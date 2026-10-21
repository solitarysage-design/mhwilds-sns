"""歴戦の個体・歴戦王 (Arch-Tempered) のデータを組み立てる。

- Param_Legendary の 4 つの群 (normal / hard / king / kingHard) の項目と、クエストでどの群が使われるかの規則
- クエストの狩猟対象ごとのソロの体力 (再計算して MissionData の SoloHealth と照合)・マルチの倍率・攻撃の倍率の目安
- クエストの配信状況 (wiki の Time Period)
- モンスターごとの個体の一覧 (monsters.json の individuals)
- 歴戦王の行動の変化と、防具スキルで防げる脅威 (monster_threats.json の variants)
- 歴戦王の報酬 (狩猟証γ → γ 防具・固定護石。MHDB)
- モンスター固有のパラメータ (Param_Unique) の傷口の肉質の置き換え (monsters.json の woundConversions と
  individuals[].hitzone) と、歴戦王・歴戦用と思われる項目の一覧 (meta.legendaryFields.uniqueParams)

出典と確度は docs/sources/monsters.md。群の選び方と体力の式は MHWS-in-json (MIT) の
src/database/missions/health.py と config.py (作者がゲームの実行ファイルを解析したもの) に従う。
"""
from __future__ import annotations

import datetime as _dt
import json
import math
import re
import struct
from collections import defaultdict

from monsters_fetch import CACHE, DIFFICULTY_REL, MANIFEST, MHWS_SHA, ROOT, wiki_page_rel

EQUIP_CACHE = ROOT / "tools" / ".cache" / "equip"
WIKI_BASE = "https://monsterhunterwiki.org/wiki/"
MHWS_BLOB = f"https://github.com/dzxrly/MHWS-in-json/blob/{MHWS_SHA}/"
HEALTH_PY_URL = MHWS_BLOB + "src/database/missions/health.py"
CONFIG_PY_URL = MHWS_BLOB + "config.py"
# Ver.1.042 (2026-08-04) からイベントクエストをオフラインでも受けられる
OFFLINE_EVENT_URL = ("https://www.rpgsite.net/news/20978-monster-hunter-wilds-version-1042-launches-on-august-4-"
                     "adding-support-for-save-transfer-from-prologue-demo")

# 実行ファイルに埋め込まれた例外 (user3 のデータには無い)。MHWS-in-json config.py の
# MISSION_HEALTH_KING_WHEN_NONE_IDS / MISSION_HEALTH_NO_AUTO_HARD_IDS を写したもの。ゲームが更新されたら見直す
KING_WHEN_NONE_IDS = frozenset({"EM0078_00_0", "EM0164_50_0"})  # ゴグマジオス・ゾ・シア: NONE でも報酬ランク 10 は kingHard
NO_AUTO_HARD_IDS = frozenset({"EM0166_00_0"})  # オメガ・プラネテス: 報酬ランクから hard にしない

GROUPS = ["normal", "hard", "king", "kingHard"]
GROUP_SUFFIX = {"normal": "", "hard": "_Hard", "king": "_King", "kingHard": "_King_Hard"}
LEGENDARY_OF_KIND = {None: "NONE", "tempered": "NORMAL", "arch-tempered": "KING", "frenzied": "NONE", "alpha": "NONE"}
KIND_LABEL = {None: "通常", "tempered": "歴戦の個体", "arch-tempered": "歴戦王", "frenzied": "狂竜化", "alpha": "ボス個体"}

CONF_HEALTH = "medium"  # ソロの体力 (式は MHWS-in-json。第三者の実測 1 件と合う。ゲーム内では未確認)
CONF_ATTACK = "low"     # 攻撃の倍率の掛け方は推定
CONF_MULTI = "low"      # マルチの倍率 (_Count = 人数と推定。コミュニティの実測と合わない表がある)

LEGENDARY_GROUPS_META = {
    "groups": {
        "normal": "歴戦の個体 (LegendaryID=NORMAL) で報酬ランク 8 以下",
        "hard": "歴戦の個体で報酬ランク 9 以上 (★9 と ★10 の歴戦の個体)",
        "king": "歴戦王 (LegendaryID=KING) で報酬ランク 9 以下 (★8/★9)",
        "kingHard": "歴戦王で報酬ランク 10 (★10)",
    },
    "rule": ("NORMAL かつ報酬ランク 9 以上 → hard、KING かつ報酬ランク 10 → kingHard、ほかの NORMAL は normal、KING は king。"
             "NONE (通常の個体・狂竜化・ボス個体) は群なし (体力の倍率は 1.0)。報酬ランクは MissionData の _RewardRank"),
    "exceptions": [
        {"emId": "EM0164_50_0", "what": "ゾ・シア: NONE でも報酬ランク 10 は kingHard の倍率を使う"},
        {"emId": "EM0078_00_0", "what": "ゴグマジオス: NONE でも報酬ランク 10 は kingHard の倍率を使う"},
        {"emId": "EM0166_00_0", "what": "オメガ・プラネテス: 報酬ランクから hard にしない"},
    ],
    "presetHard": "実行時のフラグ preset_hard は MHWS-in-json と同じく常に false として扱う (未確認)",
    "source": [HEALTH_PY_URL, CONFIG_PY_URL],
    "confidence": "medium",
    "reason": ("MHWS-in-json の作者がゲームの実行ファイル (EnemyUtil.getMaxHealth_Difficulty ほか) を解析した結果。"
               "これで大型の狩猟対象の全行の体力が MissionData と一致し (quests.json の healthCalc.matchesMissionData)、"
               "第三者の実測 (歴戦王アルシュベルドのソロ約 79,000) とも合う。ただし MissionData の SoloHealth も同じ式で"
               "作られた値なので独立の確認ではない"),
}

LEGENDARY_FIELDS_META = {
    "health": {"internal": "HealthRate", "meaning": "体力の倍率", "confidence": "medium"},
    "partsVital": {"internal": "PartsVitalRate", "meaning": "部位の耐久の倍率 (と思われる)", "confidence": "low"},
    "attackCalm": {"internal": "NoAngryAttackRate", "meaning": "平常時の攻撃の倍率 (と思われる)", "confidence": "low"},
    "attackAngry": {"internal": "AngryAttackRate", "meaning": "怒り時の攻撃の倍率 (と思われる)", "confidence": "low"},
    "motionSpeed": {"internal": "MotionSpeedRate", "meaning": "動きの速さの倍率 (と思われる)。king / kingHard 群には欄が無い (null)",
                    "confidence": "low"},
    "motionSpeedOverride": {"internal": "OverrideMotionSpeed_King_Hard",
                            "meaning": "★10 の歴戦王の動きの速さの上書き (IsEnableOverrideMotionSpeed_King_Hard が true のときだけ値)",
                            "confidence": "low"},
    "staminaSub": {"internal": "StaminaSubRate", "meaning": "スタミナの減り方 (と思われる)", "confidence": "low"},
    "woundVital": {"internal": "NormalVitalRate / TearVitalRate / TearVitalRateLegendaryScar",
                   "meaning": "傷の付きにくさ (normal)・傷の耐久 (tear)・歴戦の傷の耐久 (temperedScar) の倍率と思われる。大きいほど付きにくい・壊れにくい",
                   "confidence": "low"},
    "guardPowerAdd": {"internal": "AddVersusGuardPower",
                      "meaning": ("ガードを崩す強さを足す (と思われる)。null は Param_Legendary のその群に欄が無いという意味で、"
                                  "「足さない」とは限らない (例: ウズ・トゥナの歴戦王は Param_Unique の _LegendaryParam_King に "
                                  "_AddGuardPower 40 がある。uniqueParams)"),
                      "confidence": "low"},
    "actionOverrides": {"internal": "_ActionCustomData",
                        "meaning": "技ごとの速さ・攻撃の上書きの件数と最大値。どの技かは引けない", "confidence": "low"},
    "nullMeaning": "どの項目も null は「Param_Legendary のその群に欄が無い」。1.0 や 0 の意味ではない",
    "notImported": ("AngryScarDamageRate (意味不明)・AddStunDamageList (被弾時の気絶値?)・ArenaLegendaryScarIndexList "
                    "(歴戦の傷の位置?)・_ShellCustomData は意味が分からず画面でも使わないので取り込んでいない"),
}

