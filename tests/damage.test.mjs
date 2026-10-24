// app/model/damage.js のテスト。期待値はすべて手計算 (式はコメントに書く)。
// 実行: node --test tests/*.test.mjs (Node 24 は `node --test tests/` のディレクトリ指定を受け付けない)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  DEFAULT_RULES, clampAffinity, critExpectation, critElementExpectation, effectiveElement, effectiveAttack,
  sharpnessMultipliers, hitDamage, computeStats, aggregateModifiers, enumeratePatterns, comboExpected,
  skillContribution, resolveSkills, resolveConditions, isWoundOnlyHit,
} from '../app/model/damage.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (name) => JSON.parse(readFileSync(join(ROOT, 'data', name), 'utf8'));
const EFFECTS = load('skill_effects.json');
const MOTIONS = load('motions_sns.json');
const COMBOS = load('combos_sns.json');

const close = (actual, expected, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);

// skill_effects.json の id を名前で引く (id は MHDB の採番なので直書きしない)
function skillIdByName(name) {
  const hit = Object.entries(EFFECTS.effects).find(([, e]) => e.name === name);
  assert.ok(hit, `skill_effects.json に ${name} が無い`);
  return Number(hit[0]);
}

// 合成スキル (テスト専用の effects)
function fx(levels, extra = {}) {
  return { name: extra.name || 'test', conditional: false, defaultUptime: 1, supported: true, confidence: 'high',
    levels: levels.map((l, i) => ({ level: i + 1, ...l })), ...extra };
}
const HIT = { mv: 100, count: 1, type: 'slash', usesElement: true, elementRate: 1, canCrit: true, sharpnessMul: true };
const ONE_HIT_EARLY = { moves: [{ id: 'm', name: 'm', hits: [HIT] }] };
const ONE_PHYS_HIT_EARLY = { moves: [{ id: 'm', name: 'm', hits: [{ ...HIT, usesElement: false, elementRate: 0 }] }] };
const stats = (weapon, effectList = []) => computeStats(weapon, aggregateModifiers(effectList, weapon.element?.type), DEFAULT_RULES);

test('会心率は -100〜100 で切る (上限クリップ)', () => {
  assert.equal(clampAffinity(150), 100);
  assert.equal(clampAffinity(-130), -100);
  // 会心率 150% → 100% 扱い → 基本会心倍率 1.25 そのもの
  close(critExpectation(150), 1.25);
  // 超会心 Lv5 (1.40) で 100%
  close(critExpectation(120, 1.40), 1.40);
  // 50% なら 1 + 0.5 × 0.25 = 1.125
  close(critExpectation(50), 1.125);
});

test('マイナス会心は 0.75 倍。属性には掛からない', () => {
  // -30% → 1 + 0.3 × (0.75 − 1) = 0.925
  close(critExpectation(-30), 0.925);
  // -150% は -100% に切る → 0.75
  close(critExpectation(-150), 0.75);
  // 会心撃【属性】があってもマイナス会心は属性に掛けない
  close(critElementExpectation(-50, 1.15), 1);
});

test('属性値の上限は攻撃と同じく倍率 (2.3) と加算 (表示400) を別々に切る', () => {
  // ゲームデータ: PlayerStatusParam._ElementAttack_RateLimit=2.3 / _ElementAttack_AddLimit=40 (表示 400)
  assert.equal(EFFECTS.rules.elementRateLimit, 2.3);
  assert.equal(EFFECTS.rules.elementAddLimit, 400);
  assert.equal(EFFECTS.rules.elementCapRate, undefined);   // 旧い名前は残さない
  // 元 100、加算 500 → 加算だけ 400 に切る: 100 + 400 = 500
  assert.equal(effectiveElement(100, 1, 500), 500);
  // 元 400 × 2 = 800 (倍率は上限以下)
  assert.equal(effectiveElement(400, 2, 0), 800);
  // 元 400 × 2.5 → 倍率を 2.3 に切る: 920
  close(effectiveElement(400, 2.5, 0), 920);
  // 倍率と加算を別々に切る: 100 × min(3, 2.3) + min(300, 400) = 530
  //   (旧い読み min(元×乗算+加算, max(元+400, 元×2.3)) なら 500 になる)
  close(effectiveElement(100, 3, 300), 530);
  // 300 × min(2.5, 2.3) + 100 = 790 (旧い読みなら max(700, 690) = 700)
  close(effectiveElement(300, 2.5, 100), 790);
  // 攻撃も同じ形: 100 × min(5, 4) + min(500, 400) = 800
  close(effectiveAttack(100, 5, 500), 800);
  // rules を実データにしても同じ
  close(effectiveElement(300, 2.5, 100, EFFECTS.rules), 790);
});

test('弱点特効は物理肉質 45 以上で効く (44 は効かない)', () => {
  const wex = fx([{ weakPointAffinity: 30, woundAffinity: 20 }]);
  const st = stats({ attack: 100, affinity: 0, element: null }, [wex.levels[0]]);
  // 肉質 44: 会心 0% → 100 × 1.00 × 0.44 × 1.32 = 58.08
  close(hitDamage(HIT, st, { hitzone: { slash: 44 }, sharpness: 'white' }).physical, 58.08);
  // 肉質 45: 会心 30% → 1 + 0.3×0.25 = 1.075 → 100 × 0.45 × 1.32 × 1.075 = 63.855
  close(hitDamage(HIT, st, { hitzone: { slash: 45 }, sharpness: 'white' }).physical, 63.855);
});

test('傷口では弱点特効の追加分が乗る', () => {
  const wex = fx([{ weakPointAffinity: 30, woundAffinity: 20 }]);
  const st = stats({ attack: 100, affinity: 0, element: null }, [wex.levels[0]]);
  // 肉質 45 の傷口: 30 + 20 = 50% → 1.125 → 100 × 0.45 × 1.32 × 1.125 = 66.825
  close(hitDamage(HIT, st, { hitzone: { slash: 45 }, isWound: true, sharpness: 'white' }).physical, 66.825);
  // 肉質 44 の傷口: 傷口分 20% だけ → 1.05 → 100 × 0.44 × 1.32 × 1.05 = 60.984
  close(hitDamage(HIT, st, { hitzone: { slash: 44 }, isWound: true, sharpness: 'white' }).physical, 60.984);
});

// 合成の条件グループ (テスト専用)
const G = (id, extra = {}) => ({ id, label: id, type: 'binary', defaultUptime: 0.5, exclusiveWith: [], ...extra });

