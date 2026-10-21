// 探索の速い評価器 (app/model/search/evaluator.js) が comboExpected (部位の割合で加重平均) と同じ値になるか
// (docs/SEARCH_DESIGN.md 6.1 節)。乱数の種は固定。node --test tests/*.test.mjs で回す。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEvaluator } from '../app/model/search/evaluator.js';
import { comboExpected, MAX_PATTERNS } from '../app/model/damage.js';
import { indexEquipData } from '../app/model/build.js';
import { resolveWeaponRef, damageWeapon, sharpnessResolver, handicraftSkillId } from '../app/model/weapon.js';
import { loadRepoData, makeCases } from './search_cases.mjs';

const raw = await loadRepoData();
const { artian, targetOf } = makeCases(raw);
const effects = raw.skillEffects;
const motions = raw.motions;
const combos = raw.combos.combos;
const idx = indexEquipData({
  skills: raw.skills, decorations: raw.decorations, bonuses: raw.bonuses, armor: raw.armor, weapons: raw.weapons,
  myWeapons: [...raw.myWeapons.weapons, artian], charms: raw.charms, charmsFixed: raw.charmsFixed,
});
const HC = handicraftSkillId(idx);
const ids = [...Object.keys(effects.effects).map(Number), HC];
const maxLvOf = (id) => idx.skills.get(id)?.maxLevel ?? 5;
const skillId = (name) => [...idx.skills.values()].find((s) => s.name === name).id;

let seed = 20261021;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

// 武器: 属性あり・無属性・状態異常・マイナス会心・巨戟アーティア (所持武器)・ゴグマの元の武器
const weaponRefs = ['w-test', 1182, 985, 996, 1006, 1059, ...raw.weapons.weapons.filter((w) => w.element && w.element.type === 'ice').map((w) => w.id).slice(0, 1)];
// 傷口の無い部位 (wound が null) を 1 つ探す
const noWoundPart = (() => {
  for (const m of raw.monsters.monsters) for (const p of m.parts) if (!p.wound && p.hitzone) return { m: m.name, k: p.key };
  return null;
})();
const targetSets = [
  [{ weight: 1, target: targetOf('アルシュベルド', 'head') }],
  [{ weight: 0.6, target: targetOf('アルシュベルド', 'head') }, { weight: 0.4, target: targetOf('アルシュベルド', 'left-wing') }],
  [{ weight: 1, target: targetOf('ゴア・マガラ', 'head', true) }],
  [{ weight: 0.5, target: targetOf('ゴア・マガラ', 'head') }, { weight: 0.3, target: targetOf('アルシュベルド', 'torso') },
    ...(noWoundPart ? [{ weight: 0.2, target: targetOf(noWoundPart.m, noWoundPart.k, true) }] : [])],
];
const uptimeSets = [
  {},
  { enraged: 0.7, chain: { hit1to4: 0.2, hit5plus: 0.7 }, hpFull: 0.3, redHp: 0.4 },
  // 同時に起きない条件の合計が 100% 超え (後の方を減らす)
  { hpFull: 0.7, redHp: 0.6, hpLow: 0.5, frenzy: { infected: 0.3, overcome: 0.6 } },
  // 平らなキーの段と、0% の条件
  { 'chain.hit1to4': 0.1, 'chain.hit5plus': 0.85, latentPower: 0, afterDodge: 1 },
];
const statusSets = [[], ['frenzy'], undefined];
const buffSets = [
  {},
  // 攻撃・属性の上限に当たる組 (遅い道)
  { attackAdd: 390, elementMul: 2.2, affinityAdd: 30 },
  { attackMul: 1.1, elementAdd: 395 },
];

/** 部位の割合で加重平均した comboExpected (factored = MAX_PATTERNS を超えて因子分解の合計で出したか) */
function referenceInfo(c, list) {
  let v = 0;
  let factored = false;
  for (const t of c.targets) {
    const r = comboExpected({
      weapon: c.weapon, sharpness: c.sharpOf(list), skills: list, effects, motions, combo: c.combo, target: t.target,
      uptimes: c.uptimes, monsterStatus: c.monsterStatus, buffs: c.buffs,
    });
    v += t.weight * r.total;
    if (r.factored) factored = true;
  }
  return { v, factored };
}
const reference = (c, list) => referenceInfo(c, list).v;

