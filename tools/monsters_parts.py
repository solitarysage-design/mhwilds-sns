"""data/monsters.json を組み立てる (大型モンスター 34 体の肉質・傷口・状態別肉質・状態異常)。

結合の仕方:
- MHDB /ja/monsters (肉質 0〜1 小数・部位スラッグ・報酬・状態異常の★)
- MHDB の gameId → EM ID は MHWS-in-json の EnemyData (_enemyId "[26] EM0001_00_0") で引く
- EM ID → Param_Parts は Resident ファイルの参照でたどる (護竜アルシュベルド EM0160_50 は
  自前の Param_Parts を持たず EM0160_00 のものを参照している)
- damage_calculator (MHWS-in-json PROCESSED_DATA) から 通常/破壊後/custom1〜5 の肉質と傷口の肉質
- 生の Param_Parts から 気絶の肉質 (_Stun)・弱点 (_WeakPointArray)・破壊対象 (_PartsBreakArray)
- 生の PartsLost から 切断できる部位
- 生の Param_Unique から 傷口の肉質の置き換え (歴戦王など。monsters_legendary.wound_conversions)

MHDB の肉質と damage_calculator・生データの通常肉質は全部位で一致することを確かめてから使う
(一致しなければ例外で止める)。
"""
from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from pathlib import Path

from monsters_fetch import CACHE, enemy_id_map
from monsters_legendary import legendary_params, unique_scan, wound_conversions

HZ_KEYS = ["slash", "blunt", "shot", "fire", "water", "thunder", "ice", "dragon", "stun"]
ELEMENTS = ["fire", "water", "thunder", "ice", "dragon"]
RAW_MEAT = {"slash": "_Slash", "blunt": "_Blow", "shot": "_Shot", "fire": "_Fire", "water": "_Water",
            "thunder": "_Thunder", "ice": "_Ice", "dragon": "_Dragon", "stun": "_Stun"}
DC_MEAT = {"slash": "slash", "blunt": "blow", "shot": "shot", "fire": "fire", "water": "water",
           "thunder": "thunder", "ice": "ice", "dragon": "dragon"}
MHDB_MEAT = {"slash": "slash", "blunt": "blunt", "shot": "pierce", "fire": "fire", "water": "water",
             "thunder": "thunder", "ice": "ice", "dragon": "dragon", "stun": "stun"}

# 推奨属性の計算で「主要部位」とみなす斬撃肉質のしきい値 (弱点特効と同じ 45)
MAJOR_SLASH = 45
MAJOR_FALLBACK_TOP = 3

# damage_calculator の variants キー (= 生データの _MeatGuidXxx) の説明
STATE_KEYS = {
    "break": {"internal": "_MeatGuidBreak", "meaning": "部位破壊後の肉質と思われる", "confidence": "medium"},
    **{f"custom{i}": {"internal": f"_MeatGuidCustom{i}", "meaning": "不明 (モンスター固有の状態。怒り・形態変化など)",
                      "confidence": "low"} for i in range(1, 6)},
    "weakPoint": {"internal": "_WeakPointArray", "meaning": "弱点 (部位に付く別肉質。出現条件は不明)",
                  "confidence": "low"},
}

STATUS_MAP = {"poison": "poison", "paralysis": "paralysis", "sleep": "sleep", "blastblight": "blast",
              "stun": "stun", "exhaust": "exhaust"}
ITEM_EFFECTS = ["flash", "noise"]


def _sym(s):
    """'[2000370944] TAIL' → 'TAIL'"""
    return re.sub(r"^\[-?\d+\]\s*", "", s) if isinstance(s, str) else s


def _arr(root: dict, key: str) -> list[dict]:
    """RE Engine の cInstanceGuidArray から中身の dict の配列を取り出す。"""
    v = root.get(key)
    if not v:
        return []
    inner = next(iter(v.values()))
    return [next(iter(x.values())) for x in inner.get("_DataArray", [])]


def _slug(parts_type: str) -> str:
    return parts_type.lower().replace("_", "-")


def _load(rel: str):
    return json.loads((CACHE / rel).read_text(encoding="utf-8"))


def _raw_hz(meat: dict) -> dict:
    return {k: int(meat[v]) for k, v in RAW_MEAT.items()}


def _check_range(hz: dict, where: str) -> None:
    for k, v in hz.items():
        if not isinstance(v, int) or not 0 <= v <= 100:
            raise ValueError(f"肉質が範囲外: {where} {k}={v}")