test('条件つきスキルは条件グループの発動率で加重平均 (関係の無い条件は独立と仮定)', () => {
  const effects = {
    rules: { conditionGroups: [G('angry', { defaultUptime: 0.5 }), G('full', { defaultUptime: 0.25 })] },
    effects: {
      1: fx([{ attackAdd: 20, affinityAdd: 15 }], { name: '挑戦者', conditional: true, conditionGroup: 'angry' }),
      2: fx([{ attackAdd: 20 }], { name: 'フルチャージ', conditional: true, conditionGroup: 'full' }),
    },
  };
  const motions = { moves: [{ id: 'm', name: 'm', hits: [{ ...HIT, usesElement: false, elementRate: 0 }] }] };
  const base = { weapon: { attack: 200, affinity: 0, element: null }, sharpness: 'yellow', effects, motions,
    combo: ['m'], target: { hitzone: { slash: 100 } } };
  // 挑戦者だけ (0.5): 発動 220 × 1.0375 = 228.25、非発動 200 → 214.125
  close(comboExpected({ ...base, skills: [{ skillId: 1, level: 1 }] }).total, 214.125);
  // 2 つ: (両方 0.125) 240×1.0375=249 / (挑のみ 0.375) 228.25 / (フのみ 0.125) 220 / (なし 0.375) 200
  //   = 31.125 + 85.59375 + 27.5 + 75 = 219.21875
  const r = comboExpected({ ...base, skills: [{ skillId: 1, level: 1 }, { skillId: 2, level: 1 }] });
  close(r.total, 219.21875);
  assert.equal(r.patterns, 4);
  assert.deepEqual(r.conditions.map((c) => [c.id, c.uptime, c.fromInput]), [['angry', 0.5, false], ['full', 0.25, false]]);
  // 発動率を人が条件ごとに上書き: angry 1.0 → 228.25
  close(comboExpected({ ...base, skills: [{ skillId: 1, level: 1 }], uptimes: { angry: 1 } }).total, 228.25);
  // スキルに uptime を付けても使わない (発動率は条件ごと)
  close(comboExpected({ ...base, skills: [{ skillId: 1, level: 1, uptime: 1 }] }).total, 214.125);
  // 条件グループの無い条件つきスキルは、そのスキルだけのグループ skill:<id> (既定はスキルの defaultUptime)
  const loose = { effects: { 1: fx([{ attackAdd: 20 }], { name: 'x', conditional: true, defaultUptime: 0.25 }) } };
  const rl = comboExpected({ ...base, effects: loose, skills: [{ skillId: 1, level: 1 }] });
  close(rl.total, 205);                                             // 200 + 20 × 0.25
  assert.equal(rl.conditions[0].id, 'skill:1');
  close(comboExpected({ ...base, effects: loose, skills: [{ skillId: 1, level: 1 }], uptimes: { 'skill:1': 1 } }).total, 220);
});

test('同じ条件で動くスキルは一緒に発動する (挑戦者と巨戟龍の黙示録 = モンスターが怒っている)', () => {
  const enraged = EFFECTS.rules.conditionGroups.find((g) => g.id === 'enraged');
  assert.deepEqual(enraged.skills.map((s) => s.name).sort(), ['巨戟龍の黙示録', '挑戦者'].sort());
  assert.equal(EFFECTS.effects[skillIdByName('挑戦者')].conditionGroup, 'enraged');
  assert.equal(EFFECTS.effects[skillIdByName('巨戟龍の黙示録')].conditionGroup, 'enraged');
  const input = {
    weapon: { attack: 200, affinity: 0, element: { type: 'fire', value: 300 } }, sharpness: 'yellow',
    skills: [{ skillId: skillIdByName('挑戦者'), level: 5 }, { skillId: skillIdByName('巨戟龍の黙示録'), level: 2 },
      { skillId: skillIdByName('会心撃【属性】'), level: 3 }],
    effects: EFFECTS, motions: ONE_HIT_EARLY, combo: ['m'], target: { hitzone: { slash: 100, fire: 100 } },
  };
  // 怒り中: 攻撃 220・会心 15% → 物理 220 × (1 + 0.15 × 0.25) = 228.25
  //   属性 300 × 1.3 + 40 = 430 → 43 × 0.75 (黄) × (1 + 0.15 × 0.15) = 32.975625 → 計 261.225625
  // 怒っていない: 物理 200、属性 30 × 0.75 = 22.5 → 計 222.5
  // 発動率 0.5 (人が入れた値): (261.225625 + 222.5) / 2 = 241.8628125
  //   (スキルごとに独立と扱うと 4 パターンで 241.80796875 になる)
  const r = comboExpected({ ...input, uptimes: { enraged: 0.5 } });
  close(r.total, 241.8628125, 1e-9);
  assert.equal(r.patterns, 2);
  assert.equal(r.conditions.length, 1);
  assert.equal(r.conditions[0].fromInput, true);
  // 既定 (本人の前提 2026-10-22: 基本発動する = 100%): 怒り中だけの 1 パターン。仮置きではない
  const d = comboExpected(input);
  close(d.total, 261.225625, 1e-9);
  assert.equal(d.patterns, 1);
  assert.deepEqual([d.conditions[0].uptime, d.conditions[0].placeholder, d.conditions[0].fromInput], [1, false, false]);
  assert.match(d.conditions[0].uptimeBasis, /^基本発動する前提で計算/);
  close(comboExpected({ ...input, uptimes: { enraged: 1 } }).total, 261.225625, 1e-9);
  close(comboExpected({ ...input, uptimes: { enraged: 0 } }).total, 222.5, 1e-9);
  // 本人が入れた値が既定より優先: 0.4 → 261.225625 × 0.4 + 222.5 × 0.6 = 237.99025
  close(comboExpected({ ...input, uptimes: { enraged: 0.4 } }).total, 237.99025, 1e-9);
});

test('同時に起きない条件 (exclusive) は「両方発動」に重みを付けず、各条件の発動率は保つ', () => {
  // 攻撃 +20 (満タン) と 会心 +40% (赤ゲージ) は掛け算で効き合うので、両方発動の有無で期待値が変わる
  const effects = {
    rules: { conditionGroups: [G('full', { exclusiveWith: ['red'] }), G('red')] },   // 片側だけ書いても両側に効く
    effects: {
      1: fx([{ attackAdd: 20 }], { name: 'フルチャージ', conditional: true, conditionGroup: 'full' }),
      2: fx([{ affinityAdd: 40 }], { name: '逆恨み', conditional: true, conditionGroup: 'red' }),
    },
  };
  const base = { weapon: { attack: 200, affinity: 0, element: null }, sharpness: 'yellow', effects,
    motions: ONE_PHYS_HIT_EARLY, combo: ['m'], target: { hitzone: { slash: 100 } },
    skills: [{ skillId: 1, level: 1 }, { skillId: 2, level: 1 }] };
  // 0.5 / 0.5: 満タンだけ 0.5 → 220、赤だけ 0.5 → 200 × 1.1 = 220 → 220
  //   (独立なら 両方 0.25 × 242 + 220 × 0.25 + 220 × 0.25 + 200 × 0.25 = 220.5)
  const r = comboExpected(base);
  close(r.total, 220);
  assert.equal(r.patterns, 2);
  assert.deepEqual(r.warnings, []);
  // 0.3 / 0.4: 満タン 0.3 → 220、赤 0.4 → 220、どちらも無し 0.3 → 200 = 214
  close(comboExpected({ ...base, uptimes: { full: 0.3, red: 0.4 } }).total, 214);
  // 合計が 100% を超えたら後の条件 (赤) を減らして警告: 赤は 1 − 0.7 = 0.3 まで
  const over = comboExpected({ ...base, uptimes: { full: 0.7, red: 0.5 } });
  close(over.total, 0.7 * 220 + 0.3 * 220);
  assert.deepEqual(over.warnings.map((w) => w.code), ['exclusive-conflict']);
});

test('同時に起きない条件の合計が 100% を超えたら、仮置きの条件から減らし、本人が入れた条件は保つ (並びに関係なく)', () => {
  // full (仮置き) が並びで先でも、本人が入れた red を保つ
  const effects = {
    rules: { conditionGroups: [G('full', { exclusiveWith: ['red'], placeholder: true }), G('red', { placeholder: true })] },
    effects: {
      1: fx([{ attackAdd: 20 }], { name: 'フルチャージ', conditional: true, conditionGroup: 'full' }),
      2: fx([{ affinityAdd: 40 }], { name: '逆恨み', conditional: true, conditionGroup: 'red' }),
    },
  };
  const skills = [{ skillId: 1, level: 1 }, { skillId: 2, level: 1 }];
  const res = resolveSkills(skills, effects);
  const cond = resolveConditions(res.active, effects, { red: 0.8 });
  const { patterns, warnings } = enumeratePatterns(cond.groups);
  const prob = (f) => patterns.filter((p) => f(p.states)).reduce((t, p) => t + p.weight, 0);
  close(prob((s) => s.red === 'on'), 0.8, 1e-12);       // 入れた値のまま
  close(prob((s) => s.full === 'on'), 0.2, 1e-12);      // 仮置き 0.5 → 残りの 0.2 まで減らす
  assert.deepEqual(warnings.map((w) => [w.code, w.groupId]), [['exclusive-conflict', 'full']]);
});

