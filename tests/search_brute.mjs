// 装備探索のテスト用: 小さい問題を作る・独立の総当たり (docs/SEARCH_DESIGN.md 6.2 節)。
//
// 小さい問題 = 部位ごとの防具を 2〜3 個・護石を 2〜3 個・珠を数個に絞ったデータ。関係するスキルを数えられる数に保つため、
// 防具・護石のスキルとシリーズ/グループは決めた物 (KEEP_*) だけ残す (ほかは外したコピーにする)。
// 発動率は「全部 0%、挑戦者・巨戟龍の黙示録 (怒り) と逆襲だけ 100%」にして、条件の組み合わせを 1 つにする (comboExpected が速い)。
//
// 総当たりはソルバのコードを使わない別の道で解く:
//   防具 5 部位 × 護石 の全組 → computeBuild (珠なし) でスキルの Lv とスロット → 珠の入れ方を全部並べる
//   (スロットの大きい順に 1 つずつ。同じ大きさは順を問わない) → 珠で足した Lv の組のうち他に負けないもの (パレート。
//   Lv を上げて火力が下がらない前提。tests/search_api.test.mjs で確かめる) → comboExpected (部位の割合で加重平均) → 上位 K。
import { computeBuild, indexEquipData, ARMOR_PARTS } from '../app/model/build.js';
import { comboExpected } from '../app/model/damage.js';
import { resolveWeaponRef, damageWeapon, autoSharpness } from '../app/model/weapon.js';

/** 残す防具スキル・武器スキル・シリーズ/グループ (名前) */
export const KEEP_ARMOR_SKILLS = ['弱点特効', '挑戦者', '逆襲'];
export const KEEP_WEAPON_SKILLS = ['攻撃', '見切り', '超会心', '火属性攻撃強化'];
export const KEEP_SETS = ['巨戟龍の黙示録', '火竜の力'];
export const KEEP_GROUPS = ['ヌシの魂'];

/** 部位ごとの防具の候補 (id)。ゴグα/β (シリーズ 2 つ)・ヌシの魂のγ・限界突破でスロットが変わるレア6 など */
const POOL = {
  head: [670, 675, 328, 66, 41],
  chest: [671, 676, 329, 67, 42],
  arms: [672, 677, 330, 68, 43],
  waist: [673, 678, 331, 69, 44],
  legs: [674, 679, 332, 70, 45],
};

export function makeRng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
}

/** 全部の条件を 0% にして、残すスキルの条件だけ 100% にした発動率 */
export function smallUptimes(effects) {
  const out = {};
  for (const g of effects.rules.conditionGroups) out[g.id] = g.type === 'categorical' ? {} : 0;
  out.enraged = 1; // 挑戦者・巨戟龍の黙示録
  out.afterKnockback = 1; // 逆襲
  out.beforeGuts = 1; // ヌシの魂
  return out;
}

/**
 * 小さい問題を作る。
 * @param raw tests/search_cases.mjs の loadRepoData() の結果
 * @param o {seed, perPart (2〜3), charms (2〜3), weapon ('w-test' か weapons_sns の id), limitBreak, required, targets,
 *            include: {部位: [必ず入れる防具の id]}}
 * @returns {{data, input, artian, info}}  data は createSearch に渡すデータ (絞ったもの)、input は createSearch の入力
 */