def build_monsters() -> tuple[list[dict], dict]:
    """monsters 配列と、docs 用の集計 (report) を返す。"""
    mh = _load("mhdb_monsters_ja.json")
    part_names = {p["part"]: p["names"] for p in _load("mhdbdata_PartNames.json")}
    dc = _load("processed/damage_calculator.zh-Hans.json")
    idx = _load("natives_index.json")
    gid2em = enemy_id_map(CACHE / "natives/Common/Enemy/EnemyData.user.3.json")
    dc_by_source = {m["sourceFile"]: m for m in dc["monsters"]}

    report = {"unknownParts": [], "breakDiff": [], "unlinkedWeakPoints": [], "stateKeysUsed": Counter(),
              "woundParts": 0, "parts": 0, "sharedParts": [],
              "uniqueMissing": [], "uniqueParams": {}, "uniqueMeatIgnored": {}, "woundConversions": []}
    monsters = []
    for m in sorted((x for x in mh if x.get("kind") == "large"), key=lambda x: x["id"]):
        em = gid2em[m["gameId"]]
        ix = idx[em]
        src = "STM/" + ix["partsPath"] + ".3.json"
        dcm = dc_by_source.get(src)
        if dcm is None:
            raise ValueError(f"{m['name']} {em}: damage_calculator に {src} が無い")
        if dcm["id"] != em:
            report["sharedParts"].append({"monster": m["name"], "emId": em, "partsFrom": dcm["id"]})
        raw = _load(ix["parts"])[0]["app.user_data.EmParamParts"]
        raw_parts = {p["_InstanceGuid"]: p for p in _arr(raw, "_PartsArray")}
        raw_multi = {p["_InstanceGuid"]: p for p in _arr(raw, "_MultiPartsArray")}
        raw_meat = {p["_InstanceGuid"]: p for p in _arr(raw, "_MeatArray")}
        raw_break = {p["_InstanceGuid"]: p for p in _arr(raw, "_PartsBreakArray")}

        def break_targets(b: dict) -> list[str]:
            """PartsBreak の対象 (部位 GUID の配列)。"""
            if _sym(b["_TargetCategory"]) == "PARTS":
                return [b["_TargetDataGuid"]]
            mp = raw_multi.get(b["_TargetDataGuid"])
            return list(mp["_LinkPartsGuids"]) if mp else []

        # 切断: PartsLost → PartsBreak → 部位。種類 (_PartsType) が一致する部位を切断可とする
        severed_guids, lost_breaks = set(), set()
        if ix["partsLost"]:
            lost_root = _load(ix["partsLost"])[0]["app.user_data.EmParamPartsLost"]
            for lost in _arr(lost_root, "_PartsLostArray"):
                ptype = _sym(lost["_PartsType"])
                lost_breaks.add(lost["_PartsBreakGuid"])
                b = raw_break.get(lost["_PartsBreakGuid"])
                cands = [g for g in (break_targets(b) if b else []) if g in raw_parts]
                same = [g for g in cands if _sym(raw_parts[g]["_PartsType"]) == ptype]
                severed_guids.update(same or cands)
        # 破壊: 切断以外の PartsBreak の対象部位。複数部位にまたがる (MultiParts) ものは、破壊の種類名と
        # 部位の種類名が重なる部位に絞る (無ければリンク先の全部位)
        broken_raw = set()
        for b in raw_break.values():
            if b["_InstanceGuid"] in lost_breaks:
                continue
            linked = [g for g in break_targets(b) if g in raw_parts]
            if _sym(b["_TargetCategory"]) == "PARTS":
                broken_raw.update(linked)
                continue
            bt = _slug(_sym(b["_PartsType"]))
            match = [g for g in linked
                     if (lambda s: s == bt or s in bt or bt in s)(_slug(_sym(raw_parts[g]["_PartsType"])))]
            broken_raw.update(match or linked)

        # MHDB の報酬から 破壊できる部位スラッグ・切断報酬の有無
        broken_slugs, has_sever_reward = set(), False
        for rw in m["rewards"]:
            for c in rw["conditions"]:
                if c["kind"] == "broken-part" and c["part"]:
                    broken_slugs.add(c["part"])
                if c["kind"] in ("carve-severed", "carve-rotten-severed"):
                    has_sever_reward = True
        if has_sever_reward != bool(severed_guids):
            raise ValueError(f"{m['name']}: 切断報酬 ({has_sever_reward}) と PartsLost ({bool(severed_guids)}) が食い違う")

        # MHDB 部位 ↔ damage_calculator 部位 (種類スラッグと通常肉質で対応させる)
        used, pairs = set(), []
        for p in m["parts"]:
            mv = {k: round(p["multipliers"][MHDB_MEAT[k]] * 100) for k in HZ_KEYS}
            cands = [q for q in dcm["parts"] if _slug(q["type"]) == p["part"] and q["ordinal"] not in used]
            exact = [q for q in cands
                     if all(q["variants"][0]["meat"][DC_MEAT[k]] == mv[k] for k in DC_MEAT)]
            if not exact:
                raise ValueError(f"{m['name']} {p['part']}: damage_calculator に同じ肉質の部位が無い")
            q = exact[0]
            used.add(q["ordinal"])
            pairs.append((p, q, mv))
        if len(used) != len(dcm["parts"]):
            raise ValueError(f"{m['name']}: damage_calculator の部位が余った")
        pairs.sort(key=lambda t: t[1]["ordinal"])

        slug_count = Counter(p["part"] for p, _, _ in pairs)
        slug_seen = Counter()
        parts_out = []
        scar_guids = {}  # 部位 key → 傷口の肉質 GUID (傷口の肉質の置き換えを部位に結び付けるため)
        for p, q, mv in pairs:
            slug = p["part"]
            slug_seen[slug] += 1
            key = slug if slug_count[slug] == 1 else f"{slug}-{slug_seen[slug]}"
            ja = (part_names.get(slug) or {}).get("ja")
            unknown = not ja
            name = f"部位不明（{key}）" if unknown else ja
            rp = raw_parts[q["id"]]
            normal_guid = rp["_MeatGuidNormal"]
            rhz = _raw_hz(raw_meat[normal_guid])
            if rhz != mv:
                raise ValueError(f"{m['name']} {key}: MHDB と生データの肉質が違う {mv} / {rhz}")
            _check_range(mv, f"{m['name']} {key}")

            states = {}
            for v in q["variants"][1:]:
                if v["meat"] is None:
                    continue
                hz = {k: v["meat"][DC_MEAT[k]] for k in DC_MEAT}
                hz["stun"] = int(raw_meat[v["meatGuid"]]["_Stun"]) if v["meatGuid"] in raw_meat else None
                _check_range({k: x for k, x in hz.items() if x is not None}, f"{m['name']} {key} {v['key']}")
                states[v["key"]] = hz
                report["stateKeysUsed"][v["key"]] += 1
            wound = None
            scar_guids[key] = [s["meatGuid"] for s in q["scars"]]
            if len(q["scars"]) > 1:
                raise ValueError(f"{m['name']} {key}: 傷口が 2 つ以上ある (wound は 1 つしか持てない。形を見直す)")
            if q["scars"]:
                s = q["scars"][0]
                wound = {k: s["meat"][DC_MEAT[k]] for k in DC_MEAT}
                wound["stun"] = int(raw_meat[s["meatGuid"]]["_Stun"]) if s["meatGuid"] in raw_meat else None
                _check_range({k: x for k, x in wound.items() if x is not None}, f"{m['name']} {key} wound")
                report["woundParts"] += 1
            # 弱点 (_WeakPointArray) は部位に直接ひも付くものだけ states に入れる
            wps = []
            for w in _arr(raw, "_WeakPointArray"):
                if w["_LinkPartsGuid"] == q["id"] and w["_MeatGuid"] in raw_meat:
                    hz = _raw_hz(raw_meat[w["_MeatGuid"]])
                    if hz not in wps:
                        wps.append(hz)
            for i, hz in enumerate(wps):
                states["weakPoint" if i == 0 else f"weakPoint{i + 1}"] = hz
                report["stateKeysUsed"]["weakPoint"] += 1

            # breakable はゲームデータ (PartsBreak)、breakReward は MHDB の報酬 (broken-part) の部位スラッグ
            breakable = q["id"] in broken_raw
            reward = slug in broken_slugs
            if reward and slug_count[slug] > 1:
                # 同じスラッグが複数ある部位 (hide 等) は破壊対象のものに絞る。どれも破壊対象でなければ
                # 報酬がどの部位のものか特定できないので null
                dup_guids = [qq["id"] for pp, qq, _ in pairs if pp["part"] == slug]
                reward = breakable if any(g in broken_raw for g in dup_guids) else None
            note = []
            if reward is None:
                note.append(f"MHDB の部位破壊報酬が '{slug}' に付いているが、同名の部位が複数あり特定できない")
                report["breakDiff"].append(f"{m['name']} {key} (game={breakable}, reward=特定不可)")
            elif breakable != reward:
                note.append("ゲームデータ上は破壊対象だが MHDB の部位破壊報酬に無い" if breakable
                            else "MHDB の部位破壊報酬はこの部位だが、ゲームデータの破壊対象は別の部位")
                report["breakDiff"].append(f"{m['name']} {key} (game={breakable}, reward={reward})")
            best_val = max(mv[e] for e in ELEMENTS)
            part = {
                "key": key, "slug": slug, "name": name, "unknownPart": unknown,
                "internalType": q["type"], "ordinal": q["ordinal"],
                "health": p["health"],
                "hitzone": mv,
                "wound": wound,
                "states": states,
                "breakable": breakable,
                "breakReward": reward,
                "severable": q["id"] in severed_guids,
                "bestElement": {"types": [e for e in ELEMENTS if mv[e] == best_val] if best_val > 0 else [],
                                "value": best_val},
            }
            if note:
                part["note"] = " / ".join(note)
            if unknown:
                report["unknownParts"].append(f"{m['name']} {key}")
            parts_out.append(part)
            report["parts"] += 1

        # 日本語名が重なる部位 (ゾ・シアの 頭 / head-hide など) はスラッグを添えて区別する
        by_name = defaultdict(list)
        for pt in parts_out:
            if not pt["unknownPart"]:
                by_name[pt["name"]].append(pt)
        for nm, pts in by_name.items():
            if len(pts) > 1:
                pts.sort(key=lambda x: (len(x["slug"]), x["ordinal"]))
                for pt in pts[1:]:
                    pt["name"] = f"{nm}（{pt['slug']}）"
        # 部位に直接ひも付かない弱点 (MultiParts 等へのリンク) は件数だけ記録
        part_guids = set(raw_parts)
        unl = [w for w in _arr(raw, "_WeakPointArray") if w["_LinkPartsGuid"] not in part_guids]
        if unl:
            report["unlinkedWeakPoints"].append(f"{m['name']} {len(unl)}件")

        rec = recommend_element(parts_out)
        # モンスター固有のパラメータ (Param_Unique): 傷口の肉質の置き換えと、歴戦王・歴戦用と思われる項目の一覧
        scan = unique_scan(em, ix.get("unique"))
        if not ix.get("unique"):
            report["uniqueMissing"].append(f"{m['name']} {em}")
        if scan["values"]:
            report["uniqueParams"][m["name"]] = scan["values"]
        if scan["meatIgnored"]:
            report["uniqueMeatIgnored"][m["name"]] = scan["meatIgnored"]
        convs = wound_conversions(m["name"], em, ix.get("uniquePath"), scan,
                                  {g: _raw_hz(x) for g, x in raw_meat.items()}, parts_out, scar_guids,
                                  recommend_element)
        for c in convs:
            report["woundConversions"].append(
                f"{m['name']} {c['scope']} {c['groups']} 部位 {len(c['parts'])} / 部位に当たらない {len(c['unmatched'])} "
                f"推奨 {rec['best']} → {c['elementRecommendation']['best']}")
        status, immune, item_effects = status_info(m)
        monsters.append({
            "id": m["id"], "gameId": m["gameId"], "emId": em, "name": m["name"], "species": m["species"],
            "baseHealth": m["baseHealth"],
            "variants": [v["kind"] for v in m["variants"]],
            "variantNames": {v["kind"]: v["name"] for v in m["variants"]},
            "legendaryParams": legendary_params(ix.get("legendary")),
            "parts": parts_out,
            "woundConversions": convs,
            "elementRecommendation": rec,
            "statusWeakness": status,
            "immune": immune,
            "itemEffects": item_effects,
        })
    return monsters, report


