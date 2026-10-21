// Service Worker (sw.js) の登録と「更新があります」の検知。
// - main.js が起動時に registerServiceWorker() を呼ぶ。
// - 新しい版の sw.js が入って待機中になると、useUpdateReady() が true になる (shell.js が帯を出す)。
// - applyUpdate() で新しい版に切り替えて再読み込みする。
// - getAppVersion() で今動いている版 (sw.js の VERSION) を聞ける (設定タブで表示)。
import { useEffect, useState } from 'preact/hooks';
import { flushState } from '../../state.js';

let registration = null;
let knownVersion = null;   // 一度聞けた版 (書き出しのたびに Service Worker に聞かないように)
let waitingWorker = null;
let userAskedReload = false;
const listeners = new Set();

function setWaiting(worker) {
  waitingWorker = worker;
  for (const fn of [...listeners]) fn(!!worker);
}

// 本当に「前の版が動いていて、新しい版が待っている」ときだけ true。
// 初回のインストールは何も出さない (Safari は installed の知らせが有効化の後に届くことがあり、
// そのとき controller だけを見ると初回でも帯が出てしまう)
function isRealUpdate(worker) {
  return !!(registration && worker && registration.waiting === worker && registration.active
    && registration.active !== worker && navigator.serviceWorker.controller);
}

function refreshWaiting() {
  const w = registration && registration.waiting;
  setWaiting(isRealUpdate(w) ? w : null);
}

function watchInstalling(worker) {
  if (!worker) return;
  worker.addEventListener('statechange', () => {
    if (worker.state === 'installed' || worker.state === 'activated' || worker.state === 'redundant') refreshWaiting();
  });
}

/** sw.js を登録する。対応していない・失敗したときは null (アプリはそのまま動く)。 */
export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    // 相対 URL: GitHub Pages では /mhwilds-sns/sw.js、範囲は /mhwilds-sns/ の下だけ
    registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
  } catch (e) {
    console.warn('オフライン用の仕組み (Service Worker) を登録できませんでした', e);
    return null;
  }
  refreshWaiting();
  watchInstalling(registration.installing);
  registration.addEventListener('updatefound', () => watchInstalling(registration.installing));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // 自分で「再読み込み」を押したときだけ読み直す (初回インストールで勝手に読み直さない)
    if (userAskedReload) window.location.reload();
    else refreshWaiting();
  });
  // ホーム画面のアプリは開きっぱなしになりがちなので、前面に戻るたびに新しい版を確かめる
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });
  return registration;
}

/** 新しい版があるか今すぐ確かめる。確かめられたら true。 */
export async function checkForUpdate() {
  if (!registration) return false;
  try {
    await registration.update();
    return true;
  } catch {
    return false; // 電波が無いなど
  }
}

/** 待機中の新しい版に切り替えて再読み込みする。先に保存待ちの変更を保存する (再読み込みで消えないように)。 */
export async function applyUpdate() {
  userAskedReload = true;
  try {
    await flushState();
  } catch { /* 保存できなくても切り替える */ }
  const w = waitingWorker || (registration && registration.waiting);
  if (w) {
    w.postMessage({ type: 'SKIP_WAITING' });
    // controllerchange が来ないとき (古い Safari など) の保険
    setTimeout(() => window.location.reload(), 3000);
  } else {
    window.location.reload();
  }
}

/** 更新が待っているか (hook)。 */
export function useUpdateReady() {
  const [ready, setReady] = useState(!!waitingWorker);
  useEffect(() => {
    listeners.add(setReady);
    setReady(!!waitingWorker);
    return () => listeners.delete(setReady);
  }, []);
  return ready;
}

/**
 * 今このページを動かしている sw.js の版。Service Worker が無い・答えないときは null。
 * @returns {Promise<string|null>}
 */
export function getAppVersion({ cached = false } = {}) {
  if (cached && knownVersion) return Promise.resolve(knownVersion);
  const ctrl = 'serviceWorker' in navigator ? navigator.serviceWorker.controller : null;
  if (!ctrl || typeof MessageChannel !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 1500);
    ch.port1.onmessage = (e) => {
      clearTimeout(timer);
      const v = e.data && e.data.version ? String(e.data.version) : null;
      if (v) knownVersion = v;
      resolve(v);
    };
    try {
      ctrl.postMessage({ type: 'GET_VERSION' }, [ch.port2]);
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/** Service Worker がこのページを受け持っているか (オフラインで開けるか)。 */
export function isOfflineReady() {
  return 'serviceWorker' in navigator && !!navigator.serviceWorker.controller;
}
