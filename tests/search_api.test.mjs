// 装備探索の API (docs/SEARCH_DESIGN.md 3 章・6.4 節): 決定的・中止・途中の結果・計算し直し・alternatives・単調性・
// 続けて探す・入力の注意。node --test tests/*.test.mjs で回す。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSearch, PHASES } from '../app/model/search.js';
import { prepare } from '../app/model/search/problem.js';
import { computeBuild, indexEquipData, ARMOR_PARTS } from '../app/model/build.js';
import { comboExpected } from '../app/model/damage.js';
import { resolveWeaponRef, damageWeapon, autoSharpness, handicraftSkillId } from '../app/model/weapon.js';
import { loadRepoData, makeCases, searchDataOf } from './search_cases.mjs';

const raw = await loadRepoData();
const { cases, artian, skillId, targetOf } = makeCases(raw);
const data = searchDataOf(raw);
// 速く回すために、ビームを狭く・仕事量の予算で切る (結果が端末の速さで変わらない)。
// 発動率は仮置きを 0% にした画面の既定 (B1z。条件の組み合わせが少なく、計算し直しも速い)
const LIGHT = { beam: [10, 30], budget: { work: 2000 } };
const B1 = cases.B1z;
const idx = indexEquipData({ ...data, myWeapons: [...data.myWeapons.weapons, artian] });

function run(input, stepMs = 1e9) {
  const s = createSearch(input, data);
  let steps = 0;
  while (!s.step(stepMs)) if (++steps > 1e6) throw new Error('終わらない');
  return { s, r: s.result(), steps };
}

/** computeBuild + comboExpected で計算し直す (探索のコードを使わない) */
function recompute(build, input) {
  const r = computeBuild(build, idx);
  const w = resolveWeaponRef(build.weapon, idx);
  const hid = handicraftSkillId(idx);
  const sharpness = autoSharpness(w, idx, r.skillLevels).color;
  const skills = r.skills.filter((s) => s.level > 0).map((s) => ({ skillId: s.skillId, level: s.level }));
  let v = 0;
  for (const t of input.targets) {
    v += t.weight * comboExpected({ weapon: damageWeapon(w), sharpness, skills, uptimes: input.uptimes, effects: data.skillEffects,
      motions: data.motions, combo: input.combo, target: t.target, monsterStatus: input.monsterStatus }).total;
  }
  assert.ok(hid != null);
  return { v, r };
}

const sig = (r) => JSON.stringify(r.results.map((x) => [x.value.toFixed(9), x.build]));

test('step を小さく刻んでも一度に回しても、仕事量の予算なら結果が同じ (決定的)', () => {
  const a = run({ ...B1, ...LIGHT });
  const b = run({ ...B1, ...LIGHT }, 3);
  assert.ok(b.steps > a.steps * 5, `刻んだ回数 ${b.steps}`);
  assert.equal(a.r.status, 'stopped');
  assert.equal(sig(a.r), sig(b.r));
  assert.equal(a.r.results.length, 10);
});

test('途中の結果 (partial) が done より前に出て、段階は PHASES の順', () => {
  // B&B の続きが何区切りもかかるように、仕事量の予算を大きめにして細かく刻む (速い端末でも partial と done が同じ区切りにならない)
  const s = createSearch({ ...B1, ...LIGHT, budget: { work: 30000 } }, data);
  const seen = [];
  let partialAt = -1; let i = 0; let partial = null;
  while (!s.step(2)) {
    i++;
    const p = s.progress();
    if (!seen.includes(p.phase)) seen.push(p.phase);
    if (p.partialReady && partialAt < 0) { partialAt = i; partial = s.result(); }
  }
  assert.ok(partialAt > 0 && partialAt < i, `partial ${partialAt} / done ${i}`);
  assert.equal(partial.status, 'partial');
  assert.ok(partial.results.length > 0 && partial.results.every((x) => x.exact));
  const order = seen.map((p) => PHASES.indexOf(p));
  assert.ok(order.every((x, k) => x >= 0 && (k === 0 || x > order[k - 1])), `段階の並び ${seen}`);
  const done = s.result();
  assert.ok(done.results[0].value >= partial.results[0].value - 1e-9);
  assert.equal(s.progress().phase, 'done');
});

test('cancel の後の step で止まり、status: cancelled と、それまでの上位が返る', () => {
  const s = createSearch({ ...B1, ...LIGHT, budget: { work: 1e9 } }, data);
  while (!s.progress().partialReady) assert.equal(s.step(20), false);
  s.step(20);
  s.cancel();
  assert.equal(s.step(20), true);
  const r = s.result();
  assert.equal(r.status, 'cancelled');
  assert.ok(r.results.length > 0);
  assert.equal(s.extend({ ms: 100 }), false);
});

