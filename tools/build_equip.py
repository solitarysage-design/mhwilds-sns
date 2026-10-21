"""装備データ (スキル・防具・シリーズ/グループ・装飾品・片手剣・固定護石・鑑定護石の規則) を作る。

    PYTHONIOENCODING=utf-8 python tools/build_equip.py           # キャッシュが無ければ取得してから作る
    PYTHONIOENCODING=utf-8 python tools/build_equip.py --refresh # 取り直してから作る

出力 (形は docs/ARCHITECTURE.md の「データの形 (契約)」):
    data/skills.json, data/armor.json, data/bonuses.json, data/decorations.json,
    data/weapons_sns.json, data/charms_fixed.json, data/talisman_rules.json
    data/my_weapons.json は無いときだけ空で作る (人が増やすファイル。charms.json も触らない)。

キャッシュ (tools/.cache/equip/) だけを読むので、同じキャッシュからは何度実行しても同じ結果になる。
generatedAt は実行時刻ではなく、使った生データの取得時刻の最大値。
照合 (MHDB と MHWS-in-json の食い違い) は meta.checks に残し、標準出力にも出す。
"""
from __future__ import annotations

import argparse
import collections
import ast
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import equip_fetch  # noqa: E402
import equip_talisman  # noqa: E402

ROOT = equip_fetch.ROOT
CACHE = equip_fetch.CACHE
DATA = ROOT / "data"

GAME_VERSION = "1.042"
SOURCE_VERSIONS = {
    "mhdb": "wilds.mhdb.io /ja/ (取得日時は meta.source の各 fetchedAt)",
    "mhwsInJson": f"dzxrly/MHWS-in-json {equip_fetch.MHWS_TAG} (commit {equip_fetch.MHWS_SHA[:7]}, ゲーム版 1.42.0.2)",
}
LICENSES = {
    "mhdb": "wilds.mhdb.io (LartTyler/mhdb-wilds-data)。ゲームデータの数値と名前のみ使用",
    "mhwsInJson": "MIT (dzxrly/MHWS-in-json)",
}

PARTS = ["head", "chest", "arms", "waist", "legs"]
RESISTS = ["fire", "water", "thunder", "ice", "dragon"]
SHARP_COLORS = ["red", "orange", "yellow", "green", "blue", "white"]
GOGMA_ARTIAN_IDS = (1180, 1181, 1182)  # 破滅のキリエヴェルド×3 (攻撃/会心/属性の激化)
# MHDB の属性/状態異常名 → 契約の名前 (MHDB は爆破を "blastblight" と書く)
MHDB_ELEMENT = {"fire": "fire", "water": "water", "thunder": "thunder", "ice": "ice", "dragon": "dragon",
                "poison": "poison", "paralysis": "paralysis", "sleep": "sleep", "blastblight": "blast"}
MHWS_ATTR = {"FIRE": "fire", "WATER": "water", "ELEC": "thunder", "ICE": "ice", "DRAGON": "dragon",
             "POISON": "poison", "PARALYSE": "paralysis", "SLEEP": "sleep", "BLAST": "blast", "NONE": None}


# ---------------------------------------------------------------- 読み込み

def load(rel: str):
    return json.loads((CACHE / rel).read_text(encoding="utf-8"))


def load_xlsx_sheet(rel: str, sheet: str) -> list[dict] | None:
    """照合用の xlsx を読む。openpyxl が無ければ照合を飛ばす (None)。"""
    try:
        import openpyxl  # noqa: PLC0415
    except ImportError:
        return None
    wb = openpyxl.load_workbook(CACHE / rel, read_only=True)
    rows = list(wb[sheet].iter_rows(values_only=True))
    hdr = rows[0]
    return [dict(zip(hdr, r)) for r in rows[1:]]


