// app/model/build.js のテスト。node --test tests/ で回す。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computeBuild, indexEquipData, decorationFitError, targetKind } from '../app/model/build.js';

const readJson = (rel) => JSON.parse(fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'));

// ---------------------------------------------------------------- 小さな作り物のデータ (期待値を手で書ける)
const fx = {
  skills: [
    { id: 1, name: '攻撃', kind: 'weapon', maxLevel: 5 },
    { id: 2, name: '見切り', kind: 'weapon', maxLevel: 5 },
    { id: 3, name: '体術', kind: 'armor', maxLevel: 5 },
    { id: 10, name: '鎖刃竜の飢餓', kind: 'set', maxLevel: 2 },
    { id: 11, name: '巨戟龍の黙示録', kind: 'set', maxLevel: 2 },
    { id: 20, name: 'ヌシの魂', kind: 'group', maxLevel: 1 },
  ],
  decorations: [
    { id: 100, name: '攻撃珠【１】', kind: 'weapon', slot: 1, skills: [{ skillId: 1, level: 1 }] },
    { id: 101, name: '攻撃珠Ⅲ【３】', kind: 'weapon', slot: 3, skills: [{ skillId: 1, level: 3 }] },
    { id: 102, name: '体術珠【１】', kind: 'armor', slot: 1, skills: [{ skillId: 3, level: 1 }] },
    { id: 103, name: '体術珠Ⅱ【２】', kind: 'armor', slot: 2, skills: [{ skillId: 3, level: 2 }] },
  ],
  bonuses: {
    setBonuses: [
      { id: 3, name: '鎖刃竜の飢餓', skillId: 10, ranks: [{ pieces: 2, level: 1 }, { pieces: 4, level: 2 }] },
      { id: 42, name: '巨戟龍の黙示録', skillId: 11, ranks: [{ pieces: 2, level: 1 }, { pieces: 4, level: 2 }] },
    ],
    groupBonuses: [{ id: 7, name: 'ヌシの魂', skillId: 20, pieces: 3, level: 1 }],
  },
  armor: [
    { id: 1, name: '頭A', part: 'head', slots: [3, 1, 0], skills: [{ skillId: 1, level: 2 }], setBonusId: 3, groupBonusId: null },
    { id: 2, name: '胴A', part: 'chest', slots: [1, 0, 0], skills: [{ skillId: 1, level: 2 }], setBonusId: 3, groupBonusId: 7 },
    { id: 3, name: '腕A', part: 'arms', slots: [2, 0, 0], skills: [{ skillId: 3, level: 1 }], setBonusId: 3, groupBonusId: 7 },
    { id: 4, name: '腰A', part: 'waist', slots: [0, 0, 0], skills: [], setBonusId: 3, groupBonusId: 7 },
    { id: 5, name: '脚B', part: 'legs', slots: [1, 1, 1], skills: [{ skillId: 2, level: 1 }], setBonusId: null, groupBonusId: null },
    { id: 6, name: '脚A', part: 'legs', slots: [0, 0, 0], skills: [], setBonusId: 3, groupBonusId: null },
    // ゴグ系: シリーズスキルを 2 つ持つ部位
    { id: 7, name: '頭G', part: 'head', slots: [0, 0, 0], skills: [], setBonusId: 42, setBonusIds: [42, 3], groupBonusId: null },
  ],
  weapons: [
    { id: 1059, name: '片手剣X', slots: [3, 1, 0], skills: [{ skillId: 1, level: 1 }] },
  ],
  myWeapons: { schema: 1, weapons: [
    { id: 'w0001', name: '巨戟 (属性激化)', baseWeaponId: 1059, slots: [3, 3, 3], setBonusId: 3, groupBonusId: 7 },
  ] },
  charms: { schema: 1, charms: [
    { id: 'c0001', name: '秘歴の護石', rarity: 7, skills: [{ skillId: 2, level: 2 }], armorSlots: [2, 0, 0], weaponSlots: [0] },
    { id: 'c0002', name: '栄世の護石', rarity: 8, skills: [{ skillId: 1, level: 1 }], armorSlots: [1, 0, 0], weaponSlots: [1] },
  ] },
};
const idx = indexEquipData(fx);
const lv = (r, id) => r.skillLevels[id] ?? 0;
const codes = (r) => r.errors.map((e) => e.code);

test('スキル合計: 武器・防具・護石・装飾品を足す', () => {
  const r = computeBuild({
    weapon: 1059,
    armor: { head: 1, legs: 5 },
    charm: 'c0001',
    decorations: { weapon: [101, 100], head: [103, 102], charmArmor: [102] },
  }, idx);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  // 攻撃: 武器1 + 頭2 + 攻撃珠Ⅲ3 + 攻撃珠1 = 7 → 上限5
  // 体術: 体術珠Ⅱ2 + 体術珠1 (頭) + 体術珠1 (護石) = 4
  // 見切り: 脚1 + 護石2 = 3
  assert.equal(lv(r, 3), 4);
  assert.equal(lv(r, 2), 3);
  const atk = r.skills.find((s) => s.skillId === 1);
  assert.equal(atk.rawLevel, 7);
  assert.equal(atk.level, 5);
  assert.equal(atk.overLimit, true);
  assert.equal(atk.sources.length, 4);
});

test('上限 Lv で切る / 上限以内はそのまま', () => {
  const r = computeBuild({ weapon: 1059, armor: { head: 1, chest: 2 } }, idx);
  assert.equal(lv(r, 1), 5); // 1 + 2 + 2
  const s = r.skills.find((x) => x.skillId === 1);
  assert.equal(s.overLimit, false);
  const r2 = computeBuild({ weapon: 1059, armor: { head: 1, chest: 2 }, decorations: { weapon: [101] } }, idx);
  assert.equal(lv(r2, 1), 5);
  assert.equal(r2.skills.find((x) => x.skillId === 1).rawLevel, 8);
});

test('シリーズスキル: 1部位は無し・2部位でⅠ・3部位もⅠ・4部位でⅡ', () => {
  const cases = [
    [{ head: 1 }, 0],
    [{ head: 1, chest: 2 }, 1],
    [{ head: 1, chest: 2, arms: 3 }, 1],
    [{ head: 1, chest: 2, arms: 3, waist: 4 }, 2],
    [{ head: 1, chest: 2, arms: 3, waist: 4, legs: 6 }, 2],
  ];
  for (const [armor, want] of cases) {
    const r = computeBuild({ armor }, idx);
    assert.equal(lv(r, 10), want, JSON.stringify(armor));
    const sb = r.setBonuses.find((b) => b.bonusId === 3);
    assert.equal(sb.pieces, Object.keys(armor).length);
    assert.equal(sb.active, want > 0);
  }
  const r = computeBuild({ armor: { head: 1, chest: 2 } }, idx);
  assert.deepEqual(r.setBonuses[0].next, { pieces: 4, level: 2 });
});

test('グループスキル: 3部位で発動・2部位では発動しない', () => {
  const r2 = computeBuild({ armor: { chest: 2, arms: 3 } }, idx);
  assert.equal(lv(r2, 20), 0);
  assert.equal(r2.groupBonuses[0].active, false);
  assert.equal(r2.groupBonuses[0].required, 3);
  const r3 = computeBuild({ armor: { chest: 2, arms: 3, waist: 4 } }, idx);
  assert.equal(lv(r3, 20), 1);
  assert.equal(r3.groupBonuses[0].active, true);
});

test('巨戟アーティア: 武器のシリーズ/グループスキルを1部位として数える', () => {
  // 防具 1 部位 + 武器 = 2 部位 → シリーズⅠ
  const r = computeBuild({ weapon: 'w0001', armor: { head: 1 } }, idx);
  assert.equal(lv(r, 10), 1);
  assert.deepEqual(r.setBonuses.find((b) => b.bonusId === 3).from, ['head', 'weapon']);
  // 防具 3 部位 + 武器 = 4 部位 → シリーズⅡ
  const r4 = computeBuild({ weapon: 'w0001', armor: { head: 1, chest: 2, arms: 3 } }, idx);
  assert.equal(lv(r4, 10), 2);
  // グループ: 防具 2 部位 + 武器 = 3 → 発動
  const g = computeBuild({ weapon: 'w0001', armor: { chest: 2, arms: 3 } }, idx);
  assert.equal(lv(g, 20), 1);
  // 所持武器のスロット・スキルは my_weapons 側 (無ければ元の武器) を使う
  assert.deepEqual(r.slots.weapon.map((s) => s.size), [3, 3, 3]);
  assert.equal(lv(r, 1), 3); // 元の武器の 攻撃1 + 頭A の 攻撃2
});

test('シリーズスキルを 2 つ持つ部位 (setBonusIds) は両方に数える', () => {
  const r = computeBuild({ armor: { head: 7, chest: 2 } }, idx);
  assert.equal(r.setBonuses.find((b) => b.bonusId === 3).pieces, 2);
  assert.equal(r.setBonuses.find((b) => b.bonusId === 42).pieces, 1);
  assert.equal(lv(r, 10), 1);
  assert.equal(lv(r, 11), 0);
});

test('setBonusIds に同じ id が 2 つあっても 1 部位として数える', () => {
  const head = { id: 99, name: '頭D', part: 'head', slots: [0, 0, 0], skills: [], setBonusId: 3, setBonusIds: [3, 3], groupBonusId: null };
  const r = computeBuild({ armor: { head } }, idx);
  assert.equal(r.setBonuses.find((b) => b.bonusId === 3).pieces, 1);
  assert.equal(lv(r, 10), 0);
});

test('グループスキルの必要部位数は bonuses.json の pieces に従う (3 固定にしない)', () => {
  const g2 = indexEquipData({
    ...fx,
    bonuses: { setBonuses: fx.bonuses.setBonuses, groupBonuses: [{ id: 7, name: '仮の2部位グループ', skillId: 20, pieces: 2, level: 1 }] },
  });
  const r = computeBuild({ armor: { chest: 2, arms: 3 } }, g2);
  assert.equal(r.groupBonuses[0].required, 2);
  assert.equal(r.groupBonuses[0].active, true);
  assert.equal(lv(r, 20), 1);
});

test('固定護石 (armorSlots/weaponSlots を持たない) はスロットの行を作らない', () => {
  const fixed = { name: '痛撃の護石Ⅲ', rarity: 6, skills: [{ skillId: 1, level: 1 }] };
  const r = computeBuild({ charm: fixed }, idx);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.slots.charmArmor, []);
  assert.deepEqual(r.slots.charmWeapon, []);
  assert.equal(r.slotSummary.armor.total, 0);
  assert.equal(lv(r, 1), 1);
  assert.deepEqual(codes(computeBuild({ charm: fixed, decorations: { charmArmor: [102] } }, idx)), ['slot-missing']);
});

