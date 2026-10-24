// app/model/charms.js のテスト。node --test tests/ で回す。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  validateCharm, toNakiSimRow, toNakiSimFields, toNakiSimText, parseNakiSimRow, parseNakiSimText,
  possibleRarities, findSkillByName, fixedCharmOf, charmKind, nextCharmId, normalizeSlots,
} from '../app/model/charms.js';

const readJson = (rel) => JSON.parse(fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'));
const skills = readJson('data/skills.json');
const rules = readJson('data/talisman_rules.json');
const charmsFixed = readJson('data/charms_fixed.json');
const myCharms = readJson('data/charms.json');

const S = (name) => {
  const s = findSkillByName(name, skills);
  if (!s) throw new Error(`テストの前提: ${name} が skills.json に無い`);
  return s;
};
const sk = (name, level) => ({ skillId: S(name).id, name, level });
const codes = (r) => r.errors.map((e) => e.code);
const warnCodes = (r) => r.warnings.map((e) => e.code);
const charm = (over) => ({
  name: '秘歴の護石', rarity: 7,
  skills: [sk('ガード性能', 3), sk('属性吸収', 1)],
  armorSlots: [2, 0, 0], weaponSlots: [0], ...over,
});
const check = (c) => validateCharm(c, rules, skills, { charmsFixed });

test('本人の最初の護石 (c0001) は検証を通る', () => {
  const c = myCharms.charms.find((x) => x.id === 'c0001');
  const r = check(c);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.kind, 'random');
  assert.deepEqual(r.warnings, []);
  assert.ok(r.matches.some((m) => m.exact && m.skillGroups.join() === '3,10,0'));
  assert.deepEqual(possibleRarities(c, rules, skills), [7]);
});

test('抽選表の前提: レア5〜8 があり、泣シミュの選択肢と矛盾しない', () => {
  assert.deepEqual(Object.keys(rules.rarities), ['5', '6', '7', '8']);
  assert.equal(rules.rarities['7'].name, '秘歴の護石');
  assert.equal(rules.meta.checks.nakiSimCompatible.ok, true);
  const nakiArmor = ['0,0,0', '1,0,0', '1,1,0', '1,1,1', '2,0,0', '2,1,0', '3,0,0'];
  for (const r of Object.values(rules.rarities)) {
    for (const p of r.slotPatterns) {
      assert.ok(nakiArmor.includes(p.armor.join()), p.armor.join());
      assert.ok(['0', '1'].includes(p.weapon.join()), p.weapon.join());
    }
  }
  // レア7 (秘歴) に武器用スロットは付かない
  assert.ok(rules.rarities['7'].slotPatterns.every((p) => p.weapon[0] === 0));
});

test('抽選表の前提: レア8 のスロット構成は 武① / 武①防① / 武①防①防① の 3 種だけ', () => {
  const got = rules.rarities['8'].slotPatterns.map((p) => `武[${p.weapon}] 防[${p.armor}]`).sort();
  assert.deepEqual(got, ['武[1] 防[0,0,0]', '武[1] 防[1,0,0]', '武[1] 防[1,1,0]']);
  // レア5〜7 には武器用スロットが付かない
  for (const k of ['5', '6', '7']) assert.ok(rules.rarities[k].slotPatterns.every((p) => p.weapon[0] === 0), k);
});

