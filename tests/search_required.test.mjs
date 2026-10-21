// 必須スキル (docs/SEARCH_DESIGN.md 2.8 節・6.3 節) を本物のデータで確かめる。
// 小さい問題で総当たりと比べるもの (シリーズ/グループの必須・満たせない必須) は tests/search_small.test.mjs。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSearch } from '../app/model/search.js';
import { computeBuild, indexEquipData } from '../app/model/build.js';
import { loadRepoData, makeCases, searchDataOf } from './search_cases.mjs';

const raw = await loadRepoData();
const { cases, artian, skillId } = makeCases(raw);
const data = searchDataOf(raw);
const idx = indexEquipData({ ...data, myWeapons: [...data.myWeapons.weapons, artian] });
const LIGHT = { beam: [10, 30], budget: { work: 2000 } };

function run(input) {
  const s = createSearch(input, data);
  while (!s.step(1e9));
  return s.result();
}

/** 返した構成が全部、computeBuild の結果で必須の Lv 以上・errors が 0 */
function assertRequired(r, required, index = idx) {
  assert.ok(r.results.length > 0, `結果がある (${r.status})`);
  for (const x of r.results) {
    const cb = computeBuild(x.build, index);
    assert.equal(cb.errors.length, 0, JSON.stringify(cb.errors));
    for (const q of required) {
      assert.ok((cb.skillLevels[q.skillId] || 0) >= q.level, `${q.skillId} Lv${q.level} (${cb.skillLevels[q.skillId] || 0})`);
    }
  }
}

test('B2 (耐震3・風圧耐性3・回避性能2): 返した構成は全部満たす', () => {
  const r = run({ ...cases.B2, ...LIGHT, uptimes: cases.B1z.uptimes });
  assertRequired(r, cases.B2.required);
});

test('B4 (泣シミュ型): 満たす構成を K 件、空きスロットの多い順に。最初の 1 件はすぐ出る', () => {
  const t0 = performance.now();
  const r = run(cases.B4);
  assert.equal(r.status, 'done');
  assertRequired(r, cases.B4.required);
  assert.equal(r.results.length, cases.B4.K);
  assert.ok(r.stats.firstSolutionMs != null && r.stats.firstSolutionMs < 1000, `最初の 1 件 ${r.stats.firstSolutionMs}ms`);
  assert.ok(performance.now() - t0 < 3000);
  const free = (x) => [1, 2, 3].reduce((t, s) => t + s * (x.freeSlots.armor[s] + x.freeSlots.weapon[s]), 0);
  for (let i = 1; i < r.results.length; i++) assert.ok(free(r.results[i - 1]) >= free(r.results[i]));
  assert.ok(r.results.every((x) => x.value == null));
});

test('シリーズスキルの必須 (巨戟龍の黙示録 Lv2 = ゴグ 4 部位)・グループスキルの必須 (ヌシの魂) を刈らずに満たす', () => {
  const req1 = [{ skillId: skillId('巨戟龍の黙示録'), level: 2 }];
  assertRequired(run({ ...cases.B1z, ...LIGHT, required: req1 }), req1);
  // 武器の付けたグループ (巨戟アーティアのヌシの魂) を外した武器でも、防具 3 部位で揃える
  const req2 = [{ skillId: skillId('ヌシの魂'), level: 1 }];
  const w = { ...artian, id: 'w-test2', groupBonusId: null };
  const idx2 = indexEquipData({ ...data, myWeapons: [...data.myWeapons.weapons, w] });
  assertRequired(run({ ...cases.B1z, ...LIGHT, weapons: ['w-test2'], extraWeapons: [w], required: req2 }), req2, idx2);
  // 両方
  const both = [...req1, { skillId: skillId('黒蝕竜の力'), level: 1 }];
  const r = run({ ...cases.B1z, ...LIGHT, required: both });
  if (r.status === 'infeasible') {
    // ゴグ 4 部位 + 黒蝕竜の部位が足りないなら、足りないスキルの説明がある
    assert.ok(r.infeasible.missing.length > 0);
  } else assertRequired(r, both);
});

test('珠の無い防具スキルの必須は、防具と護石だけで満たす', () => {
  const decoSkills = new Set(raw.decorations.decorations.filter((d) => d.kind === 'armor').flatMap((d) => d.skills.map((s) => s.skillId)));
  const counts = new Map();
  for (const a of raw.armor.armor) for (const s of a.skills) if (!decoSkills.has(s.skillId)) counts.set(s.skillId, (counts.get(s.skillId) || 0) + 1);
  const id = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  const req = [{ skillId: id, level: 1 }];
  assertRequired(run({ ...cases.B1z, ...LIGHT, required: req }), req);
});

test('武器スキルの必須 (攻撃3) は武器用の珠で満たす', () => {
  const req = [{ skillId: skillId('攻撃'), level: 3 }, { skillId: skillId('弱点特効'), level: 5 }];
  assertRequired(run({ ...cases.B1z, ...LIGHT, required: req }), req);
});

test('火力に関係しない武器スキルの必須も、武器用の珠で満たす (火力の高い珠を選ぶだけでは満たせない)', () => {
  const eff = raw.skillEffects.effects;
  const wDecoSkills = new Set(raw.decorations.decorations.filter((d) => d.kind === 'weapon' && d.slot <= 2 && d.skills.length === 1)
    .map((d) => d.skills[0].skillId));
  const s = raw.skills.skills.find((x) => x.kind === 'weapon' && !eff[String(x.id)] && wDecoSkills.has(x.id) && x.maxLevel >= 2);
  assert.ok(s, '火力に関係しない武器スキル');
  const req = [{ skillId: s.id, level: 2 }];
  assertRequired(run({ ...cases.B1z, ...LIGHT, required: req }), req);
  assertRequired(run({ ...cases.B1z, ...LIGHT, required: req, mode: 'exact', budget: { work: 20000 } }), req);
});