export function makeSmallProblem(raw, artian, o) {
  const rnd = makeRng(o.seed);
  const skills = raw.skills.skills;
  const sid = (name) => skills.find((s) => s.name === name).id;
  const keepArmor = new Set(KEEP_ARMOR_SKILLS.map(sid));
  const keepWeapon = new Set(KEEP_WEAPON_SKILLS.map(sid));
  const keepSets = new Set(KEEP_SETS.map((n) => raw.bonuses.setBonuses.find((b) => b.name === n).id));
  const keepGroups = new Set(KEEP_GROUPS.map((n) => raw.bonuses.groupBonuses.find((b) => b.name === n).id));
  const strip = (a) => {
    const sets = [...new Set([...(a.setBonusIds || []), a.setBonusId].filter((x) => x != null && keepSets.has(x)))];
    return {
      ...a, skills: (a.skills || []).filter((s) => keepArmor.has(s.skillId)),
      setBonusIds: sets, setBonusId: sets[0] ?? null, groupBonusId: keepGroups.has(a.groupBonusId) ? a.groupBonusId : null,
    };
  };
  const byId = new Map(raw.armor.armor.map((a) => [a.id, a]));
  const limitBreak = o.limitBreak ?? true;
  const lbOf = (p) => (limitBreak && typeof limitBreak === 'object' ? !!limitBreak[p] : !!limitBreak);
  const armor = [];
  for (const part of ARMOR_PARTS) {
    // 同じ部位で「残したスキル・スロット・シリーズ/グループ」が同じ防具は選ばない (総当たりとソルバで数え方をそろえる)
    // o.include[part] の防具は必ず入れる (シリーズ 2 つのゴグβ・グループのγ などを確実に通すため)
    const inc = (o.include && o.include[part]) || [];
    const pool = POOL[part].filter((id) => !inc.includes(id)).map((id) => strip(byId.get(id)));
    const seen = new Set();
    const picked = [];
    const order = [...inc.map((id) => strip(byId.get(id)))];
    while (picked.length < (o.perPart ?? 3) && (order.length || pool.length)) {
      const a = order.length ? order.shift() : pool.splice(Math.floor(rnd() * pool.length), 1)[0];
      const sl = lbOf(part) && Array.isArray(a.slotsLimitBreak) ? a.slotsLimitBreak : a.slots;
      const key = JSON.stringify([a.skills.map((s) => [s.skillId, s.level]).sort(), [...sl].sort(), a.setBonusIds.sort(), a.groupBonusId]);
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(a);
    }
    armor.push(...picked);
  }
  // 護石: 所持 (スキルは残す物だけ) + 生産護石から残すスキルを持つもの
  const stripCharm = (c) => ({ ...c, skills: (c.skills || []).filter((s) => keepArmor.has(s.skillId) || keepWeapon.has(s.skillId)) });
  const fixedPool = raw.charmsFixed.charms.filter((c) => (c.skills || []).length && c.skills.every((s) => keepArmor.has(s.skillId) || keepWeapon.has(s.skillId)));
  const nFixed = (o.charms ?? 3) - 1;
  const fixed = [];
  const seenC = new Set();
  while (fixed.length < nFixed && fixedPool.length) {
    const c = fixedPool.splice(Math.floor(rnd() * fixedPool.length), 1)[0];
    const key = JSON.stringify(c.skills.map((s) => [s.skillId, s.level]).sort());
    if (seenC.has(key)) continue;
    seenC.add(key);
    fixed.push(c);
  }
  const owned = raw.charms.charms.slice(0, 1).map(stripCharm);
  // 珠: 防具用 (弱点特効 ③・挑戦者 ③・逆襲 ②) と、武器用 (残すスキルだけの珠から大きさ 1〜3 と 2 スキルのもの)
  const decos = raw.decorations.decorations;
  const armorDecos = decos.filter((d) => d.kind === 'armor' && d.skills.length === 1 && keepArmor.has(d.skills[0].skillId));
  const wPool = decos.filter((d) => d.kind === 'weapon' && d.skills.every((s) => keepWeapon.has(s.skillId)));
  const wPick = [];
  for (const want of [(d) => d.slot === 1, (d) => d.slot === 2, (d) => d.slot === 3 && d.skills.length === 1,
    (d) => d.slot === 3 && d.skills.length === 2]) {
    const c = wPool.filter((d) => want(d) && !wPick.includes(d));
    if (c.length) wPick.push(c[Math.floor(rnd() * c.length)]);
  }
  const data = {
    ...raw, armor: { armor }, decorations: { decorations: [...armorDecos, ...wPick] },
    charms: { schema: 1, charms: owned }, charmsFixed: { charms: fixed },
  };
  delete data.monsters;
  delete data.combos;
  const combo = raw.combos.combos[o.combo ?? 0];
  const input = {
    weapons: [o.weapon ?? 'w-test'], extraWeapons: [artian], targets: o.targets, combo,
    uptimes: smallUptimes(raw.skillEffects), monsterStatus: [], buffs: {}, sharpness: null, required: o.required || [],
    charms: { owned: true, fixed: true }, limitBreak, decorations: { owned: null }, armorExclude: [], objective: 'damage', K: o.K ?? 10,
  };
  const info = {
    armor: Object.fromEntries(ARMOR_PARTS.map((p) => [p, armor.filter((a) => a.part === p).map((a) => a.id)])),
    charms: [...owned.map((c) => c.id), ...fixed.map((c) => c.id)], decos: data.decorations.decorations.map((d) => d.id),
  };
  return { data, input, info };
}

const geq = (a, b) => a.every((x, i) => x >= b[i]);
function pareto(list) {
  const uniq = new Map(list.map((v) => [v.join(','), v]));
  const arr = [...uniq.values()].sort((a, b) => b.reduce((t, x) => t + x, 0) - a.reduce((t, x) => t + x, 0));
  const out = [];
  for (const v of arr) if (!out.some((u) => geq(u, v))) out.push(v);
  return out;
}

/**
 * スロットに珠を入れる全部の入れ方 (大きいスロットから 1 つずつ。同じ大きさのスロットは順を問わない)。
 * @returns 珠ごとの個数の並びのうちパレートなもの
 */
function fills(sizes, decos) {
  const S = sizes.filter((x) => x > 0).sort((a, b) => b - a);
  const out = [];
  const cnt = decos.map(() => 0);
  const rec = (i, minJ) => {
    if (i === S.length) { out.push(cnt.slice()); return; }
    const same = i > 0 && S[i] === S[i - 1];
    // j = -1 は空き
    for (let j = same ? minJ : -1; j < decos.length; j++) {
      if (j >= 0 && decos[j].slot > S[i]) continue;
      if (j >= 0) cnt[j]++;
      rec(i + 1, j);
      if (j >= 0) cnt[j]--;
    }
  };
  rec(0, -1);
  return pareto(out);
}

