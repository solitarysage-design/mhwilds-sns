// 画面の骨組み: 上の見出し・各タブの中身・下のタブバー・更新の帯・お知らせ。
// タブの中身は app/ui/tabs/<タブ名>.js を初めて開いたときに読み込む (1 つのタブが壊れても他は動く)。
// タブの書き方は docs/UI_API.md の「タブの書き方」。
import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { html, ErrorBoundary, Loading, ErrorBox, ToastHost, Button, toast, TAB_LABEL } from './components/index.js';
import { useUpdateReady, applyUpdate } from './components/app-update.js';
import { TABS, setTab, getState, useAppState, flushState, subscribeSaveStatus } from '../state.js';
import { useData, loadTargetData } from '../data.js';
import { kvGet, kvSet } from '../store.js';

/**
 * タブの定義。load は tabs/*.js を読む関数 (相対パス)。
 * needsData=true のタブは core データ (data.js) を読み終わるまで「読み込み中」を出す。
 * onOpen は開いたときに 1 回呼ぶ (相手タブはここでモンスター・クエストの読み込みを始める)。
 */
const TAB_DEFS = {
  equip: { load: () => import('./tabs/equip.js'), needsData: true },
  power: { load: () => import('./tabs/power.js'), needsData: true },
  target: { load: () => import('./tabs/target.js'), needsData: true, onOpen: () => loadTargetData().catch(() => {}) },
  charms: { load: () => import('./tabs/charms.js'), needsData: true },
  settings: { load: () => import('./tabs/settings.js'), needsData: false },
};

// ---------------------------------------------------------------- タブの切り替え (スクロール位置)

/** タブごとのスクロール位置 (タブを切り替えたら、そのタブの前の位置に戻す) */
const scrollPos = {};
/** 次に開いたとき先頭から出すタブ (goToTab の top) */
const openAtTop = new Set();

/**
 * 別のタブへ移る (タブの中のボタン用)。今のタブのスクロール位置は覚えておく。
 * top=true なら移った先を先頭から出す (「相手を変える」で相手タブのモンスターの行を見せるなど)。
 */
export function goToTab(tab, { top = false } = {}) {
  const cur = getState().tab;
  if (tab === cur) {
    if (top) window.scrollTo(0, 0);
    return;
  }
  scrollPos[cur] = window.scrollY;
  if (top) openAtTop.add(tab);
  setTab(tab);
}

/** 再読み込みの前に、保存待ちの変更 (0.3 秒遅らせて保存する分) を先に保存する */
export async function reloadPage() {
  try {
    await flushState();
  } catch { /* 保存できなくても読み直す */ }
  window.location.reload();
}

// ---------------------------------------------------------------- タブバーの絵 (自作の単純な線画。ゲームの画像は使わない)

const ICON_PATHS = {
  // 装備: 胴着の形
  equip: () => html`<path d="M8 3 4 6v5l3 1v9h10v-9l3-1V6l-4-3-2 2h-4z" />`,
  // 火力: 稲妻
  power: () => html`<path d="M13 2 4 14h7l-1 8 9-12h-7z" />`,
  // 相手: 照準
  target: () => html`<circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 1v4M12 19v4M1 12h4M19 12h4" />`,
  // 護石: 宝石
  charms: () => html`<path d="M6 3h12l4 6-10 12L2 9z" /><path d="M2 9h20M9 3l3 18M15 3l-3 18" />`,
  // 設定: つまみ
  settings: () => html`<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" />`,
};

function TabIcon({ tab }) {
  return html`
    <svg class="tab-icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"
      fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      ${ICON_PATHS[tab]()}
    </svg>`;
}

// ---------------------------------------------------------------- タブの中身を読み込んで描く

const moduleCache = new Map();

function loadTabModule(tab) {
  if (!moduleCache.has(tab)) {
    const p = TAB_DEFS[tab].load().catch((e) => {
      moduleCache.delete(tab);
      throw e;
    });
    moduleCache.set(tab, p);
  }
  return moduleCache.get(tab);
}

/** データが読めなかったときの表示。電波のせいか、ファイルが無い・壊れている (更新の失敗など) かで案内を変える */
function DataErrorBox({ error, onRetry }) {
  const network = !!(error && error.name === 'DataLoadError' && error.isNetwork);
  if (network) {
    return html`
      <${ErrorBox} title="データを読み込めませんでした" error=${error} onRetry=${onRetry}
        detail=${error && error.detail}>
        <p class="hint">電波の良い所でもう一度試してください。</p>
      </${ErrorBox}>`;
  }
  return html`
    <${ErrorBox} title="データを読み込めませんでした" error=${error} onRetry=${reloadPage} retryLabel="再読み込み"
      detail=${error && error.detail}>
      <p class="hint">アプリの更新がうまくいっていないかもしれません。再読み込みしてください。直らなければ、設定タブの「新しい版を確かめる」を押してください。</p>
    </${ErrorBox}>`;
}

