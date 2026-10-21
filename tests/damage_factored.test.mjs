// damage.js の因子分解の合計 (docs/SEARCH_DESIGN.md 4 章の 2): 条件の組み合わせ (パターン) が MAX_PATTERNS を超えたとき、
// comboExpected は同時に起きない条件の塊ごとに畳み込んで合計を返す。値が「全パターンの加重平均」と同じことを、
// 上限の手前の構成で両方の道を走らせて確かめる (comboExpected の maxPatterns: 0 で因子分解の道を強制する)。
// 乱数の種は固定。node --test tests/*.test.mjs で回す。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  comboExpected, enumeratePatterns, factorPatterns, resolveSkills, resolveConditions, skillContribution, MAX_PATTERNS,
} from '../app/model/damage.js';
import { mixExpected } from '../app/ui/tabs/power_calc.js';
import { loadRepoData, makeCases } from './search_cases.mjs';

const raw = await loadRepoData();
const { targetOf } = makeCases(raw);
const EFFECTS = raw.skillEffects;
const MOTIONS = raw.motions;
const COMBOS = raw.combos.combos;

let seed = 4242;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const shuffle = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

const relOf = (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(b));
/** 2 つの comboExpected の結果が同じ (合計 4 つ・条件・警告 (many-patterns を除く)) */
function assertSame(fac, ref, what) {
  for (const k of ['total', 'physical', 'element', 'extra']) {
    assert.ok(relOf(fac[k], ref[k]) <= 1e-9, `${what}: ${k} ${fac[k]} / ${ref[k]}`);
  }
  assert.deepEqual(fac.conditions, ref.conditions, `${what}: 条件`);
  assert.deepEqual(fac.warnings.filter((w) => w.code !== 'many-patterns'), ref.warnings, `${what}: 警告`);
  assert.equal(fac.factored, true);
  assert.equal(ref.factored, false);
  assert.equal(fac.patterns, ref.patterns, `${what}: パターンの数`);
}

test('factorPatterns: 塊ごとに数えた数と警告 (並びも) が enumeratePatterns と同じ', () => {
  const src = EFFECTS.rules.conditionGroups;
  const condSkills = Object.entries(EFFECTS.effects).filter(([, e]) => e.conditional && e.supported !== false)
    .map(([id]) => ({ skillId: Number(id), level: 1 }));
  for (let i = 0; i < 200; i++) {
    const skills = shuffle(condSkills).slice(0, 2 + Math.floor(rnd() * 9));
    const uptimes = {};
    for (const g of src) {
      if (rnd() < 0.5) continue;
      uptimes[g.id] = g.type === 'categorical'
        ? Object.fromEntries(g.states.filter((s) => (s.id ?? s) !== g.offState).map((s) => [s.id ?? s, rnd() * 0.7]))
        : pick([0, 1, rnd(), 0.6, 0.7]);
    }
    const res = resolveConditions(resolveSkills(skills, EFFECTS).active, src, uptimes,
      { skillIds: skills.map((s) => s.skillId), monsterStatus: pick([undefined, [], ['frenzy']]) });
    const full = enumeratePatterns(res.groups);
    const fp = factorPatterns(res.groups);
    assert.equal(fp.count, full.patterns.length, `数 (${i})`);
    assert.deepEqual(fp.warnings, full.warnings, `警告 (${i})`);
    // 塊の重みの積の和は 1
    const sums = fp.blocks.map((b) => b.patterns.reduce((t, p) => t + p.weight, 0));
    for (const s of sums) assert.ok(Math.abs(s - 1) < 1e-9);
  }
});

