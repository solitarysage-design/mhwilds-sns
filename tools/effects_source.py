"""火力データ生成 (担当: damage) の入力取得と読み込み。

生データは tools/.cache/damage/ に置く (git 管理外)。無ければ取りに行き、あれば使い回す。
取得元は GitHub dzxrly/MHWS-in-json (MIT) のタグ固定スナップショットと wilds.mhdb.io。
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools" / ".cache" / "damage"

# MHWS-in-json のリリースタグ (ゲーム版 1.42.0.2)。タグで固定して再現性を保つ。
MHWS_TAG = "database-20261020-070700-4a99b26"
MHWS_REPO = "dzxrly/MHWS-in-json"
MHWS_RAW = f"https://raw.githubusercontent.com/{MHWS_REPO}/{MHWS_TAG}/MHWS-in-json/natives/STM/GameDesign"
MHWS_DB_JA_ZIP = f"DATABASE_ja-JP_{MHWS_TAG.split('database-', 1)[1]}.zip"
MHWS_DB_JA_URL = f"https://github.com/{MHWS_REPO}/releases/download/{MHWS_TAG}/{MHWS_DB_JA_ZIP}"
MHDB_SKILLS_URL = "https://wilds.mhdb.io/ja/skills"

GAME_BUILD = "1.42.0.2"
GAME_VERSION = "1.042"

# 使う生ファイル (GameDesign 以下の相対パス)
RAW_FILES = {
    "SkillCommonData": "Common/Equip/SkillCommonData.user.3.json",
    "SkillData": "Common/Equip/SkillData.user.3.json",
    "PlayerSkillParam": "Player/ActionData/Common/GlobalParam/Part/PlayerSkillParam.user.3.json",
    "PlayerStatusParam": "Player/ActionData/Common/GlobalParam/Part/PlayerStatusParam.user.3.json",
    "EmCommonData": "Enemy/CommonData/Data/EmCommonData.user.3.json",
    "Wp01_Attack": "Player/ActionData/Wp01/Collision/Collider/Wp01_Attack.rcol.38.json",
    "Wp01_SubAttack": "Player/ActionData/Wp01/Collision/Collider/Wp01_SubAttack.rcol.38.json",
    "Wp01_Shell": "Player/ActionData/Wp01/Collision/Collider/Wp01_Shell.rcol.38.json",
    "Wp01ShellList": "Player/ActionData/Wp01/Shell/Wp01ShellList.user.3.json",
    "Wp01_FinishSlash": "Player/ActionData/Wp01/Shell/MainParam/Wp01_FinishSlash.user.3.json",
    "Wp01_RushFinishSlash": "Player/ActionData/Wp01/Shell/MainParam/Wp01_RushFinishSlash.user.3.json",
    "Wp01_OldScarSlash": "Player/ActionData/Wp01/Shell/MainParam/Wp01_OldScarSlash.user.3.json",
}


def raw_url(key: str) -> str:
    return f"{MHWS_RAW}/{RAW_FILES[key]}"


def _download(url: str, dest: Path) -> None:
    """URL を dest に保存する。失敗は握り潰さず例外で止める。"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "mhwilds-sns-build/1.0"})
    last = None
    for _ in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                data = res.read()
            tmp = dest.with_suffix(dest.suffix + ".part")
            tmp.write_bytes(data)
            tmp.replace(dest)
            return
        except Exception as exc:  # noqa: BLE001 - 3 回まで再試行し、最後は投げ直す
            last = exc
    raise RuntimeError(f"ダウンロード失敗: {url}: {last}")


def raw_path(key: str) -> Path:
    """生ファイルのキャッシュパス。無ければ取得する。"""
    dest = CACHE / "raw" / Path(RAW_FILES[key]).name
    if not dest.exists():
        print(f"取得: {raw_url(key)}", file=sys.stderr)
        _download(raw_url(key), dest)
    return dest


def load_raw(key: str):
    return json.loads(raw_path(key).read_text(encoding="utf-8"))


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def db_ja_dir() -> Path:
    """日本語 DATABASE (xlsx 群) を展開したフォルダ。技名の照合に使う。"""
    out = CACHE / "db_ja"
    if (out / "WeaponActionValues.xlsx").exists():
        return out
    zpath = CACHE / MHWS_DB_JA_ZIP
    if not zpath.exists():
        print(f"取得: {MHWS_DB_JA_URL}", file=sys.stderr)
        _download(MHWS_DB_JA_URL, zpath)
    with zipfile.ZipFile(zpath) as zf:
        zf.extractall(out)
    return out


def mhdb_skills() -> list[dict]:
    dest = CACHE / "mhdb_skills_ja.json"
    if not dest.exists():
        print(f"取得: {MHDB_SKILLS_URL}", file=sys.stderr)
        _download(MHDB_SKILLS_URL, dest)
    return json.loads(dest.read_text(encoding="utf-8"))


# ---------------------------------------------------------------- 生データの読み解き

ENUM_RE = re.compile(r"^\[(-?\d+)\]\s*(\S+)$")


def skill_enum() -> dict[str, int]:
    """HunterSkill_XXX → _skillId の列挙値 (= MHDB の gameId)。"""
    doc = load_raw("SkillCommonData")[0]["app.user_data.SkillCommonData"]["_Values"]
    out = {}
    for v in doc:
        x = v["app.user_data.SkillCommonData.cData"]
        m = ENUM_RE.match(x["_skillId"])
        out[m.group(2)] = int(m.group(1))
    return out


