// 研ぐまでの斬れ味の減り方 (2026-10-29。damage.js の sharpnessShares / sharpnessPlan、探索の評価器の sharpnessUse、
// 探索の sharpnessInterval)。乱数の種は固定。node --test tests/*.test.mjs で回す。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import {
  comboExpected, sharpnessShares, sharpnessPlan, hitSharpnessCost, SHARPNESS_ORDER,
} from '../app/model/damage.js';
import { makeEvaluator } from '../app/model/search/evaluator.js';
import { createSearch } from '../app/model/search.js';
import { checkBuild } from '../app/model/search/realize.js';
import { indexEquipData } from '../app/model/build.js';
import {
  resolveWeaponRef, damageWeapon, sharpnessResolver, sharpnessUseOf, handicraftSkillId, autoSharpness,
} from '../app/model/weapon.js';
import { sharpnessShareText, sharpnessKeepText, sharpnessIntervalOptions } from '../app/ui/tabs/equip_logic.js';
import { loadRepoData, makeCases, searchDataOf } from './search_cases.mjs';
import { makeSmallProblem, bruteForce } from './search_brute.mjs';

// state.js は 'preact/hooks' を名前で import する。node では app/vendor の同じファイルに向ける (tests/state.test.mjs と同じ)
const VENDOR = {
  preact: new URL('../app/vendor/preact.module.js', import.meta.url).href,
  'preact/hooks': new URL('../app/vendor/hooks.module.js', import.meta.url).href,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (VENDOR[specifier]) return nextResolve(VENDOR[specifier], context);
    return nextResolve(specifier, context);
  },
});
const { sanitizeSharpnessInterval, DEFAULT_SHARPNESS_INTERVAL, defaultState, sanitizeState } = await import('../app/state.js');