test('上限の手前の構成: 因子分解の合計 = 全パターンの加重平均 (本物のデータ・ランダム 300 組・相対 1e-9)', () => {
  const ids = Object.keys(EFFECTS.effects).map(Number).filter((id) => EFFECTS.effects[id].supported !== false);
  const condIds = ids.filter((id) => EFFECTS.effects[id].conditional);
  const weapons = [
    { attack: 200, affinity: 10, element: { type: 'fire', value: 400 } },
    { attack: 220, affinity: -25, element: null },
    { attack: 180, affinity: 5, element: { type: 'poison', value: 300 } },
    { attack: 175, affinity: 0, element: { type: 'thunder', value: 520 } },
  ];
  const targets = [
    targetOf('アルシュベルド', 'head'), targetOf('アルシュベルド', 'head', true), targetOf('ゴア・マガラ', 'head'),
    targetOf('アルシュベルド', 'left-wing'),
  ];
  const uptimeSets = [
    {}, { hpFull: 0.7, redHp: 0.6, hpLow: 0.5, enraged: 0.3, chain: { hit1to4: 0.2, hit5plus: 0.7 } },
    { enraged: 1, afterDodge: 0, frenzy: { infected: 0.4, overcome: 0.5 } },
  ];
  // 攻撃・属性の上限に当たる組 (上限に当たりうるときは、その値をまとめずに持つ道を通る)
  const buffSets = [{}, { attackAdd: 380, elementMul: 2.2 }, { attackMul: 3.9, elementAdd: 390, affinityAdd: 40 }];
  let n = 0; let worst = 0; let capped = 0;
  for (let i = 0; i < 300; i++) {
    const skills = [];
    const k = 2 + Math.floor(rnd() * 10);
    for (let j = 0; j < k; j++) {
      const id = j < 4 ? pick(condIds) : pick(ids);
      if (skills.some((s) => s.skillId === id)) continue;
      skills.push({ skillId: id, level: 1 + Math.floor(rnd() * EFFECTS.effects[id].levels.length) });
    }
    const buffs = pick(buffSets);
    if (buffs.attackAdd || buffs.attackMul) capped++;
    const inp = {
      weapon: pick(weapons), sharpness: pick(['white', 'blue', 'purple', 'green']), skills, effects: EFFECTS, motions: MOTIONS,
      combo: pick(COMBOS), target: pick(targets), uptimes: pick(uptimeSets), buffs, monsterStatus: pick([undefined, [], ['frenzy']]),
    };
    const ref = comboExpected(inp);
    if (ref.factored) continue;
    const fac = comboExpected({ ...inp, maxPatterns: 0 });
    assertSame(fac, ref, `組 ${i}`);
    worst = Math.max(worst, relOf(fac.total, ref.total));
    n++;
  }
  assert.ok(n >= 250, `比べた数 ${n}`);
  assert.ok(capped > 30);
  console.log(`  比べた ${n} 件・最大の相対差 ${worst.toExponential(2)}`);
});

