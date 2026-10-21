// 数値の点検 (review-numbers) で確かめたことを残すテスト。
// - Game8 の片手剣最強装備 (https://game8.jp/mhwilds/668364、2026-10-21 に人が見て写した) の 2 構成で、
//   computeBuild の発動スキルが記事の一覧と同じになること (Game8 はデータの取り込み元にしない。照合だけ)。
// - 同時に起きない条件 (体力満タン / 赤ゲージ / 35% 以下) の期待値が、同時分布を手で組んで
//   1 パターンずつ (発動率 0 か 1) 計算した加重平均と一致すること。
// 実行: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { computeBuild, indexEquipData } from '../app/model/build.js';
import { comboExpected } from '../app/model/damage.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (name) => JSON.parse(readFileSync(join(ROOT, 'data', name), 'utf8'));
const SKILLS = load('skills.json');
const ARMOR = load('armor.json').armor;
const DECOS = load('decorations.json').decorations;
const EFFECTS = load('skill_effects.json');
const MOTIONS = load('motions_sns.json');
const MONSTERS = load('monsters.json').monsters;

const close = (actual, expected, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= eps * Math.max(1, Math.abs(expected)), `expected ${expected}, got ${actual}`);

// id は MHDB の採番なので名前で引く
const armorId = (name) => {
  const a = ARMOR.find((x) => x.name === name);
  assert.ok(a, `armor.json に ${name} が無い`);
  return a.id;
};
const decoId = (name) => {
  const d = DECOS.find((x) => x.name === name);
  assert.ok(d, `decorations.json に ${name} が無い`);
  return d.id;
};
const skillId = (name) => {
  const s = SKILLS.skills.find((x) => x.name === name);
  assert.ok(s, `skills.json に ${name} が無い`);
  return s.id;
};
const fixedCharmId = (name) => load('charms_fixed.json').charms.find((c) => c.name === name).id;
const bonuses = load('bonuses.json');
const setBonusId = (name) => bonuses.setBonuses.find((b) => b.name === name).id;
const groupBonusId = (name) => bonuses.groupBonuses.find((b) => b.name === name).id;

// 巨戟アーティア (属性激化・火 440) に 黒蝕竜の力 (シリーズ) と ヌシの魂 (グループ) を付けたもの (Game8 の武器欄)
const ARTIAN = {
  id: 'w-test', name: '破滅のキリエヴェルド (属性激化・火)', baseWeaponId: 1182, attack: 175, affinity: 0,
  element: { type: 'fire', value: 440 }, setBonusId: setBonusId('黒蝕竜の力'), groupBonusId: groupBonusId('ヌシの魂'),
};

function data(extraCharms = []) {
  return indexEquipData({
    skills: SKILLS, decorations: DECOS, bonuses, armor: ARMOR, weapons: load('weapons_sns.json'),
    myWeapons: [ARTIAN], charms: [...load('charms.json').charms, ...extraCharms], charmsFixed: load('charms_fixed.json'),
  });
}

/** 発動スキルを「名前 Lv」の集合に */
const skillSet = (r) => new Set(r.skills.map((s) => `${s.name} ${s.level}`));

test('Game8 属性攻撃特化: 発動スキルが記事の一覧と同じ (シリーズ 3 つ・ヌシの魂を含む)', () => {
  const r = computeBuild({
    weapon: 'w-test',
    armor: {
      head: armorId('クイーンピアスα'), chest: armorId('ゴグメイルα'), arms: armorId('ダハディラアームγ'),
      waist: armorId('ダハディラコイルγ'), legs: armorId('ゴググリーヴα'),
    },
    charm: fixedCharmId('痛撃の護石Ⅲ'),
    decorations: {
      weapon: ['業物・鉄壁珠【３】', '火炎・鉄壁珠【３】', '守勢・鉄壁珠【３】'].map(decoId),
      head: ['痛撃珠【３】', '抗狂珠【１】', '抗狂珠【１】'].map(decoId),
      chest: ['挑戦珠【３】', '渾身珠【２】'].map(decoId),
      arms: ['渾身珠【２】'].map(decoId),
      waist: ['抗狂珠【１】'].map(decoId),
      legs: ['刺撃珠【３】', '渾身珠【２】', '緩衝珠【１】'].map(decoId),
    },
  }, data());
  assert.deepEqual(r.errors, []);
  const want = [
    '業物 3', 'ガード性能 3', '攻めの守勢 3', '火属性攻撃強化 3',
    '挑戦者 5', '弱点特効 5', '渾身 3', '災禍転福 3', '無我の境地 3', '巧撃 2', '早食い 2', '拘束耐性 2', 'フルチャージ 2',
    '緩衝 1', '連撃 1', '鎖刃刺撃 1', '水場・油泥適応 1',
    '凍峰竜の反逆 1', '黒蝕竜の力 1', '巨戟龍の黙示録 1', 'ヌシの魂 1',
  ];
  assert.deepEqual(skillSet(r), new Set(want));
});

