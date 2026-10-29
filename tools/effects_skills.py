"""火力に効くスキルの各 Lv の効果を、ゲームデータ (MHWS-in-json) から組み立てる。

数値は SkillData._value と PlayerSkillParam / PlayerStatusParam から読む。
照合用の調査値 (Ver.1.040) と食い違ったらゲームデータを採り、両方を verification に残す。

出力の 1 スキル分 (docs/ARCHITECTURE.md の契約 + 追加項目):
    name, conditional, defaultUptime, levels[], source, confidence, note
    追加: gameSkill (内部 ID), kind, supported, condition, uptimeBasis, verification[],
          conditionGroup (発動率を持つ条件グループの id。rules.conditionGroups)、
          activeStates (主効果 = levels[] の値が出る段。binary は ["on"])
    levels[] の追加: gameLevel, raw, byState (段ごとの効果。主効果と違う段だけ), elementType, hardPartMul,
                     hardPartMaxHitzone, jumpMul, lowSharpnessMul, lowSharpnessMaxColor, extraDamage,
                     sharpnessSave, critSharpnessSave (docs/ARCHITECTURE.md)
条件つきスキルの発動率はスキルごとに持たない。defaultUptime / uptimeBasis は条件グループの既定値から入れる
(画面と計算は rules.conditionGroups の値を使う。ここの defaultUptime は主効果が出る割合の参考値)。
"""
from __future__ import annotations

import re
import unicodedata
from typing import Callable

from effects_conditions import GROUPS_BY_ID, default_active_states, main_uptime
from effects_source import skill_data_rows, skill_pack, skill_param, status_param

# 灼熱化の判定 1 回あたりの平均の発動。段階の確率 (33% → 50% → 100%、発動すると戻る) の長い目で見た平均。
# 33% を 1/3 と見るとちょうど 0.5 (0.33 のままだと 0.499)。日本語の実測 (100 回中 51〜53 回) と合う。
SCORCH_PER_CHECK = 0.5


def _mean_per_check(chances: list[float]) -> float:
    """段階の確率 (判定ごとに次の段へ。最後の段は 1.0) で、発動 1 回までに要る判定の回数の期待値の逆数。"""
    expect, reach = 0.0, 1.0
    for k, p in enumerate(chances, start=1):
        expect += k * reach * p
        reach *= 1 - p
    return 1 / expect


# 計算で使う効果項目の既定値 (契約の levels[] の項目)
BASE_FIELDS = {
    "attackAdd": 0, "attackMul": 1.0, "affinityAdd": 0, "critMul": None,
    "elementAdd": 0, "elementMul": 1.0, "weakPointAffinity": 0, "woundAffinity": 0,
    "critElementMul": None,
}

ELEMENT_SKILLS = {
    "HunterSkill_005": "fire", "HunterSkill_006": "water", "HunterSkill_007": "ice",
    "HunterSkill_008": "thunder", "HunterSkill_009": "dragon",
}

# 属性の耐性スキル (火耐性など。防具スキル)。SkillData の _value[0] = その属性の耐性に足す値 (Lv3 の _value[1] は防御力)
RESIST_SKILLS = {
    "HunterSkill_077": "fire", "HunterSkill_078": "water", "HunterSkill_079": "ice",
    "HunterSkill_080": "thunder", "HunterSkill_081": "dragon",
}
RESIST_LABEL = {"fire": "火", "water": "水", "thunder": "雷", "ice": "氷", "dragon": "龍"}


def _r(x: float) -> float:
    """浮動小数の表示ゆれを抑える (1.1000000000000001 → 1.1)。"""
    return round(float(x), 6)


def _lv(level: int, row: dict, **fields) -> dict:
    out = {"level": level, "gameLevel": row["level"], "raw": row["value"]}
    for k, v in BASE_FIELDS.items():
        out[k] = fields.pop(k, v)
    out.update(fields)
    return out


def _levels(hid: str, fn: Callable[[dict, int], dict]) -> list[dict]:
    """SkillData の Lv (0 を除く) を昇順に並べ、MHDB の level (1 始まり) を振る。

    シリーズは game Lv 2/4 → level 1/2、グループは game Lv 3 → level 1。
    """
    rows = [r for r in skill_data_rows()[hid] if r["level"] > 0]
    return [_lv(i + 1, row, **fn(row, i)) for i, row in enumerate(rows)]


def _skill(hid: str, *, conditional: bool, group: str | None = None, active_states: list[str] | None = None,
           uptime: float = 1.0, uptime_basis: str = "",
           condition: str = "", levels: list[dict], source: str, confidence: str,
           note: str = "", supported: bool = True, verification: list | None = None,
           requires: str | None = None) -> dict:
    """1 スキル分。条件つきで計算するものは group (条件グループの id) を必ず渡す。

    group を渡すと defaultUptime / uptimeBasis はグループの既定値から入れる (uptime 引数は使わない)。
    未対応 (supported=False) の条件つきスキルは group 無しで、uptime / uptime_basis をそのまま書く。
    """
    if group is not None:
        g = GROUPS_BY_ID[group]
        active_states = active_states or default_active_states(g)
        uptime = main_uptime(group, active_states)
        uptime_basis = g["uptimeBasis"]
    return {
        "gameSkill": hid,
        "conditional": conditional,
        "conditionGroup": group if conditional else None,
        "activeStates": active_states if conditional and group is not None else None,
        "defaultUptime": uptime if conditional else 1.0,
        "uptimeBasis": uptime_basis if conditional else "",
        "condition": condition,
        "supported": supported,
        "requiresGameSkill": requires,
        "levels": levels,
        "source": source,
        "confidence": confidence,
        "note": note,
        "verification": verification or [],
    }


def _verify(item: str, game, survey) -> dict:
    return {"item": item, "gameData": game, "survey": survey, "match": game == survey}