// ---- 並びで決まる効果 (心眼・弱点特効のしきい値・鈍器使い) や会心倍率・飛燕・追加ダメージを、条件つきスキルに持たせた作り物
const SYN_GROUPS = [
  { id: 'gA', label: 'A', type: 'binary', defaultUptime: 0.5, placeholder: true, exclusiveWith: ['gB'] },
  { id: 'gB', label: 'B', type: 'binary', defaultUptime: 0.4 },
  { id: 'gC', label: 'C', type: 'categorical', states: [{ id: 'off', label: 'off' }, { id: 'a', label: 'a' }, { id: 'b', label: 'b' }],
    offState: 'off', defaultUptime: { a: 0.3, b: 0.5 } },
  { id: 'gD', label: 'D', type: 'binary', defaultUptime: 0.6 },
  { id: 'gE', label: 'E', type: 'binary', defaultUptime: 0.25, exclusiveWith: ['gA'] },
];
const lv = (o) => [{ level: 1, ...o }, { level: 2, ...o, attackAdd: (o.attackAdd || 0) + 5 }];
const SYN = {
  rules: { conditionGroups: SYN_GROUPS },
  effects: {
    201: { name: '甲', conditional: true, conditionGroup: 'gA', levels: lv({ attackAdd: 10, hardPartMul: 1.15, hardPartMaxHitzone: 44 }) },
    202: { name: '乙', conditional: true, conditionGroup: 'gB', levels: lv({ hardPartMul: 1.15, hardPartMaxHitzone: 30, weakPointMinHitzone: 40 }) },
    203: { name: '丙', conditional: false, levels: lv({ weakPointMinHitzone: 50, critMul: 1.3, lowSharpnessMul: 1.1, lowSharpnessMaxColor: 'white' }) },
    204: {
      name: '丁', conditional: true, conditionGroup: 'gC', activeStates: ['a'],
      levels: [{ level: 1, affinityAdd: 20, critElementMul: 1.1, jumpMul: 1.2,
        extraDamage: { chance: 0.3, fixed: 5, element: 100, elementType: 'fire', appliesTo: 'additionalDamageHits' },
        byState: { b: { lowSharpnessMul: 1.1, lowSharpnessMaxColor: 'blue', attackMul: 1.5, critMul: 1.35 } } }],
    },
    205: { name: '戊', conditional: true, conditionGroup: 'gD', levels: lv({ attackMul: 1.6, elementAdd: 150, affinityAdd: -10, hardPartMul: 1.15, hardPartMaxHitzone: 41 }) },
    206: { name: '己', conditional: false, levels: lv({ weakPointAffinity: 15, woundAffinity: 10, hardPartMul: 1.1, hardPartMaxHitzone: 50 }) },
    207: { name: '庚', conditional: true, conditionGroup: 'gE', levels: lv({ weakPointMinHitzone: 35, lowSharpnessMul: 1.2, lowSharpnessMaxColor: 'green', critElementMul: 1.2 }) },
    208: { name: '辛', conditional: true, conditionGroup: 'gD', levels: lv({ extraDamage: { chance: 0.5, fixed: 3, element: 40, elementType: 'water' }, jumpMul: 1.1 }) },
  },
};
const SYN_MOTIONS = {
  moves: [
    { id: 'a', name: 'A', hits: [
      { mv: 30, count: 2, type: 'slash', elementRate: 1, canCrit: true, sharpnessMul: true },
      { mv: 20, type: 'blunt', usesElement: false, elementRate: 0, canCrit: false, sharpnessMul: false, hien: true },
      { mv: 12, type: 'slash', elementRate: 0.5, additionalDamage: true, fixed: 4 }] },
    { id: 'b', name: 'B', hits: [
      { mv: 25, type: 'slash', elementRate: 0.8 },
      { mv: 15, type: 'slash', elementRate: 1, label: '傷口の追加ヒット', woundOnly: true }] },
  ],
};

test('並びで決まる効果・会心倍率・飛燕・追加ダメージ・上限を条件つきにした作り物: 因子分解の合計 = 全パターン', () => {
  const ids = Object.keys(SYN.effects).map(Number);
  const hitzones = [
    { slash: 50, blunt: 40, fire: 20, water: 15 }, { slash: 30, blunt: 44, fire: 30, water: 5 }, { slash: 45, blunt: 50, fire: 0, water: 25 },
  ];
  let n = 0;
  for (let i = 0; i < 250; i++) {
    // スキルの並び (= 効果を足す順) を毎回変える (心眼・しきい値・鈍器使いは順で勝ち負けが決まる)
    const skills = shuffle(ids).slice(0, 2 + Math.floor(rnd() * 7)).map((id) => ({ skillId: id, level: 1 + Math.floor(rnd() * 2) }));
    const uptimes = {};
    if (rnd() < 0.5) uptimes.gA = pick([0.2, 0.7, 0.9]);
    if (rnd() < 0.5) uptimes.gB = pick([0.1, 0.5, 0.8]);
    if (rnd() < 0.5) uptimes.gC = { a: rnd() * 0.5, b: rnd() * 0.5 };
    if (rnd() < 0.3) uptimes.gE = 0.6;
    const inp = {
      weapon: pick([{ attack: 200, affinity: 30, element: { type: 'fire', value: 300 } }, { attack: 150, affinity: -40, element: { type: 'water', value: 200 } },
        { attack: 0, affinity: 0, element: { type: 'fire', value: 100 } }]),
      sharpness: pick(['green', 'blue', 'white', 'purple']), skills, effects: SYN, motions: SYN_MOTIONS,
      combo: pick([['a', 'b'], [{ move: 'a', onWound: true }, 'b', { move: 'b', onWound: true }]]),
      target: { hitzone: pick(hitzones), wound: rnd() < 0.7 ? { slash: 70, blunt: 70, fire: 30, water: 20 } : null, isWound: rnd() < 0.3 },
      uptimes, buffs: pick([{}, { attackMul: 2.6 }, { attackAdd: 395, elementMul: 1.9, elementAdd: 300 }, { elementAdd: -500 }]),
    };
    const ref = comboExpected(inp);
    const fac = comboExpected({ ...inp, maxPatterns: 0 });
    assertSame(fac, ref, `作り物 ${i} ${JSON.stringify(skills)}`);
    n++;
  }
  assert.equal(n, 250);
});

