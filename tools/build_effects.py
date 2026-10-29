"""火力計算用のデータを生成する (担当: damage)。

出力:
    data/skill_effects.json  スキルの各 Lv の効果 (skillId は MHDB の skill id)
    data/motions_sns.json    片手剣のモーション値・属性補正・斬れ味の扱い
    data/combos_sns.json     代表コンボ (技の並び)

一次資料はゲームデータ (GitHub dzxrly/MHWS-in-json、ゲーム版 1.42.0.2、MIT)。
生データは tools/.cache/damage/ に置き、無ければ取得する。再実行で同じ結果になる。

使い方:
    PYTHONIOENCODING=utf-8 python tools/build_effects.py
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from effects_conditions import groups_with_skills, validate as validate_conditions  # noqa: E402
from effects_motions import build_combos, build_motions  # noqa: E402
from effects_skills import build_resist_skills, build_specs  # noqa: E402
from effects_source import (  # noqa: E402
    GAME_BUILD, GAME_VERSION, MHDB_SKILLS_URL, MHWS_DB_JA_URL, MHWS_TAG, ROOT,
    mhdb_skills, raw_path, raw_rel, raw_url, sha256_of, sharpness_table, skill_enum, skill_param,
    status_param, write_json,
)

DATA = ROOT / "data"


def _skill_index() -> tuple[dict[int, dict], str]:
    """gameId → スキル (id, name, kind, levels 数, descriptions = Lv ごとの MHDB の説明文)。
    data/skills.json (MHDB の /ja/ から生成) があればそちらを使う。"""
    sk = DATA / "skills.json"
    if sk.exists():
        doc = json.loads(sk.read_text(encoding="utf-8"))
        out = {}
        for s in doc.get("skills", []):
            if s.get("gameId") is not None:
                levels = s.get("levels") or []
                out[int(s["gameId"])] = {"id": s["id"], "name": s["name"], "kind": s.get("kind"),
                                         "levels": len(levels),
                                         "descriptions": [lv.get("description") or "" for lv in levels]}
        if out:
            return out, "data/skills.json"
    out = {}
    for s in mhdb_skills():
        out[int(s["gameId"])] = {"id": s["id"], "name": s["name"], "kind": s["kind"], "levels": len(s["ranks"]),
                                 "descriptions": [r.get("description") or "" for r in s["ranks"]]}
    return out, MHDB_SKILLS_URL


def _meta(sources: list[str], extra: dict | None = None) -> dict:
    meta = {
        "source": sources,
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "gameVersion": GAME_VERSION,
        "gameDataBuild": GAME_BUILD,
        "license": "ゲームデータの抽出は dzxrly/MHWS-in-json (MIT)。数値はカプコンのゲームデータ由来。",
    }
    if extra:
        meta.update(extra)
    return meta


def _raw_sources(keys: list[str]) -> tuple[list[str], dict[str, str]]:
    urls, hashes = [], {}
    for k in keys:
        urls.append(raw_url(k))
        hashes[raw_rel(k)] = sha256_of(raw_path(k))
    return urls, hashes


def build_skill_effects() -> tuple[dict, list[str]]:
    warnings: list[str] = []
    specs = build_specs()
    enum = skill_enum()
    index, index_src = _skill_index()
    effects: dict[str, dict] = {}
    for hid, spec in specs.items():
        gid = enum.get(hid)
        sk = index.get(gid)
        if sk is None:
            warnings.append(f"{hid} (gameId {gid}) がスキル一覧に無いので出力しない")
            continue
        if sk["levels"] and sk["levels"] != len(spec["levels"]):
            warnings.append(f"{sk['name']}: Lv 数が一覧 {sk['levels']} とゲームデータ {len(spec['levels'])} で違う")
        requires = spec.pop("requiresGameSkill")
        req_id = None
        if requires:
            req = index.get(enum.get(requires))
            req_id = req["id"] if req else None
        for v in spec["verification"]:
            if not v["match"]:
                warnings.append(f"照合の食い違い {sk['name']} {v['item']}: ゲーム={v['gameData']} 調査={v['survey']}")
        entry = {"name": sk["name"], "kind": sk["kind"], "gameId": gid, **spec}
        entry["requiresSkillId"] = req_id
        effects[str(sk["id"])] = entry
    effects = dict(sorted(effects.items(), key=lambda kv: int(kv[0])))
    # 条件グループとスキルの対応が崩れていたら出力しない (発動率が静かに効かなくなるのを防ぐ)
    errors = validate_conditions(effects)
    if errors:
        raise SystemExit("条件グループの食い違い: " + " / ".join(errors))

    st, sp = status_param(), skill_param()
    rules = {
        "criticalBase": st["_CriticalAttackRate"],
        "criticalNegative": st["_NegativeAttackRate"],
        "affinityMin": -100,
        "affinityMax": 100,
        "elementRateLimit": st["_ElementAttack_RateLimit"],
        "elementAddLimit": st["_ElementAttack_AddLimit"] * 10,
        "physicalRateLimit": st["_PhysicalAttack_RateLimit"],
        "physicalAddLimit": st["_PhysicalAttack_AddLimit"],
        "weakPointMinHitzone": int(sp["_WeakAttackMeatThreshold"]),
        "hardPartMaxHitzone": int(sp["_Shingan_MeatThreshold"]),
        "frenzyOvercomeAffinity": st["_Frenzy_Overcome_CriticalRate"],
        "frenzyOvercomeSec": st["_Frenzy_Overcome_Duration"],
        "sharpness": sharpness_table(),
        "units": {
            "attack": "係数なしの内部値 (片手剣の表示倍率 1.4 を掛けない)",
            "element": "表示値 (ダメージ計算では /10)。elementAdd も表示値",
            "affinity": "%",
        },
        "conditionGroups": groups_with_skills(effects),
        # 属性の耐性スキル → 耐性に足す値 (火力には使わない。属性やられの判定 = 耐性の合計 ≥ 20 に使う)
        "resistSkills": build_resist_skills(enum, index),
        "note": "属性の上限は攻撃と同じく倍率と加算を別々に切る: 元の値 × min(倍率, elementRateLimit) + "
                "min(加算, elementAddLimit) (PlayerStatusParam._ElementAttack_RateLimit / _ElementAttack_AddLimit。"
                "_PhysicalAttack_RateLimit / _AddLimit と同じ形の名前なので同じ切り方と読んだ。確度 medium)。"
                "条件つきスキルの発動率は conditionGroups (条件ごと) に持つ。"
                "resistSkills は属性の耐性スキル (skillId → {element, levels: {Lv: 耐性に足す値}})。"
                "値は SkillData の _value[0] で、MHDB の説明文 (「火耐性＋６」など) と照合して合わなければ生成を止める。",
    }
    urls, hashes = _raw_sources(["SkillCommonData", "SkillData", "PlayerSkillParam", "PlayerStatusParam", "EmCommonData"])
    sources = [f"https://github.com/dzxrly/MHWS-in-json/releases/tag/{MHWS_TAG}", *urls]
    if index_src not in sources:
        sources.append(index_src)
    doc = {"meta": _meta(sources, {"sourceSha256": hashes, "skillIdSource": index_src}),
           "rules": rules, "effects": effects}
    return doc, warnings


def main() -> int:
    warnings: list[str] = []
    eff, w = build_skill_effects()
    warnings += w
    body, w = build_motions()
    warnings += w
    combos = build_combos(body["moves"])

    m_urls, m_hashes = _raw_sources(["Wp01_Attack", "Wp01_SubAttack", "Wp01_Shell", "Wp01ShellList",
                                     "Wp01_FinishSlash", "Wp01_RushFinishSlash", "Wp01_OldScarSlash",
                                     "Wp01Motlist", "Wp01Mct"])
    m_sources = [f"https://github.com/dzxrly/MHWS-in-json/releases/tag/{MHWS_TAG}", *m_urls, MHWS_DB_JA_URL]
    motions = {"meta": _meta(m_sources, {
        "sourceSha256": m_hashes,
        "fields": {
            "mv": "物理モーション値 (_Attack)",
            "elementRate": "技の属性補正。属性を使わないヒット (盾など) は 0",
            "sharpnessMul": "斬れ味補正が掛かるか (= !_IsNoUseKireaji || _IsForceUseKireajiAttackRate)",
            "consumesSharpness": "斬れ味を消費するか (= !_IsNoUseKireaji)",
            "sharpnessCost": "1 回で減る斬れ味の目盛り (消費しないヒットは 0)。_CustomKireajiReduce ÷ 10 (専用の値が無いヒットは "
                             "既定の 10 → 1)。10 を 1 目盛りと読んだのは推定 (確度 medium。既定の当たりがみな 10・砥石の _HealKireaji=400 が"
                             "武器の斬れ味の満タンと同じ)",
            "hien": "飛燕の対象 (_IsSkillHien)",
            "additionalDamage": "追加ダメージ系スキル (灼熱化など) の対象と推定 (_UseSkillAdditionalDamage)",
            "count": "このヒットの回数",
            "mapping": "proven=技名の対応表どおり / inferred=調査値から推定 / unmapped=対応なし",
            "atFrame": "技の始まり (timing.startFrame) から当たり判定が出るまでのフレーム (motlist の _RequestSetID の区間の始まり)。"
                       "motlist に無いヒット (子弾など) は null",
            "atSec": "atFrame ÷ fps (60 と仮定)。灼熱化の判定の間隔を数えるのに使う",
            "timing": "技の時間。motionId = motlist のモーション番号、startFrame = 既定の再生の始まり (mct)、frameCount = startFrame "
                      "から最後までのフレーム (後隙込み)、linkFrames / linkSec = 次の技につなげるまで (low/mid/high。見積もり。"
                      "無ければ null)。計算は linkSec.mid、無ければ frameCount ÷ fps、それも無ければ 1.0 秒 (警告 no-timing)",
        }}), **body}
    combo_doc = {"meta": _meta([f"https://github.com/dzxrly/MHWS-in-json/releases/tag/{MHWS_TAG}"],
                               {"note": "技 (motions_sns.json の moves[].id) の並び。onWound=true の段は傷口の肉質で計算する。"
                                        "cycleSec = 1 周の秒数の見積もり {low, mid, high} (各段の moves[].timing.linkSec の和。"
                                        "どれかの段に見積もりが無ければ null)。"}),
                 **combos}

    changed = []
    for name, doc in (("skill_effects.json", eff), ("motions_sns.json", motions), ("combos_sns.json", combo_doc)):
        if write_json(DATA / name, doc):
            changed.append(name)
    print(f"スキル {len(eff['effects'])} 件 / 技 {len(motions['moves'])} 件 / コンボ {len(combos['combos'])} 件")
    print("更新: " + (", ".join(changed) if changed else "なし (前回と同じ)"))
    for w in warnings:
        print("注意: " + w)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