test('返した build は computeBuild にそのまま渡せて、計算し直しが合う。alternatives に入れ替えても値が同じ', () => {
  const B5 = cases.B5z;
  // 同じ類のほかの防具 (alternatives) は上位 10 件にはあまり出ないので、30 件で見る
  const { r } = run({ ...B5, ...LIGHT, K: 30 });
  let swapped = 0;
  for (const x of r.results) {
    assert.ok(x.check.relDiff <= 1e-9);
    const { v, r: cb } = recompute(x.build, B5);
    assert.equal(cb.errors.length, 0);
    assert.ok(Math.abs(v - x.value) <= 1e-9 * v, `${v} / ${x.value}`);
    assert.deepEqual(x.skills.map((s) => s.skillId).sort(), cb.skills.filter((s) => s.level > 0).map((s) => s.skillId).sort());
    for (const part of [...ARMOR_PARTS, 'charm']) {
      const alt = x.alternatives[part];
      if (!alt || !alt.length) continue;
      const b2 = part === 'charm' ? { ...x.build, charm: alt[0] } : { ...x.build, armor: { ...x.build.armor, [part]: alt[0] } };
      const y = recompute(b2, B5);
      assert.equal(y.r.errors.length, 0, `${part} を ${alt[0]} に`);
      assert.ok(Math.abs(y.v - x.value) <= 1e-9 * x.value, `${part} を ${alt[0]} に: ${y.v} / ${x.value}`);
      swapped++;
    }
  }
  assert.ok(swapped > 0, '入れ替えを試した');
  // 泣シミュ型 (B4): 類が大きい。入れ替えても必須を満たし、エラーが無い
  const { r: n4 } = run(cases.B4);
  assert.equal(n4.results.length, 10);
  let swapped4 = 0;
  for (const x of n4.results) {
    for (const part of ARMOR_PARTS) {
      for (const id of x.alternatives[part].slice(0, 3)) {
        const cb = computeBuild({ ...x.build, armor: { ...x.build.armor, [part]: id } }, idx);
        assert.equal(cb.errors.length, 0);
        for (const q of cases.B4.required) assert.ok((cb.skillLevels[q.skillId] || 0) >= q.level);
        swapped4++;
      }
    }
  }
  assert.ok(swapped4 > 0);
});

test('期待値の単調性: Lv を 1 つ上げて下がらない (ランダム 1,000 組。優越の除去の前提)', () => {
  const opts = (c) => ({
    weapons: c.weapons, targets: c.targets, combo: c.combo, uptimes: c.uptimes, monsterStatus: c.monsterStatus, buffs: {},
    required: [], limitBreak: c.limitBreak, sharpness: null, charmRefs: [], objective: 'damage', K: 10,
  });
  const P = prepare({ idx, effects: data.skillEffects, motions: data.motions }, opts(cases.B1));
  let seed = 99;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let checked = 0; let viol = 0; let exact = 0;
  const ev = P.weapons[0].ev;
  for (let t = 0; t < 1000; t++) {
    const L = new Int8Array(P.R);
    for (let r = 0; r < P.R; r++) if (rnd() < 0.35) L[r] = Math.floor(rnd() * (P.maxLv[r] + 1));
    const r = Math.floor(rnd() * P.R);
    if (L[r] >= P.maxLv[r]) continue;
    const a = ev.evaluate(L);
    const L2 = L.slice(); L2[r]++;
    const b = ev.evaluate(L2);
    checked++;
    if (b < a - 1e-9 * a) viol++;
    // 100 組は comboExpected でも確かめる (評価器を通さない)
    if (exact < 100) {
      const toList = (x) => [...x].map((lv, k) => ({ skillId: P.ids[k], level: lv })).filter((s) => s.level > 0);
      const w = P.weapons[0];
      const val = (x) => {
        try {
          const hc = P.hid != null && P.rOf.has(P.hid) ? x[P.rOf.get(P.hid)] : 0;
          return comboExpected({ weapon: w.dmg, sharpness: w.sharpFn(hc), skills: toList(x), uptimes: {}, effects: data.skillEffects,
            motions: data.motions, combo: cases.B1.combo, target: cases.B1.targets[0].target, monsterStatus: [] }).total;
        } catch (e) { return null; }
      };
      const x0 = val(L); const x1 = val(L2);
      if (x0 != null && x1 != null) { exact++; assert.ok(x1 >= x0 - 1e-9 * x0, `comboExpected で下がった: ${P.ids[r]}`); }
    }
  }
  assert.ok(checked >= 900, `確かめた数 ${checked}`);
  assert.equal(viol, 0, `下がった組 ${viol}`);
  assert.ok(exact >= 50);
});