test('条件のもと (sources): もとのスキルも相手の状態異常も無ければ 0%。相手が分からない (monsterStatus なし) なら決めつけない', () => {
  const effects = {
    rules: { conditionGroups: [G('fz', { sources: { skillIds: [9], monsterStatus: ['frenzy'], label: 'もと' } })] },
    effects: { 1: fx([{ attackAdd: 20 }], { name: '無我', conditional: true, conditionGroup: 'fz' }), 9: fx([{ attackAdd: 0 }], { name: 'もと' }) },
  };
  const base = { weapon: { attack: 200, affinity: 0, element: null }, sharpness: 'yellow', effects,
    motions: ONE_PHYS_HIT_EARLY, combo: ['m'], target: { hitzone: { slash: 100 } }, uptimes: { fz: 1 } };
  close(comboExpected({ ...base, skills: [{ skillId: 1, level: 1 }] }).total, 220);
  const off = comboExpected({ ...base, skills: [{ skillId: 1, level: 1 }], monsterStatus: [] });
  close(off.total, 200);
  assert.equal(off.conditions[0].inactive, true);
  close(comboExpected({ ...base, skills: [{ skillId: 1, level: 1 }], monsterStatus: ['frenzy'] }).total, 220);
  close(comboExpected({ ...base, skills: [{ skillId: 1, level: 1 }, { skillId: 9, level: 1 }], monsterStatus: [] }).total, 220);
});

test('実データ: 体力満タンと赤ゲージ・体力35%以下は同時に起きない。赤ゲージと35%以下は同時に起きてよい', () => {
  const groups = Object.fromEntries(EFFECTS.rules.conditionGroups.map((g) => [g.id, g]));
  assert.deepEqual(groups.hpFull.exclusiveWith.sort(), ['hpLow', 'redHp']);
  assert.deepEqual(groups.redHp.exclusiveWith, ['hpFull']);
  assert.deepEqual(groups.hpLow.exclusiveWith, ['hpFull']);
  assert.equal(EFFECTS.effects[skillIdByName('フルチャージ')].conditionGroup, 'hpFull');
  assert.equal(EFFECTS.effects[skillIdByName('逆恨み')].conditionGroup, 'redHp');
  assert.equal(EFFECTS.effects[skillIdByName('火事場力')].conditionGroup, 'hpLow');
  const skills = ['フルチャージ', '逆恨み', '火事場力'].map((n) => ({ skillId: skillIdByName(n), level: 5 }));
  const res = resolveSkills(skills, EFFECTS);
  const cond = resolveConditions(res.active, EFFECTS, { hpFull: 0.3, redHp: 0.5, hpLow: 0.4 });
  const { patterns, warnings } = enumeratePatterns(cond.groups);
  assert.deepEqual(warnings, []);
  close(patterns.reduce((t, p) => t + p.weight, 0), 1, 1e-12);
  const prob = (f) => patterns.filter((p) => f(p.states)).reduce((t, p) => t + p.weight, 0);
  // 両方発動の重みは 0
  assert.equal(prob((s) => s.hpFull === 'on' && s.redHp === 'on'), 0);
  assert.equal(prob((s) => s.hpFull === 'on' && s.hpLow === 'on'), 0);
  // 各条件の発動率は入れた値のまま
  close(prob((s) => s.hpFull === 'on'), 0.3, 1e-12);
  close(prob((s) => s.redHp === 'on'), 0.5, 1e-12);
  close(prob((s) => s.hpLow === 'on'), 0.4, 1e-12);
  // 赤ゲージと 35% 以下は満タンでないときに独立: 0.5 × 0.4 / 0.7
  close(prob((s) => s.redHp === 'on' && s.hpLow === 'on'), 0.5 * 0.4 / 0.7, 1e-12);
});

test('会心撃【属性】が無ければ会心は属性に掛からない', () => {
  const weapon = { attack: 100, affinity: 100, element: { type: 'fire', value: 300 } };
  const ctx = { hitzone: { slash: 0, fire: 20 }, sharpness: 'white' };
  // 属性 = 300/10 × 1 × 0.20 × 1.15 = 6.9 (会心率 100% でも変わらない)
  close(hitDamage(HIT, stats(weapon), ctx).element, 6.9);
  // 会心撃【属性】Lv3 (ゲームデータ 1.15): 6.9 × 1.15 = 7.935
  const ceId = skillIdByName('会心撃【属性】');
  const lv3 = EFFECTS.effects[ceId].levels[2];
  assert.equal(lv3.critElementMul, 1.15);
  close(hitDamage(HIT, stats(weapon, [lv3]), ctx).element, 7.935);
  // 会心率 40% なら 1 + 0.4 × 0.15 = 1.06 → 6.9 × 1.06 = 7.314
  close(hitDamage(HIT, stats({ ...weapon, affinity: 40 }, [lv3]), ctx).element, 7.314);
});

test('灼熱化 (火竜の力) は火肉質に依存し、固定分は肉質に依存しない', () => {
  const id = skillIdByName('火竜の力');
  const lv2 = EFFECTS.effects[id].levels[1];
  // ゲームデータ: 上位Ⅱ 固定 40 + 火 1200 (表示) = 内部 120。判定の待ち 2.4 秒・判定あたり平均 0.5 (段階 33→50→100%)。
  // ヒットごとの確率 chance は持たない (残すとヒットごとに数える道が残る)
  const x = lv2.extraDamage;
  assert.deepEqual([x.model, x.fixed, x.element, x.cooldownSec, x.perCheck, x.checkChances], ['checks', 40, 1200, 2.4, 0.5, [0.33, 0.5, 1]]);
  assert.equal('chance' in x, false);
  const st = stats({ attack: 100, affinity: 0, element: null }, [lv2]);
  const hit = { ...HIT, mv: 0, additionalDamage: true };
  // 1 ヒットだけ見る (判定の割合を渡さない) ときは、待ちの明けた所の判定 1 回: 0.5 × 1 回分
  // 火肉質 20: 0.5 × (40 + 120 × 0.20) = 0.5 × 64 = 32
  close(hitDamage(hit, st, { hitzone: { slash: 50, fire: 20 }, sharpness: 'white' }).extra, 32);
  // 火肉質 0: 0.5 × 40 = 20 (固定分は肉質によらず残る)
  close(hitDamage(hit, st, { hitzone: { slash: 50, fire: 0 }, sharpness: 'white' }).extra, 20);
  // 判定の割合を渡すと、その割合を掛ける (0.2 → 0.5 × 0.2 × 64 = 6.4)
  close(hitDamage(hit, st, { hitzone: { slash: 50, fire: 20 }, sharpness: 'white', checkWeight: () => 0.2 }).extra, 6.4);
  // 追加ダメージ対象でないヒットには出ない
  assert.equal(hitDamage({ ...hit, additionalDamage: false }, st, { hitzone: { fire: 20 } }).extra, 0);
});