UNIQUE_PARAMS_MEANING = ("モンスター固有のパラメータ (Param_Unique) のうち、項目名や構造の名前に King / Legendary が付く数値 "
                         "(歴戦王・歴戦の個体用と思われる)。傷口の肉質の置き換え (_ScarMeatConvert) は woundConversions に"
                         "取り込んだが、ほかは取り込んでいない (意味は名前からの推定もしていない。参考に値を並べただけ)。"
                         "例: ウズ・トゥナの _LegendaryParam_King._VeilVitalRate 2.4 (通常の _VeilVitalRate_Ex は 1.2。"
                         "wiki の「歴戦王は水のベールがとても壊れにくい」と合う)・_AddGuardPower 40、"
                         "ヌ・エグドラの _LostFrontHalfVitalRate_King 0.5、レ・ダウの BreakEnchantRate_LegendaryKing 0.25、"
                         "アルシュベルドの BladeVitalRate_King 1.2。キーは構造の中の項目名を . でつないだもの"
                         " (_GenusInfo と _SpeciesInfo で値が違うときは末尾に (Genus) / (Species) を付けて両方)")


def legendary_fields_meta(unique_params: dict[str, dict]) -> dict:
    """meta.legendaryFields (Param_Legendary の項目の意味) に、Param_Unique の歴戦王・歴戦用の項目の一覧を足したもの。"""
    return {**LEGENDARY_FIELDS_META,
            "uniqueParams": {"meaning": UNIQUE_PARAMS_MEANING, "confidence": "low", "byMonster": unique_params}}

# ---- 歴戦王の追加日 (ゲームデータに無い事実。出典つき) ----
# 版は MissionData の _Version から作る (ここには書かない)。★10 版はすべて Ver.1.041 (2026-02-18)。
AT_RELEASE = {
    "Rey Dau": {"date": "2025-04-30", "dateConfidence": "medium",
                "note": "期間限定 (〜2025-05-14) で初配信。2025-07 の再配信のあとで常設になった (常設になった日は未確定)",
                "sources": ["https://saiganak.com/en/news/monsterhunter-wilds-arch-tempered-rey-dau-release-date/",
                            "https://automaton-media.com/en/news/monster-hunter-wilds-brings-back-arch-tempered-rey-dau-quest/",
                            "https://www.gamespark.jp/article/2025/07/11/154945.html"]},
    "Uth Duna": {"date": "2025-07-23", "dateConfidence": "high", "note": "最初から常設 (当初の予定 7/29 を前倒し)",
                 "sources": ["https://gamebiz.jp/news/409535",
                             "https://www.gfinityesports.com/article/monster-hunter-wilds-arch-tempered-uth-duna-arrives-early-permanent-event-quests-planned"]},
    "Nu Udra": {"date": "2025-10-22", "dateConfidence": "high", "note": "常設のイベントクエストとして登場",
                "sources": ["https://animeanime.jp/release/prtimes/20250925/249667.html"]},
    "Jin Dahaad": {"date": "2025-12-24", "dateConfidence": "medium", "note": "常設のイベントクエスト",
                   "sources": ["https://www.rpgsite.net/news/19199-monster-hunter-wilds-title-update-4-is-now-live-featuring-the-elder-dragon-gogmazios-transcendence-and-more"]},
    "Arkveld": {"date": "2026-02-18", "dateConfidence": "high",
                "note": "★10 だけ。最初から常設。ファミ通は「最後の歴戦王」と書いている",
                "sources": ["https://blog.playstation.com/?p=414865", "https://www.famitsu.com/article/202602/66349"]},
}
AT_STAR10 = {"date": "2026-02-18", "dateConfidence": "high",
             "note": "Ver.1.041 で 5 体すべての ★10 版 (と連続狩猟『英雄の証』) が常設で追加",
             "sources": ["https://blog.playstation.com/?p=414865",
                         "https://animeanime.jp/release/prtimes/20260218/270887.html"]}

# ---- 歴戦王の行動の変化 (wiki の個別ページ「==== Arch-Tempered ====」の箇条書き) の日本語 ----
# キーは wiki の英文 (リンクを外したもの)。wiki が変わって合わなくなった文は text が null になり、issues に出る
MOVE_JA = {
    # レ・ダウ
    "Previous moves are performed faster with new combos.": "従来の技が速くなり、新しい連携が加わる",
    "Gains a new downward lightning beam that it uses to take off.": "飛び立つときに真下へ雷のビームを撃つ技が加わる",
    "While in a charged state, all physical attacks leave behind delayed electric aftershocks.":
        "帯電中は、物理攻撃のあとに時間差の雷が残る",
    "Charged lightning beams create delayed electric explosions at the impact site.":
        "帯電ビームの着弾点で、時間差の雷の爆発が起きる",
    "No longer exposes a weak point after its double lightning beam.": "2 連ビームのあとに弱点をさらさなくなる",
    # ウズ・トゥナ
    "Previous moves have greatly increased mobility and are performed more aggressively.":
        "従来の技の動きが大きくなり、攻めが激しくなる",
    "Water veils have greatly increased durability.": "水のベールがとても壊れにくくなる",
    "Attacks with the water veil active produce more frequent waves that deal more damage and pushback.":
        "ベールをまとった攻撃で波が多く出て、ダメージと押し出しが大きくなる",
    "Can perform additional new attacks.": "新しい技を使う",
    # ヌ・エグドラ
    "Previous moves are performed faster and more aggressively, with further reach.":
        "従来の技が速く激しくなり、届く距離が伸びる",
    "While ignited, emits a burning aura that deals constant damage to nearby hunters. "
    "This can be negated by Level 2 Adaptability.":
        "点火中は炎をまとい、近くのハンターに継続ダメージを与える (環境適応 Lv2 で無効)",
    "No longer exits the ignited state unless forced out of it via damage.": "ダメージで解除させない限り点火が続く",
    # ジン・ダハド
    "Combos previous attacks more aggressively; body slam may be performed twice in a row.":
        "従来の技を激しくつなぎ、のしかかりを 2 回続けることがある",
    "Can use attacks exclusive to the final area in the third area.": "最終エリアの技を第3エリアでも使う",
    "Expelling ice mist from its torso creates a short-lived whirlwind, dealing no damage but inflicting rapid "
    "Frostblight buildup.":
        "胴体から冷気を出して短いつむじ風を作る (ダメージは無いが、凍結が急速にたまる)",
    "Downward ice explosion produces an additional delayed explosion of icicles, dealing damage and obstructing movement.":
        "真下への氷の爆発のあと、時間差で氷柱が爆発する (ダメージがあり、動きをさえぎる)",
    "While coiled around structures, creates clusters of exploding icicles around players.":
        "構造物に巻きついている間、ハンターの周りに爆発する氷柱を出す",
    "Nova attack has a faster charge-up time and is a guaranteed faint if it connects. Additionally, in the final "
    "area, it produces additional clusters of exploding icicles from the ground while charging.":
        "ノヴァのためが速くなり、当たると確定で力尽きる。最終エリアでは、ため中に地面から爆発する氷柱も出す",
    # アルシュベルド
    "Previous attacks are performed much faster, with many having altered timings or behavior.":
        "従来の技がずっと速くなり、多くの技でタイミングや動きが変わる",
    "Can combo numerous attacks in a row without pause, with each attack potentially chaining into several other ones.":
        "多くの技を間を置かずにつなぎ、どの技からも別の技に続きうる",
    "If not charged, can now absorb elemental attacks that hit its chainblades to enter its charged state faster; "
    "the charged state can only be suppressed by dealing elemental attacks to the chainblades.":
        "帯電していないとき、鎖翼刃に当たった属性攻撃を吸って早く帯電する。帯電は鎖翼刃に属性攻撃を当てないと抑えられない",
    "Below a certain amount of HP, begins manifesting Guardian abilities to augment its charged state, giving it "
    "Wylkrystal-creating variants of many previous attacks akin to Guardian Arkveld.":
        "体力が一定以下になると護竜の力を出して帯電を強め、護竜アルシュベルドのように結晶を作る型の技が増える",
    "While manifesting Guardian abilities, gains even more new attacks.": "護竜の力を出している間は、さらに新しい技を使う",
    "After first manifesting Guardian abilities, rapidly heals any Wounds that are not destroyed quickly.":
        "最初に護竜の力を出したあとは、すぐに壊さない傷を急速に治す",
}

