"""iPhone 幅の画面のスモークテスト (Playwright / Python)。

使い方 (リポのどこからでも):
    PYTHONIOENCODING=utf-8 python tests/smoke_ui.py              # webkit の iPhone 13 (無ければ chromium で代用)
    PYTHONIOENCODING=utf-8 python tests/smoke_ui.py --browser chromium
    PYTHONIOENCODING=utf-8 python tests/smoke_ui.py --headed     # 画面を出して見る
    PYTHONIOENCODING=utf-8 python tests/smoke_ui.py --only equip,settings   # タブを絞る

確かめること:
  0. 事前の検査: sw.js の PRECACHE と実際のファイルが合っているか / JS の構文 (node --check) /
     公開前に sw.js の VERSION を上げ忘れていないか (警告だけ)
  1. GitHub Pages と同じ /mhwilds-sns/ の下で配信して開く (/mhwilds-sns/ の外へのリクエスト = 先頭 / の絶対パスの疑い → 失敗)
  2. 各タブを開き、コンソールのエラー・ページのエラー・404 が無いこと
  3. 横スクロールが出ないこと (iPhone 13 = 幅 390px と、幅 375px)
  4. ボタンなどのタップ領域が 44px 以上あること
  5. 相手タブを開くまで monsters.json / quests.json を読まないこと (遅延読み込み)
  6. Service Worker が使えるブラウザなら: 電波なし (offline) でも開けること・新しい版の帯が出て再読み込みで切り替わること
  7. 共通部品 (picker・数値入力など) を一時的に描いて動かす / 状態が IndexedDB に保存されて開き直すと戻る /
     状態とデータを計算モデルにそのまま渡せる / データが読めないとき「もう一度」で直る
  スクリーンショットは tests/artifacts/ (git 管理外) に保存する。

配信: Python の http.server で、/mhwilds-sns/ をこのリポに対応させ、それ以外は 404 にする
(親フォルダ全体は配信しない。Pages と同じパスで相対 URL を確かめられ、外へ出たリクエストも見つけられる)。

テストを足すとき:
  - タブを開いた後の確認は @tab_check('equip') を付けた関数を足す (下の「タブごとの確認」節)。
    関数は (page, ctx) を受け取り、問題があれば ctx.fail('説明') を呼ぶ。スクリーンショットは ctx.shot('名前')。
  - 別の流れ (シートを開く・入力するなど) は @scenario_check を付けた関数を足す (全タブの確認の後に 1 回呼ばれる)。
"""
from __future__ import annotations

import argparse
import http.server
import json
import mimetypes
import posixpath
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

REPO = Path(__file__).resolve().parent.parent
BASE_PATH = "/mhwilds-sns/"
ART = REPO / "tests" / "artifacts"
TABS = ["equip", "power", "target", "search", "charms", "settings"]
TAP_MIN = 43.5  # 44px (小数の丸めの分だけ緩める)

# ---------------------------------------------------------------- 配信 (Pages と同じパス)

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
}


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.lock = threading.Lock()
        self.requests: list[tuple[str, int]] = []   # (path, status)
        self.outside: list[str] = []                # /mhwilds-sns/ の外へのリクエスト
        self.sw_version_override: str | None = None  # 新しい版の sw.js を出す (更新の帯の確認用)
        self.offline = False                         # True の間は返事をせず接続を切る (電波なしのまね)


class Handler(http.server.SimpleHTTPRequestHandler):
    server: Server
    extensions_map = {**mimetypes.types_map, **MIME, "": "application/octet-stream"}

    def log_message(self, fmt, *args):  # 標準エラーに出さない
        pass

    def _record(self, status: int):
        with self.server.lock:
            self.server.requests.append((self.path, status))

    def send_response(self, code, message=None):
        self._record(code)
        super().send_response(code, message)

    def end_headers(self):
        # GitHub Pages は max-age=600 だが、テストでは毎回取り直させる (更新の確認のため)
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def translate_path(self, path):
        p = urllib.parse.unquote(urllib.parse.urlsplit(path).path)
        rel = p[len(BASE_PATH):] if p.startswith(BASE_PATH) else ""
        rel = posixpath.normpath("/" + rel).lstrip("/")
        full = (REPO / rel).resolve()
        if REPO not in full.parents and full != REPO:
            return str(REPO / "__forbidden__")
        return str(full)

    def do_GET(self):
        if self.server.offline:
            # 返事をせずに切る = ブラウザから見ると通信できない
            with self.server.lock:
                self.server.requests.append((self.path, 0))
            self.close_connection = True
            return
        path = urllib.parse.urlsplit(self.path).path
        if path == BASE_PATH.rstrip("/"):
            self.send_response(301)
            self.send_header("Location", BASE_PATH)
            self.end_headers()
            return
        if not path.startswith(BASE_PATH):
            with self.server.lock:
                self.server.outside.append(self.path)
            self.send_error(404, "outside /mhwilds-sns/")
            return
        if path == BASE_PATH + "sw.js" and self.server.sw_version_override:
            body = (REPO / "sw.js").read_text(encoding="utf-8")
            body = re.sub(r"const VERSION = '[^']*';", f"const VERSION = '{self.server.sw_version_override}';", body, count=1)
            data = body.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", MIME[".js"])
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()


def start_server() -> tuple[Server, str]:
    srv = Server(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}{BASE_PATH}"


# ---------------------------------------------------------------- 結果の入れ物

@dataclass
class Ctx:
    scenario: str
    page: object
    base_url: str
    server: Server
    failures: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)       # コンソール・ページのエラー (今の区切り)
    page_requests: list[str] = field(default_factory=list)
    sw: bool = False                                      # この流れで Service Worker (オフライン) の確認もするか

    def fail(self, msg: str):
        self.failures.append(f"[{self.scenario}] {msg}")

    def note(self, msg: str):
        self.notes.append(f"[{self.scenario}] {msg}")

    def shot(self, name: str, full_page: bool = True):
        ART.mkdir(parents=True, exist_ok=True)
        path = ART / f"{self.scenario}-{name}.png"
        self.page.screenshot(path=str(path), full_page=full_page)
        return path

    def take_errors(self) -> list[str]:
        out, self.errors = self.errors, []
        return out


TabCheck = Callable[[object, Ctx], None]
TAB_CHECKS: dict[str, list[TabCheck]] = {t: [] for t in TABS}
SCENARIO_CHECKS: list[TabCheck] = []


def tab_check(tab: str):
    """タブを開いた後に呼ぶ確認を登録する。"""
    def deco(fn: TabCheck):
        TAB_CHECKS.setdefault(tab, []).append(fn)
        return fn
    return deco


def scenario_check(fn: TabCheck):
    """全タブの確認の後に 1 回呼ぶ確認を登録する。"""
    SCENARIO_CHECKS.append(fn)
    return fn


# ---------------------------------------------------------------- ページの中で測る JS

JS_OVERFLOW = """
() => {
  const vw = document.documentElement.clientWidth;
  const out = [];
  const clipped = (el) => {
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const ox = getComputedStyle(a).overflowX;
      if (ox !== 'visible') {
        const r = a.getBoundingClientRect();
        if (r.right <= vw + 0.5 && r.left >= -0.5) return true;
      }
    }
    return false;
  };
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if ((r.right > vw + 0.5 || r.left < -0.5) && !clipped(el)) {
      const cls = typeof el.className === 'string' ? el.className.split(' ').filter(Boolean).slice(0, 2).join('.') : '';
      out.push(`${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} left=${r.left.toFixed(1)} right=${r.right.toFixed(1)}`);
    }
  }
  return { vw, scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth,
           innerWidth: window.innerWidth, over: out.slice(0, 12), overCount: out.length };
}
"""

JS_TAP = """
() => {
  const bad = [];
  const sel = 'button, select, input:not([type=checkbox]):not([type=file]):not([type=hidden]), .toggle, [role=tab]';
  for (const el of document.querySelectorAll(sel)) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (el.closest('[hidden]') || el.closest('.visually-hidden') || el.classList.contains('visually-hidden')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.height < %(min)s || r.width < %(min)s) {
      const label = (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 20);
      bad.push(`${el.tagName.toLowerCase()} "${label}" ${r.width.toFixed(0)}x${r.height.toFixed(0)}`);
    }
  }
  return bad;
}
""" % {"min": TAP_MIN}


# ---------------------------------------------------------------- 共通の確認

def wait_app_ready(page, timeout=30000):
    page.wait_for_selector('.app[data-app-ready="1"]', timeout=timeout)


def open_tab(page, tab: str, timeout=20000):
    page.click(f'button[data-tab="{tab}"]')
    page.wait_for_selector(f'.app[data-active-tab="{tab}"]', timeout=timeout)
    page.wait_for_selector(f'[data-tab-panel="{tab}"] [data-tab-ready="1"]', timeout=timeout)
    # タブの中の「読み込み中」が消えるまで待つ (相手タブの遅延読み込みなど)
    page.wait_for_function(
        """(tab) => { const p = document.querySelector(`[data-tab-panel="${tab}"]`);
                      return p && !p.querySelector('.loading'); }""",
        arg=tab, timeout=timeout)
    page.wait_for_timeout(150)


def check_layout(page, ctx: Ctx, where: str):
    m = page.evaluate(JS_OVERFLOW)
    if m["scrollWidth"] > m["vw"] or m["bodyScrollWidth"] > m["vw"] or m["overCount"]:
        ctx.fail(f"{where}: 横にはみ出しています (幅 {m['vw']}px, scrollWidth {m['scrollWidth']}px) {m['over']}")
    bad = page.evaluate(JS_TAP)
    if bad:
        ctx.fail(f"{where}: タップ領域が 44px 未満: {bad[:8]}")


def check_errors(ctx: Ctx, where: str):
    errs = ctx.take_errors()
    if errs:
        ctx.fail(f"{where}: エラー {len(errs)} 件: {errs[:6]}")


# ---------------------------------------------------------------- タブごとの確認 (足すならここ)

@tab_check("settings")
def settings_has_credits(page, ctx: Ctx):
    text = page.inner_text('[data-tab-panel="settings"]')
    for word in ["MHWS-in-json", "CC BY-SA 4.0", "カプコン", "MHDB"]:
        if word not in text:
            ctx.fail(f"設定タブに「{word}」の表記がありません")


@tab_check("settings")
def settings_shows_data_versions(page, ctx: Ctx):
    n = page.locator('[data-tab-panel="settings"] .data-row').count()
    if n < 12:
        ctx.fail(f"設定タブのデータの版の行が少ない ({n} 行)")


# ---------------------------------------------------------------- 共通部品の確認 (タブの中身に関係なく毎回)

JS_GALLERY = """
async () => {
  const C = await import('./app/ui/components/index.js');
  const { render } = await import('preact');
  const { useState } = await import('preact/hooks');
  const { html } = C;
  const items = Array.from({ length: 300 }, (_, i) => ({
    value: i, label: `テスト装備${i}`, sub: i % 2 ? 'スキル 攻撃 Lv1' : 'スロット ③①−', group: i < 150 ? '前半' : '後半',
  }));
  const colors = ['red', 'orange', 'yellow', 'green', 'blue', 'white', 'purple'];
  function Gallery() {
    const [v, setV] = useState(null);
    const [n, setN] = useState(5);
    const [r, setR] = useState(0.5);
    const [t, setT] = useState(false);
    const [seg, setSeg] = useState('white');
    const [sel, setSel] = useState(1);
    return html`
      <div class="stack" id="gallery">
        <${C.Card} title="部品の確認" sub="スモークテスト用の一時的な表示">
          <${C.PickerField} label="武器" title="武器を選ぶ" items=${items} value=${v} onChange=${setV} allowNone />
          <${C.NumberInput} label="数値" value=${n} onChange=${setN} min=${-10} max=${100} unit="%" />
          <${C.Slider} label="発動率" value=${r} onChange=${setR} percent />
          <${C.Toggle} label="限界突破" checked=${t} onChange=${setT} hint="説明の文" />
          <${C.Segmented} label="斬れ味" value=${seg} onChange=${setSeg}
            options=${colors.map((c) => ({ value: c, label: C.SHARPNESS_LABEL[c] }))} />
          <${C.Select} label="選択" value=${sel} onChange=${setSel} options=${[{ value: 1, label: '一' }, { value: 2, label: '二' }]} />
          <${C.Row} label="行" value="とても長い名前の装備がここに入っても折り返して横にはみ出さないことを確かめる" sub="補足" onClick=${() => {}} />
          <p><${C.Badge} kind="unconfirmed" /> <${C.Badge} kind="unsupported" /> <${C.Badge} kind="error" /></p>
          <${C.Notice} kind="unconfirmed" title="未確定の値">根拠が弱い数値です。</${C.Notice}>
          <${C.Notice} kind="unsupported" title="計算に入れていないスキル">説明</${C.Notice}>
          <${C.ErrorBox} error=${new Error('テストのエラー表示')} onRetry=${() => {}} />
          <output id="gallery-state">${JSON.stringify({ v, n, r, t, seg, sel })}</output>
        </${C.Card}>
      </div>`;
  }
  const host = document.createElement('div');
  host.id = 'gallery-host';
  document.querySelector('.app-main').prepend(host);
  render(html`<${Gallery} />`, host);
  window.__unmountGallery = () => { render(null, host); host.remove(); };
}
"""


def gallery_state(page) -> dict:
    return json.loads(page.inner_text("#gallery-state"))


@scenario_check
def components_gallery(page, ctx: Ctx):
    """共通部品 (picker・数値入力・スライダー・トグルなど) を一時的に描いて動かす。"""
    page.evaluate("window.scrollTo(0, 0)")
    page.evaluate(JS_GALLERY)
    page.wait_for_selector("#gallery")
    check_layout(page, ctx, "共通部品")
    ctx.shot("components")
    # picker: 開く → カタカナをひらがなで探す → 選ぶ → 閉じる
    page.click("#gallery .picker-field .row")
    page.wait_for_selector(".sheet .picker-list")
    check_layout(page, ctx, "picker を開いた")
    page.fill(".sheet input[type=search]", "てすと 装備12")
    page.wait_for_function("document.querySelector('.picker-count').textContent.trim().startsWith('11 ')")
    ctx.shot("picker", full_page=False)
    page.click(".sheet .picker-item >> nth=0")
    page.wait_for_selector(".sheet", state="detached")
    if gallery_state(page)["v"] != 12:
        ctx.fail(f"picker で選んだ値が入っていません: {gallery_state(page)}")
    # 数値入力: 全角とカンマを読み、範囲に丸める
    num = page.locator("#gallery .input-number")
    num.fill("１,０００")
    num.blur()
    if gallery_state(page)["n"] != 100:
        ctx.fail(f"数値入力が範囲 (〜100) に丸めていません: {gallery_state(page)}")
    page.click("#gallery .number-row button[aria-label='減らす']")
    if gallery_state(page)["n"] != 99:
        ctx.fail(f"数値入力の − ボタンが効きません: {gallery_state(page)}")
    # トグル・切り替え
    page.click("#gallery .toggle")
    page.click("#gallery .segment >> text=赤")
    st = gallery_state(page)
    if st["t"] is not True or st["seg"] != "red":
        ctx.fail(f"トグル/切り替えボタンが効きません: {st}")
    page.select_option("#gallery select", index=1)
    if gallery_state(page)["sel"] != 2:
        ctx.fail(f"選択 (select) が効きません: {gallery_state(page)}")
    page.evaluate("window.__unmountGallery()")


@scenario_check
def state_survives_reload(page, ctx: Ctx):
    """状態が IndexedDB に保存され、開き直しても戻ること。書き出し → 読み込みも通ること。"""
    r = page.evaluate("""async () => {
      const S = await import('./app/state.js');
      const D = await import('./app/store.js');
      S.setWeapon(1059);
      S.setArmor('head', 1);
      S.setLimitBreak('head', true);
      S.setUptime('enraged', 0.3);
      S.setUptimeState('chain', 'hit5plus', 0.7);
      S.saveMySet('テストのセット');
      await S.flushState();
      const text = await D.exportAllText({ appVersion: 'test' });
      const parsed = D.parseBackupText('ゴミ' + text + 'ゴミ');
      return { ok: parsed.ok, keys: parsed.ok ? parsed.keys : parsed.message, db: (await D.storageInfo()).available };
    }""")
    if not r["ok"] or "mhwilds-sns:state" not in r["keys"]:
        ctx.fail(f"書き出したテキストを読み戻せません: {r}")
    if not r["db"]:
        ctx.note("IndexedDB が使えない環境でした (保存の確認は飛ばします)")
        return
    page.reload(wait_until="load")
    wait_app_ready(page)
    st = page.evaluate("""async () => { const S = await import('./app/state.js'); const s = S.getState();
      return { weapon: s.build.weapon, head: s.build.armor.head, tr: s.build.limitBreak.head,
               up: s.uptimes.enraged, chain: s.uptimes.chain, sets: s.mySets.map((x) => x.name) }; }""")
    if st != {"weapon": 1059, "head": 1, "tr": True, "up": 0.3, "chain": {"hit5plus": 0.7}, "sets": ["テストのセット"]}:
        ctx.fail(f"開き直したら状態が戻りませんでした: {st}")
    # data.js の索引・state の形が計算モデルにそのまま渡せること
    calc = page.evaluate("""async () => {
      const S = await import('./app/state.js'); const D = await import('./app/data.js');
      const B = await import('./app/model/build.js'); const M = await import('./app/model/damage.js');
      const data = D.getCoreData(); const st = S.getState();
      const build = B.computeBuild(st.build, data.index);
      const r = M.comboExpected({ weapon: data.index.weapons.get(st.build.weapon), sharpness: 'white',
        skills: build.skills, uptimes: st.uptimes, effects: data.skillEffects, motions: data.motions,
        combo: S.resolveCombo(null, data.combos),
        target: S.resolveTarget({ ...st.target, mode: 'manual' }) });
      return { total: r.total, skills: build.skills.length, lb: build.limitBreak.head };
    }""")
    if not (calc["total"] > 0 and calc["skills"] > 0 and calc["lb"] is True):
        ctx.fail(f"状態とデータを計算モデルに渡すと結果がおかしい: {calc}")
    # 後片付け (初期化)
    page.evaluate("""async () => { const S = await import('./app/state.js'); const D = await import('./app/store.js');
      await D.kvClear(); await S.resetState(); }""")


# ---------------------------------------------------------------- 護石タブ (担当: tab-charms)

CHARMS_PANEL = '[data-tab-panel="charms"]'


def _charms_reset(page):
    """この端末で足した護石を消し、装備の護石を外す (護石タブの確認の前後に呼ぶ)。"""
    page.evaluate("""async () => {
      const T = await import('./app/ui/tabs/charms.js');
      const D = await import('./app/store.js');
      const S = await import('./app/state.js');
      await D.kvDelete(T.LOCAL_CHARMS_KEY);
      await T.refreshLocalCharms();
      S.setCharm(null);
      await S.flushState();
    }""")


def _charms_local_ids(page) -> list[str]:
    return page.evaluate("""async () => { const T = await import('./app/ui/tabs/charms.js');
      await T.loadLocalCharms(); return T.getLocalCharms().map((c) => c.id); }""")


def _charm_state(page):
    return page.evaluate("async () => (await import('./app/state.js')).getState().build.charm")


def _close_sheets(page):
    """開いているシートを上から全部閉じる。"""
    for _ in range(4):
        btn = page.locator(".sheet .sheet-close")
        if not btn.count():
            return
        btn.last.click()
        page.wait_for_timeout(100)


def _wait_sheet_ready(page):
    """いちばん上のシートが開ききるまで待つ (開いた直後はシートが自分にフォーカスを移すので、その前に入れた文字は消える)。"""
    page.wait_for_function("""() => { const s = [...document.querySelectorAll('.sheet')].pop();
      return !!s && s.contains(document.activeElement)
        && (s.getAnimations ? s.getAnimations() : []).every((a) => a.playState !== 'running'); }""")


def _pick_skill(page, ctx: Ctx, index: int, search: str, label: str, where: str):
    """手で足すシートのスキル枠 index の picker を開き、search で探して label を選ぶ。"""
    page.click(f'[data-charm-skill="{index}"] .picker-field .row')
    page.wait_for_selector(".picker-list")
    _wait_sheet_ready(page)
    check_layout(page, ctx, where)
    page.fill(".sheet input[type=search]", search)
    page.locator(".picker-item", has_text=label).first.click()
    page.wait_for_selector(".picker-list", state="detached")


@tab_check("charms")
def charms_list_and_photo_hint(page, ctx: Ctx):
    """data/charms.json の護石が一覧に出て、検証の印が付き、写真で足す案内が出ていること。"""
    text = page.inner_text(CHARMS_PANEL)
    for word in ["護石取り込んで", "Claude が取り込んだ護石", "この端末で足した護石", "泣シミュ形式"]:
        if word not in text:
            ctx.fail(f"護石タブに「{word}」が出ていません")
    want = json.loads((REPO / "data" / "charms.json").read_text(encoding="utf-8"))["charms"]
    # 一覧は 40 個ずつ出す (シートの護石が 250 個ある。2026-10-24)。9 個以上なら探す欄と絞り方がある
    page_size = 40
    rows = page.locator(f'{CHARMS_PANEL} [data-charm-origin="data"]')
    n = rows.count()
    if n != min(len(want), page_size):
        ctx.fail(f"data/charms.json の護石 {len(want)} 個のうち、一覧の最初に {n} 個が出ています ({min(len(want), page_size)} 個のはず)")
    shown_ids = rows.evaluate_all("els => els.map((e) => e.dataset.charmId)")
    if shown_ids != [c["id"] for c in want[:page_size]]:
        ctx.fail(f"一覧の並びが data/charms.json と違います: {shown_ids[:5]}")
    for cid in shown_ids:
        badge = page.locator(f'{CHARMS_PANEL} [data-charm-id="{cid}"] .row-end .badge')
        label = badge.inner_text().strip() if badge.count() else ""
        if label not in ("OK", "注意", "エラー"):
            ctx.fail(f"護石 {cid} に検証の印 (OK/注意/エラー) がありません: {label!r}")
    if len(want) > page_size:
        rest = page.locator(f'{CHARMS_PANEL} [data-charm-rest]')
        if not rest.count() or rest.get_attribute("data-charm-rest") != str(len(want) - page_size):
            ctx.fail(f"一覧の下に「あと {len(want) - page_size} 個あります」が出ていません")
    if len(want) > 8:
        # シートの No. で探すと 1 個になり、スロットを確かめていない護石には印がある
        sheet = [c for c in want if c.get("sheetNo") is not None]
        if sheet:
            c = sheet[-1]
            page.fill(f'{CHARMS_PANEL} [data-charm-search]', str(c["sheetNo"]))
            got = page.locator(f'{CHARMS_PANEL} [data-charm-origin="data"]').evaluate_all("els => els.map((e) => e.dataset.charmId)")
            if got != [c["id"]]:
                ctx.fail(f"一覧で「{c['sheetNo']}」を探すと {got} が出ます ({c['id']} だけのはず)")
            row_text = page.inner_text(f'{CHARMS_PANEL} [data-charm-id="{c["id"]}"]')
            if f"シート No.{c['sheetNo']}" not in row_text:
                ctx.fail(f"シートの護石 {c['id']} の行に「シート No.{c['sheetNo']}」が出ていません: {row_text!r}")
            if c.get("slotsProvisional") and "スロット未確認" not in row_text:
                ctx.fail(f"スロットを確かめていない護石 {c['id']} の行に「スロット未確認」の印がありません")
            check_layout(page, ctx, "護石タブ (No. で探した)")
            if c.get("slotsProvisional"):
                # 詳しい画面: ゲームで確かめたら、シートの No. を添えて Claude に伝える案内 (2026-10-24 点検の後)
                page.click(f'{CHARMS_PANEL} [data-charm-id="{c["id"]}"]')
                page.wait_for_selector(f'[data-charm-sheet="detail"][data-charm-id="{c["id"]}"]')
                _wait_sheet_ready(page)
                detail = page.inner_text('[data-charm-sheet="detail"]')
                for word in ["スロットはまだ確かめていません", f"シート No.{c['sheetNo']} のスロットは", "合っていたときも伝えてください"]:
                    if word not in detail:
                        ctx.fail(f"スロット未確認の護石 {c['id']} の詳しい画面に「{word}」が出ていません")
                check_layout(page, ctx, "護石の詳しい画面 (スロット未確認)")
                page.locator('[data-charm-sheet="detail"] p', has_text="のスロットは").first.scroll_into_view_if_needed()
                ctx.shot("charms-detail-unconfirmed", full_page=False)
                _close_sheets(page)
                page.wait_for_selector('[data-charm-sheet="detail"]', state="detached")
            page.fill(f'{CHARMS_PANEL} [data-charm-search]', "")
        # 「スロット未確認」だけに絞る → 合う数が出る
        n_prov = sum(1 for c in want if c.get("slotsProvisional"))
        page.locator(f'{CHARMS_PANEL} [data-charm-tools] .segment', has_text="スロット未確認").click()
        matched = page.locator(f'{CHARMS_PANEL} [data-charm-matched]')
        if not matched.count() or matched.get_attribute("data-charm-matched") != str(n_prov):
            ctx.fail(f"「スロット未確認」で絞った数が {n_prov} 個になりません")
        page.locator(f'{CHARMS_PANEL} [data-charm-tools] .segment', has_text="全部").click()
        if page.locator(f'{CHARMS_PANEL} [data-charm-origin="data"]').count() != min(len(want), page_size):
            ctx.fail("絞り方を「全部」に戻しても、一覧が元の数に戻りません")


