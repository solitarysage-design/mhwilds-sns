// 装備探索の Web Worker (モジュール Worker)。メッセージは docs/SEARCH_DESIGN.md 3.5 節と docs/RECOMMEND_DESIGN.md 5.5 節。
// 担当: solver (2a)。作り方: new Worker(new URL('./search_worker.js', import.meta.url), { type: 'module' })。
// Worker には import map が効かないので、import は相対パスだけ ('./model/search.js' など)。
// app/data.js は preact を読むので使わない (data/*.json は Worker が自分で fetch する)。
// いまは置き場だけ: start には「準備中」のエラーを返す。
self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'start') {
    self.postMessage({ type: 'error', id: msg.id ?? null, message: '装備を探す機能は準備中です' });
  }
});
