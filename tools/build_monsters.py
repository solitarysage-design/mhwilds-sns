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
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from monsters_fetch import (CACHE, MANIFEST, MHDB_DATA_SHA, MHWS_SHA, MHWS_TAG,  # noqa: E402
                            fetch_all)
from monsters_parts import STATE_KEYS, build_monsters  # noqa: E402
from monsters_wiki import LICENSE, build_quests, build_threats, rules  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
GAME_VERSION = "1.042"
NATIVE_VERSION = "1.42.0.2"


def _manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))["files"]


def _meta(files: list[str], extra_sources: list[str] | None = None, **kw) -> dict:
    """files (キャッシュ相対パス。末尾 * は前方一致) の取得元 URL と取得時刻から meta を作る。"""
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
        if u not in urls:
            urls.append(u)
        times.append(man[k]["fetchedAt"])
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
    quests, qrep = build_quests(monsters)

    mhws_note = (f"MHWS-in-json (MIT) release {MHWS_TAG} / commit {MHWS_SHA}。"
                 f"mhdb-wilds-data commit {MHDB_DATA_SHA}。")
    _write("monsters.json", {
        "meta": _meta(["mhdb_monsters_ja.json", "mhdbdata_PartNames.json",
                       "processed/damage_calculator.zh-Hans.json", "natives/*"],
                      note="肉質は 0〜100 の整数。hitzone=通常、wound=傷口、states=内部名つきの状態別 (stateKeys 参照)。"
                           + mhws_note,
                      license={"MHWS-in-json": "MIT", "mhdb-wilds-data": "MIT",
                               "wilds.mhdb.io": "データ API (出典表記)"},
                      stateKeys=STATE_KEYS,
                      elementRecommendation=("部位ごとの bestElement は通常肉質で最も高い属性 (同値は全部)。"
                                             "elementRecommendation.best は名前のある部位のうち斬撃肉質 45 以上の部位"
                                             " (2 部位未満なら斬撃上位 3 部位) の属性肉質の単純平均が最大の属性。"
                                             "部位不明 (unknownPart) は対象外。")),
        "monsters": monsters,
    })
    _write("monster_threats.json", {
        "meta": _meta(["wiki_monsters_games_mhwilds.json", "mhdb_skills_ja.json", "mhdb_skills_en.json"],
                      extra_sources=["https://monsterhunterwiki.org/wiki/Status_Effects_(MHWilds)"],
                      license=LICENSE,
                      note=("咆哮 roar: none/weak(咆哮【小】)/strong(咆哮【大】)。風圧 windPressure: none/minor(風圧【小】)/"
                            "major(風圧【大】)/dragon(龍風圧)。振動 tremor: none/minor(振動【小】)/major(振動【大】)。"
                            "wiki に値が無いものは null。blights は wiki の status_effects の属性 (属性やられ)。"),
                      wiki={"rowsScanned": trep["wikiRowsScanned"], "pages": trep["wikiPages"],
                            "wildsRows": trep["wildsRows"]}),
        "rules": rules(),
        "monsters": threats,
        "otherMonsters": others,
    })
    _write("quests.json", {
        "meta": _meta(["wiki_quests_mhwilds.json", "db_ja-JP/MissionData.xlsx", "db_en-US/MissionData.xlsx"],
                      license=LICENSE,
                      note=("クエストの一覧と狩猟対象・乱入 (intruders = wiki の other_large_monsters)・装備固定は wiki "
                            "(CC BY-SA 4.0)。日本語名と mission (体力倍率など) は MissionData.xlsx (MHWS-in-json, MIT) を"
                            "英語名で突き合わせたもの。multi は大型の狩猟対象が 2 体以上。" + mhws_note)),
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


def Counter_(it):
    from collections import Counter
    return dict(Counter(it))


if __name__ == "__main__":
    main()