def recommend_element(parts: list[dict]) -> dict:
    """推奨属性: 主要部位 (名前のある部位のうち斬撃肉質 45 以上。2 部位未満なら斬撃上位 3 部位) の
    属性肉質の単純平均が最も高い属性。全部位 (名前のある部位) 平均も併記する。

    同点は (1) 主要部位の傷口の肉質の平均 (傷口のある主要部位だけで平均) → (2) 名前のある全部位の平均
    の順で崩す。それでも同点なら全部を best に残す。崩した経過は tieBreak に残す (同点が無ければ null)。
    例: アルシュベルドは主要部位の属性肉質が全属性同じ (平均 2.5) だが、鎖翼刃の傷口が龍 38・他 30 なので龍になる。
    傷口の肉質の置き換え (Param_Unique。woundConversions) の後の値で計算し直すと、アルシュベルドは傷口の属性が
    全部同じ (鎖翼刃 30・ほか 10) になり、全部位の平均で龍になる。
    """
    named = [p for p in parts if not p["unknownPart"]]
    basis = [p for p in named if p["hitzone"]["slash"] >= MAJOR_SLASH]
    method = f"slash>={MAJOR_SLASH}"
    if len(basis) < 2:
        basis = sorted(named, key=lambda p: (-p["hitzone"]["slash"], p["ordinal"]))[:MAJOR_FALLBACK_TOP]
        method = f"slash上位{MAJOR_FALLBACK_TOP}部位"

    def raw_avg(ps, key="hitzone"):
        # 比べるときは丸める前の値を使う (丸めで別々の値が同点に見えないように)
        return {e: sum(p[key][e] for p in ps) / len(ps) for e in ELEMENTS}

    def rnd(v):
        return {e: round(x, 1) for e, x in v.items()} if v is not None else None

    a_raw = raw_avg(basis)
    all_raw = raw_avg(named)
    wounded = [p for p in basis if p["wound"] is not None]
    w_raw = raw_avg(wounded, "wound") if wounded else None
    a, all_avg = rnd(a_raw), rnd(all_raw)
    top = max(a_raw.values())
    tied = [e for e in ELEMENTS if a_raw[e] == top] if top > 0 else []
    best, tie = tied, None
    if len(tied) > 1:
        tie = {"tied": tied, "by": None, "woundAvg": rnd(w_raw), "woundParts": [p["key"] for p in wounded]}
        cand = tied
        for by, vals in (("woundAvg", w_raw), ("allPartsAvg", all_raw)):
            if vals is None:
                continue
            m = max(vals[e] for e in cand)
            cand = [e for e in cand if vals[e] == m]
            if len(cand) == 1:
                tie["by"] = by
                break
        best = cand
        if len(cand) > 1:
            tie["by"] = "unresolved"
    # order は平均の高い順。同点は同じ順 (傷口の平均 → 全部位の平均) で並べる
    order = sorted(ELEMENTS, key=lambda e: (-a_raw[e], -(w_raw[e] if w_raw else 0), -all_raw[e],
                                            ELEMENTS.index(e)))
    # 参考: 主要部位ごとに「通常と states (custom/break/weakPoint) の中で一番高い値」を取った平均。
    # 形態で肉質が大きく変わるモンスター (ゴグマジオス等) で通常肉質だけの推奨とずれることがある
    smax = {e: round(sum(max([p["hitzone"][e]] + [s[e] for s in p["states"].values()]) for p in basis)
                     / len(basis), 1) for e in ELEMENTS}
    stop = max(smax.values())
    return {
        "best": best,
        "order": [{"type": e, "avg": a[e]} for e in order],
        "basis": method,
        "basisParts": [p["key"] for p in basis],
        "tieBreak": tie,
        "allPartsAvg": all_avg,
        "stateMaxAvg": smax,
        "bestStateMax": [e for e in ELEMENTS if smax[e] == stop] if stop > 0 else [],
    }


