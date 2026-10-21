// シリーズ/グループスキルの必須 (docs/SEARCH_DESIGN.md 2.8 節・6.3 節): 残りの部位を「どのボーナスに数えるか」割り当てて判定する。
// 部位を取り合う必須 (シリーズ 2 つ + グループ・1 部位で 2 つのシリーズに数えるゴグβ) を、独立の総当たり
// (tests/search_brute.mjs。ソルバのコードを使わない) と比べて、満たせる構成を刈っていないこと・満たせない組は最初に分かることを確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSearch } from '../app/model/search.js';
import { computeBuild, indexEquipData } from '../app/model/build.js';
import { loadRepoData, makeCases, searchDataOf } from './search_cases.mjs';
import { makeSmallProblem, bruteForce } from './search_brute.mjs';

const raw = await loadRepoData();
const { cases, artian, targetOf, skillId } = makeCases(raw);
const data = searchDataOf(raw);
const HEAD = [{ weight: 1, target: targetOf('アルシュベルド', 'head') }];

function run(input, d) {
  const s = createSearch(input, d);
  let n = 0;
  while (!s.step(1e9)) if (++n > 1e6) throw new Error('終わらない');
  return s.result();
}
const req = (pairs) => pairs.map(([nm, level]) => ({ skillId: skillId(nm), level }));

// 部位: ゴグα (巨戟龍の黙示録)・ゴグメイルβ (巨戟龍の黙示録 + 火竜の力)・γ (ヌシの魂)・護火竜β (火竜の力)
const INCLUDE = {
  head: [670, 328, 66], chest: [676, 329, 42], arms: [672, 330, 68], waist: [673, 331, 69], legs: [674, 332, 70],
};
const PROBLEMS = [
  // 5 部位ぎりぎり: γ 2 (ヌシの魂 = 武器 + 2) + ゴグメイルβ (両方) + ゴグ 1 + 火竜 1
  { label: '巨戟龍の黙示録1・火竜の力1・ヌシの魂1 (5 部位ぎりぎり)', required: [['巨戟龍の黙示録', 1], ['火竜の力', 1], ['ヌシの魂', 1]] },
  // ゴグ 4 部位のうちメイルβ が火竜の力にも数える (1 部位で 2 つのボーナス)
  { label: '巨戟龍の黙示録2・火竜の力1 (ゴグメイルβ が両方に数える)', required: [['巨戟龍の黙示録', 2], ['火竜の力', 1]] },
  { label: '火竜の力1・ヌシの魂1・挑戦者2', required: [['火竜の力', 1], ['ヌシの魂', 1], ['挑戦者', 2]], seed: 12 },
  { label: '巨戟龍の黙示録1・ヌシの魂1・弱点特効3', required: [['巨戟龍の黙示録', 1], ['ヌシの魂', 1], ['弱点特効', 3]], seed: 13 },
];

for (const pr of PROBLEMS) {
  test(`部位を取り合う必須が総当たりと一致: ${pr.label}`, () => {
    const required = req(pr.required);
    const { data: d, input } = makeSmallProblem(raw, artian, { seed: pr.seed ?? 11, perPart: 3, charms: 2, targets: HEAD, include: INCLUDE, required });
    const brute = bruteForce(d, input);
    assert.ok(brute.all.length > 0, '総当たりで満たす組がある');
    const want = brute.all.slice(0, 10).map((x) => x.value);
    const ex = run({ ...input, mode: 'exact', dominance: false, K: 10 }, d);
    assert.equal(ex.status, 'done');
    assert.deepEqual(ex.results.map((r) => r.value.toFixed(9)), want.map((v) => v.toFixed(9)));
    const fa = run({ ...input, mode: 'fast', K: 10, beam: [3, 8], budget: { work: 3000 } }, d);
    assert.ok(Math.abs(fa.results[0].value - want[0]) <= 1e-9 * want[0], `fast 1 位 ${fa.results[0].value} / ${want[0]}`);
    const idx = indexEquipData({ ...d, myWeapons: [...d.myWeapons.weapons, artian] });
    for (const r of [...ex.results, ...fa.results]) {
      const cb = computeBuild(r.build, idx);
      for (const q of required) assert.ok((cb.skillLevels[q.skillId] || 0) >= q.level, `必須 ${q.skillId} Lv${q.level}`);
    }
  });
}

