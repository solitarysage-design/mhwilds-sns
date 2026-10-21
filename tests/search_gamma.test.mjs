// 歴戦王の素材が要る防具・護石 (γ 防具・狩猟証γ の固定護石。docs/SEARCH_DESIGN.md 4 章の 4・docs/RECOMMEND_DESIGN.md 2.7 節):
// monsters.json の individuals[].rewards から作る印 (gammaIndexOf) と、armorExclude・charms.fixedExclude で外したときの探索。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSearch, gammaIndexOf } from '../app/model/search.js';
import { realizeEntry } from '../app/model/search/realize.js';
import { indexEquipData, computeBuild, ARMOR_PARTS } from '../app/model/build.js';
import { loadRepoData, makeCases, searchDataOf } from './search_cases.mjs';

const raw = await loadRepoData();
const { cases, skillId } = makeCases(raw);
const data = searchDataOf(raw);
const gamma = gammaIndexOf({ monsters: raw.monsters });
const idx = indexEquipData({ ...data, myWeapons: [...data.myWeapons.weapons, ...cases.B1.extraWeapons] });
const LIGHT = { beam: [20, 60], budget: { work: 3000 } };

function run(input) {
  const s = createSearch(input, data);
  let n = 0;
  while (!s.step(1e9)) if (++n > 1e6) throw new Error('終わらない');
  return s.result();
}

test('gammaIndexOf: 歴戦王 5 体の γ 防具 25 個と狩猟証γ の護石 10 個。ヌシの魂の防具は全部 γ', () => {
  assert.equal(gamma.monsters.length, 5);
  assert.equal(Object.keys(gamma.armor).length, 25);
  assert.equal(Object.keys(gamma.charmsFixed).length, 10);
  for (const [id, g] of Object.entries(gamma.armor)) {
    const a = idx.armor.get(Number(id));
    assert.ok(a, `防具 ${id} が armor.json にある`);
    assert.match(a.name, /γ$/);
    assert.match(g.name, /（歴戦王）$/);
  }
  for (const id of Object.keys(gamma.charmsFixed)) assert.ok(idx.charmsFixed.get(Number(id)), `護石 ${id} が charms_fixed.json にある`);
  // monsters.json の形 3 通り (target データ / monsters.json 丸ごと / 配列) で同じ
  assert.deepEqual(gammaIndexOf(raw.monsters), gamma);
  assert.deepEqual(gammaIndexOf(raw.monsters.monsters), gamma);
  // ヌシの魂 (グループ) の防具は γ だけ → 全部外すとヌシの魂は武器の 1 部位だけになる
  const nushi = [...idx.groupBonuses.values()].find((b) => b.name === 'ヌシの魂');
  const withNushi = [...idx.armor.values()].filter((a) => a.groupBonusId === nushi.id).map((a) => a.id).sort((x, y) => x - y);
  assert.deepEqual(withNushi, Object.keys(gamma.armor).map(Number).sort((x, y) => x - y));
});

test('結果の γ 防具・護石に印 (results[].gamma) が付く。倒していない歴戦王の分を外すと出ない', () => {
  const r = run({ ...cases.B1z, ...LIGHT, gamma });
  assert.ok(r.results.length > 0);
  const used = new Set();
  for (const it of r.results) {
    const want = [];
    for (const p of ARMOR_PARTS) {
      const g = gamma.armor[it.build.armor[p]];
      if (g) want.push({ part: p, armorId: it.build.armor[p], monsterId: g.monsterId, name: g.name });
    }
    const gc = typeof it.build.charm === 'number' ? gamma.charmsFixed[it.build.charm] : null;
    if (gc) want.push({ part: 'charm', charmId: it.build.charm, monsterId: gc.monsterId, name: gc.name });
    assert.deepEqual(it.gamma, want);
    for (const m of it.gamma) used.add(m.monsterId);
  }
  assert.ok(used.size > 0, '上位に γ 防具が入る (B1 と同じ)');
  // 印に出た歴戦王を「倒していない」にして外す → その γ 防具・護石は出ない
  const out = gamma.monsters.filter((m) => used.has(m.monsterId));
  const armorExclude = out.flatMap((m) => m.armorIds);
  const fixedExclude = out.flatMap((m) => m.charmFixedIds);
  const r2 = run({ ...cases.B1z, ...LIGHT, gamma, armorExclude, charms: { ...cases.B1z.charms, fixedExclude } });
  assert.ok(r2.results.length > 0);
  for (const it of r2.results) {
    for (const p of ARMOR_PARTS) assert.ok(!armorExclude.includes(it.build.armor[p]), `${p} に外した防具`);
    assert.ok(!fixedExclude.includes(it.build.charm), '外した護石');
    assert.ok(it.gamma.every((m) => !used.has(m.monsterId)));
  }
  assert.ok(r2.results[0].value <= r.results[0].value + 1e-9);
});