test('低 Lv の珠は高 Lv スロットに入る / 入らない珠はエラーでスキルに数えない', () => {
  const ok = computeBuild({ armor: { head: 1 }, decorations: { head: [102] } }, idx); // Lv1 珠 → Lv3 スロット
  assert.equal(ok.ok, true);
  assert.equal(lv(ok, 3), 1);
  const bad = computeBuild({ armor: { head: 1 }, decorations: { head: [null, 103] } }, idx); // Lv2 珠 → Lv1 スロット
  assert.equal(bad.ok, false);
  assert.deepEqual(codes(bad), ['deco-too-large']);
  assert.equal(bad.errors[0].target, 'head');
  assert.equal(bad.errors[0].index, 1);
  assert.equal(lv(bad, 3), 0);
  // 武器の Lv1 スロットに Lv3 珠
  const w = computeBuild({ weapon: 1059, decorations: { weapon: [null, 101] } }, idx);
  assert.deepEqual(codes(w), ['deco-too-large']);
});

test('武器用の珠を防具スロットに入れたらエラー (逆も)', () => {
  const r = computeBuild({ armor: { head: 1 }, decorations: { head: [100] } }, idx);
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['deco-kind-mismatch']);
  assert.equal(lv(r, 1), 2); // 頭の 攻撃2 だけ (珠は数えない)
  const r2 = computeBuild({ weapon: 1059, decorations: { weapon: [102] } }, idx);
  assert.deepEqual(codes(r2), ['deco-kind-mismatch']);
  // 護石: 武器用スロットには武器用の珠だけ、防具用スロットには防具用の珠だけ
  const c = computeBuild({ charm: 'c0002', decorations: { charmWeapon: [100], charmArmor: [102] } }, idx);
  assert.equal(c.ok, true, JSON.stringify(c.errors));
  const c2 = computeBuild({ charm: 'c0002', decorations: { charmArmor: [100] } }, idx);
  assert.deepEqual(codes(c2), ['deco-kind-mismatch']);
  const c3 = computeBuild({ charm: 'c0002', decorations: { charmWeapon: [102] } }, idx);
  assert.deepEqual(codes(c3), ['deco-kind-mismatch']);
});

