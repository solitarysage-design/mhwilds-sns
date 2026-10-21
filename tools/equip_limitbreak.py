"""防具の限界突破 (TU4 / Ver.1.040 で追加。英語版 wiki では Transcend) 後のスロットを決める。

ゲームデータ (MHWS-in-json) には限界突破後のスロットの欄が無い (規則はプログラム側にあると思われる)。
そこで、出典で集めた例に当てはまる規則を探し、その規則で MHDB のスロットから計算する。

規則 (2026-10-21 に確認。根拠は docs/sources/equip.md):
- レア5: 3 つの枠をそれぞれ +1 (上限 Lv3。空き枠は Lv1 の枠になる)        例 ②①ー → ③②①
- レア6: 1 番目と 2 番目の枠を +1 (上限 Lv3。上限で余った分は次の枠に回らない) 例 ②①ー → ③②ー、③ーー → ③①ー
- レア7・8: スロットは変わらない (防御力だけ上がる)
- レア1〜4 (下位): 限界突破できない

限界突破できるレア度は ArmorUpgradeData の _IsSpecialUpgrade=true の行から取る (内部の RARE n = ゲーム内のレア n+1。
護石と同じずれ)。

照合:
- monsterhunterwiki.org (CC BY-SA 4.0) の防具シリーズのページの「Transcend N Deco」(限界突破後の Lv N の枠の数)。
  bot (MH Wiki Toolkit) が 2026-10-12 に書き込んだもの。生成のたびに全件を規則と比べ、食い違えばその防具は null にする。
- Game8 (照合だけ。取り込まない): 限界突破の解説ページの「スロットが増加する防具一覧」と、全武器種の最強装備ページの
  「(限界突破強化)」付きの防具。2026-10-21 に人手で照合した結果を GAME8_CHECK に定数で残す。
  Game8 と wiki で食い違う防具 (豪鬼αの 2 部位) は DISPUTED に入れ、推測で埋めずに null にする。
"""
from __future__ import annotations

import collections
import re

CAP = 3
# 各枠に足す Lv (左の枠から)。上限 CAP で切る。上限で余った分は次の枠に回さない
RULE_ADD = {5: [1, 1, 1], 6: [1, 1, 0], 7: [0, 0, 0], 8: [0, 0, 0]}
RULE_TEXT = {
    "5": "3 つの枠をそれぞれ +1 (上限 Lv3。空き枠は Lv1 の枠になる)。例 ②①ー → ③②①",
    "6": "1 番目と 2 番目の枠を +1 (上限 Lv3。上限で余った分は次の枠に回らない)。例 ②①ー → ③②ー、③ーー → ③①ー",
    "7": "スロットは変わらない (防御力だけ上がる)",
    "8": "スロットは変わらない (防御力だけ上がる)",
}

GAME8_LB_URL = "https://game8.jp/mhwilds/749580"
GAME8_BUILD_URLS = [f"https://game8.jp/mhwilds/{n}" for n in
                    (668362, 668363, 668364, 668365, 668366, 668367, 668368, 668370, 668371, 668372, 668373,
                     668374, 668375, 670772)]
# Game8 との照合結果 (2026-10-21、人手。Game8 は取り込み元にしないので数と食い違いだけを残す)
GAME8_CHECK = {
    "checkedAt": "2026-10-21",
    "limitBreakPage": {
        "url": GAME8_LB_URL,
        "listed": 386, "joinedByName": 385,
        "matched": 383,
        "note": ("「スロットが増加する防具一覧」(レア5 200 件・レア6 186 件)。名前で結合できない 1 件は ダイバーボディα "
                 "(MHDB では ダイバースーツα)。強化前のスロットは結合できた 385 件すべて MHDB と一致。"
                 "食い違いは 豪鬼α の 2 部位だけ (disputed)。"
                 "同ページの本文: 「レア5が3枠、レア6が2枠増える」「左から順に1個ずつ増えている」"
                 "「ミツネ装備のみスロットの増加量が少ない」(= 先頭が Lv3 で上限に当たる防具)"),
    },
    "buildPages": {
        "urls": GAME8_BUILD_URLS,
        "mentions": 43, "pieces": 14, "matched": 43,
        "note": ("全 14 武器種の最強装備ページの「(限界突破強化)」付きの防具。すべてレア6 で、規則と一致。"
                 "例: 護火竜アームβ ②①① → ③②①、護火竜グリーヴβ ②ーー → ③①ー、護兇爪竜メイルβ ②②ー → ③③ー、"
                 "ミツネヘルムα ③ーー → ③①ー (上限に当たる例。操虫棍のページ)"),
    },
}
# 出典どうしで食い違う防具 (推測で埋めない)。値は MHDB の id
DISPUTED = {
    589: {"name": "鬼の外衣α", "slots": [3, 1, 0], "wiki": [3, 2, 0], "game8": [3, 2, 1]},
    591: {"name": "鬼の腰巻α", "slots": [3, 1, 0], "wiki": [3, 2, 0], "game8": [3, 2, 1]},
}
DISPUTED_NOTE = ("限界突破後のスロットが出典で食い違う (wiki ③②ー / Game8 ③②①)。"
                 "同じく先頭が Lv3 のミツネ防具は両方の出典で「余りは次の枠に回らない」なので ③②ー の可能性が高いが、"
                 "ゲームで確かめるまで空けておく")