def make_meta(manifest: dict, rels: list[str], **extra) -> dict:
    files = manifest["files"]
    missing = [r for r in rels if r not in files]
    if missing:
        raise RuntimeError(f"manifest に無いキャッシュ: {missing}")
    urls = []
    for r in rels:
        u = files[r]["url"]
        if u not in urls:
            urls.append(u)
    return {
        "source": urls,
        "generatedAt": max(files[r]["fetchedAt"] for r in rels),
        "gameVersion": GAME_VERSION,
        "sourceVersions": SOURCE_VERSIONS,
        "license": LICENSES,
        **extra,
    }


def write_json(name: str, obj: dict) -> int:
    path = DATA / name
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, ensure_ascii=False, indent=1) + "\n"
    path.write_text(text, encoding="utf-8", newline="\n")
    return len(text.encode("utf-8"))


def sk_ref(s: dict) -> dict:
    return {"skillId": s["skill"]["id"], "level": s["level"]}


# ---------------------------------------------------------------- 装飾品

def build_decorations(mhdb_decos: list[dict], acc_xlsx: list[dict] | None) -> tuple[list, dict]:
    out = []
    for d in sorted(mhdb_decos, key=lambda x: x["id"]):
        if d["kind"] not in ("weapon", "armor"):
            raise ValueError(f"装飾品 {d['id']} の kind が想定外: {d['kind']}")
        if d["slot"] not in (1, 2, 3):
            raise ValueError(f"装飾品 {d['id']} の slot が想定外: {d['slot']}")
        out.append({"id": d["id"], "name": d["name"], "kind": d["kind"], "slot": d["slot"],
                    "rarity": d["rarity"], "skills": [sk_ref(s) for s in d["skills"]], "gameId": d["gameId"]})
    checks = {"mhwsCompared": None, "mismatches": []}
    if acc_xlsx is not None:
        by_name = {r["Name"]: r for r in acc_xlsx}
        n = 0
        for d, src in zip(out, sorted(mhdb_decos, key=lambda x: x["id"])):
            r = by_name.get(d["name"])
            if r is None:
                checks["mismatches"].append({"id": d["id"], "name": d["name"], "why": "MHWS に同名が無い"})
                continue
            n += 1
            kind = {"ACC_TYPE_00": "weapon", "ACC_TYPE_01": "armor"}[r["AccessoryType"]]
            slot = int(str(r["SlotLevelAcc"]).replace("Lv", ""))
            names = [x for x in ast.literal_eval(r["Skill"]) if x != "NONE"]
            lvs = [x for x in ast.literal_eval(r["SkillLevel"]) if x]
            ours = sorted((s["skill"]["name"], s["level"]) for s in src["skills"])
            if kind != d["kind"] or slot != d["slot"] or sorted(zip(names, lvs)) != ours:
                checks["mismatches"].append({"id": d["id"], "name": d["name"],
                                             "mhdb": [d["kind"], d["slot"], ours],
                                             "mhws": [kind, slot, sorted(zip(names, lvs))]})
        checks["mhwsCompared"] = n
    return out, checks


# ---------------------------------------------------------------- スキル

