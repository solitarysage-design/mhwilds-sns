"""装備担当 (equip) の生データ取得。保存先は tools/.cache/equip/ (git 管理外)。

取得したファイルは manifest.json に URL・取得時刻・sha256 を記録する。
既にあるファイルは再取得しない (--refresh で取り直す)。build_equip.py はキャッシュだけを
読むので、同じキャッシュからは何度実行しても同じ JSON になる。

取り込み元:
- wilds.mhdb.io /ja/ (armor, armor/sets, skills, decorations, weapons[片手剣], charms)
  と /en/armor (wiki と防具名で突き合わせるための英語名。id は /ja/ と同じ)
- GitHub dzxrly/MHWS-in-json (MIT) ※コミット固定
  - natives の生ファイル: SkillCommonData / RandomAmulet* (鑑定護石の抽選表) /
    ArmorData / AccessoryData / ShortSword / ArmorUpgradeData・ArmorSpUpgradeCostData (限界突破できるレア度)
  - release の PROCESSED_DATA (amulet_pool.json / skill_pool.json) と DATABASE_ja-JP (照合用の xlsx)
- monsterhunterwiki.org (CC BY-SA 4.0) の Wilds の防具シリーズのページ (限界突破後のスロットの照合用)。
  Bucket API の armor でページ名を集め、ページのウィキテキストを 50 件ずつ取る。
"""
from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools" / ".cache" / "equip"
MANIFEST = CACHE / "manifest.json"

USER_AGENT = "mhwilds-sns data builder (personal, non-commercial)"

# ---- 取り込み元 (固定) ----
MHDB_BASE = "https://wilds.mhdb.io/ja/"
MHDB_ENDPOINTS = {
    # キャッシュ上の名前: (パス, q フィルタ)
    "mhdb/armor.json": ("armor", None),
    "mhdb/armor_sets.json": ("armor/sets", None),
    "mhdb/skills.json": ("skills", None),
    "mhdb/decorations.json": ("decorations", None),
    "mhdb/weapons_sword-shield.json": ("weapons", {"kind": "sword-shield"}),
    "mhdb/charms.json": ("charms", None),
}
# 英語版 (wiki の英語の防具名と突き合わせる用。id は /ja/ と共通)
MHDB_EN_BASE = "https://wilds.mhdb.io/en/"
MHDB_EN_ENDPOINTS = {
    "mhdb/armor_en.json": ("armor", None),
}

# monsterhunterwiki.org (CC BY-SA 4.0)。限界突破 (Transcend) 後のスロットの照合に使う
WIKI_API = "https://monsterhunterwiki.org/api.php"
WIKI_BUCKET_PAGE = 500   # Bucket API の 1 回の上限
WIKI_TITLES_PER_QUERY = 50  # revisions で本文を取るときの 1 回の上限
WIKI_ARMOR_FIELDS = ["page_name", "name", "rarity"]
WIKI_ARMOR_BUCKET = "wiki/armor_bucket_mhwilds.json"
WIKI_ARMOR_PAGES = "wiki/armor_set_pages_mhwilds.json"