test('γ を全部外すと、ヌシの魂の必須は満たせない (理由に「使わない防具」)', () => {
  const armorExclude = Object.keys(gamma.armor).map(Number);
  const r = run({ ...cases.B1z, ...LIGHT, gamma, armorExclude, required: [{ skillId: skillId('ヌシの魂'), level: 1 }] });
  assert.equal(r.status, 'infeasible');
  const m = r.infeasible.missing.find((x) => x.skillId === skillId('ヌシの魂'));
  assert.ok(m && /使わない防具/.test(m.reason), JSON.stringify(r.infeasible));
  // 外さなければ満たせる (武器の 1 部位 + γ 2 部位)
  const ok = run({ ...cases.B1z, ...LIGHT, gamma, required: [{ skillId: skillId('ヌシの魂'), level: 1 }] });
  assert.ok(ok.results.length > 0 && ok.results.every((it) => it.gamma.filter((g) => g.part !== 'charm').length >= 2));
});

test('同じ類に γ でない防具・護石があれば、そちらを代表にする (γ は alternatives へ)', () => {
  // 作り物の類: 頭の類に [γ, γ でない] の 2 つ。ほかの部位と護石は 1 つずつ
  const gHead = Number(Object.keys(gamma.armor).find((id) => idx.armor.get(Number(id)).part === 'head'));
  const plainHead = [...idx.armor.values()].find((a) => a.part === 'head' && !gamma.armor[a.id]).id;
  const others = Object.fromEntries(ARMOR_PARTS.map((p) => [p, [...idx.armor.values()].find((a) => a.part === p && !gamma.armor[a.id]).id]));
  const gCharm = Number(Object.keys(gamma.charmsFixed)[0]);
  const plainCharm = [...idx.charmsFixed.keys()].find((id) => !gamma.charmsFixed[id]);
  const P = { idx, R: 0, armorDeco: [], opts: { limitBreak: true }, weapons: [{ ref: 'w-test', w: idx.myWeapons.get('w-test') }] };
  const S = {
    partOrder: [...ARMOR_PARTS],
    partCls: ARMOR_PARTS.map((p) => [{ members: p === 'head' ? [gHead, plainHead] : [others[p]] }]),
    charmCls: [{ members: [gCharm, plainCharm] }],
  };
  const e = { wi: 0, charm: 0, parts: [0, 0, 0, 0, 0], ws: null, deco: null };
  const plain = realizeEntry(P, S, e);
  assert.equal(plain.build.armor.head, gHead, '印を渡さなければ先頭のまま');
  const avoid = { armor: new Set(Object.keys(gamma.armor).map(Number)), charms: new Set(Object.keys(gamma.charmsFixed).map(Number)) };
  const x = realizeEntry(P, S, e, avoid);
  assert.equal(x.build.armor.head, plainHead);
  assert.deepEqual(x.alternatives.head, [gHead]);
  assert.equal(x.build.charm, plainCharm);
  assert.deepEqual(x.alternatives.charm, [gCharm]);
  assert.equal(computeBuild(x.build, idx).errors.length, 0);
});