def build_skills(mhdb_skills: list[dict], scd_rows: list[dict], decos: list[dict]) -> tuple[list, dict]:
    scd = {equip_talisman.enum_num(r["_skillId"]): r for r in scd_rows}
    cat_kind = {"WEAPON": "weapon", "EQUIP": "armor", "SERIES": "set", "GROUP": "group"}
    single = collections.defaultdict(list)
    for d in decos:
        if len(d["skills"]) == 1:
            s = d["skills"][0]
            single[s["skillId"]].append({"decorationId": d["id"], "slot": d["slot"], "level": s["level"]})
    out, mismatch = [], []
    matched = 0
    for s in sorted(mhdb_skills, key=lambda x: x["id"]):
        if s["kind"] not in ("weapon", "armor", "set", "group"):
            raise ValueError(f"スキル {s['id']} の kind が想定外: {s['kind']}")
        ranks = sorted(s["ranks"], key=lambda r: r["level"])
        lvls = [r["level"] for r in ranks]
        if lvls != list(range(1, len(lvls) + 1)):
            raise ValueError(f"スキル {s['name']} の Lv が 1 から連続していない: {lvls}")
        c = scd.get(s["gameId"])
        internal = None
        if c is not None:
            matched += 1
            internal = equip_talisman.enum_name(c["_skillId"])
            cat = cat_kind.get(equip_talisman.enum_name(c["_skillCategory"]))
            if cat != s["kind"]:
                mismatch.append({"id": s["id"], "name": s["name"], "mhdb": s["kind"], "mhws": cat})
        decs = sorted(single.get(s["id"], []), key=lambda x: (x["level"], x["slot"], x["decorationId"]))
        lv1 = [x["slot"] for x in decs if x["level"] == 1]
        out.append({
            "id": s["id"], "gameId": s["gameId"], "name": s["name"], "kind": s["kind"],
            "maxLevel": len(ranks), "decoSize": min(lv1) if lv1 else None,
            "levels": [{"level": r["level"], "name": r["name"] or "", "description": r["description"] or ""}
                       for r in ranks],
            "description": s.get("description") or "",
            "internalId": internal,
            "decorations": decs,
        })
    if matched != len(mhdb_skills):
        raise ValueError(f"MHDB の skill.gameId が SkillCommonData と {matched}/{len(mhdb_skills)} しか一致しない")
    return out, {"gameIdMatched": f"{matched}/{len(mhdb_skills)}", "kindMismatches": mismatch}


# ---------------------------------------------------------------- シリーズ/グループ

def build_bonuses(mhdb_sets: list[dict], skills_by_id: dict) -> tuple[list, list]:
    sets, groups = {}, {}
    for st in sorted(mhdb_sets, key=lambda x: x["id"]):
        b = st.get("bonus")
        if b:
            ranks = sorted(({"pieces": r["pieces"], "level": r["skill"]["level"], "name": r["skill"].get("name") or ""}
                            for r in b["ranks"]), key=lambda r: r["pieces"])
            item = {"id": b["id"], "name": skills_by_id[b["skill"]["id"]]["name"], "skillId": b["skill"]["id"],
                    "ranks": ranks}
            if b["id"] in sets and sets[b["id"]] != item:
                raise ValueError(f"シリーズスキル {b['id']} の中身が防具シリーズによって違う")
            sets[b["id"]] = item
        g = st.get("groupBonus")
        if g:
            if len(g["ranks"]) != 1:
                raise ValueError(f"グループスキル {g['id']} の ranks が 1 件でない")
            r = g["ranks"][0]
            item = {"id": g["id"], "name": skills_by_id[g["skill"]["id"]]["name"], "skillId": g["skill"]["id"],
                    "pieces": r["pieces"], "level": r["skill"]["level"], "effectName": r["skill"].get("name") or ""}
            if g["id"] in groups and groups[g["id"]] != item:
                raise ValueError(f"グループスキル {g['id']} の中身が防具シリーズによって違う")
            groups[g["id"]] = item
    # 種別 set/group のスキルが全部どれかのボーナスに載っていること
    set_skills = {v["skillId"] for v in sets.values()}
    grp_skills = {v["skillId"] for v in groups.values()}
    for s in skills_by_id.values():
        if s["kind"] == "set" and s["id"] not in set_skills:
            raise ValueError(f"シリーズスキル {s['name']} に対応するボーナスが無い")
        if s["kind"] == "group" and s["id"] not in grp_skills:
            raise ValueError(f"グループスキル {s['name']} に対応するボーナスが無い")
    return sorted(sets.values(), key=lambda x: x["id"]), sorted(groups.values(), key=lambda x: x["id"])


# ---------------------------------------------------------------- 防具