# ---- 歴戦王で増える脅威のうち、防具スキルとの関係が書かれているもの ----
# wikiMatch: wiki の歴戦王の節にこの語が無ければ生成を止める (wiki の記述が変わったら人が見直す)
AT_HAZARDS = {
    "Nu Udra": [
        {"key": "ignited-aura", "text": "点火中にまとう炎 (近くにいると継続ダメージ)", "wikiMatch": "Adaptability",
         "skill": ("Adaptability", 2, None), "oneShot": False, "confidence": "high",
         "note": "wiki の歴戦王の節に「環境適応 Lv2 で無効」と明記。環境適応 Lv2 の効果文は「地形によるダメージを無効化する」"},
    ],
    "Jin Dahaad": [
        {"key": "frostblight-whirlwind", "text": "冷気のつむじ風 (ダメージは無いが、凍結が急速にたまる)",
         "wikiMatch": "Frostblight", "skill": ("Bind Resistance", 3, 1), "oneShot": False, "confidence": "medium",
         "note": "凍結を防ぐスキルは rules.status.frostblight と同じ (wiki の Status Effects: 拘束耐性 Lv3 で凍結にならない)"},
        {"key": "nova", "text": "ノヴァ (当たると確定で力尽きる)", "wikiMatch": "guaranteed faint",
         "skill": None, "oneShot": True, "confidence": "high",
         "noSkill": "防げる防具スキルの記載は無い (避ける)"},
    ],
}
SAME_AS_BASE_REASON = ("wiki の monsters_games は個体ごとの行を持たず (歴戦王も通常と同じ行)、個別ページの歴戦王の節にも"
                       "咆哮・風圧・振動・属性やられ・状態異常が変わるという記載が無い。ゲームデータの行動ロジックに歴戦王だけの分岐は"
                       "あるが、技名や効果までは引けていない")
# (変更 2026-10-21 照合の指摘) 以前は「肉質は通常と同じ (確度 high)」としていたが、モンスター固有のパラメータ
# (Param_Unique) を見ていなかった。ウズ・トゥナの歴戦王には傷口の肉質の置き換えがある
HITZONE_SAME_REASON = ("肉質の表 (Param_Parts) はモンスター (EM ID) ごとに 1 つで、歴戦の個体・歴戦王も同じ EM ID で出る。"
                       "Param_Legendary (54 項目) に肉質の項目は無く、MissionData の全クエストでダメージの補正 "
                       "(_DamageSlashBlow / _DamageShot) は 1。ただしモンスター固有のパラメータ (Param_Unique) に傷口の肉質の"
                       "置き換え (_ScarMeatConvert) がある: ウズ・トゥナは歴戦王の群 (king / kingHard) 専用の構造の中にあり、"
                       "歴戦王では傷口の肉質が変わる (sameAsBase: false)。アルシュベルドは群の分からない場所にあり、"
                       "歴戦王で使われるか (常にか、ある状態だけか) が分からない (歴戦王は sameAsBase: null・確度 low)。"
                       "置き換えはモンスターの woundConversions に、個体ごとの置き換え後の傷口の肉質は hitzone.woundOverrides に持つ。"
                       "Param_Unique は 34 体のうち 33 体にあり (ドドブランゴには無い)、肉質を指す項目はほかにゴグマジオスの"
                       "状態ごとの傷口の肉質だけ (歴戦・歴戦王の群とは関係しない場所)。歴戦王は Param_Unique や行動ロジックに"
                       "意味の分からない専用の項目が多いので、置き換えの無い歴戦王も確度は medium にしている。"
                       "ゲームの実行ファイルの処理は確かめていない")
AT_NO_CONVERT_CONF = "medium"  # 置き換えの無い歴戦王の sameAsBase: true の確度
TEMPERED_CONF = "high"         # 置き換えの無い歴戦の個体の sameAsBase: true の確度

MONTHS = {m: i for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august",
                                         "september", "october", "november", "december"], 1)}


def _load(rel: str, base=CACHE):
    return json.loads((base / rel).read_text(encoding="utf-8"))


def _num(v):
    return round(float(v), 4) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _inner(x: dict) -> dict:
    """RE Engine の {"app.user_data.Xxx": {...}} から中身を取り出す。"""
    return next(iter(x.values()))


# ---------------------------------------------------------------- Param_Legendary

def raw_legendary(rel: str | None) -> dict | None:
    if not rel:
        return None
    return _load(rel)[0]["app.user_data.EmParamLegendary"]