MHWS_REPO = "dzxrly/MHWS-in-json"
MHWS_TAG = "database-20261020-070700-4a99b26"
MHWS_SHA = "4a99b267930a0a83bcf45274733f169455c7b641"  # 上のタグのコミット (ゲーム版 1.42.0.2)
MHWS_RAW = f"https://raw.githubusercontent.com/{MHWS_REPO}/{MHWS_SHA}/MHWS-in-json/natives/STM/GameDesign/"
MHWS_RAW_FILES = {
    "mhws/raw/SkillCommonData.user.3.json": "Common/Equip/SkillCommonData.user.3.json",
    "mhws/raw/RandomAmuletLotSkillTable.user.3.json": "Common/Equip/RandomAmuletLotSkillTable.user.3.json",
    "mhws/raw/RandomAmuletPtTable.user.3.json": "Common/Equip/RandomAmuletPtTable.user.3.json",
    "mhws/raw/RandomAmuletAccSlot.user.3.json": "Common/Equip/RandomAmuletAccSlot.user.3.json",
    "mhws/raw/ArmorData.user.3.json": "Common/Equip/ArmorData.user.3.json",
    "mhws/raw/AccessoryData.user.3.json": "Common/Equip/AccessoryData.user.3.json",
    "mhws/raw/ShortSword.user.3.json": "Common/Weapon/ShortSword.user.3.json",
    # 防具の強化段階。_IsSpecialUpgrade=true の行が限界突破 (TU4) で、対象のレア度がわかる
    "mhws/raw/ArmorUpgradeData.user.3.json": "Common/Equip/ArmorUpgradeData.user.3.json",
    "mhws/raw/ArmorSpUpgradeCostData.user.3.json": "Common/Equip/ArmorSpUpgradeCostData.user.3.json",
}
MHWS_RELEASE = f"https://github.com/{MHWS_REPO}/releases/download/{MHWS_TAG}/"
MHWS_PROCESSED_ZIP = "PROCESSED_DATA_20261020-070700-4a99b26.zip"
MHWS_DATABASE_ZIP = "DATABASE_ja-JP_20261020-070700-4a99b26.zip"
# zip から取り出すもの: キャッシュ上の名前 -> (zip 名, zip 内の名前)
MHWS_ZIP_MEMBERS = {
    "mhws/processed/amulet_pool.json": (MHWS_PROCESSED_ZIP, "amulet_pool.json"),
    "mhws/processed/skill_pool.json": (MHWS_PROCESSED_ZIP, "skill_pool.json"),
    "mhws/db/EquipCollection.xlsx": (MHWS_DATABASE_ZIP, "EquipCollection.xlsx"),
    "mhws/db/SkillCollection.xlsx": (MHWS_DATABASE_ZIP, "SkillCollection.xlsx"),
    "mhws/db/AmuletCollection.xlsx": (MHWS_DATABASE_ZIP, "AmuletCollection.xlsx"),
}


def load_manifest() -> dict:
    if MANIFEST.exists():
        return json.loads(MANIFEST.read_text(encoding="utf-8"))
    return {"files": {}}


def _save_manifest(m: dict) -> None:
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(m, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()


def _http_get(url: str, retries: int = 3) -> bytes:
    """GET して本文を返す。失敗は握り潰さず、数回やり直してから例外にする。"""
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=300) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - 再試行してから投げ直す
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"取得失敗: {url}: {last}")


def _record(manifest: dict, rel: str, url: str, body: bytes, **extra) -> None:
    manifest["files"][rel] = {"url": url, "fetchedAt": _now(),
                              "sha256": hashlib.sha256(body).hexdigest(), **extra}
    _save_manifest(manifest)


def mhdb_url(path: str, q: dict | None, base: str = MHDB_BASE) -> str:
    url = base + path
    if q:
        url += "?" + urllib.parse.urlencode({"q": json.dumps(q, ensure_ascii=False, separators=(",", ":"))})
    return url


def _fetch_json(rel: str, url: str, manifest: dict, refresh: bool) -> None:
    path = CACHE / rel
    if path.exists() and not refresh and rel in manifest["files"]:
        return
    body = _http_get(url)
    json.loads(body.decode("utf-8"))  # JSON として読めることを確かめる
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    _record(manifest, rel, url, body)


def _ensure_zip(name: str, refresh: bool) -> Path:
    zpath = CACHE / "mhws" / name
    if zpath.exists() and not refresh:
        return zpath
    zpath.parent.mkdir(parents=True, exist_ok=True)
    try:
        zpath.write_bytes(_http_get(MHWS_RELEASE + name))
    except RuntimeError:
        # urllib で落ちたときは gh で取る (どちらも同じ release の同じファイル)
        subprocess.run(["gh", "release", "download", MHWS_TAG, "-R", MHWS_REPO, "-p", name,
                        "-D", str(zpath.parent), "--clobber"], check=True)
    return zpath


def _wiki_get(params: dict) -> dict:
    url = WIKI_API + "?" + urllib.parse.urlencode({**params, "format": "json"})
    d = json.loads(_http_get(url).decode("utf-8"))
    if "error" in d:
        raise RuntimeError(f"wiki API エラー: {d['error']} ({params})")
    return d