test('stopAfter: partial は仕上げ 1 で止まる。extend で B&B の続きを始められる', () => {
  const s = createSearch({ ...B1, ...LIGHT, stopAfter: 'partial' }, data);
  while (!s.step(1e9));
  const r = s.result();
  assert.equal(r.status, 'partial');
  assert.ok(!r.stats.phases.some((p) => p.name === 'dfs'));
  assert.equal(s.extend({ work: 500 }), true);
  while (!s.step(1e9));
  const r2 = s.result();
  assert.equal(r2.status, 'stopped');
  assert.ok(r2.stats.phases.some((p) => p.name === 'dfs'));
  assert.ok(r2.results[0].value >= r.results[0].value - 1e-9);
  // もう一度続ける (前の続きから)
  const calls = r2.stats.boundCalls;
  assert.equal(s.extend({ work: 500 }), true);
  while (!s.step(7));
  const r3 = s.result();
  assert.ok(r3.stats.boundCalls > calls);
  assert.ok(r3.results[0].value >= r2.results[0].value - 1e-9);
});

test('相手のまとまり (targets[].group) ごとの値 perGroup と、いまの装備の値 baseline', () => {
  const targets = [
    { weight: 0.3, group: 'a', target: targetOf('アルシュベルド', 'head') },
    { weight: 0.3, group: 'a', target: targetOf('アルシュベルド', 'left-wing') },
    { weight: 0.4, group: 'b', target: targetOf('ゴア・マガラ', 'head') },
  ];
  const { r } = run({ ...B1, ...LIGHT, targets, budget: { work: 500 } });
  const x = r.results[0];
  assert.deepEqual(Object.keys(x.perGroup).sort(), ['a', 'b']);
  assert.ok(Math.abs(0.6 * x.perGroup.a + 0.4 * x.perGroup.b - x.value) <= 1e-9 * x.value);
  const { r: r2 } = run({ ...B1, ...LIGHT, budget: { work: 0 }, current: x.build, targets });
  assert.ok(Math.abs(r2.baseline.value - x.value) <= 1e-9 * x.value);
});

test('使わない防具・生産護石・珠を持っていない: 結果に出ない', () => {
  const base = run({ ...B1, ...LIGHT, budget: { work: 0 } }).r;
  const top = base.results[0];
  const headIds = [top.build.armor.head, ...top.alternatives.head];
  const charm = top.build.charm;
  const { r } = run({ ...B1, ...LIGHT, budget: { work: 0 }, armorExclude: headIds,
    charms: { owned: true, fixed: true, fixedExclude: typeof charm === 'number' ? [charm] : [] } });
  for (const x of r.results) {
    assert.ok(!headIds.includes(x.build.armor.head));
    for (const a of x.alternatives.head) assert.ok(!headIds.includes(a));
    if (typeof charm === 'number') assert.notEqual(x.build.charm, charm);
  }
  const { r: noDeco } = run({ ...B1, ...LIGHT, budget: { work: 0 }, decorations: { owned: {} } });
  for (const x of noDeco.results) {
    for (const list of Object.values(x.build.decorations)) assert.ok(list.every((d) => d == null));
  }
  assert.ok(noDeco.results[0].value < top.value);
});

test('入力の注意: 知らない必須は外して続ける・仮置きの発動率・満たせない必須は infeasible と足りないスキル', () => {
  const { r } = run({ ...cases.B1, ...LIGHT, budget: { work: 0 }, K: 3, required: [{ skillId: 999999, level: 1 }] });
  assert.ok(r.warnings.some((w) => w.code === 'unknown-skill'));
  assert.ok(r.warnings.some((w) => w.code === 'placeholder-uptimes'));
  assert.ok(r.results.length > 0);
  // 仮置きの条件を全部 0% にすると、仮置きの注意は出ない
  const zero = Object.fromEntries(data.skillEffects.rules.conditionGroups.filter((g) => g.placeholder)
    .map((g) => [g.id, g.type === 'categorical' ? {} : 0]));
  const { r: z } = run({ ...cases.B1, ...LIGHT, budget: { work: 0 }, K: 3, uptimes: zero });
  assert.ok(!z.warnings.some((w) => w.code === 'placeholder-uptimes'));
  assert.ok(z.stats.relevantSkills < r.stats.relevantSkills, '発動率 0% の条件スキルは関係しない');
  // 満たせない必須 (B4x): すぐ「無い」
  const t0 = performance.now();
  const { r: x } = run(cases.B4x);
  assert.equal(x.status, 'infeasible');
  assert.ok(performance.now() - t0 < 1000);
  const names = x.infeasible.missing.map((m) => m.skillId).sort();
  assert.deepEqual(names, [skillId('見切り'), skillId('超会心')].sort());
  // 武器・相手が無いと例外
  assert.throws(() => createSearch({ ...cases.B1, weapons: [] }, data), /武器/);
  assert.throws(() => createSearch({ ...cases.B1, targets: [] }, data), /相手/);
});