def legendary_params(rel: str | None) -> dict | None:
    """Param_Legendary の倍率を群 (normal / hard / king / kingHard) ごとに取り出す。

    群に欄が無い項目は null (1.0 などで埋めない)。意味と確度は meta.legendaryFields。
    """
    root = raw_legendary(rel)
    if root is None:
        return None
    out = {}
    for g, suf in GROUP_SUFFIX.items():
        acts = [_inner(a) for a in root.get("_ActionCustomData" + suf) or []]
        override = None
        if g == "kingHard" and root.get("IsEnableOverrideMotionSpeed_King_Hard") is True:
            override = _num(root.get("OverrideMotionSpeed_King_Hard"))
        out[g] = {
            "health": _num(root.get("HealthRate" + suf)),
            "partsVital": _num(root.get("PartsVitalRate" + suf)),
            "attackCalm": _num(root.get("NoAngryAttackRate" + suf)),
            "attackAngry": _num(root.get("AngryAttackRate" + suf)),
            "motionSpeed": _num(root.get("MotionSpeedRate" + suf)),
            "motionSpeedOverride": override,
            "staminaSub": _num(root.get("StaminaSubRate" + suf)),
            "woundVital": {"normal": _num(root.get("NormalVitalRate" + suf)),
                           "tear": _num(root.get("TearVitalRate" + suf)),
                           "temperedScar": _num(root.get("TearVitalRateLegendaryScar" + suf))},
            "guardPowerAdd": _num(root.get("AddVersusGuardPower" + suf)),
            "actionOverrides": ({"count": len(acts),
                                 "speedMax": max(_num(a["SpeedRate"]) for a in acts),
                                 "attackMax": max(_num(a["AttackRate"]) for a in acts)} if acts else None),
        }
        if out[g]["health"] is None:
            raise ValueError(f"{rel}: 群 {g} に HealthRate が無い")
    return out


def param_group(em_id: str, legendary_id: str, reward_rank: int) -> tuple[str | None, str]:
    """クエストの狩猟対象が使う Param_Legendary の群と、その理由。

    戻り値の理由: "rank" (報酬ランクで決まる) / "none" (NONE は群なし) /
    "exe-exception:king-when-none" / "exe-exception:no-auto-hard" (実行ファイルの例外)
    """
    if legendary_id == "NONE":
        if reward_rank == 10 and em_id in KING_WHEN_NONE_IDS:
            return "kingHard", "exe-exception:king-when-none"
        return None, "none"
    auto_hard = em_id not in NO_AUTO_HARD_IDS
    if legendary_id == "NORMAL":
        if reward_rank >= 9:
            return ("hard", "rank") if auto_hard else ("normal", "exe-exception:no-auto-hard")
        return "normal", "rank"
    if legendary_id == "KING":
        if reward_rank >= 10:
            return ("kingHard", "rank") if auto_hard else ("king", "exe-exception:no-auto-hard")
        return "king", "rank"
    raise ValueError(f"LegendaryID が想定外: {legendary_id} ({em_id})")


# ---------------------------------------------------------------- Param_Unique (モンスター固有のパラメータ)

UNIQUE_BLOB = MHWS_BLOB + "MHWS-in-json/natives/STM/"
# Param_Unique で肉質を指す項目のうち、歴戦の個体・歴戦王とは関係しないと見たもの ((EM ID, 項目名) → 理由)。
# ここに無い肉質の項目 (と、ここにあっても King / Legendary の付く構造の中にあるもの) が見つかったら生成を止める
UNIQUE_MEAT_IGNORED = {
    ("EM0078_00_0", "GeyserScarMeat"): "ゴグマジオスの状態 (間欠泉?) の傷口の肉質",
    ("EM0078_00_0", "_SolidScarMeat"): "ゴグマジオスの熱の状態ごと (固体) の部位の傷口の肉質",
    ("EM0078_00_0", "_LiquidScarMeat"): "ゴグマジオスの熱の状態ごと (液体) の部位の傷口の肉質",
    ("EM0078_00_0", "_GasScarMeat"): "ゴグマジオスの熱の状態ごと (気体) の部位の傷口の肉質",
}
UNIQUE_IGNORED_NOTE = ("ゴグマジオスの状態ごとの傷口の肉質 (GeyserScarMeat / _SolidScarMeat / _LiquidScarMeat / _GasScarMeat)。"
                       "群 (歴戦・歴戦王) の付かない場所にあり、個体によらない状態の値と見ている。取り込んでいない")

# 傷口の肉質の置き換えの、モンスターごとの補足 (ゲームデータの外で確かめたこと。照合のみで値は取り込まない)
CONVERT_NOTES = {
    "EM0157_00_0": ("歴戦王の群専用の構造 (_LegendaryParam_King / _LegendaryParam_Hard_King) の中にある。同じ構造の "
                    "_VeilVitalRate 2.4 (通常は 1.2) は wiki の歴戦王の節の「水のベールがとても壊れにくい」と合うので、"
                    "この構造が歴戦王に使われることの裏付けになる。照合: 別の抽出 (dtlnor/MHWs-in-json) の履歴では、"
                    "この構造は Ver.1.020 (歴戦王ウズ・トゥナの追加) で入った"),
    "EM0160_00_0": ("置き換えの項目名に King が無く、群の分からない場所 (モンスター全体の項目) にある。ただし並びは "
                    "*_King の項目 (CombatEmDamageRate_King〜AutoElementFinishTime_King と ForceModeChangeThreshold_King) "
                    "のあいだで、照合: 別の抽出 (dtlnor/MHWs-in-json) の履歴では、*_King の項目とこの置き換えはどれも "
                    "Ver.1.041 (歴戦王アルシュベルドの追加) で入った (それまでの版には無い)。護竜アルシュベルド (EM0160_50) の "
                    "Param_Unique では空。歴戦王用と思われるが、常に使うのか、護竜の力を出したあとなどの状態だけかは分からない"),
}
CONVERT_CONF = {"known": "medium", "unknown": "low"}


def _field_names(path: list) -> list[str]:
    """走査の経路から、クラス名 (app.xxx など) と配列の添字を除いた項目名の並び。"""
    return [p for p in path if isinstance(p, str) and not p.startswith(("app.", "ace.", "via."))]


def _group_of(fields: list[str]) -> str | None:
    """構造の項目名から群を決める (_LegendaryParam_Hard_King → kingHard、*_King → king、無ければ None)。"""
    for f in reversed(fields):
        if re.search(r"Hard_King|King_Hard", f):
            return "kingHard"
        if "King" in f:
            return "king"
    return None


