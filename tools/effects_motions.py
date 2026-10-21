"""片手剣のモーション値 (motions_sns.json) と代表コンボ (combos_sns.json) を組み立てる。

数値 (MV・属性補正・斬れ味の扱い・会心可否・飛燕対象) はすべて RCOL (当たり判定) の
AttackParamPl から読む。技とヒットの対応 (どの requestSet がどの技か) は MHWS-in-json の
技名対応表 (WeaponActionValues.xlsx の MappingInternalName) を元に、ここで手で並べる。
"""
from __future__ import annotations

import math
import re

from effects_source import rcol_hits, shell_list, shell_main, xlsx_move_names

FILES = {"A": "Wp01_Attack", "SA": "Wp01_SubAttack", "S": "Wp01_Shell"}
ENUM_RE = re.compile(r"^\[(-?\d+)\]\s*(\S+)$")
FRAMES_PER_SEC = 60  # _MultiHitTimer をフレーム (60fps) と見たときの換算 (推定)


def _sym(v) -> str:
    if isinstance(v, dict):
        v = next(iter(v.values()))["_Value"]
    m = ENUM_RE.match(str(v))
    return m.group(2) if m else str(v)


class HitTable:
    """RCOL のヒット定義を引く。"""

    def __init__(self):
        self.tables = {k: rcol_hits(v) for k, v in FILES.items()}

    def hit(self, ref: str, *, count: int = 1, label: str = "", mapping: str = "proven",
            count_basis: str = "", note: str = "") -> dict:
        f, rs = ref.split("#")
        p = self.tables[f][int(rs)]
        uses_elem = bool(p["_UseStatusAttrPower"])
        no_use = bool(p["_IsNoUseKireaji"])
        force = bool(p["_IsForceUseKireajiAttackRate"])
        out = {
            "ref": f"{FILES[f]}#{rs}",
            "label": label,
            "mv": p["_Attack"],
            "count": count,
            "type": _sym(p["_ActionTypeFixed"]).lower(),           # slash / blow / none
            "usesElement": uses_elem,
            "elementRate": p["_StatusAttrRate"] if uses_elem else 0,  # 技の属性補正 (属性を使わないヒットは 0)
            "elementRateRaw": p["_StatusAttrRate"],
            "canCrit": not p["_IsNoCritical"],
            "sharpnessMul": (not no_use) or force,   # 斬れ味補正が掛かるか
            "consumesSharpness": not no_use,          # 斬れ味を消費するか
            "sharpnessCostRaw": p["_CustomKireajiReduce"] if p["_IsCustomKireajiReduce"] else None,
            "hien": bool(p["_IsSkillHien"]),
            "additionalDamage": bool(p["_UseSkillAdditionalDamage"]),
            "continuousAttack": bool(p["_UseSkillContinuousAttack"]),
            "multiHit": "USE_MULIT_HIT" in str(p["_FlagBit"]),
            "multiHitTimer": p["_MultiHitTimer"],
            "fixed": p["_FixAttack"],
            "mapping": mapping,
        }
        if count_basis:
            out["countBasis"] = count_basis
        if note:
            out["note"] = note
        return out


def _shell_children(parent_key: str) -> list[dict]:
    """弾の子弾 (INDEX_1/INDEX_2) を RCOL の requestSetID と生成数に解決する。"""
    sl = shell_list()
    main = shell_main(parent_key)
    out = []
    for c in main["children"]:
        info = sl[c["shellNameHash"]]
        out.append({"index": c["index"], "createNum": c["createNum"],
                    "requestSetId": info["attackCollisionId"], "fixedId": info["fixedId"]})
    return out


