// 装備探索の入口 (段階 2): createSearch と定数。API は docs/SEARCH_DESIGN.md 3 章。担当: solver (2a)。
// DOM も Worker も知らない純粋な JS (node --test で動く)。import は相対パスだけ (Worker から読むため)。
// 中身は app/model/search/ (evaluator.js・problem.js・solver.js・realize.js) に分ける。いまは置き場だけ。

/** 探索の段階 (progress().phase) */
export const PHASES = Object.freeze(['prepare', 'beam1', 'beam2', 'polish1', 'dfs', 'polish2', 'done']);

/** 探索を作る (準備中。呼ぶと例外) */
export function createSearch() {
  throw new Error('装備を探す機能は準備中です');
}