def _vals(levels: list[dict], key: str) -> list:
    return [lv[key] for lv in levels]


# ---------------------------------------------------------------- 個別スキル

def build_specs() -> dict[str, dict]:
    """HunterSkill_XXX → スキル効果 (name は後で MHDB の日本語名を入れる)。"""
    sp = skill_param()
    st = status_param()
    specs: dict[str, dict] = {}

    def add(hid, spec):
        specs[hid] = spec

    # 攻撃: value[0]=倍率(%)、value[1]=加算
    lv = _levels("HunterSkill_000", lambda r, i: {"attackMul": _r(r["value"][0] / 100), "attackAdd": r["value"][1]})
    add("HunterSkill_000", _skill(
        "HunterSkill_000", conditional=False, levels=lv, confidence="high",
        source="SkillData HunterSkill_000 _value[0]=倍率% _value[1]=加算",
        verification=[_verify("攻撃 Lv1-5", [[l["attackMul"], l["attackAdd"]] for l in lv],
                              [[1.0, 3], [1.0, 5], [1.0, 7], [1.02, 8], [1.04, 9]])]))

    lv = _levels("HunterSkill_001", lambda r, i: {"affinityAdd": r["value"][0]})
    add("HunterSkill_001", _skill(
        "HunterSkill_001", conditional=False, levels=lv, confidence="high",
        source="SkillData HunterSkill_001 _value[0]=会心率%",
        verification=[_verify("見切り", _vals(lv, "affinityAdd"), [4, 8, 12, 16, 20])]))

    lv = _levels("HunterSkill_002", lambda r, i: {"critMul": _r(r["value"][0] / 100)})
    add("HunterSkill_002", _skill(
        "HunterSkill_002", conditional=False, levels=lv, confidence="high",
        source="SkillData HunterSkill_002 _value[0]=会心倍率%。基本 1.25 は PlayerStatusParam._CriticalAttackRate",
        verification=[_verify("超会心", _vals(lv, "critMul"), [1.28, 1.31, 1.34, 1.37, 1.40]),
                      _verify("基本会心倍率", st["_CriticalAttackRate"], 1.25),
                      _verify("マイナス会心倍率", st["_NegativeAttackRate"], 0.75)]))

    # 会心撃【属性】: SkillData は 0。倍率は PlayerSkillParam._AttrPowerRateData。
    # MHWS-in-json の解析で [0..2] が片手剣など、[3..5] が大剣・ハンマー・狩猟笛・ヘビィボウガン。
    rates = skill_pack("_AttrPowerRateData")
    lv = _levels("HunterSkill_003", lambda r, i: {"critElementMul": _r(rates[i])})
    add("HunterSkill_003", _skill(
        "HunterSkill_003", conditional=False, levels=lv, confidence="high",
        source="PlayerSkillParam._AttrPowerRateData[0..2] (片手剣の段)。[3..5]=1.07/1.14/1.21 は大剣・ハンマー・狩猟笛・ヘビィ",
        note="攻略サイトの値 (low) をゲームデータで確認できた。会心が出たときだけ属性ダメージに掛かる (マイナス会心は属性に掛からない扱い)。",
        verification=[_verify("会心撃【属性】片手剣", _vals(lv, "critElementMul"), [1.05, 1.10, 1.15])]))

    for hid, elem in ELEMENT_SKILLS.items():
        lv = _levels(hid, lambda r, i, e=elem: {"elementMul": _r(r["value"][0] / 100),
                                                "elementAdd": r["value"][1] * 10, "elementType": e})
        add(hid, _skill(
            hid, conditional=False, levels=lv, confidence="high",
            source=f"SkillData {hid} _value[0]=倍率% _value[1]=加算 (内部値。表示値は×10)",
            note="elementAdd は表示値 (武器の属性値と同じ単位)。",
            verification=[_verify("属性攻撃強化 (表示値)", [[l["elementMul"], l["elementAdd"]] for l in lv],
                                  [[1.0, 40], [1.1, 50], [1.2, 60]])]))

    # 心眼: 肉質しきい値は PlayerSkillParam._Shingan_MeatThreshold=44
    thr = sp["_Shingan_MeatThreshold"]
    lv = _levels("HunterSkill_018", lambda r, i: {"hardPartMul": _r(r["value"][1] / 100),
                                                  "hardPartMaxHitzone": int(thr)})
    add("HunterSkill_018", _skill(
        "HunterSkill_018", conditional=False, levels=lv, confidence="medium",
        source="SkillData HunterSkill_018 _value[1]=硬い部位への倍率%。しきい値 PlayerSkillParam._Shingan_MeatThreshold",
        note=f"物理肉質 {int(thr)} 以下で物理ダメージに掛ける (しきい値が『以下』か『未満』かは未確定)。"))

    # 鈍器使い: 色のしきい値は説明文 (Lv1-2 黄以下、Lv3 緑以下)
    lv = _levels("HunterSkill_020", lambda r, i: {"lowSharpnessMul": _r(r["value"][0] / 100),
                                                  "lowSharpnessMaxColor": "green" if i >= 2 else "yellow"})
    add("HunterSkill_020", _skill(
        "HunterSkill_020", conditional=False, levels=lv, confidence="medium",
        source="SkillData HunterSkill_020 _value[0]=倍率%。色のしきい値はスキル説明文",
        note="物理ダメージにだけ掛ける扱い (MHWS-in-json の加工は attack.hit.rate)。"))

    # 業物・達人芸: 斬れ味を減らさない確率。斬れ味の減り方 (研ぐまでの攻撃の秒数) を入れたときだけ火力に効く
    lv = _levels("HunterSkill_015", lambda r, i: {"sharpnessSave": _r(r["value"][0] / 100)})
    add("HunterSkill_015", _skill(
        "HunterSkill_015", conditional=False, levels=lv, confidence="high",
        source="SkillData HunterSkill_015 _value[0]=斬れ味を消費しない確率%",
        note="斬れ味を減らす当たりのたびに、この確率で減らない。研ぐまでの攻撃の秒数を入れたときだけ火力に効く"
             " (入れないと斬れ味はずっと一番上の色)。",
        verification=[_verify("業物", _vals(lv, "sharpnessSave"), [0.1, 0.25, 0.5])]))

    lv = _levels("HunterSkill_004", lambda r, i: {"critSharpnessSave": _r(r["value"][0] / 100)})
    add("HunterSkill_004", _skill(
        "HunterSkill_004", conditional=False, levels=lv, confidence="medium",
        source="SkillData HunterSkill_004 _value[0]=会心のとき斬れ味を消費しない確率%",
        note="会心が出た当たりで、この確率で斬れ味が減らない (業物と別々に効くと仮定)。研ぐまでの攻撃の秒数を入れたときだけ"
             "火力に効く (入れないと斬れ味はずっと一番上の色)。",
        verification=[_verify("達人芸", _vals(lv, "critSharpnessSave"), [0.8])]))

    lv = _levels("HunterSkill_028", lambda r, i: {"attackMul": _r(r["value"][0] / 100)})
    add("HunterSkill_028", _skill(
        "HunterSkill_028", conditional=True, group="justGuard",
        condition="ジャストガード成功後の一定時間", levels=lv, confidence="medium",
        source="SkillData HunterSkill_028 _value[0]=倍率%",
        note="どこに掛かるかは未確定。MHWS-in-json の加工は攻撃 Lv4/5 の倍率と同じ段 (attack.stat.rate) なので、"
             "武器攻撃力に掛けて加算より先に計算する。",
        verification=[_verify("攻めの守勢", _vals(lv, "attackMul"), [1.05, 1.10, 1.15])]))

    lv = _levels("HunterSkill_029", lambda r, i: {"affinityAdd": r["value"][0]})
    add("HunterSkill_029", _skill(
        "HunterSkill_029", conditional=True, group="afterDraw",
        condition="武器出し行動の後の一定時間 (騎乗中は無効)", levels=lv, confidence="high",
        source="SkillData HunterSkill_029 _value[0]=会心率%"))

    lv = _levels("HunterSkill_030", lambda r, i: {})
    add("HunterSkill_030", _skill(
        "HunterSkill_030", conditional=True, uptime=0.0, uptime_basis="武器出し攻撃だけに効く。代表コンボには含めない",
        condition="武器出し攻撃のみ", levels=lv, confidence="low", supported=False,
        source="PlayerSkillParam._BattoPowerData (並びの意味が未確定)",
        note="説明文は武器出し攻撃の基礎攻撃力 +3/+5/+7。対象ヒットの判定が無いので計算は未対応。"))

    # 飛燕: _IsSkillHien が立ったヒットだけ
    lv = _levels("HunterSkill_055", lambda r, i: {"jumpMul": _r(r["value"][0] / 100)})
    add("HunterSkill_055", _skill(
        "HunterSkill_055", conditional=False, levels=lv, confidence="high",
        source="SkillData HunterSkill_055 _value[0]=倍率%。対象は RCOL の _IsSkillHien が true のヒット",
        note="motions_sns.json の hits[].hien が true のヒットにだけ掛ける。"))

    lv = _levels("HunterSkill_058", lambda r, i: {"attackAdd": r["value"][0], "affinityAdd": r["value"][1]})
    add("HunterSkill_058", _skill(
        "HunterSkill_058", conditional=True, group="enraged",
        condition="戦闘中の大型モンスターが怒り状態", levels=lv, confidence="high",
        source="SkillData HunterSkill_058 _value[0]=攻撃加算 _value[1]=会心率%",
        verification=[_verify("挑戦者 攻撃", _vals(lv, "attackAdd"), [4, 8, 12, 16, 20]),
                      _verify("挑戦者 会心", _vals(lv, "affinityAdd"), [3, 5, 7, 10, 15])]))

    lv = _levels("HunterSkill_059", lambda r, i: {"attackAdd": r["value"][0]})
    add("HunterSkill_059", _skill(
        "HunterSkill_059", conditional=True, group="hpFull",
        condition="体力が最大", levels=lv, confidence="high",
        source="SkillData HunterSkill_059 _value[0]=攻撃加算",
        verification=[_verify("フルチャージ", _vals(lv, "attackAdd"), [3, 6, 10, 15, 20])]))

    lv = _levels("HunterSkill_060", lambda r, i: {"attackAdd": r["value"][0]})
    add("HunterSkill_060", _skill(
        "HunterSkill_060", conditional=True, group="redHp",
        condition="体力ゲージに赤い部分がある", levels=lv, confidence="high",
        source="SkillData HunterSkill_060 _value[0]=攻撃加算",
        verification=[_verify("逆恨み", _vals(lv, "attackAdd"), [5, 10, 15, 20, 25])]))

    wthr = sp["_WeakAttackMeatThreshold"]
    lv = _levels("HunterSkill_062", lambda r, i: {"weakPointAffinity": r["value"][0], "woundAffinity": r["value"][1],
                                                  "weakPointMinHitzone": int(wthr)})
    add("HunterSkill_062", _skill(
        "HunterSkill_062", conditional=False, levels=lv, confidence="high",
        source="SkillData HunterSkill_062 _value[0]=有効部位 _value[1]=傷口の追加。しきい値 PlayerSkillParam._WeakAttackMeatThreshold",
        note=f"物理肉質 {int(wthr)} 以上で weakPointAffinity。傷口では woundAffinity を足す "
             "(傷口の追加分が肉質しきい値と無関係に付くかは未確定。現状は肉質に関係なく足す)。",
        verification=[_verify("弱点特効 有効部位", _vals(lv, "weakPointAffinity"), [5, 10, 15, 20, 30]),
                      _verify("弱点特効 傷口", _vals(lv, "woundAffinity"), [3, 5, 10, 15, 20]),
                      _verify("弱点特効 肉質しきい値", int(wthr), 45)]))

    lv = _levels("HunterSkill_063", lambda r, i: {"affinityAdd": r["value"][0]})
    add("HunterSkill_063", _skill(
        "HunterSkill_063", conditional=True, group="latentPower",
        condition="発動条件を満たした後の一定時間", levels=lv, confidence="high",
        source="SkillData HunterSkill_063 _value[0]=会心率%",
        verification=[_verify("力の解放", _vals(lv, "affinityAdd"), [10, 20, 30, 40, 50])]))

    lv = _levels("HunterSkill_064", lambda r, i: {"affinityAdd": r["value"][0]})
    add("HunterSkill_064", _skill(
        "HunterSkill_064", conditional=True, group="staminaFull",
        condition="スタミナ満タンをしばらく維持", levels=lv, confidence="high",
        source="SkillData HunterSkill_064 _value[0]=会心率%",
        verification=[_verify("渾身", _vals(lv, "affinityAdd"), [10, 20, 30])]))

    lv = _levels("HunterSkill_100", lambda r, i: {"attackMul": _r(r["value"][0] / 100)})
    add("HunterSkill_100", _skill(
        "HunterSkill_100", conditional=True, group="hpLow",
        condition="体力が最大値の 35% 以下", levels=lv, confidence="high",
        source="SkillData HunterSkill_100 _value[0]=攻撃倍率% (防御の上昇は火力外)"))

    lv = _levels("HunterSkill_110", lambda r, i: {"attackAdd": r["value"][0]})
    add("HunterSkill_110", _skill(
        "HunterSkill_110", conditional=True, group="afterKnockback",
        condition="ふきとばされた後の一定時間", levels=lv, confidence="high",
        source="SkillData HunterSkill_110 _value[0]=攻撃加算。時間 PlayerSkillParam._CounterAttack_MaxActiveTime_Lv1-3",
        verification=[_verify("逆襲", _vals(lv, "attackAdd"), [10, 15, 25])]))

    lv = _levels("HunterSkill_111", lambda r, i: {"attackAdd": r["value"][0], "affinityAdd": r["value"][1]})
    add("HunterSkill_111", _skill(
        "HunterSkill_111", conditional=True, group="monsterPoisonPara",
        condition="大型モンスターが毒または麻痺状態", levels=lv, confidence="high",
        source="SkillData HunterSkill_111 _value[0]=攻撃加算 _value[1]=会心率%"))

    lv = _levels("HunterSkill_113", lambda r, i: {"elementMul": _r(r["value"][2] / 100)})
    add("HunterSkill_113", _skill(
        "HunterSkill_113", conditional=True, group="afterAilmentCure",
        condition="状態異常・属性やられを解除した後の一定時間", levels=lv, confidence="medium",
        source="SkillData HunterSkill_113 _value[2]=属性倍率% (片手剣・双剣の段。_value[0] は大剣・ハンマー等)",
        note="どの段が片手剣かは MHWS-in-json のネイティブ解析 (verified) に依った。"))

    # 連撃: _ContinuousAttackWp01Data = [4, 5,5, 8,6, 10,8, 12,10, 15,12, 18,14]
    ca = skill_pack("_ContinuousAttackWp01Data")
    lv = _levels("HunterSkill_114", lambda r, i: {
        "attackAdd": int(ca[3 + i * 2]), "elementAdd": int(ca[4 + i * 2] * 10),
        "byState": {"hit1to4": {"attackAdd": int(ca[1]), "elementAdd": int(ca[2] * 10)}}})
    add("HunterSkill_114", _skill(
        "HunterSkill_114", conditional=True, group="chain", active_states=["hit5plus"],
        condition="攻撃を当て続けると段階的に上がる (1〜4 ヒット段 / 5 ヒット以降段)", levels=lv, confidence="medium",
        source="PlayerSkillParam._ContinuousAttackWp01Data。並び [?, 初期攻撃, 初期属性, Lv1強化攻撃, Lv1強化属性, ...] は MHWS-in-json の解釈",
        note=f"元データ {[int(x) for x in ca]}。先頭 {int(ca[0])} の意味は未確定 (強化までのヒット数の可能性)。"
             "属性は内部値なので表示値に直すため ×10。levels[] の値は 5 ヒット以降段、byState.hit1to4 は 1〜4 ヒット段の効果。",
        verification=[_verify("連撃 強化後の攻撃", _vals(lv, "attackAdd"), [8, 10, 12, 15, 18]),
                      _verify("連撃 強化後の属性(表示)", _vals(lv, "elementAdd"), [60, 80, 100, 120, 140]),
                      _verify("連撃 1〜4ヒット目", [int(ca[1]), int(ca[2] * 10)], [5, 50])]))

    lv = _levels("HunterSkill_115", lambda r, i: {"attackAdd": r["value"][0]})
    add("HunterSkill_115", _skill(
        "HunterSkill_115", conditional=True, group="afterDodge",
        condition="回避でモンスターの攻撃が重なった後の一定時間", levels=lv, confidence="high",
        source="SkillData HunterSkill_115 _value[0]=攻撃加算"))

    lv = _levels("HunterSkill_116", lambda r, i: {"attackMul": _r(r["value"][0] / 100)})
    add("HunterSkill_116", _skill(
        "HunterSkill_116", conditional=True, group="afterAmbush",
        condition="奇襲攻撃が成功した後の一定時間 (_value[1]=30 秒)", levels=lv, confidence="high",
        source="SkillData HunterSkill_116 _value[0]=攻撃倍率%"))

    lv = _levels("HunterSkill_145", lambda r, i: {})
    add("HunterSkill_145", _skill(
        "HunterSkill_145", conditional=True, uptime=0.0, uptime_basis="未対応",
        condition="クエスト経過時間", levels=lv, confidence="low", supported=False,
        source="PlayerSkillParam._Diligent_ActiveAttackParam / _Diligent_ActiveTimeInterval",
        note=f"攻撃の段階値 {sp['_Diligent_ActiveAttackParam']}、間隔 {sp['_Diligent_ActiveTimeInterval']} 秒 × "
             f"{sp['_Diligent_ActiveTimeIntervalCount']} 回。段階と経過時間の対応が未確定なので計算は未対応。"))

    stab = skill_pack("_StabbingData")
    lv = _levels("HunterSkill_146", lambda r, i: {"woundEaseMul": _r(r["value"][0] / 100),
                                                  "extraDamageRaw": r["value"][1]})
    add("HunterSkill_146", _skill(
        "HunterSkill_146", conditional=True, uptime=0.0, uptime_basis="未対応 (蓄積しきい値が非公開)",
        condition="攻撃でダメージを蓄積させると追加の無属性ダメージ", levels=lv, confidence="low", supported=False,
        source="SkillData HunterSkill_146 _value[0]=傷のつけやすさ% _value[1]=追加ダメージ。PlayerSkillParam._StabbingData",
        note=f"蓄積しきい値が非公開なので期待値は推定しない (計算は未対応)。_StabbingData={[float(x) for x in stab]} の意味は未確定。"))

    # ---------------- グループスキル (game Lv3 → level 1)
    lv = _levels("HunterSkill_165", lambda r, i: {"affinityAdd": r["value"][1]})
    add("HunterSkill_165", _skill(
        "HunterSkill_165", conditional=True, group="afterSlide",
        condition="地形を利用したスライディングの後 (_value[0]=60 秒)", levels=lv, confidence="medium",
        source="SkillData HunterSkill_165 Lv3 _value[1]=会心率%"))

    lv = _levels("HunterSkill_168", lambda r, i: {})
    add("HunterSkill_168", _skill(
        "HunterSkill_168", conditional=True, uptime=0.0, uptime_basis="未対応",
        condition="力尽きる度 (最大 2 回)", levels=lv, confidence="low", supported=False,
        source="SkillData HunterSkill_168 Lv3 _value=[110, 115]",
        note="1 回ごとの上昇量と攻撃/防御の割り当てが未確定なので計算は未対応。"))

    lv = _levels("HunterSkill_171", lambda r, i: {"attackAdd": r["value"][0]})
    add("HunterSkill_171", _skill(
        "HunterSkill_171", conditional=True, group="hunterAilment",
        condition="ハンターが状態異常中", levels=lv, confidence="medium",
        source="SkillData HunterSkill_171 Lv3 _value[0]=10",
        note="_value[0]=10 を攻撃加算と読んだ (倍率の可能性は低いが未確認)。"))

    lv = _levels("HunterSkill_205", lambda r, i: {"attackMul": _r(r["value"][0] / 100)})
    add("HunterSkill_205", _skill(
        "HunterSkill_205", conditional=True, group="beforeGuts",
        condition="根性【果敢】の発動前", levels=lv, confidence="high",
        source="SkillData HunterSkill_205 Lv3 _value[0]=攻撃倍率% (_value[1]=発動前の防御倍率)",
        note="武器攻撃力に掛ける倍率。",
        verification=[_verify("ヌシの魂 攻撃倍率", _vals(lv, "attackMul"), [1.05])]))

    # ---------------- シリーズスキル (game Lv2/4 → level 1/2)
    lv = _levels("HunterSkill_175", lambda r, i: {"attackAdd": r["value"][0]})
    add("HunterSkill_175", _skill(
        "HunterSkill_175", conditional=True, group="afterClash",
        condition="鍔迫り合い・相殺の成功後 (_value[1]=180 秒)", levels=lv, confidence="high",
        source="SkillData HunterSkill_175 _value[0]=攻撃加算"))

    lv = _levels("HunterSkill_179", lambda r, i: {"attackAdd": r["value"][1]})
    add("HunterSkill_179", _skill(
        "HunterSkill_179", conditional=True, group="afterBindOrClash",
        condition="拘束・凍結からの回復、鍔迫り合いの後 (_value[0]=90 秒)", levels=lv, confidence="high",
        source="SkillData HunterSkill_179 _value[1]=攻撃加算 _value[0]=効果時間(秒)",
        verification=[_verify("凍峰竜の反逆", _vals(lv, "attackAdd"), [25, 50])]))

    # 火竜の力 (灼熱化)。2026-10-24 の調査で決めた仕様 (docs/sources/damage.md「灼熱化」)。確度は low のまま (画面で「未確定」):
    # 技のつなぎの秒数が見積もりで、判定の回数がそれで変わるため。
    # _ScorchingHeatData = [判定の待ち (秒), 段階の確率 2 つ目・3 つ目 (%), 下位 Ⅰ (固定, 火), 下位 Ⅱ (固定, 火), 上位 Ⅰ, 上位 Ⅱ] (火は内部値)
    sh = skill_pack("_ScorchingHeatData")
    hr = [(sh[7], sh[8]), (sh[9], sh[10])]   # 上位 Ⅰ/Ⅱ = (固定, 火属性 内部値)。計算に使う
    low = [(sh[3], sh[4]), (sh[5], sh[6])]   # 下位 (STORY ランク) Ⅰ/Ⅱ とみられる値 (確度 medium。計算には使わない)

    def _scorch(r, i):
        chances = [_r(r["value"][0] / 100), _r(sh[1] / 100), _r(sh[2] / 100)]
        return {"extraDamage": {
            "kind": "scorch", "model": "checks", "cooldownSec": sh[0], "checkChances": chances,
            "perCheck": SCORCH_PER_CHECK, "fixed": hr[i][0], "element": hr[i][1] * 10, "elementType": "fire",
            "elementSkillsApply": True, "appliesTo": "additionalDamageHits",
            "lowRank": {"fixed": low[i][0], "element": low[i][1] * 10}}}
    lv = _levels("HunterSkill_180", _scorch)
    chances = lv[0]["extraDamage"]["checkChances"]
    add("HunterSkill_180", _skill(
        "HunterSkill_180", conditional=False, levels=lv, confidence="low",
        source="SkillData HunterSkill_180 _value[0]=初回の確率%。PlayerSkillParam._ScorchingHeatData "
               "([0]=判定の待ち秒・[1..2]=段階の確率%・[7..10]=上位の固定/火・[3..6]=下位とみられる値)",
        note="確度 low の理由: 技のつなぎの秒数が見積もりで、判定の回数がそれで変わるため。"
             f"1 回のダメージ = 固定 + (火 × 火の倍率 + 火の加算)/10 × 火肉質/100。上位 Ⅰ は固定 {hr[0][0]:g} + 火 {hr[0][1]:g}、"
             f"Ⅱ は固定 {hr[1][0]:g} + 火 {hr[1][1]:g} (火は内部値。_ScorchingHeatData[7..10])。"
             "火に効く属性スキル (火属性攻撃強化・連撃など) は武器の属性と関係なく火の分に掛かる (倍率が先)。"
             "武器の攻撃力・属性値・会心・会心撃【属性】・斬れ味は掛からない。属性の上限は掛けていない (掛かるかは不明。ふつうの装備では届かない)。"
             f"判定は灼熱化の対象ヒット (RCOL の _UseSkillAdditionalDamage) でだけ行い、前の判定から {sh[0]:g} 秒 ([0]) たつまでは"
             "判定しない (外れても待つ)。"
             f"判定ごとの確率は {chances[0] * 100:g}% → {chances[1] * 100:g}% → {chances[2] * 100:g}% と上がり、発動すると最初に戻る。"
             f"平均すると判定 2 回に 1 回出る (perCheck {SCORCH_PER_CHECK:g})。"
             f"[3..6] は下位の値とみられる (Ⅰ {low[0][0]:g}+{low[0][1]:g} / Ⅱ {low[1][0]:g}+{low[1][1]:g}。lowRank に残す。計算には使わない)。"
             "全体防御率と多人数の倍率はゲームデータで全部 1.0 なので掛けない。",
        verification=[_verify("灼熱化 段階の確率", chances, [0.33, 0.5, 1.0]),
                      _verify("灼熱化 判定あたりの平均の発動", round(_mean_per_check(chances), 2), 0.5),
                      _verify("灼熱化Ⅰ 固定/火(表示)", [lv[0]["extraDamage"]["fixed"], lv[0]["extraDamage"]["element"]], [20.0, 600.0]),
                      _verify("灼熱化Ⅱ 固定/火(表示)", [lv[1]["extraDamage"]["fixed"], lv[1]["extraDamage"]["element"]], [40.0, 1200.0]),
                      # 人が測った間隔は 2〜3 秒 (待ちの後、次の対象ヒットが当たるまでの分が乗る)。TU4 より前は 3.0 秒
                      _verify("灼熱化 判定の待ち(秒)", sh[0], 2.4)]))

    lv = _levels("HunterSkill_182", lambda r, i: {})
    add("HunterSkill_182", _skill(
        "HunterSkill_182", conditional=True, uptime=0.0, uptime_basis="未対応",
        condition="ジェスチャー「雄叫び」の後", levels=lv, confidence="low", supported=False,
        source="SkillData HunterSkill_182 _value=[90,10]/[90,20]",
        note="自分への上昇量 (オトモ・サポートハンターより小さい) が分からないので未対応。"))

    # 黒蝕竜の力: Ⅰ=感染のみ、Ⅱ=[10, 15]。克服時の会心+15%/60秒は PlayerStatusParam (誰でも同じ)
    fz_crit, fz_time = st["_Frenzy_Overcome_CriticalRate"], st["_Frenzy_Overcome_Duration"]
    lv = _levels("HunterSkill_183", lambda r, i: {
        "attackAdd": r["value"][1], "affinityAdd": int(fz_crit),
        "byState": {"infected": {"attackAdd": r["value"][0]}}})
    add("HunterSkill_183", _skill(
        "HunterSkill_183", conditional=True, group="frenzy", active_states=["overcome"],
        condition=f"狂竜症の感染中 / 克服した後 (克服後の会心 +{int(fz_crit)}% は {int(fz_time)} 秒)", levels=lv,
        confidence="medium",
        source="SkillData HunterSkill_183 (_openSkill HunterSkill_196) _value[0]=感染中の攻撃 _value[1]=克服時の攻撃。"
               "会心は PlayerStatusParam._Frenzy_Overcome_CriticalRate/_Duration",
        note="Ⅱ は感染中 +10、克服時 +15 (合計値と読んだ。MHWS-in-json の注記も『Ⅱ 攻撃力合計 +15』)。"
             "『さらに +15 (合計 +25)』の読み方もあり得るので未確定。Ⅰ は攻撃上昇なし・克服で会心のみ。",
        verification=[_verify("黒蝕竜Ⅰ 克服時 会心", lv[0]["affinityAdd"], 15),
                      _verify("黒蝕竜Ⅰ 攻撃", lv[0]["attackAdd"], 0)]))

    lv = _levels("HunterSkill_186", lambda r, i: {"attackAdd": r["value"][1]})
    add("HunterSkill_186", _skill(
        "HunterSkill_186", conditional=True, group="chain", active_states=["hit1to4", "hit5plus"],
        condition="「連撃」スキルの発動中 (1〜4 ヒット段・5 ヒット以降段のどちらでも)", levels=lv, confidence="high", requires="HunterSkill_114",
        source="SkillData HunterSkill_186 _value[1]=攻撃加算 (_value[0]=連撃の時間延長段階)",
        verification=[_verify("兇爪竜の力", _vals(lv, "attackAdd"), [8, 18])]))

    lv = _levels("HunterSkill_188", lambda r, i: {"attackAdd": r["value"][1]})
    add("HunterSkill_188", _skill(
        "HunterSkill_188", conditional=True, group="afterMeal",
        condition="こんがり肉などを食べた後 (_value[0]=180 秒)", levels=lv, confidence="high",
        source="SkillData HunterSkill_188 _value[1]=攻撃加算",
        verification=[_verify("暗器蛸の力", _vals(lv, "attackAdd"), [15, 30])]))

    lv = _levels("HunterSkill_195", lambda r, i: {"affinityAdd": r["value"][1]})
    add("HunterSkill_195", _skill(
        "HunterSkill_195", conditional=True, group="frenzy", active_states=["overcome"],
        condition="狂竜症の克服状態 (黒蝕竜の力などで感染しているとき)", levels=lv, confidence="high",
        source="SkillData HunterSkill_195 _value[1]=克服時の会心率% (_value[0]=克服しやすさ)",
        verification=[_verify("無我の境地", _vals(lv, "affinityAdd"), [3, 6, 10])]))

    lv = _levels("HunterSkill_202", lambda r, i: {"affinityAdd": r["value"][0], "altAffinityAdd": r["value"][1]})
    add("HunterSkill_202", _skill(
        "HunterSkill_202", conditional=True, group="wet",
        condition="水に濡れている (泡状態なら altAffinityAdd)", levels=lv, confidence="medium",
        source="SkillData HunterSkill_202 _value[0]=濡れ時 _value[1]=泡状態の会心率%",
        note="計算は濡れ時の値。泡状態の値は altAffinityAdd に入れてある。"))

    lv = _levels("HunterSkill_204", lambda r, i: {})
    add("HunterSkill_204", _skill(
        "HunterSkill_204", conditional=False, levels=lv, confidence="low", supported=False,
        source="PlayerSkillParam._RyukiExplosion (MHWS-in-json も『対応未確認』)",
        note=f"確率で追加ダメージ。灼熱化と併用すると灼熱化は出ず、火属性ダメージが足される。値は _RyukiExplosion={skill_pack('_RyukiExplosion')} "
             "(先頭 2.4 = 判定の待ちの秒、33/50/100 = 段階の確率とみられる。灼熱化の _ScorchingHeatData と同じ形)。"
             "残りの並びの意味が未確定なので計算は未対応。"
             "前は _ViolentData をこのスキルの値としていたが、それは獄焔蛸の反逆 (恨撃) のもの (2026-10-24 の調査)。"))

    for hid in ("HunterSkill_207", "HunterSkill_221", "HunterSkill_223", "HunterSkill_225"):
        lv = _levels(hid, lambda r, i: {"attackMul": _r(r["value"][0] / 100)})
        add(hid, _skill(
            hid, conditional=True, group="festival",
            condition="季節の儀式の期間中", levels=lv, confidence="low",
            source=f"SkillData {hid} _value[0]=109 (Ⅱ) を攻撃倍率% と読んだ",
            note="説明文は『攻撃力と防御力が大きく上昇』。109 を ×1.09 と読んだが、加算の可能性もあり未確定。"))

    lv = _levels("HunterSkill_212", lambda r, i: {"affinityAdd": r["value"][1]})
    add("HunterSkill_212", _skill(
        "HunterSkill_212", conditional=True, group="afterDischarge",
        condition="蓄積で追加の雷ダメージが出た後の一定時間 (_value[2]=20/30 秒)", levels=lv, confidence="low",
        source="SkillData HunterSkill_212 _value[1]=会心率% と読んだ。PlayerSkillParam._DischargeData",
        note="追加の雷属性ダメージは蓄積しきい値が非公開なので計算しない。会心率 +15 の読みも未確認。"))

    lv = _levels("HunterSkill_215", lambda r, i: {"attackMul": _r(r["value"][1] / 100)})
    add("HunterSkill_215", _skill(
        "HunterSkill_215", conditional=True, group="afterDodgeRepeat",
        condition="「巧撃」発動中に再び条件を満たしたとき (Ⅱ)", levels=lv, confidence="low",
        source="SkillData HunterSkill_215 _value[1]=100/105 を攻撃倍率% と読んだ"))

    lv = _levels("HunterSkill_239", lambda r, i: {"elementMul": _r(r["value"][0] / 100),
                                                  "elementAdd": r["value"][1] * 10})
    add("HunterSkill_239", _skill(
        "HunterSkill_239", conditional=True, group="enraged",
        condition="戦闘中の大型モンスターが怒り状態", levels=lv, confidence="high",
        source="SkillData HunterSkill_239 (_openSkill HunterSkill_242) _value[0]=属性倍率% _value[1]=属性加算(内部値)",
        verification=[_verify("巨戟龍の黙示録 (表示値)", [[l["elementMul"], l["elementAdd"]] for l in lv],
                              [[1.2, 20], [1.3, 40]])]))

    # ---------------- 計算は未対応だが一覧には出すもの
    for hid, cond, src, note in (
        ("HunterSkill_091", "傷口の破壊・部位破壊", "SkillData HunterSkill_091 _value[0]=部位蓄積% _value[1]=傷口破壊時%",
         "集中弱点攻撃で傷口を破壊したときのダメージ倍率。どのヒットが『破壊時』かが未確定なので計算は未対応。"),
        ("HunterSkill_048", "溜め攻撃", "SkillData HunterSkill_048 _value[0]=属性倍率%",
         "片手剣のどのヒットが対象か (isSkill_048_ValidAttack) が未確定なので計算は未対応。"),
        ("HunterSkill_176", "力の解放の発動時間を延長", "SkillData HunterSkill_176 _value[0]=延長秒",
         "直接の火力上昇は無い。力の解放の発動率を上げる形で人が入れる。"),
        ("HunterSkill_178", "逆恨み発動中", "SkillData HunterSkill_178 _value[0]=23/50。PlayerSkillParam._ViolentData",
         f"恨撃の追加ダメージ。_ViolentData={skill_pack('_ViolentData')} はこのスキルの値とみられる (先頭 = 判定の待ちの秒、"
         "続く 2 つ = 上位の Ⅰ/Ⅱ。SkillData の 23/50 は下位とみられる。2026-10-24 の調査)。式と発動の仕組みが未確定なので計算は未対応。"),
        ("HunterSkill_191", "属性攻撃を受けた後", "SkillData HunterSkill_191",
         "龍属性への変換と追加ダメージ。計算は未対応。"),
        ("HunterSkill_229", "鉱石の入手後", "PlayerSkillParam (未特定)", "上昇値の式が未確定なので未対応。"),
        ("HunterSkill_231", "肉焼きの後", "PlayerSkillParam._MeatGrillMasterData", "焼き加減で効果が変わるので未対応。"),
        ("HunterSkill_237", "レゾナンス", "PlayerSkillParam._ResonanceData", "ファー/ニアーの条件と値の対応が未確定なので未対応。"),
    ):
        lv = _levels(hid, lambda r, i: {})
        add(hid, _skill(hid, conditional=True, uptime=0.0, uptime_basis="未対応", condition=cond,
                        levels=lv, confidence="low", supported=False, source=src, note=note))
    return specs