def build_armor(mhdb_armor: list[dict], mhdb_sets: list[dict], set_bonuses: list, group_bonuses: list,
                armor_xlsx: list[dict] | None) -> tuple[list, dict]:
    set_by_skill = {b["skillId"]: b["id"] for b in set_bonuses}
    grp_by_skill = {b["skillId"]: b["id"] for b in group_bonuses}
    series = {s["id"]: s for s in mhdb_sets}
    by_series = collections.defaultdict(list)
    for a in mhdb_armor:
        by_series[a["armorSet"]["id"]].append(a)

    def bonus_skills(a, kind):
        return [s["skill"]["id"] for s in a["skills"] if s["skill"]["kind"] == kind]

    out = []
    multi = []
    for a in sorted(mhdb_armor, key=lambda x: x["id"]):
        if a["kind"] not in PARTS:
            raise ValueError(f"防具 {a['id']} の部位が想定外: {a['kind']}")
        if a["rank"] not in ("low", "high"):
            raise ValueError(f"防具 {a['id']} のランクが想定外: {a['rank']}")
        if len(a["slots"]) > 3:
            raise ValueError(f"防具 {a['id']} のスロットが 3 を超える")
        siblings = by_series[a["armorSet"]["id"]]
        res = {}
        for kind, table in (("set", set_by_skill), ("group", grp_by_skill)):
            mine = bonus_skills(a, kind)
            for sid in mine:
                if sid not in table:
                    raise ValueError(f"防具 {a['name']} の {kind} スキル {sid} にボーナスが無い")
            # シリーズ全部位に共通するものを先頭に (ゴグα/β は 巨戟龍の黙示録 + 部位ごとのシリーズスキル)
            common = set(mine)
            for sib in siblings:
                common &= set(bonus_skills(sib, kind))
            ordered = [sid for sid in mine if sid in common] + [sid for sid in mine if sid not in common]
            res[kind] = [table[sid] for sid in ordered]
        if len(res["group"]) > 1:
            raise ValueError(f"防具 {a['name']} にグループスキルが 2 つ以上")
        if len(res["set"]) > 1:
            multi.append(a["id"])
        item = {
            "id": a["id"], "name": a["name"], "part": a["kind"], "rank": a["rank"], "rarity": a["rarity"],
            "slots": (list(a["slots"]) + [0, 0, 0])[:3],
            "skills": [sk_ref(s) for s in a["skills"] if s["skill"]["kind"] in ("weapon", "armor")],
            "setBonusId": res["set"][0] if res["set"] else None,
            "groupBonusId": res["group"][0] if res["group"] else None,
            "defense": {"base": a["defense"]["base"], "max": a["defense"]["max"]},
            "resist": {k: a["resistances"][k] for k in RESISTS},
            "setBonusIds": res["set"],
            "armorSetId": a["armorSet"]["id"],
            "armorSetName": series[a["armorSet"]["id"]]["name"],
        }
        out.append(item)

    checks = {"multiSetBonusPieces": multi, "mhwsCompared": None, "mismatches": []}
    if armor_xlsx is not None:
        by_name = collections.defaultdict(list)
        for r in armor_xlsx:
            by_name[r["Name"]].append(r)
        n = 0
        for a, src in zip(out, sorted(mhdb_armor, key=lambda x: x["id"])):
            rs = by_name.get(a["name"], [])
            if len(rs) != 1:
                checks["mismatches"].append({"id": a["id"], "name": a["name"], "why": f"MHWS に同名が {len(rs)} 件"})
                continue
            r = rs[0]
            n += 1
            sl = [0 if x == "NONE" else int(x[2:]) for x in ast.literal_eval(r["SlotLevel"])]
            sk = sorted(ast.literal_eval(r["SkillAndLevel"]))
            ours = sorted(f"{s['skill']['name']}: {s['level']}" for s in src["skills"])
            # MHWS の Resistance は [火, 水, 雷, 氷, 龍] の順 (RESISTS と同じ)
            res = ast.literal_eval(r["Resistance"])
            ours_res = [a["resist"][k] for k in RESISTS]
            if sl != a["slots"] or sk != ours or r["Defense"] != a["defense"]["base"] or res != ours_res:
                checks["mismatches"].append({"id": a["id"], "name": a["name"],
                                             "mhdb": [a["slots"], ours, a["defense"]["base"], ours_res],
                                             "mhws": [sl, sk, r["Defense"], res]})
        checks["mhwsCompared"] = n
    return out, checks