test('抽選表の前提: 防具スキルの上限 Lv (3スロ用=Lv1・2スロ用=Lv2・1スロ用=Lv3、例外つき)', () => {
  const max = (r, name) => rules.rarities[r].skillMaxLevel[String(S(name).id)];
  for (const r of ['5', '6', '7', '8']) {
    assert.equal(max(r, '挑戦者'), 1, `レア${r} 挑戦者 (3スロ用)`);
    assert.equal(max(r, '耳栓') <= 2, true, `レア${r} 耳栓 (2スロ用)`);
    assert.equal(max(r, '耐震'), 3, `レア${r} 耐震 (1スロ用)`);
    assert.equal(max(r, '体術'), 4, `レア${r} 体術 (1スロ用の例外: 最大 Lv5)`);
  }
  // レア5・6 は 2スロ用が Lv2 まで、レア7・8 は Lv1 まで (回避性能・火事場力・整備は 1 つ上)
  assert.equal(max('6', '耳栓'), 2);
  assert.equal(max('7', '耳栓'), 1);
  assert.equal(max('8', '回避性能'), 2);
  assert.ok(codes(check(charm({ skills: [sk('ガード性能', 3), sk('フルチャージ', 2)] }))).includes('level-over-pool-max'));
});

test('並び順は問わない', () => {
  const r = check(charm({ skills: [sk('属性吸収', 1), sk('ガード性能', 3)] }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('規則違反: レア度', () => {
  assert.ok(codes(check(charm({ rarity: 4, name: undefined }))).includes('rarity-unknown'));
  assert.ok(codes(check(charm({ rarity: 9, name: undefined }))).includes('rarity-unknown'));
  // 名前とレア度の食い違い (秘歴の護石はレア7)
  assert.ok(codes(check(charm({ rarity: 8 }))).includes('name-rarity-mismatch'));
  // 名前が鑑定護石の名前でも固定護石でもない → 警告だけ
  const r = check(charm({ name: 'お守り' }));
  assert.equal(r.ok, true);
  assert.deepEqual(warnCodes(r), ['name-unknown']);
});

test('規則違反: スロット構成', () => {
  // レア7 に武器用スロットは付かない
  assert.deepEqual(codes(check(charm({ weaponSlots: [1] }))), ['slots-not-possible']);
  // [1,1,1] は泣シミュにはあるが抽選表のどのレア度にも無い
  assert.deepEqual(codes(check(charm({ armorSlots: [1, 1, 1] }))), ['slots-not-possible']);
  // Lv4 のスロットは無い
  assert.deepEqual(codes(check(charm({ armorSlots: [4, 0, 0] }))), ['slot-invalid']);
  // 並びが違うだけなら同じ構成として扱う
  assert.equal(check(charm({ armorSlots: [0, 2] })).ok, true);
  assert.deepEqual(normalizeSlots([0, 1, 2], 3), [2, 1, 0]);
});

test('規則違反: スキルの種類・上限 Lv・抽選表に無いスキル', () => {
  assert.deepEqual(codes(check(charm({ skills: [{ skillId: 999999, level: 1 }, sk('属性吸収', 1)] }))), ['skill-unknown']);
  // シリーズスキルは護石に付かない
  assert.ok(codes(check(charm({ skills: [sk('ガード性能', 3), sk('巨戟龍の黙示録', 1)] }))).includes('skill-kind-invalid'));
  // ガード性能の最大は Lv3
  assert.ok(codes(check(charm({ skills: [sk('ガード性能', 4), sk('属性吸収', 1)] }))).includes('level-over-max'));
  // 抽選表に無いスキル (飛び込み)
  assert.ok(codes(check(charm({ skills: [sk('ガード性能', 3), sk('飛び込み', 1)] }))).includes('skill-not-in-pool'));
  // レア5 (未解) では武器スキルは Lv1 まで
  const r5 = check({ name: '未解の護石', rarity: 5, skills: [sk('ガード性能', 3), sk('体術', 2)], armorSlots: [1, 1, 0], weaponSlots: [0] });
  assert.ok(codes(r5).includes('level-over-pool-max'));
  assert.ok(codes(check(charm({ skills: [sk('ガード性能', 1), sk('属性吸収', 1), sk('攻撃', 1), sk('見切り', 1)] }))).includes('too-many-skills'));
  assert.ok(codes(check(charm({ skills: [sk('ガード性能', 3)] }))).includes('too-few-skills'));
});

test('規則違反: 武器スキル/防具スキルの枠', () => {
  // レア7 の 2 スキルの行は (武器, 防具) だけ。防具スキル 2 つは出ない
  const a = check(charm({ skills: [sk('挑戦者', 1), sk('体術', 2)], armorSlots: [1, 0, 0] }));
  assert.deepEqual(codes(a), ['skill-kind-position']);
  // レア5 (未解) は武器スキル 1 つ + 防具スキル。武器スキル 2 つは出ない
  const b = check({ name: '未解の護石', rarity: 5, skills: [sk('攻撃', 1), sk('見切り', 1)], armorSlots: [1, 1, 0], weaponSlots: [0] });
  assert.deepEqual(codes(b), ['skill-kind-position']);
});

test('規則違反: スキルとスロットの組み合わせ・表に無い組み合わせ', () => {
  // レア7 の [3,0,0] は (Lv2武器, Lv1武器, 防具群8) の行にしか付かない
  assert.deepEqual(codes(check(charm({ armorSlots: [3, 0, 0] }))), ['slots-skill-combination']);
  // ガード性能 Lv3 + 攻撃 Lv1 + 体術 Lv2: 武器2+防具1 の行はあるが Lv3 の武器スキルとは組まない
  const r = check(charm({ skills: [sk('ガード性能', 3), sk('攻撃', 1), sk('体術', 2)], armorSlots: [1, 0, 0] }));
  assert.deepEqual(codes(r), ['combination-not-in-table']);
});

test('警告: 表の Lv より低い / 同じスキルが 2 回', () => {
  const r = check(charm({ skills: [sk('ガード性能', 2), sk('属性吸収', 1)] }));
  assert.equal(r.ok, true);
  assert.deepEqual(warnCodes(r), ['not-exact']);
  const d = check({ name: '栄世の護石', rarity: 8, skills: [sk('攻撃', 2), sk('攻撃', 1), sk('攻撃', 1)], armorSlots: [0, 0, 0], weaponSlots: [1] });
  assert.ok(warnCodes(d).includes('duplicate-skill'));
});

test('固定護石との区別', () => {
  const fixed = charmsFixed.charms.find((c) => c.name === '痛撃の護石Ⅲ');
  assert.ok(fixed);
  const c = { name: '痛撃の護石Ⅲ', rarity: fixed.rarity, skills: fixed.skills, armorSlots: [0, 0, 0], weaponSlots: [0] };
  assert.equal(charmKind(c, charmsFixed), 'fixed');
  assert.equal(fixedCharmOf(c, charmsFixed).id, fixed.id);
  const r = check(c);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.kind, 'fixed');
  assert.deepEqual(codes(check({ ...c, armorSlots: [1, 0, 0] })), ['fixed-has-slots']);
  assert.deepEqual(codes(check({ ...c, skills: [sk('弱点特効', 2)] })), ['fixed-skills-mismatch']);
  assert.deepEqual(codes(check({ ...c, rarity: 5 })), ['fixed-rarity-mismatch']);
  assert.equal(charmKind(myCharms.charms[0], charmsFixed), 'random');
  // 固定護石 (スキルだけ) のレア度を鑑定護石として調べると、抽選表には当てはまらない
  assert.equal(check({ ...c, name: undefined }).ok, false);
});

test('泣シミュ形式: 12 項目の書き出し', () => {
  const c = myCharms.charms.find((x) => x.id === 'c0001'); // シートの護石は No. 順なので、c0001 は先頭とは限らない
  assert.equal(toNakiSimRow(c, skills), 'ガード性能,3,属性吸収,1,,0,2,0,0,0,0,0');
  const f = toNakiSimFields({ rarity: 8, skills: [sk('攻撃', 2), sk('見切り', 1), sk('挑戦者', 1)], armorSlots: [1, 0, 0], weaponSlots: [1] }, skills);
  assert.equal(f.length, 12);
  assert.deepEqual(f, ['攻撃', '2', '見切り', '1', '挑戦者', '1', '1', '0', '0', '1', '0', '0']);
  // 固定護石は一括書き出しから外す
  const fixed = charmsFixed.charms.find((x) => x.name === '痛撃の護石Ⅲ');
  const text = toNakiSimText([c, { name: fixed.name, rarity: fixed.rarity, skills: fixed.skills }], skills, { charmsFixed });
  assert.equal(text, 'ガード性能,3,属性吸収,1,,0,2,0,0,0,0,0');
});

test('泣シミュ形式: 往復 (書き出し → 読み込み) で同じ護石に戻る', () => {
  const samples = [
    myCharms.charms.find((x) => x.id === 'c0001'),
    { name: '栄世の護石', rarity: 8, skills: [sk('攻撃', 2), sk('見切り', 1), sk('挑戦者', 1)], armorSlots: [1, 0, 0], weaponSlots: [1] },
    { name: '未解の護石', rarity: 5, skills: [sk('ＫＯ術', 1), sk('回避性能', 2), sk('体術', 3)], armorSlots: [1, 1, 0], weaponSlots: [0] },
  ];
  for (const c of samples) {
    const row = toNakiSimRow(c, skills);
    const p = parseNakiSimRow(row, skills, { rarity: c.rarity, name: c.name, rules });
    assert.deepEqual(p.errors, [], row);
    assert.deepEqual(p.charm.skills.map((s) => [s.skillId, s.level]), c.skills.map((s) => [s.skillId, s.level]));
    assert.deepEqual(p.charm.armorSlots, normalizeSlots(c.armorSlots, 3));
    assert.deepEqual(p.charm.weaponSlots, normalizeSlots(c.weaponSlots, 1));
    assert.equal(toNakiSimRow(p.charm, skills), row);
    assert.ok(p.possibleRarities.includes(c.rarity), `${row} → ${p.possibleRarities}`);
    const v = validateCharm(p.charm, rules, skills);
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    assert.deepEqual(v.warnings, [], row);
  }
  const multi = parseNakiSimText(samples.map((c) => toNakiSimRow(c, skills)).join('\n') + '\n\n', skills);
  assert.equal(multi.length, 3);
  assert.ok(multi.every((x) => x.errors.length === 0));
});

test('泣シミュ形式: 読み込みのエラーと表記ゆれ', () => {
  assert.deepEqual(parseNakiSimRow('ガード性能,3,属性吸収,1,,0,2,0,0', skills).errors.map((e) => e.code), ['field-count']);
  assert.deepEqual(parseNakiSimRow('ガード性能X,3,,0,,0,1,0,0,0,0,0', skills).errors.map((e) => e.code), ['skill-unknown']);
  assert.deepEqual(parseNakiSimRow('ガード性能,0,,0,,0,1,0,0,0,0,0', skills).errors.map((e) => e.code), ['level-invalid']);
  assert.deepEqual(parseNakiSimRow('ガード性能,3,,0,,0,4,0,0,0,0,0', skills).errors.map((e) => e.code), ['slot-invalid']);
  assert.deepEqual(parseNakiSimRow('ガード性能,3,,0,,0,1,0,0,1,1,0', skills).errors.map((e) => e.code), ['slot-invalid']);
  // 半角の KO術 → 全角の ＫＯ術 に読む
  const p = parseNakiSimRow('KO術,1,体術,2,回避性能,2,1,1,0,0,0,0', skills);
  assert.deepEqual(p.errors, []);
  assert.equal(p.charm.skills[0].name, 'ＫＯ術');
  assert.deepEqual(p.warnings.map((w) => w.code), ['skill-name-normalized']);
});

test('nextCharmId は連番', () => {
  assert.equal(nextCharmId(myCharms), 'c0002');
  assert.equal(nextCharmId({ charms: [] }), 'c0001');
});
