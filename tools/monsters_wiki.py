"""monsterhunterwiki.org Bucket API (CC BY-SA 4.0) から
data/monster_threats.json (咆哮・風圧・振動・属性やられ・状態異常) と
data/quests.json (クエスト) の中身を組み立てる。

クエストの日本語名・体力倍率は MHWS-in-json (MIT) の MissionData.xlsx (日英) を英語名で突き合わせて足す。
"""
from __future__ import annotations

import difflib
import re
from collections import Counter

import openpyxl

import monsters_legendary as legendary
from monsters_fetch import CACHE
from monsters_parts import _load

WIKI_BASE = "https://monsterhunterwiki.org/wiki/"
LICENSE = {
    "name": "CC BY-SA 4.0",
    "url": "https://creativecommons.org/licenses/by-sa/4.0/",
    "attribution": "Monster Hunter Wiki (monsterhunterwiki.org) の寄稿者。Bucket API の monsters_games / quests "
                   "と Status Effects (MHWilds) を加工。このファイルも同じ CC BY-SA 4.0 で提供する。",
}

ELEMENT_EN = {"Fire": "fire", "Water": "water", "Thunder": "thunder", "Ice": "ice", "Dragon": "dragon"}
BLIGHT_JA = {"fire": "火属性やられ", "water": "水属性やられ", "thunder": "雷属性やられ",
             "ice": "氷属性やられ", "dragon": "龍属性やられ"}
BLIGHT_UNCERTAIN_REASON = ("wiki の攻撃属性 (elements) にはこの属性があるが、状態異常 (status_effects) に"
                           "この属性やられが無い。属性やられになるかは未確認")
# Arena Counter のページ (クエストの節分け) で、装備を持ち込む「フリーチャレンジ」の節の見出し
FREE_CHALLENGE_SECTION = "Free Challenge Quests"
# wiki の状態異常名 → (キー, 日本語名, 確度)。日本語名はゲーム内テキスト (MHWS-in-json FullText) で確認したもの
STATUS_EN = {
    "Poison": ("poison", "毒", "high"),
    "Noxious Poison": ("noxious-poison", "猛毒", "medium"),
    "Sleep": ("sleep", "睡眠", "high"),
    "Paralysis": ("paralysis", "麻痺", "high"),
    "Stun": ("stun", "気絶", "high"),
    "Blast": ("blast", "爆破やられ", "high"),
    "Bleeding": ("bleeding", "裂傷", "high"),
    "Frenzy": ("frenzy", "狂竜症", "high"),
    "Webbed": ("webbed", "糸拘束", "high"),
    "Frostblight": ("frostblight", "凍結", "high"),
    "Bubbleblight": ("bubbleblight-minor", "泡状態【小】", "high"),
    "Severe Bubbleblight": ("bubbleblight-major", "泡状態【大】", "high"),
    "Soiled": ("stench", "悪臭", "medium"),
    "Snowman": ("snowman", "雪だるま", "low"),
    "Defense Down": ("defense-down", "防御力DOWN", "high"),
}
ROAR = {"None": "none", "Weak": "weak", "Strong": "strong"}
ROAR_RANK = {"none": 0, "weak": 1, "strong": 2}
WIND = {"None": "none", "Minor": "minor", "Major": "major", "Dragon": "dragon"}
TREMOR = {"None": "none", "Minor": "minor", "Major": "major"}
VARIANT_EN = {"Tempered": "tempered", "Arch Tempered": "arch-tempered", "Frenzied": "frenzied"}
LEGENDARY = {"NONE": None, "NORMAL": "tempered", "KING": "arch-tempered"}


def skill_ids() -> dict[str, dict]:
    """MHDB の英語名 → {"skillId", "name"(日本語), "levels": {lv: 説明}}"""
    en = _load("mhdb_skills_en.json")
    ja = {s["id"]: s for s in _load("mhdb_skills_ja.json")}
    out = {}
    for s in en:
        j = ja[s["id"]]
        out[s["name"]] = {"skillId": s["id"], "name": j["name"],
                          "levels": {r["level"]: re.sub(r"\s+", "", r.get("description") or "") for r in j["ranks"]}}
    return out


