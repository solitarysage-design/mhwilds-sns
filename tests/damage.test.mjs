// app/model/damage.js のテスト。期待値はすべて手計算 (式はコメントに書く)。
// 実行: node --test tests/*.test.mjs (Node 24 は `node --test tests/` のディレクトリ指定を受け付けない)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  DEFAULT_RULES, clampAffinity, critExpectation, critElementExpectation, elementCap, effectiveElement,
  sharpnessMultipliers, hitDamage, computeStats, aggregateModifiers, enumeratePatterns, comboExpected,
  skillContribution, resolveSkills,
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

test('属性値の上限は max(元+400, 元×2.3)', () => {
  // 元 100: 上限 max(500, 230) = 500。100 + 500 = 600 → 500
  assert.equal(elementCap(100), 500);
  assert.equal(effectiveElement(100, 1, 500), 500);
  // 元 400: 上限 max(800, 920) = 920。400 × 2 = 800 は上限以下
  assert.equal(effectiveElement(400, 2, 0), 800);
  // 400 × 2.5 = 1000 → 920
  close(effectiveElement(400, 2.5, 0), 920);
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

test('条件つきスキルは発動率で加重平均 (独立と仮定)', () => {
  const effects = { effects: {
    1: fx([{ attackAdd: 20, affinityAdd: 15 }], { name: '挑戦者', conditional: true, defaultUptime: 0.5 }),
    2: fx([{ attackAdd: 20 }], { name: 'フルチャージ', conditional: true, defaultUptime: 0.25 }),
  } };
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
  // 発動率を人が上書き: 挑戦者 1.0 → 228.25
  close(comboExpected({ ...base, skills: [{ skillId: 1, level: 1, uptime: 1 }] }).total, 228.25);
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
  // ゲームデータ: 確率 33%、上位Ⅱ 固定 40 + 火 1200 (表示) = 内部 120
  assert.deepEqual([lv2.extraDamage.chance, lv2.extraDamage.fixed, lv2.extraDamage.element], [0.33, 40, 1200]);
  const st = stats({ attack: 100, affinity: 0, element: null }, [lv2]);
  const hit = { ...HIT, mv: 0, additionalDamage: true };
  // 火肉質 20: 0.33 × (40 + 120 × 0.20) = 0.33 × 64 = 21.12
  close(hitDamage(hit, st, { hitzone: { slash: 50, fire: 20 }, sharpness: 'white' }).extra, 21.12);
  // 火肉質 0: 0.33 × 40 = 13.2 (肉質無視ではないが固定分は残る)
  close(hitDamage(hit, st, { hitzone: { slash: 50, fire: 0 }, sharpness: 'white' }).extra, 13.2);
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

test('連撃: 非発動側は 1〜4 ヒット目の効果 (whenInactive)', () => {
  const id = skillIdByName('連撃');
  const lv5 = EFFECTS.effects[id].levels[4];
  assert.deepEqual([lv5.attackAdd, lv5.elementAdd, lv5.whenInactive], [18, 140, { attackAdd: 5, elementAdd: 50 }]);
  const motions = { moves: [{ id: 'm', name: 'm', hits: [HIT] }] };
  const r = comboExpected({
    weapon: { attack: 100, affinity: 0, element: { type: 'fire', value: 200 } }, sharpness: 'yellow',
    skills: [{ skillId: id, level: 5, uptime: 0.5 }], effects: EFFECTS, motions, combo: ['m'],
    target: { hitzone: { slash: 100, fire: 100 } },
  });
  // 発動: 118 + 340/10 × 0.75 = 143.5、非発動: 105 + 250/10 × 0.75 = 123.75 → 平均 133.625
  close(r.total, 133.625);
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

test('パターンの重みの合計は 1。発動率 0/1 は列挙しない', () => {
  const active = [
    { conditional: true, uptime: 0.3 }, { conditional: true, uptime: 0.6 },
    { conditional: false, uptime: 1 }, { conditional: true, uptime: 0 }, { conditional: true, uptime: 1 },
  ];
  const p = enumeratePatterns(active);
  assert.equal(p.length, 4);
  close(p.reduce((s, x) => s + x.weight, 0), 1, 1e-12);
  assert.ok(p.every((x) => x.on[2] === true && x.on[3] === false && x.on[4] === true));
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
      { skillId: skillIdByName('挑戦者'), level: 5, uptime: 0.5 }],
    effects: EFFECTS, motions: MOTIONS, combo: JUST_RUSH(), target: { hitzone: { slash: 60, blunt: 60 } },
  });
  close(r.total, 867.28584096, 1e-6);
  assert.equal(r.patterns, 2);
});

test('乗算どうしは掛け合わせる (攻撃5 ×1.04 とヌシの魂 ×1.05、属性攻撃強化3 ×1.2 と巨戟龍の黙示録Ⅱ ×1.3)', () => {
  // 攻撃力 200 × 1.04 × 1.05 + 9 = 227.4
  // 属性値 300 × 1.2 × 1.3 + 60 + 40 = 568 (上限 max(700, 690) = 700 以下)
  // 1 ヒット (MV100・属性補正1・黄・肉質 100・会心 0%): 物理 227.4 / 属性 56.8 × 0.75 = 42.6
  const r = comboExpected({
    weapon: { attack: 200, affinity: 0, element: { type: 'fire', value: 300 } }, sharpness: 'yellow',
    skills: [{ skillId: skillIdByName('攻撃'), level: 5 }, { skillId: skillIdByName('ヌシの魂'), level: 1, uptime: 1 },
      { skillId: skillIdByName('火属性攻撃強化'), level: 3 }, { skillId: skillIdByName('巨戟龍の黙示録'), level: 2, uptime: 1 }],
    effects: EFFECTS, motions: ONE_HIT, combo: ['m'], target: { hitzone: { slash: 100, fire: 100 } },
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
