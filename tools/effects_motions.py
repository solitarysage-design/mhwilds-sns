"""片手剣のモーション値 (motions_sns.json) と代表コンボ (combos_sns.json) を組み立てる。

数値 (MV・属性補正・斬れ味の扱い・会心可否・飛燕対象) はすべて RCOL (当たり判定) の
AttackParamPl から読む。技とヒットの対応 (どの requestSet がどの技か) は MHWS-in-json の
技名対応表 (WeaponActionValues.xlsx の MappingInternalName) を元に、ここで手で並べる。

技の時間 (moves[].timing と hits[].atSec。灼熱化の判定の間隔に使う) は、モーション一覧 (wp01_00.motlist.992) の
frameCount と当たり判定の区間 (_RequestSetID) と、モーションのつなぎ (wp01_00_mct) の再生の始まりから読む。
どのモーションを使うかと、次の技へのつなぎのフレーム (見積もり) は TIMING に手で書く。
"""
from __future__ import annotations

import math
import re

from effects_source import load_raw, rcol_hits, shell_list, shell_main, xlsx_move_names

FILES = {"A": "Wp01_Attack", "SA": "Wp01_SubAttack", "S": "Wp01_Shell"}
ENUM_RE = re.compile(r"^\[(-?\d+)\]\s*(\S+)$")
FRAMES_PER_SEC = 60  # _MultiHitTimer とモーションのフレームを 60fps と見たときの換算 (推定。確度 medium)

# ---------------------------------------------------------------- 技の時間 (docs/sources/damage.md「技の時間」)
# 技 id → (モーション番号, つなぎのフレーム (low, mid, high) | None, 注記)。
# モーション番号 = wp01_00.motlist.992 の motionId (その技のヒットの requestSetID が出るもの。2026-10-24 の調査で選んだ)。
# None = その技のモーションが決められない (timing を null にする)。
# つなぎ = 技の始まり (再生の始まり) から、次の技につなげられるまでのフレーム。ゲームデータに無いので見積もり (確度 low):
#   判定が終わった次のフレーム〜+20f を目安にした (斜め斬り下ろしは +40f まで)。調査の作業ファイル
#   (motion_timing/cycle_est.py) の値。None = 見積もっていない (計算では技の全長を使い、警告 no-timing を出す)。
TIMING: dict[str, tuple[int | None, tuple[int, int, int] | None, str]] = {
    "slash_1": (301, (24, 33, 43), "別系統のモーション 255 (判定 26f) もある。△連携の主の方を 301 とした (推定)。"),
    "slash_2": (302, (15, 24, 34), "別系統 256 (判定 12f)。"),
    "slash_3": (308, (29, 38, 48), "別系統 257 (判定 24f)。"),
    "slash_4": (309, (27, 45, 66), "別系統 258。締めの技で後隙が長いので、つなぎの幅を広く取った。"),
    "spin_slash": (305, None, ""),
    "spin_upper_slash": (331, None, ""),
    "spin_slash_2": (307, (37, 50, 82), ""),
    "horizontal_slash": (320, None, "A#7 は 335〜338 にも出る (つながり方の違いとみられる)。"),
    "vertical_slash": (321, None, ""),
    "upper_slash": (306, None, "A#6 は 167〜170・340 にも出る。"),
    "dash_slash": (304, None, ""),
    "guard_slash": (316, None, ""),
    "sliding_slash": (330, None, ""),
    "charge_slash": (313, None, "溜めの長押しの時間はモーションに入らない。"),
    "finish_slash": (340, (55, 90, 151),
                     "340 は既定で 50f 目から再生する (mct)。340 を溜め斬り落とし本体とみなしたのは推定 (332・341 にも A#13/A#14)。"
                     "溜めの長押しの時間は入らない。子弾の時刻は motlist に無い。"),
    "finish_slash_strong": (340, (55, 90, 151), "finish_slash と同じモーション・同じつなぎの見積もり。"),
    "shield_bash_1": (318, None, ""),
    "shield_bash_2": (319, None, ""),
    "shield_bash_3": (322, None, ""),
    "jump_slash": (None, None, "A#10/A#11 の出るモーションは 313 (溜め斬り) と 358 (既定で 50f 目から再生し、判定 44f より後) で、"
                               "ジャンプ斬りのものを決められない。"),
    "fall_bash": (355, None, "SA#106 (着地) は別のモーション 357 に出るので時刻を入れていない。"),
    "em_step_jump_slash": (347, None, ""),
    "jump_dash_slash": (353, None, ""),
    "jump_upper_slash": (352, None, ""),
    "sliding_draw_slash": (390, None, ""),
    "just_guard_slash": (329, None, "329 は既定で 15f 目から再生する (mct)。"),
    "just_rush_start": (414, (66, 75, 90), "旋刈り (307) から入るときは 70f 目から再生する (mct)。計算は既定の 0f から。"),
    "just_rush_1_just": (415, (60, 72, 90), "2 段目へのつなぎ (ジャストの受付) はデータに無く見積もり。"),
    "just_rush_1_miss": (415, None, ""),
    "just_rush_2_just": (416, (21, 30, 45), "3 段目は 2 段目のすぐ後に来るので、つなぎを早めに置いた。"),
    "just_rush_2_miss": (416, None, ""),
    "just_rush_3_just": (410, (47, 65, 90), "盾 SA#160 と子弾の時刻は motlist に無い。"),
    "just_rush_3_miss": (410, None, ""),
    "aim_attack_nohit": (465, None, ""),
    "aim_attack_wound": (465, (30, 60, 78), ""),
    "aim_attack_old_scar": (465, None, "白傷の追加ヒット (子弾) の時刻は motlist に無い。"),
    "const_finish": (504, None, ""),
    "const_finish_bash": (510, None, ""),
}
TIMING_SOURCE = ("MHWS-in-json wp01_00.motlist.992 (frameCount と AttackCollision の _RequestSetID の区間)・"
                 "wp01_00_mct (既定の再生の始まり)。60fps と仮定。つなぎは見積もり (2026-10-24 の調査)")