test('攻撃力 = 武器攻撃力 × 乗算 + 加算 (攻撃 Lv5 はゲームデータで ×1.04 + 9)', () => {
  const id = skillIdByName('攻撃');
  const lvs = EFFECTS.effects[id].levels;
  assert.deepEqual(lvs.map((l) => [l.attackMul, l.attackAdd]), [[1, 3], [1, 5], [1, 7], [1.02, 8], [1.04, 9]]);
  // 200 × 1.04 + 9 = 217
  close(stats({ attack: 200, affinity: 0, element: null }, [lvs[4]]).attack, 217);
});

test('斬れ味補正: 白は物理 1.32 / 属性 1.15。盾は属性 0 だが斬れ味補正は掛かる', () => {
  assert.deepEqual(sharpnessMultipliers('white', DEFAULT_RULES), { physical: 1.32, element: 1.15 });
  // ゲームデータ (EmCommonData._KireajiTable) も白 1.32
  assert.equal(EFFECTS.rules.sharpness.white.physical, 1.32);
  assert.equal(EFFECTS.rules.sharpness.blue.element, 1.0625);
  const shield = MOTIONS.moves.find((m) => m.id === 'shield_bash_1').hits[0];
  assert.equal(shield.elementRate, 0);
  assert.equal(shield.sharpnessMul, true);
  assert.equal(shield.consumesSharpness, false);
  const st = stats({ attack: 100, affinity: 0, element: { type: 'fire', value: 300 } });
  // 盾攻撃 MV16、打撃肉質 50: 100 × 0.16 × 0.50 × 1.32 = 10.56、属性 0
  const d = hitDamage(shield, st, { hitzone: { blunt: 50, fire: 30 }, sharpness: 'white' });
  close(d.physical, 10.56);
  assert.equal(d.element, 0);
  // 斬れ味補正の掛からないヒットは 1.0
  close(hitDamage({ ...HIT, sharpnessMul: false }, st, { hitzone: { slash: 50 }, sharpness: 'white' }).physical, 50);
});

test('連撃は段階のある条件 (未発動 / 1〜4 ヒット段 / 5 ヒット以降段)', () => {
  const id = skillIdByName('連撃');
  const lv5 = EFFECTS.effects[id].levels[4];
  assert.deepEqual([lv5.attackAdd, lv5.elementAdd, lv5.byState], [18, 140, { hit1to4: { attackAdd: 5, elementAdd: 50 } }]);
  assert.equal(lv5.whenInactive, undefined);
  const chain = EFFECTS.rules.conditionGroups.find((g) => g.id === 'chain');
  assert.equal(chain.type, 'categorical');
  assert.deepEqual(chain.states.map((s) => s.id), ['none', 'hit1to4', 'hit5plus']);
  assert.equal(chain.offState, 'none');
  const motions = { moves: [{ id: 'm', name: 'm', hits: [HIT] }] };
  const base = {
    weapon: { attack: 100, affinity: 0, element: { type: 'fire', value: 200 } }, sharpness: 'yellow',
    skills: [{ skillId: id, level: 5 }], effects: EFFECTS, motions, combo: ['m'],
    target: { hitzone: { slash: 100, fire: 100 } },
  };
  // 未発動: 100 + 200/10 × 0.75 = 115
  // 1〜4 ヒット段: 105 + 250/10 × 0.75 = 123.75
  // 5 ヒット以降段: 118 + 340/10 × 0.75 = 143.5
  // 既定 (本人の前提 2026-10-22: いつも 5 ヒット以降段) → 143.5。1 パターンだけ (未発動・1〜4 段は数えない)
  const def = comboExpected(base);
  close(def.total, 143.5);
  assert.equal(def.patterns, 1);
  assert.deepEqual(def.conditions[0].uptime, { hit1to4: 0, hit5plus: 1 });
  assert.equal(def.conditions[0].placeholder, false);
  // 1〜4 段 0.5 / 5 段以降 0.5 (2026-10-21 までの既定の値) → 133.625
  close(comboExpected({ ...base, uptimes: { chain: { hit1to4: 0.5, hit5plus: 0.5 } } }).total, 133.625);
  // 1〜4 段 0.3 / 5 段以降 0.5 / 未発動 0.2 → 23 + 37.125 + 71.75 = 131.875
  const r = comboExpected({ ...base, uptimes: { chain: { hit1to4: 0.3, hit5plus: 0.5 } } });
  close(r.total, 131.875);
  assert.equal(r.patterns, 3);
  // 兇爪竜の力Ⅱ (+18) は連撃が発動している段 (1〜4 段・5 段以降) ならいつでも: + 0.8 × 18 = 146.275
  const kyo = skillIdByName('兇爪竜の力');
  assert.deepEqual(EFFECTS.effects[kyo].activeStates, ['hit1to4', 'hit5plus']);
  close(comboExpected({ ...base, skills: [...base.skills, { skillId: kyo, level: 2 }],
    uptimes: { chain: { hit1to4: 0.3, hit5plus: 0.5 } } }).total, 146.275);
  // 段の割合の合計が 100% を超えたら縮めて警告: 0.6 / 0.6 → 0.5 / 0.5
  const over = comboExpected({ ...base, uptimes: { chain: { hit1to4: 0.6, hit5plus: 0.6 } } });
  close(over.total, 133.625);
  assert.deepEqual(over.warnings.map((w) => w.code), ['uptime-over-100']);
  // 平らなキー "chain.<段 id>" でも渡せる (数だけを保存する画面の入れ物向け)。渡さない段は 0
  close(comboExpected({ ...base, uptimes: { 'chain.hit1to4': 0.3, 'chain.hit5plus': 0.5 } }).total, 131.875);
  close(comboExpected({ ...base, uptimes: { 'chain.hit5plus': 1 } }).total, 143.5);
  // 入れ子の形があればそちらが優先
  close(comboExpected({ ...base, uptimes: { chain: { hit5plus: 1 }, 'chain.hit1to4': 1 } }).total, 143.5);
  // 数で渡すなど読めない値は既定値 (5 ヒット以降段 100%) で計算して警告
  const bad = comboExpected({ ...base, uptimes: { chain: 0.9 } });
  close(bad.total, 143.5);
  assert.deepEqual(bad.warnings.map((w) => w.code), ['bad-uptime']);
});

test('狂竜症: 黒蝕竜の力は感染中と克服後で効果が違い、無我の境地は克服後だけ', () => {
  const koku = skillIdByName('黒蝕竜の力');
  const muga = skillIdByName('無我の境地');
  const lv2 = EFFECTS.effects[koku].levels[1];
  assert.deepEqual([lv2.attackAdd, lv2.affinityAdd, lv2.byState], [15, 15, { infected: { attackAdd: 10 } }]);
  assert.equal(EFFECTS.effects[muga].levels[2].affinityAdd, 10);
  const r = comboExpected({
    weapon: { attack: 200, affinity: 0, element: null }, sharpness: 'yellow',
    skills: [{ skillId: koku, level: 2 }, { skillId: muga, level: 3 }], effects: EFFECTS,
    motions: ONE_PHYS_HIT_EARLY, combo: ['m'], target: { hitzone: { slash: 100 } },
    uptimes: { frenzy: { infected: 0.3, overcome: 0.5 } },
  });
  // かかっていない 0.2: 200 / 感染中 0.3: 210 / 克服後 0.5: 215 × (1 + 0.25 × 0.25) = 228.4375
  //   = 40 + 63 + 114.21875 = 217.21875
  close(r.total, 217.21875);
  assert.equal(r.patterns, 3);
});

