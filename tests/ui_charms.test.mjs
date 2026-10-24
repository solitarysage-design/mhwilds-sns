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
// シートの護石のうち、スロット未確認の護石 (unconf) と確かめた護石 (conf) を 1 つずつ使う。どちらが何個あるかはデータ次第
// (いまは確かめたシートの護石が無い。スロットを読み直した CSV で作り直すと未確認が無くなる) なので、データに無ければ
// シートの護石の写しで作って一覧と索引に足す (シートの No. は 9001・9002。シートの行とは重ならない)
const sheetCharms = raw.charms.charms.filter((c) => /^s\d+$/.test(c.id));
const extras = [];
const pick = (provisional, no) => {
  const found = sheetCharms.find((c) => c.slotsProvisional === provisional);
  if (found) return found;
  const made = { ...sheetCharms[0], id: `s${no}`, sheetNo: no, slotsProvisional: provisional };
  extras.push(made);
  return made;
};
const unconf = pick(true, 9001);
const conf = pick(false, 9002);
const charmList = [...raw.charms.charms, ...extras];
const index = indexEquipData({ ...raw, charms: { schema: 1, charms: charmList } });
const data = { index, talismanRules: raw.rules, charmsFixed: raw.charmsFixed, lists: { charms: charmList, charmsFixed: raw.charmsFixed.charms } };
const ctx = T.ctxOf(data);
const entries = T.makeEntries(charmList, [], ctx);
const ids = (list) => list.map((e) => e.charm.id);

test('シートの番号とスロット未確認の印', () => {
  const s088 = raw.charms.charms.find((c) => c.id === 's088');
  assert.equal(T.sheetLabel(s088), 'シート No.88');
  assert.equal(T.sheetLabel(unconf), `シート No.${unconf.sheetNo}`);
  assert.equal(T.slotsUnconfirmed(unconf), true);
  assert.equal(T.slotsUnconfirmed(conf), false, '確かめたシートの護石には印が無い');
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
  assert.equal(counts.unconfirmed, charmList.filter((c) => c.slotsProvisional === true).length);
  assert.ok(counts.unconfirmed >= 1);
  assert.equal(counts.issue, entries.filter((e) => e.issues.length).length);
  const un = T.filterCharmEntries(entries, { filter: 'unconfirmed' }, ctx);
  assert.ok(un.every((e) => e.charm.slotsProvisional === true));
  assert.ok(ids(un).includes(unconf.id) && !ids(un).includes(conf.id) && !ids(un).includes('c0001'));
  assert.ok(T.filterCharmEntries(entries, { filter: 'issue' }, ctx).every((e) => e.issues.length > 0));
  assert.equal(T.filterCharmEntries(entries, { query: 'ない言葉' }, ctx).length, 0);
  assert.equal(T.filterCharmEntries(entries, {}, ctx).length, entries.length);
});

test('ほかのタブ: 装備タブの一覧と探すタブの結果に、シートの No. と未確認の印', () => {
  const s088 = raw.charms.charms.find((c) => c.id === 's088');
  assert.equal(L.charmLabel(s088), '秘歴の護石 シート No.88');
  assert.equal(F.charmNameOf(index, 's088'), '秘歴の護石 (シート No.88)');
  assert.equal(F.charmNameOf(index, 'c0001'), '秘歴の護石 (シート No.5)');
  const items = L.charmItems(index, charmList, [], raw.charmsFixed.charms);
  for (const [c, want] of [[unconf, true], [conf, false]]) {
    const label = `${c.name} シート No.${c.sheetNo}`;
    assert.equal(L.charmLabel(c), label);
    assert.equal(/\(未確認\)/.test(L.charmSub(c, index)), want, `${c.id}: 装備タブの一覧の「(未確認)」`);
    const it = items.find((x) => x.value === c.id);
    assert.equal(it.label, label);
    assert.match(it.keywords, new RegExp(`No\\.${c.sheetNo}`));
    assert.equal(F.charmNameOf(index, c.id), `${c.name} (シート No.${c.sheetNo})`);
    assert.equal(F.charmUnconfirmed(index, c.id), want);
    const lines = F.buildLines({ weapon: 1059, armor: {}, charm: c.id, decorations: {}, limitBreak: {} }, index);
    const charm = lines.find((l) => l.key === 'charm');
    assert.equal(charm.name, `${c.name} (シート No.${c.sheetNo})`);
    assert.equal(charm.unconfirmed, want, `${c.id}: 探すタブの詳しくの印`);
  }
  assert.equal(F.charmUnconfirmed(index, 'c0001'), false);
  assert.equal(F.charmUnconfirmed(index, 187), false, '生産する護石');
});