def _rare(s: str) -> int:
    """'[13] RARE5' → ゲーム内のレア度 6 (内部の RARE n は 0 始まり)"""
    m = re.search(r"RARE(\d+)$", s)
    if not m:
        raise ValueError(f"レア度の形が想定外: {s}")
    return int(m.group(1)) + 1


def apply_rule(slots: list[int], rarity: int) -> list[int]:
    """限界突破後のスロット (規則)。"""
    add = RULE_ADD[rarity]
    return [min(CAP, s + a) for s, a in zip(slots, add)]


def upgrade_levels(upgrade_rows: list[dict], sp_cost_rows: list[dict]) -> dict[int, dict]:
    """レア度ごとの強化上限 Lv と限界突破後の上限 Lv。限界突破できるレア度だけ limitBreakMaxLevel を持つ。"""
    out: dict[int, dict] = {}
    for r in upgrade_rows:
        rar = _rare(r["_Rare"])
        d = out.setdefault(rar, {"maxLevel": 1, "limitBreakMaxLevel": None})
        if r["_IsSpecialUpgrade"]:
            d["limitBreakMaxLevel"] = max(d["limitBreakMaxLevel"] or 0, r["_MaxLevel"])
        else:
            d["maxLevel"] = max(d["maxLevel"], r["_MaxLevel"])
    sp = sorted(_rare(r["_Rare"]) for r in sp_cost_rows)
    lb = sorted(k for k, v in out.items() if v["limitBreakMaxLevel"])
    if sp != lb:
        raise ValueError(f"限界突破できるレア度が ArmorUpgradeData {lb} と ArmorSpUpgradeCostData {sp} で違う")
    return dict(sorted(out.items()))


def _template_fields(body: str) -> dict:
    f = {}
    for line in body.split("\n"):
        m = re.match(r"\|\s*([^=|]+?)\s*=\s*(.*)$", line)
        if m:
            f[m.group(1)] = m.group(2).strip()
    return f


def _slots_from(f: dict, fmt: str) -> list[int]:
    s: list[int] = []
    for lv in (4, 3, 2, 1):
        v = f.get(fmt.format(lv), "")
        s += [lv] * (int(v) if v.isdigit() else 0)
    if len(s) > 3:
        raise ValueError(f"wiki のスロットが 3 つを超える: {f.get('Piece Name')} {s}")
    return (s + [0, 0, 0])[:3]


def parse_wiki_pieces(pages: dict) -> list[dict]:
    """wiki の防具シリーズのページから 1 部位ずつ (名前・レア度・スロット・限界突破後のスロット) を取り出す。

    「Level N Decos」= Lv N の枠の数、「Transcend N Deco」= 限界突破後の Lv N の枠の数。
    Transcend の欄が 1 つも無い部位は transcendSlots = None (スロット 0 の部位や、限界突破の記載が無いページ)。
    """
    out = []
    for title, pg in pages.items():
        for m in re.finditer(r"\{\{GenericArmorSetPiece(.*?)\n\}\}", pg["wikitext"], flags=re.S):
            f = _template_fields(m.group(1))
            name = f.get("Piece Name")
            if not name:
                continue
            has_t = any(re.fullmatch(r"Transcend \d Deco", k) for k in f)
            out.append({"page": title, "revid": pg["revid"], "name": name,
                        "rarity": int(f["Rarity"]) if f.get("Rarity", "").isdigit() else None,
                        "slots": _slots_from(f, "Level {} Decos"),
                        "transcendSlots": _slots_from(f, "Transcend {} Deco") if has_t else None})
    return out


def _pat(s: list[int]) -> str:
    return "".join("ー①②③④"[x] for x in s)