def rules() -> dict:
    """防御スキルの規則。しきい値は wiki の Status Effects (MHWilds)、レベルごとの効果文は MHDB の
    スキル説明 (ゲーム内テキスト) から。"""
    sk = skill_ids()

    def ref(en, negate=None, mitigate=None):
        s = sk[en]
        d = {"skill": s["name"], "skillEn": en, "skillId": s["skillId"]}
        if negate is not None:
            d["negateLevel"] = negate
        if mitigate is not None:
            d["mitigateLevel"] = mitigate
        d["levelText"] = s["levels"]
        return d

    return {
        "elementalBlight": {
            "description": "属性耐性が 20 以上ならその属性の属性やられにならない。属性やられ耐性 Lv3 で全属性の属性やられを無効。"
                           "Lv1/2 は効果時間を短くするだけ。",
            "resistanceThreshold": 20,
            "skill": ref("Blight Resistance", negate=3, mitigate=1),
            "source": WIKI_BASE + "Status_Effects_(MHWilds)",
            "confidence": "high",
        },
        "roar": {"weak": ref("Earplugs", negate=2, mitigate=1), "strong": ref("Earplugs", negate=3, mitigate=2)},
        "windPressure": {"minor": ref("Windproof", negate=1), "major": ref("Windproof", negate=2, mitigate=1),
                         "dragon": ref("Windproof", negate=3, mitigate=2)},
        "tremor": {"minor": ref("Tremor Resistance", negate=2, mitigate=1),
                   "major": ref("Tremor Resistance", negate=3, mitigate=2)},
        "status": {
            "poison": ref("Poison Resistance", negate=3, mitigate=1),
            "noxious-poison": ref("Poison Resistance", negate=3, mitigate=1),
            "paralysis": ref("Paralysis Resistance", negate=3, mitigate=1),
            "sleep": ref("Sleep Resistance", negate=3, mitigate=1),
            "stun": ref("Stun Resistance", negate=3, mitigate=1),
            "blast": ref("Blast Resistance", negate=3, mitigate=1),
            "bleeding": ref("Bleeding Resistance", negate=3, mitigate=1),
            "webbed": ref("Bind Resistance", negate=3, mitigate=1),
            "frostblight": ref("Bind Resistance", negate=3, mitigate=1),
            "stench": ref("Stench Resistance", negate=2, mitigate=1),
            "defense-down": ref("Iron Skin", negate=3, mitigate=1),
        },
        "noSkill": {
            "bubbleblight-minor": "防具スキルでは防げない (狩猟笛の旋律などのみ)",
            "bubbleblight-major": "防具スキルでは防げない (タマミツネのシリーズスキルで無効)",
            "frenzy": "無効化するスキルは無い (無我の境地は克服を助けるだけ)",
            "snowman": "wiki に防ぎ方の記載なし",
        },
        "source": [WIKI_BASE + "Status_Effects_(MHWilds)", "https://wilds.mhdb.io/ja/skills"],
    }


def _parse_wind(v):
    """風圧。'None'/'Minor' 等の素直な値か、wiki マークアップの生文字列 (ゾ・シア) を読む。"""
    if v is None:
        return None, None
    if v in WIND:
        return WIND[v], None
    m = re.search(r"#(\w+) Wind Pressure\|(\w+)", v)
    if m and m.group(1) in WIND:
        return WIND[m.group(1)], f"wiki の値がマークアップの生文字列だったため '{m.group(1)} Wind Pressure' を読み取った"
    return None, f"風圧の値を解釈できない: {v[:60]}"


