// 入口。index.html の <script type="module"> から読まれる。
// 1. データ (core) の読み込みを先に始める
// 2. 保存してある状態を戻す (IndexedDB。失敗しても初期値で動く)
// 3. 画面を描く
// 4. 保存領域を消さないよう頼む (初回だけ) ・オフライン用の Service Worker を登録する
import { render } from 'preact';
import { html } from './ui/components/html.js';
import { Shell } from './ui/shell.js';
import { initState } from './state.js';
import { loadCoreData } from './data.js';
import { requestPersist } from './store.js';
import { registerServiceWorker } from './ui/components/app-update.js';

async function boot() {
  const root = document.getElementById('app');
  loadCoreData().catch(() => { /* 画面側 (useData) で失敗を出す */ });
  await initState();
  root.textContent = '';
  render(html`<${Shell} />`, root);
  document.documentElement.dataset.booted = '1';
  requestPersist().catch(() => {});
  registerServiceWorker().catch(() => {});
}

boot().catch((e) => {
  console.error('起動に失敗しました', e);
  const root = document.getElementById('app');
  if (root) {
    root.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'boot';
    box.textContent = `起動できませんでした (${e && e.message ? e.message : e})。再読み込みしてください。`;
    root.appendChild(box);
  }
});
