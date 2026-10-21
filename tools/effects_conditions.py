"""条件つきスキルの「条件グループ」(skill_effects.json の rules.conditionGroups) を定義する。

発動率はスキルごとではなく条件ごとに持つ。同じ意味の条件 (例: モンスターが怒っている) で動くスキルは
1 つのグループにまとめ、画面では 1 つの発動率を入れれば全部に効くようにする。

グループの形:
    id            発動率の入力キー (damage.js の uptimes のキー)
    label         画面に出す名前 (やさしい日本語)
    type          binary (発動している/していない) / categorical (段階がある)
    states        categorical のときの段階 [{id, label}]。offState が「発動していない」段
    offState      categorical の「発動していない」段の id
    defaultUptime binary は数 (0〜1)、categorical は {段の id: 割合} (残りが offState)
    placeholder   True = 既定の発動率に根拠が無い (仮置き)。画面で人が入れる前提
    uptimeBasis   既定の発動率の根拠 (仮置きならそう書く)
    exclusiveWith 同時に起きない条件のグループ id (体力満タン と 赤ゲージあり など)。
                  全パターンの加重平均で「両方発動」に重みを付けない
    sources       (あるものだけ) その条件が起きるもとになるもの {skillIds, monsterStatus, label, inactiveText}。
                  どのスキルも装備しておらず、相手もその状態異常を使わないときは「発動していない」100% で計算する
                  (damage.js の resolveConditions。相手の状態異常は画面が input.monsterStatus で渡す)
    note          補足
"""
from __future__ import annotations

PLACEHOLDER = "仮置き (根拠なし。人が発動率を入れる前提)"


def _bin(gid: str, label: str, *, uptime: float = 0.5, basis: str = PLACEHOLDER, placeholder: bool = True,
         exclusive: tuple[str, ...] = (), note: str = "") -> dict:
    return {"id": gid, "label": label, "type": "binary", "defaultUptime": uptime,
            "placeholder": placeholder, "uptimeBasis": basis, "exclusiveWith": list(exclusive), "note": note}


def _cat(gid: str, label: str, states: list[tuple[str, str]], *, uptime: dict, basis: str = PLACEHOLDER,
         placeholder: bool = True, note: str = "", sources: dict | None = None) -> dict:
    g = {"id": gid, "label": label, "type": "categorical",
         "states": [{"id": s, "label": lab} for s, lab in states], "offState": states[0][0],
         "defaultUptime": uptime, "placeholder": placeholder, "uptimeBasis": basis,
         "exclusiveWith": [], "note": note}
    if sources:
        g["sources"] = sources
    return g


# 並び順は画面に出す順。体力まわりは先頭 (同時に起きない条件の計算はこの順で条件づける)。
CONDITION_GROUPS: list[dict] = [
    _bin("hpFull", "体力が満タン", exclusive=("redHp", "hpLow"),
         note="体力が満タンのときは赤ゲージも体力 35% 以下も起きないので、同時には発動しない扱い。"),
    _bin("redHp", "体力ゲージに赤い部分がある", exclusive=("hpFull",)),
    _bin("hpLow", "体力が 35% 以下", exclusive=("hpFull",),
         note="赤ゲージありとは同時に起きてよい (体力が満タンでないときだけ起きる)。"),
    _bin("enraged", "モンスターが怒っている"),
    _cat("chain", "連撃の段階", [("none", "未発動"), ("hit1to4", "1〜4 ヒット段"), ("hit5plus", "5 ヒット以降段")],
         uptime={"hit1to4": 0.5, "hit5plus": 0.5},
         note="既定の値 (各 50%) は仮置きで、攻撃を当て続けている前提です。当てていない時間があるなら、その分を未発動に回してください。"),
    _cat("frenzy", "狂竜症", [("none", "かかっていない"), ("infected", "感染中"), ("overcome", "克服した後")],
         uptime={"infected": 0.5, "overcome": 0.5},
         sources={"skillIds": [106], "monsterStatus": ["frenzy"],
                  "label": "黒蝕竜の力か、狂竜症を使う相手 (ゴア・マガラ・狂竜化した個体)",
                  "inactiveText": "黒蝕竜の力を装備しておらず、相手も狂竜症を使わない (ゴア・マガラや狂竜化した個体ではない) ので、"
                                  "狂竜症にはかからない (0%) として計算しています。"},
         note="黒蝕竜の力は感染中と克服後で効果が違う。無我の境地は克服後だけ。"
              "黒蝕竜の力も狂竜症を使う相手もいないときは、かかっていない (0%) として計算する。"),
    _bin("latentPower", "力の解放が発動中"),
    _bin("staminaFull", "スタミナ満タンをしばらく保っている"),
    _bin("afterDraw", "武器を出した直後"),
    _bin("justGuard", "ジャストガードの後"),
    _bin("afterKnockback", "ふきとばされた後"),
    _bin("monsterPoisonPara", "モンスターが毒か麻痺"),
    _bin("afterAilmentCure", "状態異常・属性やられを治した後"),
    _bin("afterDodge", "回避でモンスターの攻撃をかわした後"),
    _bin("afterDodgeRepeat", "巧撃の発動中にもう一度かわした後",
         note="「回避でかわした後」の中の一部。別の条件として入れる (本当は回避の後より短い)。"),
    _bin("afterAmbush", "奇襲攻撃が成功した後"),
    _bin("afterSlide", "坂をすべった後"),
    _bin("hunterAilment", "自分が状態異常"),
    _bin("afterClash", "鍔迫り合い・相殺の後"),
    _bin("afterBindOrClash", "拘束・凍結から回復した後、または鍔迫り合いの後"),
    _bin("afterMeal", "こんがり肉などを食べた後"),
    _bin("wet", "水に濡れている"),
    _bin("afterDischarge", "追加の雷ダメージが出た後"),
    _bin("beforeGuts", "根性【果敢】がまだ発動していない", uptime=1.0, placeholder=False,
         basis="根性が発動するまでは常に有効。発動後は攻撃上昇が消えるので、被弾が多い人は下げる"),
    _bin("festival", "季節の儀式の期間中", uptime=1.0, placeholder=False,
         basis="儀式 (イベント) の期間中のみ。期間外は 0 にする"),
]