def _motion_table() -> dict[int, dict]:
    """motlist → {motionId: {name, frameCount, rs: {requestSetId: [開始フレーム, ...]}}} (当たり判定のあるモーションだけ)。"""
    doc = load_raw("Wp01Motlist")
    if doc.get("_format") != "re_engine_motlist_action_tracks_v1":
        raise SystemExit(f"motlist の形式が想定と違う: {doc.get('_format')}")
    out: dict[int, dict] = {}
    for m in doc["motions"]:
        clips = [c for c in m["clips"] if c.get("source") == "motion"]
        out[m["motionId"]] = {"name": m["motionName"], "frameCount": clips[0]["frameCount"] if clips else None,
                              "clips": len(m["clips"]), "rs": {}}
    for r in doc["requestSetMappings"]:
        if not r["trackName"].endswith("AttackCollision_PlWp"):
            continue
        out[r["motionId"]]["rs"].setdefault(r["requestSetId"], []).append(r["startFrame"])
    return out


def _default_starts() -> dict[int, float]:
    """mct (MotionConnect) → {motionId: 既定 (_Default_ から入るとき) の再生の始まりのフレーム}。"""
    lst = load_raw("Wp01Mct")[0]["ace.user_data.MotionConnect"]["_DataList"]
    out: dict[int, float] = {}
    for e in lst:
        o = e["ace.user_data.MotionConnect.cOneMotionData"]
        for c in o["_ChangeParamList"]:
            c = c["ace.user_data.MotionConnect.cChangeParamElement"]
            if c["_MotionListName"] == "_Default_":
                out[o["_MotionID"]] = c["_StartFrame"]
    return out


def _attach_timing(moves: list[dict], hit_tables: dict, warnings: list[str]) -> None:
    """moves[].timing と hits[].atFrame / atSec を入れる (TIMING に無い技があれば止める)。"""
    if set(hit_tables["A"]) & set(hit_tables["SA"]):
        raise SystemExit("Wp01_Attack と Wp01_SubAttack の requestSetID が重なっている (motlist の番号と突き合わせられない)")
    missing = [m["id"] for m in moves if m["id"] not in TIMING]
    if missing or set(TIMING) - {m["id"] for m in moves}:
        raise SystemExit(f"TIMING と技の一覧が合わない: 足りない {missing} / 余分 {sorted(set(TIMING) - {m['id'] for m in moves})}")
    mot = _motion_table()
    starts = _default_starts()
    fps = FRAMES_PER_SEC
    for m in moves:
        motion, link, note = TIMING[m["id"]]
        if motion is None:
            # モーションが決められない: 長さも時刻も無い (計算は 1.0 秒と 0 秒に置き、警告 no-timing)
            m["timing"] = {"motionId": None, "motionName": None, "startFrame": None, "frameCount": None, "fps": fps,
                           "linkFrames": None, "linkSec": None, "source": TIMING_SOURCE, "confidence": "low", "note": note}
            for h in m["hits"]:
                h["atFrame"] = None
                h["atSec"] = None
            continue
        info = mot.get(motion)
        if info is None or info["frameCount"] is None:
            raise SystemExit(f"{m['id']}: モーション {motion} が motlist に無い")
        if info["clips"] != 1:
            warnings.append(f"{m['id']}: モーション {motion} のクリップが {info['clips']} 個 (先頭の長さを使った)")
        start = starts.get(motion, 0)
        length = info["frameCount"] - start
        for h in m["hits"]:
            f, rs = h["ref"].split("#")
            at = None
            if f in (FILES["A"], FILES["SA"]):
                frames = info["rs"].get(int(rs))
                if frames:
                    at = min(frames) - start
                    if at < 0:
                        warnings.append(f"{m['id']}: {h['ref']} の判定 ({min(frames)}f) が再生の始まり ({start}f) より前なので時刻なし")
                        at = None
                elif h["additionalDamage"]:
                    warnings.append(f"{m['id']}: 灼熱化の対象ヒット {h['ref']} がモーション {motion} に無い")
            h["atFrame"] = int(at) if at is not None else None
            h["atSec"] = round(at / fps, 6) if at is not None else None
        timing = {"motionId": motion, "motionName": info["name"], "startFrame": int(start), "frameCount": int(length),
                  "fps": fps, "linkFrames": None, "linkSec": None, "source": TIMING_SOURCE, "confidence": "low", "note": note}
        if link is not None:
            lo, mid, hi = link
            if not (0 < lo <= mid <= hi <= length):
                raise SystemExit(f"{m['id']}: つなぎの見積もり {link} が技の長さ {length}f と合わない")
            timing["linkFrames"] = {"low": lo, "mid": mid, "high": hi}
            timing["linkSec"] = {k: round(v / fps, 6) for k, v in timing["linkFrames"].items()}
        m["timing"] = timing