function randomCase(i) {
  const ref = weaponRefs[i % weaponRefs.length];
  const w = resolveWeaponRef(ref, idx);
  const fixed = rnd() < 0.3 ? pick(['white', 'blue', 'purple', 'green']) : null;
  const resolver = sharpnessResolver(w, idx, fixed);
  const sharpOf = (list) => (resolver ? resolver(list).sharpness : fixed);
  return {
    ref, weapon: damageWeapon(w), sharpOf, fixed,
    // 評価器には「匠の Lv → 色」を渡す
    sharpness: fixed || ((lv) => resolver([{ skillId: HC, level: lv }]).sharpness),
    combo: combos[i % combos.length], targets: targetSets[Math.floor(rnd() * targetSets.length)],
    uptimes: pick(uptimeSets), monsterStatus: pick(statusSets), buffs: rnd() < 0.25 ? pick(buffSets) : {},
  };
}

function evaluatorOf(c, extra = {}) {
  return makeEvaluator({
    effects, motions, combo: c.combo, targets: c.targets, weapon: c.weapon, uptimes: c.uptimes,
    monsterStatus: c.monsterStatus, buffs: c.buffs, relevantIds: ids, sharpness: c.sharpness,
    handicraftIndex: ids.indexOf(HC), ...extra,
  });
}

function randomLevels(maxSkills) {
  const lv = new Int8Array(ids.length);
  const k = 1 + Math.floor(rnd() * maxSkills);
  for (let n = 0; n < k; n++) {
    const r = Math.floor(rnd() * ids.length);
    lv[r] = 1 + Math.floor(rnd() * maxLvOf(ids[r]));
  }
  return lv;
}
// 条件つきスキルを多めに積む組 (パターンが多い・MAX_PATTERNS に近い組も通す)
const condR = ids.map((id, r) => (effects.effects[String(id)]?.conditional ? r : -1)).filter((r) => r >= 0);
function heavyLevels() {
  const lv = randomLevels(6);
  const k = 6 + Math.floor(rnd() * 12);
  for (let n = 0; n < k; n++) {
    const r = condR[Math.floor(rnd() * condR.length)];
    lv[r] = 1 + Math.floor(rnd() * maxLvOf(ids[r]));
  }
  return lv;
}
const toList = (lv) => {
  const list = [];
  ids.forEach((id, r) => { if (lv[r] > 0) list.push({ skillId: id, level: lv[r] }); });
  return list;
};

test('評価器 = comboExpected (ランダムなスキルの組 1,000 件以上・相対 1e-9)', () => {
  let compared = 0; let worst = 0; let overMax = 0; let slow = 0;
  const seen = { combos: new Set(), weapons: new Set(), targets: new Set() };
  for (let i = 0; i < 110; i++) {
    const c = randomCase(i);
    const ev = evaluatorOf(c);
    seen.combos.add(c.combo.id); seen.weapons.add(c.ref); seen.targets.add(targetSets.indexOf(c.targets));
    for (let t = 0; t < 10; t++) {
      const lv = t < 7 ? randomLevels(12) : heavyLevels();
      const list = toList(lv);
      const got = ev.evaluate(lv);
      // MAX_PATTERNS を超える組は、comboExpected が因子分解の合計で出す (docs/SEARCH_DESIGN.md 4 章の 2)。それとも比べる
      const { v: want, factored } = referenceInfo(c, list);
      if (factored) overMax++;
      const rel = Math.abs(got - want) / Math.max(1, Math.abs(want));
      worst = Math.max(worst, rel);
      assert.ok(rel <= 1e-9, `ずれ ${rel} (${got} / ${want}) 武器 ${c.ref} コンボ ${c.combo.id} ${JSON.stringify(list)}`
        + ` 発動率 ${JSON.stringify(c.uptimes)} 強化 ${JSON.stringify(c.buffs)} 斬れ味 ${c.fixed || '自動'}`);
      compared++;
    }
    slow += ev.slowEvals;
  }
  assert.ok(compared >= 1000, `比べた数 ${compared}`);
  assert.equal(seen.combos.size, combos.length, 'コンボを全部通る');
  assert.equal(seen.targets.size, targetSets.length, '相手の組を全部通る');
  assert.ok(slow > 0, '遅い道 (上限に当たる組) も通る');
  assert.ok(worst < 1e-9);
  console.log(`  比べた ${compared} 件・最大の相対差 ${worst.toExponential(2)}・うち MAX_PATTERNS 超え (因子分解の合計) ${overMax} 件・遅い道 ${slow} 回`);
});

