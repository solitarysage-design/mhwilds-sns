"""sw.js の VERSION を、PRECACHE に載っているファイルの中身から作り直す。

Service Worker はキャッシュを優先するので、app/・data/・index.html などを変えても VERSION を上げないと、
ホーム画面のアプリには届かない。VERSION を人の手で上げる代わりに、このスクリプトを実行する:

    PYTHONIOENCODING=utf-8 python tools/sw_version.py          # 中身が変わっていれば VERSION を書き換える
    PYTHONIOENCODING=utf-8 python tools/sw_version.py --check  # 合っているかだけ見る (合っていなければ終了コード 1)

VERSION の形は "<日付>-<中身のハッシュ 10 文字>" (例 "2026-10-21-3f9a0c12de")。
ハッシュの部分が今のファイルと同じなら書き換えない (日付も変えない)。
tests/smoke_ui.py は、ハッシュの部分がファイルの中身と合っていないと失敗にする。
"""
from __future__ import annotations

import argparse
import hashlib
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SW = ROOT / "sw.js"
TEXT_SUFFIXES = {".js", ".css", ".html", ".json", ".webmanifest", ".txt", ".md"}


def precache_paths(sw_text: str) -> list[str]:
    """sw.js の PRECACHE に載っているファイル (リポのルートからの相対パス。'./' は index.html と同じなので除く)。"""
    m = re.search(r"const PRECACHE = \[(.*?)\];", sw_text, re.S)
    if not m:
        raise ValueError("sw.js に PRECACHE が見つかりません")
    paths = [p for p in re.findall(r"'\./([^']*)'", m.group(1)) if p]
    return sorted(set(paths))


def content_hash(root: Path = ROOT) -> str:
    """PRECACHE のファイルの中身のハッシュ (16 進 10 文字)。文字のファイルは改行を LF にそろえてから数える。"""
    sw_text = (root / "sw.js").read_text(encoding="utf-8")
    h = hashlib.sha256()
    for rel in precache_paths(sw_text):
        f = root / rel
        data = f.read_bytes() if f.exists() else b"(missing)"
        if f.suffix in TEXT_SUFFIXES:
            data = data.replace(b"\r\n", b"\n")
        h.update(rel.encode("utf-8") + b"\0" + data + b"\0")
    return h.hexdigest()[:10]


def read_version(sw_text: str) -> str | None:
    m = re.search(r"const VERSION = '([^']*)'", sw_text)
    return m.group(1) if m else None


def version_matches(version: str | None, digest: str) -> bool:
    return bool(version) and version.endswith(f"-{digest}")


def main() -> int:
    ap = argparse.ArgumentParser(description="sw.js の VERSION を中身から作り直す")
    ap.add_argument("--check", action="store_true", help="合っているかだけ見る")
    args = ap.parse_args()
    text = SW.read_text(encoding="utf-8")
    current = read_version(text)
    digest = content_hash()
    if version_matches(current, digest):
        print(f"sw.js の VERSION はファイルの中身と合っています: {current}")
        return 0
    if args.check:
        print(f"sw.js の VERSION ({current}) がファイルの中身 ({digest}) と合っていません。"
              "python tools/sw_version.py を実行してください")
        return 1
    new = f"{date.today().isoformat()}-{digest}"
    text = re.sub(r"const VERSION = '[^']*'", f"const VERSION = '{new}'", text, count=1)
    SW.write_text(text, encoding="utf-8", newline="\n")
    print(f"sw.js の VERSION を上げました: {current} → {new}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