test('Game8 灼熱化+束縛反攻 (護火竜アームβ・グリーヴβ を限界突破): スロットと発動スキルが記事どおり', () => {
  const charm = {
    id: 'u-test', name: '栄世の護石', rarity: 8,
    skills: [{ skillId: skillId('見切り'), level: 3 }, { skillId: skillId('弱点特効'), level: 1 }],
    armorSlots: [1, 1, 0], weaponSlots: [1],
  };
  const r = computeBuild({
    weapon: 'w-test',
    armor: {
      head: armorId('クイーンピアスα'), chest: armorId('ダハディラメイルγ'), arms: armorId('護火竜アームβ'),
      waist: armorId('ダハディラコイルγ'), legs: armorId('護火竜グリーヴβ'),
    },
    limitBreak: { arms: true, legs: true },
    charm: 'u-test',
    decorations: {
      weapon: ['超心珠Ⅲ【３】', '達芸珠【３】', '守勢・鉄壁珠【３】'].map(decoId),
      head: ['痛撃珠【３】', '早食珠【１】', '早食珠【１】'].map(decoId),
      chest: ['渾身珠【２】', '渾身珠【２】'].map(decoId),
      arms: ['痛撃珠【３】', '渾身珠【２】', '早食珠【１】'].map(decoId),
      waist: ['抗狂珠【１】'].map(decoId),
      legs: ['刺撃珠【３】', '抗狂珠【１】'].map(decoId),
      charmWeapon: ['超心珠【１】'].map(decoId),
      charmArmor: ['抗狂珠【１】', '体術珠【１】'].map(decoId),
    },
  }, data([charm]));
  assert.deepEqual(r.errors, [], '限界突破後のスロット (③②① / ③①ー) に珠が全部入る');
  assert.deepEqual(r.slots.arms.map((s) => s.size), [3, 2, 1]);
  assert.deepEqual(r.slots.legs.map((s) => s.size), [3, 1, 0]);
  assert.deepEqual(r.limitBreak, { head: false, chest: false, arms: true, waist: false, legs: true });
  const want = [
    '超会心 4', '見切り 3', '攻めの守勢 3', 'ガード性能 1', '達人芸 1',
    '挑戦者 5', '弱点特効 5', '渾身 3', '無我の境地 3', '早食い 3', '拘束耐性 2', '体術 1', '連撃 1', '鎖刃刺撃 1', '風圧耐性 1',
    '火竜の力 1', '凍峰竜の反逆 1', '黒蝕竜の力 1', 'ヌシの魂 1',
  ];
  assert.deepEqual(skillSet(r), new Set(want));
});

// 注: 体力の 3 条件で動くスキルは今のデータでは攻撃力だけ (加算・乗算) なので、期待値は各条件の発動率 (周辺確率) で決まり、
// 同時分布の形 (相関) には左右されない。このテストが守るのは「入れた発動率がそのまま効く」こと
// (満タンでない割合で割り忘れる、などの誤りで落ちる)。
test('同時に起きない条件の期待値 = 同時分布を手で組んだ 1 パターンずつの加重平均 (発動率を動かしても一致)', () => {
  const skills = [['フルチャージ', 5], ['逆恨み', 5], ['火事場力', 5], ['挑戦者', 5]]
    .map(([n, lv]) => ({ skillId: skillId(n), level: lv }));
  const part = MONSTERS.find((m) => m.name === 'ゴア・マガラ').parts.find((p) => p.key === 'head');
  const base = {
    weapon: { attack: 210, affinity: 15, element: { type: 'thunder', value: 250 } }, sharpness: 'white', skills,
    effects: EFFECTS, motions: MOTIONS, combo: ['slash_1', 'slash_2', 'just_rush_3_just'],
    target: { hitzone: part.hitzone, wound: part.wound },
  };
  for (const [f, red, low, enr] of [[0.3, 0.6, 0.5, 0.7], [0.5, 0.5, 0.5, 0.5], [0, 0.2, 0.9, 1], [0.8, 0.2, 0.1, 0.25]]) {
    const got = comboExpected({ ...base, uptimes: { hpFull: f, redHp: red, hpLow: low, enraged: enr } }).total;
    // 満タン f。満タンでないとき (1-f) に 赤 red/(1-f)・35% 以下 low/(1-f) が独立。怒りは独立
    const rc = f < 1 ? red / (1 - f) : 0;
    const lc = f < 1 ? low / (1 - f) : 0;
    const joint = [[f, 1, 0, 0]];
    for (const r of [1, 0]) for (const l of [1, 0]) joint.push([(1 - f) * (r ? rc : 1 - rc) * (l ? lc : 1 - lc), 0, r, l]);
    let want = 0;
    for (const [w, ff, r, l] of joint) {
      for (const e of [1, 0]) {
        const we = w * (e ? enr : 1 - enr);
        if (we <= 0) continue;
        want += we * comboExpected({ ...base, uptimes: { hpFull: ff, redHp: r, hpLow: l, enraged: e } }).total;
      }
    }
    close(got, want, 1e-12);
  }
});