def build_threats(monsters: list[dict]) -> tuple[list[dict], list[dict], dict]:
    """34 体の脅威データ・その他 (34 体以外の Wilds 行)・集計を返す。"""
    mg = _load("wiki_monsters_games_mhwilds.json")
    en2id = monster_en_names(monsters)
    by_id = {m["id"]: m for m in monsters}
    rows = {r["page_name"]: r for r in mg["rows"]}
    out, others, issues = [], [], []
    seen = set()
    for page, r in sorted(rows.items()):
        base = re.sub(r"\s*\(MHWilds\)$", "", page)
        mid = en2id.get(base)
        status, blights, notes = [], [], []
        for s in r.get("status_effects") or []:
            if s in ELEMENT_EN:
                e = ELEMENT_EN[s]
                if e not in blights:
                    blights.append(e)
            elif s in STATUS_EN:
                k, ja, conf = STATUS_EN[s]
                status.append({"key": k, "name": ja, "wiki": s, "nameConfidence": conf})
            else:
                status.append({"key": s.lower().replace(" ", "-"), "name": None, "wiki": s, "nameConfidence": None})
                notes.append(f"状態異常名 '{s}' の対応が未定義")
        roar_vals = [ROAR[x] for x in (r.get("roar") or []) if x in ROAR]
        roar = max(roar_vals, key=lambda x: ROAR_RANK[x]) if roar_vals else None
        wind, wnote = _parse_wind(r.get("wind_pressure"))
        if wnote:
            notes.append(wnote)
        tremor = TREMOR.get(r.get("tremor")) if r.get("tremor") is not None else None
        if r.get("tremor") is not None and tremor is None:
            notes.append(f"振動の値を解釈できない: {r.get('tremor')}")
        for f, v in (("roar", roar), ("windPressure", wind), ("tremor", tremor)):
            if v is None:
                notes.append(f"{f} が wiki に無い (null)")
        attack = [ELEMENT_EN[e] for e in (r.get("elements") or []) if e in ELEMENT_EN]
        entry = {
            "wikiPage": page, "wikiUrl": WIKI_BASE + page.replace(" ", "_"),
            "roar": roar, "windPressure": wind, "tremor": tremor,
            "attackElements": attack,
            "blights": [{"element": e, "name": BLIGHT_JA[e]} for e in blights],
            # 攻撃属性にあるのに属性やられに無いもの。wiki の書き漏れか、本当にやられにならないのか分からないので
            # blights には足さず (自動で埋めない)、ここに分けて持つ
            "blightsUncertain": [{"element": e, "name": BLIGHT_JA[e], "reason": BLIGHT_UNCERTAIN_REASON}
                                 for e in attack if e not in blights],
            "statusEffects": status,
            "issues": notes,
        }
        if mid is None:
            others.append({"nameEn": base, **entry})
            continue
        seen.add(mid)
        out.append({"monsterId": mid, "name": by_id[mid]["name"], "nameEn": base, **entry})
        for n in notes:
            issues.append(f"{by_id[mid]['name']}: {n}")
    missing = [m["name"] for m in monsters if m["id"] not in seen]
    for mid in sorted(set(by_id) - seen):
        out.append({"monsterId": mid, "name": by_id[mid]["name"], "nameEn": None, "wikiPage": None, "wikiUrl": None,
                    "roar": None, "windPressure": None, "tremor": None, "attackElements": [], "blights": [],
                    "blightsUncertain": [], "statusEffects": [], "issues": ["wiki に Wilds の行が無い"]})
    out.sort(key=lambda x: x["monsterId"])
    summary = {"wikiRowsScanned": mg["totalRowsScanned"], "wikiPages": mg["pages"], "wildsRows": len(mg["rows"]),
               "matched": len(seen), "missing": missing, "issues": issues}
    return out, others, summary


def monster_en_names(monsters: list[dict]) -> dict[str, int]:
    """英語名 → MHDB id (mhdb-wilds-data の LargeMonsters の names.en を gameId で結合)。"""
    lm = _load("mhdbdata_LargeMonsters.json")
    gid2id = {m["gameId"]: m["id"] for m in monsters}
    out = {}
    for m in lm:
        mid = gid2id.get(int(m["game_id"]))
        if mid is not None:
            out[m["names"]["en"]] = mid
    return out


