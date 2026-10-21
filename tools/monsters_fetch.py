"""モンスター担当の生データ取得 (tools/.cache/monsters/ に置く)。

取得したファイルは manifest.json に URL と取得時刻を記録する。
既にあるファイルは再取得しない (--refresh で取り直す)。build_monsters.py は
キャッシュだけを読むので、同じキャッシュからは何度実行しても同じ JSON になる。

取り込み元:
- wilds.mhdb.io /ja/monsters (大型モンスター・肉質・状態異常・報酬)
- GitHub LartTyler/mhdb-wilds-data (部位スラッグの日本語名・英語名つきモンスター一覧) ※コミット固定
- GitHub dzxrly/MHWS-in-json (MIT) の release PROCESSED_DATA (damage_calculator) と
  natives の生ファイル (EnemyData / Resident / ParamPack / Param_Parts / PartsLost) ※コミット固定
- monsterhunterwiki.org Bucket API (CC BY-SA 4.0) の monsters_games と quests、
  ページ「MHWilds/Quests/Arena Counter」のウィキテキスト (クエストの節分け)
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools" / ".cache" / "monsters"
MANIFEST = CACHE / "manifest.json"

USER_AGENT = "mhwilds-sns data builder (personal, non-commercial)"

# ---- 取り込み元 (固定) ----
MHDB_MONSTERS_URL = "https://wilds.mhdb.io/ja/monsters"

MHDB_DATA_SHA = "c50a1eb892f4a1ad9bb35c147801658804be2cc2"  # LartTyler/mhdb-wilds-data 2026-04-14
MHDB_DATA_RAW = f"https://raw.githubusercontent.com/LartTyler/mhdb-wilds-data/{MHDB_DATA_SHA}/output/merged/"

MHWS_TAG = "database-20261020-070700-4a99b26"
MHWS_SHA = "4a99b267930a0a83bcf45274733f169455c7b641"  # 上のタグのコミット (ゲーム版 1.42.0.2)
MHWS_PROCESSED_ZIP = "PROCESSED_DATA_20261020-070700-4a99b26.zip"
MHWS_PROCESSED_URL = f"https://github.com/dzxrly/MHWS-in-json/releases/download/{MHWS_TAG}/{MHWS_PROCESSED_ZIP}"
MHWS_RAW = f"https://raw.githubusercontent.com/dzxrly/MHWS-in-json/{MHWS_SHA}/MHWS-in-json/natives/STM/"

WIKI_API = "https://monsterhunterwiki.org/api.php"
WIKI_PAGE = 500  # Bucket API の 1 回の上限
WIKI_ARENA_COUNTER_URL = WIKI_API + "?" + urllib.parse.urlencode(
    {"action": "parse", "page": "MHWilds/Quests/Arena Counter", "prop": "wikitext", "format": "json"})

MG_FIELDS = ["page_name", "page_name_sub", "overview_page", "size_class", "elements",
             "status_effects", "weakest_to", "roar", "wind_pressure", "tremor"]
QUEST_FIELDS = ["page_name", "page_name_sub", "order", "name", "game", "location", "locale", "rank",
                "stars", "arena_info", "important", "time_period", "quest_type", "summary",
                "goal_icon_names", "goal_icon_types", "other_large_monsters", "other_small_monsters",
                "requirements", "time_limit", "failure_conditions", "notes", "client", "description"]


def _load_manifest() -> dict:
    if MANIFEST.exists():
        return json.loads(MANIFEST.read_text(encoding="utf-8"))
    return {"files": {}}


def _save_manifest(m: dict) -> None:
    MANIFEST.write_text(json.dumps(m, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()


def _http_get(url: str, retries: int = 3) -> bytes:
    """GET して本文を返す。失敗は握り潰さず、数回やり直してから例外にする。"""
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - 再試行してから投げ直す
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"取得失敗: {url}: {last}")


def _fetch(rel: str, url: str, manifest: dict, refresh: bool, *, binary: bool = False) -> Path:
    """url を CACHE/rel に保存する。既にあれば (refresh でない限り) そのまま使う。"""
    path = CACHE / rel
    if path.exists() and not refresh and rel in manifest["files"]:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    body = _http_get(url)
    if not binary:
        json.loads(body.decode("utf-8"))  # JSON として読めることを確かめる
    path.write_bytes(body)
    manifest["files"][rel] = {"url": url, "fetchedAt": _now()}
    _save_manifest(manifest)
    return path


def _wiki_query(q: str) -> list[dict]:
    url = WIKI_API + "?" + urllib.parse.urlencode({"action": "bucket", "format": "json", "query": q})
    d = json.loads(_http_get(url).decode("utf-8"))
    if "error" in d:
        raise RuntimeError(f"Bucket API エラー: {d['error']} ({q})")
    return d["bucket"]


def _sel(fields: list[str]) -> str:
    return ",".join(f"'{f}'" for f in fields)


def fetch_wiki_monsters_games(manifest: dict, refresh: bool) -> Path:
    """monsters_games を全件 (全作品) ページングで取り、(MHWilds) の行だけ保存する。

    Bucket API は LIKE が使えないので page_name 順に offset で全件めくる。
    """
    rel = "wiki_monsters_games_mhwilds.json"
    path = CACHE / rel
    if path.exists() and not refresh and rel in manifest["files"]:
        return path
    rows, offset, queries = [], 0, []
    while True:
        q = (f"bucket('monsters_games').select({_sel(MG_FIELDS)})"
             f".orderBy('page_name','asc').limit({WIKI_PAGE}).offset({offset}).run()")
        page = _wiki_query(q)
        queries.append(q)
        rows.extend(page)
        if len(page) < WIKI_PAGE:
            break
        offset += WIKI_PAGE
        time.sleep(1)
    wilds = [r for r in rows if re.search(r"\(MHWilds\)$", r.get("page_name", ""))]
    out = {"totalRowsScanned": len(rows), "pages": len(queries), "rows": wilds}
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    manifest["files"][rel] = {"url": WIKI_API, "queries": queries, "fetchedAt": _now()}
    _save_manifest(manifest)
    return path


def fetch_wiki_quests(manifest: dict, refresh: bool) -> Path:
    """quests を where game = MHWilds で全件 (ページング) 取る。"""
    rel = "wiki_quests_mhwilds.json"
    path = CACHE / rel
    if path.exists() and not refresh and rel in manifest["files"]:
        return path
    rows, offset, queries = [], 0, []
    while True:
        q = (f"bucket('quests').select({_sel(QUEST_FIELDS)}).where('game','MHWilds')"
             f".orderBy('page_name','asc').limit({WIKI_PAGE}).offset({offset}).run()")
        page = _wiki_query(q)
        queries.append(q)
        rows.extend(page)
        if len(page) < WIKI_PAGE:
            break
        offset += WIKI_PAGE
        time.sleep(1)
    out = {"pages": len(queries), "rows": rows}
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    manifest["files"][rel] = {"url": WIKI_API, "queries": queries, "fetchedAt": _now()}
    _save_manifest(manifest)
    return path


def fetch_processed_zip(manifest: dict, refresh: bool) -> Path:
    """MHWS-in-json の PROCESSED_DATA zip から damage_calculator.zh-Hans.json を取り出す。"""
    rel = "processed/damage_calculator.zh-Hans.json"
    out = CACHE / rel
    if out.exists() and not refresh and rel in manifest["files"]:
        return out
    zpath = CACHE / MHWS_PROCESSED_ZIP
    if not zpath.exists() or refresh:
        try:
            zpath.write_bytes(_http_get(MHWS_PROCESSED_URL))
        except RuntimeError:
            # urllib で落ちたときは gh で取る (どちらも同じ release の同じファイル)
            subprocess.run(["gh", "release", "download", MHWS_TAG, "-R", "dzxrly/MHWS-in-json",
                            "-p", MHWS_PROCESSED_ZIP, "-D", str(CACHE), "--clobber"], check=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zpath) as z:
        out.write_bytes(z.read("damage_calculator.zh-Hans.json"))
    manifest["files"][rel] = {"url": MHWS_PROCESSED_URL, "member": "damage_calculator.zh-Hans.json",
                              "fetchedAt": _now()}
    _save_manifest(manifest)
    return out


def em_dirs(em_id: str) -> tuple[str, str]:
    """'EM0160_50_0' → ('Em0160', '50')"""
    m = re.fullmatch(r"EM(\d{4})_(\d{2})_\d", em_id)
    if not m:
        raise ValueError(f"EM ID の形が想定外: {em_id}")
    return f"Em{m.group(1)}", m.group(2)


def _ref_path(doc: list, key: str) -> str | None:
    """RE Engine の user.3.json から、キー key の参照先パス ("GameDesign/...user") を探す。"""
    found = []

    def walk(x):
        if isinstance(x, dict):
            for k, v in x.items():
                if k == key and isinstance(v, dict):
                    for inner in v.values():
                        if isinstance(inner, dict) and "path" in inner:
                            found.append(inner["path"])
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
    walk(doc)
    return found[0] if found else None


def fetch_natives(em_ids: list[str], manifest: dict, refresh: bool) -> dict:
    """EM ID ごとに Resident → Param_Parts、ParamPack → PartsLost をたどって取る。

    戻り値: {em_id: {"parts": rel, "partsLost": rel|None, "partsPath": "GameDesign/...", ...}}
    """
    result = {}
    for em in em_ids:
        d1, d2 = em_dirs(em)
        base = f"{d1}_{d2}"  # 'EM0160_50_0' → 'Em0160_50'
        res_rel = f"natives/Enemy/Resident/{base}_0_Resident.user.3.json"
        res = _fetch(res_rel, MHWS_RAW + f"GameDesign/Enemy/Resident/{base}_0_Resident.user.3.json",
                     manifest, refresh)
        parts_path = _ref_path(json.loads(res.read_text(encoding="utf-8")), "_Parts")
        if not parts_path:
            raise RuntimeError(f"{em}: Resident に _Parts の参照が無い")
        parts_rel = "natives/" + parts_path.replace("GameDesign/", "") + ".3.json"
        _fetch(parts_rel, MHWS_RAW + parts_path + ".3.json", manifest, refresh)
        pack_rel = f"natives/Enemy/{d1}/{d2}/Data/{base}_ParamPack.user.3.json"
        pack = _fetch(pack_rel, MHWS_RAW + f"GameDesign/Enemy/{d1}/{d2}/Data/{base}_ParamPack.user.3.json",
                      manifest, refresh)
        lost_path = _ref_path(json.loads(pack.read_text(encoding="utf-8")), "_PartsLost")
        lost_rel = None
        if lost_path:
            lost_rel = "natives/" + lost_path.replace("GameDesign/", "") + ".3.json"
            _fetch(lost_rel, MHWS_RAW + lost_path + ".3.json", manifest, refresh)
        # 歴戦の個体/歴戦王の倍率 (EmParamLegendary)
        leg_path = _ref_path(json.loads(pack.read_text(encoding="utf-8")), "_Legendary")
        leg_rel = None
        if leg_path:
            leg_rel = "natives/" + leg_path.replace("GameDesign/", "") + ".3.json"
            _fetch(leg_rel, MHWS_RAW + leg_path + ".3.json", manifest, refresh)
        result[em] = {"resident": res_rel, "partsPath": parts_path, "parts": parts_rel,
                      "paramPack": pack_rel, "partsLostPath": lost_path, "partsLost": lost_rel,
                      "legendaryPath": leg_path, "legendary": leg_rel}
    (CACHE / "natives_index.json").write_text(json.dumps(result, ensure_ascii=False, indent=1, sort_keys=True),
                                              encoding="utf-8")
    return result


def fetch_database_xlsx(lang: str, member: str, manifest: dict, refresh: bool) -> Path:
    """MHWS-in-json の DATABASE_<lang> zip から member (例 MissionData.xlsx) を取り出す。"""
    rel = f"db_{lang}/{member}"
    out = CACHE / rel
    if out.exists() and not refresh and rel in manifest["files"]:
        return out
    zname = f"DATABASE_{lang}_{MHWS_TAG.split('-', 1)[1]}.zip"
    url = f"https://github.com/dzxrly/MHWS-in-json/releases/download/{MHWS_TAG}/{zname}"
    zpath = CACHE / zname
    if not zpath.exists() or refresh:
        try:
            zpath.write_bytes(_http_get(url))
        except RuntimeError:
            subprocess.run(["gh", "release", "download", MHWS_TAG, "-R", "dzxrly/MHWS-in-json",
                            "-p", zname, "-D", str(CACHE), "--clobber"], check=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zpath) as z:
        out.write_bytes(z.read(member))
    manifest["files"][rel] = {"url": url, "member": member, "fetchedAt": _now()}
    _save_manifest(manifest)
    return out


def fetch_all(refresh: bool = False) -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    manifest = _load_manifest()
    _fetch("mhdb_monsters_ja.json", MHDB_MONSTERS_URL, manifest, refresh)
    # 防御スキルの規則 (rules) で skillId を引くため
    _fetch("mhdb_skills_ja.json", "https://wilds.mhdb.io/ja/skills", manifest, refresh)
    _fetch("mhdb_skills_en.json", "https://wilds.mhdb.io/en/skills", manifest, refresh)
    # クエストの日本語名・体力倍率 (MissionData) は日英の DATABASE から
    fetch_database_xlsx("ja-JP", "MissionData.xlsx", manifest, refresh)
    fetch_database_xlsx("en-US", "MissionData.xlsx", manifest, refresh)
    _fetch("mhdbdata_PartNames.json", MHDB_DATA_RAW + "PartNames.json", manifest, refresh)
    _fetch("mhdbdata_LargeMonsters.json", MHDB_DATA_RAW + "LargeMonsters.json", manifest, refresh)
    fetch_processed_zip(manifest, refresh)
    enemy = _fetch("natives/Common/Enemy/EnemyData.user.3.json",
                   MHWS_RAW + "GameDesign/Common/Enemy/EnemyData.user.3.json", manifest, refresh)
    # MHDB の gameId → EM ID は EnemyData の _enemyId ("[26] EM0001_00_0") で引く
    gid2em = enemy_id_map(enemy)
    mh = json.loads((CACHE / "mhdb_monsters_ja.json").read_text(encoding="utf-8"))
    ems = sorted({gid2em[m["gameId"]] for m in mh if m.get("kind") == "large"})
    fetch_natives(ems, manifest, refresh)
    fetch_wiki_monsters_games(manifest, refresh)
    fetch_wiki_quests(manifest, refresh)
    # Arena Counter のページ (クエストの節分け: Arena / Challenge / Free Challenge)。フリーチャレンジの装備の判定に使う
    _fetch("wiki_arena_counter.json", WIKI_ARENA_COUNTER_URL, manifest, refresh)


def enemy_id_map(path: Path) -> dict[int, str]:
    """EnemyData.user.3.json から {固定ID(int): 'EM0001_00_0'}。"""
    text = path.read_text(encoding="utf-8")
    out = {}
    for num, em in re.findall(r'"_enemyId":\s*"\[(-?\d+)\]\s*(EM\d{4}_\d{2}_\d)"', text):
        out[int(num)] = em
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--refresh", action="store_true", help="キャッシュを無視して取り直す")
    a = ap.parse_args()
    fetch_all(refresh=a.refresh)
    print("取得完了:", CACHE)
