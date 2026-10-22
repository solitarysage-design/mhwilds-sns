// 小さい問題で、探索の上位 K と独立の総当たりが一致するか (docs/SEARCH_DESIGN.md 6.2 節)。
// 総当たりはソルバのコードを使わない (tests/search_brute.mjs)。乱数の種は固定。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSearch } from '../app/model/search.js';
import { computeBuild, indexEquipData } from '../app/model/build.js';
import { loadRepoData, makeCases } from './search_cases.mjs';
import { makeSmallProblem, bruteForce } from './search_brute.mjs';

const raw = await loadRepoData();
const { artian, targetOf, skillId, zeroPlaceholders } = makeCases(raw);
const HEAD = [{ weight: 1, target: targetOf('アルシュベルド', 'head') }];
const MIX = [{ weight: 0.6, target: targetOf('アルシュベルド', 'head') }, { weight: 0.4, target: targetOf('アルシュベルド', 'left-wing') }];
const LB_MIXED = { head: true, chest: false, arms: true, waist: false, legs: true };

function run(input, data) {
  const s = createSearch(input, data);
  let n = 0;
  while (!s.step(1e9)) if (++n > 1e6) throw new Error('終わらない');
  return s.result();
}

// 問題: 種・部位ごとの数・護石の数・武器・限界突破・相手・コンボ・必須
const PROBLEMS = [
  { seed: 1, perPart: 3, charms: 3, targets: HEAD },
  // ゴグβ (巨戟龍の黙示録 + 火竜の力) と護火竜β (火竜の力・限界突破でスロットが変わる)
  { seed: 2, perPart: 3, charms: 3, targets: MIX, limitBreak: LB_MIXED, include: { chest: [676], arms: [68], legs: [70] } },
  { seed: 3, perPart: 3, charms: 2, targets: HEAD, weapon: 1182, combo: 1 },
  { seed: 4, perPart: 2, charms: 3, targets: MIX, limitBreak: false, combo: 2 },
  { seed: 5, perPart: 3, charms: 3, targets: HEAD, limitBreak: LB_MIXED, required: [['弱点特効', 4], ['攻撃', 3]] },
  { seed: 6, perPart: 3, charms: 3, targets: HEAD, required: [['巨戟龍の黙示録', 1]], include: { head: [670], chest: [676] } },
  // ヌシの魂 = 武器 (巨戟アーティア) 1 + γ 2 部位
  { seed: 7, perPart: 3, charms: 2, targets: MIX, required: [['ヌシの魂', 1]], combo: 3, include: { head: [328], arms: [330] } },
  { seed: 9, perPart: 3, charms: 3, targets: HEAD, required: [['火竜の力', 1]], include: { head: [66], chest: [676], waist: [69] } },
  { seed: 8, perPart: 3, charms: 3, targets: MIX, required: [['挑戦者', 3], ['見切り', 4]], limitBreak: LB_MIXED },
  // 探すタブの既定の発動率 (仮置きは 0%・本人の前提の怒り・連撃 5 ヒット以降段・スタミナ満タンは 100%。2026-10-22)。
  // 連撃・渾身・兇爪竜の力 (連撃が要る) も残す。1 位は挑戦者・連撃・渾身・兇爪竜の力が入った組
  { seed: 22, perPart: 2, charms: 3, targets: MIX, include: { head: [349], waist: [673] }, keepArmor: ['連撃', '渾身'],
    keepSets: ['兇爪竜の力'], uptimes: zeroPlaceholders, note: '探すタブの既定の発動率', topSkills: ['挑戦者', '連撃', '渾身', '兇爪竜の力'] },
  // 同じ発動率で必須つきの 2 問 (種 23・25) は tests/search_bound.test.mjs で、同じ総当たりを使って上位 10 件の一致も見る
];