test('部位が足りない組 (巨戟龍の黙示録2 = 4 部位 + ヌシの魂 = γ 2 部位) は、総当たりも 0 件で、探索は最初の上界で「無い」', () => {
  const required = req([['巨戟龍の黙示録', 2], ['ヌシの魂', 1]]);
  const { data: d, input } = makeSmallProblem(raw, artian, { seed: 11, perPart: 3, charms: 2, targets: HEAD, include: INCLUDE, required });
  assert.equal(bruteForce(d, input).all.length, 0);
  for (const mode of ['exact', 'fast']) {
    const r = run({ ...input, mode }, d);
    assert.equal(r.status, 'infeasible', mode);
    assert.equal(r.stats.nodes, 0, `${mode}: 木を回らずに分かる`);
    const names = r.infeasible.missing.map((m) => m.name).sort();
    assert.deepEqual(names, ['ヌシの魂', '巨戟龍の黙示録'].sort());
    assert.ok(r.infeasible.missing.every((m) => /同時には届きません/.test(m.reason)), JSON.stringify(r.infeasible));
  }
});

test('本物のデータ (B1): 巨戟龍の黙示録2 + ヌシの魂 は最初の上界で「無い」・巨戟龍の黙示録1 + ヌシの魂 は全部満たす', () => {
  const t0 = performance.now();
  const bad = run({ ...cases.B1, required: req([['巨戟龍の黙示録', 2], ['ヌシの魂', 1]]), budget: { work: 3000 } }, data);
  assert.equal(bad.status, 'infeasible');
  assert.equal(bad.stats.nodes, 0);
  assert.ok(performance.now() - t0 < 2000);
  const required = req([['巨戟龍の黙示録', 1], ['ヌシの魂', 1], ['火竜の力', 1]]);
  const ok = run({ ...cases.B1z, required, beam: [20, 60], budget: { work: 3000 } }, data);
  assert.ok(ok.results.length > 0, ok.status);
  for (const r of ok.results) {
    const lv = Object.fromEntries(r.skills.map((s) => [s.skillId, s.level]));
    for (const q of required) assert.ok((lv[q.skillId] || 0) >= q.level, `必須 ${q.skillId}`);
  }
});

test('ランダムな部位の組 (種 20〜27) でシリーズ/グループの必須: 満たせるかが総当たりと同じ・exact の 1 位が同じ', () => {
  const choices = [['巨戟龍の黙示録', 1], ['巨戟龍の黙示録', 2], ['火竜の力', 1], ['火竜の力', 2], ['ヌシの魂', 1]];
  let feasible = 0; let infeasible = 0;
  for (let seed = 20; seed < 28; seed++) {
    // 種から必須を 2〜3 個選ぶ (同じスキルは 1 つ)
    const picked = [];
    let s = seed;
    while (picked.length < 2 + (seed % 2)) {
      s = (s * 1103515245 + 12345) % 2147483648;
      const c = choices[s % choices.length];
      if (!picked.some((p) => p[0] === c[0])) picked.push(c);
    }
    const required = req(picked);
    const { data: d, input } = makeSmallProblem(raw, artian, { seed, perPart: 2, charms: 2, targets: HEAD, required,
      include: Object.fromEntries(Object.entries(INCLUDE).map(([p, ids]) => [p, [ids[seed % 3], ids[(seed + 1) % 3]]])) });
    const brute = bruteForce(d, input);
    const r = run({ ...input, mode: 'exact', K: 3 }, d);
    if (!brute.all.length) {
      infeasible++;
      assert.equal(r.status, 'infeasible', `種 ${seed} ${JSON.stringify(picked)}`);
    } else {
      feasible++;
      assert.ok(r.results.length > 0, `種 ${seed} ${JSON.stringify(picked)} は満たせる`);
      assert.ok(Math.abs(r.results[0].value - brute.all[0].value) <= 1e-9 * brute.all[0].value, `種 ${seed} 1 位`);
    }
  }
  assert.ok(feasible >= 2 && infeasible >= 1, `満たせる ${feasible}・満たせない ${infeasible}`);
});