@scenario_check
def charms_add_equip_export_import(page, ctx: Ctx):
    """護石タブ: 手で足す (選択肢が抽選表どおりに絞られる) → 装備にする → 直す → 書き出し 2 種 →
    泣シミュ形式の読み込み → 取り込み済みの片付け → 消す。"""
    open_tab(page, "charms")
    _charms_reset(page)
    page.wait_for_function(
        "() => !document.querySelector('[data-tab-panel=\"charms\"] [data-charm-origin=\"local\"]')")
    model = page.evaluate("""async () => {
      const T = await import('./app/ui/tabs/charms.js'); const D = await import('./app/data.js');
      const rules = D.getCoreData().talismanRules;
      return { slots8: T.slotChoices(rules, 8).length, slots7: T.slotChoices(rules, 7).length,
               skill0: T.skillChoices(rules, 7, '2,0,0|0', [null, null, null], 0).length };
    }""")

    # --- 手で足す: レア8 はスロットの選択肢が抽選表の分だけで、どれも武器用の穴がある
    page.click(f'{CHARMS_PANEL} [data-charm-action="add"]')
    page.wait_for_selector('[data-charm-sheet="editor"]')
    if not page.locator('[data-charm-action="save"]').is_disabled():
        ctx.fail("護石を足すシート: 何も選んでいないのに「足す」が押せます")
    _wait_sheet_ready(page)
    page.locator('[data-charm-field="rarity"] .segment', has_text="レア8").click()
    labels = page.locator('[data-charm-field="slots"] .segment').all_inner_texts()
    if len(labels) != model["slots8"] or not all("武器" in x for x in labels):
        ctx.fail(f"レア8 のスロットの選択肢が抽選表と合いません: {labels} (抽選表 {model['slots8']} 通り)")
    check_layout(page, ctx, "護石を足す (レア8)")
    ctx.shot("charms-editor-r8", full_page=False)
    # レア7・防具 ②−− にする → スキル 1 の選択肢の数が計算と同じ
    page.locator('[data-charm-field="rarity"] .segment', has_text="レア7").click()
    if page.locator('[data-charm-field="slots"] .segment').count() != model["slots7"]:
        ctx.fail("レア7 のスロットの選択肢の数が抽選表と合いません")
    page.locator('[data-charm-field="slots"] .segment', has_text="防具 ②−−").click()
    page.click('[data-charm-skill="0"] .picker-field .row')
    page.wait_for_selector(".picker-list")
    _wait_sheet_ready(page)
    shown = int(page.inner_text(".picker-count").split()[0])
    if shown != model["skill0"]:
        ctx.fail(f"スキル 1 の選択肢が {shown} 件 (抽選表からは {model['skill0']} 件)")
    ctx.shot("charms-skill-picker", full_page=False)
    page.locator(".sheet .sheet-close").last.click()  # picker だけ閉じる (足すシートは開いたまま)
    page.wait_for_selector(".picker-list", state="detached")
    _pick_skill(page, ctx, 0, "見切り", "見切り Lv3", "スキル 1 を選ぶ")
    # 見切り Lv3 (武器スキルの群) を選んだら、2 つ目は防具スキルだけ
    page.click('[data-charm-skill="1"] .picker-field .row')
    page.wait_for_selector(".picker-list")
    groups = page.locator(".picker-group").all_inner_texts()
    if any("武器" in g for g in groups):
        ctx.fail(f"見切り Lv3 のあとに、レア7 では一緒に出ない武器スキルが選べます: {groups}")
    page.locator(".sheet .sheet-close").last.click()
    page.wait_for_selector(".picker-list", state="detached")
    _pick_skill(page, ctx, 1, "弱点特効", "弱点特効 Lv1", "スキル 2 を選ぶ")
    status = page.inner_text('[data-charm-status="1"]')
    if "このまま足せます" not in status:
        ctx.fail(f"見切り Lv3 + 弱点特効 Lv1 で足せる状態になりません: {status}")
    page.click('[data-charm-action="save"]')
    page.wait_for_selector('[data-charm-sheet="detail"][data-charm-id="u0001"]')
    _wait_sheet_ready(page)
    if "ゲームの決まりと合っています" not in page.inner_text('[data-charm-sheet="detail"]'):
        ctx.fail("足した護石の詳しい画面に「ゲームの決まりと合っています」が出ません")
    check_layout(page, ctx, "護石の詳しい画面")
    ctx.shot("charms-detail", full_page=False)

    # --- 装備の護石にする
    page.click('[data-charm-action="equip"]')
    page.wait_for_selector('[data-charm-action="unequip"]')
    if _charm_state(page) != "u0001":
        ctx.fail(f"「装備の護石にする」で装備の護石が変わりません: {_charm_state(page)}")

    # --- 直す (メモを足す)
    page.click('[data-charm-action="edit"]')
    page.wait_for_selector('[data-charm-sheet="editor"]')
    _wait_sheet_ready(page)
    if "このまま足せます" not in page.inner_text('[data-charm-status="1"]'):
        ctx.fail("直すシートで今の中身が選ばれた状態になっていません")
    memo = page.locator('[data-charm-sheet="editor"] input.input[type=text]')
    memo.fill("スモークテスト")
    memo.blur()
    page.click('[data-charm-action="save"]')
    page.wait_for_selector('[data-charm-sheet="detail"][data-charm-id="u0001"]')
    if "スモークテスト" not in page.inner_text('[data-charm-sheet="detail"]'):
        ctx.fail("直したメモが詳しい画面に出ません")
    _close_sheets(page)
    row = page.locator(f'{CHARMS_PANEL} [data-charm-id="u0001"]')
    if "装備中" not in row.inner_text():
        ctx.fail("装備した護石の行に「装備中」が出ません")

    # --- Claude に渡す (data/charms.json に足せる JSON)
    data_charms = json.loads((REPO / "data" / "charms.json").read_text(encoding="utf-8"))["charms"]
    next_no = max([int(c["id"][1:]) for c in data_charms if re.fullmatch(r"c\d+", c["id"])] or [0]) + 1
    page.click(f'{CHARMS_PANEL} [data-charm-action="export-claude"]')
    page.wait_for_selector('[data-charm-export="claude"]')
    _wait_sheet_ready(page)
    text = page.locator("[data-charm-export-text]").input_value()
    try:
        arr = json.loads(text[text.index("["): text.rindex("]") + 1])
        c = arr[0]
        ok = (len(arr) == 1 and c["id"] == f"c{next_no:04d}" and c["rarity"] == 7
              and sorted((s["skillId"], s["level"]) for s in c["skills"]) == [(3, 3), (57, 1)]
              and c["armorSlots"] == [2, 0, 0] and c["weaponSlots"] == [0] and c["note"] == "スモークテスト")
        if not ok:
            ctx.fail(f"Claude に渡す JSON の中身が違います: {arr}")
    except Exception as e:
        ctx.fail(f"Claude に渡すテキストから JSON を読めません: {e}: {text[:200]}")
    check_layout(page, ctx, "Claude に渡す")
    ctx.shot("charms-export-claude", full_page=False)
    _close_sheets(page)

    # --- 泣シミュ形式で書き出す
    page.click(f'{CHARMS_PANEL} [data-charm-action="export-naki"]')
    page.wait_for_selector('[data-charm-export="naki"]')
    naki = page.locator("[data-charm-export-text]").input_value().splitlines()
    if "見切り,3,弱点特効,1,,0,2,0,0,0,0,0" not in naki or not all(len(x.split(",")) == 12 for x in naki):
        ctx.fail(f"泣シミュ形式の書き出しが 12 項目になっていません: {naki[:4]}")
    _close_sheets(page)

    # --- 泣シミュ形式を読み込む: 足せる行 (レア8 だけ) / 同じ護石 / 読めない行 / レア度を選ぶ行
    page.click(f'{CHARMS_PANEL} [data-charm-action="import-naki"]')
    page.wait_for_selector('[data-charm-sheet="import"]')
    _wait_sheet_ready(page)
    paste = "\n".join([
        "攻撃,3,弱点特効,1,,0,1,0,0,1,0,0",          # レア8 だけ
        "見切り,3,弱点特効,1,,0,2,0,0,0,0,0",        # さっき足した護石と同じ
        "ナゾのスキル,1,,0,,0,0,0,0,0,0,0",          # 読めない
        "攻撃,1,ランナー,3,,0,1,1,0,0,0,0",           # レア5 か 7
    ])
    page.fill('[data-charm-sheet="import"] textarea', paste)
    page.click('[data-charm-action="import-read"]')
    page.wait_for_selector("[data-import-row]")
    rows = {i: page.inner_text(f'[data-import-row="{i}"]') for i in range(1, 5)}
    for i, word in [(1, "足せます"), (2, "同じ護石がもうあります"), (3, "読み込めません"), (4, "レア度を選んでください")]:
        if word not in rows[i]:
            ctx.fail(f"泣シミュ形式の読み込み {i} 行目に「{word}」が出ません: {rows[i]!r}")
    page.locator('[data-import-row="4"] .segment', has_text="レア7").click()
    check_layout(page, ctx, "泣シミュ形式の読み込み")
    ctx.shot("charms-import", full_page=False)
    add_btn = page.locator('[data-charm-action="import-add"]')
    if "2 個" not in add_btn.inner_text():
        ctx.fail(f"読み込みで足す数が 2 個になりません: {add_btn.inner_text()!r}")
    add_btn.click()
    page.wait_for_selector('[data-charm-sheet="import"]', state="detached")
    ids = _charms_local_ids(page)
    if ids != ["u0001", "u0002", "u0003"]:
        ctx.fail(f"読み込んだあとの、この端末の護石が違います: {ids}")

    # --- Claude が取り込み済みの護石 (data/charms.json と同じもの) は「片付ける」で消え、装備は付け替わる
    if data_charms:
        first = data_charms[0]
        page.evaluate("""async (c) => { const T = await import('./app/ui/tabs/charms.js');
          const S = await import('./app/state.js');
          const { ids } = await T.addLocalCharms([{ ...c, id: undefined }]); S.setCharm(ids[0]); }""", first)
        page.wait_for_selector(f'{CHARMS_PANEL} [data-charm-action="cleanup"]')
        page.click(f'{CHARMS_PANEL} [data-charm-action="cleanup"]')
        page.wait_for_selector(f'{CHARMS_PANEL} [data-charm-action="cleanup"]', state="detached")
        if _charm_state(page) != first["id"]:
            ctx.fail(f"片付けたあと、装備の護石が {first['id']} に付け替わりません: {_charm_state(page)}")

    # --- 消す (2 回押す)
    page.evaluate("async () => (await import('./app/state.js')).setCharm('u0001')")
    page.click(f'{CHARMS_PANEL} [data-charm-id="u0001"]')
    page.wait_for_selector('[data-charm-sheet="detail"][data-charm-id="u0001"]')
    page.click('[data-charm-action="delete"]')
    page.click('[data-charm-action="delete-confirm"]')
    page.wait_for_selector('[data-charm-sheet="detail"]', state="detached")
    if "u0001" in _charms_local_ids(page) or _charm_state(page) is not None:
        ctx.fail(f"消した護石が残っているか、装備から外れていません: {_charms_local_ids(page)} / {_charm_state(page)}")
    # data/charms.json の護石は消せず、Claude に頼む案内が出る
    if data_charms:
        page.click(f'{CHARMS_PANEL} [data-charm-id="{data_charms[0]["id"]}"]')
        page.wait_for_selector('[data-charm-sheet="detail"]')
        d = page.inner_text('[data-charm-sheet="detail"]')
        if page.locator('[data-charm-action="delete"]').count() or "Claude に「護石" not in d:
            ctx.fail("data/charms.json の護石に「消す」があるか、Claude に頼む案内が出ていません")
        _close_sheets(page)
    _charms_reset(page)


# ---------------------------------------------------------------- 装備タブ (担当: tab-equip)

EQUIP_PANEL = '[data-tab-panel="equip"]'


def _equip_reset(page):
    """装備・マイセット・画面で足した武器・斬れ味の固定を空にする (装備タブの確認の前後に呼ぶ)。"""
    page.evaluate("""async () => { const S = await import('./app/state.js');
      S.clearBuild(); for (const s of [...S.getState().mySets]) S.deleteMySet(s.id);
      S.setTabState('equip', { myWeapons: [], armorRank: 'all', armorRarity: 'all' }); S.setSharpness(null);
      await S.flushState(); }""")


def _equip_state(page) -> dict:
    return page.evaluate("""async () => { const s = (await import('./app/state.js')).getState();
      return { weapon: s.build.weapon, head: s.build.armor.head, lb: s.build.limitBreak.head,
               decos: s.build.decorations, sets: s.mySets.map((x) => x.name),
               mine: (s.tabs.equip && s.tabs.equip.myWeapons) || [] }; }""")


def _open_deco_group(page, target: str):
    """装飾品のカードの、その装備 (weapon / head / charmArmor など) の畳んだ行を開く (開いていれば何もしない)。"""
    btn = page.locator(f'[data-tab-panel="equip"] [data-eq-deco-toggle="{target}"]')
    btn.wait_for(timeout=5000)
    if btn.get_attribute("aria-expanded") != "true":
        btn.click()
        page.wait_for_selector(f'[data-tab-panel="equip"] [data-eq-deco="{target}"] [data-eq-slot]', timeout=5000)


def _equip_open_picker(page, opener: str):
    """opener の中の PickerField の行を押してシートを開く。装飾品のスロットなら先に装備の行を開く。"""
    m = re.search(r'data-eq-slot="([^:"]+):', opener)
    if m:
        _open_deco_group(page, m.group(1))
    page.locator(f"{opener} .picker-field .row").first.click()
    page.wait_for_selector(".sheet .picker-list")


def _equip_choose(page, search: str, label: str):
    """開いているシートで search を探し、label を含む最初の候補を選ぶ。"""
    page.fill(".sheet input[type=search]", search)
    page.locator(".sheet .picker-item:not(.picker-none)", has_text=label).first.click()
    page.wait_for_selector(".sheet .picker-list", state="detached")


@tab_check("equip")
def equip_build_flow(page, ctx: Ctx):
    """装備タブ: 武器 (属性の無いアーティアを足す) → 防具 (絞り込み・限界突破) → 装飾品 (入る珠だけ) →
    スキル・シリーズ・空きスロット・火力の要約 → マイセットの保存/呼び出し/削除 → 足した武器を消す。"""
    P = EQUIP_PANEL
    _equip_reset(page)
    if "武器を選ぶと" not in page.inner_text(f'{P} [data-eq="power"]'):
        ctx.fail("武器を選ぶ前の火力の要約に案内が出ていません")

    # --- 武器: 片手剣 95 本 + 持っている武器。巨戟アーティアは激化の種類で見分けられる
    _equip_open_picker(page, f'{P} [data-eq="weapon"]')
    check_layout(page, ctx, "武器を選ぶシート")
    page.wait_for_timeout(300)  # シートが下から出てくるのを待つ (画像のため)
    ctx.shot("equip-weapon-picker", full_page=False)
    n_weapons = len(json.loads((REPO / "data" / "weapons_sns.json").read_text(encoding="utf-8"))["weapons"])
    shown = int(page.inner_text(".picker-count").split()[0])
    if shown < n_weapons:
        ctx.fail(f"武器の一覧が {shown} 件 (片手剣は {n_weapons} 本)")
    page.fill(".sheet input[type=search]", "キリエヴェルド")
    labels = page.locator(".sheet .picker-item .picker-label").all_inner_texts()
    for v in ["攻撃激化", "会心激化", "属性激化"]:
        if not any(v in x for x in labels):
            ctx.fail(f"破滅のキリエヴェルドの「{v}」が一覧で見分けられません: {labels}")
    _equip_choose(page, "キリエヴェルド", "属性激化")
    page.wait_for_selector(f'{P} [data-eq="artian-form"]')
    form = f'{P} [data-eq="artian-form"]'
    page.select_option(f"{form} select", label="火")
    # 巨戟アーティアはシリーズスキルを 1 つ付けられる (1 部位として数える)
    page.locator(f"{form} .picker-field .row").first.click()
    page.wait_for_selector(".sheet .picker-list")
    _equip_choose(page, "火竜", "火竜の力")
    check_layout(page, ctx, "アーティアの入力")
    page.click(f'{P} [data-eq="artian-add"]')
    page.wait_for_selector(f'{P} [data-eq="artian-edit"]')
    st = _equip_state(page)
    mine = st["mine"][0] if st["mine"] else {}
    if not (isinstance(st["weapon"], str) and st["weapon"].startswith("wl") and mine.get("id") == st["weapon"]
            and mine.get("element", {}).get("type") == "fire" and mine.get("setBonusId") == 7
            and mine.get("baseWeaponId") == 1182):
        ctx.fail(f"足したアーティアが「持っている武器」として保存されていません: {st['weapon']} / {mine}")
    if "属性激化・火" not in page.inner_text(f'{P} [data-eq="weapon"]'):
        ctx.fail("足したアーティアの名前が武器の行に出ていません")

    # --- 防具: 上位・レア5 に絞って頭を選ぶ → 限界突破でスロットが増える
    _equip_open_picker(page, f'{P} [data-eq-part="head"]')
    page.locator(".sheet .eq-filter .segment", has_text="上位").click()
    page.select_option(".sheet .eq-filter select", label="レア 5")
    groups = set(page.locator(".sheet .picker-group").all_inner_texts())
    if groups != {"上位 レア 5"}:
        ctx.fail(f"防具の絞り込み (上位・レア5) が効いていません: {groups}")
    check_layout(page, ctx, "防具を選ぶシート")
    page.wait_for_timeout(300)  # シートが下から出てくるのを待つ (画像のため)
    ctx.shot("equip-armor-picker", full_page=False)
    page.fill(".sheet input[type=search]", "コンガヘルム")
    sub = page.locator(".sheet .picker-item", has_text="コンガヘルムα").first.inner_text()
    if "スロット" not in sub or "Lv" not in sub:
        ctx.fail(f"防具の候補にスロットとスキルが出ていません: {sub!r}")
    page.locator(".sheet .picker-item", has_text="コンガヘルムα").first.click()
    page.wait_for_selector(".sheet .picker-list", state="detached")
    toggle = page.locator(f'{P} [data-eq-part="head"] .toggle')
    if not toggle.count():
        ctx.fail("限界突破できる防具なのに「限界突破」が出ていません")
    else:
        toggle.click()
    _open_deco_group(page, "head")
    page.wait_for_function("""() => document.querySelectorAll('[data-tab-panel="equip"] [data-eq-deco="head"] [data-eq-slot]').length === 3""",
                           timeout=5000)
    if _equip_state(page)["lb"] is not True:
        ctx.fail("限界突破が状態に入っていません")
    # 限界突破の後のスロットが分からない防具 (slotsLimitBreak が null) には出さない
    armor = json.loads((REPO / "data" / "armor.json").read_text(encoding="utf-8"))["armor"]
    unknown = next((a for a in armor if a.get("part") == "chest" and a.get("slotsLimitBreak") is None), None)
    if unknown:
        page.evaluate("async (id) => (await import('./app/state.js')).setArmor('chest', id)", unknown["id"])
        page.wait_for_timeout(100)
        if page.locator(f'{P} [data-eq-part="chest"] .toggle').count():
            ctx.fail(f"限界突破の後が分からない防具 ({unknown['name']}) に「限界突破」が出ています")
        page.evaluate("async () => (await import('./app/state.js')).setArmor('chest', null)")

    # --- 装飾品: 頭のスロット 1 (Lv2) は防具用の Lv2 以下だけ。武器のスロット (Lv3) は武器用だけ
    _equip_open_picker(page, f'{P} [data-eq-slot="head:0"]')
    groups = set(page.locator(".sheet .picker-group").all_inner_texts())
    if not groups or not groups <= {"スロット Lv2 の装飾品", "スロット Lv1 の装飾品"}:
        ctx.fail(f"頭の Lv2 スロットに入らない装飾品が候補に出ています: {groups}")
    decos = json.loads((REPO / "data" / "decorations.json").read_text(encoding="utf-8"))["decorations"]
    want = sum(1 for d in decos if d["kind"] == "armor" and d["slot"] <= 2)
    got = int(page.inner_text(".picker-count").split()[0])
    if got != want:
        ctx.fail(f"頭の Lv2 スロットの候補が {got} 件 (防具用 Lv2 以下は {want} 件)")
    page.locator(".sheet .picker-item:not(.picker-none)").first.click()
    page.wait_for_selector(".sheet .picker-list", state="detached")
    _equip_open_picker(page, f'{P} [data-eq-slot="weapon:0"]')
    want = sum(1 for d in decos if d["kind"] == "weapon" and d["slot"] <= 3)
    got = int(page.inner_text(".picker-count").split()[0])
    if got != want:
        ctx.fail(f"武器の Lv3 スロットの候補が {got} 件 (武器用 Lv3 以下は {want} 件)")
    check_layout(page, ctx, "装飾品を選ぶシート")
    page.wait_for_timeout(300)  # シートが下から出てくるのを待つ (画像のため)
    ctx.shot("equip-deco-picker", full_page=False)
    _equip_choose(page, "攻撃", "攻撃")
    st = _equip_state(page)
    if st["decos"]["head"][:1] == [None] or not st["decos"]["head"] or not st["decos"]["weapon"]:
        ctx.fail(f"選んだ装飾品が状態に入っていません: {st['decos']}")

    # --- 結果: スキル・シリーズ・空きスロット・エラーなし
    n_skills = page.locator(f'{P} [data-eq="skills"] .eq-skill').count()
    if n_skills < 2:
        ctx.fail(f"発動スキルが {n_skills} 個しか出ていません")
    page.locator(f'{P} [data-eq="skills"] .eq-skill-btn').first.click()
    if "出どころ" not in page.inner_text(f'{P} [data-eq="skills"]'):
        ctx.fail("スキルを押しても出どころが出ません")
    bonuses = page.inner_text(f'{P} [data-eq="bonuses"]') if page.locator(f'{P} [data-eq="bonuses"]').count() else ""
    if "火竜の力" not in bonuses or "部位" not in bonuses:
        ctx.fail(f"武器に付けたシリーズスキル (1 部位) が出ていません: {bonuses!r}")
    if "使用" not in page.inner_text(f'{P} [data-eq="free-slots"]'):
        ctx.fail("空きスロットが出ていません")
    if page.locator(f'{P} [data-eq="issues"] .notice-error').count():
        ctx.fail(f"入る装飾品だけを選んだのにエラーが出ています: {page.inner_text(f'{P} [data-eq=issues]')}")

    # --- 火力の要約: 期待値・スキルなし比・既定の肉質の案内 (相手のデータは読まない)
    page.wait_for_selector(f'{P} [data-eq="power-result"]', timeout=10000)
    power = page.inner_text(f'{P} [data-eq="power"]')
    num = page.inner_text(f'{P} .eq-power-num').replace(",", "")
    try:
        ok_num = float(num) > 0
    except ValueError:
        ok_num = False
    if not ok_num or "スキルなし比" not in power or "切断 45・打撃 45・属性 20" not in power:
        ctx.fail(f"火力の要約が出ていません: {power[:200]!r}")
    if not page.locator(f'{P} [data-eq="to-power"]').count():
        ctx.fail("火力タブへのボタンがありません")
    # 上に貼りつく要約: 期待値が火力の要約と同じで、押すと火力の要約へ移る
    bar = page.inner_text(f'{P} [data-eq="summary-bar"]') if page.locator(f'{P} [data-eq="summary-bar"]').count() else ""
    if page.inner_text(f'{P} .eq-power-num') not in bar or "スキル" not in bar:
        ctx.fail(f"上の要約 (期待値・スキルの数) が出ていません: {bar!r}")
    page.evaluate("window.scrollTo(0, 0)")
    page.click(f'{P} [data-eq="jump-power"]')
    try:
        page.wait_for_function("""() => { const r = document.getElementById('eq-power').getBoundingClientRect();
          return r.top >= 0 && r.top < window.innerHeight / 2; }""", timeout=5000)
    except Exception:
        ctx.fail("上の要約を押しても「火力の要約」へ移りません")
    check_layout(page, ctx, "装備を選んだ装備タブ")
    ctx.shot("equip-filled")

    # --- 武器を替えても、新しい武器のスロットに入る装飾品は残る。入らないものは知らせて「元に戻す」で戻せる
    before = _equip_state(page)["decos"]["weapon"]
    prev_weapon = _equip_state(page)["weapon"]
    info = page.evaluate("""async () => { const D = await import('./app/data.js'); const S = await import('./app/state.js');
      const d = D.getCoreData(); const w = d.lists.weapons.find((x) => x.slots[0] === 1 && !x.slots[1]);
      const deco = S.getState().build.decorations.weapon.find((x) => x != null);
      return w ? { label: w.displayName || w.name, decoSlot: deco != null ? d.index.decorations.get(deco).slot : null } : null; }""")
    if info and info["decoSlot"]:
        _equip_open_picker(page, f'{P} [data-eq="weapon"]')
        page.fill(".sheet input[type=search]", info["label"])
        page.locator(".sheet .picker-item:not(.picker-none)").filter(
            has=page.locator(".picker-label", has_text=re.compile(f"^{re.escape(info['label'])}$"))).first.click()
        page.wait_for_selector(".sheet .picker-list", state="detached")
        if info["decoSlot"] > 1:
            try:
                page.wait_for_selector(".toast-host .toast-action", timeout=5000)
                if "外しました" not in page.inner_text(".toast-host"):
                    ctx.fail(f"入らない装飾品を外した知らせの文が違います: {page.inner_text('.toast-host')!r}")
                ctx.shot("equip-deco-removed-toast", full_page=False)
                page.click(".toast-host .toast-action")
                page.wait_for_timeout(200)
                st = _equip_state(page)
                if st["weapon"] != prev_weapon or st["decos"]["weapon"] != before:
                    ctx.fail(f"「元に戻す」で武器と装飾品が戻りません: {st['weapon']} {st['decos']['weapon']} (前 {prev_weapon} {before})")
            except Exception as e:
                ctx.fail(f"武器を替えて装飾品が入らないときに知らせ (元に戻す) が出ません: {str(e).splitlines()[0]}")
        else:
            st = _equip_state(page)
            if [x for x in st["decos"]["weapon"] if x is not None] != [x for x in before if x is not None][:1]:
                ctx.fail(f"武器を替えたら、入るはずの装飾品まで外れました: {st['decos']['weapon']} (前 {before})")
            page.evaluate("""async ([w, d]) => (await import('./app/state.js')).setWeapon(w, { decorations: d })""",
                          [prev_weapon, before])

    # --- マイセット: 保存 → 全部外す → 呼び出す → 消す
    page.fill(f'{P} [data-eq="myset-name"]', "スモークのセット")
    page.click(f'{P} [data-eq="myset-save"]')
    page.wait_for_selector(f'{P} [data-eq="myset-list"] .row')
    if "使用中" not in page.inner_text(f'{P} [data-eq="myset-list"]'):
        ctx.fail("保存したばかりのセットに「使用中」が出ていません")
    if page.input_value(f'{P} [data-eq="myset-name"]'):
        ctx.fail("保存したあと、セットの名前の欄が空に戻っていません")
    page.evaluate("async () => (await import('./app/state.js')).clearBuild()")
    page.wait_for_function("""() => !document.querySelector('[data-tab-panel="equip"] [data-eq-deco]')""", timeout=5000)
    page.locator(f'{P} [data-eq="myset-list"] .row', has_text="スモークのセット").click()
    page.wait_for_selector('[data-eq="myset-sheet"]')
    page.wait_for_timeout(400)  # シートが下から出てくるのを待つ (画像のため)
    check_layout(page, ctx, "マイセットのシート")
    ctx.shot("equip-myset-sheet", full_page=False)
    page.click('[data-eq="myset-load"]')
    page.wait_for_selector('[data-eq="myset-sheet"]', state="detached")
    st = _equip_state(page)
    if not (isinstance(st["weapon"], str) and st["head"] is not None and st["lb"] is True):
        ctx.fail(f"マイセットを呼び出しても装備が戻りません: {st}")
    page.locator(f'{P} [data-eq="myset-list"] .row', has_text="スモークのセット").click()
    page.wait_for_selector('[data-eq="myset-sheet"]')
    page.click('[data-eq="myset-delete"]')
    page.click('[data-eq="myset-delete-yes"]')
    page.wait_for_selector('[data-eq="myset-sheet"]', state="detached")
    if _equip_state(page)["sets"]:
        ctx.fail(f"マイセットを消せません: {_equip_state(page)['sets']}")

    # --- 足した武器を消す (2 回押す) と、装備から外れる
    page.click(f'{P} [data-eq="artian-edit"]')
    page.wait_for_selector(f'{P} [data-eq="artian-edit-form"]')
    check_layout(page, ctx, "足した武器を直す")
    page.click(f'{P} [data-eq="artian-delete"]')
    page.click(f'{P} [data-eq="artian-delete-yes"]')
    page.wait_for_function("""() => !document.querySelector('[data-tab-panel="equip"] [data-eq="artian-edit-form"]')""",
                           timeout=5000)
    st = _equip_state(page)
    if st["weapon"] is not None or st["mine"]:
        ctx.fail(f"足した武器を消しても残っています: {st['weapon']} / {st['mine']}")
    _equip_reset(page)


# ---------------------------------------------------------------- 火力タブ・相手タブ (担当: tab-power)

POWER_PANEL = '[data-tab-panel="power"]'
TARGET_PANEL = '[data-tab-panel="target"]'
ELEM_JA = {"fire": "火", "water": "水", "thunder": "雷", "ice": "氷", "dragon": "龍"}

# 確認の前に状態を写し、確認の後に戻す (ほかの確認に影響を残さない)
JS_STATE_SNAPSHOT = """async () => { const S = await import('./app/state.js'); return JSON.parse(JSON.stringify(S.getState())); }"""
JS_STATE_RESTORE = """async (snap) => { const S = await import('./app/state.js'); const D = await import('./app/store.js');
  await D.kvSet(S.STATE_KEY, snap); await S.reloadState(); }"""

# 火の片手剣 + 連撃 (段階の条件)・弱点特効・火竜の力 (確度 low = 未確定) が付く防具。名前で探す (id は MHDB の採番)
JS_POWER_SETUP = """async () => {
  const S = await import('./app/state.js'); const D = await import('./app/data.js');
  const data = D.getCoreData();
  const w = data.lists.weapons.find((x) => x.name === '炎尾剣フォルナクス')
    || data.lists.weapons.find((x) => x.element && x.element.type === 'fire');
  const armor = (name) => { const a = data.lists.armor.find((x) => x.name === name); return a ? a.id : null; };
  S.setWeapon(w.id);
  S.setArmor('head', armor('護兇爪竜ヘルムβ')); S.setArmor('chest', armor('護火竜メイルβ'));
  S.setArmor('arms', armor('護火竜アームβ')); S.setArmor('waist', armor('護兇爪竜コイルβ'));
  S.setArmor('legs', armor('護火竜グリーヴβ'));
  return w.id;
}"""

# 画面と同じ入力で damage.js を直接呼んだ期待値。parts = [{w, hitzone, wound, isWound} | {w, default: true}] (割合で加重平均)
JS_POWER_EXPECT = """async (parts) => {
  const S = await import('./app/state.js'); const D = await import('./app/data.js');
  const B = await import('./app/model/build.js'); const M = await import('./app/model/damage.js');
  const L = await import('./app/ui/tabs/equip_logic.js');
  const T = await import('./app/ui/tabs/target_mix.js');
  const data = D.getCoreData(); const st = S.getState();
  const build = B.computeBuild(st.build, data.index);
  const w = L.resolveWeaponRef(st.build.weapon, data.index);
  const hid = L.handicraftSkillId(data.index);
  const lvOf = (skills) => Object.fromEntries(skills.map((s) => [s.skillId, s.level]));
  const sharpOf = (skills) => st.sharpness || L.autoSharpness(w, data.index, lvOf(skills)).color || 'white';
  const list = build.skills.map((s) => ({ skillId: s.skillId, level: s.level }));
  const input = { weapon: L.damageWeapon(w), uptimes: st.uptimes, effects: data.skillEffects, motions: data.motions,
    combo: S.resolveCombo(st.combo, data.combos), monsterStatus: T.monsterStatusOf(st.target, D.getTargetData()) || [] };
  const tg = (p) => (p.default ? { ...L.DEFAULT_TARGET, isWound: !!st.target.isWound }
    : { hitzone: p.hitzone, wound: p.wound ?? null, isWound: !!p.isWound });
  const one = (skills, p) => M.comboExpected({ ...input, skills, sharpness: sharpOf(skills), target: tg(p) });
  const sum = parts.reduce((a, p) => a + p.w, 0);
  let total = 0; let none = 0;
  for (const p of parts) {
    total += (p.w / sum) * one(list, p).total;
    none += (p.w / sum) * one([], p).total;
  }
  const base = one(list, parts[0]);
  const drops = list.filter((s) => data.skillEffects.effects[String(s.skillId)] || s.skillId === hid)
    .filter((s) => !base.unsupported.some((u) => u.skillId === s.skillId))
    .map((s) => ({ name: (data.skillEffects.effects[String(s.skillId)] || { name: '匠' }).name,
                   drop: 1 - one(list.filter((o) => o.skillId !== s.skillId), parts[0]).total / base.total }))
    .sort((a, b) => b.drop - a.drop);
  return { total, vs: (total / none - 1) * 100, top: drops.length ? drops[0].name : null };
}"""

# スライダー (input[type=range]) に値を入れて input を起こす
JS_SET_RANGE = """([sel, v]) => { const el = document.querySelector(sel); if (!el) return false;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(el, String(v)); el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true })); return true; }"""


def _power_total(page):
    v = page.get_attribute(f"{POWER_PANEL} [data-power-total]", "data-power-total")
    return float(v) if v not in (None, "") else None