# ---------------------------------------------------------------- 片手剣

def handicraft_max(base: list[int], breaks: list[int]) -> list[int]:
    """MHDB の handicraft (各色に何 Lv 分足すか) から匠 Lv5 の斬れ味を作る。1 Lv = 10。

    先頭の値は「素の斬れ味で最も上の色」に、次の値はその 1 つ上の色に足す (MHDB ドキュメントの定義)。
    """
    out = list(base)
    top = max(i for i, v in enumerate(base) if v > 0)
    for k, lv in enumerate(breaks):
        idx = top + k
        if idx >= len(out):
            if lv:
                raise ValueError(f"匠の伸び先が白より上: {base} {breaks}")
            continue
        out[idx] += lv * 10
    return out


def build_weapons(mhdb_weapons: list[dict], sns_xlsx: list[dict] | None) -> tuple[list, dict]:
    ws = sorted((w for w in mhdb_weapons if w["kind"] == "sword-shield"), key=lambda x: x["id"])
    gogma = [w for w in ws if w["id"] in GOGMA_ARTIAN_IDS]
    if len(gogma) != 3 or len({w["name"] for w in gogma}) != 1:
        raise ValueError("破滅のキリエヴェルド×3 (id 1180〜1182) が想定どおりでない")
    # 3 種の見分け: 攻撃力が最も高い=攻撃激化、会心率が最も高い=会心激化、残り=属性激化
    atk = max(gogma, key=lambda w: w["damage"]["raw"])["id"]
    aff = max(gogma, key=lambda w: w["affinity"])["id"]
    rest = [w["id"] for w in gogma if w["id"] not in (atk, aff)]
    if atk == aff or len(rest) != 1:
        raise ValueError("破滅のキリエヴェルドの 3 種を攻撃力・会心率で見分けられない")
    variant = {atk: "攻撃激化", aff: "会心激化", rest[0]: "属性激化"}

    names = collections.Counter(w["name"] for w in ws)
    out = []
    for w in ws:
        if len(w["specials"]) > 1:
            raise ValueError(f"片手剣 {w['id']} に属性が 2 つ以上")
        if round(w["damage"]["raw"] * 1.4) != w["damage"]["display"]:
            raise ValueError(f"片手剣 {w['id']} の攻撃力が 1.4 倍の関係にない")
        if len(w["slots"]) > 3:
            raise ValueError(f"片手剣 {w['id']} のスロットが 3 を超える")
        sh = w["sharpness"]
        if sh.get("purple", 0):
            raise ValueError(f"片手剣 {w['id']} に紫ゲージがある")
        base = [sh[c] for c in SHARP_COLORS]
        artian = w["series"] is None
        element = None
        notes = []
        if w["specials"]:
            sp = w["specials"][0]
            raw_type = sp["element"] if sp["kind"] == "element" else sp["status"]
            etype = MHDB_ELEMENT.get(raw_type)
            if etype is None:
                raise ValueError(f"片手剣 {w['id']} の属性名が想定外: {raw_type}")
            element = {"type": etype, "value": sp["damage"]["display"]}
            if sp.get("hidden"):
                element["hidden"] = True
                notes.append("属性は隠し (解放スキルが要る)")
        if artian:
            if w["specials"] or w["skills"]:
                raise ValueError(f"アーティア系 {w['id']} に属性かスキルがある (想定外)")
            notes.append("属性は手入力")
        item = {
            "id": w["id"], "name": w["name"], "rarity": w["rarity"],
            "attack": w["damage"]["raw"], "affinity": w["affinity"], "element": element,
            "sharpness": {"base": base, "handicraftMax": handicraft_max(base, w["handicraft"])},
            "slots": (list(w["slots"]) + [0, 0, 0])[:3],
            "skills": [sk_ref(s) for s in w["skills"]],
            "artian": artian, "gogmaArtian": w["id"] in GOGMA_ARTIAN_IDS,
            "note": "",
            "attackDisplay": w["damage"]["display"], "defenseBonus": w["defenseBonus"],
            "elderseal": w["elderseal"], "handicraft": w["handicraft"],
            "series": w["series"]["name"] if w["series"] else None,
            "gameId": w["gameId"],
        }
        if w["id"] in GOGMA_ARTIAN_IDS:
            item["variant"] = variant[w["id"]]
            item["displayName"] = f"{w['name']} ({variant[w['id']]})"
            notes = ["巨戟アーティア (" + variant[w["id"]] + "。攻撃力と会心率から判定)",
                     "属性は手入力", "ランダムスキル・シリーズ/グループスキルも手入力 (data/my_weapons.json)"]
        elif names[w["name"]] > 1:
            raise ValueError(f"破滅のキリエヴェルド以外に同名の片手剣がある: {w['name']}")
        item["note"] = "。".join(notes)
        out.append(item)

    checks = {"mhwsCompared": None, "mismatches": [], "mhwsOnly": []}
    if sns_xlsx is not None:
        by_name = collections.defaultdict(list)
        for r in sorted(sns_xlsx, key=lambda x: x["SortId"]):
            by_name[r["Name"]].append(r)
        mhdb_names = {w["name"] for w in out}
        checks["mhwsOnly"] = [{"id": r["Id"], "name": r["Name"]} for r in sns_xlsx if r["Name"] not in mhdb_names]
        used = collections.Counter()
        n = 0
        for w in out:
            rs = by_name.get(w["name"], [])
            k = used[w["name"]]
            used[w["name"]] += 1
            if k >= len(rs):
                checks["mismatches"].append({"id": w["id"], "name": w["name"], "why": "MHWS に無い"})
                continue
            r = rs[k]
            n += 1
            sl = [0 if x == "NONE" else int(x[2:]) for x in ast.literal_eval(r["SlotLevel"])]
            sk = sorted(ast.literal_eval(r["SkillAndLevel"]))
            sharp = ast.literal_eval(r["SharpnessValList"])[:6]
            taku = [x for x in ast.literal_eval(r["TakumiValList"]) if x]
            attr = MHWS_ATTR[r["Attribute"]]
            diffs = {}
            if r["Attack"] != w["attack"]:
                diffs["attack"] = [w["attack"], r["Attack"]]
            if r["Critical"] != w["affinity"]:
                diffs["affinity"] = [w["affinity"], r["Critical"]]
            if sl != w["slots"]:
                diffs["slots"] = [w["slots"], sl]
            if sharp != w["sharpness"]["base"]:
                diffs["sharpness"] = [w["sharpness"]["base"], sharp]
            if taku != [x * 10 for x in w["handicraft"] if x]:
                diffs["handicraft"] = [w["handicraft"], taku]
            if w["element"] is None:
                if attr is not None:
                    diffs["element"] = [None, [attr, r["AttributeValue"] * 10]]
            elif attr != w["element"]["type"] or r["AttributeValue"] * 10 != w["element"]["value"]:
                diffs["element"] = [w["element"], [attr, r["AttributeValue"] * 10]]
            mine = sorted(f"{s['skill']['name']}: {s['level']}" for s in
                          next(x for x in mhdb_weapons if x["id"] == w["id"])["skills"])
            if sk != mine:
                diffs["skills"] = [mine, sk]
            if w["artian"]:
                # アーティア系は属性未選択 (Attribute=NONE) で AttributeValue だけ入っている。手入力の目安として残す
                w["mhwsAttributeValue"] = r["AttributeValue"] * 10
                diffs.pop("element", None)
            if diffs:
                checks["mismatches"].append({"id": w["id"], "name": w["name"], **diffs})
        checks["mhwsCompared"] = n
    return out, checks