test('条件グループのデータ: 条件つきで計算するスキルは全部どれかのグループにあり、根拠の無い既定値は仮置きと書く', () => {
  const groups = EFFECTS.rules.conditionGroups;
  const ids = new Set(groups.map((g) => g.id));
  for (const [sid, e] of Object.entries(EFFECTS.effects)) {
    if (!e.conditional || e.supported === false) continue;
    assert.ok(ids.has(e.conditionGroup), `${e.name} (${sid}) の conditionGroup ${e.conditionGroup}`);
    const g = groups.find((x) => x.id === e.conditionGroup);
    assert.ok(g.skills.some((s) => s.skillId === Number(sid)), `${g.id} の skills に ${e.name} が無い`);
  }
  for (const g of groups) {
    assert.ok(g.label && g.uptimeBasis, g.id);
    if (g.placeholder) assert.match(g.uptimeBasis, /仮置き/, g.id);
    for (const o of g.exclusiveWith) assert.ok(groups.find((x) => x.id === o).exclusiveWith.includes(g.id), `${g.id}↔${o}`);
  }
  // 根拠のある既定値 (ヌシの魂・祈り) は仮置きではない
  assert.equal(groups.find((g) => g.id === 'beforeGuts').placeholder, false);
  assert.equal(groups.find((g) => g.id === 'festival').placeholder, false);
  // 仮置きでないのは、根拠のある既定値 2 つと本人の前提 3 つだけ (残りは全部仮置き 50%)
  assert.deepEqual(groups.filter((g) => !g.placeholder).map((g) => g.id).sort(),
    ['beforeGuts', 'chain', 'enraged', 'festival', 'staminaFull']);
  for (const g of groups.filter((x) => x.placeholder)) {
    assert.deepEqual(g.type === 'categorical' ? Object.values(g.defaultUptime) : [g.defaultUptime],
      g.type === 'categorical' ? g.states.slice(1).map(() => 0.5) : [0.5], g.id);
  }
});

test('本人の前提 (2026-10-22「基本発動する前提で」): 怒り・連撃・スタミナ満タンは既定 100% で、仮置きではない', () => {
  const groups = EFFECTS.rules.conditionGroups;
  const g = (id) => groups.find((x) => x.id === id);
  assert.deepEqual([g('enraged').defaultUptime, g('enraged').placeholder], [1, false]);
  assert.deepEqual([g('chain').defaultUptime, g('chain').placeholder], [{ hit1to4: 0, hit5plus: 1 }, false]);
  assert.deepEqual([g('staminaFull').defaultUptime, g('staminaFull').placeholder], [1, false]);
  for (const id of ['enraged', 'chain', 'staminaFull']) {
    // 根拠の文は火力タブの発動率の欄 (その条件のスライダーのすぐ下) に出るので、「火力タブで」とは書かない
    assert.match(g(id).uptimeBasis, /^基本発動する前提で計算 \(2026-10-22 に決めた既定\)。.*上のスライダーで入れる$/, id);
    assert.doesNotMatch(g(id).uptimeBasis, /仮置き|火力タブ/, id);
  }
  // スキルの defaultUptime (主効果が出る割合の参考値) も 100%。兇爪竜の力は連撃のどの段でも
  for (const name of ['挑戦者', '巨戟龍の黙示録', '連撃', '兇爪竜の力', '渾身']) {
    assert.equal(EFFECTS.effects[skillIdByName(name)].defaultUptime, 1, name);
  }
  // 何も入れないと、3 条件とも「発動中」だけの 1 パターン (0% の段を数え上げない = 0% のときと同じ速さ)
  const skills = ['挑戦者', '巨戟龍の黙示録', '連撃', '兇爪竜の力', '渾身'].map((name) => ({ skillId: skillIdByName(name), level: 2 }));
  const input = {
    weapon: { attack: 200, affinity: 0, element: { type: 'fire', value: 300 } }, sharpness: 'white', skills,
    effects: EFFECTS, motions: ONE_HIT_EARLY, combo: ['m'], target: { hitzone: { slash: 60, fire: 20 } },
  };
  const on = comboExpected(input);
  assert.equal(on.patterns, 1);
  assert.equal(on.conditions.filter((c) => c.placeholder).length, 0);
  const all = { enraged: 1, chain: { hit5plus: 1 }, staminaFull: 1 };
  close(on.total, comboExpected({ ...input, uptimes: all }).total, 1e-12);
  const off = comboExpected({ ...input, uptimes: { enraged: 0, chain: {}, staminaFull: 0 } });
  assert.equal(off.patterns, 1);
  assert.ok(on.total > off.total);
  // 本人が入れた値が優先 (怒り 40%): 2 パターン。怒り 100% と 0% の 4:6 の加重平均
  const mine = comboExpected({ ...input, uptimes: { enraged: 0.4 } });
  assert.equal(mine.patterns, 2);
  const hi = comboExpected({ ...input, uptimes: { enraged: 1 } }).total;
  const lo = comboExpected({ ...input, uptimes: { enraged: 0 } }).total;
  close(mine.total, 0.4 * hi + 0.6 * lo, 1e-9);
});

test('仮置きの条件に値を入れると仮でなくなる (火力タブの「仮」の印のもと。0% を入れても同じ)', () => {
  // 本人の前提の 3 条件は仮でなくなったので、残っている仮置きの条件 (体力 35% 以下 = 火事場力) で確かめる
  const input = {
    weapon: { attack: 200, affinity: 0, element: null }, sharpness: 'white', skills: [{ skillId: skillIdByName('火事場力'), level: 5 }],
    effects: EFFECTS, motions: ONE_HIT_EARLY, combo: ['m'], target: { hitzone: { slash: 60 } },
  };
  const hpLow = (uptimes) => comboExpected({ ...input, uptimes }).conditions.find((c) => c.id === 'hpLow');
  assert.deepEqual([hpLow({}).placeholder, hpLow({}).fromInput, hpLow({}).uptime], [true, false, 0.5]);
  assert.deepEqual([hpLow({ hpLow: 0.3 }).placeholder, hpLow({ hpLow: 0.3 }).fromInput, hpLow({ hpLow: 0.3 }).uptime], [false, true, 0.3]);
  assert.deepEqual([hpLow({ hpLow: 0 }).placeholder, hpLow({ hpLow: 0 }).fromInput], [false, true]);
  // null は「入れていない」(既定の仮置き 50% のまま)
  assert.deepEqual([hpLow({ hpLow: null }).placeholder, hpLow({ hpLow: null }).fromInput], [true, false]);
});

test('モーション値はゲームデータどおり (ジャストラッシュ・集中急所突き・溜め斬り落とし)', () => {
  const mv = (id) => MOTIONS.moves.find((m) => m.id === id).hits;
  const flat = (hits) => hits.flatMap((h) => Array(h.count).fill(h.mv));
  const rates = (hits) => hits.map((h) => h.elementRate);
  assert.deepEqual(flat(mv('just_rush_1_just')), [40, 40, 45]);
  assert.deepEqual(rates(mv('just_rush_1_just')), [0, 1.5, 1.5]);
  assert.deepEqual(flat(mv('just_rush_2_just')), [60]);
  assert.deepEqual(rates(mv('just_rush_2_just')), [0]);
  assert.deepEqual(flat(mv('just_rush_3_just')), [80, 25, 34, 34, 34]);
  assert.deepEqual(rates(mv('just_rush_3_just')), [1.5, 0, 1]);
  assert.deepEqual(flat(mv('aim_attack_nohit')), [15]);
  assert.deepEqual(flat(mv('aim_attack_wound')), [15, 15]);
  assert.deepEqual(flat(mv('aim_attack_old_scar')), [15, 15, 19, 19, 19]);
  assert.deepEqual(flat(mv('finish_slash')), [18, 28, 14, 14, 14, 14]);
  assert.deepEqual(rates(mv('finish_slash')), [1, 1.2, 0.3]);
  assert.deepEqual(rates(mv('finish_slash_strong')), [1, 1.2, 1.25]);
});