def variant_en_names(monsters: list[dict]) -> dict[str, tuple[int, str]]:
    """'Alpha Doshaguma' / 'Nerscylla Clone' 等の英語の個体名 → (MHDB id, variant)。"""
    lm = _load("mhdbdata_LargeMonsters.json")
    gid2id = {m["gameId"]: m["id"] for m in monsters}
    out = {}
    for m in lm:
        mid = gid2id.get(int(m["game_id"]))
        for v in m.get("variants") or []:
            n = (v.get("names") or {}).get("en")
            if mid is not None and n:
                out[n] = (mid, v["kind"])
    return out


# ---------------- クエスト ----------------

def _norm(s: str) -> str:
    s = (s or "").lower().replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    s = re.sub(r"^event:\s*", "", s)
    s = re.sub(r"[^\w\s]", "", s)
    return re.sub(r"\s+", " ", s).strip()


def _strip_tags(s) -> str:
    return re.sub(r"<[^>]+>", "", s or "").strip()


def mission_columns(head: tuple, sub: tuple) -> dict[str, int]:
    """MissionData の 2 段の見出し → {列名: 列番号}。2 段目がある列は「上段|下段」(例 '_Count = 2|_Health')。"""
    col, cur = {}, None
    for i, (a, b) in enumerate(zip(head, sub)):
        if a is not None:
            cur = a
        if cur is None:
            continue
        col.setdefault(f"{cur}|{b}" if b else cur, i)
    return col


def load_missions() -> dict[str, dict]:
    """MissionData.xlsx (日英) → {missionId: {...}}。対象モンスターは続きの行 (_MissionId 空) にも並ぶ。"""
    def rows(lang):
        ws = openpyxl.load_workbook(CACHE / f"db_{lang}/MissionData.xlsx", read_only=True).worksheets[0]
        return list(ws.iter_rows(values_only=True))
    ja, en = rows("ja-JP"), rows("en-US")
    col = mission_columns(ja[0], ja[1])
    need = ["_MissionId", "_QuestLv", "_TitleMsg", "MonsterName", "_TargetType", "_LegendaryID", "SoloHealth",
            "_Health", "_Attack", "_PartsVital", "_Version", "_QuestType", "_Stage",
            "_RewardRank", "_DamageSlashBlow", "_DamageShot", "_MultiTableId", "_MaxPlayerNum"]
    need += [f"_Count = {n}|{k}" for n in (2, 3, 4) for k in ("_Health", "_Attack", "_PartsVital")]
    for n in need:
        if n not in col:
            raise ValueError(f"MissionData に列 {n} が無い")
    out, cur = {}, None
    for rj, re_ in zip(ja[2:], en[2:]):
        if rj[col["_MissionId"]]:
            cur = rj[col["_MissionId"]]
            out[cur] = {"missionId": cur, "questLv": rj[col["_QuestLv"]],
                        "nameJa": _strip_tags(rj[col["_TitleMsg"]]), "nameEn": _strip_tags(re_[col["_TitleMsg"]]),
                        "questType": rj[col["_QuestType"]], "version": rj[col["_Version"]],
                        "stage": rj[col["_Stage"]], "maxPlayers": rj[col["_MaxPlayerNum"]], "targets": []}
        if cur is None or not rj[col["MonsterName"]]:
            continue
        solo = rj[col["SoloHealth"]]
        solo_list = [int(x) for x in re.findall(r"\d+", str(solo))] if solo is not None else []
        rank = re.fullmatch(r"REWARD_RANK_(\d+)", str(rj[col["_RewardRank"]] or ""))
        out[cur]["targets"].append({
            "nameJa": rj[col["MonsterName"]], "targetType": rj[col["_TargetType"]],
            "legendary": rj[col["_LegendaryID"]],
            "health": rj[col["_Health"]], "attack": rj[col["_Attack"]], "partsVital": rj[col["_PartsVital"]],
            "soloHealth": solo_list,
            "rewardRank": int(rank.group(1)) if rank else None,
            "damageSlashBlow": rj[col["_DamageSlashBlow"]], "damageShot": rj[col["_DamageShot"]],
            "multiTableId": rj[col["_MultiTableId"]],
            "multi": {n: {"health": rj[col[f"_Count = {n}|_Health"]], "attack": rj[col[f"_Count = {n}|_Attack"]],
                          "partsVital": rj[col[f"_Count = {n}|_PartsVital"]]} for n in (2, 3, 4)},
        })
    return out