test('スロットが無い・装備が無い・部位違い・不明な id はエラー', () => {
  assert.deepEqual(codes(computeBuild({ armor: { head: 1 }, decorations: { head: [null, null, 102] } }, idx)), ['slot-missing']);
  assert.deepEqual(codes(computeBuild({ armor: { head: 1 }, decorations: { head: [null, null, null, 102] } }, idx)), ['slot-missing']);
  assert.deepEqual(codes(computeBuild({ decorations: { chest: [102] } }, idx)), ['no-equipment']);
  assert.deepEqual(codes(computeBuild({ armor: { head: 2 } }, idx)), ['armor-part-mismatch']);
  assert.deepEqual(codes(computeBuild({ armor: { head: 999 } }, idx)), ['unknown-armor']);
  assert.deepEqual(codes(computeBuild({ armor: { head: 1 }, decorations: { head: [999] } }, idx)), ['unknown-decoration']);
  assert.deepEqual(codes(computeBuild({ decorations: { shield: [100] } }, idx)), ['unknown-target']);
  assert.deepEqual(codes(computeBuild({ weapon: 'w9999' }, idx)), ['unknown-weapon']);
});

test('スロットの集計: 武器用 (武器+護石の武器用) と防具用 (防具+護石の防具用) に分ける', () => {
  const r = computeBuild({
    weapon: 1059, armor: { head: 1 }, charm: 'c0002',
    decorations: { weapon: [101], head: [102], charmWeapon: [100] },
  }, idx);
  assert.equal(r.ok, true);
  assert.deepEqual(r.slotSummary.weapon, { total: 3, used: 2, free: 1, freeBySize: { 1: 1, 2: 0, 3: 0 } });
  assert.deepEqual(r.slotSummary.armor, { total: 3, used: 1, free: 2, freeBySize: { 1: 2, 2: 0, 3: 0 } });
  assert.equal(r.slots.head[0].decorationId, 102);
  assert.equal(r.slots.head[1].decorationId, null);
});

