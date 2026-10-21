"""鑑定護石の抽選表 (MHWS-in-json の RandomAmulet*) から data/talisman_rules.json の中身を作る。

生ファイル (natives/STM/GameDesign/Common/Equip/):
- RandomAmuletPtTable      … 護石の種類 (AmuletType) ごとの行。1 行 = (スキル枠1〜3 の群番号, スロット構成番号)。
                              同じ行が複数回載っているものがある (= 出やすさ)。行数を weight として残す。
- RandomAmuletLotSkillTable … 群番号 (SkillPt) ごとのスキルと Lv。LotSkill01 = 武器スキル群, LotSkill02 = 防具スキル群。
- RandomAmuletAccSlot      … スロット構成番号 (SlotPt) ごとの 3 枠の種類 (ACC_TYPE_00=武器用, 01=防具用) と Lv。

AmuletType の数値は MHDB の charms (random=true) の gameId と一致する。レア度は MHDB 側 (ゲーム内表示) を使う。
PROCESSED_DATA の amulet_pool.json は "Rare 4"〜"Rare 7" と書くが、これはゲーム内のレア 5〜8 にあたる
(0 始まりの内部値)。照合して一致を確かめる。
"""
from __future__ import annotations

import collections
import re

# 泣シミュ (mhwilds.wiki-db.com/sim) の護石追加画面の選択肢 (2026-10-21 時点の画面のスクリプトで確認)
NAKISIM_ARMOR_CHOICES = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 1, 1], [2, 0, 0], [2, 1, 0], [3, 0, 0]]
NAKISIM_WEAPON_CHOICES = [[0], [1]]  # 泣シミュ上は [0,0,0] / [1,0,0] の 3 項目

ACC_TYPE_WEAPON = "ACC_TYPE_00"
ACC_TYPE_ARMOR = "ACC_TYPE_01"
LOT_WEAPON = "LotSkill01"
LOT_ARMOR = "LotSkill02"


def enum_num(s: str) -> int:
    """'[705317568] HunterSkill_086' → 705317568"""
    m = re.match(r"\[(-?\d+)\]", s)
    if not m:
        raise ValueError(f"列挙値の形が想定外: {s}")
    return int(m.group(1))


def enum_name(s: str) -> str:
    """'[705317568] HunterSkill_086' → 'HunterSkill_086'"""
    return s.split("] ", 1)[1]


def user_values(doc: list) -> list[dict]:
    """RE Engine の user.3.json から _Values の中身 (cData) を取り出す。"""
    top = doc[0]
    key = next(iter(top))
    return [next(iter(v.values())) for v in top[key]["_Values"]]


def _slot_level(s: str) -> int:
    name = enum_name(s)
    if name == "NONE":
        return 0
    m = re.fullmatch(r"Lv(\d)", name)
    if not m:
        raise ValueError(f"スロット Lv の形が想定外: {s}")
    return int(m.group(1))


def _pad_desc(levels: list[int], n: int) -> list[int]:
    out = sorted((x for x in levels if x > 0), reverse=True)
    if len(out) > n:
        raise ValueError(f"スロットが {n} 個を超える: {levels}")
    return out + [0] * (n - len(out))


def build_slot_pts(acc_rows: list[dict]) -> dict[int, dict]:
    """SlotPt → {"armor": [3], "weapon": [1]}"""
    out = {}
    for r in acc_rows:
        armor, weapon = [], []
        for i in (1, 2, 3):
            lv = _slot_level(r[f"_SlotLevel0{i}"])
            if lv == 0:
                continue
            t = enum_name(r[f"_SlotType0{i}"])
            if t == ACC_TYPE_WEAPON:
                weapon.append(lv)
            elif t == ACC_TYPE_ARMOR:
                armor.append(lv)
            else:
                raise ValueError(f"スロット種別が想定外: {t}")
        out[r["_SlotPt"]] = {"armor": _pad_desc(armor, 3), "weapon": _pad_desc(weapon, 1)}
    return out