def unique_scan(em_id: str, rel: str | None) -> dict:
    """Param_Unique を走査する。無ければ空。

    戻り値:
      converts: [{"info": "_GenusInfo"|"_SpeciesInfo", "fields": [項目名の並び], "group": 群|None,
                  "pairs": ((置き換え前の肉質 GUID, 置き換え後の肉質 GUID), ...)}]
      values:   {"項目.項目": 値}  King / Legendary の付く項目の数値 (meta.legendaryFields.uniqueParams)
      meatIgnored: [項目名]  UNIQUE_MEAT_IGNORED に当たった肉質の項目
    肉質を指す項目で扱いの決まっていないものがあれば例外 (人が見て UNIQUE_MEAT_IGNORED か処理に足す)。
    """
    out = {"converts": [], "values": {}, "meatIgnored": []}
    if not rel:
        return out
    root = _load(rel)[0]["app.user_data.EmParamUnique"]
    raw_vals: dict[str, dict[str, float]] = defaultdict(dict)

    def walk(x, path):
        if isinstance(x, dict):
            for k, v in x.items():
                fields = _field_names(path + [k])
                if k == "_ScarMeatConvert":
                    pairs = []
                    for item in v or []:
                        c = _inner(item)
                        pairs.append((_inner(c["_Before"])["Value"], _inner(c["_After"])["Value"]))
                    out["converts"].append({"info": fields[0], "fields": fields[1:], "group": _group_of(fields[1:]),
                                            "pairs": tuple(pairs)})
                    continue
                if not k.startswith(("app.", "ace.", "via.")) and re.search(r"meat", k, re.I):
                    reason = UNIQUE_MEAT_IGNORED.get((em_id, k))
                    if reason is None or any(re.search(r"King|Legendary", f) for f in fields[1:]):
                        raise ValueError(f"{em_id} の Param_Unique に扱いの決まっていない肉質の項目がある: "
                                         f"{'.'.join(fields)} (UNIQUE_MEAT_IGNORED か unique_scan に足す)")
                    if k not in out["meatIgnored"]:
                        out["meatIgnored"].append(k)
                walk(v, path + [k])
        elif isinstance(x, list):
            for i, v in enumerate(x):
                walk(v, path + [i])
        elif isinstance(x, (int, float)) and not isinstance(x, bool):
            fields = _field_names(path)
            if len(fields) > 1 and any(re.search(r"King|Legendary", f) for f in fields[1:]):
                # 配列の添字は [n] で残す (例 ElectrostaticChargeDataArray[0].ElectricChargeValue_Legendary)
                key, seen_info = [], False
                for p in path:
                    if isinstance(p, int):
                        if key:
                            key[-1] += f"[{p}]"
                    elif not p.startswith(("app.", "ace.", "via.")):
                        if not seen_info:
                            seen_info = True  # 先頭の _GenusInfo / _SpeciesInfo は除く
                            continue
                        key.append(p)
                raw_vals[".".join(key)][fields[0]] = _num(x)

    walk(root, [])
    for k, by_info in sorted(raw_vals.items()):
        vals = set(by_info.values())
        if len(vals) == 1:
            out["values"][k] = next(iter(vals))
        else:
            for info, v in sorted(by_info.items()):
                out["values"][f"{k} ({info.strip('_').removesuffix('Info')})"] = v
    return out


def wound_conversions(m_name: str, em_id: str, uniq_path: str | None, scan: dict, meats: dict[str, dict],
                      parts: list[dict], scar_guids: dict[str, list[str]], recommend) -> list[dict]:
    """傷口の肉質の置き換え (Param_Unique の _ScarMeatConvert) を部位の key に結び付ける (monsters.json の woundConversions)。

    meats: 肉質 GUID → 肉質 (Param_Parts の _MeatArray)、scar_guids: 部位 key → その部位の傷口の肉質 GUID。
    recommend: 推奨属性の計算 (monsters_parts.recommend_element)。置き換え後の傷口で計算し直す。
    _GenusInfo と _SpeciesInfo が同じ置き換えなら 1 つにまとめ、king と kingHard が同じならまとめる。
    """
    by_group: dict[str | None, tuple] = {}
    for c in scan["converts"]:
        if c["pairs"] and c["group"] in by_group and by_group[c["group"]] != c["pairs"]:
            raise ValueError(f"{m_name}: 群 {c['group']} の傷口の肉質の置き換えが _GenusInfo と _SpeciesInfo で違う "
                             "(どちらを使うか決めてから取り込む)")
        if c["pairs"]:
            by_group[c["group"]] = c["pairs"]
    merged: dict[tuple, list] = {}
    for g, pairs in by_group.items():
        merged.setdefault(pairs, []).append(g)
    internal = {}
    for c in scan["converts"]:
        if c["pairs"]:
            internal.setdefault(c["pairs"], set()).add(".".join(c["fields"]))
    out = []
    order = {p["key"]: i for i, p in enumerate(parts)}
    for pairs, groups in merged.items():
        if None in groups and len(groups) > 1:
            raise ValueError(f"{m_name}: 群の分かる置き換えと分からない置き換えが同じ (形を見直す)")
        known = sorted((g for g in groups if g), key=GROUPS.index)
        rows, unmatched = [], []
        for before, after in pairs:
            if before not in meats or after not in meats:
                raise ValueError(f"{m_name}: 置き換えの肉質 GUID が Param_Parts に無い ({before} → {after})")
            hit = [p for p in parts if before in scar_guids.get(p["key"], [])]
            if not hit:
                unmatched.append({"before": meats[before], "after": meats[after]})
                continue
            for p in hit:
                if p["wound"] != meats[before]:
                    raise ValueError(f"{m_name} {p['key']}: 置き換え前の肉質が傷口の肉質と違う")
                rows.append({"key": p["key"], "before": p["wound"], "after": meats[after],
                             "changed": [k for k in meats[after] if meats[after][k] != p["wound"][k]]})
        rows.sort(key=lambda r: order[r["key"]])
        if len({r["key"] for r in rows}) != len(rows):
            raise ValueError(f"{m_name}: 1 つの部位に置き換えが 2 つ以上当たる")
        after_by_key = {r["key"]: r["after"] for r in rows}
        rec = recommend([dict(p, wound=after_by_key.get(p["key"], p["wound"])) for p in parts])
        scope = "arch-tempered" if known else "unknown"
        if known and not set(known) <= {"king", "kingHard"}:
            raise ValueError(f"{m_name}: 歴戦王以外の群の置き換え {known} (形を見直す)")
        out.append({
            "scope": scope,
            "groups": known or None,
            "internal": " / ".join(f"Param_Unique の {x}" for x in sorted(internal[pairs])),
            "condition": ("歴戦王の群 (" + " / ".join(known) + ") 専用の構造の中にある = 歴戦王で使われる"
                          if known else "不明 (群の分からない場所にある。いつ使われるかはデータに無い)"),
            "confidence": CONVERT_CONF["known" if known else "unknown"],
            "note": CONVERT_NOTES.get(em_id),
            "parts": rows,
            "unmatched": unmatched,
            "elementRecommendation": rec,
            "source": UNIQUE_BLOB + uniq_path + ".3.json",
        })
    return out


def individual_hitzone(m: dict, kind: str | None, used_groups: set) -> dict:
    """個体の肉質が通常 (parts) と同じか と、置き換え後の傷口の肉質 (woundOverrides)。理由は meta.individualsHitzone。"""
    def hz(same, conf, conv=None, note=None):
        d = {"sameAsBase": same, "confidence": conf,
             "woundOverrides": {r["key"]: r["after"] for r in conv["parts"]} if conv else None,
             "elementRecommendation": conv["elementRecommendation"] if conv else None}
        if note:
            d["note"] = note
        return d

    if kind is None:
        return hz(True, "high")
    if kind not in ("tempered", "arch-tempered"):
        return hz(None, None)  # 狂竜化・ボス個体は未調査
    mine = {"tempered": {"normal", "hard"}, "arch-tempered": {"king", "kingHard"}}[kind]
    convs = m["woundConversions"]
    known = [c for c in convs if c["groups"] and set(c["groups"]) & mine]
    unknown = [c for c in convs if not c["groups"]]
    if len(known) > 1 or len(unknown) > 1:
        raise ValueError(f"{m['name']} {kind}: 傷口の肉質の置き換えが 2 つ以上ある (形を見直す)")
    if known:
        c = known[0]
        if used_groups - {None} - set(c["groups"]):
            raise ValueError(f"{m['name']} {kind}: 出るクエストの群 {sorted(used_groups - {None})} の一部だけが置き換わる "
                             "(群ごとに持つ形にする)")
        return hz(False, c["confidence"], c)
    if unknown:
        c = unknown[0]
        if kind == "arch-tempered":
            return hz(None, c["confidence"], c,
                      "傷口の肉質の置き換えがあるが、いつ使われるか分からない (woundConversions)。"
                      "woundOverrides と elementRecommendation は置き換わるとしたときの値 (参考)")
        return hz(True, "medium", None,
                  "条件の分からない傷口の肉質の置き換えがある (woundConversions)。歴戦の個体に使われるかは確かめていない")
    return hz(True, AT_NO_CONVERT_CONF if kind == "arch-tempered" else TEMPERED_CONF)