def _sym(v) -> str:
    if isinstance(v, dict):
        v = next(iter(v.values()))["_Value"]
    m = ENUM_RE.match(str(v))
    return m.group(2) if m else str(v)


# 斬れ味を減らす量 (_CustomKireajiReduce) の既定値と、1 目盛りあたりの値
SHARPNESS_REDUCE_DEFAULT = 10
SHARPNESS_REDUCE_UNIT = 10


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
            # 1 回で減る斬れ味の目盛り。_CustomKireajiReduce は既定の当たりで 10 (= 1 目盛りと読む。ゲージは満タン 400 で
            # 武器の斬れ味の値と同じ単位。_HealKireaji=400)。専用の値の技 (滑り込み斬り 5 など) はその値 ÷ 10
            "sharpnessCost": 0 if no_use else (p["_CustomKireajiReduce"] if p["_IsCustomKireajiReduce"] else SHARPNESS_REDUCE_DEFAULT)
            / SHARPNESS_REDUCE_UNIT,
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
    _attach_timing(out_moves, ht.tables, warnings)

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


# description = 画面に出す短い説明 (やさしい日本語)。note = データの根拠 (画面では「くわしく」の中にだけ出す)。
COMBOS = [
    {"id": "just_rush_perfect", "name": "ジャストラッシュ1周 (全段ジャスト成功)",
     "steps": [{"move": "just_rush_1_just"}, {"move": "just_rush_2_just"}, {"move": "just_rush_3_just"}],
     "confidence": "medium",
     "description": "ジャストラッシュの 3 段を全部ジャストで決めたときの 1 周分です。入り口の飛び込み斬りは入れていません。",
     "note": "ラッシュ部分だけ (入り口の飛び込み斬りは含めない)。3 段目の盾のヒット (モーション値 25) は、"
             "ゲームデータの技との対応を推定で決めた。"},
    {"id": "focus_wound", "name": "集中弱点攻撃で傷を突く",
     "steps": [{"move": "aim_attack_wound", "onWound": True}],
     "confidence": "high",
     "description": "集中モードで傷口を突く攻撃 1 回分です。全部のヒットを傷口の肉質で計算します。",
     "note": "全ヒットを傷口の肉質で計算する (弱点特効などの傷口の会心も乗る)。"},
    {"id": "ground_basic", "name": "通常の地上コンボ (△連携)",
     "steps": [{"move": "slash_1"}, {"move": "slash_2"}, {"move": "slash_3"}, {"move": "slash_4"}],
     "confidence": "medium",
     "description": "斬り下ろし → 横斬り → 斜め斬り上げ → 斜め斬り下ろし の 4 回の連携です。",
     "note": "入力の並びはゲーム内ガイドの『威力の高い連携』を参考にした代表例。"
             "モーション値 7 の追加のヒット (ゲームデータの番号 A#40) は、出る条件が分からないので入れていない。"},
    {"id": "charged_chop", "name": "溜め斬り落とし (単発)",
     "steps": [{"move": "finish_slash"}],
     "confidence": "medium",
     "description": "溜め斬り落とし 1 回分です。",
     "note": "あとから出る 4 回のヒットは、ふつうの方の値 (モーション値 14 × 4 回・属性の補正 0.3) で計算している。"},
]


def _cycle_sec(steps: list[dict], by_id: dict[str, dict]) -> dict | None:
    """1 周の秒数の見積もり {low, mid, high} = 各段のつなぎの秒数の和 (どれかの段に見積もりが無ければ None)。"""
    links = [(by_id[s["move"]].get("timing") or {}).get("linkFrames") for s in steps]
    if not steps or any(x is None for x in links):
        return None
    return {k: round(sum(x[k] for x in links) / FRAMES_PER_SEC, 6) for k in ("low", "mid", "high")}


def build_combos(moves: list[dict]) -> dict:
    by_id = {m["id"]: m for m in moves}
    out = []
    for c in COMBOS:
        for s in c["steps"]:
            if s["move"] not in by_id:
                raise ValueError(f"コンボ {c['id']} の技 {s['move']} が motions に無い")
        d = {"id": c["id"], "name": c["name"], "steps": c["steps"], "cycleSec": _cycle_sec(c["steps"], by_id)}
        d.update({k: v for k, v in c.items() if k not in d})
        out.append(d)
    return {"combos": out}
