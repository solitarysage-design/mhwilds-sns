// 締めた上界 (docs/SEARCH_DESIGN.md 2.4 節「締めた上界」) を、乱数で作る小さい問題 (tests/search_brute.mjs の makeRandomProblem) で
// 確かめる (中身は tests/search_bound_check.mjs。決めた 8 問は tests/search_bound.test.mjs)。決めた問題 (種 31 を足す前の 7 問) は
// 上界と本当の最良の差がいちばん小さい所でも 1% ほどあり、上界を 1% 以下だけ下げる誤りが見えないので、上界かふるいが本当の最良とぴったり同じになる状態がある
// 種を選んだ (最後のテストでそれを確かめる)。乱数の種は固定。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSearch } from '../app/model/search.js';
import { BnbSolver } from '../app/model/search/solver.js';
import { loadRepoData, makeCases } from './search_cases.mjs';
import { makeRandomProblem, bruteForce } from './search_brute.mjs';
import { checkProblem } from './search_bound_check.mjs';

const raw = await loadRepoData();
const { artian, targetOf } = makeCases(raw);

// createSearch は内側のソルバを返さないので、作られたものを覚える (このファイルだけ。node --test はファイルごとに別のプロセス)
const solvers = [];
const start0 = BnbSolver.prototype.start;
BnbSolver.prototype.start = function () { solvers.push(this); return start0.call(this); };

// 種 (makeRandomProblem)。どれも総当たりが 0.5 秒以下。156 と 266 は武器用スロットが同じで武器の珠の上積みが違う護石の類があり、武器の
// 珠の上積みの覚え (weaponGain の鍵) の誤りが値に出る (1〜400 でこの形は 12 個だけ)。ほかは上界かふるいが本当の最良とぴったり同じになる
// 状態がある (2026-10-22 のデータ。データが変わってそうでなくなったら、最後のテストが落ちるので種を選び直す)
const RANDOM_SEEDS = [6, 9, 23, 27, 31, 47, 58, 156, 266];
/** 上界・ふるいと本当の最良の差の一番小さいもの (相対。最後のテストで検出力を見る) */
const slack = { ub: Infinity, kid: Infinity };

for (const seed of RANDOM_SEEDS) {
  test(`乱数で作った問題 (種 ${seed}): 締めた上界・ふるい ≥ 本当の最良・覚えと作り直しが同じ・表の行 ≥ 本当の増え方`, () => {
    const { data, input, info } = makeRandomProblem(raw, artian, targetOf, seed);
    const brute = bruteForce(data, input);
    assert.ok(brute.all.length > 0, JSON.stringify(info));
    const s = createSearch({ ...input, mode: 'exact', dominance: false, K: 10, budget: { work: 1 } }, data);
    s.step(1e9); s.step(1e9);
    const o = checkProblem(solvers.at(-1), brute, seed, slack);
    console.log(`  種 ${seed} (${info.armor.join('・')} / ${info.weapon.join('・')}${info.required.length ? ` / 必須 ${info.required.join('・')}` : ''}): 状態 ${o.states}・前より締まった ${o.tighter}・ふるいの類 ${o.screened}・表の行 ${o.rows}`);
  });
}

test('乱数で作った問題に、上界とふるいが本当の最良とぴったり同じになる状態がある (少しだけ低い上界も見えるか)', () => {
  console.log(`  差の一番小さいもの: 上界 ${slack.ub}・ふるい ${slack.kid}`);
  assert.ok(slack.ub <= 1e-9, `上界の差の最小 ${slack.ub} (種を選び直す)`);
  assert.ok(slack.kid <= 1e-9, `ふるいの差の最小 ${slack.kid} (種を選び直す)`);
});