/**
 * 独立の総当たり。全部の防具・護石の組 × 珠の全部の入れ方を computeBuild + comboExpected で計算し、組ごとの最良を返す。
 * @returns {{all: [{value, armor, charm}], count}}  all は値の大きい順 (必須を満たさない組は入れない)
 */
export function bruteForce(data, input) {
  const idx = indexEquipData({
    skills: data.skills, decorations: data.decorations, bonuses: data.bonuses, armor: data.armor, weapons: data.weapons,
    myWeapons: [...data.myWeapons.weapons, ...(input.extraWeapons || [])], charms: data.charms, charmsFixed: data.charmsFixed,
  });
  const decos = data.decorations.decorations;
  const aDecos = decos.filter((d) => d.kind === 'armor');
  const wDecos = decos.filter((d) => d.kind === 'weapon');
  const skillIds = [...new Set(decos.flatMap((d) => d.skills.map((s) => s.skillId)))];
  const maxOf = (id) => idx.skills.get(id).maxLevel;
  const decoVec = (list, counts) => {
    const v = new Map();
    list.forEach((d, j) => { if (counts[j]) for (const s of d.skills) v.set(s.skillId, (v.get(s.skillId) || 0) + s.level * counts[j]); });
    return v;
  };
  const w = resolveWeaponRef(input.weapons[0], idx);
  const dw = damageWeapon(w);
  const parts = ARMOR_PARTS.map((p) => [...idx.armor.values()].filter((a) => a.part === p));
  const charms = [...idx.charms.keys(), ...idx.charmsFixed.keys()];
  const fillCache = new Map();
  const fillsOf = (sizes, list) => {
    const k = `${list === aDecos ? 'a' : 'w'}|${[...sizes].sort().join(',')}`;
    if (!fillCache.has(k)) fillCache.set(k, fills(sizes, list));
    return fillCache.get(k);
  };
  const valueCache = new Map();
  const value = (levels) => {
    const list = [...levels].filter(([, l]) => l > 0).sort((a, b) => a[0] - b[0]);
    const key = list.map(([id, l]) => `${id}:${l}`).join(',');
    let v = valueCache.get(key);
    if (v === undefined) {
      const skills = list.map(([skillId, level]) => ({ skillId, level }));
      const sl = Object.fromEntries(list);
      const sharpness = input.sharpness || autoSharpness(w, idx, sl).color || 'white';
      v = 0;
      for (const t of input.targets) {
        v += t.weight * comboExpected({ weapon: dw, sharpness, skills, uptimes: input.uptimes, effects: data.skillEffects,
          motions: data.motions, combo: input.combo, target: t.target, monsterStatus: input.monsterStatus, buffs: input.buffs }).total;
      }
      valueCache.set(key, v);
    }
    return v;
  };
  const all = [];
  let count = 0;
  const chosen = [];
  const rec = (pi) => {
    if (pi < 5) { for (const a of parts[pi]) { chosen[pi] = a.id; rec(pi + 1); } return; }
    for (const charm of charms) {
      count++;
      const armor = Object.fromEntries(ARMOR_PARTS.map((p, i) => [p, chosen[i]]));
      const r0 = computeBuild({ weapon: input.weapons[0], armor, charm, decorations: {}, limitBreak: input.limitBreak }, idx);
      if (r0.errors.length) throw new Error(JSON.stringify(r0.errors));
      const aSizes = [...ARMOR_PARTS.flatMap((p) => r0.slots[p].map((s) => s.size)), ...r0.slots.charmArmor.map((s) => s.size)];
      const wSizes = [...r0.slots.weapon.map((s) => s.size), ...r0.slots.charmWeapon.map((s) => s.size)];
      const raw = new Map(r0.skills.map((s) => [s.skillId, s.rawLevel]));
      let best = -Infinity;
      for (const af of fillsOf(aSizes, aDecos)) {
        const av = decoVec(aDecos, af);
        for (const wf of fillsOf(wSizes, wDecos)) {
          const wv = decoVec(wDecos, wf);
          const lv = new Map(raw);
          for (const id of skillIds) lv.set(id, (lv.get(id) || 0) + (av.get(id) || 0) + (wv.get(id) || 0));
          for (const [id, l] of lv) lv.set(id, Math.min(l, maxOf(id)));
          if ((input.required || []).some((q) => (lv.get(q.skillId) || 0) < q.level)) continue;
          const v = value(lv);
          if (v > best) best = v;
        }
      }
      if (best > -Infinity) all.push({ value: best, armor, charm });
    }
  };
  rec(0);
  all.sort((a, b) => b.value - a.value);
  return { all, count, evaluations: valueCache.size };
}