def fetch_wiki_armor(manifest: dict, refresh: bool) -> None:
    """wiki の Wilds の防具 (Bucket armor) と、その防具シリーズのページのウィキテキストを取る。

    Bucket の armor には限界突破後のスロットの欄 (transcend_decos*) があるが Wilds では空なので、
    ページ本文の {{GenericArmorSetPiece}} の「Transcend N Deco」を読む (equip_limitbreak.py)。
    """
    bpath = CACHE / WIKI_ARMOR_BUCKET
    if refresh or not bpath.exists() or WIKI_ARMOR_BUCKET not in manifest["files"]:
        rows, offset, queries = [], 0, []
        sel = ",".join(f"'{f}'" for f in WIKI_ARMOR_FIELDS)
        while True:
            q = (f"bucket('armor').select({sel}).where('game','MHWilds')"
                 f".orderBy('page_name','asc').limit({WIKI_BUCKET_PAGE}).offset({offset}).run()")
            page = _wiki_get({"action": "bucket", "query": q})["bucket"]
            queries.append(q)
            rows.extend(page)
            if len(page) < WIKI_BUCKET_PAGE:
                break
            offset += WIKI_BUCKET_PAGE
            time.sleep(1)
        body = json.dumps({"rows": rows}, ensure_ascii=False, indent=1).encode("utf-8")
        bpath.parent.mkdir(parents=True, exist_ok=True)
        bpath.write_bytes(body)
        _record(manifest, WIKI_ARMOR_BUCKET, WIKI_API, body, queries=queries)
    ppath = CACHE / WIKI_ARMOR_PAGES
    if refresh or not ppath.exists() or WIKI_ARMOR_PAGES not in manifest["files"]:
        rows = json.loads(bpath.read_text(encoding="utf-8"))["rows"]
        titles = sorted({r["page_name"] for r in rows})
        pages = {}
        for i in range(0, len(titles), WIKI_TITLES_PER_QUERY):
            chunk = titles[i:i + WIKI_TITLES_PER_QUERY]
            d = _wiki_get({"action": "query", "prop": "revisions", "titles": "|".join(chunk),
                           "rvprop": "content|ids|timestamp", "rvslots": "main"})
            for p in d["query"]["pages"].values():
                if "revisions" not in p:
                    raise RuntimeError(f"wiki のページが取れない: {p.get('title')}")
                rv = p["revisions"][0]
                pages[p["title"]] = {"revid": rv["revid"], "timestamp": rv["timestamp"],
                                     "wikitext": rv["slots"]["main"]["*"]}
            time.sleep(1)
        missing = [t for t in titles if t not in pages]
        if missing:
            raise RuntimeError(f"wiki のページが足りない: {missing}")
        body = json.dumps({"pages": dict(sorted(pages.items()))}, ensure_ascii=False, indent=1).encode("utf-8")
        ppath.write_bytes(body)
        _record(manifest, WIKI_ARMOR_PAGES, WIKI_API, body, titles=len(titles))


def fetch_all(refresh: bool = False) -> dict:
    manifest = load_manifest()
    for rel, (path, q) in MHDB_ENDPOINTS.items():
        _fetch_json(rel, mhdb_url(path, q), manifest, refresh)
    for rel, (path, q) in MHDB_EN_ENDPOINTS.items():
        _fetch_json(rel, mhdb_url(path, q, MHDB_EN_BASE), manifest, refresh)
    for rel, sub in MHWS_RAW_FILES.items():
        _fetch_json(rel, MHWS_RAW + sub, manifest, refresh)
    for rel, (zname, member) in MHWS_ZIP_MEMBERS.items():
        out = CACHE / rel
        if out.exists() and not refresh and rel in manifest["files"]:
            continue
        zpath = _ensure_zip(zname, refresh)
        with zipfile.ZipFile(zpath) as z:
            # zip 内のフォルダ構成に依らず、末尾の名前で探す
            names = [n for n in z.namelist() if n.split("/")[-1] == member]
            if len(names) != 1:
                raise RuntimeError(f"{zname} に {member} が 1 つだけ無い: {names}")
            body = z.read(names[0])
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(body)
        _record(manifest, rel, MHWS_RELEASE + zname, body, member=names[0])
    fetch_wiki_armor(manifest, refresh)
    return manifest


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--refresh", action="store_true", help="キャッシュがあっても取り直す")
    args = ap.parse_args(argv)
    m = fetch_all(args.refresh)
    for rel in sorted(m["files"]):
        print(rel, m["files"][rel]["fetchedAt"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