def build_motions() -> tuple[dict, list[str]]:
    """motions_sns.json の本体 (meta 以外) と、照合で出た注意のリストを返す。"""
    ht = HitTable()
    warnings: list[str] = []

    fin = {c["index"]: c for c in _shell_children("Wp01_FinishSlash")}
    rush = {c["index"]: c for c in _shell_children("Wp01_RushFinishSlash")}
    old = shell_main("Wp01_OldScarSlash")
    tear = ht.tables["S"][0]
    tear_count = math.floor(old["lifeSec"] * FRAMES_PER_SEC / tear["_MultiHitTimer"])
    fin1, fin2 = fin["[0] INDEX_1"], fin["[1] INDEX_2"]
    rush1, rush2 = rush["[0] INDEX_1"], rush["[1] INDEX_2"]
    child_basis = "親の弾 (MainParam) の CallCustomChildShell._CreateNum"
    tear_basis = (f"Wp01_OldScarSlash の _LifeSec={old['lifeSec']} 秒 と _MultiHitTimer={tear['_MultiHitTimer']} "
                  f"(60fps のフレームと仮定) から {tear_count} 回と推定")

    H = ht.hit
    moves = [
        # (id, 表示名, 内部名, ヒット, 確度, 注記)
        ("slash_1", "斬り下ろし", "WP01_SLASH_1", [H("A#0")], "high", ""),
        ("slash_2", "横斬り", "WP01_SLASH_2", [H("A#1")], "high", ""),
        ("slash_3", "斜め斬り上げ", "WP01_SLASH_3", [H("A#2")], "high", ""),
        ("slash_4", "斜め斬り下ろし", "WP01_SLASH_4", [H("A#3")], "high",
         "ゲーム内ガイドの『斜め斬り下ろし』は△連携 4 段 (18/17/24/27) をまとめて指す。ここでは 4 段目 (27) だけ。"),
        ("spin_slash", "回転斬り", "WP01_SPIN_SLASH", [H("A#5")], "high", ""),
        ("spin_upper_slash", "回転斬り上げ", "WP01_SPIN_UPPER_SLASH", [H("A#12")], "high", ""),
        ("spin_slash_2", "旋刈り", "WP01_SPIN_SLASH_2", [H("A#15")], "high", ""),
        ("horizontal_slash", "水平斬り", "WP01_HORIZONTAL_SLASH", [H("A#7")], "high", ""),
        ("vertical_slash", "斬り返し", "WP01_VERTICAL_SLASH", [H("A#8")], "high", ""),
        ("upper_slash", "斬り上げ", "WP01_UPPER_SLASH", [H("A#6")], "high", ""),
        ("dash_slash", "突進斬り", "WP01_DASH_SLASH", [H("A#4")], "high", ""),
        ("guard_slash", "ガード斬り", "WP01_GUARD_SLASH", [H("A#17")], "high", ""),
        ("sliding_slash", "滑り込み斬り", "WP01_SLIDING_SLASH", [H("A#23"), H("A#24")], "high", ""),
        ("charge_slash", "溜め斬り", "WP01_CHARGE_SLASH", [H("A#10"), H("A#11")], "high", ""),
        ("finish_slash", "溜め斬り落とし", "WP01_FINISH_SLASH",
         [H("A#6"), H("A#13"),
          H(f"S#{fin1['requestSetId']}", count=fin1["createNum"], label="子弾 (FINISH_SLASH_CHILD)", count_basis=child_basis)],
         "medium",
         "3〜6 ヒット目は子弾。INDEX_1 の子弾 (MV14・属性補正0.3) を通常とした。INDEX_2 の子弾 (MV28・属性補正1.25) は "
         "finish_slash_strong。資料で属性補正が 0.3 と 1.25 に割れるのはこの 2 種類の子弾のため。"
         "A#14 (MV22・多段) は発生条件と回数が不明なので含めない。"),
        ("finish_slash_strong", "溜め斬り落とし (強化子弾)", "WP01_FINISH_SLASH",
         [H("A#6"), H("A#13"),
          H(f"S#{fin2['requestSetId']}", count=fin2["createNum"], label="子弾 (FINISH_SLASH_CHILD_STRONG)", count_basis=child_basis)],
         "low", "INDEX_2 の子弾が出る条件は未確定 (ジャスト系・傷口などの候補)。"),
        ("shield_bash_1", "盾攻撃", "WP01_SHIELD_BASH_1", [H("SA#102")], "high", "盾のヒットは属性を使わない (_UseStatusAttrPower=false)。"),
        ("shield_bash_2", "バックナックル", "WP01_SHIELD_BASH_2", [H("SA#103")], "high", ""),
        ("shield_bash_3", "ハードバッシュ", "WP01_SHIELD_BASH_3", [H("SA#104")], "high", ""),
        ("jump_slash", "ジャンプ斬り", "WP01_JUMP_SLASH", [H("A#10"), H("A#11")], "high", ""),
        ("fall_bash", "フォールバッシュ", "WP01_FALL_BASH", [H("SA#105"), H("SA#106")], "high", ""),
        ("em_step_jump_slash", "駆け上がり斬り", "WP01_EM_STEP_JUMP_SLASH", [H("A#20")], "high", ""),
        ("jump_dash_slash", "ジャンプ突進斬り", "WP01_JUMP_DASH_SLASH", [H("A#19")], "high", ""),
        ("jump_upper_slash", "ジャンプ斬り上げ", "WP01_JUMP_USLASH", [H("A#36")], "high", ""),
        ("sliding_draw_slash", "スライディング斬り", "WP01_SLIDING_DRAW_SWORD", [H("A#21"), H("A#22")], "high", ""),
        ("just_guard_slash", "反撃斬り", "WP01_JUST_GUARD_SLASH", [H("A#35")], "high",
         "A#701 (MV18・斬れ味消費なし) は発生条件不明なので含めない。"),
        ("just_rush_start", "飛び込み斬り", "WP01_JUST_RUSH_START", [H("A#50")], "high", ""),
        ("just_rush_1_just", "ジャストラッシュ1段目 (ジャスト成功)", "WP01_JUST_RUSH_1",
         [H("SA#150", label="盾"), H("A#51", label="剣"), H("A#53", label="剣")], "high", ""),
        ("just_rush_1_miss", "ジャストラッシュ1段目 (ジャスト失敗)", "WP01_JUST_RUSH_1",
         [H("SA#151", label="盾"), H("A#52", label="剣"), H("A#54", label="剣")], "high", ""),
        ("just_rush_2_just", "ジャストラッシュ2段目 (ジャスト成功)", "WP01_JUST_RUSH_2", [H("SA#157", label="盾")], "high", ""),
        ("just_rush_2_miss", "ジャストラッシュ2段目 (ジャスト失敗)", "WP01_JUST_RUSH_2", [H("SA#158", label="盾")], "high", ""),
        ("just_rush_3_just", "ジャストラッシュ3段目 (ジャスト成功)", "WP01_JUST_RUSH_3",
         [H("A#55", label="剣"),
          H("SA#160", label="盾", mapping="inferred",
            note="技名の対応表に無いヒット。調査値の『80・25・34×3』の 25 に当たるので含めた。"),
          H(f"S#{rush2['requestSetId']}", count=rush2["createNum"], label="子弾 (RUSH_FINISH_SLASH_CHILD_STRONG)",
            count_basis=child_basis)],
         "medium", ""),
        ("just_rush_3_miss", "ジャストラッシュ3段目 (ジャスト失敗)", "WP01_JUST_RUSH_3",
         [H("A#56", label="剣"),
          H(f"S#{rush1['requestSetId']}", count=rush1["createNum"], label="子弾 (RUSH_FINISH_SLASH_CHILD)",
            count_basis=child_basis)],
         "medium", "失敗時に INDEX_1 の子弾が出ると推定。"),
        ("aim_attack_nohit", "集中急所突き (傷なし)", "WP01_AIM_ATTACK_NOHIT", [H("A#25")], "high", ""),
        ("aim_attack_wound", "集中急所突き (傷口)", "WP01_AIM_ATTACK_NOHIT",
         [H("A#25"), H("A#26", label="傷口の追加ヒット")], "high", ""),
        ("aim_attack_old_scar", "集中急所突き (白傷)", "WP01_AIM_ATTACK_NOHIT",
         [H("A#25"), H("A#26", label="傷口の追加ヒット"),
          H("S#0", count=tear_count, label="白傷の追加ヒット (TEAR_SCAR_HIT)", count_basis=tear_basis)],
         "medium", ""),
        ("const_finish", "フォールスラッシュ", "WP01_CONST_FINISH", [H("A#30"), H("A#31")], "medium",
         "A#33 (MV7・多段) の回数が不明なので含めない。"),
        ("const_finish_bash", "バッシュアッパー", "WP01_CONST_FINISH_BASH", [H("SA#131"), H("SA#132")], "medium", ""),
    ]
    names = xlsx_move_names()
    out_moves = []
    for mid, name, internal, hits, conf, note in moves:
        base = name.split(" (")[0]
        game_name = names.get(internal)
        if game_name and game_name != base and not base.startswith(game_name):
            warnings.append(f"技名の食い違い: {mid} 表示={name} 対応表={game_name}")
        out_moves.append({"id": mid, "name": name, "internal": internal, "gameName": game_name,
                          "hits": hits, "confidence": conf, "note": note})

    # どの技にも入れていないヒット (発生条件・回数が不明)。データとして残す。
    unused = []
    for ref, why in (("A#40", "斬り下ろし〜斜め斬り下ろしに付く MV7 の追加ヒット。発生条件不明"),
                     ("A#700", "突進斬りに付く追加ヒット。発生条件不明"),
                     ("A#701", "反撃斬りに付く追加ヒット。発生条件不明"),
                     ("A#702", "斬り上げに付く追加ヒット。発生条件不明"),
                     ("A#14", "溜め斬り落としの多段ヒット。回数不明"),
                     ("A#18", "落下突きの多段ヒット。回数不明"),
                     ("A#33", "フォールスラッシュの多段ヒット。回数不明"),
                     ("A#32", "技名の対応表に無い"),
                     ("SA#107", "技名の対応表に無い"),
                     ("SA#130", "技名の対応表に無い (多段)")):
        h = ht.hit(ref, mapping="unmapped")
        h["note"] = why
        unused.append(h)
    return {"moves": out_moves, "unusedHits": unused}, warnings