def match_mission(q: dict, by_norm: dict[str, list[dict]], missions_norm: list[str]) -> tuple[dict | None, str]:
    """wiki のクエスト名と MissionData の英語名を突き合わせる。"""
    n = _norm(q["name"])
    cands = by_norm.get(n, [])
    how = "exact"
    if not cands:
        close = difflib.get_close_matches(n, missions_norm, n=2, cutoff=0.9)
        if len(close) >= 1:
            cands = by_norm[close[0]]
            how = f"fuzzy:{close[0]}"
    cands = [c for c in cands if c["questLv"] is not None]  # 名前だけの空行は捨てる
    if not cands:
        return None, "none"
    same = [c for c in cands if c["questLv"] == q.get("stars")]
    pick = (same or cands)
    pick = sorted(pick, key=lambda c: c["missionId"])[0]
    if pick["questLv"] != q.get("stars"):
        how += ":stars-differ"
    return pick, how


_VARIANT_PREFIX = [("Arch-Tempered ", "arch-tempered"), ("Arch Tempered ", "arch-tempered"),
                   ("Tempered ", "tempered"), ("Frenzied ", "frenzied")]


def _resolve_en(name: str, en2id: dict[str, int], var_en: dict[str, tuple[int, str]]) -> tuple[int | None, str | None]:
    """英語名 → (MHDB id, variant)。基本種の名前を先に見て、次に個体名 ('Alpha Doshaguma' 等)、
    最後に 'Tempered ' 等の接頭辞を外して引く。解決できなければ (None, None)。"""
    if name in en2id:
        return en2id[name], None
    if name in var_en:
        return var_en[name]
    low = name.lower()
    for pre, v in _VARIANT_PREFIX:
        if low.startswith(pre.lower()):
            mid, _ = _resolve_en(name[len(pre):], en2id, var_en)
            return (mid, v) if mid is not None else (None, None)
    return None, None


def _wiki_link_names(summary: str) -> list[tuple[str, str]]:
    """'[[Nerscylla (MHWilds)|Nerscylla Clone]]' → [('Nerscylla', 'Nerscylla Clone')]"""
    out = []
    for page, disp in re.findall(r"\[\[([^\]|]+)\|([^\]]+)\]\]", summary or ""):
        if "(MHWilds)" in page:
            out.append((re.sub(r"\s*\(MHWilds\)$", "", page), disp))
    return out


def arena_sections() -> dict[str, str]:
    """wiki の「MHWilds/Quests/Arena Counter」ページの節分け: クエスト名 (表示名) → 節の見出し。

    節は Arena Quests / Challenge Quests (どちらも装備セット Set 1〜3 の記載あり) と
    Free Challenge Quests (タイムランキング付き。装備セットの記載が無い) の 3 つ。
    """
    d = _load("wiki_arena_counter.json")
    text = d["parse"]["wikitext"]["*"]
    out = {}
    secs = re.split(r"^==([^=\n]+)==\s*$", text, flags=re.M)
    for i in range(1, len(secs), 2):
        head = secs[i].strip()
        for name in re.findall(r"\|Quest Name\s*=\s*\[\[[^|\]]*\|([^\]]+)\]\]", secs[i + 1]):
            out[name.strip()] = head
    if FREE_CHALLENGE_SECTION not in out.values():
        raise ValueError(f"Arena Counter のページに「{FREE_CHALLENGE_SECTION}」の節が無い (ページの構成が変わった?)")
    return out