GROUPS_BY_ID: dict[str, dict] = {g["id"]: g for g in CONDITION_GROUPS}


def states_of(group: dict) -> list[str]:
    """グループの段の id (binary は off/on)。"""
    if group["type"] == "binary":
        return ["off", "on"]
    return [s["id"] for s in group["states"]]


def off_state(group: dict) -> str:
    return "off" if group["type"] == "binary" else group["offState"]


def default_active_states(group: dict) -> list[str]:
    """activeStates を書かないときに主効果が出る段 (binary は on、categorical は未発動以外の全部)。"""
    off = off_state(group)
    return [s for s in states_of(group) if s != off]


def main_uptime(group_id: str, active_states: list[str] | None) -> float:
    """そのスキルの主効果 (levels[] の値) が出る割合の既定値。skill_effects の defaultUptime に入れる。"""
    g = GROUPS_BY_ID[group_id]
    if g["type"] == "binary":
        return float(g["defaultUptime"])
    act = active_states or default_active_states(g)
    return round(sum(float(g["defaultUptime"].get(s, 0)) for s in act), 6)


def validate(effects: dict[str, dict]) -> list[str]:
    """条件グループとスキルの対応を確かめる。食い違いはエラーとして返す (呼び側で止める)。"""
    errors: list[str] = []
    for g in CONDITION_GROUPS:
        for o in g["exclusiveWith"]:
            if o not in GROUPS_BY_ID:
                errors.append(f"条件グループ {g['id']} の exclusiveWith {o} が無い")
            elif g["id"] not in GROUPS_BY_ID[o]["exclusiveWith"]:
                errors.append(f"条件グループ {g['id']} と {o} の exclusiveWith が片側だけ")
        if g["type"] == "categorical":
            ids = states_of(g)
            total = 0.0
            for s, p in g["defaultUptime"].items():
                if s not in ids or s == off_state(g):
                    errors.append(f"条件グループ {g['id']} の defaultUptime に知らない段 {s}")
                total += float(p)
            if total > 1 + 1e-9:
                errors.append(f"条件グループ {g['id']} の defaultUptime の合計が 1 を超える ({total})")
    used: set[str] = set()
    for sid, e in effects.items():
        gid = e.get("conditionGroup")
        if e.get("conditional") and e.get("supported", True) and gid is None:
            errors.append(f"{e['name']} (id {sid}) は条件つきなのに conditionGroup が無い")
        if gid is None:
            continue
        g = GROUPS_BY_ID.get(gid)
        if g is None:
            errors.append(f"{e['name']} の conditionGroup {gid} が定義に無い")
            continue
        used.add(gid)
        ids = states_of(g)
        for s in e.get("activeStates") or []:
            if s not in ids:
                errors.append(f"{e['name']} の activeStates {s} は {gid} の段に無い")
        for lv in e.get("levels", []):
            for s in (lv.get("byState") or {}):
                if s not in ids:
                    errors.append(f"{e['name']} Lv{lv['level']} の byState {s} は {gid} の段に無い")
    for g in CONDITION_GROUPS:
        if g["id"] not in used:
            errors.append(f"条件グループ {g['id']} を使うスキルが無い")
        for sid in (g.get("sources") or {}).get("skillIds", []):
            e = effects.get(str(sid))
            if e is None or e.get("conditionGroup") != g["id"]:
                errors.append(f"条件グループ {g['id']} の sources のスキル {sid} がこのグループのスキルに無い")
    return errors


def groups_with_skills(effects: dict[str, dict]) -> list[dict]:
    """rules.conditionGroups に出す形 (各グループに、そこで動くスキルの一覧を付ける)。"""
    out = []
    for g in CONDITION_GROUPS:
        skills = [{"skillId": int(sid), "name": e["name"]}
                  for sid, e in effects.items() if e.get("conditionGroup") == g["id"]]
        out.append({**g, "skills": skills})
    return out