def build_groups(lot_rows: list[dict], skills_by_game_id: dict[int, dict]) -> tuple[dict, dict]:
    """群番号 → [{skillId, level}] と 群番号 → {"kind", "lotType"}"""
    groups: dict[int, list] = collections.defaultdict(list)
    meta: dict[int, dict] = {}
    for r in sorted(lot_rows, key=lambda x: x["_Index"]):
        pt = r["_SkillPt"]
        gid = enum_num(r["_SkillType"])
        sk = skills_by_game_id.get(gid)
        if sk is None:
            raise ValueError(f"抽選表のスキルが MHDB に無い: {r['_SkillType']}")
        lot = enum_name(r["_LotSkillType"])
        kind = {"LotSkill01": "weapon", "LotSkill02": "armor"}.get(lot)
        if kind is None:
            raise ValueError(f"LotSkillType が想定外: {lot}")
        if sk["kind"] != kind:
            raise ValueError(f"群 {pt} の {sk['name']} は MHDB では {sk['kind']} スキル ({lot})")
        if r["_SkillLv"] > len(sk["ranks"]):
            raise ValueError(f"群 {pt} の {sk['name']} Lv{r['_SkillLv']} が最大 Lv を超える")
        prev = meta.setdefault(pt, {"kind": kind, "lotType": lot})
        if prev["kind"] != kind:
            raise ValueError(f"群 {pt} に武器スキルと防具スキルが混在")
        if any(g["skillId"] == sk["id"] for g in groups[pt]):
            raise ValueError(f"群 {pt} に {sk['name']} が 2 回")
        groups[pt].append({"skillId": sk["id"], "level": r["_SkillLv"]})
    return dict(groups), meta


