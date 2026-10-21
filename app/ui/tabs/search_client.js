// 探索の Worker の出し入れ (作る・start・cancel・extend・作り直し・Worker が無いときの代わり) と hook useSearchRun。
// 担当: ui-search (3e)。Worker は app/search_worker.js (メッセージは docs/SEARCH_DESIGN.md 3.5 節と docs/RECOMMEND_DESIGN.md 5.5 節)。
// 作り方の例: new Worker(new URL('../../search_worker.js', import.meta.url), { type: 'module' })
// 結果の保存は store.js の saveSearchLast / loadSearchLast、時間の記録は appendSearchTiming / loadSearchTiming。
// いまは置き場だけ。
export {};