def _fixed_equipment(r: dict, section: str | None = None) -> tuple[bool | None, str, str]:
    """装備固定か (値, 根拠, 確度)。section は Arena Counter ページでそのクエストが載っている節の見出し。"""
    ai = r.get("arena_info") or ""
    notes = r.get("notes") or ""
    desc = r.get("description") or ""
    if "Set 1" in ai:
        conf = "high" if re.search(r"pre-?determined|per-determined", desc) else "medium"
        return True, "arena_info に装備セット (Set 1〜3) の記載がある (アリーナ/チャレンジの固定装備)", conf
    if "Akuma Set" in notes:
        return True, "notes に「Equipped with Akuma Set」", "high"
    if r.get("quest_type") == "Arena":
        if section == FREE_CHALLENGE_SECTION and not re.search(r"pre-?determined|set of equipment", desc):
            return False, ("wiki の Arena Counter ページで、装備セット (Set 1〜3) が付く Arena/Challenge の節とは別の"
                           "「Free Challenge Quests」の節に載っており、説明文も「特に手強いモンスターに挑む・"
                           "期間中の最速タイムで報酬」で固定装備の記載が無い (= 持ち込み装備のフリーチャレンジ)。"
                           "ゲーム内では未確認"), "medium"
        if "Time Ranking" in ai:
            return None, ("タイムランキング付きのチャレンジ。"
                          "Bucket の項目と Arena Counter の節からは装備固定か判断できない"), "low"
        return None, "アリーナ種別だが装備の記載が無い", "low"
    return False, "通常のクエスト (持ち込み装備)", "high"