const raw = await loadRepoData();
const { artian, targetOf, skillId, zeroPlaceholders } = makeCases(raw);
const effects = raw.skillEffects;
const motions = raw.motions;
const combos = raw.combos.combos;
const idx = indexEquipData({
  skills: raw.skills, decorations: raw.decorations, bonuses: raw.bonuses, armor: raw.armor, weapons: raw.weapons,
  myWeapons: [...raw.myWeapons.weapons, artian], charms: raw.charms, charmsFixed: raw.charmsFixed,
});
const HC = handicraftSkillId(idx);
const GYO = skillId('業物');
const TATSU = skillId('達人芸');
const W = SHARPNESS_ORDER.indexOf('white');
const B = SHARPNESS_ORDER.indexOf('blue');
const G = SHARPNESS_ORDER.indexOf('green');
const close = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} / ${b}`);

test('色の割合: 上の色から順に減る・秒数 0 や減らないときは一番上の色・使い切ったら赤', () => {
  const gauge = [140, 40, 40, 80, 30, 20];
  const a = sharpnessShares(gauge, 1, 60);
  close(a.shares[W], 20 / 60); close(a.shares[B], 30 / 60); close(a.shares[G], 10 / 60);
  close(a.shares.reduce((x, y) => x + y, 0), 1);
  assert.equal(a.top, W);
  close(a.sec[W], 20);
  assert.equal(sharpnessShares(gauge, 1, 0).shares[W], 1);
  assert.equal(sharpnessShares(gauge, 0, 60).shares[W], 1);
  // 全部で 350 目盛り。400 秒なら最後の 50 秒は赤のまま (赤は 140 + 50 秒分)
  const z = sharpnessShares(gauge, 1, 400);
  close(z.shares[0], 190 / 400);
  // ゲージが分からない武器は白
  assert.equal(sharpnessShares(null, 1, 60).shares[W], 1);
});

test('データ: 業物 10/25/50%・達人芸 80% (SkillData)、1 回で減る目盛り (既定 1・滑り込み斬り 0.5・減らない当たりは 0)', () => {
  assert.deepEqual(effects.effects[String(GYO)].levels.map((l) => l.sharpnessSave), [0.1, 0.25, 0.5]);
  assert.deepEqual(effects.effects[String(TATSU)].levels.map((l) => l.critSharpnessSave), [0.8]);
  const moves = new Map(motions.moves.map((m) => [m.id, m]));
  for (const m of motions.moves) {
    for (const h of m.hits) {
      if (h.consumesSharpness === false) assert.equal(h.sharpnessCost, 0, `${m.id} 減らない当たり`);
      else assert.ok(h.sharpnessCost > 0 && h.sharpnessCost <= 1, `${m.id} ${h.sharpnessCost}`);
      assert.equal(hitSharpnessCost(h), h.sharpnessCost);
    }
  }
  assert.equal(moves.get('sliding_slash').hits[0].sharpnessCost, 0.5);
  // ジャストラッシュ 1 周 (全段ジャスト) は 9 回当たって 3 目盛り減る
  const rush = combos.find((c) => c.id === 'just_rush_perfect');
  const units = rush.steps.flatMap((s) => moves.get(s.move).hits).reduce((t, h) => t + hitSharpnessCost(h) * (h.count ?? 1), 0);
  assert.equal(units, 3);
  assert.equal(hitSharpnessCost({ mv: 10 }), 1);
});

test('comboExpected: sharpnessUse = 色ごとの値を割合で混ぜたもの・業物と達人芸で減りが遅くなる', () => {
  const w = resolveWeaponRef('w-test', idx);
  const target = targetOf('アルシュベルド', 'head');
  const base = {
    weapon: damageWeapon(w), effects, motions, combo: combos[0], target, uptimes: zeroPlaceholders, monsterStatus: [],
  };
  const skills = [{ skillId: skillId('見切り'), level: 5 }, { skillId: skillId('弱点特効'), level: 5 }];
  const gauge = autoSharpness(w, idx, {}).gauge;
  const r = comboExpected({ ...base, skills, sharpness: 'white', sharpnessUse: { gauge, intervalSec: 60 } });
  assert.ok(r.sharpnessPlan);
  let mixed = 0;
  r.sharpnessPlan.shares.forEach((s, i) => {
    if (s > 0) mixed += s * comboExpected({ ...base, skills, sharpness: SHARPNESS_ORDER[i] }).total;
  });
  close(r.total, mixed, 1e-12);
  const white = comboExpected({ ...base, skills, sharpness: 'white' }).total;
  assert.ok(r.total < white);
  // 達人芸 (会心率が高いほど効く) と業物 3 で 1 秒に減る目盛りが減る
  const t = sharpnessPlan({ ...base, skills: [...skills, { skillId: TATSU, level: 1 }], sharpnessUse: { gauge, intervalSec: 60 } });
  const g = sharpnessPlan({ ...base, skills: [...skills, { skillId: GYO, level: 3 }], sharpnessUse: { gauge, intervalSec: 60 } });
  close(t.keep, 1 - 0.8 * t.critRate);
  close(g.keep, 0.5);
  assert.ok(t.critRate > 0.3 && t.critRate <= 1);
  assert.ok(t.sec[t.top] > r.sharpnessPlan.sec[r.sharpnessPlan.top]);
  // 秒数が 0 なら今までどおり (一番上の色のまま)
  assert.equal(comboExpected({ ...base, skills, sharpness: 'white', sharpnessUse: { gauge, intervalSec: 0 } }).total, white);
  assert.equal(sharpnessUseOf(w, idx, {}, 60, 'white'), null, '色を固定したら減り方は使わない');
});

// ---- 評価器 = 参照 (damage.js: 部位をまとめた sharpnessPlan → 部位ごとの comboExpected)

let seed = 20261029;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const ids = [...Object.keys(effects.effects).map(Number), HC];
const maxLvOf = (id) => idx.skills.get(id)?.maxLevel ?? 5;
const SHARP_R = [GYO, TATSU, HC, skillId('鈍器使い')].map((id) => ids.indexOf(id));
const targetSets = [
  [{ weight: 1, target: targetOf('アルシュベルド', 'head') }],
  [{ weight: 0.6, target: targetOf('アルシュベルド', 'head') }, { weight: 0.4, target: targetOf('アルシュベルド', 'left-wing') }],
  [{ weight: 0.5, target: targetOf('ゴア・マガラ', 'head', true) }, { weight: 0.5, target: targetOf('アルシュベルド', 'torso') }],
];
const uptimeSets = [{}, zeroPlaceholders, { enraged: 0.7, chain: { hit1to4: 0.2, hit5plus: 0.7 }, hpFull: 0.3, afterDodge: 0.5 }];
const buffSets = [{}, { attackAdd: 390, elementMul: 2.2, affinityAdd: 30 }];

function randomLevels() {
  const lv = new Int8Array(ids.length);
  const k = 1 + Math.floor(rnd() * 10);
  for (let n = 0; n < k; n++) {
    const r = Math.floor(rnd() * ids.length);
    lv[r] = 1 + Math.floor(rnd() * maxLvOf(ids[r]));
  }
  // 斬れ味のスキル (業物・達人芸・匠・鈍器使い) を多めに入れる
  for (const r of SHARP_R) if (rnd() < 0.5) lv[r] = 1 + Math.floor(rnd() * maxLvOf(ids[r]));
  return lv;
}
const toList = (lv) => {
  const list = [];
  ids.forEach((id, r) => { if (lv[r] > 0) list.push({ skillId: id, level: lv[r] }); });
  return list;
};

test('評価器 (研ぐまでの減り方あり) = damage.js の参照 (速い道・遅い道・部位を混ぜる・相対 1e-9)', () => {
  let compared = 0; let slow = 0; let worst = 0;
  for (let i = 0; i < 60; i++) {
    const ref = pick(['w-test', 1182, 985, 1006]);
    const w = resolveWeaponRef(ref, idx);
    const intervalSec = pick([30, 60, 120, 300]);
    const resolver = sharpnessResolver(w, idx, null, { intervalSec });
    const targets = pick(targetSets);
    const c = {
      weapon: damageWeapon(w), combo: combos[i % combos.length], targets, uptimes: pick(uptimeSets), monsterStatus: pick([[], ['frenzy']]),
      buffs: rnd() < 0.2 ? pick(buffSets) : {},
    };
    const opts = {
      effects, motions, combo: c.combo, targets, weapon: c.weapon, uptimes: c.uptimes, monsterStatus: c.monsterStatus, buffs: c.buffs,
      relevantIds: ids, sharpness: (lv) => resolver([{ skillId: HC, level: lv }]).sharpness, handicraftIndex: ids.indexOf(HC),
      sharpnessUse: { intervalSec, gaugeFn: (lv) => autoSharpness(w, idx, { [HC]: lv }).gauge },
    };
    const fast = makeEvaluator(opts);
    const slowEv = makeEvaluator({ ...opts, forceSlow: true });
    for (let t = 0; t < 6; t++) {
      const lv = randomLevels();
      const list = toList(lv);
      const per = resolver(list);
      const input = { weapon: c.weapon, skills: list, effects, motions, combo: c.combo, uptimes: c.uptimes,
        monsterStatus: c.monsterStatus, buffs: c.buffs, ...per };
      const plan = sharpnessPlan(input, targets);
      let want = 0;
      for (const x of targets) want += x.weight * comboExpected({ ...input, sharpnessShares: plan.shares, target: x.target }).total;
      const a = fast.evaluate(lv);
      const b = slowEv.evaluate(lv);
      for (const got of [a, b]) {
        const rel = Math.abs(got - want) / Math.max(1, Math.abs(want));
        worst = Math.max(worst, rel);
        assert.ok(rel <= 1e-9, `ずれ ${rel} (${got} / ${want}) 武器 ${ref} 秒 ${intervalSec} ${JSON.stringify(list)}`);
      }
      compared++;
    }
    slow += fast.slowEvals;
  }
  assert.ok(compared >= 300);
  assert.ok(slow > 0, '遅い道 (上限に当たる組) も通る');
  console.log(`  比べた ${compared} 件・最大の相対差 ${worst.toExponential(2)}・速い道から落ちた ${slow} 回`);
});

test('checkBuild の sharpnessInterval: 部位をまとめた減り方 (sharpnessPlan) で計算し直す', () => {
  const targets = targetSets[1];
  const build = { weapon: 'w-test', armor: {}, charm: null, decorations: { weapon: [66, null, null] }, limitBreak: {} };
  const ctx = { idx, effects, motions, combo: combos[0], targets, uptimes: zeroPlaceholders, monsterStatus: [], buffs: {}, sharpness: null };
  const off = checkBuild(build, ctx);
  const on = checkBuild(build, { ...ctx, sharpnessInterval: 60 });
  assert.equal(off.sharpnessPlan, null);
  assert.ok(on.sharpnessPlan && on.sharpnessPlan.critSave === 0.8);
  assert.ok(on.value < off.value);
});

test('探索 (研ぐまで 60 秒): fast の 1 位が総当たりの 1 位と同じ値で、斬れ味のスキルが入る', () => {
  // 武器の珠は 攻撃珠Ⅲ・超心珠Ⅲ・達芸珠・業物珠Ⅲ・匠珠Ⅲ だけ
  const decoId = (name) => raw.decorations.decorations.find((d) => d.name === name).id;
  const weaponDecos = ['攻撃珠Ⅲ【３】', '超心珠Ⅲ【３】', '達芸珠【３】', '業物珠Ⅲ【３】', '匠珠Ⅲ【３】'].map(decoId);
  for (const pr of [{ seed: 41, perPart: 2, charms: 2 }, { seed: 42, perPart: 2, charms: 3, combo: 2 }]) {
    const { data, input } = makeSmallProblem(raw, artian, {
      ...pr, targets: targetSets[1], weaponDecos, weaponDecosOnly: true, uptimes: zeroPlaceholders,
    });
    const inp = { ...input, sharpnessInterval: 60 };
    const brute = bruteForce(data, inp);
    const top = brute.all[0];
    const s = createSearch({ ...inp, mode: 'fast', K: 5 }, data);
    while (!s.step(1e9));
    const res = s.result();
    assert.equal(res.quality, 'heuristic', '研ぐまでの減り方があるときは目安');
    close(res.results[0].value, top.value, 1e-9);
    const has = res.results[0].skills.some((x) => [GYO, TATSU, HC].includes(x.skillId) && x.level > 0);
    assert.ok(has, `1 位に業物・達人芸・匠のどれかが入る ${JSON.stringify(res.results[0].skills)}`);
    // exact も総当たりと同じ 1 位 (上界の保証は無いが、この大きさでは見落とさない)
    const ex = createSearch({ ...inp, mode: 'exact', K: 3, dominance: false }, data);
    while (!ex.step(1e9));
    close(ex.result().results[0].value, top.value, 1e-9);
    // 減り方なし (今までどおり) なら業物・達人芸は効かない
    const plain = bruteForce(data, input);
    assert.ok(plain.all[0].value > top.value);
  }
});

test('状態: 研ぐまでの秒数の既定は 60・壊れた値は既定・0 は減らない', () => {
  assert.equal(DEFAULT_SHARPNESS_INTERVAL, 60);
  assert.equal(defaultState().sharpnessInterval, 60);
  assert.equal(sanitizeSharpnessInterval(0), 0);
  assert.equal(sanitizeSharpnessInterval('120'), 120);
  assert.equal(sanitizeSharpnessInterval(-5), 60);
  assert.equal(sanitizeSharpnessInterval('abc'), 60);
  assert.equal(sanitizeSharpnessInterval(99999), 3600);
  assert.equal(sanitizeState({ sharpnessInterval: 0 }).sharpnessInterval, 0);
  assert.equal(sanitizeState({}).sharpnessInterval, 60, '前の版の保存データ (項目が無い) は既定');
});

test('画面の文: 色の割合・一番上の色がもつ秒数・秒数の候補', () => {
  const plan = { ...sharpnessShares([140, 40, 40, 80, 30, 20], 1.08, 60), intervalSec: 60 };
  assert.equal(sharpnessShareText(plan), '白 31%・青 46%・緑 23%');
  assert.equal(sharpnessKeepText(plan), '白は攻撃し続けて約 19 秒もちます');
  const long = { ...sharpnessShares([140, 40, 40, 80, 30, 20], 0.2, 60), intervalSec: 60 };
  assert.equal(sharpnessKeepText(long), '研ぐまで白のままです');
  assert.deepEqual(sharpnessIntervalOptions(60).map((o) => o.value), [0, 30, 60, 120, 180]);
  assert.deepEqual(sharpnessIntervalOptions(90).map((o) => o.label), ['減らない', '30 秒', '1 分', '90 秒', '2 分', '3 分']);
});

test('探索 (研ぐまで 60 秒・達人芸必須): fast が厳密 (白の上界) と同じ 1 位 (2026-10-29 の取りこぼしの再現)', () => {
  // 歴戦王アルシュベルドの鎖翼刃 2 か所と尻尾・本人の巨戟アーティア (攻撃 220・会心 6・龍 320・兇爪竜の力)。防具と護石を絞った問題。
  // 直す前の fast は、葉で武器の珠の組を「いまの最良の所 (匠 3 で白が足りた所)」で測った表で並べて達芸珠の組を打ち切り、
  // 900.4 (護石 匠3) を返していた (正しくは 915.5 = 護石 攻撃2・匠1 と 攻撃珠Ⅲ・達芸珠)
  const setIdOf = (n) => raw.bonuses.setBonuses.find((b) => b.name === n).id;
  const grpIdOf = (n) => raw.bonuses.groupBonuses.find((b) => b.name === n).id;
  const w = { id: 'w-sharp', name: '巨戟アーティア (攻撃激化・龍)', baseWeaponId: 1180, attack: 220, affinity: 6,
    element: { type: 'dragon', value: 320 }, setBonusId: setIdOf('兇爪竜の力'), groupBonusId: grpIdOf('鱗張りの技法') };
  const armorNames = ['オリオンヘッドα', '護兇爪竜ヘルムβ', '護闢獣ヘルムβ', 'アーフィヘッドα', 'ダハディラメイルγ', '護兇爪竜メイルβ',
    '護兇爪竜アームβ', 'ダハディラアームγ', 'ダハディラコイルγ', '護兇爪竜コイルβ', 'ダハディラグリーヴγ', '護兇爪竜グリーヴβ'];
  const charmIds = ['s251', 's256', 's442', 's001', 's016', 's070'];
  const small = {
    ...raw, armor: { ...raw.armor, armor: raw.armor.armor.filter((a) => armorNames.includes(a.name)) },
    charms: { ...raw.charms, charms: raw.charms.charms.filter((c) => charmIds.includes(c.id)) }, charmsFixed: { ...raw.charmsFixed, charms: [] },
  };
  const data = searchDataOf(small);
  const third = 1 / 3;
  const input = {
    weapons: ['w-sharp'], extraWeapons: [w],
    targets: ['left-wing-blade', 'right-wing-blade', 'tail'].map((k) => ({ weight: third, target: targetOf('アルシュベルド', k) })),
    combo: combos.find((c) => c.id === 'just_rush_perfect'), uptimes: zeroPlaceholders, monsterStatus: [], buffs: {}, sharpness: null,
    sharpnessInterval: 60, required: [{ skillId: skillId('回避性能'), level: 1 }, { skillId: skillId('龍耐性'), level: 3 }, { skillId: TATSU, level: 1 }],
    charms: { owned: true, fixed: true }, limitBreak: true, decorations: { owned: null }, armorExclude: [], armorResistMin: { dragon: 0 },
    objective: 'damage', K: 3,
  };
  const run = (extra) => { const s = createSearch({ ...input, ...extra }, data); while (!s.step(1e9)); return s.result(); };
  const ex = run({ mode: 'exact', dominance: false });
  const fa = run({ mode: 'fast', budget: { work: 2000000 } });
  assert.equal(ex.status, 'done');
  close(fa.results[0].value, ex.results[0].value, 1e-9);
  const top = fa.results[0];
  assert.ok(top.skills.some((x) => x.skillId === TATSU), '1 位に達人芸');
  assert.equal(top.build.charm, 's251', '1 位の護石は 攻撃2・鈍器使い1・匠1');
});
