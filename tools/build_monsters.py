"""モンスター担当のデータ生成: data/monsters.json, data/monster_threats.json, data/quests.json

使い方:
    PYTHONIOENCODING=utf-8 python tools/build_monsters.py            # キャッシュが無ければ取得してから生成
    PYTHONIOENCODING=utf-8 python tools/build_monsters.py --refresh  # 生データを取り直して生成

生成はキャッシュ (tools/.cache/monsters/) だけを読む。generatedAt は「使った生データの取得時刻の最大値」
にしているので、同じキャッシュからは何度実行しても同じファイルになる (冪等)。
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import monsters_legendary as legendary  # noqa: E402
from monsters_fetch import (CACHE, DIFFICULTY_REL, MANIFEST, MHDB_DATA_SHA, MHWS_SHA,  # noqa: E402
                            MHWS_TAG, fetch_all, wiki_page_rel)
from monsters_parts import STATE_KEYS, build_monsters  # noqa: E402
from monsters_wiki import LICENSE, build_quests, build_threats, rules, skill_ids  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
GAME_VERSION = "1.042"
NATIVE_VERSION = "1.42.0.2"


def _manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))["files"]


def _equip_manifest() -> dict:
    p = legendary.EQUIP_CACHE / "manifest.json"
    return json.loads(p.read_text(encoding="utf-8"))["files"]


def _meta(files: list[str], extra_sources: list[str] | None = None, equip_files: list[str] | None = None,
          **kw) -> dict:
    """files (キャッシュ相対パス。末尾 * は前方一致) の取得元 URL と取得時刻から meta を作る。

    equip_files は装備担当のキャッシュ (tools/.cache/equip/) の相対パス (歴戦王の報酬に使う MHDB の防具・護石)。
    """
    man = _manifest()
    picked = []
    for f in files:
        if f.endswith("*"):
            picked += [k for k in man if k.startswith(f[:-1])]
        elif f in man:
            picked.append(f)
        else:
            raise KeyError(f"manifest に無い: {f}")
    urls, times = [], []
    for k in sorted(set(picked)):
        u = man[k]["url"]
        if "/MHWS-in-json/natives/" in u:
            u = f"https://github.com/dzxrly/MHWS-in-json/tree/{MHWS_SHA}/MHWS-in-json/natives/STM/GameDesign/Enemy"
        if k.startswith("wiki_pages/"):
            # API の URL ではなく人が読むページの URL にする
            page = urllib.parse.parse_qs(urllib.parse.urlparse(u).query)["page"][0]
            u = legendary.WIKI_BASE + page.replace(" ", "_")
        if u not in urls:
            urls.append(u)
        times.append(man[k]["fetchedAt"])
    if equip_files:
        eman = _equip_manifest()
        for k in equip_files:
            if eman[k]["url"] not in urls:
                urls.append(eman[k]["url"])
            times.append(eman[k]["fetchedAt"])
    for u in extra_sources or []:
        if u not in urls:
            urls.append(u)
    return {"source": urls, "generatedAt": max(times), "gameVersion": GAME_VERSION,
            "nativeVersion": NATIVE_VERSION, **kw}


def _write(name: str, obj: dict, indent: int | None = 1) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, ensure_ascii=False, indent=indent)
    (DATA / name).write_text(text + "\n", encoding="utf-8", newline="\n")
    print(f"  {name}: {len(text.encode('utf-8')) / 1024:.0f} KB")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true", help="生データを取り直す")
    a = ap.parse_args()
    if a.refresh or not MANIFEST.exists():
        fetch_all(refresh=a.refresh)
    else:
        fetch_all(refresh=False)  # 足りないファイルだけ取る (あれば何もしない)

    monsters, rep = build_monsters()
    threats, others, trep = build_threats(monsters)
    # 歴戦王の行動の変化と脅威 (wiki の個別ページ) を monster_threats.json の variants に
    vnotes = legendary.attach_threat_variants(threats, monsters, skill_ids())
    quests, qrep = build_quests(monsters)
    # 個体の一覧 (通常 / 歴戦の個体 / 歴戦王 …) と、歴戦王の報酬 (MHDB の狩猟証γ)
    rewards = legendary.at_rewards(monsters)
    irep = legendary.attach_individuals(monsters, quests, rewards, threats)
    at_monster_pages = [wiki_page_rel(f"{t['nameEn']} (MHWilds)") for t in threats if t["variants"]]
    quest_pages = sorted({rel for rel in (wiki_page_rel(urllib.parse.unquote(q["wikiUrl"].rsplit("/", 1)[1])
                                                         .replace("_", " ")) for q in quests)
                          if (CACHE / rel).exists()})

    mhws_note = (f"MHWS-in-json (MIT) release {MHWS_TAG} / commit {MHWS_SHA}。"
                 f"mhdb-wilds-data commit {MHDB_DATA_SHA}。")
    _write("monsters.json", {
        "meta": _meta(["mhdb_monsters_ja.json", "mhdbdata_PartNames.json",
                       "processed/damage_calculator.zh-Hans.json", "natives/*", "db_ja-JP/MissionData.xlsx",
                       "wiki_quests_mhwilds.json"],
                      extra_sources=[legendary.HEALTH_PY_URL, legendary.CONFIG_PY_URL]
                      + sorted({u for r in legendary.AT_RELEASE.values() for u in r["sources"]}
                               | set(legendary.AT_STAR10["sources"])),
                      equip_files=["mhdb/armor.json", "mhdb/charms.json"],
                      note="肉質は 0〜100 の整数。hitzone=通常、wound=傷口、states=内部名つきの状態別 (stateKeys 参照)。"
                           + mhws_note,
                      license={"MHWS-in-json": "MIT", "mhdb-wilds-data": "MIT",
                               "wilds.mhdb.io": "データ API (出典表記)",
                               "monsterhunterwiki.org": ("CC BY-SA 4.0。individuals[].questIds / intruderQuestIds は "
                                                         "quests.json の id (クエストと狩猟対象・乱入の対応は wiki 由来)")},
                      legendaryGroups=legendary.LEGENDARY_GROUPS_META,
                      legendaryFields=legendary.legendary_fields_meta(rep["uniqueParams"]),
                      individuals=("individuals はモンスターの個体の一覧。先頭は通常 (kind=null)、続いて MHDB の variants の順 "
                                   "(tempered=歴戦の個体 / arch-tempered=歴戦王 / frenzied=狂竜化 / alpha=ボス個体)。"
                                   "kind は quests.json の targets[].variant と同じ値 (通常は null)。"
                                   "groupByRank = 報酬ランクごとに使う legendaryParams の群 (群なし=null は体力の倍率 1.0)。"
                                   "rates = その個体が出るクエストで実際に使われる群と倍率 (確度つき)。"
                                   "hitzone = 肉質が通常と同じか と、置き換え後の傷口の肉質 (meta.individualsHitzone)。"
                                   "歴戦王だけ added (追加の版と日付)・star10・rewards (狩猟証γ で作れる γ 防具と固定護石) を持つ。"
                                   "クエストごとのソロの体力は quests.json の mission.targets[].healthCalc。"),
                      individualsHitzone={
                          "sameAsBase": ("hitzone.sameAsBase = その個体の肉質 (通常・傷口・状態別・属性) が parts と同じか。"
                                         "true / false (違う。woundOverrides に置き換え後の値) / null (分からない)。"
                                         "null で confidence も null は未調査 (狂竜化・ボス個体)、confidence が low は"
                                         "置き換えがあるのに条件が分からないもの (歴戦王アルシュベルド)"),
                          "woundOverrides": ("hitzone.woundOverrides = 部位 key → 置き換え後の傷口の肉質 (parts[].wound と同じ形)。"
                                             "書いていない部位は parts[].wound のまま。置き換えが無ければ null。"
                                             "sameAsBase が null のときは置き換わるとしたときの値 (参考)"),
                          "elementRecommendation": ("hitzone.elementRecommendation = 置き換え後の傷口で計算し直した推奨属性 "
                                                    "(モンスターの elementRecommendation と同じ形)。置き換えが無ければ null "
                                                    "(モンスターの elementRecommendation のまま)"),
                          "note": "hitzone.note はあるときだけ",
                          "reason": legendary.HITZONE_SAME_REASON},
                      woundConversions=("woundConversions = モンスター固有のパラメータ (Param_Unique) の傷口の肉質の置き換え "
                                        "(_ScarMeatConvert)。いまはウズ・トゥナ (歴戦王の群) とアルシュベルド (条件不明) だけで、"
                                        "ほかは []。scope: arch-tempered (歴戦王の群の構造の中にある) / unknown (いつ使われるか"
                                        "分からない)、groups: 使われる群 (unknown は null)、parts: [{key, before (= parts[].wound), "
                                        "after, changed (値の変わる項目)}]、unmatched: どの部位の傷口にも当たらない置き換え、"
                                        "elementRecommendation: 置き換え後の傷口で計算し直した推奨属性。parts[].wound には"
                                        "反映していない (通常の個体の値のまま)"),
                      uniqueIgnored=legendary.UNIQUE_IGNORED_NOTE,
                      stateKeys=STATE_KEYS,
                      elementRecommendation=("部位ごとの bestElement は通常肉質で最も高い属性 (同値は全部)。"
                                             "elementRecommendation.best は名前のある部位のうち斬撃肉質 45 以上の部位"
                                             " (2 部位未満なら斬撃上位 3 部位) の属性肉質の単純平均が最大の属性。"
                                             "部位不明 (unknownPart) は対象外。同点は 主要部位の傷口の肉質の平均 "
                                             "(傷口のある主要部位だけ) → 名前のある全部位の平均 の順で崩す "
                                             "(経過は tieBreak。同点が無ければ null)。傷口は parts[].wound (通常の個体) の値で、"
                                             "傷口の肉質の置き換え (woundConversions) は入れていない。置き換え後の推奨は "
                                             "woundConversions[].elementRecommendation (アルシュベルドは置き換え後だと傷口の"
                                             "属性が全部同じ値になり、傷口では崩れず、全部位の平均で龍のまま)。")),
        "monsters": monsters,
    })
    _write("monster_threats.json", {
        "meta": _meta(["wiki_monsters_games_mhwilds.json", "mhdb_skills_ja.json", "mhdb_skills_en.json"]
                      + at_monster_pages,
                      extra_sources=["https://monsterhunterwiki.org/wiki/Status_Effects_(MHWilds)"],
                      license=LICENSE,
                      variants=("variants は個体ごとの差分。いまは歴戦王 ('arch-tempered') だけで、wiki の個別ページの"
                                "「Arch-Tempered」節の箇条書き (moveChanges。text は日本語、textEn は wiki の英文) と、"
                                "防具スキルとの関係が書かれた脅威 (hazards。skill は rules と同じ形。oneShot=当たると力尽きる)。"
                                "sameAsBase は咆哮・風圧・振動・属性やられ・状態異常が通常と同じと見ているもの (確度つき)。"),
                      note=("咆哮 roar: none/weak(咆哮【小】)/strong(咆哮【大】)。風圧 windPressure: none/minor(風圧【小】)/"
                            "major(風圧【大】)/dragon(龍風圧)。振動 tremor: none/minor(振動【小】)/major(振動【大】)。"
                            "wiki に値が無いものは null。blights は wiki の status_effects の属性 (属性やられ)。"
                            "blightsUncertain は攻撃属性 (attackElements) にあるのに blights に無いもの "
                            "(属性やられになるか未確認。blights には足していない)。"),
                      wiki={"rowsScanned": trep["wikiRowsScanned"], "pages": trep["wikiPages"],
                            "wildsRows": trep["wildsRows"]}),
        "rules": rules(),
        "monsters": threats,
        "otherMonsters": others,
    })
    _write("quests.json", {
        "meta": _meta(["wiki_quests_mhwilds.json", "wiki_arena_counter.json",
                       "db_ja-JP/MissionData.xlsx", "db_en-US/MissionData.xlsx", DIFFICULTY_REL, "natives/*"]
                      + quest_pages,
                      extra_sources=[legendary.HEALTH_PY_URL, legendary.CONFIG_PY_URL, legendary.OFFLINE_EVENT_URL],
                      license=LICENSE,
                      healthFormula=("ソロの体力 = ceil(float32(基礎体力 × クエストの health × 乱数の等級 × 群の HealthRate))。"
                                     "群は monsters.json の meta.legendaryGroups、倍率は monsters.json の "
                                     "legendaryParams[paramGroup] (群なし=NONE は 1.0)。乱数の等級と確率は healthGrades "
                                     "(EmCommonDifficulty2。adjustRange 0〜3)。healthCalc.mid は等級 1.0 の値。計算した値の集合が "
                                     "MissionData の soloHealth と一致したときだけ adjustRange と min/max を入れる "
                                     "(matchesMissionData。soloHealth は昇順で healthGrades[adjustRange].probs と同じ並び)。"
                                     "SoloHealth も MHWS-in-json が同じ式で作った値なので、一致は独立の確認ではない"),
                      healthGrades=qrep["healthGrades"],
                      attackNote=("attackRate = クエストの attack × 群の平常/怒りの攻撃倍率 (掛け方は推定。確度 low)。"
                                  "NONE (群なし) は null"),
                      multiNote=("multi = MissionData の _MultiTableId の表 (tableId) の _Count = 2〜maxPlayers の倍率 "
                                 "(_Count を参加人数と推定。確度 low)。_Count = 5 は意味が分からないので入れていない。"
                                 "_Count = 2〜5 が全部同じ値の表は、オメガ・プラネテスの 4 人クエスト (1.55 / 1.8) と"
                                 "ゴグマジオスの 4 人クエスト (1.0) のもの。2 人までのクエストは人数で増える表を使う"),
                      availabilityNote=("availability = wiki の time_period から。status: permanent (常設) / inactive (終了中) / "
                                        "active (配信中) / standard (期間の無い通常のクエスト・任務) / unknown。"
                                        "availabilityAsOf (wiki の取得日) 時点。Ver.1.042 (2026-08-04) からイベントクエストは"
                                        "オフラインでも受けられる (rpgsite の記事)"),
                      availabilityAsOf=qrep["availabilityAsOf"],
                      damageRateCheck={"rows": qrep["damageRateRows"], "notOne": qrep["damageRateNot1"],
                                       "note": ("MissionData の _DamageSlashBlow / _DamageShot (クエスト側のダメージ補正)。"
                                                "大型の全行で 1 (= 歴戦・歴戦王でも与えるダメージは肉質どおり)")},
                      note=("クエストの一覧と狩猟対象・乱入 (intruders = wiki の other_large_monsters)・装備固定は wiki "
                            "(CC BY-SA 4.0)。日本語名と mission (体力倍率など) は MissionData.xlsx (MHWS-in-json, MIT) を"
                            "英語名で突き合わせたもの。multi は大型の狩猟対象が 2 体以上。"
                            "装備固定の判定には wiki のページ MHWilds/Quests/Arena Counter の節分けも使う "
                            "(Free Challenge Quests の節 = 持ち込み装備)。" + mhws_note)),
        "quests": quests,
    })

    print("monsters:", len(monsters), "parts:", rep["parts"], "wound:", rep["woundParts"],
          "states:", dict(rep["stateKeysUsed"]))
    print("  部位不明:", len(rep["unknownParts"]), rep["unknownParts"])
    print("  部位共有:", rep["sharedParts"])
    print("  破壊の食い違い:", rep["breakDiff"])
    print("  部位にひも付かない弱点:", rep["unlinkedWeakPoints"])
    print("threats:", len(threats), "others:", len(others), "missing:", trep["missing"])
    for i in trep["issues"]:
        print("  ", i)
    print("quests:", len(quests), "multi:", sum(q["multi"] for q in quests),
          "fixed:", Counter_(q["fixedEquipment"] for q in quests))
    print("  mission 一致:", qrep["missionMatched"], "不一致:", len(qrep["missionUnmatched"]), qrep["missionUnmatched"])
    print("  あいまい一致:", qrep["missionFuzzy"])
    print("  ★違い:", qrep["starsDiffer"])
    print("  対象の食い違い:", qrep["targetMismatch"])
    print("  wiki 対象で 34 体に無い名前:", qrep["unmappedTargets"])
    print("  MissionData で解決できない名前:", qrep["unmappedMissionMonsters"])
    print("  乱入で解決できない名前:", qrep["unmappedIntruders"])
    print("  歴戦/歴戦王の食い違い (wiki / MissionData):", qrep["variantMismatch"])
    print("  Arena Counter の節:", qrep["arenaSections"], "Bucket に無い:", qrep["arenaSectionNotInBucket"])
    ties = [(m["name"], m["elementRecommendation"]["tieBreak"]["tied"], m["elementRecommendation"]["best"],
             m["elementRecommendation"]["tieBreak"]["by"]) for m in monsters if m["elementRecommendation"]["tieBreak"]]
    print("推奨属性の同点:", ties)
    print("歴戦王:", irep["archTempered"], "LegendaryID の食い違い:", irep["legendaryMismatch"])
    print("  Param_Unique が無い:", rep["uniqueMissing"])
    print("  傷口の肉質の置き換え:", rep["woundConversions"])
    print("  Param_Unique の肉質の項目 (取り込まない):", rep["uniqueMeatIgnored"])
    print("  Param_Unique の King / Legendary の項目があるモンスター:", list(rep["uniqueParams"]))
    print("  個体の肉質:", [(m["name"], i["kind"], i["hitzone"]["sameAsBase"], i["hitzone"]["confidence"])
                       for m in monsters for i in m["individuals"]
                       if i["hitzone"]["sameAsBase"] is not True or i["hitzone"].get("note")])
    print("  体力の再計算:", qrep["healthChecked"], "行 / 不一致:", qrep["healthMismatch"])
    print("  ダメージ補正が 1 でない行:", qrep["damageRateNot1"])
    print("  種別の上書き:", qrep["categoryOverride"])
    print("  配信状況:", qrep["availability"])
    print("  歴戦王の行動の訳の抜け:", vnotes)
    print("属性やられ未確認 (blightsUncertain):",
          [(x["name"], [b["element"] for b in x["blightsUncertain"]]) for x in threats if x["blightsUncertain"]],
          [(x["nameEn"], [b["element"] for b in x["blightsUncertain"]]) for x in others if x["blightsUncertain"]])


def Counter_(it):
    from collections import Counter
    return dict(Counter(it))


if __name__ == "__main__":
    main()