test('速い道と遅い道 (全パターン) が同じ値', () => {
  for (let i = 0; i < 40; i++) {
    const c = randomCase(1000 + i);
    const fast = evaluatorOf(c);
    const slow = evaluatorOf(c, { forceSlow: true });
    for (let t = 0; t < 5; t++) {
      const lv = randomLevels(10);
      const a = fast.evaluate(lv);
      const b = slow.evaluate(lv);
      assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${a} / ${b} ${JSON.stringify(toList(lv))}`);
    }
  }
});

test('MAX_PATTERNS を超える組: comboExpected は因子分解の合計 (例外にしない)、評価器と同じ値', () => {
  // 条件つきスキルを 15 グループぶん積む (2^15 > MAX_PATTERNS)
  const condIds = ids.filter((id) => effects.effects[String(id)]?.conditional);
  const groups = new Map();
  for (const id of condIds) {
    const g = effects.effects[String(id)].conditionGroup;
    if (!groups.has(g)) groups.set(g, id);
  }
  // 2 択の条件だけを 15 グループ (2^15 = 32,768 > MAX_PATTERNS)
  const binary = [...groups.entries()].filter(([g]) => {
    const def = (effects.rules.conditionGroups || []).find((x) => x.id === g);
    return def && def.type !== 'categorical' && !def.sources;
  }).slice(0, 15);
  assert.equal(binary.length, 15);
  const lv = new Int8Array(ids.length);
  for (const [, id] of binary) lv[ids.indexOf(id)] = 1;
  // 既定が 0% / 100% の条件は段が 1 つになるので、全部 50% にする
  const c = { ...randomCase(7), uptimes: Object.fromEntries(binary.map(([g]) => [g, 0.5])), monsterStatus: ['frenzy'], buffs: {} };
  const list = toList(lv);
  // comboExpected は塊ごとに畳み込んだ合計を返す (技ごとの内訳は出さない・警告 many-patterns)
  const one = comboExpected({
    weapon: c.weapon, sharpness: c.sharpOf(list), skills: list, effects, motions, combo: c.combo, target: c.targets[0].target,
    uptimes: c.uptimes, monsterStatus: c.monsterStatus, buffs: c.buffs,
  });
  assert.equal(one.factored, true);
  assert.equal(one.steps.length, 0);
  assert.ok(one.patterns > MAX_PATTERNS);
  assert.ok(one.warnings.some((w) => w.code === 'many-patterns'));
  const ref = reference(c, list);
  const v = evaluatorOf(c).evaluate(lv);
  const vs = evaluatorOf(c, { forceSlow: true }).evaluate(lv);
  assert.ok(Number.isFinite(v) && v > 0);
  assert.ok(Math.abs(v - vs) <= 1e-9 * v, `速い道 ${v} / 遅い道 ${vs}`);
  assert.ok(Math.abs(v - ref) <= 1e-9 * v, `評価器 ${v} / comboExpected ${ref}`);
  assert.ok(MAX_PATTERNS < 2 ** binary.length);
});

test('上限を外した評価器は上限ありより下がらない (上界の前提)', () => {
  for (let i = 0; i < 30; i++) {
    const c = randomCase(2000 + i);
    const ev = evaluatorOf(c);
    const evU = evaluatorOf(c, { uncapped: true });
    const evA = evaluatorOf(c, { uncapped: 'attack' });
    for (let t = 0; t < 5; t++) {
      const lv = randomLevels(14);
      const v = ev.evaluate(lv);
      assert.ok(evA.evaluate(lv) >= v - 1e-9 * v, '攻撃・属性の上限だけ外した版');
      assert.ok(evU.evaluate(lv) >= v - 1e-9 * v, '全部外した版');
    }
  }
});

test('必要なスキル (requiresSkillId) が無いと効かない・匠で斬れ味が変わる', () => {
  const entry = Object.entries(effects.effects).find(([, e]) => e.requiresSkillId != null);
  assert.ok(entry, 'requiresSkillId のスキルがある');
  const [sid, e] = entry;
  const c = { ...randomCase(3), uptimes: {}, buffs: {} };
  const ev = evaluatorOf(c);
  const lv = new Int8Array(ids.length);
  lv[ids.indexOf(Number(sid))] = e.levels[e.levels.length - 1].level;
  const without = ev.evaluate(lv);
  assert.ok(Math.abs(without - reference(c, toList(lv))) <= 1e-9 * without);
  lv[ids.indexOf(Number(e.requiresSkillId))] = 1;
  const withReq = ev.evaluate(lv);
  assert.ok(Math.abs(withReq - reference(c, toList(lv))) <= 1e-9 * withReq);
  // 匠: 自動の斬れ味なら Lv で色が変わる武器があり、評価器もその色で計算する
  const w = raw.weapons.weapons.map((x) => resolveWeaponRef(x.id, idx)).find((x) => {
    const res = sharpnessResolver(x, idx, null);
    return res([{ skillId: HC, level: 0 }]).sharpness !== res([{ skillId: HC, level: 5 }]).sharpness;
  });
  assert.ok(w, '匠で色が変わる武器がある');
  const res = sharpnessResolver(w, idx, null);
  const c2 = { ...c, weapon: damageWeapon(w), sharpOf: (list) => res(list).sharpness,
    sharpness: (l) => res([{ skillId: HC, level: l }]).sharpness };
  const ev2 = evaluatorOf(c2);
  const lv2 = new Int8Array(ids.length);
  const vals = [0, 5].map((l) => {
    lv2[ids.indexOf(HC)] = l;
    const v = ev2.evaluate(lv2);
    assert.ok(Math.abs(v - reference(c2, toList(lv2))) <= 1e-9 * v);
    return v;
  });
  assert.ok(vals[1] > vals[0], `匠5 で上がる: ${vals}`);
  assert.equal(skillId('匠'), HC);
});

test('条件のパターンの覚えを評価器どうしで使い回しても同じ値 (武器・上限の違う評価器を交互に)', () => {
  for (let i = 0; i < 20; i++) {
    const a = randomCase(3000 + i);
    // 同じ発動率・状態異常で、武器 (属性) と上限だけ違う評価器
    const b = { ...randomCase(3001 + i), uptimes: a.uptimes, monsterStatus: a.monsterStatus, combo: a.combo, targets: a.targets };
    const shared = new Map();
    const pairs = [
      [evaluatorOf(a, { patternCache: shared }), evaluatorOf(a)],
      [evaluatorOf(b, { patternCache: shared }), evaluatorOf(b)],
      [evaluatorOf(a, { patternCache: shared, uncapped: true }), evaluatorOf(a, { uncapped: true })],
    ];
    for (let t = 0; t < 8; t++) {
      const lv = t % 2 ? randomLevels(12) : heavyLevels();
      for (const [s, own] of pairs) {
        const x = s.evaluate(lv);
        const y = own.evaluate(lv);
        assert.ok(Math.abs(x - y) <= 1e-12 * Math.max(1, Math.abs(y)), `${x} / ${y}`);
      }
    }
    assert.ok(shared.size > 0);
  }
  // relevantIds の違う評価器には渡せない
  const c = randomCase(4000);
  const shared = new Map();
  evaluatorOf(c, { patternCache: shared });
  assert.throws(() => makeEvaluator({
    effects, motions, combo: c.combo, targets: c.targets, weapon: c.weapon, uptimes: c.uptimes, relevantIds: ids.slice(1),
    sharpness: 'white', patternCache: shared,
  }), /patternCache/);
});