def group_by_rank(em_id: str, legendary_id: str) -> list[dict]:
    """報酬ランク (1〜10) → 群 の対応を区間にまとめる (individuals の説明用)。"""
    out = []
    for r in range(1, 11):
        g, why = param_group(em_id, legendary_id, r)
        if out and out[-1]["group"] == g and out[-1]["reason"] == why:
            out[-1]["max"] = r
        else:
            out.append({"min": r, "max": r, "group": g, "reason": why})
    return out


# ---------------------------------------------------------------- 体力

def _f32(v: float) -> float:
    return struct.unpack("<f", struct.pack("<f", float(v)))[0]


def _solo(base: int, quest_health: float, rand: float, leg: float) -> int:
    """ceil(float32(float32(基礎体力) × float32(クエストの _Health) × float32(乱数の等級) × float32(群の HealthRate)))"""
    return math.ceil(_f32(_f32(base) * _f32(quest_health) * _f32(rand) * _f32(leg)))


class HealthModel:
    """EmCommonDifficulty2 (乱数の等級と確率表) と各モンスターの Param_Parts / Param_Legendary を持つ。"""

    def __init__(self, monsters: list[dict]):
        diff = _load(DIFFICULTY_REL)[0]["app.user_data.EmParamDifficulty2"]
        self.rates = _inner(diff["_RandomRateTblArray"][0])  # {"_ValueM3": 0.94, ...}
        self.prob_tables = [_inner(p) for p in diff["_RandomProbabilityTblArray"]]
        idx = _load("natives_index.json")
        self.by_id = {m["id"]: m for m in monsters}
        self.legendary = {}
        for m in monsters:
            ix = idx[m["emId"]]
            parts = _load(ix["parts"])[0]["app.user_data.EmParamParts"]
            if int(parts["_BaseHealth"]) != m["baseHealth"]:
                raise ValueError(f"{m['name']}: MHDB の baseHealth {m['baseHealth']} と Param_Parts の _BaseHealth "
                                 f"{parts['_BaseHealth']} が違う")
            self.legendary[m["id"]] = raw_legendary(ix.get("legendary"))

    def grades(self, range_index: int) -> list[tuple[float, int]]:
        """確率表 range_index の (乱数の等級, 確率%) (確率 0 は除く)。"""
        out = []
        for k, p in self.prob_tables[range_index].items():
            if k.startswith("_Prob") and p > 0:
                out.append((float(self.rates["_Value" + k.removeprefix("_Prob")]), int(p)))
        return sorted(out)

    def grade_tables(self) -> list[dict]:
        """quests.json の meta.healthGrades に入れる確率表 (adjustRange ごとの 乱数の等級と確率%)。"""
        return [{"adjustRange": ri, "rates": [r for r, _ in self.grades(ri)], "probs": [p for _, p in self.grades(ri)]}
                for ri in range(len(self.prob_tables))]

    def target(self, monster_id: int, legendary_id: str, reward_rank: int | None, quest_health,
               quest_attack, solo_list: list[int]) -> dict:
        """クエストの狩猟対象 1 体ぶんの群・体力・攻撃の倍率の目安。

        群の倍率そのものは monsters.json の legendaryParams[paramGroup] (ここには重ねて持たない)。
        """
        m = self.by_id[monster_id]
        if reward_rank is None:
            return {"rewardRank": None, "paramGroup": None, "paramGroupReason": "unknown",
                    "healthCalc": None, "attackRate": None}
        group, why = param_group(m["emId"], legendary_id, reward_rank)
        raw = self.legendary[monster_id]
        suf = GROUP_SUFFIX.get(group) if group else None
        leg_h = float(raw["HealthRate" + suf]) if group else 1.0
        calc = None
        if quest_health is not None:
            want = sorted(set(solo_list))
            hit = None
            for ri in range(len(self.prob_tables)):
                vals = sorted({_solo(m["baseHealth"], quest_health, r, leg_h) for r, _ in self.grades(ri)})
                if vals == want:
                    hit = ri
                    break
            calc = {"mid": _solo(m["baseHealth"], quest_health, 1.0, leg_h),
                    "min": want[0] if hit is not None else None, "max": want[-1] if hit is not None else None,
                    "adjustRange": hit, "matchesMissionData": hit is not None,
                    "confidence": CONF_HEALTH if hit is not None else "low"}
        atk = None
        if group and quest_attack is not None:
            atk = {"calm": round(float(quest_attack) * float(raw["NoAngryAttackRate" + suf]), 4),
                   "angry": round(float(quest_attack) * float(raw["AngryAttackRate" + suf]), 4),
                   "confidence": CONF_ATTACK}
        return {"rewardRank": reward_rank, "paramGroup": group, "paramGroupReason": why,
                "healthCalc": calc, "attackRate": atk}


def multi_info(t: dict, max_players: int | None) -> dict | None:
    """MissionData の _MultiTableId が指す表の、人数ごとの体力・部位の耐久の倍率 (_Count = 人数と推定)。

    攻撃の倍率 (_Attack) は全部の表で 1 なので持たない (1 でない表があれば生成を止める)。
    tableId は表の id (同じ表を使う行は同じ値になる。テストで確かめる)。
    """
    if not t.get("multiTableId"):
        return None
    top = max_players or 4
    counts = [n for n in (2, 3, 4) if n <= top]
    mt = t["multi"]
    if any(mt[n]["health"] is None for n in counts):
        return None
    if any(mt[n]["attack"] != 1 for n in (2, 3, 4)):
        raise ValueError(f"マルチの攻撃の倍率が 1 でない表がある: {t['multiTableId']} (multi に attack を足す)")
    return {"tableId": t["multiTableId"],
            "health": {str(n): mt[n]["health"] for n in counts},
            "partsVital": {str(n): mt[n]["partsVital"] for n in counts},
            "confidence": CONF_MULTI}


# ---------------------------------------------------------------- 配信状況 (wiki の Time Period)

def fetched_date(rel: str) -> str:
    """キャッシュの取得日 (日本時間の日付)。"""
    man = json.loads(MANIFEST.read_text(encoding="utf-8"))["files"][rel]
    t = _dt.datetime.fromisoformat(man["fetchedAt"]).astimezone(_dt.timezone(_dt.timedelta(hours=9)))
    return t.date().isoformat()


