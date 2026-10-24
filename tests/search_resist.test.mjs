// 防具の耐性の合計の下限 (探索の入力 armorResistMin。docs/SEARCH_DESIGN.md 2.12 節) のテスト。
// 相手タブの「耐性の値で属性やられを防ぐ」回は、守りのチェック (耐性の合計 ≥ 20) を探索の条件に入れる (2026-10-24。所持護石が増えると、
// 上位が「防具の耐性が足りない組」で埋まって、守りを満たす組が上位の外に押し出されたため)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSearch } from '../app/model/search.js';
import { ARMOR_PARTS } from '../app/model/build.js';
import { defenseCheck } from '../app/model/recommend.js';
import { loadRepoData, makeCases, makePlanCases } from './search_cases.mjs';
import { makeSmallProblem, bruteForce } from './search_brute.mjs';

const raw = await loadRepoData();
const { artian, targetOf } = makeCases(raw);
const HEAD = [{ weight: 1, target: targetOf('アルシュベルド', 'head') }];

function run(input, data) {
  const s = createSearch(input, data);
  let n = 0;
  while (!s.step(1e9)) if (++n > 1e6) throw new Error('終わらない');
  return s.result();
}

const resistSum = (armorById, armor, e) => ARMOR_PARTS.reduce((t, p) => t + (Number(armorById.get(armor[p]).resist?.[e]) || 0), 0);
const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

test('小さい問題: 下限つきの上位 K が、総当たりで下限を満たす組だけを並べたものと一致する (属性 1 つ・2 つ)', () => {
  for (const seed of [1, 8]) {
    const { data, input } = makeSmallProblem(raw, artian, { seed, perPart: 3, charms: 3, targets: HEAD });
    const byId = new Map(data.armor.armor.map((a) => [a.id, a]));
    const all = bruteForce(data, input).all;
    // 下限は、総当たりの上位 20 組の火耐性の合計の中央値 (上位の半分くらいが落ちる)
    const fires = all.slice(0, 20).map((x) => resistSum(byId, x.armor, 'fire')).sort((a, b) => a - b);
    const waters = all.slice(0, 20).map((x) => resistSum(byId, x.armor, 'water')).sort((a, b) => a - b);
    for (const min of [{ fire: fires[10] }, { fire: fires[6], water: waters[6] }]) {
      const brute = bruteForce(data, { ...input, armorResistMin: min }).all;
      assert.ok(brute.length > 0 && brute[0].value < all[0].value * (1 + 1e-12), `種 ${seed} ${JSON.stringify(min)}: 下限で組が減る`);
      const K = 10;
      const want = brute.slice(0, K).map((x) => x.value);
      const ex = run({ ...input, armorResistMin: min, mode: 'exact', dominance: false, K }, data);
      assert.equal(ex.status, 'done');
      assert.deepEqual(ex.results.map((x) => x.value.toFixed(9)), want.map((v) => v.toFixed(9)), `種 ${seed} ${JSON.stringify(min)} exact`);
      // 優越の除去あり・fast でも 1 位は同じで、どの結果も下限を満たす
      const exd = run({ ...input, armorResistMin: min, mode: 'exact', K }, data);
      const fa = run({ ...input, armorResistMin: min, mode: 'fast', K, beam: [3, 8], budget: { work: 3000 } }, data);
      for (const r of [ex, exd, fa]) {
        assert.ok(near(r.results[0].value, want[0]), `種 ${seed} 1 位 ${r.results[0].value} / ${want[0]}`);
        for (const x of r.results) {
          for (const [e, m] of Object.entries(min)) assert.ok(resistSum(byId, x.build.armor, e) >= m, `${e} ${resistSum(byId, x.build.armor, e)} < ${m}`);
        }
      }
    }
  }
});

