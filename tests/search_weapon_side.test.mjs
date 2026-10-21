// 武器の側だけを選び直す optimizeWeaponSide (docs/RECOMMEND_DESIGN.md 3.3 節・5.4 節。武器 2 本の案) を、
// 候補の武器 × 武器の珠の全組の総当たりと比べる (RECOMMEND_DESIGN.md 6.2 節の「武器 2 本」)。総当たりは探索のコードを使わない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optimizeWeaponSide } from '../app/model/search.js';
import { computeBuild, indexEquipData } from '../app/model/build.js';
import { comboExpected } from '../app/model/damage.js';
import { resolveWeaponRef, damageWeapon, autoSharpness } from '../app/model/weapon.js';
import { loadRepoData, makeCases, searchDataOf } from './search_cases.mjs';

const raw = await loadRepoData();
const { cases, artian, skillId, targetOf, zeroPlaceholders } = makeCases(raw);
const data = searchDataOf(raw);
const idx = indexEquipData({ ...data, myWeapons: [...data.myWeapons.weapons, artian] });

// 候補の武器: 巨戟アーティア・スロット 3 つの無属性・爆破 (スロット 2・2)・火・雷・水 (スロットのあるもの)
const ws = raw.weapons.weapons;
const firstOf = (type) => ws.find((w) => w.element && w.element.type === type && (w.slots || []).filter((x) => x > 0).length >= 2).id;
const WEAPONS = ['w-test', 1182, 1006, firstOf('fire'), firstOf('thunder'), firstOf('water')];
// 持っている武器用の珠 (総当たりで数えられる数に絞る)
const KEEP = ['攻撃', '見切り', '超会心', '火属性攻撃強化', '雷属性攻撃強化', '匠'];
const OWNED = raw.decorations.decorations.filter((d) => d.kind === 'weapon' && d.skills.every((s) => KEEP.includes(idx.skills.get(s.skillId).name)));
// 固定する防具・護石 (珠は防具 1 つと護石なし)
const ARMOR = { head: 670, chest: 676, arms: 330, waist: 69, legs: 45 };
const CHARM = raw.charmsFixed.charms.find((c) => (c.skills || []).length).id;
const FIXED = { armor: ARMOR, charm: CHARM, limitBreak: true, decorations: { head: [], chest: [], arms: [], waist: [], legs: [], charmArmor: [], charmWeapon: [] } };
// 相手は 2 体 (group a / b)。採点は「全部倒すまでの回数」を小さくする向き (-Σ H / 値)
const TARGETS = [
  { weight: 0.3, group: 'a', target: targetOf('アルシュベルド', 'head') },
  { weight: 0.2, group: 'a', target: targetOf('アルシュベルド', 'left-wing') },
  { weight: 0.5, group: 'b', target: targetOf('ゴア・マガラ', 'head') },
];
const H = { a: 30000, b: 20000 };
const score = (pg) => -(H.a / pg.a + H.b / pg.b);
const input = {
  ...cases.B1z, weapons: WEAPONS, targets: TARGETS,
  decorations: { owned: Object.fromEntries(raw.decorations.decorations.map((d) => [d.id, OWNED.includes(d) ? 9 : 0])) },
};

/** 武器 1 本の、武器スロットへの珠の全部の入れ方 (同じ大きさのスロットは順を問わない) */
function fills(sizes) {
  const S = sizes.map((x, i) => ({ size: x, i })).filter((s) => s.size > 0).sort((a, b) => b.size - a.size);
  const out = [];
  const pick = new Array(sizes.length).fill(null);
  const rec = (k, minJ) => {
    if (k === S.length) { out.push(pick.slice()); return; }
    const same = k > 0 && S[k].size === S[k - 1].size;
    for (let j = same ? minJ : -1; j < OWNED.length; j++) {
      if (j >= 0 && OWNED[j].slot > S[k].size) continue;
      pick[S[k].i] = j >= 0 ? OWNED[j].id : null;
      rec(k + 1, j);
    }
    pick[S[k].i] = null;
  };
  rec(0, -1);
  return out;
}