def _parse_period(text: str) -> dict:
    """'May 6 - 20, 2025' / 'July 28 - August 11, 2025' / 'December 16, 2025 - February 2, 2026' /
    'August 4, 2026' (開始日だけ) / 'April 14 - 21' (年なし → from/to は null)"""
    s = re.sub(r"\s+", " ", text).strip()
    m = re.fullmatch(r"([A-Za-z]+) (\d{1,2})(?:, (\d{4}))?(?: - (?:([A-Za-z]+) )?(\d{1,2})(?:, (\d{4}))?)?", s)
    out = {"from": None, "to": None, "text": s}
    if not m or m.group(1).lower() not in MONTHS:
        return out
    m1, d1, y1, m2, d2, y2 = m.groups()
    mo1 = MONTHS[m1.lower()]
    if d2 is None:  # 開始日だけ
        if y1:
            out["from"] = _dt.date(int(y1), mo1, int(d1)).isoformat()
        return out
    mo2 = MONTHS[m2.lower()] if m2 else mo1
    if not (y1 or y2):
        return out
    yy2 = int(y2 or y1)
    yy1 = int(y1) if y1 else (yy2 - 1 if mo1 > mo2 else yy2)
    out["from"] = _dt.date(yy1, mo1, int(d1)).isoformat()
    out["to"] = _dt.date(yy2, mo2, int(d2)).isoformat()
    return out


def availability(row: dict, category: str | None, as_of: str) -> dict:
    """wiki の time_period から配信状況。

    status: permanent (常設) / inactive (終了中。periods に過去の配信期間) / active (配信中) /
            standard (期間の記載が無い通常のクエスト・任務) / unknown。as_of (wiki の取得日) は meta に持つ
    """
    raw = row.get("time_period")
    out = {"status": "unknown", "periods": [], "permanentFrom": None, "text": None}
    if not raw:
        out["status"] = "standard" if category in ("optional", "assignment", "arena") else "unknown"
        return out
    pieces = [re.sub(r"''", "", p).strip() for p in re.split(r"<br\s*/?>", raw)]
    flags = []
    for p in pieces:
        if not p:
            continue
        if p in ("Permanently Active", "Made Permanent", "Inactive"):
            flags.append(p)
        else:
            out["periods"].append(_parse_period(p))
    out["text"] = " / ".join(x for x in pieces if x)
    if "Permanently Active" in flags or "Made Permanent" in flags:
        out["status"] = "permanent"
        # 「August 4, 2026 <br> Permanently Active」のような開始日だけの行は、その日から常設
        starts = [p["from"] for p in out["periods"] if p["from"] and p["to"] is None]
        if "Permanently Active" in flags and starts:
            out["permanentFrom"] = max(starts)
    elif "Inactive" in flags:
        out["status"] = "inactive"
    if any(p["from"] and p["to"] and p["from"] <= as_of <= p["to"] for p in out["periods"]):
        out["status"] = "active"
    return out


def quest_page_importance(page_name: str) -> str | None:
    """取得してある wiki のクエストページの Infobox の Importance (無ければ None)。"""
    p = CACHE / wiki_page_rel(page_name)
    if not p.exists():
        return None
    text = json.loads(p.read_text(encoding="utf-8"))["parse"]["wikitext"]["*"]
    m = re.search(r"^\|Importance\s*=\s*([^\n]*)$", text, re.M)
    return m.group(1).strip() if m and m.group(1).strip() else None


# ---------------------------------------------------------------- 歴戦王の行動の変化 (wiki)

def _unlink(s: str) -> str:
    s = re.sub(r"\[\[[^\]|]*\|([^\]]*)\]\]", r"\1", s)
    s = re.sub(r"\[\[([^\]]*)\]\]", r"\1", s)
    return re.sub(r"\s+", " ", s).strip()


def at_section_bullets(name_en: str) -> list[str]:
    """wiki の個別ページの「==== Arch-Tempered ====」節の箇条書き (リンクを外した英文)。"""
    rel = wiki_page_rel(f"{name_en} (MHWilds)")
    text = _load(rel)["parse"]["wikitext"]["*"]
    m = re.search(r"^====\s*Arch-Tempered\s*====\s*$(.*?)(?=^<div|^==|\Z)", text, re.M | re.S)
    if not m:
        raise ValueError(f"wiki の {name_en} (MHWilds) に歴戦王の節が無い (ページの構成が変わった?)")
    return [_unlink(b) for b in re.findall(r"^\*\s*(.+)$", m.group(1), re.M)]


def _skill_ref(sk: dict, en: str, negate: int | None, mitigate: int | None) -> dict:
    s = sk[en]
    d = {"skill": s["name"], "skillEn": en, "skillId": s["skillId"]}
    if negate is not None:
        d["negateLevel"] = negate
    if mitigate is not None:
        d["mitigateLevel"] = mitigate
    d["levelText"] = s["levels"]
    return d


def attach_threat_variants(threats: list[dict], monsters: list[dict], skill_ids: dict) -> list[str]:
    """monster_threats.json の各行に variants を足す (歴戦王のいる 5 体だけ中身がある)。戻り値は未翻訳などの記録。"""
    by_id = {m["id"]: m for m in monsters}
    notes = []
    for row in threats:
        m = by_id[row["monsterId"]]
        row["variants"] = {}
        if "arch-tempered" not in m["variants"]:
            continue
        en = row["nameEn"]
        bullets = at_section_bullets(en)
        moves = []
        for b in bullets:
            ja = MOVE_JA.get(b)
            if ja is None:
                notes.append(f"{m['name']}: 歴戦王の行動の変化の訳が無い (wiki の文が変わった?): {b[:60]}")
            moves.append({"text": ja, "textEn": b})
        hazards = []
        for h in AT_HAZARDS.get(en, []):
            if not any(h["wikiMatch"] in b for b in bullets):
                raise ValueError(f"{m['name']}: wiki の歴戦王の節に「{h['wikiMatch']}」が無い (記述が変わった。AT_HAZARDS を見直す)")
            skill = _skill_ref(skill_ids, *h["skill"]) if h["skill"] else None
            hz = {"key": h["key"], "text": h["text"], "skill": skill, "oneShot": h["oneShot"],
                  "source": row["wikiUrl"], "confidence": h["confidence"]}
            if h.get("noSkill"):
                hz["noSkill"] = h["noSkill"]
            if h.get("note"):
                hz["note"] = h["note"]
            hazards.append(hz)
        row["variants"]["arch-tempered"] = {
            "name": m["variantNames"]["arch-tempered"],
            "sameAsBase": {"roar": True, "windPressure": True, "tremor": True, "blights": True, "statusEffects": True,
                           "confidence": "medium", "reason": SAME_AS_BASE_REASON},
            "moveChanges": moves,
            "hazards": hazards,
            "source": row["wikiUrl"],
        }
    return notes


# ---------------------------------------------------------------- 歴戦王の報酬 (MHDB)