test('類の中の防具の耐性が違うとき: 下限を満たす防具を選び、同じ値になる防具も下限を満たすものだけ出す', () => {
  const { data, input } = makeSmallProblem(raw, artian, { seed: 1, perPart: 3, charms: 3, targets: HEAD });
  const free = run({ ...input, mode: 'exact', K: 1 }, data);
  const top = free.results[0];
  const byId0 = new Map(data.armor.armor.map((a) => [a.id, a]));
  const fire0 = resistSum(byId0, top.build.armor, 'fire');
  // 1 位の頭と同じスキル・スロットで、火耐性だけ +10 の防具 (同じ類になる) と -10 の防具を足す
  const head = byId0.get(top.build.armor.head);
  const hi = { ...head, id: 990001, name: `${head.name} (耐性 +10)`, resist: { ...head.resist, fire: (head.resist.fire || 0) + 10 } };
  const lo = { ...head, id: 990002, name: `${head.name} (耐性 -10)`, resist: { ...head.resist, fire: (head.resist.fire || 0) - 10 } };
  const d2 = { ...data, armor: { armor: [lo, ...data.armor.armor, hi] } };
  const byId = new Map(d2.armor.armor.map((a) => [a.id, a]));
  // 下限なし: 3 つとも同じ類 (同じ値になる防具に出る)
  const r0 = run({ ...input, mode: 'exact', K: 1 }, d2);
  assert.ok(near(r0.results[0].value, top.value));
  const alt0 = [r0.results[0].build.armor.head, ...r0.results[0].alternatives.head].sort();
  assert.ok([head.id, hi.id, lo.id].every((id) => alt0.includes(id)), JSON.stringify(alt0));
  // 下限 = いまの 1 位の火耐性 + 5: 頭が +10 の防具なら同じ値で満たせる
  const r = run({ ...input, armorResistMin: { fire: fire0 + 5 }, mode: 'exact', K: 3 }, d2);
  const b = r.results[0];
  assert.ok(near(b.value, top.value), `${b.value} / ${top.value}`);
  assert.equal(b.build.armor.head, hi.id);
  assert.ok(!b.alternatives.head.includes(head.id) && !b.alternatives.head.includes(lo.id), '入れ替えると下限を割る防具は出さない');
  for (const x of r.results) assert.ok(resistSum(byId, x.build.armor, 'fire') >= fire0 + 5);
  // 下限 = 1 位の火耐性 - 5: 元の頭でも満たすので、元の並び (先にある -10 の防具は満たさないので飛ばす) で選び、+10 も同じ値になる防具に出す
  const r2 = run({ ...input, armorResistMin: { fire: fire0 - 5 }, mode: 'exact', K: 1 }, d2);
  assert.equal(r2.results[0].build.armor.head, head.id);
  assert.ok(r2.results[0].alternatives.head.includes(hi.id) && !r2.results[0].alternatives.head.includes(lo.id));
  // 属性 2 つ: 火だけ高い頭と水だけ高い頭 (同じ類)。類の中の最大を属性ごとに足すと届くが、1 つの防具では両方は満たせない
  const water0 = resistSum(byId0, top.build.armor, 'water');
  const f = { ...head, id: 990003, resist: { ...head.resist, fire: (head.resist.fire || 0) + 10, water: (head.resist.water || 0) - 10 } };
  const w = { ...head, id: 990004, resist: { ...head.resist, fire: (head.resist.fire || 0) - 10, water: (head.resist.water || 0) + 10 } };
  const d3 = { ...data, armor: { armor: [...data.armor.armor.filter((a) => a.id !== head.id), f, w] } };
  const byId3 = new Map(d3.armor.armor.map((a) => [a.id, a]));
  const min2 = { fire: fire0 + 5, water: water0 + 5 };
  const r3 = run({ ...input, armorResistMin: min2, mode: 'exact', K: 10 }, d3);
  const brute3 = bruteForce(d3, { ...input, armorResistMin: min2 }).all;
  if (brute3.length) assert.ok(near(r3.results[0].value, brute3[0].value), `${r3.results[0]?.value} / ${brute3[0].value}`);
  else assert.equal(r3.status, 'infeasible');
  for (const x of r3.results) {
    for (const [e, m] of Object.entries(min2)) assert.ok(resistSum(byId3, x.build.armor, e) >= m, `${e}: ${resistSum(byId3, x.build.armor, e)} < ${m}`);
  }
});