# ---------------------------------------------------------------- 固定護石

def build_fixed_charms(mhdb_charms: list[dict]) -> list:
    out = []
    for c in mhdb_charms:
        if c.get("random"):
            continue
        for r in c["ranks"]:
            if not r["skills"]:
                raise ValueError(f"固定護石 {r['name']} にスキルが無い")
            out.append({"id": r["id"], "name": r["name"], "rarity": r["rarity"],
                        "skills": [sk_ref(s) for s in r["skills"]],
                        "charmId": c["id"], "level": r["level"], "gameId": c["gameId"]})
    return sorted(out, key=lambda x: x["id"])


# ---------------------------------------------------------------- main

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--refresh", action="store_true", help="生データを取り直してから作る")
    args = ap.parse_args(argv)
    manifest = equip_fetch.fetch_all(args.refresh)

    m_skills = load("mhdb/skills.json")
    m_armor = load("mhdb/armor.json")
    m_sets = load("mhdb/armor_sets.json")
    m_decos = load("mhdb/decorations.json")
    m_weapons = load("mhdb/weapons_sword-shield.json")
    m_charms = load("mhdb/charms.json")
    vals = lambda rel: equip_talisman.user_values(load(rel))  # noqa: E731
    scd = vals("mhws/raw/SkillCommonData.user.3.json")

    sizes = {}

    decos, deco_checks = build_decorations(
        m_decos, load_xlsx_sheet("mhws/db/SkillCollection.xlsx", "AccessoryData"))
    skills, skill_checks = build_skills(m_skills, scd, decos)
    skills_by_id = {s["id"]: s for s in m_skills}

    sizes["skills.json"] = write_json("skills.json", {
        "meta": make_meta(manifest, ["mhdb/skills.json", "mhdb/decorations.json",
                                     "mhws/raw/SkillCommonData.user.3.json"], checks=skill_checks,
                          note="decoSize は Lv1 を付ける単体装飾品のスロット Lv (無ければ null)。"
                               "internalId は MHWS-in-json SkillCommonData の _skillId (gameId で結合)"),
        "skills": skills})

    sizes["decorations.json"] = write_json("decorations.json", {
        "meta": make_meta(manifest, ["mhdb/decorations.json", "mhws/db/SkillCollection.xlsx"], checks=deco_checks),
        "decorations": decos})

    set_b, grp_b = build_bonuses(m_sets, skills_by_id)
    sizes["bonuses.json"] = write_json("bonuses.json", {
        "meta": make_meta(manifest, ["mhdb/armor_sets.json", "mhdb/skills.json"],
                          note="setBonuses と groupBonuses の id は別の番号体系 (MHDB の bonus id / groupBonus id)"),
        "setBonuses": set_b, "groupBonuses": grp_b})

    armor, armor_checks = build_armor(m_armor, m_sets, set_b, grp_b,
                                      load_xlsx_sheet("mhws/db/EquipCollection.xlsx", "Armor"))
    sizes["armor.json"] = write_json("armor.json", {
        "meta": make_meta(manifest, ["mhdb/armor.json", "mhdb/armor_sets.json", "mhws/db/EquipCollection.xlsx"],
                          checks=armor_checks,
                          note="slots は限界突破前。setBonusIds はその部位が数に入る全シリーズスキル "
                               "(ゴグα/β は 2 つ。先頭がシリーズ共通のもの = setBonusId)"),
        "armor": armor})

    weapons, weapon_checks = build_weapons(m_weapons, load_xlsx_sheet("mhws/db/EquipCollection.xlsx",
                                                                      "Wp_ShortSword"))
    sizes["weapons_sns.json"] = write_json("weapons_sns.json", {
        "meta": make_meta(manifest, ["mhdb/weapons_sword-shield.json", "mhws/db/EquipCollection.xlsx"],
                          checks=weapon_checks,
                          note="attack は係数なし (表示値 / 1.4)。sharpness は [赤,橙,黄,緑,青,白] の長さ (ヒット数)。"
                               "handicraftMax は匠 Lv5。mhwsAttributeValue はアーティア系の属性値の目安 (属性未選択の値)"),
        "weapons": weapons})

    fixed = build_fixed_charms(m_charms)
    sizes["charms_fixed.json"] = write_json("charms_fixed.json", {
        "meta": make_meta(manifest, ["mhdb/charms.json"],
                          note="id は MHDB の charm rank id。charmId は MHDB の charm id (同じ系統の Ⅰ〜Ⅲ で共通)"),
        "charms": fixed})

    rules_body, rules_checks = equip_talisman.build_rules(
        vals("mhws/raw/RandomAmuletPtTable.user.3.json"),
        vals("mhws/raw/RandomAmuletLotSkillTable.user.3.json"),
        vals("mhws/raw/RandomAmuletAccSlot.user.3.json"),
        m_charms, m_skills,
        load("mhws/processed/amulet_pool.json"), load("mhws/processed/skill_pool.json"))
    sizes["talisman_rules.json"] = write_json("talisman_rules.json", {
        "meta": make_meta(
            manifest,
            ["mhws/raw/RandomAmuletPtTable.user.3.json", "mhws/raw/RandomAmuletLotSkillTable.user.3.json",
             "mhws/raw/RandomAmuletAccSlot.user.3.json", "mhdb/charms.json", "mhdb/skills.json",
             "mhws/processed/amulet_pool.json", "mhws/processed/skill_pool.json"],
            checks=rules_checks,
            note="rarities のキーはゲーム内のレア度。patterns が抽選表の 1 行 (重複は weight に畳んだ)。"
                 "skillGroups[i] = スキル枠 i の群番号 (0 は枠なし)。groups[群番号] の Lv はその群で付く Lv。"
                 "slotPatterns / skillSlots は patterns を枠ごとにまとめたもの (枠どうしの組み合わせは patterns を見る)"),
        **rules_body})

    mw = DATA / "my_weapons.json"
    if not mw.exists():
        write_json("my_weapons.json", {"schema": 1, "weapons": []})

    print("件数: skills", len(skills), "/ decorations", len(decos), "/ setBonuses", len(set_b),
          "/ groupBonuses", len(grp_b), "/ armor", len(armor),
          f"(low {sum(a['rank'] == 'low' for a in armor)} high {sum(a['rank'] == 'high' for a in armor)})",
          "/ weapons_sns", len(weapons), "/ charms_fixed", len(fixed))
    print("鑑定護石:", {k: (v["name"], v["rows"], len(v["patterns"])) for k, v in rules_body["rarities"].items()},
          "unmapped", [u["amuletType"] for u in rules_body["unmapped"]])
    print("照合: skills", skill_checks["gameIdMatched"], "kind 不一致", len(skill_checks["kindMismatches"]),
          "/ decorations", deco_checks["mhwsCompared"], "件比較 不一致", len(deco_checks["mismatches"]),
          "/ armor", armor_checks["mhwsCompared"], "件比較 不一致", len(armor_checks["mismatches"]),
          "/ weapons", weapon_checks["mhwsCompared"], "件比較 不一致", len(weapon_checks["mismatches"]))
    for mm in weapon_checks["mismatches"] + armor_checks["mismatches"] + deco_checks["mismatches"]:
        print("  不一致:", json.dumps(mm, ensure_ascii=False))
    print("talisman checks:", json.dumps(rules_checks, ensure_ascii=False))
    print("サイズ:", {k: f"{v / 1024:.0f}KB" for k, v in sizes.items()})
    return 0


if __name__ == "__main__":
    sys.exit(main())