test('代表コンボ (△連携) を実データで計算すると手計算と一致', () => {
  const combo = COMBOS.combos.find((c) => c.id === 'ground_basic');
  const r = comboExpected({
    weapon: { attack: 200, affinity: 0, element: { type: 'fire', value: 300 } }, sharpness: 'white',
    skills: [], effects: EFFECTS, motions: MOTIONS, combo, target: { hitzone: { slash: 50, fire: 20 } },
  });
  // 物理: 200 × (18+17+24+27)/100 × 0.50 × 1.32 = 113.52
  close(r.physical, 113.52);
  // 属性: 30 × 1.3 × 0.20 × 1.15 × 4 ヒット = 35.88
  close(r.element, 35.88);
  close(r.total, 149.4);
  assert.equal(r.steps.length, 4);
});

test('スキルなし比・1 つ外したときの低下・Lv ごとの上昇', () => {
  const id = skillIdByName('攻撃');
  const motions = { moves: [{ id: 'm', name: 'm', hits: [{ ...HIT, usesElement: false, elementRate: 0 }] }] };
  const r = skillContribution({
    weapon: { attack: 200, affinity: 0, element: null }, sharpness: 'yellow',
    skills: [{ skillId: id, level: 5 }], effects: EFFECTS, motions, combo: ['m'],
    target: { hitzone: { slash: 100 } },
  });
  close(r.total, 217);
  close(r.noSkills, 200);
  close(r.vsNoSkillsPct, 8.5);                    // 217/200 − 1
  close(r.removeEach[0].dropPct, (1 - 200 / 217) * 100);
  const lv = r.perLevel[0].levels;
  assert.deepEqual(lv.map((l) => l.total), [200, 203, 205, 207, 212, 217]);  // Lv4: 200×1.02+8
  close(lv[1].gainPctVsNone, 1.5);
  close(lv[5].gainPctVsPrev, (217 / 212 - 1) * 100);
});

test('心眼は物理肉質 44 以下で効き、45 では効かない', () => {
  const id = skillIdByName('心眼');
  const lv3 = EFFECTS.effects[id].levels[2];
  const st = stats({ attack: 100, affinity: 0, element: null }, [lv3]);
  // 44: 100 × 0.44 × 1.0 (黄) × 1.3 = 57.2 / 45: 100 × 0.45 = 45
  close(hitDamage(HIT, st, { hitzone: { slash: 44 }, sharpness: 'yellow' }).physical, 57.2);
  close(hitDamage(HIT, st, { hitzone: { slash: 45 }, sharpness: 'yellow' }).physical, 45);
});

test('兇爪竜の力は連撃が無いと効かない。未対応スキルは一覧で返す', () => {
  const kyo = skillIdByName('兇爪竜の力');
  const ren = skillIdByName('連撃');
  const chain = skillIdByName('鎖刃刺撃');
  const r1 = resolveSkills([{ skillId: kyo, level: 2 }, { skillId: chain, level: 3 }], EFFECTS);
  assert.equal(r1.active.length, 0);
  assert.equal(r1.unsupported.length, 2);
  const r2 = resolveSkills([{ skillId: kyo, level: 2 }, { skillId: ren, level: 1 }], EFFECTS);
  assert.equal(r2.active.length, 2);
  // {skillId: level} の形 (build.js の skillLevels) も受ける
  assert.equal(resolveSkills({ [ren]: 3 }, EFFECTS).active[0].level, 3);
});

test('パターンの重みの合計は 1。発動率 0/1 の条件は分岐しない', () => {
  const effects = {
    rules: { conditionGroups: [G('a'), G('b'), G('c'), G('d')] },
    effects: {
      1: fx([{ attackAdd: 1 }], { conditional: true, conditionGroup: 'a' }),
      2: fx([{ attackAdd: 1 }], { conditional: true, conditionGroup: 'b' }),
      3: fx([{ attackAdd: 1 }], { conditional: false }),
      4: fx([{ attackAdd: 1 }], { conditional: true, conditionGroup: 'c' }),
      5: fx([{ attackAdd: 1 }], { conditional: true, conditionGroup: 'd' }),
    },
  };
  const skills = [1, 2, 3, 4, 5].map((skillId) => ({ skillId, level: 1 }));
  const cond = resolveConditions(resolveSkills(skills, effects).active, effects, { a: 0.3, b: 0.6, c: 0, d: 1 });
  assert.deepEqual(cond.groups.map((g) => g.id), ['a', 'b', 'c', 'd']);
  const { patterns } = enumeratePatterns(cond.groups);
  assert.equal(patterns.length, 4);
  close(patterns.reduce((s, x) => s + x.weight, 0), 1, 1e-12);
  assert.ok(patterns.every((x) => x.states.c === 'off' && x.states.d === 'on'));
});

test('集中弱点攻撃のコンボは傷口の肉質と傷口の会心補正で計算する', () => {
  const combo = COMBOS.combos.find((c) => c.id === 'focus_wound');
  const wex = skillIdByName('弱点特効');
  const r = comboExpected({
    weapon: { attack: 200, affinity: 0, element: null }, sharpness: 'white',
    skills: [{ skillId: wex, level: 5 }], effects: EFFECTS, motions: MOTIONS, combo,
    target: { hitzone: { slash: 30 }, wound: { slash: 60 } },
  });
  // 傷口 60 → 会心 30 + 20 = 50% → 1.125。(15 + 15) × 200/100 × 0.60 × 1.32 × 1.125 = 53.46
  close(r.physical, 53.46);
});

// ------------------------------------------------------------------ 検証役 (damage-verify) が足したテスト
// 変異注入で見逃しが出た箇所 (超会心がスキルとして効くか・ヒット回数・乗算の掛け合わせ・属性の「乗算→加算」の順・
// 属性の種類違いの強化・弱点特効込みの属性会心・飛燕・会心不可ヒット・buffs・状態異常属性・鈍器使いの色・Lv の上限) を、
// damage.js を使わない手計算で押さえる。数値はゲームデータ (MHWS-in-json) を検証役が読み直した値。

const JUST_RUSH = () => COMBOS.combos.find((c) => c.id === 'just_rush_perfect');
const ONE_HIT = { moves: [{ id: 'm', name: 'm', hits: [HIT] }] };
const ONE_PHYS_HIT = { moves: [{ id: 'm', name: 'm', hits: [{ ...HIT, usesElement: false, elementRate: 0 }] }] };
const baseSkills = () => [
  { skillId: skillIdByName('攻撃'), level: 5 },
  { skillId: skillIdByName('見切り'), level: 5 },
  { skillId: skillIdByName('超会心'), level: 3 },
];

test('手計算 (a): 攻撃200・会心10%・白、攻撃5/見切り5/超会心3/弱点特効5、肉質60の頭にジャストラッシュ1周', () => {
  // 攻撃力 200 × 1.04 + 9 = 217
  // 会心率 10 + 20 (見切り5) + 30 (弱点特効5、肉質 60 ≥ 45) = 60% → 期待値 1 + 0.60 × (1.34 − 1) = 1.204
  // MV: 1段目 盾40 + 40 + 45 / 2段目 盾60 / 3段目 80 + 盾25 + 34×3 = 合計 392 (盾は打撃なので打撃肉質 60)
  // 物理 = 217 × 3.92 × 0.60 × 1.32 × 1.204 = 811.14308352。無属性なので属性 0
  const r = comboExpected({
    weapon: { attack: 200, affinity: 10, element: null }, sharpness: 'white',
    skills: [...baseSkills(), { skillId: skillIdByName('弱点特効'), level: 5 }],
    effects: EFFECTS, motions: MOTIONS, combo: JUST_RUSH(), target: { hitzone: { slash: 60, blunt: 60 } },
  });
  close(r.physical, 811.14308352, 1e-6);
  assert.equal(r.element, 0);
  close(r.total, 811.14308352, 1e-6);
});