test('届かない下限は「無い」(infeasible)。知らない属性・数でない値は外して続ける', () => {
  const { data, input } = makeSmallProblem(raw, artian, { seed: 1, perPart: 3, charms: 3, targets: HEAD });
  const r = run({ ...input, armorResistMin: { fire: 999 }, mode: 'fast', budget: { work: 1e6 } }, data);
  assert.equal(r.status, 'infeasible');
  assert.equal(r.results.length, 0);
  // 足りないものは「防具の火耐性の合計」(スキルのせいにしない)
  assert.deepEqual(r.infeasible.missing.map((m) => [m.skillId, m.name, m.min]), [[null, '防具の火耐性の合計', 999]]);
  const base = run({ ...input, mode: 'exact', K: 3 }, data);
  const odd = run({ ...input, armorResistMin: { poison: 50, fire: 'x', water: null }, mode: 'exact', K: 3 }, data);
  assert.deepEqual(odd.results.map((x) => x.value), base.results.map((x) => x.value));
});

test('相手タブ (S4z・S3z): 耐性の回に armorResistMin が付き、結果は全部守りのチェックに合格する', async () => {
  const { jobs, data, index } = await makePlanCases(raw, { budgetMs: 6000 });
  for (const name of ['S4z', 'S3z']) {
    const job = jobs[name];
    const resistRun = job.runs.find((x) => x.key === 'blight-resist');
    const elements = job.requirements.find((x) => x.kind === 'blight').elements;
    assert.deepEqual(Object.keys(resistRun.input.armorResistMin).sort(), [...elements].sort());
    assert.ok(Object.values(resistRun.input.armorResistMin).every((v) => v === 0), '耐性スキル Lv3 (+20) で、防具の合計が 0 以上');
    assert.equal(job.runs.find((x) => x.key === 'blight-skill').input.armorResistMin, undefined, '属性やられ耐性の回には付けない');
    const s = createSearch({ ...resistRun.input, budget: { work: 20000 } }, data);
    while (!s.step(1e9));
    const r = s.result();
    assert.ok(r.results.length > 0, name);
    for (const x of r.results) {
      const d = defenseCheck(x.build, job.requirements, index, data.skillEffects);
      assert.ok(d.ok, `${name}: ${JSON.stringify(d.rows.filter((q) => !q.meets).map((q) => q.text))}`);
      for (const p of ARMOR_PARTS) {
        for (const alt of x.alternatives[p] || []) {
          const d2 = defenseCheck({ ...x.build, armor: { ...x.build.armor, [p]: alt } }, job.requirements, index, data.skillEffects);
          assert.ok(d2.ok, `${name}: 同じ値になる防具 ${alt} (${p}) も守りを満たす`);
        }
      }
    }
  }
});

test('相手タブ: 1 体・武器 1 本なら、前の回で守りを満たした組の K 番目の値を floor として後の回に渡す (多頭・武器 2 本は渡さない)', async () => {
  const { createSearch: cs, optimizeWeaponSide } = await import('../app/model/search.js');
  const { createPlanRunner } = await import('../app/model/recommend.js');
  const { jobs, data, index } = await makePlanCases(raw, { budget: { work: 3000 } });
  const runJob = (job) => {
    const runner = createPlanRunner(job, data, { createSearch: cs, optimizeWeaponSide });
    let n = 0;
    while (!runner.step(1e9)) if (++n > 1e5) throw new Error('終わらない');
    return runner.result();
  };
  const job = jobs.S5z;
  assert.equal(job.merge.mode, 'single');
  const r = runJob(job);
  const [first, second] = r.stats.runs;
  assert.equal(first.floor, null, '最初の回には無い');
  // 1 回目の結果 (守りを満たすもの) の K 番目
  const s1 = createSearch(job.runs[0].input, data);
  while (!s1.step(1e9));
  const vals = s1.result().results.filter((x) => defenseCheck(x.build, job.requirements, index, data.skillEffects).ok).map((x) => x.value)
    .sort((a, b) => b - a);
  assert.ok(vals.length >= job.K);
  assert.ok(near(second.floor, vals[job.K - 1]), `${second.floor} / ${vals[job.K - 1]}`);
  // 合わせた上位は守りを満たし、floor より上
  assert.ok(r.results.every((x) => x.defense.ok));
  assert.ok(r.results.slice(0, job.K).every((x) => x.score.value >= second.floor - 1e-9));
  // 多頭 (S3z) は渡さない
  const m = runJob(jobs.S3z);
  assert.ok(m.stats.runs.every((x) => x.floor == null));
});