COMBOS = [
    {"id": "just_rush_perfect", "name": "ジャストラッシュ1周 (全段ジャスト成功)",
     "steps": [{"move": "just_rush_1_just"}, {"move": "just_rush_2_just"}, {"move": "just_rush_3_just"}],
     "confidence": "medium",
     "note": "ラッシュ部分だけ (入り口の飛び込み斬りは含めない)。3段目の盾ヒット (MV25) は対応が推定。"},
    {"id": "focus_wound", "name": "集中弱点攻撃で傷を突く",
     "steps": [{"move": "aim_attack_wound", "onWound": True}],
     "confidence": "high",
     "note": "全ヒットを傷口の肉質で計算する (傷口の会心補正も乗る)。"},
    {"id": "ground_basic", "name": "通常の地上コンボ (△連携)",
     "steps": [{"move": "slash_1"}, {"move": "slash_2"}, {"move": "slash_3"}, {"move": "slash_4"}],
     "confidence": "medium",
     "note": "斬り下ろし→横斬り→斜め斬り上げ→斜め斬り下ろし。入力の並びはゲーム内ガイドの『威力の高い連携』を参考にした代表例。"
             "MV7 の追加ヒット (A#40) は発生条件不明なので含めない。"},
    {"id": "charged_chop", "name": "溜め斬り落とし (単発)",
     "steps": [{"move": "finish_slash"}],
     "confidence": "medium",
     "note": "子弾は通常 (MV14×4・属性補正0.3) の側。"},
]


def build_combos(moves: list[dict]) -> dict:
    ids = {m["id"] for m in moves}
    for c in COMBOS:
        for s in c["steps"]:
            if s["move"] not in ids:
                raise ValueError(f"コンボ {c['id']} の技 {s['move']} が motions に無い")
    return {"combos": COMBOS}