test('手計算 (b): (a) の武器に火属性300、属性攻撃強化3・会心撃【属性】3、火肉質25・物理肉質40', () => {
  // 会心率 10 + 20 = 30% (肉質 40 < 45 なので弱点特効は付かない)
  //   物理の会心期待値 1 + 0.30 × 0.34 = 1.102 / 属性の会心期待値 1 + 0.30 × (1.15 − 1) = 1.045
  // 属性値 min(300 × 1.2 + 60, max(300 + 400, 300 × 2.3)) = 420 → /10 = 42 ((300 + 60) × 1.2 = 432 ではない)
  // 属性補正の合計 1.5 + 1.5 (1段目の剣) + 1.5 (3段目の剣) + 1.0 × 3 (子弾) = 7.5 (盾は 0)
  // 物理 = 217 × 3.92 × 0.40 × 1.32 × 1.102 = 494.94998784
  // 属性 = 42 × 7.5 × 0.25 × 1.15 × 1.045 = 94.6378125
  const input = {
    weapon: { attack: 200, affinity: 10, element: { type: 'fire', value: 300 } }, sharpness: 'white',
    skills: [...baseSkills(), { skillId: skillIdByName('火属性攻撃強化'), level: 3 },
      { skillId: skillIdByName('会心撃【属性】'), level: 3 }],
    effects: EFFECTS, motions: MOTIONS, combo: JUST_RUSH(), target: { hitzone: { slash: 40, blunt: 40, fire: 25 } },
  };
  const r = comboExpected(input);
  close(r.physical, 494.94998784, 1e-6);
  close(r.element, 94.6378125, 1e-9);
  close(r.total, 589.58780034, 1e-6);
  // 弱点特効5 を足しても肉質 40 では変わらない
  const withWex = [...input.skills, { skillId: skillIdByName('弱点特効'), level: 5 }];
  close(comboExpected({ ...input, skills: withWex }).total, 589.58780034, 1e-6);
  // 水属性攻撃強化は火属性の武器には効かない
  close(comboExpected({ ...input, skills: [...input.skills, { skillId: skillIdByName('水属性攻撃強化'), level: 3 }] }).total,
    589.58780034, 1e-6);
  // 肉質 45 なら弱点特効の会心が属性の会心期待値にも乗る: 60% → 1 + 0.60 × 0.15 = 1.09
  //   42 × 7.5 × 0.25 × 1.15 × 1.09 = 98.713125
  const r45 = comboExpected({ ...input, skills: withWex, target: { hitzone: { slash: 45, blunt: 45, fire: 25 } } });
  close(r45.element, 98.713125, 1e-9);
});

test('手計算 (c): 挑戦者5 を発動率 0.5、他は (a) と同じ', () => {
  // 発動: 攻撃力 217 + 20 = 237、会心 60 + 15 = 75% → 1 + 0.75 × 0.34 = 1.255
  //   237 × 3.92 × 0.60 × 1.32 × 1.255 = 923.4285984
  // 非発動: (a) の 811.14308352 → 平均 (923.4285984 + 811.14308352) / 2 = 867.28584096
  const r = comboExpected({
    weapon: { attack: 200, affinity: 10, element: null }, sharpness: 'white',
    skills: [...baseSkills(), { skillId: skillIdByName('弱点特効'), level: 5 },
      { skillId: skillIdByName('挑戦者'), level: 5 }],
    effects: EFFECTS, motions: MOTIONS, combo: JUST_RUSH(), target: { hitzone: { slash: 60, blunt: 60 } },
    uptimes: { enraged: 0.5 },
  });
  close(r.total, 867.28584096, 1e-6);
  assert.equal(r.patterns, 2);
});

test('乗算どうしは掛け合わせる (攻撃5 ×1.04 とヌシの魂 ×1.05、属性攻撃強化3 ×1.2 と巨戟龍の黙示録Ⅱ ×1.3)', () => {
  // 攻撃力 200 × 1.04 × 1.05 + 9 = 227.4
  // 属性値 300 × (1.2 × 1.3 = 1.56 ≤ 2.3) + (60 + 40 = 100 ≤ 400) = 568
  // 1 ヒット (MV100・属性補正1・黄・肉質 100・会心 0%): 物理 227.4 / 属性 56.8 × 0.75 = 42.6
  const r = comboExpected({
    weapon: { attack: 200, affinity: 0, element: { type: 'fire', value: 300 } }, sharpness: 'yellow',
    skills: [{ skillId: skillIdByName('攻撃'), level: 5 }, { skillId: skillIdByName('ヌシの魂'), level: 1 },
      { skillId: skillIdByName('火属性攻撃強化'), level: 3 }, { skillId: skillIdByName('巨戟龍の黙示録'), level: 2 }],
    effects: EFFECTS, motions: ONE_HIT, combo: ['m'], target: { hitzone: { slash: 100, fire: 100 } },
    uptimes: { beforeGuts: 1, enraged: 1 },
  });
  close(r.physical, 227.4);
  close(r.element, 42.6);
});

test('飛燕は飛燕対象のヒット (_IsSkillHien) だけに掛かる', () => {
  // 飛び込み斬り (MV30・対象): 100 × 0.30 × 1.1 = 33 / 斬り下ろし (MV18・対象外): 18
  const base = {
    weapon: { attack: 100, affinity: 0, element: null }, sharpness: 'yellow',
    skills: [{ skillId: skillIdByName('飛燕'), level: 1 }], effects: EFFECTS, motions: MOTIONS,
    target: { hitzone: { slash: 100 } },
  };
  close(comboExpected({ ...base, combo: ['just_rush_start'] }).total, 33);
  close(comboExpected({ ...base, combo: ['slash_1'] }).total, 18);
});

test('会心不可のヒットは会心率 100% でも物理・属性とも会心が掛からない', () => {
  const lv3 = EFFECTS.effects[skillIdByName('会心撃【属性】')].levels[2];
  const st = stats({ attack: 100, affinity: 100, element: { type: 'fire', value: 300 } }, [lv3]);
  // 物理 100 × 0.50 × 1.32 = 66、属性 30 × 0.20 × 1.15 = 6.9
  const d = hitDamage({ ...HIT, canCrit: false }, st, { hitzone: { slash: 50, fire: 20 }, sharpness: 'white' });
  close(d.physical, 66);
  close(d.element, 6.9);
});

test('buffs (アイテム等) は攻撃・会心に足される。状態異常属性は属性ダメージ 0', () => {
  // (200 + 10) × (1 + 0.20 × 0.25) = 220.5
  const r = comboExpected({
    weapon: { attack: 200, affinity: 0, element: null }, sharpness: 'yellow', skills: [], effects: EFFECTS,
    motions: ONE_PHYS_HIT, combo: ['m'], target: { hitzone: { slash: 100 } }, buffs: { attackAdd: 10, affinityAdd: 20 },
  });
  close(r.total, 220.5);
  // 毒 300 の武器: 物理 100 × 1.0 (黄) = 100、属性 0
  const p = comboExpected({
    weapon: { attack: 100, affinity: 0, element: { type: 'poison', value: 300 } }, sharpness: 'yellow', skills: [],
    effects: EFFECTS, motions: ONE_HIT, combo: ['m'], target: { hitzone: { slash: 100, fire: 100 } },
  });
  assert.equal(p.element, 0);
  close(p.total, 100);
});