const outcomes = [];
for (const pr of PROBLEMS) {
  const label = `種 ${pr.seed}${pr.required ? ` 必須 ${pr.required.map(([nm, l]) => nm + l).join('・')}` : ''}${pr.note ? ` (${pr.note})` : ''}`;
  test(`総当たりと一致: ${label}`, () => {
    const required = (pr.required || []).map(([nm, level]) => ({ skillId: skillId(nm), level }));
    const { data, input, info } = makeSmallProblem(raw, artian, { ...pr, required });
    const brute = bruteForce(data, input);
    assert.ok(brute.all.length > 0, `総当たりで満たす組がある (${JSON.stringify(info)})`);
    const K = 10;
    const want = brute.all.slice(0, K).map((x) => x.value);

    // exact・優越の除去なし: 上位 K の値が総当たりと完全に一致する
    const ex = run({ ...input, mode: 'exact', dominance: false, K }, data);
    assert.equal(ex.status, 'done');
    assert.equal(ex.quality, 'exact');
    const got = ex.results.map((x) => x.value);
    assert.equal(got.length, want.length);
    got.forEach((v, i) => assert.ok(Math.abs(v - want[i]) <= 1e-9 * want[i], `${i + 1} 位: ${v} / 総当たり ${want[i]}`));
    for (const nm of pr.topSkills || []) {
      assert.ok(ex.results[0].skills.some((x) => x.skillId === skillId(nm) && x.level > 0), `1 位に ${nm} が入る`);
    }

    // exact (優越の除去あり): 上位 1 件が一致。どの結果も総当たりの値のどれか
    const exd = run({ ...input, mode: 'exact', K }, data);
    assert.ok(Math.abs(exd.results[0].value - want[0]) <= 1e-9 * want[0], `優越の除去あり 1 位 ${exd.results[0].value} / ${want[0]}`);
    const values = brute.all.map((x) => x.value);
    for (const r of exd.results) assert.ok(values.some((v) => Math.abs(v - r.value) <= 1e-9 * v), `総当たりに無い値 ${r.value}`);

    // fast (狭いビーム + 仕事量の予算): 上位 1 件が一致。各順位の差を記録 (0.5% まで)
    const fa = run({ ...input, mode: 'fast', K, beam: [3, 8], budget: { work: 3000 } }, data);
    assert.ok(Math.abs(fa.results[0].value - want[0]) <= 1e-9 * want[0], `fast 1 位 ${fa.results[0].value} / ${want[0]}`);
    const gaps = exd.results.map((r, i) => (fa.results[i] ? (r.value - fa.results[i].value) / r.value : 1));
    const maxGap = Math.max(...gaps);
    assert.ok(maxGap <= 0.005, `fast の順位ごとの差 ${maxGap}`);

    // 返した装備は computeBuild でエラーが無く、必須を満たし、計算し直しの差が小さい
    const idx = indexEquipData({ ...data, myWeapons: [...data.myWeapons.weapons, artian] });
    for (const res of [ex, exd, fa]) {
      for (const r of res.results) {
        assert.equal(r.check.errors.length, 0);
        assert.ok(r.check.relDiff <= 1e-9, `計算し直しの差 ${r.check.relDiff}`);
        const cb = computeBuild(r.build, idx);
        for (const q of required) assert.ok((cb.skillLevels[q.skillId] || 0) >= q.level, `必須 ${q.skillId} Lv${q.level}`);
      }
    }
    outcomes.push({ label, combos: brute.count, evaluations: brute.evaluations, fastMaxGap: maxGap });
  });
}

test('満たせない必須: 総当たりで 0 件なら、探索も「無い」(infeasible) と答える', () => {
  // 種 8 の珠には超会心が無く、武器 (1182) と護石だけでは超会心 2 に届かない
  const required = [['挑戦者', 3], ['超会心', 2]].map(([nm, level]) => ({ skillId: skillId(nm), level }));
  const { data, input } = makeSmallProblem(raw, artian, { seed: 8, perPart: 3, charms: 3, targets: HEAD, weapon: 1182, required });
  assert.equal(bruteForce(data, input).all.length, 0);
  for (const mode of ['exact', 'fast']) {
    const r = run({ ...input, mode, budget: mode === 'fast' ? { work: 1e7 } : undefined }, data);
    assert.equal(r.results.length, 0, mode);
    assert.equal(r.status, 'infeasible', mode);
    assert.ok(r.infeasible.missing.some((m) => m.skillId === skillId('超会心')), JSON.stringify(r.infeasible));
  }
});

test('結果の記録 (fast の順位ごとの差)', () => {
  console.log(outcomes.map((o) => `  ${o.label}: 組 ${o.combos}・評価 ${o.evaluations}・fast の最大の差 ${(o.fastMaxGap * 100).toFixed(3)}%`).join('\n'));
  assert.equal(outcomes.length, PROBLEMS.length);
});