def status_info(m: dict) -> tuple[dict, list[str], dict]:
    """MHDB の weaknesses/resistances から 状態異常の★・無効・アイテムの効き。"""
    status = {v: None for v in STATUS_MAP.values()}
    immune, items = [], {k: {"effective": None, "conditions": []} for k in ITEM_EFFECTS}
    for w in m["weaknesses"]:
        if w["kind"] == "element":
            continue  # MHDB の属性弱点フラグは抜けが多いので使わない (部位肉質から計算する)
        k = w.get("status") or w.get("effect")
        if k in STATUS_MAP:
            status[STATUS_MAP[k]] = w["level"]
        elif k in items:
            items[k]["effective"] = True
            if w.get("condition"):
                items[k]["conditions"].append(w["condition"])
    for r in m["resistances"]:
        if r["kind"] == "element":
            continue
        k = r.get("status") or r.get("effect")
        if k in STATUS_MAP:
            status[STATUS_MAP[k]] = 0
            immune.append(STATUS_MAP[k])
        elif k in items:
            items[k]["effective"] = False  # 閃光・音爆弾が効かない (immune には入れず itemEffects で持つ)
    return status, sorted(set(immune)), items


if __name__ == "__main__":
    ms, rep = build_monsters()
    print(len(ms), rep["parts"], rep["woundParts"], dict(rep["stateKeysUsed"]))