test('decorationFitError / targetKind', () => {
  assert.equal(targetKind('charmWeapon'), 'weapon');
  assert.equal(targetKind('legs'), 'armor');
  assert.equal(decorationFitError(fx.decorations[0], 'weapon', 3), null);
  assert.equal(decorationFitError(fx.decorations[1], 'weapon', 2), 'deco-too-large');
  assert.equal(decorationFitError(fx.decorations[0], 'armor', 3), 'deco-kind-mismatch');
  assert.equal(decorationFitError(fx.decorations[0], 'weapon', 0), 'slot-missing');
});

// ---------------------------------------------------------------- 実データ (data/*.json)
const real = {
  skills: readJson('data/skills.json'),
  decorations: readJson('data/decorations.json'),
  bonuses: readJson('data/bonuses.json'),
  armor: readJson('data/armor.json'),
  weapons: readJson('data/weapons_sns.json'),
  charms: readJson('data/charms.json'),
  charmsFixed: readJson('data/charms_fixed.json'),
};
const ridx = indexEquipData(real);
const armorByName = (n) => real.armor.armor.find((a) => a.name === n);
const skillByName = (n) => real.skills.skills.find((s) => s.name === n);
const decoByName = (n) => real.decorations.decorations.find((d) => d.name === n);

test('実データ: ゴグα 5部位 + 巨戟アーティア (黙示録) で 巨戟龍の黙示録Ⅱ、部位ごとのシリーズは 1 部位', () => {
  const parts = { head: 'ゴグヘルムα', chest: 'ゴグメイルα', arms: 'ゴグアームα', waist: 'ゴグコイルα', legs: 'ゴググリーヴα' };
  const armor = Object.fromEntries(Object.entries(parts).map(([p, n]) => [p, armorByName(n).id]));
  const apoc = real.bonuses.setBonuses.find((b) => b.name === '巨戟龍の黙示録');
  const weapon = { ...real.weapons.weapons.find((w) => w.id === 1182), setBonusId: apoc.id, groupBonusId: null };
  const r = computeBuild({ weapon, armor }, ridx);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const sb = r.setBonuses.find((b) => b.bonusId === apoc.id);
  assert.equal(sb.pieces, 6);
  assert.equal(r.skillLevels[apoc.skillId], 2);
  // 部位ごとの 2 つめのシリーズスキル (白熾龍の脈動 など) は 1 部位なので発動しない
  for (const b of r.setBonuses) if (b.bonusId !== apoc.id) assert.equal(b.active, false, b.name);
});

