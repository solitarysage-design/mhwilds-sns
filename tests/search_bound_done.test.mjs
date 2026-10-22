// 締めた上界 (docs/SEARCH_DESIGN.md 2.4 節「締めた上界」) で、探すタブの既定 (仮置きの発動率 0%・本人の前提の怒り・連撃・スタミナ満タンは
// 100%) の B&B が最後まで終わるか。前の上界では、B1z で上界を約 676 万回 (31 秒) 求めてやっと終わり、B3z は数十秒で終わらなかった。
// 上界の正しさは tests/search_bound.test.mjs (node --test はファイルごとに並べて回すので、重いものを分けた)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSearch } from '../app/model/search.js';
import { loadRepoData, makeCases, searchDataOf } from './search_cases.mjs';

const raw = await loadRepoData();
const { cases } = makeCases(raw);
const data = searchDataOf(raw);

for (const name of ['B1z', 'B3z']) {
  test(`探すタブの既定 (${name}): B&B が最後まで終わる (仕事量の予算 40 万回の中で)`, () => {
    // B3z は 2 段のふるいで残した武器 (3 本) の dfs が終わること (ふるいで外した武器は extend で回る)
    const s = createSearch({ ...cases[name], budget: { work: 400000 } }, data);
    while (!s.step(1e9));
    const r = s.result();
    assert.equal(r.status, 'done');
    assert.ok(r.stats.boundCalls < 400000);
    assert.equal(r.quality, 'heuristic');
  });
}
