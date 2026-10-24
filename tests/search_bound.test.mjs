// 締めた上界 (docs/SEARCH_DESIGN.md 2.4 節「締めた上界」) が上界のままか。決めた小さい問題 8 問 (tests/search_brute.mjs) の乱数の
// 部分状態で、上界・ふるい ≥ 本当の最良・前の上界以下・覚えと作り直しが同じ・表の行 ≥ 本当の増え方 を確かめる
// (確かめの中身は tests/search_bound_check.mjs)。乱数で作る問題は tests/search_bound_random.test.mjs、探すタブの既定の B&B が
// 最後まで終わることは tests/search_bound_done.test.mjs (node --test はファイルごとに並べて回すので、重いものを分けた)。乱数の種は固定。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSearch } from '../app/model/search.js';
import { BnbSolver, MEMO_LIMITS } from '../app/model/search/solver.js';
import { loadRepoData, makeCases } from './search_cases.mjs';
import { makeSmallProblem, bruteForce } from './search_brute.mjs';
import { checkProblem } from './search_bound_check.mjs';

const raw = await loadRepoData();
const { artian, targetOf, skillId, zeroPlaceholders } = makeCases(raw);
const HEAD = [{ weight: 1, target: targetOf('アルシュベルド', 'head') }];
const MIX = [{ weight: 0.6, target: targetOf('アルシュベルド', 'head') }, { weight: 0.4, target: targetOf('アルシュベルド', 'left-wing') }];

// createSearch は内側のソルバを返さないので、作られたものを覚える (このファイルだけ。node --test はファイルごとに別のプロセス)
const solvers = [];
const start0 = BnbSolver.prototype.start;
BnbSolver.prototype.start = function () { solvers.push(this); return start0.call(this); };
let joint = 0;
const joint0 = BnbSolver.prototype.jointForced;
BnbSolver.prototype.jointForced = function (...a) { const x = joint0.apply(this, a); if (x) joint++; return x; };

const PROBLEMS = [
  // 探すタブの既定の発動率 (挑戦者・連撃・渾身・兇爪竜の力 (連撃が前提))
  { seed: 22, perPart: 2, charms: 3, targets: MIX, include: { head: [349], waist: [673] }, keepArmor: ['連撃', '渾身'], keepSets: ['兇爪竜の力'],
    uptimes: zeroPlaceholders },
  // 同じ発動率で必須つき: 最初の段が急なスキル (連撃) を珠で埋める分 (decoGreedy の forced を min(λx, H(x)) で数える所) と、
  // 前提のスキルが要るシリーズ (兇爪竜の力。表ではシリーズの行) の必須。match = mode 'exact' の上位 10 件が総当たりと一致することも見る
  // (tests/search_small.test.mjs と同じ確かめ。総当たりを 2 回しないようにこちらに置いた)
  { seed: 23, perPart: 2, charms: 3, targets: HEAD, include: { head: [349], chest: [676] }, keepArmor: ['連撃', '渾身'], keepSets: ['兇爪竜の力'],
    required: [['連撃', 5]], uptimes: zeroPlaceholders, match: true },
  { seed: 25, perPart: 2, charms: 2, targets: HEAD, include: { head: [349], waist: [673] }, keepArmor: ['連撃', '渾身'], keepSets: ['兇爪竜の力'],
    required: [['兇爪竜の力', 1]], uptimes: zeroPlaceholders, match: true },
  { seed: 5, perPart: 3, charms: 3, targets: HEAD, required: [['弱点特効', 4], ['攻撃', 3]] },
  { seed: 7, perPart: 3, charms: 2, targets: MIX, required: [['ヌシの魂', 1]], combo: 3, include: { head: [328], arms: [330] } },
  // 火力に効かない必須 (珠の大きさ 1 が 2 つ・2 が 2 つ)。同じ部位の別々の類がそれぞれ別の耐性を持つ形にして、
  // 珠の数をまとめて見る下限 (jointForced) を通す
  { seed: 41, perPart: 2, charms: 2, targets: HEAD, keepArmor: ['風圧耐性', '気絶耐性'], include: { waist: [69], legs: [332, 70] },
    required: [['風圧耐性', 3], ['気絶耐性', 3]], uptimes: zeroPlaceholders },
  { seed: 42, perPart: 2, charms: 3, targets: MIX, keepArmor: ['スタミナ急速回復', '回避性能'], include: { head: [328, 41], legs: [332, 45] },
    required: [['スタミナ急速回復', 3], ['回避性能', 3]] },
  // 灼熱化 (2026-10-24): 火でない武器 (龍属性の鎖刃剣アルトリウス) + 火竜の力 (護火竜β・ゴグメイルβ) + 火属性攻撃強化 (火炎珠)。
  // 火属性攻撃強化は火竜の力があるときだけ灼熱化の火の分に効く (補い合う形)。△連携 (対象ヒット 4 つ)。武器用の珠は火炎珠だけにして、
  // 火属性攻撃強化が上位の組に入るようにする。match で上位 10 件も総当たりと比べる
  { seed: 31, perPart: 2, charms: 2, targets: HEAD, weapon: 1064, combo: 2, include: { head: [66], chest: [676], arms: [68], waist: [69] },
    weaponDecos: [155, 154, 294], weaponDecosOnly: true, match: true, scorch: true },
];