# ---------------------------------------------------------------- 属性の耐性スキル (rules.resistSkills)

def _desc_value(text: str, label: str) -> int | None:
    """MHDB の説明文 (「火耐性＋６」「火耐性＋２０、防御力＋１０」) から耐性の値を読む。読めなければ None。"""
    m = re.match(rf"^{label}耐性\+(\d+)", unicodedata.normalize("NFKC", text or "").strip())
    return int(m.group(1)) if m else None


def _desc_defense(text: str) -> int:
    """MHDB の説明文の「防御力＋１０」の値 (書いていなければ 0)。"""
    m = re.search(r"防御力\+(\d+)", unicodedata.normalize("NFKC", text or ""))
    return int(m.group(1)) if m else 0


def build_resist_skills(enum: dict[str, int], index: dict[int, dict]) -> dict[str, dict]:
    """rules.resistSkills (属性の耐性スキル → 耐性に足す値) を作る。docs/RECOMMEND_DESIGN.md 5.8 節。

    値はゲームデータ (SkillData の _value[0])。MHDB のスキルの説明文 (「火耐性＋６」など) と照合し、
    スキルが見つからない・名前・Lv の数・値 (耐性と、Lv3 の防御力) のどれかが合わなければ SystemExit で生成を止める
    (属性やられの判定に使う耐性の合計が静かに狂うのを防ぐ)。
    enum: HunterSkill_XXX → gameId。index: gameId → {id, name, descriptions: [Lv1 の説明文, ...]}
    """
    rows_by_hid = skill_data_rows()
    out: dict[str, dict] = {}
    errors: list[str] = []
    for hid, elem in RESIST_SKILLS.items():
        label = RESIST_LABEL[elem]
        sk = index.get(enum.get(hid))
        rows = [r for r in rows_by_hid.get(hid, []) if r["level"] > 0]
        if sk is None or not rows:
            errors.append(f"{hid} ({label}耐性) がスキル一覧かゲームデータに無い")
            continue
        if sk["name"] != f"{label}耐性":
            errors.append(f"{hid}: スキル名が {sk['name']} (期待は {label}耐性)")
            continue
        game = [int(r["value"][0]) for r in rows]
        descs = sk.get("descriptions") or []
        mhdb = [_desc_value(d, label) for d in descs]
        if len(descs) != len(game) or mhdb != game:
            errors.append(f"{sk['name']}: ゲームデータ {game} と MHDB の説明文 {mhdb} ({descs}) が合わない")
            continue
        game_def = [int(r["value"][1]) for r in rows]
        mhdb_def = [_desc_defense(d) for d in descs]
        if mhdb_def != game_def:
            errors.append(f"{sk['name']}: 防御力の加算 ゲームデータ {game_def} と MHDB の説明文 {mhdb_def} が合わない")
            continue
        defense = {str(i + 1): v for i, v in enumerate(game_def) if v}
        out[str(sk["id"])] = {
            "name": sk["name"], "element": elem, "gameSkill": hid,
            "levels": {str(i + 1): v for i, v in enumerate(game)},
            "defenseAdd": defense,
            "source": f"SkillData {hid} _value[0]=耐性の加算 (Lv3 の _value[1]=防御力の加算)。MHDB の説明文と照合",
            "confidence": "high",
            "verification": [_verify(f"{sk['name']} (MHDB の説明文)", game, mhdb),
                             _verify(f"{sk['name']} 防御力の加算 (MHDB の説明文)", game_def, mhdb_def)],
        }
    if errors:
        raise SystemExit("耐性スキルの照合の食い違い: " + " / ".join(errors))
    return dict(sorted(out.items(), key=lambda kv: int(kv[0])))
