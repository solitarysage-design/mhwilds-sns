// 護石の類をばらして探す工夫 (solver の spread。docs/SEARCH_DESIGN.md 2.13 節) のテスト。
// 最初のビームで護石の類ごとに 1 つずつ先に残し、dfs の根では護石の類を見つかった値の高い順に回る。刈る規則は変えないので、
// 最後まで探したときの上位は spread のあり・なしで同じで、総当たりの 1 位とも同じ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSearch } from '../app/model/search.js';
import { spreadByCharm, BnbSolver } from '../app/model/search/solver.js';
import { loadRepoData, makeCases } from './search_cases.mjs';
import { makeSmallProblem, bruteForce } from './search_brute.mjs';

const raw = await loadRepoData();
const { artian, targetOf } = makeCases(raw);
const HEAD = [{ weight: 1, target: targetOf('アルシュベルド', 'head') }];
const MIX = [{ weight: 0.6, target: targetOf('アルシュベルド', 'head') }, { weight: 0.4, target: targetOf('アルシュベルド', 'left-wing') }];

function run(input, data) {
  const s = createSearch(input, data);
  let n = 0;
  while (!s.step(1e9)) if (++n > 1e6) throw new Error('終わらない');
  return s.result();
}
const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
const vals = (r) => r.results.map((x) => x.value.toFixed(9));

test('spreadByCharm: 護石の類ごとに一番上界の高い状態を先に 1 つずつ、残りを上界の順。戻り値も上界の順', () => {
  const st = (charm, ub) => ({ charm, ub });
  const states = [st(0, 10), st(0, 9), st(0, 8), st(1, 7), st(0, 6), st(2, 5), st(1, 4)];
  const pick = (W) => spreadByCharm(states, W).map((s) => [s.charm, s.ub]);
  assert.deepEqual(pick(4), [[0, 10], [0, 9], [1, 7], [2, 5]], '類 1・2 の一番を先に残し、残りの 1 つは上界の順');
  assert.deepEqual(pick(2), [[0, 10], [1, 7]], '幅より類が多いときは、類ごとの一番を上界の順に');
  assert.deepEqual(pick(3), [[0, 10], [1, 7], [2, 5]]);
  assert.equal(spreadByCharm(states, 10).length, states.length, '幅に収まるときは全部');
  assert.notEqual(spreadByCharm(states, 10), states, '元の配列は変えない (写しを返す)');
  // 護石をまだ決めていない状態 (charm -1) は先に取る枠を持たず、上界の順で埋める側に入る (ビームでは護石を最初に決めるので出てこない)
  assert.deepEqual(spreadByCharm([st(-1, 9), st(-1, 8), st(0, 7)], 2).map((s) => s.ub), [9, 7]);
});

test('小さい問題: 最後まで探すと spread のあり・なしで上位 K の値が同じ。1 位は総当たりと同じ (護石の類が多い・ビームが狭い)', () => {
  // ビームを狭くすると、根を回る順 (見つかった値の順) が上界の順と食い違いやすい。根の刈り方 (1 つずつ飛ばす) の確かめも兼ねる
  const problems = [
    { seed: 1, perPart: 3, charms: 8, targets: HEAD },
    { seed: 2, perPart: 3, charms: 8, targets: MIX },
    { seed: 4, perPart: 2, charms: 8, targets: MIX, limitBreak: false, combo: 2 },
    { seed: 8, perPart: 3, charms: 6, targets: HEAD },
    { seed: 11, perPart: 3, charms: 8, targets: HEAD, combo: 1 },
  ];
  let reordered = 0;
  for (const pr of problems) {
    const { data, input } = makeSmallProblem(raw, artian, pr);
    const brute = bruteForce(data, input).all;
    assert.ok(brute.length > 0);
    for (const beam of [[1, 2], [3, 8], [60, 200]]) {
      const on = run({ ...input, mode: 'fast', beam, K: 10 }, data);
      const off = run({ ...input, mode: 'fast', beam, K: 10, spread: false }, data);
      assert.equal(on.status, 'done');
      assert.deepEqual(vals(on), vals(off), `種 ${pr.seed} ビーム ${beam}`);
      assert.ok(near(on.results[0].value, brute[0].value), `種 ${pr.seed} ビーム ${beam}: 1 位 ${on.results[0].value} / 総当たり ${brute[0].value}`);
      if (on.stats.boundCalls !== off.stats.boundCalls) reordered++;
    }
  }
  assert.ok(reordered > 0, 'どこかで探す順が変わっている (spread が効いている)');
});

test('dfs の根はどの順でもよい: 根で刈れる子があってもその子だけを飛ばし、後ろの子も回る (上位は spread なしと同じ)', () => {
  // 根の節 (anyOrder) は上界の順ではないので、刈れる子の後ろに上界の高い子が残る。上界の順のつもりで残りを全部飛ばすと、それを落とす。
  // 小さい問題では根の上界がどれも近くて根で刈りが起きないので、根の 2 番目に「必ず刈れる子」(1 番目の写しで上界を極端に低くしたもの) を
  // 差し込み、さらに残りを上界の低い順にして確かめる
  const orig = BnbSolver.prototype.beginWeapon;
  const twisted = function (wi) {
    orig.call(this, wi);
    const fr = this.stack[0];
    if (!fr.anyOrder || !fr.kids.length) return;
    const [first, ...rest] = fr.kids;
    rest.sort((a, b) => a.ub - b.ub);
    fr.kids = [first, { ...first, ub: -1e12 }, ...rest];
  };
  try {
    let checked = 0;
    for (const pr of [{ seed: 1, perPart: 3, charms: 8, targets: HEAD }, { seed: 2, perPart: 3, charms: 8, targets: MIX },
      { seed: 11, perPart: 3, charms: 8, targets: HEAD, combo: 1 }]) {
      const { data, input } = makeSmallProblem(raw, artian, pr);
      const opt = { ...input, mode: 'fast', beam: [3, 8], K: 10, dominance: false };
      BnbSolver.prototype.beginWeapon = twisted;
      const tw = run(opt, data);
      BnbSolver.prototype.beginWeapon = orig;
      const off = run({ ...opt, spread: false }, data);
      assert.equal(tw.status, 'done');
      assert.deepEqual(vals(tw), vals(off), `種 ${pr.seed}`);
      // 確かめになっているか: 1 位の護石の類だけでは上位 10 件がそろわない (ほかの類を落とすと結果が変わる)
      if (new Set(off.results.map((x) => JSON.stringify(x.build.charm))).size > 1) checked++;
    }
    assert.ok(checked > 0, '上位にいくつかの護石が入る問題がある');
  } finally {
    BnbSolver.prototype.beginWeapon = orig;
  }
});

test('exact・泣シミュ型では spread をしない (探す順は今までどおり)', () => {
  const { data, input } = makeSmallProblem(raw, artian, { seed: 1, perPart: 3, charms: 8, targets: HEAD });
  const a = run({ ...input, mode: 'exact', K: 10 }, data);
  const b = run({ ...input, mode: 'exact', K: 10, spread: false }, data);
  assert.equal(a.stats.boundCalls, b.stats.boundCalls);
  assert.deepEqual(vals(a), vals(b));
  const n1 = run({ ...input, objective: 'none', K: 5 }, data);
  const n2 = run({ ...input, objective: 'none', K: 5, spread: false }, data);
  assert.equal(n1.stats.boundCalls, n2.stats.boundCalls);
});