test('実データ: 所持護石 c0001 (秘歴の護石・防具用 Lv2) に珠を入れる', () => {
  const guard = skillByName('ガード性能');
  const lv1armor = real.decorations.decorations.find((d) => d.kind === 'armor' && d.slot === 1);
  const lv3armor = real.decorations.decorations.find((d) => d.kind === 'armor' && d.slot === 3);
  const ok = computeBuild({ charm: 'c0001', decorations: { charmArmor: [lv1armor.id] } }, ridx);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.skillLevels[guard.id], 3);
  const big = computeBuild({ charm: 'c0001', decorations: { charmArmor: [lv3armor.id] } }, ridx);
  assert.deepEqual(codes(big), ['deco-too-large']);
  const weaponDeco = decoByName('鉄壁珠【１】') || real.decorations.decorations.find((d) => d.kind === 'weapon' && d.slot === 1);
  const w = computeBuild({ charm: 'c0001', decorations: { charmArmor: [weaponDeco.id] } }, ridx);
  assert.deepEqual(codes(w), ['deco-kind-mismatch']);
  const w2 = computeBuild({ charm: 'c0001', decorations: { charmWeapon: [weaponDeco.id] } }, ridx);
  assert.deepEqual(codes(w2), ['slot-missing']); // 秘歴の護石に武器用スロットは無い
});

test('実データ: ガード性能 Lv3 (護石) + 鉄壁珠 は上限 3 で切る', () => {
  const guard = skillByName('ガード性能');
  const deco = real.decorations.decorations.find((d) => d.kind === 'weapon' && d.skills.length === 1 && d.skills[0].skillId === guard.id && d.slot === 1);
  const r = computeBuild({ weapon: 1182, charm: 'c0001', decorations: { weapon: [deco.id] } }, ridx);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const s = r.skills.find((x) => x.skillId === guard.id);
  assert.equal(s.rawLevel, 4);
  assert.equal(s.level, 3);
  assert.equal(s.overLimit, true);
});