def _close(a, b, rel=1e-6):
    return a is not None and b is not None and abs(a - b) <= rel * max(1.0, abs(b))


def _app_state(page, expr: str):
    """state の一部を読む。expr は s (状態) を使った JS の式 (例 's.target')。"""
    return page.evaluate(f"async () => {{ const s = (await import('./app/state.js')).getState(); return {expr}; }}")


@tab_check("power")
def power_tab_expected_value(page, ctx: Ctx):
    """火力タブ: DPS でない旨の説明 → 装備を入れると期待値・スキルなし比が damage.js と合い、発動率 (仮) を動かすと変わり、
    効き目の並び・未確定・未対応・スキル火力表が出る。"""
    text = page.inner_text(POWER_PANEL)
    if "1 秒あたりの火力 (DPS) ではなく、コンボ 1 回あたりの期待値です" not in text:
        ctx.fail("火力タブに「1 秒あたりの火力 (DPS) ではなく…」の説明が出ていません")
    snap = page.evaluate(JS_STATE_SNAPSHOT)
    try:
        if snap["build"]["weapon"] is None and "武器を選んでいません" not in text:
            ctx.fail("火力タブ: 武器が無いときの案内が出ていません")
        page.evaluate(JS_POWER_SETUP)
        page.wait_for_selector(f"{POWER_PANEL} [data-power-total]", timeout=10000)
        exp = page.evaluate(JS_POWER_EXPECT, [{"w": 1, "default": True}])
        total = _power_total(page)
        if not _close(total, exp["total"]):
            ctx.fail(f"火力タブの期待値が damage.js と合いません: 画面 {total} / 計算 {exp['total']}")
        vs = page.get_attribute(f"{POWER_PANEL} [data-power-vs]", "data-power-vs")
        if not _close(float(vs or "nan"), exp["vs"]):
            ctx.fail(f"火力タブのスキルなし比が damage.js と合いません: 画面 {vs} / 計算 {exp['vs']}")
        if "既定の肉質" not in page.inner_text(f"{POWER_PANEL} [data-power-target]"):
            ctx.fail("相手を選んでいないのに「既定の肉質」と出ていません")
        # 灼熱化 (火竜の力) の説明: この連携を続けたときの間隔 (結論)・判定は前の判定から 2.4 秒たつまで起きないこと・
        # 技のつなぎの秒数が見積もりであること (2026-10-24。技が 1 つのコンボは「この技を続けて出すと」)
        hint = page.locator(f"{POWER_PANEL} [data-power-extra-hint]")
        hint_text = hint.inner_text() if hint.count() else ""
        if ("この連携を続けると約" not in hint_text and "この技を続けて出すと約" not in hint_text) \
                or "前の判定から 2.4 秒たつまでは判定しません" not in hint_text or "技のつなぎの秒数は見積もりです" not in hint_text:
            ctx.fail(f"火力タブに灼熱化の説明 (約 N 秒に 1 回・判定の待ち・見積もり) が出ていません: {hint_text!r}")
        # 発動率: 連撃の段は本人の前提 (2026-10-22: 5 ヒット以降段 100%。仮ではない) → 「仮」の印は無く、根拠の文が出る。
        # スライダーで 1〜4 段を 30% にすると期待値が変わり、「既定に戻す」が出る
        chain = f'{POWER_PANEL} [data-condition="chain"]'
        if not page.locator(chain).count():
            ctx.fail("連撃の発動率 (条件 chain) の欄がありません")
        else:
            if "仮" in page.inner_text(f"{chain} .pw-cond-title"):
                ctx.fail("本人の前提の発動率 (連撃) に「仮」の印が付いています")
            if "基本発動する前提で計算" not in page.inner_text(chain):
                ctx.fail("連撃の発動率に本人の前提の根拠の文が出ていません")
            page.evaluate(JS_SET_RANGE, [f"{chain} input[type=range]", 0.3])
            page.wait_for_function(
                "(v) => Number(document.querySelector('[data-tab-panel=\"power\"] [data-power-total]').dataset.powerTotal) !== v",
                arg=total, timeout=5000)
            up = _app_state(page, "s.uptimes.chain")
            if not isinstance(up, dict) or up.get("hit1to4") != 0.3 or up.get("hit5plus") != 0.7:
                ctx.fail(f"連撃のスライダーが state.uptimes に入っていません: {up}")
            if "既定に戻す" not in page.inner_text(chain):
                ctx.fail("発動率を入れた後に「既定に戻す」がありません")
            exp = page.evaluate(JS_POWER_EXPECT, [{"w": 1, "default": True}])
            if not _close(_power_total(page), exp["total"]):
                ctx.fail(f"発動率を変えた後の期待値が damage.js と合いません: 画面 {_power_total(page)} / 計算 {exp['total']}")
        # スキルごとの効き目: 一番上が damage.js の skillContribution の一番上と同じ
        names = page.locator(f"{POWER_PANEL} [data-power-contrib] .pw-contrib-name")
        if not names.count():
            ctx.fail("スキルごとの効き目の一覧がありません")
        elif exp["top"] and not names.first.inner_text().startswith(exp["top"]):
            ctx.fail(f"効き目の一番上が {names.first.inner_text()!r} (計算では {exp['top']})")
        if "未確定の値で計算したスキル" not in page.inner_text(POWER_PANEL):
            ctx.fail("確度 low のスキル (火竜の力) に「未確定」の案内が出ていません")
        # スキル火力表: 行が出て、未対応のスキルが分けて出る
        page.wait_for_selector(f"{POWER_PANEL} [data-power-table] tr[data-skill-row]", timeout=20000)
        n = page.locator(f"{POWER_PANEL} [data-power-table] tr[data-skill-row]").count()
        if n < 20:
            ctx.fail(f"スキル火力表の行が少ない ({n} 行)")
        if not page.locator(f"{POWER_PANEL} [data-power-unsupported]").count():
            ctx.fail("スキル火力表に「未対応 (計算に入れていません)」の一覧がありません")
        # 仮置きの条件のスキル (火事場力) には「(仮)」、本人の前提の挑戦者 (怒り 100%) には付かない
        ids = page.evaluate("""async () => { const D = await import('./app/data.js'); const s = D.getCoreData().lists.skills;
          const id = (n) => (s.find((x) => x.name === n) || {}).id; return { hl: id('火事場力'), ch: id('挑戦者') }; }""")
        hl_row = page.locator(f'{POWER_PANEL} [data-power-table] tr[data-skill-row="{ids["hl"]}"] .pw-name')
        ch_row = page.locator(f'{POWER_PANEL} [data-power-table] tr[data-skill-row="{ids["ch"]}"] .pw-name')
        if not hl_row.count() or "(仮)" not in hl_row.inner_text():
            ctx.fail("スキル火力表の火事場力 (仮置きの条件) に「(仮)」がありません")
        if not ch_row.count() or "(仮)" in ch_row.inner_text() or "100%" not in ch_row.inner_text():
            ctx.fail(f"スキル火力表の挑戦者 (本人の前提 100%) の書き方が違います: {ch_row.inner_text() if ch_row.count() else 'なし'}")
        check_layout(page, ctx, "火力タブ (装備あり)")
        ctx.shot("power-with-build")
        # 火でない武器 (龍属性) + 火竜の力: 火属性攻撃強化は灼熱化の火の分に効くので、表に残して注記を出す。
        # 外した一覧には入れない (点検 2026-10-24。前は「武器の属性と合わないので表から外した」と出ていた)
        fid = page.evaluate("""async () => { const S = await import('./app/state.js'); const D = await import('./app/data.js');
          const data = D.getCoreData(); const w = data.lists.weapons.find((x) => x.element && x.element.type === 'dragon');
          S.setWeapon(w.id); return (data.lists.skills.find((x) => x.name === '火属性攻撃強化') || {}).id; }""")
        fire_note = f'{POWER_PANEL} [data-power-table] tr[data-skill-row="{fid}"] [data-extra-only]'
        try:
            page.wait_for_selector(fire_note, timeout=20000)
        except Exception:
            ctx.fail("龍属性の武器 + 火竜の力 で、スキル火力表に火属性攻撃強化の行 (灼熱化の火の分だけ) が出ていません")
        else:
            if "灼熱化" not in page.inner_text(fire_note):
                ctx.fail(f"火属性攻撃強化の行の注記が違います: {page.inner_text(fire_note)!r}")
            other = page.locator(f"{POWER_PANEL} [data-power-other-element]")
            if other.count() and "火属性攻撃強化" in other.inner_text():
                ctx.fail(f"火竜の力があるのに、火属性攻撃強化を「表から外したスキル」に出しています: {other.inner_text()!r}")
            ctx.shot("power-dragon-scorch-table")
    finally:
        page.evaluate(JS_STATE_RESTORE, snap)


@tab_check("target")
def target_tab_pick_monster_and_parts(page, ctx: Ctx):
    """相手タブ: ひらがなで探して選ぶ → 部位の一覧 (部位不明は隠す・弱点の印) → おすすめ属性・咆哮など (出典つき) →
    部位不明を出す → 割合で混ぜる → 属性やられの「要確認」→ 手入力 (全角数字)。"""
    snap = page.evaluate(JS_STATE_SNAPSHOT)
    try:
        md = page.evaluate("""async () => { const D = await import('./app/data.js'); const t = D.getTargetData();
          const m = t.lists.monsters.find((x) => x.name === 'レ・ダウ');
          return { id: m.id, best: m.elementRecommendation.best,
                   parts: m.parts.map((p) => ({ key: p.key, unknown: !!p.unknownPart, slash: p.hitzone.slash,
                                                blunt: p.hitzone.blunt })) }; }""")
        page.click(f"{TARGET_PANEL} .picker-field .row")
        page.wait_for_selector(".sheet .picker-list")
        page.wait_for_timeout(150)  # 開いたときに検索欄を空にする処理の後で打つ
        page.fill(".sheet input[type=search]", "れだう")
        page.wait_for_function("document.querySelector('.picker-count').textContent.trim().startsWith('1 ')")
        page.click(".sheet .picker-item >> nth=0")
        page.wait_for_selector(".sheet", state="detached")
        page.wait_for_selector(f"{TARGET_PANEL} [data-target-parts] [data-part]")
        st = _app_state(page, "s.target")
        if st["monsterId"] != md["id"] or not st["partKey"]:
            ctx.fail(f"モンスターを選んでも state.target に入っていません: {st}")
        shown = page.eval_on_selector_all(f"{TARGET_PANEL} [data-target-parts] [data-part]", "els => els.map((e) => e.dataset.part)")
        named = [p["key"] for p in md["parts"] if not p["unknown"]]
        if sorted(shown) != sorted(named):
            ctx.fail(f"部位の一覧が「部位不明を隠した一覧」になっていません: {shown}")
        for p in md["parts"]:
            if p["unknown"]:
                continue
            has = "弱点" in page.inner_text(f'{TARGET_PANEL} [data-part="{p["key"]}"]')
            if has != (p["slash"] >= 45 or (p["blunt"] or 0) >= 45):
                ctx.fail(f"部位 {p['key']} (切断 {p['slash']}・打撃 {p['blunt']}) の弱点の印が {'ある' if has else '無い'}")
        reco = page.inner_text(f"{TARGET_PANEL} [data-target-reco]")
        if not all(ELEM_JA.get(b, b) in reco for b in md["best"]):
            ctx.fail(f"おすすめの属性 {md['best']} が出ていません: {reco!r}")
        panel_text = page.inner_text(TARGET_PANEL)
        for word in ["咆哮", "風圧", "振動", "属性やられ", "状態異常", "Monster Hunter Wiki", "CC BY-SA 4.0"]:
            if word not in panel_text:
                ctx.fail(f"相手タブに「{word}」が出ていません")
        unknown_n = sum(1 for p in md["parts"] if p["unknown"])
        if unknown_n:
            page.click(f'{TARGET_PANEL} .toggle:has-text("部位不明も出す")')
            n = page.locator(f"{TARGET_PANEL} [data-target-parts] [data-part]").count()
            if n != len(md["parts"]):
                ctx.fail(f"部位不明も出すにしても {n} / {len(md['parts'])} 部位しか出ません")
        # 割合で混ぜる: もう 1 部位を足すと割合のつまみが出て、tabs.target.mix に入る
        page.click(f'{TARGET_PANEL} .toggle:has-text("割合で混ぜる")')
        other = next(k for k in named if k != st["partKey"])
        page.click(f'{TARGET_PANEL} [data-part="{other}"]')
        page.wait_for_selector(f"{TARGET_PANEL} .tg-mix-slider")
        mix = _app_state(page, "s.tabs.target && s.tabs.target.mix")
        if not (mix and mix.get("on") and mix.get("monsterId") == md["id"]
                and set(mix.get("weights", {})) == {st["partKey"], other}):
            ctx.fail(f"割合で混ぜる指定が state.tabs.target.mix に入っていません: {mix}")
        check_layout(page, ctx, "相手タブ (割合で混ぜる)")
        ctx.shot("target-mix")
        # 割合のつまみ: つまみの値がその部位の割合そのもの (2 部位なら、もう一方は残り)
        sliders = page.locator(f"{TARGET_PANEL} .tg-mix-slider input[type=range]")
        if sliders.count() == 2:
            page.evaluate(JS_SET_RANGE, [f"{TARGET_PANEL} .tg-mix-slider input[type=range]", 0.6])
            page.wait_for_timeout(300)
            shown = page.locator(f"{TARGET_PANEL} .tg-mix-slider .slider-value").all_inner_texts()
            if shown != ["全体の 60%", "全体の 40%"]:
                ctx.fail(f"割合のつまみを 60% にしても、表示が 60% / 40% になりません: {shown}")
        # 攻撃の属性はあるのに属性やられが未確認のモンスター → 「未確認」
        bid = page.evaluate("""async () => { const D = await import('./app/data.js'); const S = await import('./app/state.js');
          const row = D.getTargetData().lists.threats.find((x) => (x.blightsUncertain || []).length);
          if (!row) return null; S.selectMonster(row.monsterId); return row.monsterId; }""")
        if bid is not None:
            page.wait_for_selector(f"{TARGET_PANEL} [data-target-blights]")
            if "未確認" not in page.inner_text(f"{TARGET_PANEL} [data-target-blights]"):
                ctx.fail("属性やられが未確認 (blightsUncertain) なのに「未確認」と出ていません")
        # 手入力: 全角数字を読む
        page.click(f"{TARGET_PANEL} .segment >> text=肉質を手入力")
        inp = page.locator(f"{TARGET_PANEL} .tg-grid .input-number").first
        inp.fill("６０")
        inp.blur()
        if _app_state(page, "s.target.manual.hitzone.slash") != 60:
            ctx.fail("手入力の切断肉質 (全角の ６０) が state に入っていません")
        check_layout(page, ctx, "相手タブ (手入力)")
    finally:
        page.evaluate(JS_STATE_RESTORE, snap)


# ---------------------------------------------------------------- 相手タブの段階 3 (担当: ui-target)
#
# docs/RECOMMEND_DESIGN.md 6.5 節の相手タブの分 (target_arch_tempered / target_multi_quest)。
# 個体・クエスト (既定の選び方・名前から選ぶ)・人数・体力と強さ・討伐までの回数・歴戦王で変わること・このクエストの相手 (多頭)・
# 「この相手で装備を探す」の受け渡し・保存して開き直す・文字を大きくしたとき を確かめる。
# 数字は 2026-10-21 のデータ (quests.json の healthCalc)。データが変わったら TH_* を直す。

TH_HEALTH = f'{TARGET_PANEL} [data-th-card="health"]'
# 歴戦王アルシュベルドの既定のクエスト (id, 名前, 体力, 範囲の表示, 4 人の体力)
TH_AT_QUEST = ("Freedom from Solitude", "孤独から出でし君という自由", 79923, "76,726〜83,120", 239769)
# 装備固定のクエスト (検索語, id, 体力)
TH_FIXED_QUEST = ("解鎖", "Event: Unchained Arkveld", 28944)
# 多頭のクエスト (検索語, id, 相手の体力の並び)
TH_MULTI_QUEST = ("英雄の証", "Proof of a Hero", [32850, 46574, 40242, 71701])

JS_TH_RESET = """async () => { const S = await import('./app/state.js'); const H = await import('./app/ui/tabs/target_hunt.js');
  H.setPlanBuilderForTest(null);
  S.setTabState('target', { mix: null, memo: null }); S.setTargetMode('monster'); S.selectMonster(null);
  S.setWound(false); S.setPlayers(1); S.setUseUncertainWound(false); }"""

# 「この相手で装備を探す」で置かれる印を、探すタブが受け取って消す前に写しておく
JS_TH_WATCH_AUTOSTART = """async () => { const S = await import('./app/state.js');
  if (window.__thOff) window.__thOff();
  window.__thAuto = [];
  window.__thOff = S.subscribe((s) => { if (s.search.autoStart) window.__thAuto.push({ ...s.search.autoStart, useTarget: s.search.useTarget }); });
}"""
JS_TH_TAKE_AUTOSTART = """() => { if (window.__thOff) window.__thOff(); window.__thOff = null; return window.__thAuto || []; }"""

# docs/RECOMMEND_DESIGN.md 5.3 節の形の作り物の Plan (buildPlan ができるまでの見た目の確認用)
JS_TH_FAKE_PLAN = """async () => { const H = await import('./app/ui/tabs/target_hunt.js'); const D = await import('./app/data.js');
  const roar = D.getTargetData().threats.rules.roar.weak;
  H.setPlanBuilderForTest(({ target }) => {
    const key = `${target.monsterId}:arch-tempered#0`;
    return {
      subjects: [{ key, monsterId: target.monsterId, kind: 'arch-tempered', name: 'ヌ・エグドラ（歴戦王）', health: null,
                   targets: [], element: null, threats: [] }],
      element: { mode: 'element', weapons: [], twoWeapons: { suggested: false, groups: [] },
                 perSubject: [{ key, view: { kind: 'clear', best: ['water'], top: 30, gap: 8, weapon: 'other' } }] },
      requirements: [
        { key: 'hazard:ignited-aura', label: '環境適応 Lv2', options: [[{ skillId: 88, level: 2 }]], tier: 'on', defaultOn: true,
          on: true, why: [{ subjectKey: key, text: '点火中にまとう炎' }], provisional: true, unconfirmed: false,
          mitigateLevel: null, negateLevel: 2 },
        { key: 'roar', label: `${roar.skill} Lv${roar.negateLevel}`, options: [[{ skillId: roar.skillId, level: roar.negateLevel }]],
          tier: 'ref', defaultOn: false, on: false, why: [{ subjectKey: key, text: '咆哮【小】' }], provisional: true,
          unconfirmed: true, mitigateLevel: null, negateLevel: roar.negateLevel },
      ],
      notes: [{ subjectKey: key, text: '作り物の注意 (防げない攻撃)', oneShot: true, source: '' }],
      exclusions: { armor: [], charmsFixed: [], labels: [] }, weights: [], warnings: [], license: [],
    };
  });
}"""

# 雷の片手剣 (ウズ・トゥナの歴戦王の傷口は雷 25→20 に置き換わる。火の武器では差が出ない)
JS_TH_THUNDER_WEAPON = """async () => { const S = await import('./app/state.js'); const D = await import('./app/data.js');
  const w = D.getCoreData().lists.weapons.find((x) => x.element && x.element.type === 'thunder');
  S.setWeapon(w.id); return w.id; }"""


def _th_pick_monster(page, search: str, name: str):
    """モンスター欄を開き、search で探して、名前がちょうど name の候補を選ぶ。"""
    page.locator(f"{TARGET_PANEL} .picker-field .row").first.click()
    page.wait_for_selector(".sheet .picker-list")
    page.wait_for_timeout(150)
    page.fill(".sheet input[type=search]", search)
    page.locator(".sheet .picker-item").filter(
        has=page.locator(".picker-label", has_text=re.compile(f"^{re.escape(name)}$"))).first.click()
    page.wait_for_selector(".sheet", state="detached")


def _th_individual(page, label: str):
    page.locator(f"{TARGET_PANEL} [data-th-individual] .segment", has_text=re.compile(f"^{re.escape(label)}$")).click()


def _th_players(page, n: int):
    page.locator(f"{TARGET_PANEL} [data-th-players] .segment", has_text=re.compile(f"^{n} 人$")).click()


def _th_attr(page, sel: str, name: str):
    return page.get_attribute(f"{TH_HEALTH} {sel}", name)


def _th_wait_attr(page, sel: str, name: str, value: str, timeout=10000):
    page.wait_for_function(
        "([s, n, v]) => { const e = document.querySelector(s); return !!e && e.getAttribute(n) === v; }",
        arg=[f"{TH_HEALTH} {sel}", name, value], timeout=timeout)


def _th_quest_field(page):
    return page.locator(f"{TARGET_PANEL} .picker-field",
                        has=page.locator(".row-label", has_text=re.compile("^クエスト$"))).locator(".row").first


def _th_choose_in_sheet(page, search: str, label: str, ctx: Ctx | None = None, shot: str | None = None):
    """開いたシートで search で探して、名前がちょうど label の候補を選ぶ (shot があれば探す前のシートを写す)。"""
    page.wait_for_selector(".sheet .picker-list")
    page.wait_for_timeout(150)
    if ctx and shot:
        check_layout(page, ctx, f"相手タブのシート ({shot})")
        ctx.shot(shot, full_page=False)
    page.fill(".sheet input[type=search]", search)
    page.locator(".sheet .picker-item:not(.picker-none)").filter(
        has=page.locator(".picker-label", has_text=re.compile(f"^{re.escape(label)}$"))).first.click()
    page.wait_for_selector(".sheet", state="detached")


def _th_zoom_layout(page, ctx: Ctx, where: str, shot: str):
    """文字を大きくしたとき (Safari の表示の拡大 125% ≒ 幅 375px の 0.8 = 300px) にも横にはみ出さない。"""
    vp = page.viewport_size
    try:
        page.set_viewport_size({"width": 300, "height": vp["height"]})
        page.wait_for_timeout(200)
        check_layout(page, ctx, f"{where} (幅 300px = 文字を大きくしたとき)")
        ctx.shot(shot)
    finally:
        page.set_viewport_size(vp)