for (const pr of PROBLEMS) {
  test(`締めた上界 ≥ 部分状態から届く本当の最良: 種 ${pr.seed}${pr.required ? ` 必須 ${pr.required.map(([nm, l]) => nm + l).join('・')}` : ''}`, () => {
    const required = (pr.required || []).map(([nm, level]) => ({ skillId: skillId(nm), level }));
    const { data, input } = makeSmallProblem(raw, artian, { ...pr, required });
    const brute = bruteForce(data, input);
    assert.ok(brute.all.length > 0);
    const s = createSearch({ ...input, mode: 'exact', dominance: false, K: 10, budget: { work: 1 } }, data);
    s.step(1e9); s.step(1e9);
    const S = solvers.at(-1);
    assert.ok(S.tight);
    const o = checkProblem(S, brute, pr.seed);
    console.log(`  種 ${pr.seed}: 状態 ${o.states}・前より締まった ${o.tighter}・ふるいの類 ${o.screened}・表の行 ${o.rows}・耐性の珠をまとめて見た回 ${joint}`);
    assert.ok(o.tighter > 0);
    if (pr.seed >= 41) assert.ok(joint > 0, '珠の数をまとめて見る下限を通った');
    if (pr.scorch) {
      // 総当たりの上位に、火竜の力と火属性攻撃強化の両方が入った組がある (この問題で補い合う形を通っている)
      const sc = skillId('火竜の力'); const fu = skillId('火属性攻撃強化');
      assert.ok(brute.all.slice(0, 10).some((x) => x.levels[sc] > 0 && x.levels[fu] > 0), '上位に火竜の力 + 火属性攻撃強化の組がある');
    }
    joint = 0;
    if (pr.match) {
      const ex = createSearch({ ...input, mode: 'exact', dominance: false, K: 10 }, data);
      while (!ex.step(1e9));
      const r = ex.result();
      assert.equal(r.status, 'done');
      assert.equal(r.quality, 'exact');
      const want = brute.all.slice(0, 10).map((x) => x.value);
      assert.equal(r.results.length, want.length);
      r.results.forEach((x, i) => assert.ok(Math.abs(x.value - want[i]) <= 1e-9 * want[i], `${i + 1} 位: ${x.value} / 総当たり ${want[i]}`));
    }
  });
}

test('表の行の覚えが上限 (MEMO_LIMITS.boundRows) をこえたら、引く前に全部の武器の行を忘れて作り直す (値は同じ)', () => {
  const pr = PROBLEMS[1];
  const { data, input } = makeSmallProblem(raw, artian, { ...pr, required: pr.required.map(([nm, level]) => ({ skillId: skillId(nm), level })) });
  const s = createSearch({ ...input, mode: 'exact', dominance: false, K: 10, budget: { work: 1 } }, data);
  s.step(1e9); s.step(1e9);
  const S = solvers.at(-1);
  const ubOf = (ch, parts, d) => {
    S.list = []; S.keys = new Map(); S.phase = 'dfs';
    S.load({ wi: 0, charm: ch, parts });
    return S.bound(true, d, d < 5 ? d : -1);
  };
  const states = [];
  for (let ch = 0; ch < S.charmCls.length; ch++) {
    for (let d = 0; d <= 5; d++) states.push({ ch, d, parts: [0, 1, 2, 3, 4].map((pi) => (pi < d ? (ch + pi) % S.partCls[pi].length : -1)) });
  }
  const want = states.map((st) => ubOf(st.ch, st.parts, st.d));
  const clears0 = S.stats.boundRowClears;
  // 毎回、上限をこえた状態から引く (忘れるのは引く前だけで、その呼び出しで作る行は上限をこえても最後まで使う。前は行を作る途中で
  // 忘れて呼び直していたので、上限が 1 回に作る行の数より小さいと止まらなかった)
  states.forEach((st, i) => {
    S.boundRowsN = MEMO_LIMITS.boundRows + 1;
    const ub = ubOf(st.ch, st.parts, st.d);
    assert.ok(ub === want[i] || Math.abs(ub - want[i]) <= 1e-12 * Math.abs(want[i]), `${ub} / ${want[i]}`);
    assert.ok(S.boundRowsN < MEMO_LIMITS.boundRows);
  });
  assert.ok(S.stats.boundRowClears - clears0 >= states.length);
});