def build_rules(pt_rows: list[dict], lot_rows: list[dict], acc_rows: list[dict],
                mhdb_charms: list[dict], mhdb_skills: list[dict],
                processed_pool: list[dict] | None = None,
                processed_skill_pool: list[dict] | None = None) -> tuple[dict, dict]:
    """talisman_rules.json の本体 (meta 以外) と、照合結果 (checks) を返す。"""
    skills_by_game_id = {s["gameId"]: s for s in mhdb_skills}
    skills_by_id = {s["id"]: s for s in mhdb_skills}
    slot_pts = build_slot_pts(acc_rows)
    groups, group_meta = build_groups(lot_rows, skills_by_game_id)

    # 護石の種類 (AmuletType の数値 = MHDB charms の gameId)
    amulets = {}
    for c in mhdb_charms:
        if not c.get("random"):
            continue
        if len(c["ranks"]) != 1:
            raise ValueError(f"鑑定護石 {c['id']} の ranks が 1 件でない")
        r = c["ranks"][0]
        amulets[c["gameId"]] = {"name": r["name"], "rarity": r["rarity"], "mhdbCharmId": c["id"]}

    rows_by_type: dict[int, list] = collections.defaultdict(list)
    type_names: dict[int, str] = {}
    for r in sorted(pt_rows, key=lambda x: x["_Index"]):
        t = enum_num(r["_AmuletType"])
        type_names[t] = enum_name(r["_AmuletType"])
        rows_by_type[t].append(r)

    rarities: dict[str, dict] = {}
    unmapped = []
    for t, rows in rows_by_type.items():
        for r in rows:
            for k in ("_SkillPt_01", "_SkillPt_02", "_SkillPt_03"):
                if r[k] and r[k] not in groups:
                    raise ValueError(f"抽選表の群番号 {r[k]} が LotSkillTable に無い")
            if r["_SlotPt"] not in slot_pts:
                raise ValueError(f"抽選表のスロット構成 {r['_SlotPt']} が AccSlot に無い")
        if t not in amulets:
            unmapped.append({
                "amuletType": type_names[t], "amuletGameId": t, "rows": len(rows),
                "patterns": sorted({(r["_SlotPt"], r["_SkillPt_01"], r["_SkillPt_02"], r["_SkillPt_03"]) for r in rows}),
                "note": "MHDB の charms にも MHWS-in-json の AmuletCollection にも名前が無い。レア度不明のため検証には使わない",
            })
            continue
        a = amulets[t]
        pat_count = collections.Counter(
            (r["_SlotPt"], r["_SkillPt_01"], r["_SkillPt_02"], r["_SkillPt_03"]) for r in rows)
        patterns = []
        for (slot_pt, p1, p2, p3), w in sorted(pat_count.items()):
            sp = slot_pts[slot_pt]
            patterns.append({"slotPt": slot_pt, "armor": sp["armor"], "weapon": sp["weapon"],
                             "skillGroups": [p1, p2, p3], "weight": w})
        slot_count = collections.Counter(r["_SlotPt"] for r in rows)
        slot_patterns = [{"slotPt": spt, "armor": slot_pts[spt]["armor"], "weapon": slot_pts[spt]["weapon"],
                          "weight": w} for spt, w in sorted(slot_count.items())]
        skill_slots = []
        for i, k in enumerate(("_SkillPt_01", "_SkillPt_02", "_SkillPt_03")):
            vals = [r[k] for r in rows]
            gs = sorted({v for v in vals if v})
            skill_slots.append({
                "groups": gs,
                "kinds": sorted({group_meta[g]["kind"] for g in gs}),
                "optional": any(v == 0 for v in vals),
            })
        # このレア度で各スキルが取りうる最大 Lv (どの枠でもよい)
        max_lv: dict[int, int] = {}
        for p in patterns:
            for g in p["skillGroups"]:
                for e in groups.get(g, []):
                    max_lv[e["skillId"]] = max(max_lv.get(e["skillId"], 0), e["level"])
        n_skills = [sum(1 for g in p["skillGroups"] if g) for p in patterns]
        rarities[str(a["rarity"])] = {
            "name": a["name"], "amuletType": type_names[t], "amuletGameId": t, "mhdbCharmId": a["mhdbCharmId"],
            "rows": len(rows), "totalWeight": sum(p["weight"] for p in patterns),
            "minSkills": min(n_skills), "maxSkills": max(n_skills),
            "slotPatterns": slot_patterns, "skillSlots": skill_slots, "patterns": patterns,
            "skillMaxLevel": {str(k): v for k, v in sorted(max_lv.items())},
        }

    if set(rarities) != {str(a["rarity"]) for a in amulets.values()}:
        raise ValueError(f"MHDB の鑑定護石のうち抽選表に無いものがある: {sorted(rarities)}")

    checks = {"rarityOffset": None, "processedPoolMatch": None, "processedSkillPoolMatch": None,
              "nakiSimCompatible": None}

    # 泣シミュの選択肢と矛盾しないか
    bad = []
    used_armor = set()
    for rk, rv in rarities.items():
        for sp in rv["slotPatterns"]:
            used_armor.add(tuple(sp["armor"]))
            if sp["armor"] not in NAKISIM_ARMOR_CHOICES or sp["weapon"] not in NAKISIM_WEAPON_CHOICES:
                bad.append({"rarity": int(rk), "armor": sp["armor"], "weapon": sp["weapon"]})
    checks["nakiSimCompatible"] = {
        "ok": not bad, "outside": bad,
        "nakiSimChoicesUnused": [c for c in NAKISIM_ARMOR_CHOICES if tuple(c) not in used_armor],
        "slotPtsDefinedButUnused": sorted(
            spt for spt in slot_pts
            if spt and not any(spt == p["slotPt"] for rv in rarities.values() for p in rv["slotPatterns"])),
    }

    # PROCESSED_DATA の amulet_pool.json ("Rare N") と行ごとに照合する
    if processed_pool is not None:
        offs = set()
        proc_rows = collections.Counter()
        for r in processed_pool:
            ja = [n["name"] for n in r["rare"]["name"] if n["languageCode"] == "ja-JP"][0]
            rn = int(r["rare"]["rare"].split()[1])
            rar = next(int(k) for k, v in rarities.items() if v["name"] == ja)
            offs.add(rar - rn)
            proc_rows[(rar, int(r["slot"]["slotPt"]), int(r["skillPt1"]), int(r["skillPt2"]),
                       int(r["skillPt3"]))] += 1
        ours = collections.Counter()
        for rk, rv in rarities.items():
            for p in rv["patterns"]:
                ours[(int(rk), p["slotPt"], *p["skillGroups"])] += p["weight"]
        checks["rarityOffset"] = sorted(offs)
        checks["processedPoolMatch"] = proc_rows == ours
        if proc_rows != ours:
            raise ValueError("PROCESSED_DATA の amulet_pool.json と生ファイルの行が一致しない")
        if offs != {1}:
            raise ValueError(f"amulet_pool.json の Rare とゲーム内レアのずれが 1 でない: {offs}")
    if processed_skill_pool is not None:
        ok = True
        for g in processed_skill_pool:
            names = [([n["name"] for n in s["name"] if n["languageCode"] == "ja-JP"][0], s["level"])
                     for s in g["skillList"]]
            ours = [(skills_by_id[e["skillId"]]["name"], e["level"]) for e in groups.get(g["skillPt"], [])]
            if sorted(names) != sorted(ours):
                ok = False
        checks["processedSkillPoolMatch"] = ok
        if not ok:
            raise ValueError("PROCESSED_DATA の skill_pool.json と生ファイルの群が一致しない")

    body = {
        "rarities": dict(sorted(rarities.items(), key=lambda kv: int(kv[0]))),
        "groups": {str(k): v for k, v in sorted(groups.items())},
        "groupKinds": {str(k): v["kind"] for k, v in sorted(group_meta.items())},
        "slotPts": {str(k): v for k, v in sorted(slot_pts.items())},
        "unmapped": unmapped,
    }
    return body, checks