def apply_limit_break(armor: list[dict], mhdb_en: list[dict], wiki_pages: dict,
                      upgrade_rows: list[dict], sp_cost_rows: list[dict]) -> dict:
    """armor.json の各要素に limitBreakable / slotsLimitBreak (と必要なら slotsLimitBreakNote) を足し、
    meta に入れる説明・照合結果を返す。"""
    levels = upgrade_levels(upgrade_rows, sp_cost_rows)
    lb_rarities = [r for r, v in levels.items() if v["limitBreakMaxLevel"]]
    for r in lb_rarities:
        if r not in RULE_ADD:
            raise ValueError(f"限界突破できるレア {r} の規則が無い (新しいレア度?)")

    en_by_id = {a["id"]: a for a in mhdb_en}
    pieces = parse_wiki_pieces(wiki_pages)
    by_name = collections.defaultdict(list)
    for p in pieces:
        by_name[p["name"]].append(p)

    checks = {"wikiPieces": len(pieces), "joined": 0, "notInWiki": [], "baseSlotMismatch": [],
              "compared": 0, "matched": 0, "mismatches": [], "noTranscendField": collections.Counter(),
              "byRarity": {}}
    by_rar = collections.defaultdict(lambda: {"compared": 0, "matched": 0, "patterns": collections.Counter()})
    examples: dict[tuple, dict] = {}
    for a in armor:
        rar = a["rarity"]
        if rar not in lb_rarities:
            a["limitBreakable"] = False
            a["slotsLimitBreak"] = None
            continue
        a["limitBreakable"] = True
        pred = apply_rule(a["slots"], rar)
        en = en_by_id.get(a["id"])
        if en is None:
            raise ValueError(f"MHDB /en/armor に id {a['id']} ({a['name']}) が無い")
        if (list(en["slots"]) + [0, 0, 0])[:3] != a["slots"]:
            raise ValueError(f"MHDB の /ja/ と /en/ でスロットが違う: {a['id']} {a['name']}")
        cands = by_name.get(en["name"], [])
        wiki = None
        if len(cands) == 1:
            checks["joined"] += 1
            wiki = cands[0]
            if wiki["slots"] != a["slots"]:
                checks["baseSlotMismatch"].append({"id": a["id"], "name": a["name"], "mhdb": a["slots"],
                                                  "wiki": wiki["slots"]})
                wiki = None
        else:
            checks["notInWiki"].append({"id": a["id"], "name": a["name"], "nameEn": en["name"],
                                        "wikiCandidates": len(cands)})
        note = None
        if wiki is not None and wiki["transcendSlots"] is not None:
            checks["compared"] += 1
            br = by_rar[rar]
            br["compared"] += 1
            if wiki["transcendSlots"] == pred:
                checks["matched"] += 1
                br["matched"] += 1
                br["patterns"][f"{_pat(a['slots'])}→{_pat(pred)}"] += 1
                key = (rar, tuple(a["slots"]))
                if key not in examples and a["id"] not in DISPUTED:
                    examples[key] = {"id": a["id"], "name": a["name"], "rarity": rar, "slots": a["slots"],
                                     "slotsLimitBreak": pred, "wikiPage": wiki["page"]}
            else:
                checks["mismatches"].append({"id": a["id"], "name": a["name"], "rarity": rar, "slots": a["slots"],
                                             "rule": pred, "wiki": wiki["transcendSlots"]})
                note = "wiki の限界突破後のスロットが規則と食い違う (規則の見直しが要る)"
        elif wiki is not None:
            checks["noTranscendField"][rar] += 1
        if a["id"] in DISPUTED:
            d = DISPUTED[a["id"]]
            if d["name"] != a["name"] or d["slots"] != a["slots"]:
                raise ValueError(f"DISPUTED の防具 {a['id']} の名前かスロットが変わった: {a['name']} {a['slots']}")
            if wiki is not None and wiki["transcendSlots"] not in (None, d["wiki"]):
                raise ValueError(f"DISPUTED の防具 {a['name']} の wiki の値が変わった: {wiki['transcendSlots']}")
            note = DISPUTED_NOTE
        if note:
            a["slotsLimitBreak"] = None
            a["slotsLimitBreakNote"] = note
        else:
            a["slotsLimitBreak"] = pred

    checks["noTranscendField"] = {str(k): v for k, v in sorted(checks["noTranscendField"].items())}
    checks["byRarity"] = {str(r): {"compared": v["compared"], "matched": v["matched"],
                                   "patterns": dict(sorted(v["patterns"].items()))}
                          for r, v in sorted(by_rar.items())}
    filled = sum(1 for a in armor if a.get("slotsLimitBreak") is not None)
    return {
        "rarities": lb_rarities,
        "levels": {str(r): v for r, v in levels.items()},
        "rule": RULE_TEXT,
        "ruleAdd": {str(k): v for k, v in RULE_ADD.items()},
        "cap": CAP,
        "confidence": "high",
        "confidenceNote": ("wiki (bot が書いた全部位) と規則が全件一致、Game8 の一覧とも 385 件中 383 件一致 "
                           "(残り 2 件は出典どうしの食い違い = disputed)。レア7・8 でスロットが変わらないことは"
                           "公式の告知 (「レア5・6の防具では装飾品スロットが強化」) とも合う"),
        "filled": filled,
        "disputed": [{"id": k, **v, "note": DISPUTED_NOTE} for k, v in sorted(DISPUTED.items())],
        "checks": {"wiki": checks, "game8": GAME8_CHECK},
        "examples": [examples[k] for k in sorted(examples)],
        "sources": [
            "https://monsterhunterwiki.org/ (MHWilds の防具シリーズのページ。CC BY-SA 4.0。照合に使用)",
            GAME8_LB_URL + " (照合のみ。取り込まない)",
            "https://www.gamespark.jp/article/2025/11/12/159406.html (TU4 の告知の紹介: レア5・6 はスロットも強化)",
            "MHWS-in-json ArmorUpgradeData / ArmorSpUpgradeCostData (限界突破できるレア度と強化上限 Lv)",
        ],
    }