function TabHost({ tab, active, core }) {
  const [mod, setMod] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    loadTabModule(tab).then((m) => alive && setMod(m)).catch((e) => {
      console.error(`タブ ${tab} を読み込めませんでした`, e);
      if (alive) setError(e);
    });
    return () => {
      alive = false;
    };
  }, [tab]);

  const def = TAB_DEFS[tab];
  if (error) {
    return html`<${ErrorBox} title="この画面を読み込めませんでした" error=${error} onRetry=${reloadPage}
      retryLabel="再読み込み" />`;
  }
  if (def.needsData && core.status === 'error') return html`<${DataErrorBox} error=${core.error} onRetry=${core.retry} />`;
  if (!mod || (def.needsData && core.status !== 'ready')) return html`<${Loading} text="読み込み中…" />`;
  const View = mod.default;
  if (typeof View !== 'function') {
    return html`<${ErrorBox} title="この画面の作りが正しくありません" error=${new Error(`tabs/${tab}.js に export default が無い`)} />`;
  }
  return html`
    <div class="tab-content" data-tab-ready="1">
      <${ErrorBoundary} title=${`${TAB_LABEL[tab]}タブでエラーが起きました`}>
        <${View} data=${core.data} active=${active} />
      </${ErrorBoundary}>
    </div>`;
}

// ---------------------------------------------------------------- 更新の帯

function UpdateBanner() {
  return html`
    <div class="update-banner" role="status">
      <span class="update-text">新しい版があります</span>
      <button type="button" class="btn btn-primary btn-small" onClick=${applyUpdate}>再読み込み</button>
    </div>`;
}

// ---------------------------------------------------------------- ホーム画面に追加の案内

const HOME_HINT_KEY = 'mhwilds-sns:hint-home-screen';

/** ホーム画面から開いているか (ホーム画面のアプリなら true) */
export function isStandalone() {
  try {
    if (navigator.standalone === true) return true;
    return !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  } catch {
    return false;
  }
}

/** iPhone / iPad の Safari か (しばらく使わないと保存が消されることがある) */
function isIosBrowser() {
  try {
    const ua = navigator.userAgent || '';
    return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  } catch {
    return false;
  }
}

/** Safari のまま使っているときの案内 (しばらく使わないと保存が消されることがある)。閉じたら次から出さない */
function HomeScreenHint() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (isStandalone() || !isIosBrowser()) return;
    let alive = true;
    kvGet(HOME_HINT_KEY).then((v) => { if (alive && !v) setShow(true); }).catch(() => { if (alive) setShow(true); });
    return () => { alive = false; };
  }, []);
  if (!show) return null;
  const close = () => {
    setShow(false);
    kvSet(HOME_HINT_KEY, { closedAt: new Date().toISOString() }).catch(() => {});
  };
  return html`
    <div class="app-hint" role="note" data-hint="home-screen">
      <span class="app-hint-text">共有ボタンから「ホーム画面に追加」して使うと、保存したデータが消えにくくなります (Safari のままだと、しばらく使わないと消されることがあります)。</span>
      <${Button} small variant="ghost" onClick=${close}>閉じる</${Button}>
    </div>`;
}

// ---------------------------------------------------------------- 本体

export function Shell() {
  const tab = useAppState((s) => s.tab);
  const core = useData();
  const updateReady = useUpdateReady();
  const [visited, setVisited] = useState(() => new Set([tab]));

  // タブを切り替えたらそのタブの前のスクロール位置に戻す (goToTab の top なら先頭)
  useLayoutEffect(() => {
    if (openAtTop.has(tab)) {
      openAtTop.delete(tab);
      window.scrollTo(0, 0);
    } else {
      window.scrollTo(0, scrollPos[tab] || 0);
    }
    if (!visited.has(tab)) setVisited(new Set([...visited, tab]));
    const def = TAB_DEFS[tab];
    if (def && def.onOpen) def.onOpen();
  }, [tab]);

  // 端末に保存できなくなったら (初めてのときだけ) 知らせる。閉じると消えるので、書き出しで控えを取ってもらう
  useEffect(() => subscribeSaveStatus((next, prev) => {
    if (next.status === 'memory' && prev.status !== 'memory') {
      toast('この端末に保存できていません。閉じると消えます。設定タブの「書き出す」で控えを取ってください', {
        kind: 'error', ms: 10000, action: { label: '設定を見る', onClick: () => goToTab('settings', { top: true }) },
      });
    }
  }), []);

  const choose = (t) => {
    if (t === tab) {
      // 開いているタブをもう一度押したら上に戻る
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    goToTab(t);
  };

  return html`
    <div class=${`app${updateReady ? ' has-banner' : ''}`} data-app-ready=${core.status === 'ready' ? '1' : '0'}
      data-active-tab=${tab}>
      <header class="app-header">
        <div class="app-header-inner">
          <h1 class="app-title">${TAB_LABEL[tab]}</h1>
          <span class="app-name">片手剣ビルド</span>
        </div>
      </header>
      <main class="app-main" id="main">
        <${HomeScreenHint} />
        ${TABS.filter((t) => visited.has(t) || t === tab).map((t) => html`
          <section key=${t} class="tab-panel" id=${`panel-${t}`} data-tab-panel=${t} role="tabpanel"
            aria-labelledby=${`tab-${t}`} hidden=${t !== tab}>
            <${TabHost} tab=${t} active=${t === tab} core=${core} />
          </section>`)}
      </main>
      ${updateReady && html`<${UpdateBanner} />`}
      <nav class="tabbar" role="tablist" aria-label="画面の切り替え">
        ${TABS.map((t) => html`
          <button type="button" role="tab" id=${`tab-${t}`} class=${`tab-button${t === tab ? ' is-active' : ''}`}
            aria-selected=${t === tab ? 'true' : 'false'} aria-controls=${`panel-${t}`} data-tab=${t}
            onClick=${() => choose(t)}>
            <${TabIcon} tab=${t} />
            <span class="tab-label">${TAB_LABEL[t]}</span>
          </button>`)}
      </nav>
      <${ToastHost} />
    </div>`;
}