def at_rewards(monsters: list[dict]) -> dict[int, dict]:
    """狩猟証γ (説明文「歴戦王○○の狩猟に成功した者に…」) から モンスター → γ 防具・固定護石。

    MHDB の防具・護石 (tools/.cache/equip/mhdb/。data/armor.json と data/charms_fixed.json の生成元) を使う。
    """
    for rel in ("mhdb/armor.json", "mhdb/charms.json"):
        if not (EQUIP_CACHE / rel).exists():
            raise FileNotFoundError(f"{EQUIP_CACHE / rel} が無い。先に tools/build_equip.py を実行する")
    armor = _load("mhdb/armor.json", EQUIP_CACHE)
    charms = _load("mhdb/charms.json", EQUIP_CACHE)
    by_name = {m["name"]: m["id"] for m in monsters}
    items = {}
    for a in armor:
        for mat in (a.get("crafting") or {}).get("materials") or []:
            it = mat["item"]
            desc = re.sub(r"\s+", "", it.get("description") or "")
            mm = re.match(r"歴戦王(.+?)の狩猟に成功", desc)
            if it["name"].endswith("狩猟証γ") and mm:
                if mm.group(1) not in by_name:
                    raise ValueError(f"狩猟証γ の説明文のモンスター名を解決できない: {mm.group(1)}")
                items[it["id"]] = {"itemId": it["id"], "name": it["name"], "monsterId": by_name[mm.group(1)]}
    out = {}
    for item_id, it in sorted(items.items()):
        sets, group_skills = {}, {}
        for a in armor:
            mats = {x["item"]["id"] for x in (a.get("crafting") or {}).get("materials") or []}
            if item_id not in mats:
                continue
            s = sets.setdefault(a["armorSet"]["id"], {"armorSetId": a["armorSet"]["id"], "name": a["armorSet"]["name"],
                                                    "armorIds": []})
            s["armorIds"].append(a["id"])
            for sk in a["skills"]:
                if sk["skill"]["kind"] == "group":
                    group_skills[sk["skill"]["id"]] = sk["skill"]["name"]
        charm_ids = sorted(r["id"] for c in charms for r in c["ranks"]
                           if item_id in {x["item"]["id"] for x in (r.get("crafting") or {}).get("materials") or []})
        for s in sets.values():
            s["armorIds"].sort()
        out[it["monsterId"]] = {
            "certificate": {"itemId": it["itemId"], "name": it["name"]},
            "armorSets": sorted(sets.values(), key=lambda s: s["armorSetId"]),
            "groupSkills": [{"skillId": k, "name": v} for k, v in sorted(group_skills.items())],
            "charmFixedIds": charm_ids,
            "source": "https://wilds.mhdb.io/ja/armor , https://wilds.mhdb.io/ja/charms (crafting の素材)",
        }
    return out


# ---------------------------------------------------------------- 個体の一覧 (monsters.json の individuals)

def _version(v: str | None) -> str | None:
    """'VER_1041_00_00' → '1.041'"""
    m = re.fullmatch(r"VER_(\d)(\d{3})_\d{2}_\d{2}", v or "")
    return f"{m.group(1)}.{m.group(2)}" if m else None


def _label(monster_name: str, kind: str | None, vname: str | None) -> tuple[str, str]:
    """(表示名, 種類の短い名前)。MHDB の個体名 (例「レ・ダウ（歴戦の個体）」「狂竜化ネルスキュラ」) から作る。"""
    if kind is None:
        return monster_name, KIND_LABEL[None]
    short = (vname or "").replace(monster_name, "").strip("（）()・ ")
    if not vname or not short:
        # MHDB の個体名が基本種と同じ (オメガ・プラネテスの歴戦の個体) ときは種類名を添える
        return f"{monster_name}（{KIND_LABEL[kind]}）", KIND_LABEL[kind]
    return vname, short


def attach_individuals(monsters: list[dict], quests: list[dict], rewards: dict[int, dict],
                       threats: list[dict]) -> dict:
    """各モンスターに individuals (通常 + MHDB の variants) を足す。戻り値は集計。"""
    by_q = {q["id"]: q for q in quests}
    threat_by_id = {t["monsterId"]: t for t in threats}
    rep = {"archTempered": [], "legendaryMismatch": []}
    for i, m in enumerate(monsters):
        kinds = [None] + list(m["variants"])
        rows = []
        for kind in kinds:
            name, label = _label(m["name"], kind, m["variantNames"].get(kind) if kind else None)
            leg = LEGENDARY_OF_KIND[kind]
            qids, iqids, stars = [], [], set()
            used = defaultdict(set)  # 群 → 報酬ランク
            versions = []
            for q in quests:
                if any(t["monsterId"] == m["id"] and t["variant"] == kind for t in q["targets"] if t["large"]):
                    qids.append(q["id"])
                    stars.add(q["stars"])
                    if q["mission"]:
                        # 同じクエストに同じモンスターの別の個体がいることがあるので、LegendaryID で見分ける
                        # (狂竜化・ボス個体は MissionData では NONE)
                        mts = [mt for mt in q["mission"]["targets"]
                               if mt["monsterId"] == m["id"] and mt["legendaryId"] == leg]
                        if not mts:
                            rep["legendaryMismatch"].append(
                                f"{m['name']} {kind}: {q['id']} の MissionData に LegendaryID={leg} の行が無い")
                        for mt in mts:
                            if mt["rewardRank"] is not None:
                                used[mt["paramGroup"]].add(mt["rewardRank"])
                            if kind == "arch-tempered":
                                versions.append((q["stars"], q["mission"]["version"]))
                if any(t["monsterId"] == m["id"] and t["variant"] == kind for t in q["intruders"]):
                    iqids.append(q["id"])
            sort_key = lambda x: (by_q[x]["stars"], x)  # noqa: E731
            rates = []
            for g, ranks in sorted(used.items(), key=lambda kv: (min(kv[1]), kv[0] or "")):
                lp = m["legendaryParams"][g] if g else None
                rates.append({
                    "group": g, "rewardRanks": sorted(ranks),
                    "health": lp["health"] if lp else 1.0,
                    "attackCalm": lp["attackCalm"] if lp else None,
                    "attackAngry": lp["attackAngry"] if lp else None,
                    "partsVital": lp["partsVital"] if lp else None,
                    "healthConfidence": CONF_HEALTH, "attackConfidence": CONF_ATTACK,
                })
            # 理由の文は meta.individualsHitzone に 1 回だけ持つ。傷口の肉質の置き換えは m["woundConversions"]
            hitzone = individual_hitzone(m, kind, set(used))
            row = {
                "kind": kind, "label": label, "name": name, "legendaryId": leg,
                "groupByRank": group_by_rank(m["emId"], leg),
                "rates": rates,
                "questIds": sorted(qids, key=sort_key),
                "intruderQuestIds": sorted(iqids, key=sort_key),
                "stars": sorted(stars),
                "hitzone": hitzone,
                "threatVariant": kind if kind and kind in threat_by_id[m["id"]]["variants"] else None,
            }
            if kind == "arch-tempered":
                en = threat_by_id[m["id"]]["nameEn"]
                rel = AT_RELEASE.get(en)
                if rel is None:
                    raise ValueError(f"{m['name']}: AT_RELEASE に追加日の記録が無い (新しい歴戦王?)")
                first = min(versions, key=lambda x: x[1]) if versions else (None, None)
                star10 = min((v for s, v in versions if s == 10), default=None)
                row["added"] = {"version": _version(first[1]), "date": rel["date"],
                                "dateConfidence": rel["dateConfidence"], "note": rel["note"], "sources": rel["sources"]}
                row["star10"] = ({"version": _version(star10), **AT_STAR10} if star10 else None)
                if m["id"] not in rewards:
                    raise ValueError(f"{m['name']}: 狩猟証γ が見つからない")
                row["rewards"] = rewards[m["id"]]
                rep["archTempered"].append(m["name"])
            rows.append(row)
        # individuals は legendaryParams の次に置く
        out = {}
        for k, v in m.items():
            out[k] = v
            if k == "legendaryParams":
                out["individuals"] = rows
        monsters[i] = out
    return rep