/** 2 択の条件 15 個 (2^15 > MAX_PATTERNS) を全部 50% で積んだ組 */
function overLimitInput() {
  const groups = new Map();
  for (const [id, e] of Object.entries(EFFECTS.effects)) {
    if (!e.conditional || e.supported === false) continue;
    const def = EFFECTS.rules.conditionGroups.find((g) => g.id === e.conditionGroup);
    if (!def || def.type === 'categorical' || def.sources || (def.exclusiveWith || []).length) continue;
    if (!groups.has(def.id)) groups.set(def.id, Number(id));
  }
  const list = [...groups.entries()].slice(0, 15);
  assert.equal(list.length, 15);
  return {
    weapon: { attack: 200, affinity: 10, element: { type: 'fire', value: 400 } }, sharpness: 'white',
    skills: list.map(([, id]) => ({ skillId: id, level: 1 })), effects: EFFECTS, motions: MOTIONS, combo: COMBOS[0],
    target: targetOf('アルシュベルド', 'head'), uptimes: Object.fromEntries(list.map(([g]) => [g, 0.5])), monsterStatus: [],
  };
}

test('上限を超える組: 例外にせず合計を返す (技ごとの内訳なし・警告 many-patterns)。条件を 1 つ 0% にした値と順が合う', () => {
  const inp = overLimitInput();
  const r = comboExpected(inp);
  assert.equal(r.factored, true);
  assert.ok(r.patterns > MAX_PATTERNS);
  assert.deepEqual(r.steps, []);
  const w = r.warnings.find((x) => x.code === 'many-patterns');
  assert.ok(w && w.count === r.patterns && /技ごとの内訳/.test(w.message));
  assert.ok(Number.isFinite(r.total) && r.total > 0);
  assert.ok(Math.abs(r.physical + r.element + r.extra - r.total) <= 1e-9 * r.total);
  // 1 つの条件を 0% にすると全パターンを並べられる (2^14)。その値は因子分解の道でも同じ
  const first = Object.keys(inp.uptimes)[0];
  const inp14 = { ...inp, uptimes: { ...inp.uptimes, [first]: 0 } };
  const r14 = comboExpected(inp14);
  assert.equal(r14.factored, false);
  assertSame(comboExpected({ ...inp14, maxPatterns: 0 }), r14, '2^14');
  // スキルの寄与 (火力タブ) も計算できる
  const c = skillContribution(inp);
  assert.ok(c.total === r.total && c.removeEach.length === inp.skills.length);
});

test('火力タブ: 上限を超える組でも期待値と警告が出る (技ごとの内訳は空)', () => {
  const inp = overLimitInput();
  const { target, ...rest } = inp;
  const m = mixExpected(rest, [{ weight: 0.6, label: '頭', target }, { weight: 0.4, label: '左翼', target: targetOf('アルシュベルド', 'left-wing') }]);
  assert.ok(m.total > 0);
  assert.deepEqual(m.steps, []);
  assert.equal(m.warnings.filter((w) => w.code === 'many-patterns').length, 1, '部位ごとに同じ警告を 2 回出さない');
});