def skill_data_rows() -> dict[str, list[dict]]:
    """HunterSkill_XXX → [{level, value[4], openSkill[...]}] (SkillData の Lv 昇順)。"""
    doc = load_raw("SkillData")[0]["app.user_data.SkillData"]["_Values"]
    out: dict[str, list[dict]] = {}
    for v in doc:
        x = v["app.user_data.SkillData.cData"]
        m = ENUM_RE.match(x["_skillId"])
        name = m.group(2)
        out.setdefault(name, []).append({
            "level": x["_SkillLv"], "value": list(x["_value"]),
            "openSkill": [ENUM_RE.match(s).group(2) for s in x["_openSkill"]],
        })
    for rows in out.values():
        rows.sort(key=lambda r: r["level"])
    return out


def skill_param() -> dict:
    return load_raw("PlayerSkillParam")[0]["app.user_data.PlayerSkillParam"]


def skill_pack(field: str) -> list[float]:
    """PlayerSkillParam の cSkillBasicDataPack を数値の並びにする。"""
    wrapper = skill_param()[field]
    pack = wrapper["app.user_data.PlayerSkillParam.cSkillBasicDataPack"]["_DataPack"]
    return [float(e["app.user_data.PlayerSkillParam.cSkillBasicData"]) for e in pack]


def status_param() -> dict:
    return load_raw("PlayerStatusParam")[0]["app.user_data.PlayerStatusParam"]


def sharpness_table() -> dict[str, dict]:
    """EmCommonData._KireajiTable → {red: {physical, element}, ...}。"""
    doc = load_raw("EmCommonData")[0]["app.user_data.EmParamCommon"]["_KireajiTable"]
    rows = next(iter(doc.values()))["_ParamList"]
    out = {}
    for e in rows:
        r = e["app.user_data.EmParamCommon.cKireajiRate"]
        color = ENUM_RE.match(r["EnumValue"]).group(2).lower()
        out[color] = {"physical": r["Damage"], "element": r["Elem"]}
    return out


def rcol_hits(key: str) -> dict[int, dict]:
    """RCOL (当たり判定) の requestSetID → AttackParamPl の中身。"""
    doc = load_raw(key)
    out = {}
    for rs in doc["requestSets"]:
        ud = rs["userData"]
        k = next(iter(ud))
        if not k.endswith("AttackParamPl"):
            continue
        out[rs["requestSetID"]] = ud[k]
    return out


def shell_main(key: str) -> dict:
    """弾 (Shell) の MainParam から寿命・子弾数を取り出す。"""
    doc = load_raw(key)[0]["ace.user_data.ShellMainParam"]
    life = doc["_CommonParam"]["ace.cShellminiParamCommon"]["_LifeSec"]
    children = []
    for p in doc["_ShellMiniParams"]:
        k = next(iter(p))
        if k == "app.cShellminiParamCallCustomChildShell":
            v = p[k]
            children.append({
                "index": v["_ShellIndex"],
                "createNum": v["_CreateNum"],
                "shellNameHash": v["_ShellList"]["ace.cChildShellGenerateParam"]["_ShellNameHash"],
            })
    return {"lifeSec": life, "children": children}


def shell_list() -> dict[int, dict]:
    """_ShellNameHash → {fixedId, attackCollisionId, mainParam}。"""
    doc = load_raw("Wp01ShellList")[0]["ace.user_data.ShellList"]["_DataList"]
    out = {}
    for e in doc:
        c = e["ace.user_data.ShellList.cData"]
        pkg = c["_ShellPackage"]["ace.cShellPackage"]
        out[pkg["_ShellNameHash"]] = {
            "fixedId": c["_FixedID"],
            "attackCollisionId": pkg["_AttackCollisionID"],
            "mainParam": pkg["_MainParam"]["ace.user_data.ShellMainParam"]["path"],
        }
    return out


def xlsx_move_names() -> dict[str, str]:
    """日本語 DATABASE の WeaponActionValues から 内部名 → 日本語技名 (ゲーム内ガイド文言)。"""
    import openpyxl  # 遅延 import (技名照合のときだけ要る)

    wb = openpyxl.load_workbook(db_ja_dir() / "WeaponActionValues.xlsx", read_only=True)
    rows = list(wb["Wp01_ShortSword"].iter_rows(values_only=True))
    hdr = rows[1]
    i_name, i_int = hdr.index("MappingName"), hdr.index("MappingInternalName")
    out = {}
    for r in rows[2:]:
        if r[i_name] and r[i_int] and r[i_int] not in out:
            out[r[i_int]] = r[i_name]
    return out


# ---------------------------------------------------------------- 出力の共通処理

def write_json(path: Path, obj: dict, *, indent: int | None = 1) -> bool:
    """冪等に書く。meta.generatedAt 以外が前回と同じなら前回の generatedAt を残す。

    戻り値: 中身が変わって書き換えたら True。
    """
    if path.exists():
        try:
            old = json.loads(path.read_text(encoding="utf-8"))
            prev_at = old.get("meta", {}).get("generatedAt")
            cmp_new = json.loads(json.dumps(obj, ensure_ascii=False))
            cmp_new.get("meta", {}).pop("generatedAt", None)
            old.get("meta", {}).pop("generatedAt", None)
            if old == cmp_new and prev_at:
                obj["meta"]["generatedAt"] = prev_at
        except (json.JSONDecodeError, OSError):
            pass
    text = json.dumps(obj, ensure_ascii=False, indent=indent) + "\n"
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")
    return True