/** 総当たり: 武器ごとに一番良い珠の入れ方 (computeBuild + comboExpected)。score の大きい順 */
function brute(required = []) {
  const cache = new Map();
  const out = [];
  for (const ref of WEAPONS) {
    const w = resolveWeaponRef(ref, idx);
    let best = null;
    for (const deco of fills(w.slots || [])) {
      const build = { weapon: ref, armor: ARMOR, charm: CHARM, decorations: { ...FIXED.decorations, weapon: deco }, limitBreak: true };
      const r = computeBuild(build, idx);
      assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
      if (required.some((q) => (r.skillLevels[q.skillId] || 0) < q.level)) continue;
      const skills = r.skills.filter((s) => s.level > 0).map((s) => ({ skillId: s.skillId, level: s.level }));
      const key = `${ref}|${skills.map((s) => `${s.skillId}:${s.level}`).join(',')}`;
      let pg = cache.get(key);
      if (!pg) {
        const sharpness = autoSharpness(w, idx, r.skillLevels).color;
        const acc = { a: [0, 0], b: [0, 0] };
        for (const t of TARGETS) {
          const v = comboExpected({ weapon: damageWeapon(w), sharpness, skills, uptimes: input.uptimes, effects: data.skillEffects,
            motions: data.motions, combo: input.combo, target: t.target, monsterStatus: input.monsterStatus, buffs: {} }).total;
          acc[t.group][0] += t.weight * v; acc[t.group][1] += t.weight;
        }
        pg = { a: acc.a[0] / acc.a[1], b: acc.b[0] / acc.b[1] };
        cache.set(key, pg);
      }
      const s = score(pg);
      if (!best || s > best.score) best = { weapon: ref, score: s, perGroup: pg, deco };
    }
    if (best) out.push(best);
  }
  return out.sort((x, y) => y.score - x.score);
}

const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.abs(b);

test('武器の支配除去なし: 上位 N 件 (武器ごとの一番良い珠の組) が総当たりと同じ', () => {
  const want = brute();
  assert.ok(want.length >= 5);
  const got = optimizeWeaponSide({ ...input, dominance: false }, FIXED, data, { score, N: 5 });
  assert.equal(got.length, 5);
  got.forEach((g, i) => {
    assert.ok(close(g.score, want[i].score), `${i + 1} 位: ${g.weapon} ${g.score} / 総当たり ${want[i].weapon} ${want[i].score}`);
    assert.ok(close(g.perGroup.a, want[i].perGroup.a) && close(g.perGroup.b, want[i].perGroup.b));
    // 計算し直し (comboExpected) と同じ値・固定した側は変えない
    assert.ok(g.check.relDiff <= 1e-9, `計算し直しの差 ${g.check.relDiff}`);
    assert.equal(g.check.errors.length, 0);
    assert.ok(close(g.check.perGroup.a, g.perGroup.a) && close(g.check.perGroup.b, g.perGroup.b));
    assert.deepEqual(g.build.armor, ARMOR);
    assert.equal(g.build.charm, CHARM);
    assert.deepEqual(g.build.decorations.weapon, g.decorations.weapon);
    for (const k of Object.keys(FIXED.decorations)) assert.deepEqual(g.build.decorations[k], FIXED.decorations[k]);
  });
});

test('武器の支配除去あり: 1 位が総当たりと同じ。どの結果もその武器の一番良い値', () => {
  const want = brute();
  const got = optimizeWeaponSide(input, FIXED, data, { score, N: 3 });
  assert.ok(close(got[0].score, want[0].score), `${got[0].score} / ${want[0].score}`);
  for (const g of got) {
    const w = want.find((x) => x.weapon === g.weapon);
    assert.ok(w && close(g.score, w.score), `${g.weapon}`);
  }
  // 同じ input の物でもう一度呼ぶと、下ごしらえを使い回して同じ結果
  const again = optimizeWeaponSide(input, FIXED, data, { score, N: 3 });
  assert.deepEqual(again.map((g) => [g.weapon, g.score]), got.map((g) => [g.weapon, g.score]));
});

test('必須の武器スキル (見切り 3・攻撃 2) を満たす組だけを出す', () => {
  const required = [{ skillId: skillId('見切り'), level: 3 }, { skillId: skillId('攻撃'), level: 2 }];
  const want = brute(required);
  const got = optimizeWeaponSide({ ...input, required, dominance: false }, FIXED, data, { score, N: 4 });
  assert.equal(got.length, Math.min(4, want.length));
  got.forEach((g, i) => {
    assert.ok(close(g.score, want[i].score), `${i + 1} 位 ${g.score} / ${want[i].score}`);
    const r = computeBuild(g.build, idx);
    for (const q of required) assert.ok((r.skillLevels[q.skillId] || 0) >= q.level);
  });
});

test('採点を渡さなければ全体の期待値 (割合の加重平均) の大きい順', () => {
  const got = optimizeWeaponSide({ ...input, dominance: false }, FIXED, data, { N: 3 });
  for (let i = 1; i < got.length; i++) assert.ok(got[i - 1].value >= got[i].value);
  for (const g of got) {
    assert.equal(g.score, g.value);
    assert.ok(close(g.value, 0.5 * g.perGroup.a + 0.5 * g.perGroup.b));
  }
});

test('check: false なら計算し直しを省く (値と並びは同じ)', () => {
  const a = optimizeWeaponSide(input, FIXED, data, { score, N: 3 });
  const b = optimizeWeaponSide(input, FIXED, data, { score, N: 3, check: false });
  assert.deepEqual(b.map((g) => [g.weapon, g.score]), a.map((g) => [g.weapon, g.score]));
  assert.ok(b.every((g) => g.check === null));
  assert.ok(a.every((g) => g.check && g.check.relDiff <= 1e-9));
});