@scenario_check
def target_arch_tempered(page, ctx: Ctx):
    """相手タブ: アルシュベルド → 歴戦王 → 既定のクエスト → 体力と範囲 → 4 人で倍率 (未確定) → 攻撃の強さ (未確定) →
    討伐までの回数 = 体力 ÷ 火力タブの期待値 → 歴戦王で変わること (出典) → 開き直しても残る → 装備固定のクエストで体力が変わり
    探すボタンが出ない → ウズ・トゥナの歴戦王で傷口に「未確認」・火力タブも置き換え後の傷口 → ヌ・エグドラの歴戦王で
    作り物の Plan の見た目と「この相手で装備を探す」(探すタブへ移り、自動で探し始める印が置かれる)。"""
    snap = page.evaluate(JS_STATE_SNAPSHOT)
    qid, qname, hp, hp_range, hp4 = TH_AT_QUEST
    try:
        page.evaluate(JS_POWER_SETUP)
        open_tab(page, "target")
        page.evaluate(JS_TH_RESET)
        # --- アルシュベルド → 歴戦王 → 既定のクエスト『孤独から出でし君という自由』
        _th_pick_monster(page, "あるしゅべるど", "アルシュベルド")
        # モンスター欄で選ぶと、通常の個体の既定のクエスト (2.2 節の規則) も選んでおく
        want_q = page.evaluate("""async () => { const D = await import('./app/data.js'); const H = await import('./app/model/hunt.js');
          const S = await import('./app/state.js'); return H.defaultQuestId(D.getTargetData(), S.getState().target.monsterId, null); }""")
        if _app_state(page, "s.target.questId") != want_q or want_q is None:
            ctx.fail(f"モンスターを選んでも通常の個体の既定のクエスト ({want_q}) になりません: {_app_state(page, 's.target.questId')}")
        _th_individual(page, "歴戦王")
        page.wait_for_selector(f"{TH_HEALTH} [data-th-health]", timeout=10000)
        st = _app_state(page, "s.target")
        if st["individual"] != "arch-tempered" or st["questId"] != qid:
            ctx.fail(f"歴戦王を選んでも既定のクエスト ({qid}) になりません: {st}")
        if qname not in page.inner_text(f"{TARGET_PANEL} .card:has([data-th-individual])"):
            ctx.fail(f"クエストの欄に「{qname}」が出ていません")
        health = page.inner_text(TH_HEALTH)
        if _th_attr(page, "[data-th-health]", "data-th-health") != str(hp) or f"{hp:,}" not in health or hp_range not in health:
            ctx.fail(f"体力に「{hp:,}」と「{hp_range}」が出ていません: {health[:160]!r}")
        # 討伐までの回数 = 体力 ÷ 火力タブの 1 コンボの期待値 (切り上げ)
        combos = _th_attr(page, "[data-th-combos]", "data-th-combos")
        value = float(_th_attr(page, "[data-th-combos]", "data-th-combo-value") or "nan")
        if "拘束・部位破壊・ダウン・状態異常" not in page.inner_text(f"{TARGET_PANEL} .card:has([data-th-card=\"health\"])"):
            ctx.fail("討伐までの回数に「拘束・部位破壊・ダウン・状態異常」を含まない目安である旨がありません")
        open_tab(page, "power")
        page.wait_for_selector(f"{POWER_PANEL} [data-power-total]", timeout=15000)
        pw_total = _power_total(page)
        if "アルシュベルド（歴戦王）" not in page.inner_text(f"{POWER_PANEL} [data-power-target]"):
            ctx.fail(f"火力タブの相手が歴戦王になっていません: {page.inner_text(f'{POWER_PANEL} [data-power-target]')!r}")
        open_tab(page, "target")
        if not _close(value, pw_total, rel=1e-9):
            ctx.fail(f"討伐までの回数に使った期待値 {value} が火力タブの期待値 {pw_total} と違います")
        if not combos or int(combos) != int(-(-hp // pw_total)):  # 切り上げ
            ctx.fail(f"討伐までの回数 {combos} が 体力 {hp} ÷ 期待値 {pw_total} の切り上げと違います")
        # --- 4 人: 体力 × 3.0 = 239,769 (未確定)
        _th_players(page, 4)
        _th_wait_attr(page, "[data-th-total]", "data-th-total", str(hp4))
        health = page.inner_text(TH_HEALTH)
        if f"{hp4:,}" not in health or "未確定" not in health:
            ctx.fail(f"4 人のときの体力「{hp4:,}」と「未確定」が出ていません: {health[:200]!r}")
        if _app_state(page, "s.target.players") != 4:
            ctx.fail("人数を 4 人にしても state.target.players が 4 になりません")
        # 2 人: 倍率が変わる
        _th_players(page, 2)
        page.wait_for_function(
            "([s, v]) => { const e = document.querySelector(s); return !!e && e.getAttribute('data-th-total') !== v; }",
            arg=[f"{TH_HEALTH} [data-th-total]", str(hp4)], timeout=10000)
        t2 = int(_th_attr(page, "[data-th-total]", "data-th-total") or 0)
        if not (hp < t2 < hp4):
            ctx.fail(f"2 人のときの体力 {t2} が 1 人 ({hp}) と 4 人 ({hp4}) の間になりません")
        _th_players(page, 4)
        _th_wait_attr(page, "[data-th-total]", "data-th-total", str(hp4))
        atk = page.inner_text(f"{TH_HEALTH} [data-th-attack]")
        if "未確定" not in atk or "倍" not in atk:
            ctx.fail(f"攻撃の強さに「〇倍」と「未確定」が出ていません: {atk!r}")
        arch = page.inner_text(f'{TARGET_PANEL} [data-th-card="arch"]')
        for word in ["Monster Hunter Wiki", "CC BY-SA 4.0", "未確定"]:
            if word not in arch:
                ctx.fail(f"歴戦王で変わることに「{word}」がありません")
        check_layout(page, ctx, "相手タブ (歴戦王・4 人)")
        ctx.shot("target-at")
        _th_zoom_layout(page, ctx, "相手タブ (歴戦王)", "target-at-zoom")

        # --- 保存して開き直しても、個体・クエスト・人数が残る
        page.evaluate("async () => { const S = await import('./app/state.js'); await S.flushState(); }")
        page.reload(wait_until="load")
        wait_app_ready(page)
        open_tab(page, "target")
        page.wait_for_selector(f"{TH_HEALTH} [data-th-total]", timeout=15000)
        st = _app_state(page, "s.target")
        if (st["individual"], st["questId"], st["players"]) != ("arch-tempered", qid, 4) \
                or _th_attr(page, "[data-th-total]", "data-th-total") != str(hp4):
            ctx.fail(f"開き直したら個体・クエスト・人数が戻りません: {st}")
        if _app_state(page, "s.search.autoStart") is not None:
            ctx.fail("開き直しただけで「自動で探し始める」の印が残っています")

        # --- クエストを替えると体力が変わる (装備固定のクエスト: 探すボタンは出ず、理由が出る。人数は 2 人まで)
        search, fixed_id, fixed_hp = TH_FIXED_QUEST
        _th_quest_field(page).click()
        _th_choose_in_sheet(page, search, "イベント：解鎖のアルシュベルド", ctx, "target-quest-picker")
        _th_wait_attr(page, "[data-th-health]", "data-th-health", str(fixed_hp))
        if _app_state(page, "s.target.questId") != fixed_id:
            ctx.fail("クエストの欄で選んだクエストが state.target.questId に入っていません")
        text = page.inner_text(TARGET_PANEL)
        if "装備が決められたクエスト" not in text:
            ctx.fail("装備固定のクエストで「装備が決められたクエスト」の案内が出ていません")
        if page.locator(f"{TARGET_PANEL} [data-th-search]").count() or not page.locator(f"{TARGET_PANEL} [data-th-search-blocked]").count():
            ctx.fail("装備固定のクエストなのに「この相手で装備を探す」が出ています (または理由が出ていません)")
        n_players = page.locator(f"{TARGET_PANEL} [data-th-players] .segment").count()
        if n_players != 2:
            ctx.fail(f"2 人までのクエストなのに人数の選択肢が {n_players} 個あります")

        # --- ウズ・トゥナの歴戦王: 傷口に「未確認」。火力タブも置き換え後の傷口 (雷 25→20) で計算する
        page.evaluate(JS_TH_THUNDER_WEAPON)
        _th_pick_monster(page, "うず", "ウズ・トゥナ")
        _th_individual(page, "歴戦王")
        page.click(f'{TARGET_PANEL} [data-target-parts] [data-part="head"]')
        page.wait_for_selector(f'{TARGET_PANEL} [data-target-parts] ~ [data-th-wound-mark="unverified"]', timeout=10000)
        if "未確認" not in page.inner_text(f'{TARGET_PANEL} [data-th-wound-mark="unverified"] >> nth=0'):
            ctx.fail("ウズ・トゥナの歴戦王で、傷口の印「未確認」が出ていません")
        check_layout(page, ctx, "相手タブ (ウズ・トゥナの歴戦王)")
        ctx.shot("target-at-uth")
        page.locator(f'{TARGET_PANEL} .toggle:has-text("傷口を狙う")').click()
        uth = page.evaluate("""async () => { const D = await import('./app/data.js');
          const m = D.getTargetData().lists.monsters.find((x) => x.name === 'ウズ・トゥナ');
          const p = m.parts.find((x) => x.key === 'head');
          return { hitzone: p.hitzone, wound: m.individuals.find((i) => i.kind === 'arch-tempered').hitzone.woundOverrides.head,
                   base: p.wound }; }""")
        open_tab(page, "power")
        page.wait_for_function(
            "() => { const e = document.querySelector('[data-tab-panel=\"power\"] [data-power-target]');"
            " return !!e && e.textContent.includes('ウズ・トゥナ（歴戦王）'); }", timeout=15000)
        exp_ov = page.evaluate(JS_POWER_EXPECT, [{"w": 1, "hitzone": uth["hitzone"], "wound": uth["wound"], "isWound": True}])
        exp_base = page.evaluate(JS_POWER_EXPECT, [{"w": 1, "hitzone": uth["hitzone"], "wound": uth["base"], "isWound": True}])
        if not _close(_power_total(page), exp_ov["total"]):
            ctx.fail(f"ウズ・トゥナの歴戦王の頭の傷口: 火力タブ {_power_total(page)} が置き換え後の傷口の計算 {exp_ov['total']} と違います")
        if _close(exp_ov["total"], exp_base["total"]):
            ctx.note("ウズ・トゥナの歴戦王: 置き換え前後で期待値が同じでした (武器の属性を確かめてください)")
        open_tab(page, "target")
        page.locator(f'{TARGET_PANEL} .toggle:has-text("傷口を狙う")').click()

        # --- ヌ・エグドラの歴戦王: 本物の buildPlan の「この相手のおすすめ」(環境適応 Lv2 がオン) →
        #     作り物の Plan で見た目 (印・注意・いま) → 「この相手で装備を探す」
        page.evaluate(JS_POWER_SETUP)
        _th_pick_monster(page, "ぬえぐ", "ヌ・エグドラ")
        _th_individual(page, "歴戦王")
        page.wait_for_selector(f"{TARGET_PANEL} [data-th-search]", timeout=10000)
        page.wait_for_selector(f'{TARGET_PANEL} [data-th-card="plan"] [data-th-plan-on]', timeout=10000)
        real_on = page.inner_text(f'{TARGET_PANEL} [data-th-card="plan"] [data-th-plan-on]')
        for word in ["環境適応 Lv2", "火属性やられ"]:
            if word not in real_on:
                ctx.fail(f"本物の buildPlan の「この相手のおすすめ」の守りに「{word}」がありません: {real_on!r}")
        page.evaluate(JS_TH_FAKE_PLAN)
        page.wait_for_selector(f'{TARGET_PANEL} [data-th-card="plan"]', timeout=10000)
        plan_card = page.locator(f"{TARGET_PANEL} section.card", has=page.locator('[data-th-card="plan"]'))
        plan_text = plan_card.inner_text()
        for word in ["この相手のおすすめ", "仮", "環境適応 Lv2", "点火中にまとう炎", "守り", "参考", "未確認", "注意",
                     "作り物の注意", "水 (いまの武器は火。水の方が通る)", "いま"]:
            if word not in plan_text:
                ctx.fail(f"作り物の Plan の「この相手のおすすめ」に「{word}」が出ていません")
        if plan_card.locator("[data-th-search]").count() != 1:
            ctx.fail("「この相手のおすすめ」のカードに「この相手で装備を探す」がありません")
        check_layout(page, ctx, "相手タブ (この相手のおすすめ)")
        ctx.shot("target-plan")
        _th_zoom_layout(page, ctx, "相手タブ (この相手のおすすめ)", "target-plan-zoom")
        page.evaluate(JS_TH_WATCH_AUTOSTART)
        plan_card.locator("[data-th-search]").click()
        page.wait_for_selector('.app[data-active-tab="search"]', timeout=10000)
        seen = page.evaluate(JS_TH_TAKE_AUTOSTART)
        if not seen or seen[0].get("from") != "target" or seen[0].get("useTarget") is not True:
            ctx.fail(f"「この相手で装備を探す」で探すタブへの印 (search.autoStart) が置かれていません: {seen}")
        # 探すタブに 環境適応 Lv2 の行がオンで出て、自動で探し始める (探す流れは run_search の本物の Worker の節で確かめる。ここでは止める)
        page.wait_for_selector(f'{SEARCH_PANEL} [data-sr-req][data-sr-req-on="1"]', timeout=10000)
        if not page.locator(f'{SEARCH_PANEL} [data-sr-req][data-sr-req-on="1"]', has_text="環境適応").count():
            ctx.fail("「この相手で装備を探す」のあと、探すタブに 環境適応 Lv2 の行がオンで出ていません")
        page.wait_for_function("""async () => { const m = await import('./app/ui/tabs/search_client.js');
          const s = m.getSearchController().getSnapshot(); return s.busy || s.status !== 'idle'; }""", timeout=10000)
        page.evaluate("""async () => { const m = await import('./app/ui/tabs/search_client.js'); m.getSearchController().cancel(); }""")
        page.evaluate("async () => (await import('./app/ui/tabs/target_hunt.js')).setPlanBuilderForTest(null)")
        open_tab(page, "target")
    finally:
        page.evaluate("async () => (await import('./app/ui/tabs/target_hunt.js')).setPlanBuilderForTest(null)")
        page.evaluate(JS_STATE_RESTORE, snap)


@scenario_check
def target_multi_quest(page, ctx: Ctx):
    """相手タブ: 「クエストの名前から選ぶ」→『英雄の証』→ 4 体の行と全部倒すまでの回数 → 行をタップで相手が替わり、
    部位の選び方はモンスターごとに覚える → 「このクエストで装備を探す」。"""
    snap = page.evaluate(JS_STATE_SNAPSHOT)
    search, qid, hps = TH_MULTI_QUEST
    try:
        page.evaluate(JS_POWER_SETUP)
        open_tab(page, "target")
        page.evaluate(JS_TH_RESET)
        page.click(f"{TARGET_PANEL} [data-th-quest-by-name]")
        _th_choose_in_sheet(page, search, search, ctx, "target-quest-names")
        page.wait_for_selector(f'{TARGET_PANEL} [data-th-card="multi"] [data-th-subject]', timeout=10000)
        st = _app_state(page, "s.target")
        if st["questId"] != qid or st["individual"] != "arch-tempered" or st["questTargetIndex"] != 0 or not st["partKey"]:
            ctx.fail(f"クエストの名前から選んでも、1 体目 (歴戦王・行 0・部位) になりません: {st}")
        rows = page.locator(f'{TARGET_PANEL} [data-th-card="multi"] [data-th-subject]')
        if rows.count() != len(hps):
            ctx.fail(f"『{search}』の相手の行が {rows.count()} 行 (期待 {len(hps)} 行)")
        texts = rows.all_inner_texts()
        for t, h in zip(texts, hps):
            if f"{h:,}" not in t or "回" not in t:
                ctx.fail(f"相手の行に体力 {h:,} と回数が出ていません: {t!r}")
        _th_wait_attr(page, "[data-th-health]", "data-th-health", str(hps[0]))
        nums = [int(re.search(r"約 ([\d,]+) 回", t).group(1).replace(",", "")) for t in texts if re.search(r"約 ([\d,]+) 回", t)]
        total = page.get_attribute(f"{TARGET_PANEL} [data-th-multi-total]", "data-th-multi-total")
        if len(nums) != len(hps) or not total or int(total) != sum(nums):
            ctx.fail(f"全部倒すまでの回数 {total} が相手ごとの回数 {nums} の合計と違います")
        if nums and _th_attr(page, "[data-th-combos]", "data-th-combos") != str(nums[0]):
            ctx.fail("1 体目の行の回数と、体力と強さのカードの回数が違います")
        if "このクエストで装備を探す" not in page.inner_text(f"{TARGET_PANEL} [data-th-search]"):
            ctx.fail("多頭のクエストで「このクエストで装備を探す」になっていません")
        # 属性の違う歴戦王が 4 体なので、探すタブで「武器を 2 本使う」(探す流れは run_search の本物の Worker の節)
        open_tab(page, "search")
        page.wait_for_selector(f'{SEARCH_PANEL} [data-sr="weapon"]', timeout=15000)
        if not page.locator(f'{SEARCH_PANEL} [data-sr-two-weapons="on"]').count():
            ctx.fail("『英雄の証』で探すタブに「武器を 2 本使う」が出ていません")
        open_tab(page, "target")
        check_layout(page, ctx, "相手タブ (多頭)")
        ctx.shot("target-multi")
        # 1 体目の部位を替えてから 2 体目へ → 2 体目に替わり、1 体目へ戻すと部位も戻る
        first = st["monsterId"]
        parts = page.eval_on_selector_all(f"{TARGET_PANEL} [data-target-parts] [data-part]", "els => els.map((e) => e.dataset.part)")
        other = next((k for k in parts if k != st["partKey"]), None)
        if other:
            page.click(f'{TARGET_PANEL} [data-target-parts] [data-part="{other}"]')
        rows.nth(1).click()
        _th_wait_attr(page, "[data-th-health]", "data-th-health", str(hps[1]))
        st2 = _app_state(page, "s.target")
        if st2["questId"] != qid or st2["questTargetIndex"] != 1 or st2["monsterId"] == first:
            ctx.fail(f"2 体目の行をタップしても、相手が替わりません: {st2}")
        if (rows.nth(1).get_attribute("aria-pressed")) != "true":
            ctx.fail("タップした相手の行が選ばれた見た目になっていません")
        # 2 体目の回数 = 体力 ÷ 火力タブの期待値
        value = float(_th_attr(page, "[data-th-combos]", "data-th-combo-value") or "nan")
        open_tab(page, "power")
        page.wait_for_selector(f"{POWER_PANEL} [data-power-total]", timeout=15000)
        if not _close(value, _power_total(page), rel=1e-9):
            ctx.fail(f"2 体目の討伐までの回数に使った期待値 {value} が火力タブ {_power_total(page)} と違います")
        open_tab(page, "target")
        rows.nth(0).click()
        _th_wait_attr(page, "[data-th-health]", "data-th-health", str(hps[0]))
        st3 = _app_state(page, "s.target")
        if other and st3["partKey"] != other:
            ctx.fail(f"1 体目に戻しても、前に選んだ部位 ({other}) に戻りません: {st3['partKey']}")
        memo = _app_state(page, "s.tabs.target && s.tabs.target.memo")
        if not isinstance(memo, dict) or str(st2["monsterId"]) not in memo:
            ctx.fail(f"部位の選び方が state.tabs.target.memo に残っていません: {memo}")
        _th_zoom_layout(page, ctx, "相手タブ (多頭)", "target-multi-zoom")
    finally:
        page.evaluate(JS_STATE_RESTORE, snap)


# ---------------------------------------------------------------- 探すタブ (段階 2・3)

SEARCH_PANEL = '[data-tab-panel="search"]'
# 下のタブの並び (docs/RECOMMEND_DESIGN.md 4.1 節)
TAB_LABELS = ["装備", "火力", "相手", "探す", "護石", "設定"]

JS_TABBAR = """() => [...document.querySelectorAll('.tabbar [role=tab]')].map((b) => {
  const r = b.getBoundingClientRect();
  const l = b.querySelector('.tab-label');
  const lr = l.getBoundingClientRect();
  const icon = b.querySelector('.tab-icon');
  const ir = icon ? icon.getBoundingClientRect() : null;
  return { tab: b.dataset.tab, text: l.textContent.trim(), w: r.width, h: r.height, left: r.left, right: r.right,
           lLeft: lr.left, lRight: lr.right, lScroll: l.scrollWidth, lClient: l.clientWidth,
           fs: parseFloat(getComputedStyle(l).fontSize), icon: ir ? ir.width : 0,
           iconInside: !!ir && ir.left >= r.left - 0.5 && ir.right <= r.right + 0.5 };
})"""


@tab_check("search")
def search_tab_opens(page, ctx: Ctx):
    """探すタブ: 条件のカードと「この条件で探す」が出て (「準備中」の置き場ではない)、見出しが「探す」・state.tab が search。
    探す流れの確認は下の run_search (作り物の Worker で画面の流れ・本物の Worker で通し)。"""
    if page.locator(f'{SEARCH_PANEL} [data-search-tab="placeholder"]').count():
        ctx.fail("探すタブが「準備中」の置き場のままです")
    for key in SEARCH_CARDS:
        if not page.locator(f'{SEARCH_PANEL} [data-sr="{key}"]').count():
            ctx.fail(f"探すタブに {key} のカードがありません")
    if not page.locator(f'{SEARCH_PANEL} [data-sr-action="start"]').count():
        ctx.fail("探すタブに「この条件で探す」がありません")
    if page.inner_text(".app-title").strip() != "探す":
        ctx.fail(f"探すタブの見出しが「探す」になっていません: {page.inner_text('.app-title')!r}")
    if _app_state(page, "s.tab") != "search":
        ctx.fail("探すタブを開いても state.tab が search になっていません")


@tab_check("search")
def tabbar_six_tabs_fit(page, ctx: Ctx):
    """下のタブ 6 つが幅いっぱいに並び、どれも 44px 以上で押せて、文字が切れず、絵がボタンの中にある。"""
    tabs = page.evaluate(JS_TABBAR)
    vw = page.evaluate("document.documentElement.clientWidth")
    if [t["tab"] for t in tabs] != TABS:
        ctx.fail(f"タブの並びが違います: {[t['tab'] for t in tabs]}")
    if [t["text"] for t in tabs] != TAB_LABELS:
        ctx.fail(f"タブの名前が違います: {[t['text'] for t in tabs]}")
    for t in tabs:
        where = f"幅 {vw}px の「{t['text']}」タブ"
        if t["w"] < TAP_MIN or t["h"] < TAP_MIN:
            ctx.fail(f"{where}: 押せる大きさが足りません ({t['w']:.0f}x{t['h']:.0f})")
        if t["lScroll"] > t["lClient"] + 0.5 or t["lLeft"] < t["left"] - 0.5 or t["lRight"] > t["right"] + 0.5:
            ctx.fail(f"{where}: 名前が切れています (文字の幅 {t['lScroll']} / 欄 {t['lClient']})")
        if t["fs"] < 10.5:
            ctx.fail(f"{where}: 名前の文字が小さすぎます ({t['fs']}px)")
        if t["icon"] < 20 or not t["iconInside"]:
            ctx.fail(f"{where}: 絵が小さいか、ボタンからはみ出しています")
    for a, b in zip(tabs, tabs[1:]):
        if b["left"] < a["right"] - 0.5:
            ctx.fail(f"「{a['text']}」と「{b['text']}」のタブが重なっています")
    if tabs and (tabs[0]["left"] < -0.5 or tabs[-1]["right"] > vw + 0.5):
        ctx.fail(f"幅 {vw}px でタブが画面からはみ出しています")
    ctx.shot("tabbar", full_page=False)


@scenario_check
def tab_dot_marks_unseen_tab(page, ctx: Ctx):
    """shell.js の setTabDot: 見ていないタブの絵に点が付き、そのタブを開くと消える。開いているタブには付けない。"""
    before = _app_state(page, "s.tab")
    set_dot = "async (tab) => { const m = await import('./app/ui/shell.js'); m.setTabDot(tab); }"
    try:
        open_tab(page, "equip")
        page.evaluate(set_dot, "search")
        page.wait_for_selector('.tabbar [data-tab-dot="search"]', timeout=5000)
        if "新しい結果" not in page.inner_text('.tabbar [data-tab="search"]'):
            ctx.fail("点の付いたタブに、読み上げ用の「新しい結果があります」がありません")
        check_layout(page, ctx, "タブの点")
        ctx.shot("tab-dot", full_page=False)
        open_tab(page, "search")
        if page.locator(".tabbar [data-tab-dot]").count():
            ctx.fail("点の付いたタブを開いても点が消えません")
        page.evaluate(set_dot, "search")
        page.wait_for_timeout(100)
        if page.locator(".tabbar [data-tab-dot]").count():
            ctx.fail("開いているタブにも点が付きます")
    finally:
        if before in TABS:
            open_tab(page, before)


# ---------------------------------------------------------------- 探すタブ (担当: ui-search)
#
# 画面の流れ (1〜5) は作り物の Worker (tests/fixtures/fake_search_worker.js) で確かめる。段階ごとの進み・途中の結果・終わり・
# やめる・続けて探す・失敗が決まった順で来る (値は本物の計算モデルで計算したもの)。本物の探索との通しは 6・7 (本物の Worker)。
# 作り物への切り替えは init script の window.__mhwSearchWorker = {url} (app/ui/tabs/search_client.js。本番では置かない)。
# まっさらな保存領域 (新しい context) で 1 つずつ動かす。main() から run_search(...) を 1 行で呼ぶ (--only で search を外すと動かない)。
#   1. 通し (iPhone 13・ライト): 仮置きの発動率の一覧 → 「火力タブの値で探す」→ 探す → 段階の文 → 途中の結果 → 終わり
#      (1 位が良くなる) → 1 位の詳しく → 装備に入れる (state.build = 結果・火力タブと計算モデルの値 = 結果の値) → 元に戻す →
#      続けて探す → 保存 (search-last・search-timing。書き出しには search-last だけ) → 開き直すと前回の結果 → 条件を変えると
#      「条件が変わりました」。続けて (段階をゆっくり進める作り物で) やめる → もう一度 → 計算中にタブを移る (点が付く) →
#      裏に回して戻す → 相手タブからの自動の開始
#   2. 相手・武器が無いときの案内と、探せないとき (いまの武器で、武器が無い) の止め方
#   3. 必須スキルを足す (Lv の ＋/−) → 満たせない → 「〇〇を外して探す」
#   4. Worker の失敗 (error を返す → もう一度で直る / 落ちる) と、Worker が無い端末 (画面のスレッドで回る)
#   5. 幅 375・ダークで結果とシートの見た目 (はみ出し・44px)
#   6・7. 本物の Worker (下の「本物の Worker でつなぐ」節)

SEARCH_CARDS = ["target", "weapon", "defense", "required", "equip-options", "placeholders", "budget", "start"]
SEARCH_FAKE = "./tests/fixtures/fake_search_worker.js"
SEARCH_RESULTS = f'{SEARCH_PANEL} [data-sr="results"]'
SEARCH_PHASE_TEXT = ["準備しています", "候補を絞っています", "仕上げています", "もっと良い組を探しています", "まとめています"]

JS_SEARCH_SNAP = """async () => { const m = await import('./app/ui/tabs/search_client.js'); const s = m.getSearchController().getSnapshot();
  const r = s.result; return { status: s.status, busy: s.busy, partial: s.partial, improved: s.improved, canExtend: s.canExtend,
    inline: s.inline, extended: s.extended, n: r ? r.results.length : 0, top: r && r.results[0] ? r.results[0].value : null,
    topBuild: r && r.results[0] ? r.results[0].build : null, error: s.error, restored: !!s.restored }; }"""

# 火の片手剣 (レア 8) + アルシュベルドの頭。探すタブの条件は既定に戻す
JS_SEARCH_SETUP = """async () => { const S = await import('./app/state.js'); const D = await import('./app/data.js');
  const data = D.getCoreData();
  const w = data.lists.weapons.find((x) => x.element && x.element.type === 'fire' && x.rarity === 8);
  S.clearBuild(); S.setWeapon(w.id); S.setTargetMode('monster'); S.selectMonster(20, 'head'); S.setWound(false);
  S.setSearch(S.defaultSearch()); S.resetUptime(); S.setCombo(null); S.setSharpness(null);
  await S.flushState(); return w.id; }"""

JS_SEARCH_BUILD = """async () => { const S = await import('./app/state.js'); return JSON.parse(JSON.stringify(S.getState().build)); }"""


def _search_open(browser, ctx_opts: dict, server: Server, base_url: str, name: str, *, fake="step=150", no_worker=False):
    """作り物の Worker を使う context を開く (Service Worker は使わない)。"""
    context = browser.new_context(**ctx_opts, service_workers="block")
    context.add_init_script(ROBUST_UNHANDLED)
    context.add_init_script(f"window.__mhwSearchWorker = {{ url: {json.dumps(SEARCH_FAKE + '?' + fake)} }};")
    if no_worker:
        context.add_init_script("try { delete window.Worker; } catch (e) {} window.Worker = undefined;")
    page = context.new_page()
    ctx = Ctx(scenario=name, page=page, base_url=base_url, server=server)
    page.on("console", lambda m: ctx.errors.append(f"console.error: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: ctx.errors.append(f"pageerror: {e}"))
    page.on("response", lambda r: ctx.errors.append(f"HTTP {r.status}: {r.url}")
            if r.url.startswith(base_url) and r.status >= 400 else None)
    page.goto(base_url, wait_until="load")
    wait_app_ready(page)
    return context, page, ctx


def _search_status(page, status: str, timeout=20000):
    page.wait_for_selector(f'{SEARCH_RESULTS}[data-sr-status="{status}"]', timeout=timeout)


def _search_start(page):
    page.locator(f'{SEARCH_PANEL} [data-sr-action="start"]').click()


def _search_top(page):
    v = page.locator(f"{SEARCH_PANEL} .sr-result").first.get_attribute("data-sr-value")
    return float(v) if v not in (None, "") else None


def _search_err(e) -> str:
    """例外の文の先頭 (Playwright の待ちの失敗は、どの要素を待っていたかが 2 行目以降にある)。"""
    return " / ".join(x.strip() for x in str(e).splitlines()[:4] if x.strip())


def _same_build(a: dict, b: dict) -> bool:
    keys = ["weapon", "armor", "charm", "limitBreak"]
    return all(json.dumps(a.get(k), sort_keys=True) == json.dumps(b.get(k), sort_keys=True) for k in keys)


# 1 位の行の位置 (画面の中か)。タブバーより上に、行の上の 40px が見えていればよい
JS_FIRST_ROW_BOX = """() => { const el = document.querySelector('[data-tab-panel="search"] .sr-result'); if (!el) return null;
  const r = el.getBoundingClientRect(); const bar = document.querySelector('.tabbar');
  return { top: r.top, limit: bar ? bar.getBoundingClientRect().top : innerHeight, scrollY: scrollY }; }"""


def _first_row_visible(page, ctx: Ctx, where: str):
    """終わった直後に 1 位の行が画面の中にあるか (知らせの山の下に押し出されて見えなくならない。2026-10-22 の点検)。"""
    page.wait_for_timeout(500)  # 探し始めたときのスクロール (smooth) が止まるまで
    box = page.evaluate(JS_FIRST_ROW_BOX)
    if not box or not (0 <= box["top"] and box["top"] + 40 <= box["limit"]):
        ctx.fail(f"{where}: 終わった直後に 1 位の行が画面の中にありません: {box}")


def search_walkthrough(browser, ctx_opts, server, base_url) -> Ctx:
    """1. 通し: 探す → 途中の結果 → 終わり → 装備に入れる → 元に戻す → 続けて探す → 保存して開き直す → やめる → タブを移る など。"""
    # 段階は 0.4 秒ずつ (途中の結果が出ている間に、計算中の画面の確かめとスクリーンショットを撮り終えるため。
    # 2026-10-21 のまとめ (相手に合わせた Job で探すようになった) のあと、0.15 秒ずつでは途中の結果を見る前に終わることがあった)
    context, page, ctx = _search_open(browser, ctx_opts, server, base_url, "iphone13-light", fake="step=400")
    P = SEARCH_PANEL
    try:
        page.evaluate(JS_SEARCH_SETUP)
        open_tab(page, "search")
        # --- 仮置きの発動率の一覧 → 「火力タブの値で探す」(装備に入れたあと火力タブと値を比べるため)
        n = int(page.get_attribute(f'{P} [data-sr="placeholders"]', "data-sr-placeholder-count") or "0")
        if n < 20:
            ctx.fail(f"探す: 仮置きの発動率の条件の数が {n} 個 (20 個以上あるはず)")
        page.locator(f'{P} [data-sr="placeholders"] summary').click()
        if page.locator(f'{P} [data-sr-placeholder-list] li').count() != n:
            ctx.fail("探す: 仮の条件の一覧の行数が数と合いません")
        # 本人の前提 (怒り・連撃・スタミナ満タン 100%。2026-10-22) は仮の一覧に入れず、「仮でない条件」の行に出す
        listed = page.inner_text(f'{P} [data-sr-placeholder-list]')
        fixed = page.inner_text(f'{P} [data-sr-fixed]') if page.locator(f'{P} [data-sr-fixed]').count() else ""
        if "モンスターが怒っている" in listed or "モンスターが怒っている" not in fixed or "5 ヒット以降段 100%" not in fixed:
            ctx.fail(f"探す: 本人の前提の条件の出し方が違います (仮でない条件: {fixed!r})")
        # 火力タブで怒りに値 (40%) を入れると、「火力タブで値を入れた条件」の行に移り、「仮でない条件」の行からは消える
        page.evaluate("async () => { const S = await import('./app/state.js'); S.setUptime('enraged', 0.4); await S.flushState(); }")
        page.wait_for_function(
            "() => (document.querySelector('[data-tab-panel=\"search\"] [data-sr-mine]') || {}).textContent?.includes('モンスターが怒っている')",
            timeout=5000)
        mine = page.inner_text(f'{P} [data-sr-mine]') if page.locator(f'{P} [data-sr-mine]').count() else ""
        fixed = page.inner_text(f'{P} [data-sr-fixed]') if page.locator(f'{P} [data-sr-fixed]').count() else ""
        if "「モンスターが怒っている」40%" not in mine or "モンスターが怒っている" in fixed:
            ctx.fail(f"探す: 火力タブで入れた怒り 40% の出し方が違います (入れた条件: {mine!r} / 仮でない条件: {fixed!r})")
        page.evaluate("async () => { const S = await import('./app/state.js'); S.resetUptime('enraged'); await S.flushState(); }")
        page.wait_for_function("() => !document.querySelector('[data-tab-panel=\"search\"] [data-sr-mine]')", timeout=5000)
        page.locator(f'{P} [data-sr="placeholders"] .segment', has_text="火力タブの値で探す").click()
        if _app_state(page, "s.search.placeholders") != "keep":
            ctx.fail("探す: 「火力タブの値で探す」が state.search.placeholders に入りません")
        if "アルシュベルド" not in page.inner_text(f'{P} [data-sr-target-label]'):
            ctx.fail(f"探す: 相手のカードに相手が出ていません: {page.inner_text(f'{P} [data-sr-target-label]')!r}")
        check_layout(page, ctx, "探す (条件)")
        ctx.shot("search-form")

        # --- 探す → 段階の文 → 途中の結果 → 終わり (1 位が良くなる)
        _search_start(page)
        page.wait_for_selector(f'{P} [data-sr="running"]', timeout=10000)
        phase = page.inner_text(f'{P} [data-sr-phase]')
        if not any(t in phase for t in SEARCH_PHASE_TEXT):
            ctx.fail(f"探す: 計算中の段階の文が出ていません: {phase!r}")
        if not page.locator(f'{P} [data-sr-action="start"]').is_disabled():
            ctx.fail("探す: 計算中なのに「この条件で探す」が押せます")
        check_layout(page, ctx, "探す (計算中)")
        ctx.shot("search-running", full_page=False)
        page.wait_for_selector(f'{SEARCH_RESULTS}[data-sr-partial="1"] .sr-result', timeout=15000)
        if not page.locator(f'{P} [data-sr-note="partial"]').count():
            ctx.fail("探す: 途中の結果に「途中の結果です」が出ていません")
        partial_top = _search_top(page)
        _search_status(page, "done")
        done_top = _search_top(page)
        if not (partial_top and done_top and done_top > partial_top):
            ctx.fail(f"探す: 終わりの 1 位が途中の結果より良くなっていません: {partial_top} → {done_top}")
        if not page.locator(f'{P} [data-sr-note="improved"]').count():
            ctx.fail("探す: 1 位が良くなったのに「もっと良い組が見つかりました」が出ません")
        snap = page.evaluate(JS_SEARCH_SNAP)
        if not _close(snap["top"], done_top, 1e-12) or snap["n"] != page.locator(f"{P} .sr-result").count():
            ctx.fail(f"探す: 画面の結果がコントローラの結果と違います: {snap}")
        text = page.inner_text(SEARCH_RESULTS)
        for word in ["近似", "いまより", "が変わる"]:
            if word not in text:
                ctx.fail(f"探す: 結果に「{word}」がありません")
        if not page.locator(f'{P} .sr-result .badge', has_text="γ").count():
            ctx.fail("探す: 歴戦王の素材が要る防具の印 (γ) が出ていません")
        _first_row_visible(page, ctx, "探す (結果)")
        check_layout(page, ctx, "探す (結果)")
        ctx.shot("search-results")

        # --- 1 位の詳しく → 装備に入れる → 火力タブ・計算モデルの値が結果と同じ → 元に戻す
        before = page.evaluate(JS_SEARCH_BUILD)
        page.locator(f"{P} .sr-result").first.click()
        page.wait_for_selector('[data-sr-sheet="result"]')
        _wait_sheet_ready(page)
        sheet = page.inner_text(".sheet")
        for word in ["スキル (いまと比べて)", "近似", "頭", "護石"]:
            if word not in sheet:
                ctx.fail(f"探す: 結果の詳しくに「{word}」がありません")
        check_layout(page, ctx, "探す (結果の詳しく)")
        ctx.shot("search-sheet", full_page=False)
        page.locator('.sheet [data-sr-action="apply"]').click()
        page.wait_for_selector(".sheet", state="detached")
        after = page.evaluate(JS_SEARCH_BUILD)
        if not _same_build(after, snap["topBuild"]):
            ctx.fail(f"探す: 装備に入れても state.build が結果と違います: {after} / {snap['topBuild']}")
        if not page.locator(f'{P} [data-sr-note="applied"]').count():
            ctx.fail("探す: 装備に入れたあとに「元に戻す」が出ません")
        model = _walk_model(page, ctx)
        if model and not _close(model["total"], done_top, 1e-9):
            ctx.fail(f"探す: 計算モデル (calc_from_state) の値 {model['total']} が結果の値 {done_top} と違います")
        open_tab(page, "power")
        page.wait_for_selector(f"{POWER_PANEL} [data-power-total]", timeout=15000)
        if not _close(_power_total(page), done_top, 1e-9):
            ctx.fail(f"探す: 装備に入れたあとの火力タブの値 {_power_total(page)} が結果の値 {done_top} と違います")
        open_tab(page, "search")
        page.locator(f'{P} [data-sr-action="undo"]').click()
        if not _same_build(page.evaluate(JS_SEARCH_BUILD), before):
            ctx.fail("探す: 「元に戻す」で前の装備に戻りません")

        # --- 続けて探す
        page.locator(f'{P} [data-sr-action="extend"]').click()
        page.wait_for_selector(f'{P} [data-sr="running"]', timeout=10000)
        _search_status(page, "done")
        ext_top = _search_top(page)
        snap = page.evaluate(JS_SEARCH_SNAP)
        if not (ext_top and ext_top > done_top and snap["extended"] == 1):
            ctx.fail(f"探す: 「続けて探す」で 1 位が良くなりません: {done_top} → {ext_top} ({snap})")

        # --- 保存: search-last (書き出しに入る) と search-timing (この端末だけ)
        page.wait_for_function("""async () => { const D = await import('./app/store.js');
          const last = await D.kvGet('mhwilds-sns:search-last'); const t = await D.kvGet('mhwilds-sns:search-timing');
          return !!last && last.result && last.result.results.length > 0 && Array.isArray(t) && t.length >= 2; }""", timeout=10000)
        saved = page.evaluate("""async () => { const D = await import('./app/store.js');
          const last = await D.kvGet('mhwilds-sns:search-last'); const t = await D.kvGet('mhwilds-sns:search-timing');
          const text = await D.exportAllText({}); return { top: last.result.results[0].value, key: last.inputKey,
          timing: t.length, phases: t[0].phases.length, inExport: text.includes('mhwilds-sns:search-last'),
          timingInExport: text.includes('mhwilds-sns:search-timing') }; }""")
        if not _close(saved["top"], ext_top, 1e-12) or not saved["key"]:
            ctx.fail(f"探す: 保存した最後の結果が画面と違います: {saved}")
        if not saved["inExport"] or saved["timingInExport"]:
            ctx.fail(f"探す: 書き出しには search-last だけが入るはず: {saved}")
        if saved["phases"] < 3:
            ctx.fail(f"探す: 時間の記録に段階が入っていません: {saved}")

        # --- 開き直すと前回の結果 → 条件を変えると「条件が変わりました」
        page.evaluate("async () => (await import('./app/state.js')).flushState()")
        page.reload(wait_until="load")
        wait_app_ready(page)
        page.wait_for_selector(f'{P} [data-sr-note="restored"]', timeout=15000)
        if not _close(_search_top(page), ext_top, 1e-12):
            ctx.fail(f"探す: 開き直したときの前回の結果の 1 位が違います: {_search_top(page)} / {ext_top}")
        if page.locator(f'{P} [data-sr-action="extend"]').count():
            ctx.fail("探す: 保存から戻した結果なのに「続けて探す」が出ています")
        if page.locator(f'{P} [data-sr-note="stale"]').count():
            ctx.fail("探す: 条件を変えていないのに「条件が変わりました」が出ています")
        page.locator(f'{P} [data-sr="budget"] .segment', has_text="5 件").click()
        page.wait_for_selector(f'{P} [data-sr-note="stale"]', timeout=5000)
        page.locator(f'{P} [data-sr="budget"] .segment', has_text="10 件").click()
        page.wait_for_selector(f'{P} [data-sr-note="stale"]', state="detached", timeout=5000)
        ctx.shot("search-restored")
        check_errors(ctx, "探す (通し)")
    except Exception as e:
        ctx.fail(f"探す (通し) が途中で止まりました: {_search_err(e)}")
        try:
            ctx.shot("search-stopped")
        except Exception:
            pass
    finally:
        context.close()
    return ctx


def search_cancel_and_tabs(browser, ctx_opts, server, base_url) -> Ctx:
    """1 の続き (段階をゆっくり進める作り物で): やめる → もう一度 → 計算中にタブを移る → 裏に回す → 相手タブからの自動の開始。"""
    context, page, ctx = _search_open(browser, ctx_opts, server, base_url, "search-cancel", fake="step=500")
    P = SEARCH_PANEL
    try:
        page.evaluate(JS_SEARCH_SETUP)
        open_tab(page, "search")
        # --- やめる → 途中でやめました → もう一度
        _search_start(page)
        page.wait_for_selector(f'{P} [data-sr="running"]', timeout=10000)
        page.locator(f'{P} [data-sr-action="cancel"]').click()
        _search_status(page, "cancelled")
        if not page.locator(f'{P} [data-sr-note="cancelled"]').count():
            ctx.fail("探す: やめたのに「途中でやめました」が出ません")
        _search_start(page)
        _search_status(page, "done")

        # --- 計算中にほかのタブへ移る → 終わるとタブの絵に点 → 戻ると結果
        _search_start(page)
        page.wait_for_selector(f'{P} [data-sr="running"]', timeout=10000)
        open_tab(page, "equip")
        page.wait_for_function(f"async () => (await ({JS_SEARCH_SNAP})()).status === 'done'", timeout=15000)
        page.wait_for_selector('.tabbar [data-tab-dot="search"]', timeout=5000)
        open_tab(page, "search")
        if page.locator(".tabbar [data-tab-dot]").count():
            ctx.fail("探す: 探すタブを開いても点が消えません")
        if not page.locator(f"{P} .sr-result").count():
            ctx.fail("探す: ほかのタブから戻ると結果がありません")

        # --- 裏に回す (visibilitychange) → 戻す: 止まらずに終わる
        _search_start(page)
        page.wait_for_selector(f'{P} [data-sr="running"]', timeout=10000)
        page.evaluate("""() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
          document.dispatchEvent(new Event('visibilitychange')); }""")
        page.wait_for_timeout(400)
        page.evaluate("""() => { delete document.visibilityState;
          document.dispatchEvent(new Event('visibilitychange')); }""")
        _search_status(page, "done")

        # --- 相手タブから「この相手で装備を探す」(印を置いて探すタブへ) → 自動で始まり、印は消える
        open_tab(page, "target")
        page.evaluate("""async () => { const S = await import('./app/state.js'); const sh = await import('./app/ui/shell.js');
          S.requestSearch({ from: 'target' }); sh.goToTab('search', { top: true }); }""")
        page.wait_for_selector('.app[data-active-tab="search"]')
        page.wait_for_selector(f'{P} [data-sr="running"]', timeout=10000)
        _search_status(page, "done")
        if _app_state(page, "s.search.autoStart") is not None:
            ctx.fail("探す: 自動で探し始めたあとも state.search.autoStart の印が残っています")
        check_errors(ctx, "探す (やめる・タブを移る)")
    except Exception as e:
        ctx.fail(f"探す (やめる・タブを移る) が途中で止まりました: {_search_err(e)}")
        try:
            ctx.shot("search-cancel-stopped")
        except Exception:
            pass
    finally:
        context.close()
    return ctx


def search_guidance_and_required(browser, ctx_opts, server, base_url) -> Ctx:
    """2・3. 相手・武器が無いときの案内、探せないとき、必須スキルを足して満たせない → 外して探す。"""
    context, page, ctx = _search_open(browser, ctx_opts, server, base_url, "search-required", fake="step=20&result=infeasible")
    P = SEARCH_PANEL
    try:
        open_tab(page, "search")
        if "相手を選んでいません" not in page.inner_text(f'{P} [data-sr-target-label]'):
            ctx.fail("探す: 相手が無いときの案内が出ません")
        if "片手剣すべて" not in page.inner_text(f'{P} [data-sr-weapon-text]'):
            ctx.fail("探す: 武器が無いとき (おまかせ) に「片手剣すべて」から探す案内が出ません")
        page.locator(f'{P} [data-sr="weapon"] .segment', has_text="いまの武器").click()
        page.wait_for_selector(f'{P} [data-sr-blocker="no-weapon"]', timeout=5000)
        if not page.locator(f'{P} [data-sr-action="start"]').is_disabled():
            ctx.fail("探す: 武器が無いのに「いまの武器」で探せてしまいます")
        page.locator(f'{P} [data-sr="weapon"] .segment', has_text="おまかせ").click()
        # 必須スキルを足す → Lv を上げ下げ
        page.locator(f'{P} [data-sr-action="add-required"]').click()
        page.wait_for_selector(".sheet .picker-list")
        page.fill(".sheet input[type=search]", "耐震")
        page.locator(".sheet .picker-item:not([disabled])", has_text="耐震").first.click()
        page.wait_for_selector(".sheet", state="detached")
        row = page.locator(f"{P} [data-sr-required]")
        if row.count() != 1 or "耐震" not in row.inner_text():
            ctx.fail("探す: 必須スキル (耐震) の行が出ません")
        row.locator('[data-sr-action="lv-up"]').click()
        row.locator('[data-sr-action="lv-up"]').click()
        row.locator('[data-sr-action="lv-down"]').click()
        req = _app_state(page, "s.search.required")
        if len(req) != 1 or req[0]["level"] != 2:
            ctx.fail(f"探す: 必須スキルの Lv の上げ下げが state に入りません: {req}")
        check_layout(page, ctx, "探す (必須スキル)")
        _search_start(page)
        _search_status(page, "infeasible")
        if "耐震" not in page.inner_text(f'{P} [data-sr-note="infeasible"]'):
            ctx.fail("探す: 満たせないときに足りないスキルが出ません")
        ctx.shot("search-infeasible")
        page.locator(f'{P} [data-sr-action="remove-missing"]').first.click()
        page.wait_for_selector(f"{P} [data-sr-required]", state="detached", timeout=5000)
        page.wait_for_function(f"async () => {{ const s = await ({JS_SEARCH_SNAP})(); return s.status === 'infeasible' && !s.busy; }}",
                               timeout=10000)
        if _app_state(page, "s.search.required"):
            ctx.fail("探す: 「〇〇を外して探す」で必須スキルが外れません")
        check_errors(ctx, "探す (案内と必須スキル)")
    except Exception as e:
        ctx.fail(f"探す (案内と必須スキル) が途中で止まりました: {_search_err(e)}")
    finally:
        context.close()
    return ctx


def search_failures(browser, ctx_opts, server, base_url) -> list[Ctx]:
    """4. Worker が error を返す (もう一度で直る)・Worker が落ちる・Worker が無い端末。"""
    out = []
    P = SEARCH_PANEL
    # error を返す → もう一度 (差し替えを普通の作り物に戻してから) で直る
    context, page, ctx = _search_open(browser, ctx_opts, server, base_url, "search-fail", fake="step=20&fail=start")
    try:
        page.evaluate(JS_SEARCH_SETUP)
        open_tab(page, "search")
        _search_start(page)
        _search_status(page, "error")
        note = page.locator(f'{P} [data-sr-note="error"]')
        if "探せませんでした" not in note.inner_text():
            ctx.fail("探す: Worker のエラーが「探せませんでした」で出ません")
        ctx.shot("search-error")
        page.evaluate(f"() => {{ window.__mhwSearchWorker = {{ url: {json.dumps(SEARCH_FAKE + '?step=20')} }}; }}")
        note.locator("button", has_text="もう一度").click()
        _search_status(page, "done")
        check_errors(ctx, "探す (Worker のエラー)")
    except Exception as e:
        ctx.fail(f"探す (Worker のエラー) が途中で止まりました: {_search_err(e)}")
    finally:
        context.close()
    out.append(ctx)
    # Worker が落ちる (error イベント) → エラーの表示 (作り物の例外のコンソール出力は数えない)
    context, page, ctx = _search_open(browser, ctx_opts, server, base_url, "search-crash", fake="step=20&fail=crash")
    try:
        page.evaluate(JS_SEARCH_SETUP)
        open_tab(page, "search")
        _search_start(page)
        _search_status(page, "error")
        errs = [e for e in ctx.take_errors() if "作り物" not in e]
        if errs:
            ctx.fail(f"探す (Worker が落ちる): エラー {errs[:4]}")
    except Exception as e:
        ctx.fail(f"探す (Worker が落ちる) が途中で止まりました: {_search_err(e)}")
    finally:
        context.close()
    out.append(ctx)
    # Worker が無い端末 → 画面のスレッドで回る
    context, page, ctx = _search_open(browser, ctx_opts, server, base_url, "search-noworker", fake="step=20", no_worker=True)
    try:
        if page.evaluate("typeof window.Worker") != "undefined":
            ctx.note("探す: init script で Worker を消せなかったので、Worker が無い端末の確認は Worker のまま動きました")
        page.evaluate(JS_SEARCH_SETUP)
        open_tab(page, "search")
        _search_start(page)
        _search_status(page, "done")
        if not page.evaluate(JS_SEARCH_SNAP)["inline"] or not page.locator(f'{P} [data-sr-note="inline"]').count():
            ctx.fail("探す: Worker が無いのに、画面の処理で探したことになっていません")
        check_errors(ctx, "探す (Worker が無い)")
    except Exception as e:
        ctx.fail(f"探す (Worker が無い) が途中で止まりました: {_search_err(e)}")
    finally:
        context.close()
    out.append(ctx)
    return out


def search_dark_375(browser, ctx_opts, server, base_url) -> Ctx:
    """5. 幅 375・ダークで、結果の一覧と詳しくのシートがはみ出さず、44px 以上で押せる。
    相手は歴戦王ウズ・トゥナ (雷がはっきり) で、火の武器なので「おすすめの属性」から探す。雷の武器の結果を装備に入れても
    「条件が変わりました」にならない (探し始めた時の装備で比べ直す) ことも確かめる。"""
    context, page, ctx = _search_open(browser, ctx_opts, server, base_url, "w375-dark", fake="step=20&warn=1")
    P = SEARCH_PANEL
    try:
        page.evaluate(JS_SEARCH_SETUP)
        page.evaluate("""async () => { const S = await import('./app/state.js'); const D = await import('./app/data.js');
          const td = await D.loadTargetData(); const m = td.lists.monsters.find((x) => x.name === 'ウズ・トゥナ');
          S.selectMonster(m.id, 'head'); S.selectIndividual('arch-tempered'); await S.flushState(); }""")
        open_tab(page, "search")
        if "おすすめの属性" not in page.inner_text(f'{P} [data-sr-weapon-text]'):
            ctx.fail(f"探す: 歴戦王ウズ・トゥナと火の武器で「おすすめの属性」から探していません: {page.inner_text(f'{P} [data-sr-weapon-text]')!r}")
        _search_start(page)
        _search_status(page, "done")
        if not page.locator(f'{P} [data-sr-note="warnings"]').count():
            ctx.fail("探す: 結果の警告 (evaluator-mismatch) が出ません")
        if not page.locator(f'{P} [data-sr-note="zeroed"]').count():
            ctx.fail("探す: 仮の発動率を 0% にして探したときの説明が出ません")
        check_layout(page, ctx, "探す (幅 375・ダークの結果)")
        ctx.shot("search-results")
        page.locator(f"{P} .sr-result").first.click()
        page.wait_for_selector('[data-sr-sheet="result"]')
        _wait_sheet_ready(page)
        check_layout(page, ctx, "探す (幅 375・ダークの詳しく)")
        ctx.shot("search-sheet", full_page=False)
        # 1 位 (武器が変わる組) を装備に入れても「条件が変わりました」にならない → 元に戻す
        before = page.evaluate(JS_SEARCH_BUILD)
        page.locator('.sheet [data-sr-action="apply"]').click()
        page.wait_for_selector(".sheet", state="detached")
        after = page.evaluate(JS_SEARCH_BUILD)
        if after.get("weapon") == before.get("weapon"):
            ctx.note("探す: 1 位の組の武器がいまの武器と同じだったので、武器が変わるときの確かめになっていません")
        page.wait_for_timeout(300)
        if page.locator(f'{P} [data-sr-note="stale"]').count():
            ctx.fail("探す: 結果の組を装備に入れただけで「条件が変わりました」が出ます")
        page.locator(f'{P} [data-sr-action="undo"]').click()
        if not _same_build(page.evaluate(JS_SEARCH_BUILD), before):
            ctx.fail("探す: 「元に戻す」で前の装備に戻りません (幅 375・ダーク)")
        check_errors(ctx, "探す (幅 375・ダーク)")
    except Exception as e:
        ctx.fail(f"探す (幅 375・ダーク) が途中で止まりました: {_search_err(e)}")
    finally:
        context.close()
    return ctx


# ---------------------------------------------------------------- 探すタブ: 本物の Worker でつなぐ (3f)
#
# 作り物の Worker を使わず、app/search_worker.js (本物の createSearch / recommend.createPlanRunner) で通しを確かめる。
# 結果が時間で変わらないよう、予算は仕事量 (window.__mhwSearchBudget = {work: n}。画面には出さない) にする。
#   6. 相手タブで歴戦王アルシュベルド (置き換わった傷口・傷口を狙う) →「この相手で装備を探す」→ 探すタブで自動で始まる (Plan の Job) →
#      途中の結果 → 終わり → 1 位を装備に入れる → 火力タブの期待値 = 結果の値
#   7. 多頭クエスト『英雄の証』(倒していない歴戦王を 1 体外す) →「このクエストで装備を探す」→ 武器 2 本の案 →
#      2 本目を装備に入れる。外した歴戦王の γ 防具は探索の入力から外れ、結果にも出ない

SEARCH_REAL_BUDGET = "{ work: 3000 }"

JS_REAL_SNAP = """async () => { const m = await import('./app/ui/tabs/search_client.js'); const s = m.getSearchController().getSnapshot();
  const r = s.result; const job = s.job; const run0 = job && job.runs ? job.runs[0] : null;
  return { status: s.status, inline: s.inline, partialMs: s.partialMs, doneMs: s.doneMs, phases: s.phases.map((x) => x.name),
    kind: job ? job.kind : null, runs: job && job.runs ? job.runs.map((x) => x.key) : [], merge: job && job.merge ? job.merge.mode : null,
    targets: run0 ? run0.input.targets : null, armorExclude: run0 ? run0.input.armorExclude : null,
    fixedExclude: run0 ? run0.input.charms.fixedExclude : null,
    n: r ? r.results.length : 0, top: r && r.results[0] ? r.results[0].score.value : null,
    topBuild: r && r.results[0] ? r.results[0].build : null, topBuilds: r && r.results[0] ? r.results[0].builds : null,
    allBuilds: r ? r.results.flatMap((x) => x.builds || [x.build]) : [], gamma: r ? r.results.flatMap((x) => (x.gamma || []).map((g) => g.monsterId)) : [],
    defenseOk: r ? r.results.map((x) => !!(x.defense && x.defense.ok)) : [], twoWeapons: r ? r.results.filter((x) => x.twoWeapons).length : 0,
    error: s.error, warnings: r ? r.warnings.map((w) => w.code) : [] }; }"""


def _real_open(browser, ctx_opts: dict, server: Server, base_url: str, name: str):
    """本物の Worker (app/search_worker.js) を使う context を開く (Service Worker は使わない・予算は仕事量)。"""
    context = browser.new_context(**ctx_opts, service_workers="block")
    context.add_init_script(ROBUST_UNHANDLED)
    context.add_init_script(f"window.__mhwSearchBudget = {SEARCH_REAL_BUDGET};")
    page = context.new_page()
    ctx = Ctx(scenario=name, page=page, base_url=base_url, server=server)
    page.on("console", lambda m: ctx.errors.append(f"console.error: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: ctx.errors.append(f"pageerror: {e}"))
    page.on("response", lambda r: ctx.errors.append(f"HTTP {r.status}: {r.url}")
            if r.url.startswith(base_url) and r.status >= 400 else None)
    page.goto(base_url, wait_until="load")
    wait_app_ready(page)
    return context, page, ctx


def _real_wait_finished(page, timeout=90000):
    """本物の探索が終わる (done か、仕事量の予算で打ち切った stopped) まで待つ。"""
    page.wait_for_selector(f'{SEARCH_RESULTS}[data-sr-status="done"], {SEARCH_RESULTS}[data-sr-status="stopped"]', timeout=timeout)


def search_real_arch_tempered(browser, ctx_opts, server, base_url) -> Ctx:
    """6. 本物の Worker: 相手タブで歴戦王アルシュベルド → この相手で装備を探す → 途中の結果 → 終わり → 装備に入れる → 火力タブ。"""
    context, page, ctx = _real_open(browser, ctx_opts, server, base_url, "search-real-arch")
    P = SEARCH_PANEL
    try:
        page.evaluate(JS_SEARCH_SETUP)
        # 火力タブと値を比べるので、仮置きの発動率も火力タブの値のまま探す
        page.evaluate("""async () => { const S = await import('./app/state.js'); S.setSearch({ placeholders: 'keep' });
          S.selectMonster(null); await S.flushState(); }""")
        open_tab(page, "target")
        page.evaluate(JS_TH_RESET)
        _th_pick_monster(page, "あるしゅべるど", "アルシュベルド")
        _th_individual(page, "歴戦王")
        page.wait_for_selector(f"{TARGET_PANEL} [data-th-search]", timeout=15000)
        # 個体を選んだ所から 1 画面の中に「この相手で装備を探す」がある (「個体とクエスト」のカードの下。2026-10-22 の点検)
        ind = page.locator(f"{TARGET_PANEL} [data-th-individual]").bounding_box()
        quick = page.locator(f"{TARGET_PANEL} [data-th-search-quick]")
        qb = quick.bounding_box() if quick.count() == 1 else None
        vh = page.viewport_size["height"]
        if not ind or not qb or qb["y"] + qb["height"] - ind["y"] > vh or qb["height"] < 44:
            ctx.fail(f"探す (本物): 個体の欄から 1 画面の中に「この相手で装備を探す」がありません: 個体 {ind} / ボタン {qb} / 画面 {vh}")
        elif "この相手で装備を探す" not in quick.inner_text():
            ctx.fail(f"探す (本物): 個体とクエストのカードのボタンの文が違います: {quick.inner_text()!r}")
        # 置き換わった傷口 (確度の低い woundOverrides) を使い、置き換えのある部位の傷口を狙う
        part = page.evaluate("""async () => { const D = await import('./app/data.js');
          const m = D.getTargetData().lists.monsters.find((x) => x.name === 'アルシュベルド');
          const ov = m.individuals.find((i) => i.kind === 'arch-tempered').hitzone.woundOverrides || {};
          const p = m.parts.find((x) => x.wound && ov[x.key] && Object.keys(ov[x.key]).some((k) => ov[x.key][k] !== x.wound[k]));
          return p ? { key: p.key, override: ov[p.key], base: p.wound } : null; }""")
        if not part:
            ctx.fail("探す (本物): 歴戦王アルシュベルドに傷口の置き換えのある部位が見つかりません")
            return ctx
        page.click(f'{TARGET_PANEL} [data-target-parts] [data-part="{part["key"]}"]')
        page.evaluate("""async () => { const S = await import('./app/state.js'); S.setWound(true); S.setUseUncertainWound(true); }""")
        plan_card = page.locator(f"{TARGET_PANEL} section.card", has=page.locator('[data-th-card="plan"]'))
        plan_card.wait_for(timeout=15000)
        plan_text = plan_card.inner_text()
        for word in ["この相手のおすすめ", "龍属性やられ", "仮"]:
            if word not in plan_text:
                ctx.fail(f"探す (本物): 相手タブの「この相手のおすすめ」(本物の buildPlan) に「{word}」がありません: {plan_text[:200]!r}")
        ctx.shot("real-target-plan")
        # --- この相手で装備を探す → 探すタブで自動で始まる
        plan_card.locator("[data-th-search]").click()
        page.wait_for_selector('.app[data-active-tab="search"]', timeout=10000)
        page.wait_for_selector(f'{P} [data-sr="running"]', timeout=15000)
        if not page.locator(f'{P} [data-sr-req][data-sr-req-on="1"]', has_text="龍属性やられ").count():
            ctx.fail("探す (本物): 守りのスキルのカードに「龍属性やられ」の行がオンで出ていません")
        _real_wait_finished(page)
        snap = page.evaluate(JS_REAL_SNAP)
        if snap["kind"] != "plan" or snap["inline"]:
            ctx.fail(f"探す (本物): 相手に合わせた Job (plan) を Worker で回していません: {snap['kind']} / inline {snap['inline']}")
        if snap["runs"] != ["blight-skill", "blight-resist"]:
            ctx.fail(f"探す (本物): 属性やられの「または」で探索が 2 回になっていません: {snap['runs']}")
        if snap["partialMs"] is None or (snap["doneMs"] is not None and snap["partialMs"] > snap["doneMs"]):
            ctx.fail(f"探す (本物): 途中の結果が終わりより先に届いていません: {snap['partialMs']} / {snap['doneMs']}")
        t0 = (snap["targets"] or [{}])[0].get("target") or {}
        if t0.get("wound") != part["override"] or t0.get("isWound") is not True:
            ctx.fail(f"探す (本物): 探索の相手に歴戦王の置き換わった傷口が入っていません: {t0.get('wound')} / {part['override']}")
        if not snap["n"] or not all(snap["defenseOk"]):
            ctx.fail(f"探す (本物): 結果が無いか、守り (龍属性やられ) を満たさない組があります: {snap['n']} / {snap['defenseOk']}")
        text = page.inner_text(SEARCH_RESULTS)
        for word in ["近似", "守り", "いまより", "討伐まで"]:
            if word not in text:
                ctx.fail(f"探す (本物): 結果に「{word}」がありません")
        _first_row_visible(page, ctx, "探す (本物・歴戦王の結果)")
        check_layout(page, ctx, "探す (本物・歴戦王の結果)")
        ctx.shot("real-arch-results")
        top = _search_top(page)
        if not _close(top, snap["top"], 1e-12):
            ctx.fail(f"探す (本物): 画面の 1 位 {top} がコントローラの 1 位 {snap['top']} と違います")
        # --- 1 位を装備に入れる → 火力タブの期待値 = 結果の値
        page.locator(f"{P} .sr-result").first.click()
        page.wait_for_selector('[data-sr-sheet="result"]')
        _wait_sheet_ready(page)
        if "守り" not in page.inner_text(".sheet"):
            ctx.fail("探す (本物): 結果の詳しくに「守り」がありません")
        page.locator('.sheet [data-sr-action="apply"]').click()
        page.wait_for_selector(".sheet", state="detached")
        if not _same_build(page.evaluate(JS_SEARCH_BUILD), snap["topBuild"]):
            ctx.fail("探す (本物): 装備に入れても state.build が結果と違います")
        open_tab(page, "power")
        page.wait_for_selector(f"{POWER_PANEL} [data-power-total]", timeout=15000)
        if "アルシュベルド（歴戦王）" not in page.inner_text(f"{POWER_PANEL} [data-power-target]"):
            ctx.fail(f"探す (本物): 火力タブの相手が歴戦王になっていません: {page.inner_text(f'{POWER_PANEL} [data-power-target]')!r}")
        if not _close(_power_total(page), top, 1e-9):
            ctx.fail(f"探す (本物): 装備に入れたあとの火力タブの期待値 {_power_total(page)} が結果の値 {top} と違います")
        model = _walk_model(page, ctx)
        if model and not _close(model["total"], top, 1e-9):
            ctx.fail(f"探す (本物): 計算モデル (calc_from_state) の値 {model['total']} が結果の値 {top} と違います")
        open_tab(page, "search")
        page.wait_for_timeout(300)
        if page.locator(f'{P} [data-sr-note="stale"]').count():
            ctx.fail("探す (本物): 結果の組を装備に入れただけで「条件が変わりました」が出ます")
        # 入れたあとの 1 位の行は「いまの装備と同じ」で、「いまより」もいまの装備 (= 1 位) と比べる (前は探す前の装備のまま +x% と出た)
        row1 = page.inner_text(f"{P} .sr-result >> nth=0")
        if "いまの装備と同じ" not in row1 or "いまと同じくらい" not in row1 or "いまより +" in row1:
            ctx.fail(f"探す (本物): 1 位を装備に入れたあとの 1 位の行が、いまの装備と比べていません: {row1!r}")
        check_errors(ctx, "探す (本物・歴戦王)")
    except Exception as e:
        ctx.fail(f"探す (本物・歴戦王) が途中で止まりました: {_search_err(e)}")
        try:
            ctx.shot("real-arch-stopped")
        except Exception:
            pass
    finally:
        context.close()
    return ctx


def search_real_multi_two_weapons(browser, ctx_opts, server, base_url) -> Ctx:
    """7. 本物の Worker: 多頭『英雄の証』→ このクエストで装備を探す → 武器 2 本の案 → 2 本目を装備に入れる。倒していない歴戦王の γ を外す。"""
    context, page, ctx = _real_open(browser, ctx_opts, server, base_url, "search-real-multi")
    P = SEARCH_PANEL
    search, qid, hps = TH_MULTI_QUEST
    try:
        page.evaluate(JS_SEARCH_SETUP)
        page.evaluate("""async () => { const S = await import('./app/state.js'); S.selectMonster(null); await S.flushState(); }""")
        open_tab(page, "target")
        page.evaluate(JS_TH_RESET)
        page.click(f"{TARGET_PANEL} [data-th-quest-by-name]")
        _th_choose_in_sheet(page, search, search)
        page.wait_for_selector(f'{TARGET_PANEL} [data-th-card="multi"] [data-th-subject]', timeout=15000)
        # ヌ・エグドラの歴戦王は倒していないことにする (γ 防具・狩猟証γ の護石を使わない)
        gnu = page.evaluate("""async () => { const S = await import('./app/state.js'); const D = await import('./app/data.js');
          const H = await import('./app/model/hunt.js');
          const r = H.archTemperedRewards(D.getTargetData()).find((x) => x.monster === 'ヌ・エグドラ');
          S.setArchTemperedHunted(r.monsterId, false); return r; }""")
        plan_card = page.locator(f"{TARGET_PANEL} section.card", has=page.locator('[data-th-card="plan"]'))
        plan_card.wait_for(timeout=15000)
        if "このクエストのおすすめ" not in plan_card.inner_text() or "2 本" not in plan_card.inner_text():
            ctx.fail(f"探す (本物): 相手タブの「このクエストのおすすめ」に武器 2 本の案がありません: {plan_card.inner_text()[:200]!r}")
        plan_card.locator("[data-th-search]").click()
        page.wait_for_selector('.app[data-active-tab="search"]', timeout=10000)
        page.wait_for_selector(f'{P} [data-sr="running"]', timeout=15000)
        if not page.locator(f'{P} [data-sr-two-weapons="on"]').count():
            ctx.fail("探す (本物): 多頭で属性が違うのに、武器のカードに「武器を 2 本使う」が出ていません")
        _real_wait_finished(page)
        snap = page.evaluate(JS_REAL_SNAP)
        if snap["kind"] != "plan" or snap["merge"] != "twoWeapons":
            ctx.fail(f"探す (本物): 多頭の Job が武器 2 本になっていません: {snap['kind']} / {snap['merge']}")
        if not snap["twoWeapons"] or not snap["topBuilds"] or len(snap["topBuilds"]) != 2:
            ctx.fail(f"探す (本物): 武器 2 本の案が結果にありません: {snap['twoWeapons']}")
        # 倒していない歴戦王の γ は探索の入力から外れ、結果にも出ない
        if not all(i in (snap["armorExclude"] or []) for i in gnu["armorIds"]) \
                or not all(i in (snap["fixedExclude"] or []) for i in gnu["charmFixedIds"]):
            ctx.fail("探す (本物): 倒していない歴戦王の γ 防具・狩猟証γ の護石が探索の入力から外れていません")
        used = {v for b in snap["allBuilds"] for v in list((b.get("armor") or {}).values()) + [b.get("charm")]}
        if used & set(gnu["armorIds"] + gnu["charmFixedIds"]) or gnu["monsterId"] in snap["gamma"]:
            ctx.fail("探す (本物): 倒していない歴戦王の γ 防具・護石が結果に出ています")
        rows = page.locator(f"{P} .sr-result")
        if not rows.count() or "全部倒すまで" not in page.inner_text(f"{P} .sr-result >> nth=0") \
                or "回" not in page.inner_text(f"{P} .sr-result >> nth=0"):
            ctx.fail("探す (本物): 多頭の結果が「全部倒すまで 約 n 回」になっていません")
        # 相手ごとの狙う部位を出す。ウズ・トゥナの一時的な部位 (水膜) は自動では選ばない (2026-10-22 の点検)
        parts_text = page.inner_text(f"{P} [data-sr-subject-parts]") if page.locator(f"{P} [data-sr-subject-parts]").count() else ""
        if "ウズ・トゥナ" not in parts_text or "水膜" in parts_text:
            ctx.fail(f"探す (本物): 多頭の相手ごとの狙う部位が出ていないか、水膜を選んでいます: {parts_text!r}")
        _first_row_visible(page, ctx, "探す (本物・多頭の結果)")
        if not page.locator(f"{P} [data-sr-row-second]").count():
            ctx.fail("探す (本物): 結果の行に 2 本目の武器が出ていません")
        if "回数の少ない順" not in page.inner_text(f"{P} #sr-results"):
            ctx.fail("探す (本物): 多頭の結果の見出しが「回数の少ない順」になっていません")
        check_layout(page, ctx, "探す (本物・多頭の結果)")
        ctx.shot("real-multi-results")
        rows.first.click()
        page.wait_for_selector('[data-sr-sheet="result"]')
        _wait_sheet_ready(page)
        if page.locator("[data-sr-per-subject] li").count() != len(hps):
            ctx.fail(f"探す (本物): 結果の詳しくの「相手ごと」が {len(hps)} 行ではありません")
        check_layout(page, ctx, "探す (本物・多頭の詳しく)")
        ctx.shot("real-multi-sheet", full_page=False)
        page.locator('.sheet [data-sr-action="apply2"]').click()
        page.wait_for_selector(".sheet", state="detached")
        after = page.evaluate(JS_SEARCH_BUILD)
        if not _same_build(after, snap["topBuilds"][1]):
            ctx.fail(f"探す (本物): 「2 本目の武器で装備に入れる」で 2 本目の組が入りません: {after.get('weapon')} / {snap['topBuilds'][1].get('weapon')}")
        check_errors(ctx, "探す (本物・多頭)")
    except Exception as e:
        ctx.fail(f"探す (本物・多頭) が途中で止まりました: {_search_err(e)}")
        try:
            ctx.shot("real-multi-stopped")
        except Exception:
            pass
    finally:
        context.close()
    return ctx


def search_offline_retry(browser, ctx_opts, server, base_url) -> Ctx:
    """8. 電波が無くて探す処理 (Worker も画面の処理も) を読み込めない → 日本語の文と「再読み込み」→ 電波が戻れば「もう一度」で探せる。
    (前は画面の処理に切り替えたままになり、再読み込みするまで英語の文で失敗し続けた。2026-10-22 の点検)"""
    context, page, ctx = _real_open(browser, ctx_opts, server, base_url, "search-offline")
    P = SEARCH_PANEL
    try:
        page.evaluate(JS_SEARCH_SETUP)
        open_tab(page, "search")
        server.offline = True
        try:
            _search_start(page)
            _search_status(page, "error", timeout=20000)
        finally:
            server.offline = False
        ctx.take_errors()  # 読み込めなかったこと自体のコンソールの出力は数えない
        note = page.locator(f'{P} [data-sr-note="error"]')
        text = note.inner_text()
        if "読み込めませんでした" not in text or "Importing" in text.split("くわしく")[0]:
            ctx.fail(f"探す (電波なし): 読み込めなかったときの文が日本語になっていません: {text[:160]!r}")
        if not note.locator('[data-sr-action="reload"]').count():
            ctx.fail("探す (電波なし): 「再読み込み」のボタンがありません")
        ctx.shot("search-offline-error", full_page=False)
        note.locator("button", has_text="もう一度").click()
        _real_wait_finished(page)
        snap = page.evaluate(JS_REAL_SNAP)
        if snap["inline"] or not snap["n"]:
            ctx.fail(f"探す (電波なし): 電波が戻っても「もう一度」で Worker で探せません: inline {snap['inline']} / {snap['n']} 件")
        check_errors(ctx, "探す (電波なし → もう一度)")
    except Exception as e:
        ctx.fail(f"探す (電波なし) が途中で止まりました: {_search_err(e)}")
    finally:
        server.offline = False
        context.close()
    return ctx


def _broken_last_variants() -> list[tuple[str, dict, bool]]:
    """(説明, mhwilds-sns:search-last の result, 行を開いて確かめるか)"""
    b = {"weapon": None, "armor": {"head": None}, "charm": None, "decorations": {}, "limitBreak": {}}
    return [
        ("スキルに null", {"status": "done", "results": [{"build": b, "value": 900, "skills": [None]}]}, True),
        ("足りないスキルに null", {"status": "infeasible", "results": [], "infeasible": {"missing": [None, 5]}}, False),
        ("相手ごとに null", {"status": "done", "results": [{"build": b, "value": 900, "perSubject": [None, 5],
                                                         "builds": [None, 3], "defense": {"ok": True, "rows": [None]}}]}, True),
        ("装飾品の形が違う", {"status": "done", "results": [{"build": {**b, "decorations": {"weapon": 5}, "armor": "x"},
                                                          "value": 900, "score": 3, "baseline": "x"}]}, True),
    ]


def search_broken_last(browser, ctx_opts, server, base_url) -> Ctx:
    """9. 保存した最後の結果 (search-last) の中が壊れていても、探すタブが開ける・行を開ける (前は開くたびに落ちた)。"""
    context, page, ctx = _search_open(browser, ctx_opts, server, base_url, "search-broken-last", fake="step=20")
    P = SEARCH_PANEL
    try:
        for label, result, open_row in _broken_last_variants():
            page.evaluate("""async (result) => { const D = await import('./app/store.js');
              await D.kvSet('mhwilds-sns:search-last', { savedAt: '2026-10-22T00:00:00Z', inputKey: 'k0', summary: null, result }); }""", result)
            page.reload(wait_until="load")
            wait_app_ready(page)
            open_tab(page, "search")
            page.wait_for_timeout(500)
            broken = page.evaluate(JS_BROKEN, ["search", BROKEN_TITLES])
            if broken:
                ctx.fail(f"探す (壊れた search-last: {label}): エラーの表示 {broken[:2]}")
                continue
            if open_row and page.locator(f"{P} .sr-result").count():
                page.locator(f"{P} .sr-result").first.click()
                page.wait_for_selector('[data-sr-sheet="result"]', timeout=5000)
                _close_sheets(page)
            check_errors(ctx, f"探す (壊れた search-last: {label})")
    except Exception as e:
        ctx.fail(f"探す (壊れた search-last) が途中で止まりました: {_search_err(e)}")
    finally:
        context.close()
    return ctx


def run_search(browser, device: dict, bname: str, server: Server, base_url: str, args, failures: list, notes: list):
    """探すタブの流れを全部動かし、失敗とメモを failures / notes に足す (--robust-only か、--only に search が無ければ何もしない)。"""
    if args.robust_only or (args.only and "search" not in args.only.split(",")):
        return
    light = {**device, "color_scheme": "light"}
    dark = {**device, "viewport": {"width": 375, "height": 667}, "color_scheme": "dark"}
    runs = [
        ("search-walkthrough", lambda: search_walkthrough(browser, light, server, base_url)),
        ("search-cancel", lambda: search_cancel_and_tabs(browser, light, server, base_url)),
        ("search-required", lambda: search_guidance_and_required(browser, light, server, base_url)),
        ("search-failures", lambda: search_failures(browser, light, server, base_url)),
        ("search-dark-375", lambda: search_dark_375(browser, dark, server, base_url)),
        # 本物の Worker でつなぐ (3f)
        ("search-real-arch", lambda: search_real_arch_tempered(browser, light, server, base_url)),
        ("search-real-multi", lambda: search_real_multi_two_weapons(browser, dark, server, base_url)),
        # 2026-10-22 の点検の直し: 電波が無くて読み込めない → もう一度・壊れた search-last
        ("search-offline", lambda: search_offline_retry(browser, light, server, base_url)),
        ("search-broken-last", lambda: search_broken_last(browser, light, server, base_url)),
    ]
    for name, fn in runs:
        print(f"--- {bname} {name}", flush=True)
        res = fn()
        for c in (res if isinstance(res, list) else [res]):
            failures += c.failures
            notes += c.notes


@scenario_check
def power_uses_target_mix(page, ctx: Ctx):
    """相手タブの「割合で混ぜる」が火力タブの期待値 (加重平均) に入ること。傷口の無い部位を狙うと警告が出ること。"""
    snap = page.evaluate(JS_STATE_SNAPSHOT)
    try:
        page.evaluate(JS_POWER_SETUP)
        info = page.evaluate("""async () => { const D = await import('./app/data.js'); const S = await import('./app/state.js');
          await D.loadTargetData(); const t = D.getTargetData();
          const m = t.lists.monsters.find((x) => x.name === 'レ・ダウ');
          const named = m.parts.filter((p) => !p.unknownPart);
          const a = named[0]; const b = named[named.length - 1];
          S.selectMonster(m.id, a.key);
          S.setTabState('target', { mix: { on: true, monsterId: m.id, weights: { [a.key]: 0.75, [b.key]: 0.25 } } });
          return { a: { hitzone: a.hitzone, wound: a.wound }, b: { hitzone: b.hitzone, wound: b.wound } }; }""")
        open_tab(page, "power")
        page.wait_for_function(
            "() => { const e = document.querySelector('[data-tab-panel=\"power\"] [data-power-target]');"
            " return !!e && e.textContent.includes('75%'); }",
            timeout=10000)
        exp = page.evaluate(JS_POWER_EXPECT, [{"w": 0.75, **info["a"]}, {"w": 0.25, **info["b"]}])
        if not _close(_power_total(page), exp["total"]):
            ctx.fail(f"割合で混ぜた期待値が加重平均と合いません: 画面 {_power_total(page)} / 計算 {exp['total']}")
        check_layout(page, ctx, "火力タブ (部位を割合で混ぜた)")
        # 装備タブの火力の要約も同じ加重平均になる (割合で混ぜる指定を無視しない)
        open_tab(page, "equip")
        page.wait_for_selector(f'{EQUIP_PANEL} [data-eq="power-result"]', timeout=10000)
        eq_total = float(page.get_attribute(f"{EQUIP_PANEL} [data-eq-total]", "data-eq-total") or "nan")
        if not _close(eq_total, exp["total"]):
            ctx.fail(f"割合で混ぜたとき、装備タブの期待値が加重平均と合いません: 画面 {eq_total} / 計算 {exp['total']}")
        if "75%" not in page.inner_text(f'{EQUIP_PANEL} [data-eq="power"]'):
            ctx.fail("割合で混ぜたとき、装備タブの火力の要約の相手に割合が出ていません")
        open_tab(page, "power")
        # 傷口の無い部位で「傷口を狙う」→ 警告
        ok = page.evaluate("""async () => { const D = await import('./app/data.js'); const S = await import('./app/state.js');
          for (const m of D.getTargetData().lists.monsters) {
            const p = m.parts.find((x) => !x.unknownPart && x.wound == null);
            if (p) { S.selectMonster(m.id, p.key); S.setWound(true); return true; }
          }
          return false; }""")
        if ok:
            page.wait_for_selector(f"{POWER_PANEL} [data-power-warnings]", timeout=10000)
            if "傷口ができません" not in page.inner_text(f"{POWER_PANEL} [data-power-warnings]"):
                ctx.fail("傷口の無い部位で傷口を狙ったのに「傷口ができません」の警告がありません")
    finally:
        page.evaluate(JS_STATE_RESTORE, snap)


# ---------------------------------------------------------------- 通しの操作 (担当: integrate)
#
# 本人が実際にやる順番で、画面だけを触って装備を組み、計算モデルと値が合うかを確かめる:
#   武器 (破滅のキリエヴェルド 属性激化 に 火 440) → 防具 5 部位 (2 部位は限界突破) → 痛撃の護石Ⅲ → 装飾品 →
#   相手 (アルシュベルドの頭) → 火力タブ (期待値・効き目) → 護石タブ (c0001 が OK・泣シミュ形式) →
#   再読み込みで戻る → 電波なしで再読み込みしても開く。
# 画面に出たスキル一覧と期待値は、tests/calc_from_state.mjs (計算モデルだけで計算する) の結果と比べる。

WALK_ARMOR = [  # (部位, 検索語, 名前, 限界突破する)
    ("head", "護兇爪竜ヘルム", "護兇爪竜ヘルムβ", True),
    ("chest", "護火竜メイル", "護火竜メイルβ", False),
    ("arms", "護火竜アーム", "護火竜アームβ", True),
    ("waist", "護兇爪竜コイル", "護兇爪竜コイルβ", False),
    ("legs", "護火竜グリーヴ", "護火竜グリーヴβ", False),
]
WALK_DECOS = [  # (スロット, 検索語, 名前)
    ("weapon:0", "火炎・匠", "火炎・匠珠【３】"),
    ("weapon:1", "属会・火炎", "属会・火炎珠【３】"),
    ("weapon:2", "達人珠Ⅲ", "達人珠Ⅲ【３】"),
    ("head:0", "挑戦", "挑戦珠【３】"),        # 限界突破で ②→③ になったスロット
    ("arms:0", "連撃", "連撃珠【３】"),        # 同上
    ("waist:0", "渾身", "渾身珠【２】"),
]
WALK_CHARM = ("痛撃の護石", "痛撃の護石Ⅲ")
WALK_MONSTER = ("あるしゅべるど", "アルシュベルド", "head")
WALK_NAKI_C0001 = "ガード性能,3,属性吸収,1,,0,2,0,0,0,0,0"

JS_WALK_RESET = """async () => { const S = await import('./app/state.js');
  S.clearBuild(); for (const s of [...S.getState().mySets]) S.deleteMySet(s.id);
  S.setTabState('equip', { myWeapons: [], armorRank: 'all', armorRarity: 'all' });
  S.setTabState('target', { mix: null });
  S.setSharpness(null); S.setCombo(null); S.resetUptime();
  S.setTargetMode('monster'); S.selectMonster(null); S.setWound(false);
  await S.flushState(); }"""

JS_WALK_STATE = """async () => { const S = await import('./app/state.js'); const s = S.getState();
  return JSON.parse(JSON.stringify({ build: s.build, target: s.target, uptimes: s.uptimes, combo: s.combo,
    sharpness: s.sharpness, myWeapons: (s.tabs.equip && s.tabs.equip.myWeapons) || [] })); }"""

JS_WALK_SCREEN_SKILLS = """() => [...document.querySelectorAll('[data-tab-panel="equip"] li.eq-skill')].map((li) => {
  const n = li.querySelector('.eq-skill-name').cloneNode(true);
  n.querySelectorAll('.eq-skill-kind').forEach((x) => x.remove());
  return { skillId: Number(li.dataset.skillId), level: Number(li.dataset.skillLevel), name: n.textContent.trim() };
})"""


def _walk_choose(page, opener: str, search: str, label: str):
    """opener の PickerField を開き、search で探して、名前が label を含む最初の候補を選ぶ。"""
    m = re.search(r'data-eq-slot="([^:"]+):', opener)
    if m:
        _open_deco_group(page, m.group(1))
    page.locator(f"{opener} .picker-field .row").first.click()
    page.wait_for_selector(".sheet .picker-list")
    page.fill(".sheet input[type=search]", search)
    page.locator(".sheet .picker-item:not(.picker-none)", has_text=label).first.click()
    page.wait_for_selector(".sheet .picker-list", state="detached")


def _walk_model(page, ctx: Ctx) -> dict | None:
    """いまの状態を node の計算モデル (tests/calc_from_state.mjs) に渡した結果。"""
    node = shutil.which("node")
    if not node:
        ctx.note("node が無いので、計算モデルとの突き合わせを飛ばしました")
        return None
    payload = page.evaluate("""async () => { const S = await import('./app/state.js');
      const T = await import('./app/ui/tabs/charms.js'); await T.loadLocalCharms();
      return { state: JSON.parse(JSON.stringify(S.getState())), localCharms: T.getLocalCharms() }; }""")
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "state.json"
        f.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        r = subprocess.run([node, str(REPO / "tests" / "calc_from_state.mjs"), str(f)],
                           capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        ctx.fail(f"計算モデルでの計算に失敗: {r.stderr.strip()[-400:]}")
        return None
    return json.loads(r.stdout)


def _walk_compare(page, ctx: Ctx, model: dict, where: str):
    """装備タブのスキル一覧・火力の要約と、火力タブの期待値・スキルなし比を計算モデルと比べる (今の画面のタブは問わない)。"""
    open_tab(page, "equip")
    page.wait_for_selector(f'{EQUIP_PANEL} [data-eq="power-result"]', timeout=15000)
    screen = page.evaluate(JS_WALK_SCREEN_SKILLS)
    want = [{"skillId": s["skillId"], "level": s["level"], "name": s["name"]} for s in model["skills"]]
    if screen != want:
        ctx.fail(f"{where}: 装備タブの発動スキルが計算モデルと違います: 画面 {screen} / 計算 {want}")
    eq_total = float(page.get_attribute(f"{EQUIP_PANEL} [data-eq-total]", "data-eq-total") or "nan")
    eq_vs = float(page.get_attribute(f"{EQUIP_PANEL} [data-eq-vs]", "data-eq-vs") or "nan")
    if not (_close(eq_total, model["total"]) and _close(eq_vs, model["vsNoSkillsPct"])):
        ctx.fail(f"{where}: 装備タブの期待値/スキルなし比が計算モデルと違います: "
                 f"画面 {eq_total} / {eq_vs} 計算 {model['total']} / {model['vsNoSkillsPct']}")
    shown = page.inner_text(f"{EQUIP_PANEL} .eq-power-num").replace(",", "")
    if shown != str(round(model["total"])):
        ctx.fail(f"{where}: 装備タブの期待値の表示 {shown} が計算 {model['total']:.2f} の四捨五入と違います")
    open_tab(page, "power")
    page.wait_for_selector(f"{POWER_PANEL} [data-power-total]", timeout=15000)
    pw_total = _power_total(page)
    pw_vs = float(page.get_attribute(f"{POWER_PANEL} [data-power-vs]", "data-power-vs") or "nan")
    if not (_close(pw_total, model["total"]) and _close(pw_vs, model["vsNoSkillsPct"])):
        ctx.fail(f"{where}: 火力タブの期待値/スキルなし比が計算モデルと違います: "
                 f"画面 {pw_total} / {pw_vs} 計算 {model['total']} / {model['vsNoSkillsPct']}")
    target = page.inner_text(f"{POWER_PANEL} [data-power-target]")
    if model["target"] not in target:
        ctx.fail(f"{where}: 火力タブの相手が {target!r} (計算は {model['target']})")


@scenario_check
def walkthrough_full_build(page, ctx: Ctx):
    """通しの操作: 画面だけで装備を組み、相手を選び、火力・護石を見て、再読み込み・電波なしでも戻ること。"""
    snap = page.evaluate(JS_STATE_SNAPSHOT)
    try:
        _charms_reset(page)
        page.evaluate(JS_WALK_RESET)
        open_tab(page, "equip")
        P = EQUIP_PANEL

        # --- 武器: 破滅のキリエヴェルド (属性激化) に 火 440 を入れて「持っている武器」にする
        _walk_choose(page, f'{P} [data-eq="weapon"]', "キリエヴェルド", "属性激化")
        form = f'{P} [data-eq="artian-form"]'
        page.wait_for_selector(form)
        page.select_option(f"{form} select", label="火")
        val = page.locator(f"{form} .field", has_text="属性値").locator(".input-number")
        val.fill("440")
        val.blur()
        page.click(f'{P} [data-eq="artian-add"]')
        page.wait_for_selector(f'{P} [data-eq="artian-edit"]')
        st = page.evaluate(JS_WALK_STATE)
        mine = st["myWeapons"][0] if st["myWeapons"] else {}
        if not (mine.get("id") == st["build"]["weapon"] and mine.get("baseWeaponId") == 1182
                and mine.get("element") == {"type": "fire", "value": 440}):
            ctx.fail(f"通し: 武器 (属性激化・火 440) が状態に入っていません: {st['build']['weapon']} / {mine}")

        # --- 防具 5 部位 (頭と腕は限界突破)
        for part, search, name, lb in WALK_ARMOR:
            _walk_choose(page, f'{P} [data-eq-part="{part}"]', search, name)
            if name not in page.inner_text(f'{P} [data-eq-part="{part}"]'):
                ctx.fail(f"通し: {part} に {name} が入っていません")
            if lb:
                page.locator(f'{P} [data-eq-part="{part}"] .toggle').click()

        # --- 護石: 痛撃の護石Ⅲ (固定の護石)
        _walk_choose(page, f'{P} [data-eq="charm"]', *WALK_CHARM)

        # --- 装飾品 (限界突破で増えた Lv3 スロットにも入れる)
        for slot, search, name in WALK_DECOS:
            _walk_choose(page, f'{P} [data-eq-slot="{slot}"]', search, name)
        st = page.evaluate(JS_WALK_STATE)
        if not (st["build"]["limitBreak"]["head"] and st["build"]["limitBreak"]["arms"]
                and st["build"]["charm"] == 187 and all(st["build"]["armor"].values())):
            ctx.fail(f"通し: 防具・限界突破・護石が状態に入っていません: {st['build']}")
        n_decos = sum(1 for v in st["build"]["decorations"].values() for x in v if x is not None)
        if n_decos != len(WALK_DECOS):
            ctx.fail(f"通し: 装飾品が {n_decos} 個しか入っていません: {st['build']['decorations']}")
        if page.locator(f'{P} [data-eq="issues"] .notice-error').count():
            ctx.fail(f"通し: 入る装飾品だけなのにエラーが出ています: {page.inner_text(f'{P} [data-eq=issues]')}")

        # --- 相手: アルシュベルドの頭
        open_tab(page, "target")
        search, mname, part = WALK_MONSTER
        page.locator(f"{TARGET_PANEL} .picker-field .row").first.click()
        page.wait_for_selector(".sheet .picker-list")
        page.fill(".sheet input[type=search]", search)
        page.locator(".sheet .picker-item").filter(
            has=page.locator(".picker-label", has_text=re.compile(f"^{mname}$"))).first.click()
        page.wait_for_selector(".sheet", state="detached")
        page.click(f'{TARGET_PANEL} [data-target-parts] [data-part="{part}"]')
        st = page.evaluate(JS_WALK_STATE)
        if st["target"]["partKey"] != part or st["target"]["monsterId"] is None:
            ctx.fail(f"通し: 相手 (アルシュベルドの頭) が状態に入っていません: {st['target']}")
        check_layout(page, ctx, "通し: 相手タブ")
        ctx.shot("walk-target")

        # --- 火力タブ: 期待値と、スキルごとの効き目・スキル火力表
        open_tab(page, "power")
        page.wait_for_selector(f"{POWER_PANEL} [data-power-total]", timeout=15000)
        if not page.locator(f"{POWER_PANEL} [data-power-contrib] .pw-contrib-name").count():
            ctx.fail("通し: 火力タブにスキルごとの効き目が出ていません")
        page.wait_for_selector(f"{POWER_PANEL} [data-power-table] tr[data-skill-row]", timeout=30000)
        check_layout(page, ctx, "通し: 火力タブ")
        ctx.shot("walk-power")
        page.evaluate("window.scrollTo(0, 400)")
        page.locator(f"{POWER_PANEL} button", has_text="相手を変える").click()
        page.wait_for_selector('.app[data-active-tab="target"]')
        page.wait_for_timeout(200)
        if page.evaluate("window.scrollY") > 5:
            ctx.fail(f"「相手を変える」で相手タブの先頭 (モンスターの行) から出ません: scrollY {page.evaluate('window.scrollY')}")
        # シートを開いたままブラウザの「戻る」→ シートだけ閉じて、アプリは離れない
        page.locator(f"{TARGET_PANEL} .picker-field .row").first.click()
        page.wait_for_selector(".sheet .picker-list")
        page.go_back(wait_until="commit")
        try:
            page.wait_for_selector(".sheet", state="detached", timeout=5000)
            if not page.locator('.app[data-app-ready="1"]').count():
                ctx.fail(f"シートを開いたまま「戻る」とアプリを離れます: {page.url}")
        except Exception:
            ctx.fail(f"シートを開いたまま「戻る」を押してもシートが閉じません (url {page.url})")
        if not page.url.startswith(ctx.base_url):
            # アプリを離れてしまったら開き直して続ける (この後の確認を止めない)
            page.goto(ctx.base_url, wait_until="load")
            wait_app_ready(page)
        open_tab(page, "power")

        # --- 画面の値と計算モデル (node) の値の突き合わせ
        model = _walk_model(page, ctx)
        if model:
            if model["errors"]:
                ctx.fail(f"通し: 計算モデルで装備のエラー: {model['errors']}")
            names = page.locator(f"{POWER_PANEL} [data-power-contrib] .pw-contrib-name")
            if model["topContribution"] and not names.first.inner_text().startswith(model["topContribution"]):
                ctx.fail(f"通し: 効き目の一番上が {names.first.inner_text()!r} (計算では {model['topContribution']})")
            _walk_compare(page, ctx, model, "通し")
            ctx.note(f"通し: 期待値 {model['total']:.2f} (スキルなし比 +{model['vsNoSkillsPct']:.1f}%)・"
                     f"スキル {len(model['skills'])} 個・斬れ味 {model['sharpness']}・相手 {model['target']}")
        open_tab(page, "equip")
        check_layout(page, ctx, "通し: 装備タブ")
        ctx.shot("walk-equip")

        # --- 護石タブ: 本人の護石 c0001 が検証 OK で出て、泣シミュ形式が 12 項目の決まった形
        open_tab(page, "charms")
        badge = page.locator(f'{CHARMS_PANEL} [data-charm-id="c0001"] .row-end .badge')
        if not badge.count() or badge.inner_text().strip() != "OK":
            ctx.fail(f"通し: 護石 c0001 の検証が OK になっていません: {badge.inner_text() if badge.count() else '行なし'}")
        model_row = page.evaluate("""async () => { const C = await import('./app/model/charms.js');
          const D = await import('./app/data.js'); const d = D.getCoreData();
          return C.toNakiSimRow(d.lists.charms.find((c) => c.id === 'c0001'), d.skills); }""")
        if model_row != WALK_NAKI_C0001:
            ctx.fail(f"通し: 計算モデルの泣シミュ形式が {model_row!r} (期待 {WALK_NAKI_C0001!r})")
        page.click(f'{CHARMS_PANEL} [data-charm-id="c0001"]')
        page.wait_for_selector('[data-charm-sheet="detail"]')
        if WALK_NAKI_C0001 not in page.inner_text('[data-charm-sheet="detail"]'):
            ctx.fail("通し: 護石 c0001 の詳しい画面に泣シミュ形式の行が出ていません")
        _close_sheets(page)
        page.click(f'{CHARMS_PANEL} [data-charm-action="export-naki"]')
        page.wait_for_selector('[data-charm-export="naki"]')
        if WALK_NAKI_C0001 not in page.locator("[data-charm-export-text]").input_value().splitlines():
            ctx.fail("通し: 泣シミュ形式の書き出しに c0001 の行がありません")
        _close_sheets(page)
        check_layout(page, ctx, "通し: 護石タブ")
        ctx.shot("walk-charms")
        open_tab(page, "settings")
        check_layout(page, ctx, "通し: 設定タブ")
        ctx.shot("walk-settings")

        # --- 再読み込みで選択が戻る
        before = page.evaluate(JS_WALK_STATE)
        page.evaluate("async () => (await import('./app/state.js')).flushState()")
        page.reload(wait_until="load")
        wait_app_ready(page)
        after = page.evaluate(JS_WALK_STATE)
        if after != before:
            ctx.fail(f"通し: 再読み込みで選択が戻りません: 前 {before} / 後 {after}")
        if model:
            _walk_compare(page, ctx, model, "通し (再読み込み後)")

        # --- 電波なしで再読み込みしても開く (Service Worker)
        if ctx.sw and page.evaluate("'serviceWorker' in navigator"):
            page.evaluate("navigator.serviceWorker.ready.then(() => true)")
            if not page.evaluate("!!navigator.serviceWorker.controller"):
                page.reload(wait_until="load")
                wait_app_ready(page)
            ctx.take_errors()
            ctx.server.offline = True
            try:
                page.reload(wait_until="load")
                wait_app_ready(page)
                if page.evaluate(JS_WALK_STATE) != before:
                    ctx.fail("通し: 電波なしで開き直すと選択が戻りません")
                if model:
                    _walk_compare(page, ctx, model, "通し (電波なし)")
                open_tab(page, "target")
                if "アルシュベルド" not in page.inner_text(TARGET_PANEL):
                    ctx.fail("通し: 電波なしで相手タブにアルシュベルドが出ません")
                errs = [e for e in ctx.take_errors() if "sw.js" not in e]
                if errs:
                    ctx.fail(f"通し: 電波なしで開いたときのエラー {len(errs)} 件: {errs[:6]}")
            except Exception as e:
                ctx.fail(f"通し: 電波なしで開けません: {e}")
                ctx.take_errors()
            finally:
                ctx.server.offline = False
    finally:
        _charms_reset(page)
        page.evaluate(JS_STATE_RESTORE, snap)


# ---------------------------------------------------------------- 1 つの端末設定での流れ

def run_scenario(pw, browser, name: str, ctx_opts: dict, server: Server, base_url: str,
                 tabs: list[str], with_sw_checks: bool) -> Ctx:
    context = browser.new_context(**ctx_opts)
    # 未処理の Promise の拒否を console.error にする (ブラウザによっては pageerror にもコンソールにも出ないため)
    context.add_init_script("""window.addEventListener('unhandledrejection', (e) => {
      const r = e.reason; console.error('unhandledrejection: ' + (r && r.stack ? r.stack : r && r.message ? r.message : String(r)));
    });""")
    page = context.new_page()
    ctx = Ctx(scenario=name, page=page, base_url=base_url, server=server, sw=with_sw_checks)

    def on_console(msg):
        if msg.type == "error":
            ctx.errors.append(f"console.error: {msg.text}")

    def on_response(res):
        url = res.url
        if url.startswith(base_url.rsplit("/mhwilds-sns/", 1)[0]) and res.status >= 400:
            ctx.errors.append(f"HTTP {res.status}: {url}")

    page.on("console", on_console)
    page.on("pageerror", lambda e: ctx.errors.append(f"pageerror: {e}"))
    page.on("response", on_response)
    page.on("request", lambda r: ctx.page_requests.append(r.url))

    try:
        page.goto(base_url, wait_until="load")
        wait_app_ready(page)
        check_errors(ctx, "起動")

        target_seen_before = False
        for tab in tabs:
            if tab == "target":
                target_seen_before = any(u.endswith(("/data/monsters.json", "/data/quests.json")) for u in ctx.page_requests)
            open_tab(page, tab)
            check_layout(page, ctx, f"{tab} タブ")
            for fn in TAB_CHECKS.get(tab, []):
                try:
                    fn(page, ctx)
                except Exception as e:  # 確認の関数そのものの失敗も報告する
                    ctx.fail(f"{tab} の確認 {fn.__name__} が例外: {e}")
            ctx.shot(tab)
            check_errors(ctx, f"{tab} タブ")

        if page.locator(".update-banner").count():
            ctx.fail("初めて開いただけなのに「新しい版があります」の帯が出ています")

        if "target" in tabs and tabs[0] != "target":
            if target_seen_before:
                ctx.fail("相手タブを開く前に monsters.json / quests.json を読んでいます (遅延読み込みになっていない)")
            if not any(u.endswith("/data/monsters.json") for u in ctx.page_requests):
                ctx.fail("相手タブを開いても monsters.json を読んでいません")

        for fn in SCENARIO_CHECKS:
            try:
                fn(page, ctx)
            except Exception as e:
                ctx.fail(f"確認 {fn.__name__} が例外: {e}")
            check_errors(ctx, fn.__name__)

        if with_sw_checks:
            sw_checks(page, context, ctx)
    except Exception as e:
        ctx.fail(f"流れの途中で止まりました: {e}")
        try:
            ctx.shot("stopped")
        except Exception:
            pass
        traceback.print_exc()
    finally:
        context.close()
    return ctx


def data_failure_scenario(browser, ctx_opts: dict, server: Server, base_url: str) -> Ctx:
    """データが読めないとき: 装備タブに「読み込めませんでした」と「もう一度」が出て、設定タブは開け、もう一度で直ること。"""
    context = browser.new_context(**ctx_opts, service_workers="block")
    page = context.new_page()
    ctx = Ctx(scenario="data-failure", page=page, base_url=base_url, server=server)
    page.on("pageerror", lambda e: ctx.errors.append(f"pageerror: {e}"))
    broken = {"on": True}

    def handler(route):
        if broken["on"]:
            route.fulfill(status=404, body="not found")
        else:
            route.continue_()

    page.route("**/data/armor.json", handler)
    try:
        page.goto(base_url, wait_until="load")
        page.wait_for_selector('[data-tab-panel="equip"] .notice-error', timeout=20000)
        ctx.shot("equip-error", full_page=False)
        open_tab(page, "settings")
        check_layout(page, ctx, "データが読めないときの設定タブ")
        broken["on"] = False
        page.click('button[data-tab="equip"]')
        page.click('[data-tab-panel="equip"] .notice-error button')
        wait_app_ready(page)
        page.wait_for_selector('[data-tab-panel="equip"] [data-tab-ready="1"]', timeout=20000)
        errs = ctx.take_errors()
        if errs:
            ctx.fail(f"ページのエラー: {errs[:4]}")
    except Exception as e:
        ctx.fail(f"データが読めないときの表示・やり直しが通りません: {e}")
        try:
            ctx.shot("data-failure-stopped")
        except Exception:
            pass
    finally:
        context.close()
    return ctx


def sw_checks(page, context, ctx: Ctx):
    """Service Worker: オフラインで開けるか・更新の帯が出るか。"""
    supported = page.evaluate("'serviceWorker' in navigator")
    if not supported:
        ctx.note("このブラウザでは Service Worker が使えないため、オフラインと更新の確認は飛ばしました")
        return
    # 登録が済んで有効になるのを待ち、受け持たれた状態で開き直す
    page.evaluate("navigator.serviceWorker.ready.then(() => true)")
    page.reload(wait_until="load")
    wait_app_ready(page)
    try:
        page.wait_for_function("!!navigator.serviceWorker.controller", timeout=10000)
    except Exception:
        ctx.fail("Service Worker がページを受け持っていません (オフラインで開けない)")
        return
    ctx.take_errors()

    # --- オフライン (配信を止めたのと同じ状態にする。webkit は set_offline だと Service Worker ごと止まるため)
    ctx.server.offline = True
    try:
        page.reload(wait_until="load")
        wait_app_ready(page)
        for tab in ["equip", "target", "settings"]:
            open_tab(page, tab)
        ctx.shot("offline-target-settings")
        # 電波が無いときの sw.js の更新確認の失敗はブラウザが出すもので、アプリの不具合ではない
        errs = [e for e in ctx.take_errors() if "sw.js" not in e]
        if errs:
            ctx.fail(f"電波なしで開く: エラー {len(errs)} 件: {errs[:6]}")
    except Exception as e:
        ctx.fail(f"電波なしで開けません: {e}")
        ctx.take_errors()
    finally:
        ctx.server.offline = False

    # --- 更新の帯
    new_version = f"smoke-{int(time.time())}"
    ctx.server.sw_version_override = new_version
    try:
        page.evaluate("navigator.serviceWorker.getRegistration().then((r) => r && r.update())")
        page.wait_for_selector(".update-banner", timeout=20000)
        check_layout(page, ctx, "更新の帯")
        ctx.shot("update-banner", full_page=False)
        with page.expect_navigation(timeout=20000):
            page.click(".update-banner button")
        wait_app_ready(page)
        open_tab(page, "settings")
        page.wait_for_function(
            "(v) => document.querySelector('[data-tab-panel=\"settings\"]').innerText.includes(v)",
            arg=new_version, timeout=10000)
        check_errors(ctx, "更新して再読み込み")
    except Exception as e:
        ctx.fail(f"更新の帯の流れが通りません: {e}")
        try:
            ctx.shot("update-failed")
        except Exception:
            pass
    finally:
        ctx.server.sw_version_override = None


# ---------------------------------------------------------------- 事前の検査 (ブラウザ不要)

def precache_check() -> tuple[list[str], list[str]]:
    """sw.js の PRECACHE と実際のファイルの差。(失敗, 警告)"""
    fails, warns = [], []
    sw = (REPO / "sw.js").read_text(encoding="utf-8")
    m = re.search(r"const PRECACHE = \[(.*?)\];", sw, re.S)
    if not m:
        return ["sw.js に PRECACHE が見つかりません"], warns
    listed = set(re.findall(r"'\./([^']*)'", m.group(1)))
    listed.discard("")
    on_disk = {"index.html", "manifest.webmanifest"}
    for pat in ["app/**/*.js", "app/**/*.css", "app/icons/*.png", "app/vendor/LICENSE-*", "data/*.json"]:
        on_disk |= {p.relative_to(REPO).as_posix() for p in REPO.glob(pat) if p.is_file()}
    missing = sorted(on_disk - listed)
    gone = sorted(listed - on_disk)
    if missing:
        fails.append(f"sw.js の PRECACHE に無いファイル (オフラインで使えない): {missing}")
    if gone:
        fails.append(f"sw.js の PRECACHE にあるが存在しないファイル: {gone}")

    # VERSION の上げ忘れ: VERSION の末尾はファイルの中身のハッシュ (tools/sw_version.py が作る)。合っていなければ失敗
    # (上げずに公開すると、ホーム画面のアプリには変更がいつまでも届かないため)
    try:
        sys.path.insert(0, str(REPO / "tools"))
        import sw_version  # noqa: E402
        digest = sw_version.content_hash(REPO)
        if not sw_version.version_matches(sw_version.read_version(sw), digest):
            fails.append(f"sw.js の VERSION ({sw_version.read_version(sw)}) がファイルの中身 ({digest}) と合っていません。"
                         "PYTHONIOENCODING=utf-8 python tools/sw_version.py を実行して版を上げてください")
    except Exception as e:
        fails.append(f"sw.js の VERSION を確かめられません: {e}")
    return fails, warns


def syntax_check() -> list[str]:
    """JS の構文 (node --check)。node が無ければ飛ばす。"""
    node = shutil.which("node")
    if not node:
        return []
    fails = []
    files = [REPO / "sw.js", *sorted((REPO / "app").rglob("*.js"))]
    for f in files:
        r = subprocess.run([node, "--check", str(f)], capture_output=True, text=True, encoding="utf-8")
        if r.returncode != 0:
            fails.append(f"構文エラー {f.relative_to(REPO).as_posix()}: {r.stderr.strip().splitlines()[-1] if r.stderr else ''}")
    return fails


def manifest_check() -> list[str]:
    fails = []
    try:
        m = json.loads((REPO / "manifest.webmanifest").read_text(encoding="utf-8"))
    except Exception as e:
        return [f"manifest.webmanifest が読めません: {e}"]
    for icon in m.get("icons", []):
        src = icon.get("src", "")
        if src.startswith("/"):
            fails.append(f"manifest のアイコンが絶対パス: {src}")
        elif not (REPO / src).exists():
            fails.append(f"manifest のアイコンが無い: {src}")
    for key in ("start_url", "scope"):
        if str(m.get(key, "")).startswith("/"):
            fails.append(f"manifest の {key} が絶対パス: {m.get(key)}")
    return fails


# ---------------------------------------------------------------- 壊れにくさ (担当: review-robust)
#
# まっさらな保存領域 (新しい context) で 1 つずつ動かす流れ。main() の最後に run_robust() で呼ぶ
# (--robust-only でこれだけ動かせる)。端末は iPhone 13・ライト表示。配信は専用のサーバー (ファイルの差し替えができる)。
#   1. 保存できない環境: IndexedDB が無い / 開くと例外 / 開くと失敗 / 開くのが止まる / 書くと容量切れ
#      → 起動でき、全タブが開け、メモリで動き、書き出しにも今の状態が入り、設定タブに「保存できない」と出る
#   2. 途中で IndexedDB の接続が切れる (iPhone で長く裏に回したあとに起きる) → 開き直して保存を続けられる
#   3. 壊れた保存データ (型の違う値・無い id・壊れた端末の護石) → 全タブが開け、そのあとの保存も続けられる
#   4. 全データの書き出し → 初期化 → 読み込み (設定タブのボタンで) の往復 → 状態と端末の護石が元どおり。
#      壊れたテキスト・新しい版の書き出しは断り、"mhwilds-sns:" で始まらないキーは保存しない
#   5. Service Worker: 設定タブのリンク先 (ライセンス・CC BY-SA のデータ) が開ける / 版を上げると data の更新が届き、
#      古い版のキャッシュが消える / 同じオリジンの別サイト (earnings-monitor) の保存に触らない /
#      更新の途中で 1 ファイル取れなくても、電波なしで全タブが開ける
#   6. 入力欄の文字が 16px 以上 (全タブと picker の検索欄。タブごとの確認として毎回)
#   7. iPhone の Safari の落とし穴と manifest の id をファイルだけで調べる (robust_static_check。事前の検査として毎回)

APP_PREFIX = "mhwilds-sns:"
SETTINGS_PANEL = '[data-tab-panel="settings"]'
ROBUST_UNHANDLED = """window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason; console.error('unhandledrejection: ' + (r && r.stack ? r.stack : r && r.message ? r.message : String(r)));
});"""
# エラーの囲い (ErrorBoundary) やタブの読み込み失敗で出る見出し
BROKEN_TITLES = ["タブでエラーが起きました", "この画面を読み込めませんでした", "データを読み込めませんでした",
                 "この画面の作りが正しくありません"]
# 見えているタブの中だけを見る (隠れた別のタブのエラー表示は数えない)
JS_BROKEN = """([tab, titles]) => [...document.querySelectorAll(`[data-tab-panel="${tab}"] [role=alert]`)]
  .map((e) => e.innerText.replace(/\\s+/g, ' ').slice(0, 160))
  .filter((t) => titles.some((x) => t.includes(x)))"""

JS_SMALL_INPUTS = """
() => {
  const skip = ['checkbox', 'radio', 'range', 'file', 'hidden', 'button', 'submit', 'reset', 'color', 'image'];
  const bad = [];
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (skip.includes(type) || el.closest('[hidden]')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const fs = parseFloat(cs.fontSize);
    if (!(fs >= 15.95)) bad.push(`${el.tagName.toLowerCase()}${type ? '[' + type + ']' : ''}.${String(el.className).split(' ')[0]} ${fs}px`);
  }
  return bad;
}
"""


def _check_small_inputs(page, ctx: Ctx, where: str):
    bad = page.evaluate(JS_SMALL_INPUTS)
    if bad:
        ctx.fail(f"{where}: 文字が 16px 未満の入力欄があります (iPhone で触ると画面が拡大される): {bad[:6]}")


def _input_font_check(tab: str) -> TabCheck:
    def fn(page, ctx: Ctx):
        _check_small_inputs(page, ctx, f"{tab} タブ")
    fn.__name__ = f"robust_input_font_{tab}"
    return fn


for _tab in TABS:
    tab_check(_tab)(_input_font_check(_tab))


@tab_check("equip")
def robust_picker_search_font(page, ctx: Ctx):
    """picker の検索欄も 16px 以上 (装備タブの最初の選ぶ欄を開いて測り、閉じる)。"""
    opener = page.locator(f"{EQUIP_PANEL} .picker-field .row")
    if not opener.count():
        ctx.note("装備タブに選ぶ欄が無いので、picker の検索欄の文字の大きさは測っていません")
        return
    opener.first.click()
    try:
        page.wait_for_selector(".sheet input[type=search]", timeout=5000)
        _check_small_inputs(page, ctx, "picker の検索欄")
    except Exception:
        ctx.note("装備タブの最初の選ぶ欄に検索欄がありませんでした")
    finally:
        _close_sheets(page)


def _hover_outside_media(text: str) -> list[int]:
    """:hover が @media (hover: hover) の外にある行番号 (iPhone では触ったあと :hover の見た目が残る)。"""
    out, stack = [], []
    for m in re.finditer(r"@media[^{;]*\{|\{|\}|:hover", text):
        tok = m.group(0)
        if tok.startswith("@media"):
            stack.append("hover" if re.search(r"\(\s*hover\s*:\s*hover\s*\)", tok) else "media")
        elif tok == "{":
            stack.append("block")
        elif tok == "}":
            if stack:
                stack.pop()
        elif "hover" not in stack:
            out.append(text.count("\n", 0, m.start()) + 1)
    return out


def robust_static_check() -> list[str]:
    """iPhone の Safari の落とし穴と、同じオリジンの別サイトとのぶつかりを、ファイルを読むだけで調べる (ブラウザ不要)。"""
    fails = []
    # manifest の id は start_url の「オリジン」を基準に解決される ("./" はオリジンの直下 = 同じ github.io の全サイト共通)
    try:
        man = json.loads((REPO / "manifest.webmanifest").read_text(encoding="utf-8"))
        if "id" in man:
            resolved = urllib.parse.urljoin("https://solitarysage-design.github.io/", str(man["id"]))
            if urllib.parse.urlsplit(resolved).path in ("", "/"):
                fails.append(f"manifest の id {man['id']!r} がオリジンの直下 ({resolved}) になります。"
                             "同じ github.io の別サイトのアプリと同じ id になるので、mhwilds-sns を含めてください")
    except Exception as e:
        fails.append(f"manifest.webmanifest が読めません: {e}")
    ui_files = [*sorted((REPO / "app" / "ui").glob("*.css")), *sorted((REPO / "app" / "ui").rglob("*.js"))]
    for f in ui_files:
        text = f.read_text(encoding="utf-8")
        rel = f.relative_to(REPO).as_posix()
        lines = _hover_outside_media(text)
        if lines:
            fails.append(f"{rel}: :hover が @media (hover: hover) の外にあります (iPhone では触った後も残る) 行 {lines[:5]}")
        # 100vh は iPhone のアドレスバーの分だけはみ出す。同じ規則の中に dvh/svh の指定 (上書き) が要る
        for m in re.finditer(r"(?<![\w.])\d+(?:\.\d+)?vh\b", text):
            start = text.rfind("{", 0, m.start())
            end = text.find("}", m.end())
            block = text[start + 1:end if end >= 0 else len(text)]
            if not re.search(r"\d(?:dvh|svh|lvh)\b", block):
                fails.append(f"{rel} 行 {text.count(chr(10), 0, m.start()) + 1}: vh だけで高さを決めています (dvh の指定が無い)")
    html_text = (REPO / "index.html").read_text(encoding="utf-8")
    im = html_text.find('type="importmap"')
    mod = html_text.find('type="module"')
    pre = html_text.find("modulepreload")
    if im < 0:
        fails.append("index.html に import map がありません")
    elif (mod >= 0 and mod < im) or (pre >= 0 and pre < im):
        fails.append("index.html: import map が module の script / modulepreload より後にあります (Safari は無視する)")
    for f in sorted((REPO / "app").rglob("*.js")):
        if "vendor" in f.parts:
            continue
        text = f.read_text(encoding="utf-8")
        for m in re.finditer(r"serviceWorker\.register\(([^)]*)\)", text):
            if re.search(r"type\s*:\s*['\"]module['\"]", m.group(1)):
                fails.append(f"{f.relative_to(REPO).as_posix()}: Service Worker を module として登録しています (古い iOS で動かない)")
    sw = (REPO / "sw.js").read_text(encoding="utf-8")
    if re.search(r"^\s*(import\s|export\s)", sw, re.M):
        fails.append("sw.js に import/export があります (classic の Service Worker として登録しているので動かない)")
    return fails


# ---- 専用の配信: Handler に「このパスだけ別の中身・状態で返す」を足したもの (更新・取りこぼしの確認用)

class RobustHandler(Handler):
    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        overrides = getattr(self.server, "overrides", {})
        if not self.server.offline and path.startswith(BASE_PATH) and path[len(BASE_PATH):] in overrides:
            status, ctype, body = overrides[path[len(BASE_PATH):]]
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


class RobustServer(Server):
    def handle_error(self, request, client_address):
        # 再読み込みで読み込み途中の接続をブラウザが切るのはふつうのこと (traceback を出さない)
        if isinstance(sys.exc_info()[1], (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


def start_robust_server() -> tuple[Server, str]:
    srv = RobustServer(("127.0.0.1", 0), RobustHandler)
    srv.overrides = {}   # {"data/combos_sns.json": (status, content-type, bytes)}
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}{BASE_PATH}"


def _robust_ids() -> dict:
    """テストで使う実在の id (data/ から取る。データが変わっても動くように)。"""
    load = lambda name: json.loads((REPO / "data" / name).read_text(encoding="utf-8"))
    weapons = load("weapons_sns.json")["weapons"]
    head = next(a for a in load("armor.json")["armor"] if a["part"] == "head")
    mon = next(m for m in load("monsters.json")["monsters"] if m.get("parts"))
    return {"weapon": weapons[0]["id"], "weapon2": weapons[1]["id"], "armorHead": head["id"],
            "monster": mon["id"], "part": mon["parts"][0]["key"]}


def _robust_open(browser, ctx_opts: dict, server: Server, base_url: str, name: str, *, sw=False, init_scripts=()):
    opts = dict(ctx_opts)
    if not sw:
        opts["service_workers"] = "block"
    context = browser.new_context(**opts)
    context.add_init_script(ROBUST_UNHANDLED)
    for s in init_scripts:
        context.add_init_script(s)
    page = context.new_page()
    ctx = Ctx(scenario=f"robust-{name}", page=page, base_url=base_url, server=server, sw=sw)
    page.on("console", lambda m: ctx.errors.append(f"console.error: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: ctx.errors.append(f"pageerror: {e}"))

    def on_response(res):
        if res.url.startswith(base_url) and res.status >= 400:
            ctx.errors.append(f"HTTP {res.status}: {res.url}")
    page.on("response", on_response)
    return context, page, ctx


def _robust_tabs(page, ctx: Ctx, where: str, tabs=TABS):
    """全タブを開き、エラーの囲い・読み込み失敗の表示とコンソールのエラーが無いことを見る。"""
    for tab in tabs:
        try:
            open_tab(page, tab)
        except Exception as e:
            ctx.fail(f"{where}: {tab} タブが開けません: {str(e).splitlines()[0]}")
            continue
        broken = page.evaluate(JS_BROKEN, [tab, BROKEN_TITLES])
        if broken:
            ctx.fail(f"{where}: {tab} タブにエラーの表示: {broken[:2]}")
    check_errors(ctx, where)


def _robust_shot(ctx: Ctx, name: str):
    try:
        ctx.shot(name, full_page=False)
    except Exception:
        pass


# ---- 1. 保存できない環境

IDB_BREAKERS = [
    ("idb-missing", "IndexedDB が無い (取り出すと例外)", True,
     """Object.defineProperty(window, 'indexedDB', { configurable: true,
          get() { throw new DOMException('このモードでは使えません', 'SecurityError'); } });"""),
    ("idb-open-throws", "IndexedDB を開くと例外", True,
     """IDBFactory.prototype.open = function () { throw new DOMException('使えません', 'InvalidStateError'); };"""),
    ("idb-open-error", "IndexedDB を開くと失敗 (古い Safari のプライベートブラウズ)", True,
     """IDBFactory.prototype.open = function () { const req = {};
          setTimeout(() => { req.error = new DOMException('使えません', 'UnknownError'); if (req.onerror) req.onerror({ target: req }); }, 20);
          return req; };"""),
    ("idb-open-hangs", "IndexedDB を開くのが止まる", True,
     """IDBFactory.prototype.open = function () { return {}; };"""),
    ("idb-write-fails", "IndexedDB に書くと容量切れ", False,
     """IDBObjectStore.prototype.put = function () { throw new DOMException('容量がいっぱいです', 'QuotaExceededError'); };"""),
]

JS_MEMORY_ONLY = """async (wid) => {
  const S = await import('./app/state.js'); const D = await import('./app/store.js');
  S.setWeapon(wid);
  const st = await S.flushState();
  const p = D.parseBackupText(await D.exportAllText({ appVersion: 'test' }));
  const ent = p.ok ? p.backup.entries['mhwilds-sns:state'] : null;
  return { status: st.status, exported: ent && ent.build ? ent.build.weapon : null, now: S.getState().build.weapon };
}"""


def robust_storage_unavailable(browser, ctx_opts, server, base_url, ids) -> list[Ctx]:
    out = []
    for key, label, unavailable, script in IDB_BREAKERS:
        context, page, ctx = _robust_open(browser, ctx_opts, server, base_url, key, init_scripts=[script])
        out.append(ctx)
        try:
            t0 = time.time()
            page.goto(base_url, wait_until="load")
            wait_app_ready(page, timeout=30000)
            took = time.time() - t0
            if took > 12:
                ctx.fail(f"{label}: 起動に {took:.0f} 秒かかりました")
            _robust_tabs(page, ctx, label)
            r = page.evaluate(JS_MEMORY_ONLY, ids["weapon"])
            if r["now"] != ids["weapon"]:
                ctx.fail(f"{label}: 武器を選んでも状態が変わりません: {r}")
            if r["status"] != "memory":
                ctx.fail(f"{label}: 保存できないのに保存の状態が「{r['status']}」です (memory のはず)")
            if r["exported"] != ids["weapon"]:
                ctx.fail(f"{label}: 書き出しに今の状態 (メモリの分) が入っていません: {r}")
            # 設定タブを開き直して、保存できないことが出ているか
            open_tab(page, "equip")
            open_tab(page, "settings")
            page.wait_for_function(f"() => !document.querySelector('{SETTINGS_PANEL} .loading')", timeout=10000)
            text = page.inner_text(SETTINGS_PANEL)
            if unavailable and "この端末に保存できません" not in text:
                ctx.fail(f"{label}: 設定タブに「この端末に保存できません」が出ません")
            if "メモリだけ" not in text:
                ctx.fail(f"{label}: 設定タブの保存の欄に「メモリだけ」が出ません")
            check_errors(ctx, f"{label} (設定タブ)")
            _robust_shot(ctx, "settings")
        except Exception as e:
            ctx.fail(f"{label}: 流れの途中で止まりました: {str(e).splitlines()[0]}")
            _robust_shot(ctx, "stopped")
        finally:
            context.close()
    return out


# ---- 2. 途中で IndexedDB の接続が切れる (Safari の "Connection to Indexed Database server lost")

IDB_CONNECTION_LOST = """(() => {
  const opened = []; const dead = new WeakSet();
  window.__idbKill = () => { for (const db of opened) dead.add(db); return opened.length; };
  const open = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function (...a) {
    const req = open.apply(this, a);
    req.addEventListener('success', () => opened.push(req.result));
    return req;
  };
  const tx = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...a) {
    if (dead.has(this)) throw new DOMException('Connection to Indexed Database server lost. Refresh the page to try again', 'UnknownError');
    return tx.apply(this, a);
  };
})();"""

JS_SET_AND_FLUSH = """async (wid) => { const S = await import('./app/state.js'); S.setWeapon(wid);
  const st = await S.flushState(); return st.status; }"""


def robust_idb_connection_lost(browser, ctx_opts, server, base_url, ids) -> Ctx:
    context, page, ctx = _robust_open(browser, ctx_opts, server, base_url, "idb-lost", init_scripts=[IDB_CONNECTION_LOST])
    try:
        page.goto(base_url, wait_until="load")
        wait_app_ready(page)
        first = page.evaluate(JS_SET_AND_FLUSH, ids["weapon"])
        if first != "saved":
            ctx.note(f"接続が切れる前の保存が {first} でした (IndexedDB が使えない環境なので飛ばします)")
            return ctx
        killed = page.evaluate("window.__idbKill()")
        second = page.evaluate(JS_SET_AND_FLUSH, ids["weapon2"])
        page.reload(wait_until="load")
        wait_app_ready(page)
        after = page.evaluate("async () => (await import('./app/state.js')).getState().build.weapon")
        if second != "saved" or after != ids["weapon2"]:
            ctx.fail(f"IndexedDB の接続が切れたあと (iPhone で長く裏に回したあとに起きる) 開き直さないので、以後の変更が"
                     f"端末に保存されません: 切れた接続 {killed} 本・切れた後の保存 {second}・開き直した後の武器 {after} "
                     f"(最後に選んだのは {ids['weapon2']})")
        check_errors(ctx, "接続が切れた後")
    except Exception as e:
        ctx.fail(f"接続が切れる流れの途中で止まりました: {str(e).splitlines()[0]}")
    finally:
        context.close()
    return ctx


# ---- 3. 壊れた保存データ

def _corrupt_variants(ids: dict) -> list[tuple[str, object, object]]:
    """(説明, mhwilds-sns:state に入れる値, mhwilds-sns:charms-local に入れる値 (None なら消す))"""
    mid, part = ids["monster"], ids["part"]
    return [
        ("文字列", "壊れたデータ", "壊れた護石"),
        ("型がばらばら", {
            "schema": 99, "tab": "nope",
            "build": {"weapon": {"x": 1}, "armor": [1, 2], "limitBreak": "yes", "charm": 12.5,
                      "decorations": {"weapon": "abc", "head": [999999, -1, "x", None, 5, 6], "legs": {"0": 1}}},
            "target": {"mode": "monster", "monsterId": "zzz", "partKey": 5, "isWound": "yes",
                       "manual": {"name": 5, "hitzone": "x", "wound": 5}},
            "combo": {"id": 1},
            "uptimes": {"chain": "abc", "enraged": 5, "hpFull": {"a": 1}, "frenzy": -3, "x" * 200: 1, "hpLow": None},
            "sharpness": "rainbow",
            "mySets": [None, {"id": 5}, {"id": "s1", "name": 123, "build": "x"}, {"id": "s1", "name": "同じ id"}],
            "tabs": {"equip": {"myWeapons": "zzz", "armorRank": 7, "armorRarity": "x"},
                     "target": {"mix": {"on": "yes", "monsterId": "1", "weights": None}, "sort": 5, "elem": {}, "showUnknown": "x"},
                     "power": 3, "charms": [1, 2]},
        }, {"charms": "zzz"}),
        ("無い id を指す", {
            "schema": 1, "tab": "power",
            "build": {"weapon": "wl-gone", "armor": {"head": 999999, "chest": ids["armorHead"], "arms": None, "waist": None, "legs": 999998},
                      "limitBreak": {"head": True, "chest": True}, "charm": "u0009",
                      "decorations": {"weapon": [999999, None, 999998], "head": [999999], "chest": [999999, 999999, 999999],
                                      "charmArmor": [999999], "charmWeapon": [999999]}},
            "target": {"mode": "monster", "monsterId": 999, "partKey": "zzz", "isWound": True, "questId": "no such quest"},
            "combo": ["no_such_move", "slash_1"],
            "uptimes": {"no_such_group": 0.5, "chain": {"no_state": 0.5, "hit5plus": 0.9, "hit1to4": 0.9}},
            "sharpness": "purple",
            "mySets": [{"id": "s1", "name": "消えた装備", "savedAt": "x", "build": {"weapon": 999999}}],
            "tabs": {"equip": {"myWeapons": [
                        {"id": "wl-gone", "name": "元の武器が無い", "baseWeaponId": 999999},
                        {"id": "wl-bad", "baseWeaponId": "x", "slots": [9, "x"], "element": {"type": "light", "value": "x"},
                         "sharpness": [1e9, -5], "attack": "x"}]},
                     "target": {"mix": {"on": True, "monsterId": 999, "weights": {"zzz": 1}}}},
        }, [{"id": "u0009", "name": "壊れた護石", "rarity": "x", "skills": "x", "armorSlots": [9, 9, 9], "weaponSlots": "x"},
            {"id": "u0010", "rarity": 99, "skills": [{"skillId": 999999, "level": 99}, {"skillId": "x"}]}, None, 5]),
        ("いる相手の無い部位・割合が全部 0", {
            "tab": "target",
            "target": {"mode": "monster", "monsterId": mid, "partKey": "zzz", "isWound": True},
            "tabs": {"target": {"mix": {"on": True, "monsterId": mid, "weights": {part: 0, "zzz": 0}}}},
        }, None),
        ("手入力の肉質が壊れている", {
            "tab": "power",
            "target": {"mode": "manual", "isWound": True, "manual": {"name": "", "hitzone": {"slash": "abc"}, "wound": {}}},
        }, None),
    ]


JS_PUT_RAW = """async ([state, charms]) => {
  const D = await import('./app/store.js');
  await D.kvSet('mhwilds-sns:state', state);
  if (charms === null) await D.kvDelete('mhwilds-sns:charms-local'); else await D.kvSet('mhwilds-sns:charms-local', charms);
}"""


def robust_corrupt_saved_data(browser, ctx_opts, server, base_url, ids) -> Ctx:
    context, page, ctx = _robust_open(browser, ctx_opts, server, base_url, "corrupt")
    try:
        page.goto(base_url, wait_until="load")
        wait_app_ready(page)
        for label, state, charms in _corrupt_variants(ids):
            page.evaluate(JS_PUT_RAW, [state, charms])
            page.reload(wait_until="load")
            try:
                wait_app_ready(page)
            except Exception as e:
                ctx.fail(f"壊れた保存データ ({label}) で起動できません: {str(e).splitlines()[0]}")
                _robust_shot(ctx, "boot")
                continue
            _robust_tabs(page, ctx, f"壊れた保存データ ({label})")
        # 壊れたデータのあとも、保存して開き直せる
        status = page.evaluate(JS_SET_AND_FLUSH, ids["weapon"])
        page.reload(wait_until="load")
        wait_app_ready(page)
        after = page.evaluate("async () => (await import('./app/state.js')).getState().build.weapon")
        if status != "saved" or after != ids["weapon"]:
            ctx.fail(f"壊れた保存データのあと、保存して開き直すと戻りません: 保存 {status}・開き直した武器 {after}")
        check_errors(ctx, "壊れた保存データのあとの保存")
    except Exception as e:
        ctx.fail(f"壊れた保存データの流れの途中で止まりました: {str(e).splitlines()[0]}")
        _robust_shot(ctx, "stopped")
    finally:
        context.close()
    return ctx


# ---- 4. 書き出し → 初期化 → 読み込み (画面のボタンで)

JS_ROBUST_SETUP = """async (ids) => {
  const S = await import('./app/state.js'); const T = await import('./app/ui/tabs/charms.js');
  S.setWeapon(ids.weapon); S.setArmor('head', ids.armorHead); S.setLimitBreak('head', true);
  S.setUptime('enraged', 0.3); S.setUptimeState('chain', 'hit5plus', 0.7); S.setSharpness('blue');
  S.selectMonster(ids.monster, ids.part);
  S.setTabState('equip', { myWeapons: [{ id: 'wl-robust', name: '往復の武器', baseWeaponId: ids.weapon,
                                          element: { type: 'fire', value: 440 } }] });
  S.setTabState('power', { showSteps: true });
  S.saveMySet('往復のセット');
  await T.addLocalCharms([{ name: '往復の護石', rarity: 7, skills: [{ skillId: 3, name: '見切り', level: 3 }],
                            armorSlots: [2, 0, 0], weaponSlots: [0], note: '往復' }]);
  await S.flushState();
}"""

JS_ROBUST_SNAPSHOT = """async () => {
  const S = await import('./app/state.js'); const T = await import('./app/ui/tabs/charms.js'); const D = await import('./app/store.js');
  await T.refreshLocalCharms();
  const st = JSON.parse(JSON.stringify(S.getState()));
  delete st.tab;
  return { state: st, charms: JSON.parse(JSON.stringify(T.getLocalCharms())), keys: await D.kvKeys() };
}"""


def _toast_texts(page) -> list[str]:
    return page.locator(".toast-host .toast").all_inner_texts()


def _wait_toast(page, word: str, timeout=8000):
    page.wait_for_function("(w) => [...document.querySelectorAll('.toast-host .toast')].some((t) => t.innerText.includes(w))",
                           arg=word, timeout=timeout)


def _paste_import(page, text: str):
    """設定タブの「テキストを貼り付けて読み込む」で中身を確かめるところまで。"""
    page.locator(f"{SETTINGS_PANEL} button", has_text="テキストを貼り付けて読み込む").click()
    page.wait_for_selector(".sheet textarea")
    _wait_sheet_ready(page)
    page.fill(".sheet textarea", text)
    page.locator(".sheet .sheet-foot button").click()


def robust_backup_roundtrip(browser, ctx_opts, server, base_url, ids) -> Ctx:
    context, page, ctx = _robust_open(browser, ctx_opts, server, base_url, "backup")
    try:
        page.goto(base_url, wait_until="load")
        wait_app_ready(page)
        page.evaluate(JS_ROBUST_SETUP, ids)
        open_tab(page, "settings")
        before = page.evaluate(JS_ROBUST_SNAPSHOT)
        if not before["charms"] or not before["state"]["mySets"]:
            ctx.fail(f"往復の準備ができていません: {before}")
            return ctx

        # 書き出す (ファイル)。iPhone は共有シート、ここ (共有の無いブラウザ) はダウンロードになる
        text = None
        try:
            with page.expect_download(timeout=15000) as dl:
                page.locator(f"{SETTINGS_PANEL} button", has_text="書き出す (ファイル)").click()
            if not re.fullmatch(r"mhwilds-sns-backup-\d{8}-\d{4}\.txt", dl.value.suggested_filename):
                ctx.fail(f"書き出しのファイル名が違います: {dl.value.suggested_filename}")
            text = Path(dl.value.path()).read_text(encoding="utf-8")
        except Exception as e:
            ctx.note(f"書き出しのダウンロードを受け取れなかったので、書き出しの関数で代わりに作りました ({str(e).splitlines()[0]})")
            text = page.evaluate("async () => (await import('./app/store.js')).exportAllText({ appVersion: 'test' })")
        backup = json.loads(text)
        foreign = [k for k in backup.get("entries", {}) if not k.startswith(APP_PREFIX)]
        if foreign:
            ctx.fail(f"書き出しに mhwilds-sns: で始まらないキーが入っています: {foreign}")
        # 同じオリジンの別サイトのキーが混ざった書き出しを読んでも、それは保存しない
        backup["entries"]["earnings_favorites"] = ["7203"]
        text2 = json.dumps(backup, ensure_ascii=False)

        # 初期化 (2 段階)
        page.locator(f"{SETTINGS_PANEL} button", has_text="すべて初期化する").click()
        page.get_by_role("button", name="消す", exact=True).click()
        _wait_toast(page, "初期化しました")
        if page.get_attribute(".app", "data-active-tab") != "settings":
            ctx.fail("「すべて初期化する」のあと、設定タブから別のタブに移りました (開いているタブは残す決まり)")
            open_tab(page, "settings")
        empty = page.evaluate(JS_ROBUST_SNAPSHOT)
        if empty["charms"] or empty["state"]["mySets"] or empty["state"]["build"]["weapon"] is not None:
            ctx.fail(f"初期化しても状態か端末の護石が残っています: {empty}")

        # 壊れたテキスト・新しい版の書き出しは断る (今のデータはそのまま)
        _paste_import(page, "これは書き出したテキストではありません")
        page.wait_for_selector(".toast-host .toast-error", timeout=8000)
        newer = json.dumps({**backup, "format": 99}, ensure_ascii=False)
        page.fill(".sheet textarea", newer)
        page.locator(".sheet .sheet-foot button").click()
        _wait_toast(page, "新しい版")
        _close_sheets(page)

        # 読み込む
        _paste_import(page, text2)
        page.wait_for_selector(".sheet textarea", state="detached", timeout=8000)
        page.get_by_role("button", name="読み込む", exact=True).click()
        _wait_toast(page, "読み込みました")
        page.wait_for_timeout(300)
        after = page.evaluate(JS_ROBUST_SNAPSHOT)
        if after["state"] != before["state"]:
            diff = [k for k in before["state"] if before["state"].get(k) != after["state"].get(k)]
            ctx.fail(f"書き出し → 初期化 → 読み込みで状態が元に戻りません (違う項目: {diff})")
        if after["charms"] != before["charms"]:
            ctx.fail(f"書き出し → 初期化 → 読み込みで端末の護石が元に戻りません: {after['charms']}")
        if [k for k in after["keys"] if not k.startswith(APP_PREFIX)]:
            ctx.fail(f"読み込みで mhwilds-sns: で始まらないキーを保存しました: {after['keys']}")
        # 開き直さなくても護石タブ・装備タブに出る
        open_tab(page, "charms")
        try:
            page.wait_for_selector(f'{CHARMS_PANEL} [data-charm-id="{before["charms"][0]["id"]}"]', timeout=5000)
        except Exception:
            ctx.fail("読み込んだ端末の護石が、開き直さないと護石タブに出ません")
        _robust_tabs(page, ctx, "読み込んだ後")
        page.reload(wait_until="load")
        wait_app_ready(page)
        again = page.evaluate(JS_ROBUST_SNAPSHOT)
        if again["state"] != before["state"] or again["charms"] != before["charms"]:
            ctx.fail("読み込んだデータが、開き直すと元に戻りません (端末に保存されていない)")
        check_errors(ctx, "書き出しと読み込みの往復")
    except Exception as e:
        ctx.fail(f"書き出しと読み込みの往復の途中で止まりました: {str(e).splitlines()[0]}")
        _robust_shot(ctx, "stopped")
    finally:
        context.close()
    return ctx


# ---- 5. Service Worker (更新・同じオリジンの別サイト・リンク先・取りこぼし)

JS_NEIGHBOR_SEED = """async () => {
  localStorage.setItem('earnings_favorites', JSON.stringify(['7203', '6758']));
  await new Promise((res, rej) => {
    const r = indexedDB.open('earnings-monitor', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => { const db = r.result; const t = db.transaction('kv', 'readwrite');
      t.objectStore('kv').put('となりのサイト', 'favorites');
      t.oncomplete = () => { db.close(); res(); }; t.onerror = () => rej(t.error); };
    r.onerror = () => rej(r.error);
  });
  const c = await caches.open('earnings-monitor-v1');
  await c.put(new URL('../earnings-monitor/data.json', location.href).href, new Response('となりのキャッシュ'));
  return true;
}"""

JS_NEIGHBOR_CHECK = """async () => {
  const out = { ls: localStorage.getItem('earnings_favorites'), lsKeys: Object.keys(localStorage) };
  out.idb = await new Promise((res) => {
    const r = indexedDB.open('earnings-monitor');
    r.onsuccess = () => { const db = r.result;
      if (!db.objectStoreNames.contains('kv')) { db.close(); res(null); return; }
      const g = db.transaction('kv').objectStore('kv').get('favorites');
      g.onsuccess = () => { db.close(); res(g.result === undefined ? null : g.result); };
      g.onerror = () => { db.close(); res(null); }; };
    r.onerror = () => res(null);
  });
  const names = await caches.keys();
  out.cacheNames = names;
  if (names.includes('earnings-monitor-v1')) {
    const hit = await (await caches.open('earnings-monitor-v1')).match(new URL('../earnings-monitor/data.json', location.href).href);
    out.cache = hit ? await hit.text() : null;
  } else {
    out.cache = null;
  }
  out.dbNames = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : null;
  return out;
}"""

JS_SW_UPDATE_NOW = """async () => {
  const r = await navigator.serviceWorker.getRegistration();
  if (!r) return { reg: false };
  try { await r.update(); } catch (e) { /* 取れなかった */ }
  const t0 = Date.now();
  while (r.installing && Date.now() - t0 < 20000) await new Promise((ok) => setTimeout(ok, 200));
  return { reg: true, waiting: !!r.waiting, active: r.active ? r.active.state : null };
}"""


def _neighbors_ok(ctx: Ctx, n: dict, where: str):
    if n["ls"] != '["7203","6758"]':
        ctx.fail(f"{where}: 同じオリジンの別サイトの localStorage (earnings_favorites) が変わりました: {n['ls']!r}")
    if n["idb"] != "となりのサイト":
        ctx.fail(f"{where}: 同じオリジンの別サイトの IndexedDB が消えました/変わりました: {n['idb']!r}")
    if n["cache"] != "となりのキャッシュ":
        ctx.fail(f"{where}: 同じオリジンの別サイトのキャッシュが消えました: {n['cacheNames']}")
    mine_ls = [k for k in n["lsKeys"] if k != "earnings_favorites"]
    if mine_ls:
        ctx.fail(f"{where}: このアプリが localStorage に書いています (接頭辞の決まりの外): {mine_ls}")
    other_caches = [c for c in n["cacheNames"] if c != "earnings-monitor-v1" and not c.startswith(APP_PREFIX)]
    if other_caches:
        ctx.fail(f"{where}: mhwilds-sns: で始まらないキャッシュがあります: {other_caches}")
    if n["dbNames"] is not None:
        other_dbs = [d for d in n["dbNames"] if d != "earnings-monitor" and not str(d).startswith(APP_PREFIX)]
        if other_dbs:
            ctx.fail(f"{where}: mhwilds-sns: で始まらない IndexedDB があります: {other_dbs}")


def _app_caches(n: dict) -> list[str]:
    return sorted(c for c in n["cacheNames"] if c.startswith(APP_PREFIX + "app-"))


def _click_update_banner(page, ctx: Ctx, where: str) -> bool:
    try:
        page.wait_for_selector(".update-banner", timeout=20000)
    except Exception:
        ctx.fail(f"{where}: 新しい版の帯が出ません")
        return False
    with page.expect_navigation(timeout=20000):
        page.click(".update-banner button")
    wait_app_ready(page)
    return True


def robust_service_worker(browser, ctx_opts, server, base_url, ids) -> Ctx:
    context, page, ctx = _robust_open(browser, ctx_opts, server, base_url, "sw", sw=True)
    try:
        page.goto(base_url, wait_until="load")
        wait_app_ready(page)
        if not page.evaluate("'serviceWorker' in navigator"):
            ctx.note("Service Worker が使えないブラウザなので、更新とリンク先の確認は飛ばしました")
            return ctx
        page.evaluate(JS_NEIGHBOR_SEED)
        page.evaluate("navigator.serviceWorker.ready.then(() => true)")
        page.reload(wait_until="load")
        wait_app_ready(page)
        page.wait_for_function("!!navigator.serviceWorker.controller", timeout=10000)
        n0 = page.evaluate(JS_NEIGHBOR_CHECK)
        first = _app_caches(n0)
        if len(first) != 1:
            ctx.fail(f"このアプリのキャッシュが 1 つではありません: {first}")
        _neighbors_ok(ctx, n0, "初めて開いた後")

        # 設定タブのリンク先 (ライセンス・CC BY-SA のデータ) を開くと、そのファイルが出る
        for rel, want in [("app/vendor/LICENSE-preact.txt", "Permission is hereby granted"),
                          ("app/vendor/LICENSE-htm.txt", "Apache License"),
                          ("data/monster_threats.json", '"meta"')]:
            page.goto(base_url + rel, wait_until="load")
            body = page.evaluate("document.body ? document.body.innerText.slice(0, 4000) : ''")
            if want not in body:
                ctx.fail(f"設定タブのリンク先 {rel} を開くと、ファイルではなくアプリの画面 (index.html) が返ります "
                         f"(sw.js が画面を開く要求に全部 index.html を返すため): {body[:60]!r}")
                _robust_shot(ctx, "link-" + rel.split("/")[-1].split(".")[0])
        page.goto(base_url, wait_until="load")
        wait_app_ready(page)
        ctx.take_errors()

        # 書き出しと初期化が別サイトのものを含めない・消さない
        keys = page.evaluate("""async () => { const D = await import('./app/store.js');
          return Object.keys(JSON.parse(await D.exportAllText()).entries); }""")
        if [k for k in keys if not k.startswith(APP_PREFIX)]:
            ctx.fail(f"書き出しに別サイトのキーが入っています: {keys}")
        page.evaluate("""async () => { const S = await import('./app/state.js'); const D = await import('./app/store.js');
          await D.kvClear(); await S.resetState(); }""")
        _neighbors_ok(ctx, page.evaluate(JS_NEIGHBOR_CHECK), "初期化の後")

        # data を変えて公開: 版を上げないと届かない (設計どおり)・上げると届いて古いキャッシュが消える
        marker = f"robust-{int(time.time())}"
        combos = json.loads((REPO / "data" / "combos_sns.json").read_text(encoding="utf-8"))
        combos["meta"]["generatedAt"] = "2099-01-02T03:04:05Z"
        combos["meta"]["robustMarker"] = marker
        server.overrides["data/combos_sns.json"] = (200, MIME[".json"], json.dumps(combos, ensure_ascii=False).encode("utf-8"))
        page.reload(wait_until="load")
        wait_app_ready(page)
        got = page.evaluate("async () => (await import('./app/data.js')).getCoreData().combos.meta.robustMarker || null")
        if got == marker:
            ctx.note("sw.js の版を上げなくても data の更新が届きました (キャッシュ優先のはず)")
        new_version = f"robust-{int(time.time())}"
        server.sw_version_override = new_version
        page.evaluate(JS_SW_UPDATE_NOW)
        if _click_update_banner(page, ctx, "data を変えて版を上げた"):
            got = page.evaluate("async () => (await import('./app/data.js')).getCoreData().combos.meta.robustMarker || null")
            if got != marker:
                ctx.fail("sw.js の版を上げて再読み込みしても、data/combos_sns.json の更新が反映されません")
            open_tab(page, "settings")
            try:
                page.wait_for_function(
                    "(v) => document.querySelector('[data-tab-panel=\"settings\"]').innerText.includes(v)",
                    arg=new_version, timeout=10000)
            except Exception:
                ctx.fail(f"更新後、設定タブにアプリの版 {new_version} が出ません")
            if "2099" not in page.inner_text(SETTINGS_PANEL):
                ctx.fail("更新後、設定タブのデータの版 (作成日時) が新しいものになりません")
            n1 = page.evaluate(JS_NEIGHBOR_CHECK)
            now = _app_caches(n1)
            if len(now) != 1 or now == first:
                ctx.fail(f"更新後、古い版のキャッシュが消えていません (前 {first} → 今 {now})")
            _neighbors_ok(ctx, n1, "更新の後")
        check_errors(ctx, "data の更新")

        # 更新の途中で 1 ファイル取れなかった (電波が途切れた・配信の途中) → 電波なしでも全タブが開けること
        server.overrides["app/ui/tabs/target.js"] = (500, "text/plain; charset=utf-8", b"temporary error")
        server.sw_version_override = new_version + "-b"
        st = page.evaluate(JS_SW_UPDATE_NOW)
        if st.get("waiting"):
            _click_update_banner(page, ctx, "1 ファイル取れなかった更新")
        server.overrides.pop("app/ui/tabs/target.js", None)
        ctx.take_errors()
        server.offline = True
        try:
            page.reload(wait_until="load")
            wait_app_ready(page)
            for tab in ["target", "equip", "settings"]:
                try:
                    open_tab(page, tab)
                except Exception as e:
                    ctx.fail(f"更新の途中で 1 ファイル取れなかった後、電波なしで {tab} タブが開けません: {str(e).splitlines()[0]}")
                    continue
                broken = page.evaluate(JS_BROKEN, [tab, BROKEN_TITLES])
                if broken:
                    ctx.fail(f"更新の途中で 1 ファイル (app/ui/tabs/target.js) 取れなかった後、電波なしで {tab} タブが壊れます "
                             f"(sw.js が取りこぼしたまま新しい版に切り替え、古い版のキャッシュを消すため): {broken[:1]}")
                    _robust_shot(ctx, f"partial-offline-{tab}")
        finally:
            server.offline = False
            ctx.take_errors()
    except Exception as e:
        ctx.fail(f"Service Worker の流れの途中で止まりました: {str(e).splitlines()[0]}")
        _robust_shot(ctx, "stopped")
    finally:
        server.overrides.clear()
        server.sw_version_override = None
        server.offline = False
        context.close()
    return ctx


def run_robust(browser, device: dict, bname: str) -> tuple[list[str], list[str]]:
    """壊れにくさの流れを全部動かす。(失敗, メモ)"""
    server, base_url = start_robust_server()
    ids = _robust_ids()
    opts = {**device, "color_scheme": "light"}
    failures, notes = [], []
    try:
        for fn in (robust_storage_unavailable, robust_idb_connection_lost, robust_corrupt_saved_data,
                   robust_backup_roundtrip, robust_service_worker):
            print(f"--- {bname} {fn.__name__}", flush=True)
            res = fn(browser, opts, server, base_url, ids)
            for c in (res if isinstance(res, list) else [res]):
                failures += c.failures
                notes += c.notes
    finally:
        server.shutdown()
    if server.outside:
        failures.append(f"[robust] /mhwilds-sns/ の外へのリクエスト: {sorted(set(server.outside))[:10]}")
    return failures, notes


# ---------------------------------------------------------------- 入口

def launch(pw, want: str):
    """want のブラウザを起動。webkit が無ければ入れてみて、だめなら chromium で代用する。"""
    if want == "webkit":
        try:
            return pw.webkit.launch(), "webkit", None
        except Exception as e:
            print("webkit を起動できません。python -m playwright install webkit を試します…", flush=True)
            subprocess.run([sys.executable, "-m", "playwright", "install", "webkit"])
            try:
                return pw.webkit.launch(), "webkit", None
            except Exception as e2:
                note = f"webkit が使えないため chromium の iPhone 13 で代用しました ({str(e2).splitlines()[0]})"
                return pw.chromium.launch(), "chromium", note
    return pw.chromium.launch(), "chromium", None


def main() -> int:
    try:  # Windows の端末でも日本語を出せるように
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="iPhone 幅の画面のスモークテスト")
    ap.add_argument("--browser", choices=["webkit", "chromium"], default="webkit")
    ap.add_argument("--headed", action="store_true", help="画面を出す")
    ap.add_argument("--only", default="", help="確かめるタブ (カンマ区切り)")
    ap.add_argument("--no-sw", action="store_true", help="オフラインと更新の確認を飛ばす")
    ap.add_argument("--robust-only", action="store_true", help="壊れにくさの確認 (run_robust) だけを動かす")
    args = ap.parse_args()

    tabs = [t for t in TABS if not args.only or t in args.only.split(",")]
    failures, notes = [], []

    f, w = precache_check()
    failures += f
    notes += w
    failures += syntax_check()
    failures += manifest_check()
    failures += robust_static_check()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Playwright がありません: pip install playwright && python -m playwright install webkit")
        return 2

    if ART.exists():
        for old in ART.glob("robust-*.png" if args.robust_only else "*.png"):
            old.unlink()
    server, base_url = start_server()
    print(f"配信: {base_url}", flush=True)
    try:
        with sync_playwright() as pw:
            browser, bname, note = launch(pw, args.browser)
            if args.headed:
                browser.close()
                browser = getattr(pw, bname).launch(headless=False)
            if note:
                notes.append(note)
            device = dict(pw.devices["iPhone 13"])
            device.pop("default_browser_type", None)
            scenarios = [
                ("iphone13-light", {**device, "color_scheme": "light"}, not args.no_sw),
                ("w375-dark", {**device, "viewport": {"width": 375, "height": 667}, "color_scheme": "dark"}, False),
            ]
            for name, opts, sw in (scenarios if not args.robust_only else []):
                print(f"--- {bname} {name}", flush=True)
                ctx = run_scenario(pw, browser, name, opts, server, base_url, tabs, sw)
                failures += ctx.failures
                notes += ctx.notes
            if not args.only and not args.robust_only:
                print(f"--- {bname} data-failure", flush=True)
                ctx = data_failure_scenario(browser, {**device, "color_scheme": "light"}, server, base_url)
                failures += ctx.failures
            if not args.only:
                f, n = run_robust(browser, device, bname)
                failures += f
                notes += n
            run_search(browser, device, bname, server, base_url, args, failures, notes)  # 探すタブ (作り物の Worker と本物の Worker)
            browser.close()
    finally:
        server.shutdown()

    if server.outside:
        failures.append(f"/mhwilds-sns/ の外へのリクエスト (先頭 / の絶対パスの疑い): {sorted(set(server.outside))[:10]}")

    print()
    for n in notes:
        print(f"メモ: {n}")
    if failures:
        print(f"失敗 {len(failures)} 件:")
        for x in failures:
            print(f"  - {x}")
        print(f"スクリーンショット: {ART}")
        return 1
    print(f"OK ({bname}): {len(tabs)} タブ × 2 画面。スクリーンショット: {ART}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
