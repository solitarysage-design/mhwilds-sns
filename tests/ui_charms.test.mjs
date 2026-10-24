// 護石タブ (app/ui/tabs/charms.js) と、ほかのタブの護石の名前 (シートから取り込んだ護石の No.・スロット未確認の印) のテスト。
// charms.js は 'preact/hooks' を名前で import するので、ui_search.test.mjs と同じく app/vendor に向ける。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const VENDOR = {
  preact: new URL('../app/vendor/preact.module.js', import.meta.url).href,
  'preact/hooks': new URL('../app/vendor/hooks.module.js', import.meta.url).href,
  htm: new URL('../app/vendor/htm.module.js', import.meta.url).href,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (VENDOR[specifier]) return nextResolve(VENDOR[specifier], context);
    return nextResolve(specifier, context);
  },
});

const { indexEquipData } = await import('../app/model/build.js');
const T = await import('../app/ui/tabs/charms.js');
const L = await import('../app/ui/tabs/equip_logic.js');
const F = await import('../app/ui/tabs/search_form.js');

const readJson = (rel) => JSON.parse(readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'));
const raw = {
  skills: readJson('data/skills.json'), decorations: readJson('data/decorations.json'), bonuses: readJson('data/bonuses.json'),
  armor: readJson('data/armor.json'), weapons: readJson('data/weapons_sns.json'), myWeapons: readJson('data/my_weapons.json'),
  charms: readJson('data/charms.json'), charmsFixed: readJson('data/charms_fixed.json'), rules: readJson('data/talisman_rules.json'),
};
const index = indexEquipData(raw);
const data = { index, talismanRules: raw.rules, charmsFixed: raw.charmsFixed, lists: { charms: raw.charms.charms, charmsFixed: raw.charmsFixed.charms } };
const ctx = T.ctxOf(data);
const entries = T.makeEntries(raw.charms.charms, [], ctx);
const ids = (list) => list.map((e) => e.charm.id);

test('シートの番号とスロット未確認の印', () => {
  const s088 = raw.charms.charms.find((c) => c.id === 's088');
  assert.equal(T.sheetLabel(s088), 'シート No.88');
  assert.equal(T.slotsUnconfirmed(s088), true);
  const c1 = raw.charms.charms.find((c) => c.id === 'c0001');
  assert.equal(T.sheetLabel(c1), 'シート No.5');
  assert.equal(T.slotsUnconfirmed(c1), false, 'c0001 のスロットは写真で確かめた');
  assert.equal(T.sheetLabel({ id: 'u0001', name: '秘歴の護石' }), '', 'この端末で足した護石には無い');
});

test('一覧を探す: 数はシートの No. (と番号)、言葉はスキルの名前など。絞り方は「スロット未確認」「注意・エラー」', () => {
  assert.deepEqual(ids(T.filterCharmEntries(entries, { query: '88' }, ctx)), ['s088']);
  assert.deepEqual(ids(T.filterCharmEntries(entries, { query: 'No.5' }, ctx)), ['c0001']);
  assert.deepEqual(ids(T.filterCharmEntries(entries, { query: 'no５' }, ctx)), ['c0001'], '全角の数・小文字');
  assert.deepEqual(ids(T.filterCharmEntries(entries, { query: 'c0001' }, ctx)), ['c0001']);
  const ko = T.filterCharmEntries(entries, { query: 'ko術' }, ctx);
  assert.ok(ko.length > 5 && ko.every((e) => e.charm.skills.some((s) => s.name === 'ＫＯ術')), '半角の KO術 でも全角の ＫＯ術 に当たる');
  const two = T.filterCharmEntries(entries, { query: 'ガード性能 属性吸収' }, ctx);
  assert.ok(two.length >= 2 && two.every((e) => e.charm.skills.some((s) => s.name === 'ガード性能') && e.charm.skills.some((s) => s.name === '属性吸収')));
  const counts = T.charmFilterCounts(entries);
  assert.equal(counts.all, entries.length);
  assert.equal(counts.unconfirmed, raw.charms.charms.filter((c) => c.slotsProvisional === true).length);
  assert.equal(counts.issue, entries.filter((e) => e.issues.length).length);
  assert.ok(T.filterCharmEntries(entries, { filter: 'unconfirmed' }, ctx).every((e) => e.charm.slotsProvisional === true));
  assert.ok(T.filterCharmEntries(entries, { filter: 'issue' }, ctx).every((e) => e.issues.length > 0));
  assert.equal(T.filterCharmEntries(entries, { query: 'ない言葉' }, ctx).length, 0);
  assert.equal(T.filterCharmEntries(entries, {}, ctx).length, entries.length);
});

test('ほかのタブ: 装備タブの一覧と探すタブの結果に、シートの No. と未確認の印', () => {
  const s088 = raw.charms.charms.find((c) => c.id === 's088');
  assert.equal(L.charmLabel(s088), '秘歴の護石 シート No.88');
  assert.match(L.charmSub(s088, index), /\(未確認\)/);
  const items = L.charmItems(index, raw.charms.charms, [], raw.charmsFixed.charms);
  const it = items.find((x) => x.value === 's088');
  assert.equal(it.label, '秘歴の護石 シート No.88');
  assert.match(it.keywords, /No\.88/);
  assert.equal(F.charmNameOf(index, 's088'), '秘歴の護石 (シート No.88)');
  assert.equal(F.charmNameOf(index, 'c0001'), '秘歴の護石 (シート No.5)');
  assert.equal(F.charmUnconfirmed(index, 's088'), true);
  assert.equal(F.charmUnconfirmed(index, 'c0001'), false);
  assert.equal(F.charmUnconfirmed(index, 187), false, '生産する護石');
  const lines = F.buildLines({ weapon: 1059, armor: {}, charm: 's088', decorations: {}, limitBreak: {} }, index);
  const charm = lines.find((l) => l.key === 'charm');
  assert.equal(charm.name, '秘歴の護石 (シート No.88)');
  assert.equal(charm.unconfirmed, true);
});