def build_quests(monsters: list[dict]) -> tuple[list[dict], dict]:
    data = _load("wiki_quests_mhwilds.json")
    rows = data["rows"]
    en2id = monster_en_names(monsters)
    var_en = variant_en_names(monsters)
    by_id = {m["id"]: m for m in monsters}
    ja2id = {m["name"]: m["id"] for m in monsters}
    for m in monsters:
        for k, n in m["variantNames"].items():
            ja2id.setdefault(n, m["id"])
    missions = load_missions()
    sections = arena_sections()
    health = legendary.HealthModel(monsters)
    as_of = legendary.fetched_date("wiki_quests_mhwilds.json")
    by_norm: dict[str, list[dict]] = {}
    for ms in missions.values():
        by_norm.setdefault(_norm(ms["nameEn"]), []).append(ms)
    norms = list(by_norm)

    names = Counter(r["name"] for r in rows)
    dups = [n for n, c in names.items() if c > 1]
    if dups:
        raise ValueError(f"クエスト名が重複: {dups}")

    report = {"rows": len(rows), "pages": data["pages"], "missionMatched": 0, "missionUnmatched": [],
              "missionFuzzy": [], "starsDiffer": [], "unmappedTargets": Counter(), "unmappedMissionMonsters": Counter(),
              "targetMismatch": [], "unmappedIntruders": Counter(), "variantMismatch": [],
              "healthChecked": 0, "healthMismatch": [], "damageRateRows": 0, "damageRateNot1": [],
              "categoryOverride": [],
              "availability": Counter()}
    out = []
    for r in sorted(rows, key=lambda x: x["name"]):
        icons = r.get("goal_icon_names") or []
        types = r.get("goal_icon_types") or []
        link_disp = dict((d, p) for p, d in _wiki_link_names(r.get("summary")))
        summary_plain = re.sub(r"\[\[[^\]|]*\|([^\]]*)\]\]", r"\1", r.get("summary") or "")
        summary_plain = re.sub(r"\[\[([^\]]*)\]\]", r"\1", summary_plain)
        tgt_acc: dict[tuple, dict] = {}
        for i, name in enumerate(icons):
            vt = types[i] if i < len(types) else None
            variant = VARIANT_EN.get(vt)
            mid = en2id.get(name)
            if mid is None and name in var_en:
                mid, variant = var_en[name][0], variant or var_en[name][1]
            if mid is not None and variant is None:
                # 要約のリンク表示名で個体を判別 ('Nerscylla Clone' 等)。
                # 基本種と同じ名前の個体名 (MHDB ではオメガ・プラネテスの歴戦個体の英語名が 'Omega Planetes')
                # は個体の手がかりにならないので使わない (使うと通常個体のクエストが歴戦になる)
                for disp, page in link_disp.items():
                    if page == name and disp in var_en and disp not in en2id and var_en[disp][0] == mid:
                        variant = var_en[disp][1]
            key = (mid, name if mid is None else None, variant)
            if key not in tgt_acc:
                tgt_acc[key] = {"monsterId": mid, "name": by_id[mid]["name"] if mid else None,
                                "nameEn": name if mid is None else
                                next(k for k, v in en2id.items() if v == mid),
                                "variant": variant, "count": 0, "large": mid is not None}
            tgt_acc[key]["count"] += 1
            if mid is None:
                report["unmappedTargets"][name] += 1
        targets = list(tgt_acc.values())
        # 小型の討伐数 ("Slay 8 Piragill") は要約の数字で数える
        if len(targets) == 1 and not targets[0]["large"]:
            mnum = re.search(r"\b(\d+)\b", summary_plain)
            if mnum:
                targets[0]["count"] = int(mnum.group(1))
        large_count = sum(t["count"] for t in targets if t["large"])
        vset = {t["variant"] for t in targets if t["large"]}
        qvariant = (next(iter(vset)) if len(vset) == 1 else ("mixed" if vset - {None} else None)) if vset else None

        intr, seen = [], set()
        for n in r.get("other_large_monsters") or []:
            if n in seen:
                continue
            seen.add(n)
            # 'Tempered Rathalos' / 'Alpha Doshaguma' のように個体名が付いていることがある
            mid, ivar = _resolve_en(n, en2id, var_en)
            if mid is None:
                report["unmappedIntruders"][n] += 1
            intr.append({"monsterId": mid, "name": by_id[mid]["name"] if mid else None, "nameEn": n,
                         "variant": ivar})

        fixed, fixed_reason, fixed_conf = _fixed_equipment(r, sections.get(r["name"]))
        ms, how = match_mission(r, by_norm, norms)
        mission = None
        if ms:
            report["missionMatched"] += 1
            if how.startswith("fuzzy"):
                report["missionFuzzy"].append(f"{r['name']} → {ms['nameEn']}")
            if "stars-differ" in how:
                report["starsDiffer"].append(f"{r['name']} wiki★{r.get('stars')} / MissionData★{ms['questLv']}")
            mts = []
            for t in ms["targets"]:
                mid = ja2id.get(t["nameJa"])
                if mid is None:
                    report["unmappedMissionMonsters"][t["nameJa"]] += 1
                mt = {"monsterId": mid, "nameJa": t["nameJa"],
                      "variant": LEGENDARY.get(t["legendary"]) if t["legendary"] in LEGENDARY else None,
                      "legendaryId": t["legendary"], "targetType": t["targetType"],
                      "health": t["health"], "attack": t["attack"], "partsVital": t["partsVital"],
                      "soloHealth": t["soloHealth"]}
                if mid is not None:
                    # 歴戦の群・体力の再計算 (MissionData の SoloHealth と照合)・攻撃の倍率の目安
                    mt.update(health.target(mid, t["legendary"], t["rewardRank"], t["health"], t["attack"],
                                            t["soloHealth"]))
                    hc = mt["healthCalc"]
                    if hc is not None:
                        report["healthChecked"] += 1
                        if not hc["matchesMissionData"]:
                            report["healthMismatch"].append(f"{r['name']} {t['nameJa']} 計算 {hc['mid']} / "
                                                            f"MissionData {t['soloHealth']}")
                else:
                    mt.update({"rewardRank": t["rewardRank"], "paramGroup": None, "paramGroupReason": "unknown",
                               "healthCalc": None, "attackRate": None})
                # クエスト側のダメージ補正 (切断・打撃 / 弾)。全部 1 なので行には持たず、件数を meta に残す
                # (1 でない行があれば report に出る。値の無い行 = 小型は数えない)
                if (t["damageSlashBlow"], t["damageShot"]) != (None, None):
                    report["damageRateRows"] += 1
                    if (t["damageSlashBlow"], t["damageShot"]) != (1, 1):
                        report["damageRateNot1"].append(
                            f"{r['name']} {t['nameJa']} {t['damageSlashBlow']}/{t['damageShot']}")
                mt["multi"] = legendary.multi_info(t, ms["maxPlayers"])
                mts.append(mt)
            wiki_ids = sorted(t["monsterId"] for t in targets if t["large"] for _ in range(t["count"]))
            mis_ids = sorted(t["monsterId"] for t in mts if t["monsterId"] is not None)
            if wiki_ids != mis_ids:
                report["targetMismatch"].append(r["name"])
            # 歴戦/歴戦王の判定を MissionData の _LegendaryID と突き合わせる (alpha/frenzied は比べられない)
            leg = {"tempered", "arch-tempered"}
            vkey = lambda x: (x[0], x[1] or "")  # noqa: E731  (None と文字列を並べるため)
            wiki_v = sorted(((t["monsterId"], t["variant"] if t["variant"] in leg else None)
                             for t in targets if t["large"] for _ in range(t["count"])), key=vkey)
            mis_v = sorted(((t["monsterId"], t["variant"]) for t in mts if t["monsterId"] is not None), key=vkey)
            if wiki_ids == mis_ids and wiki_v != mis_v:
                report["variantMismatch"].append(f"{r['name']} wiki={wiki_v} / MissionData={mis_v}")
            mission = {"missionId": ms["missionId"], "match": how, "questLv": ms["questLv"],
                       "questType": ms["questType"], "version": ms["version"], "stage": ms["stage"],
                       "maxPlayers": ms["maxPlayers"], "targets": mts}
        else:
            report["missionUnmatched"].append(r["name"])

        locale = (r.get("locale") or "").split("|")[0].strip() or None
        category = (r.get("important") or "").lower() or None
        cat_extra = {}
        # Bucket の important がページの Infobox と食い違うものがある (歴戦王のクエストのページだけ取得している)。
        # ページが Event なのに Bucket が optional のときだけページに合わせる
        imp = legendary.quest_page_importance(r["page_name"])
        if imp == "Event" and category == "optional":
            cat_extra = {"categoryBucket": category,
                         "categoryReason": "wiki の Bucket では optional だが、クエストのページの Importance は Event "
                                           "(配信期間 Time Period もある)。ページに合わせた"}
            report["categoryOverride"].append(f"{r['name']}: {category} → event")
            category = "event"
        avail = legendary.availability(r, category, as_of)
        report["availability"][avail["status"]] += 1
        out.append({
            "id": r["name"],
            "name": ms["nameJa"] if ms else r["name"],
            "nameLang": "ja" if ms else "en",
            "nameEn": r["name"],
            "stars": r.get("stars"),
            "rank": (r.get("rank") or "").lower() or None,
            "type": (r.get("quest_type") or "").lower() or None,
            "category": category,
            **cat_extra,
            "availability": avail,
            "targets": targets,
            "largeTargetCount": large_count,
            "multi": large_count >= 2,
            "variant": qvariant,
            "intruders": intr,
            "fixedEquipment": fixed,
            "fixedEquipmentReason": fixed_reason,
            "fixedEquipmentConfidence": fixed_conf,
            "locale": locale,
            "timeLimit": r.get("time_limit"),
            "requirements": r.get("requirements"),
            "wikiUrl": WIKI_BASE + r["page_name"].replace(" ", "_"),
            "mission": mission,
        })
    report["unmappedTargets"] = dict(report["unmappedTargets"])
    report["unmappedMissionMonsters"] = dict(report["unmappedMissionMonsters"])
    report["unmappedIntruders"] = dict(report["unmappedIntruders"])
    report["availability"] = dict(report["availability"])
    report["availabilityAsOf"] = as_of
    report["healthGrades"] = health.grade_tables()
    # Arena Counter のページに載っているのに Bucket の quests に無いクエスト (名前の付け方のずれの検出用)
    report["arenaSectionNotInBucket"] = sorted(set(sections) - set(names))
    report["arenaSections"] = dict(Counter(sections.values()))
    return out, report