test('鈍器使いは指定の色以下でだけ物理に掛かる', () => {
  const lvs = EFFECTS.effects[skillIdByName('鈍器使い')].levels;
  const st1 = stats({ attack: 100, affinity: 0, element: null }, [lvs[0]]);   // Lv1: 黄以下 ×1.05
  close(hitDamage(HIT, st1, { hitzone: { slash: 100 }, sharpness: 'orange' }).physical, 78.75);  // 100 × 0.75 × 1.05
  close(hitDamage(HIT, st1, { hitzone: { slash: 100 }, sharpness: 'blue' }).physical, 120);      // 掛からない
  const st3 = stats({ attack: 100, affinity: 0, element: null }, [lvs[2]]);   // Lv3: 緑以下 ×1.1
  close(hitDamage(HIT, st3, { hitzone: { slash: 100 }, sharpness: 'green' }).physical, 115.5);   // 100 × 1.05 × 1.1
});

test('Lv を最大より大きく渡すと最大 Lv で計算する (攻撃 Lv7 → Lv5)', () => {
  const r = resolveSkills([{ skillId: skillIdByName('攻撃'), level: 7 }], EFFECTS);
  assert.equal(r.active[0].level, 5);
  close(comboExpected({
    weapon: { attack: 200, affinity: 0, element: null }, sharpness: 'yellow',
    skills: [{ skillId: skillIdByName('攻撃'), level: 7 }], effects: EFFECTS, motions: ONE_PHYS_HIT, combo: ['m'],
    target: { hitzone: { slash: 100 } },
  }).total, 217);
});

// ------------------------------------------------------------------ 検証役の指摘への対応 (model-fix) で足したテスト

test('傷口の無い部位 (wound: null) に傷口の段を当てると、傷口専用ヒットも弱点特効の傷口分も入れず警告する', () => {
  const combo = COMBOS.combos.find((c) => c.id === 'focus_wound');
  assert.equal(combo.steps[0].onWound, true);
  const wex = skillIdByName('弱点特効');
  const base = {
    weapon: { attack: 200, affinity: 0, element: null }, sharpness: 'white',
    skills: [{ skillId: wex, level: 5 }], effects: EFFECTS, motions: MOTIONS, combo,
  };
  // 物理肉質 30 (弱点でない): 集中急所突きの 1 ヒット目 (MV15) だけ、会心 0%
  //   200 × 0.15 × 0.30 × 1.32 = 11.88 (傷口の追加ヒットを数えると 23.76、傷口の会心 20% を入れると 12.474)
  const r = comboExpected({ ...base, target: { hitzone: { slash: 30 }, wound: null } });
  close(r.physical, 11.88);
  assert.equal(r.steps[0].isWound, false);
  assert.deepEqual(r.warnings.map((w) => w.code), ['no-wound']);
  assert.match(r.warnings[0].message, /この部位には傷口ができません/);
  // 物理肉質 50 (弱点): 弱点特効の有効部位の 30% だけ → 1.075。200 × 0.15 × 0.50 × 1.32 × 1.075 = 21.285
  close(comboExpected({ ...base, target: { hitzone: { slash: 50 }, wound: null } }).physical, 21.285);
  // wound を渡さない (undefined) のも傷口なし扱い
  close(comboExpected({ ...base, target: { hitzone: { slash: 30 } } }).physical, 11.88);
  // isWound (全段を傷口で) でも、部位に傷口が無ければ同じ
  const iw = comboExpected({ ...base, combo: ['aim_attack_wound'], target: { hitzone: { slash: 30 }, wound: null, isWound: true } });
  close(iw.physical, 11.88);
  assert.deepEqual(iw.warnings.map((w) => w.code), ['no-wound']);
  // 傷口がある部位なら今までどおり: (15 + 15) × 2 × 0.60 × 1.32 × 1.125 = 53.46、警告なし
  const ok = comboExpected({ ...base, target: { hitzone: { slash: 30 }, wound: { slash: 60 } } });
  close(ok.physical, 53.46);
  assert.deepEqual(ok.warnings, []);
});

test('傷口に当てない段では、傷口でだけ出るヒットを数えない', () => {
  const hits = (id) => MOTIONS.moves.find((m) => m.id === id).hits;
  assert.deepEqual(hits('aim_attack_wound').map(isWoundOnlyHit), [false, true]);
  assert.deepEqual(hits('aim_attack_old_scar').map(isWoundOnlyHit), [false, true, true]);
  assert.ok(MOTIONS.moves.filter((m) => !m.id.startsWith('aim_attack')).every((m) => !m.hits.some(isWoundOnlyHit)));
  // woundOnly の項目があればラベルより優先
  assert.equal(isWoundOnlyHit({ label: '傷口の追加ヒット', woundOnly: false }), false);
  assert.equal(isWoundOnlyHit({ label: '', woundOnly: true }), true);
  // onWound の無い段: 200 × 0.15 × 0.50 × 1.32 = 19.8 (1 ヒットだけ)
  const r = comboExpected({
    weapon: { attack: 200, affinity: 0, element: null }, sharpness: 'white', skills: [], effects: EFFECTS,
    motions: MOTIONS, combo: ['aim_attack_wound'], target: { hitzone: { slash: 50 }, wound: { slash: 60 } },
  });
  close(r.physical, 19.8);
  assert.deepEqual(r.warnings.map((w) => w.code), ['wound-only-hits-skipped']);
});

test('火竜の力 (灼熱化) は技のつなぎの秒数が見積もりなので確度 low。計算に使うと lowConfidence に必ず入る', () => {
  const id = skillIdByName('火竜の力');
  const e = EFFECTS.effects[id];
  assert.equal(e.confidence, 'low');
  // 理由の文 (画面の「くわしく」に出る) は、値の読みではなく技のつなぎの秒数
  assert.match(e.note, /^確度 low の理由: 技のつなぎの秒数が見積もり/);
  assert.doesNotMatch(e.note, /別の読み/);
  // [3..6] は下位の値とみられる (Ⅰ 固定20+火24 / Ⅱ 固定30+火60。火は内部値)。lowRank に残し、計算には使わない
  assert.match(e.note, /20\+24/);
  assert.match(e.note, /30\+60/);
  assert.deepEqual(e.levels.map((l) => [l.extraDamage.lowRank.fixed, l.extraDamage.lowRank.element]), [[20, 240], [30, 600]]);
  assert.equal(e.levels.some((l) => 'extraDamageAlt' in l), false);
  // 計算は上位 (Ⅱ 固定40+火1200)
  assert.deepEqual([e.levels[1].extraDamage.fixed, e.levels[1].extraDamage.element], [40, 1200]);
  const input = {
    weapon: { attack: 200, affinity: 0, element: null }, sharpness: 'white', skills: [{ skillId: id, level: 2 }],
    effects: EFFECTS, motions: MOTIONS, combo: COMBOS.combos.find((c) => c.id === 'ground_basic'),
    target: { hitzone: { slash: 50, fire: 20 } },
  };
  const r = comboExpected(input);
  assert.ok(r.extra > 0);
  assert.deepEqual(r.lowConfidence.map((x) => [x.skillId, x.confidence]), [[id, 'low']]);
  assert.ok(r.lowConfidence[0].reason.length > 0);
  assert.deepEqual(skillContribution(input).lowConfidence.map((x) => x.skillId), [id]);
  // 効果 (Lv) 側に low が付いているだけでも lowConfidence に入る
  const fxs = { effects: { 9: fx([{ attackAdd: 1, confidence: 'low' }], { name: 'y', confidence: 'high' }) } };
  assert.equal(resolveSkills([{ skillId: 9, level: 1 }], fxs).lowConfidence.length, 1);
});
