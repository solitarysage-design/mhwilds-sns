// 探索の下ごしらえ (docs/SEARCH_DESIGN.md 2.2 節) と増え方の表 (2.4 節)。
//  - 関係するスキル (上限を外した評価器で「全部最大から 1 つだけ 0」「何も無い所に 1 つだけ入れる」で値が変わるもの + 必須)
//  - 防具の同値類と優越の除去 (足りない防具スキルを余ったスロットの珠で埋められるなら下の類を捨てる)・護石の同値類
//  - 武器用スロット (武器 + 護石の武器用) の珠の組のうち Lv の並びがパレート最適なもの
//  - 武器の支配除去 (武器も探すとき)
// データ (装備・スキル・珠) は引数で受ける。武器の解決と斬れ味は ../weapon.js。import は相対パスだけ (Worker から読むため)。
import { ARMOR_PARTS } from '../build.js';
import { resolveWeaponRef, damageWeapon, autoSharpness, handicraftSkillId } from '../weapon.js';
import { makeEvaluator } from './evaluator.js';

const setIdsOf = (x) => [...new Set([...(Array.isArray(x.setBonusIds) ? x.setBonusIds : []), x.setBonusId].filter((id) => id != null))];
const wantsLB = (lb, part) => (lb && typeof lb === 'object' ? !!lb[part] : !!lb);
const sortDesc = (a) => [...(a || [])].map((v) => Number(v) || 0).sort((x, y) => y - x);
const SHARP_ORDER = ['red', 'orange', 'yellow', 'green', 'blue', 'white', 'purple'];
const ELEMENTAL = ['fire', 'water', 'thunder', 'ice', 'dragon'];

/** 防具の Lv の並び・スロットの「Lv t 以上の数」が全部以上か (入れ子のスロット) */
function slotsGeNested(a, b) {
  for (let t = 3; t >= 1; t--) {
    let na = 0, nb = 0;
    for (const x of a) if (x >= t) na++;
    for (const x of b) if (x >= t) nb++;
    if (na < nb) return false;
  }
  return true;
}

/**
 * 下ごしらえ。
 * @param data {idx: indexEquipData の結果 (端末の護石・所持アーティアも入れたもの), effects: skill_effects.json, motions}
 * @param o {
 *   weapons: [武器の参照], targets: [{weight, target}] (weight は足して 1), combo, uptimes, monsterStatus, buffs,
 *   required: [{skillId, level}], limitBreak: {head: bool, ...}, sharpness: null (自動) | 色,
 *   charmRefs: [使う護石の参照 (文字列 = 所持・端末 / 数値 = 生産)], armorExclude: [防具の id],
 *   decoCount: null | {装飾品 id: 持っている数} (null = 全部持っている), objective: 'damage' | 'none',
 *   K, domK (この数以上の類に優越される類を捨てる。既定 1。泣シミュ型は捨てない), weaponDominance (既定 true),
 *   light (true = 防具の類と上界用の評価器を作らない。武器の側だけを選び直す optimizeWeaponSide 用)
 * }
 */
export function prepare(data, o) {
  const K = o.K ?? 10;
  const none = o.objective === 'none';
  const domK = o.domK ?? (none ? Infinity : 1);
  const idx = data.idx;
  const effects = data.effects;
  const effMap = effects.effects || {};
  const skillById = idx.skills;
  const hid = handicraftSkillId(idx);
  const warnings = [];
  const warn = (code, message, extra = {}) => { if (!warnings.some((w) => w.code === code && w.message === message)) warnings.push({ code, message, ...extra }); };

  // ---- データの形の前提 (崩れていたら探索の前提が成り立たないので例外にして気づけるようにする)
  for (const d of idx.decorations.values()) {
    if (d.kind === 'armor' && (d.skills || []).some((s) => s.level !== 1)) throw new Error(`防具用の珠で Lv が 1 でないものがある: ${d.name}`);
    if (d.kind === 'armor' && (d.skills || []).length !== 1) throw new Error(`防具用の珠でスキルが 1 つでないものがある: ${d.name}`);
  }
  for (const a of idx.armor.values()) {
    for (const s of a.skills || []) {
      const k = skillById.get(s.skillId)?.kind;
      if (k === 'weapon') throw new Error(`防具に武器スキルが付いている: ${a.name}`);
    }
  }

  // ---- 武器
  const fixedSharp = o.sharpness || null;
  let weapons = [];
  for (const ref of o.weapons) {
    const w = resolveWeaponRef(ref, idx);
    if (!w) { warn('unknown-weapon', `武器 (${ref}) が見つからないので外しました`); continue; }
    const cache = new Map();
    const sharpFn = fixedSharp ? null : (lv) => {
      if (!cache.has(lv)) cache.set(lv, autoSharpness(w, idx, hid != null ? { [hid]: lv } : {}).color || 'white');
      return cache.get(lv);
    };
    weapons.push({ ref, w, dmg: damageWeapon(w), sharpFn, fixedSharp, name: w.displayName || w.name });
  }
  if (!weapons.length) throw new Error('探す武器がありません');

  // ---- 関係するスキル: 上限を外した評価器で「全部最大から 1 つだけ 0 にする」と「1 つだけ入れる」で変わるもの + 必須スキル
  const cand = Object.keys(effMap).map(Number).filter((id) => effMap[id].supported !== false && skillById.has(id));
  if (hid != null && !fixedSharp && !cand.includes(hid)) cand.push(hid);
  const required = [];
  for (const q of o.required || []) {
    if (!(q.level > 0)) continue;
    const old = required.find((x) => x.skillId === q.skillId);
    if (old) old.level = Math.max(old.level, q.level); else required.push({ skillId: q.skillId, level: q.level });
  }
  for (const q of required) if (!cand.includes(q.skillId)) cand.push(q.skillId);
  const maxOf = (id) => skillById.get(id)?.maxLevel ?? 0;
  const evalOpts = (wp, ids, uncapped, patternCache) => ({
    effects, motions: data.motions, combo: o.combo, targets: o.targets, weapon: wp.dmg,
    uptimes: o.uptimes || {}, monsterStatus: o.monsterStatus, buffs: o.buffs, relevantIds: ids,
    sharpness: wp.sharpFn || wp.fixedSharp || 'white', handicraftIndex: ids.indexOf(hid), uncapped, patternCache,
  });
  const sigOf = (wp) => [wp.dmg.element ? wp.dmg.element.type : '-', wp.dmg.element ? 1 : 0,
    ...[0, 1, 2, 3, 4, 5].map((lv) => (wp.sharpFn ? wp.sharpFn(lv) : wp.fixedSharp))].join('|');
  const relevant = new Set(required.map((r) => r.skillId));
  const relCache = new Map();
  // Lv を上げて火力が下がるスキル (上界・優越の除去の前提が崩れる。docs/SEARCH_DESIGN.md 4 章の 6)
  const nonMonotone = new Set();
  if (!none) {
    for (const wp of weapons) {
      const sig = sigOf(wp);
      let rel = relCache.get(sig);
      if (!rel) {
        rel = new Set(required.map((q) => q.skillId));
        const ev = makeEvaluator(evalOpts(wp, cand, true));
        const top = new Int8Array(cand.map(maxOf));
        const fTop = ev.evaluate(top);
        const zero = new Int8Array(cand.length);
        const f0 = ev.evaluate(zero);
        cand.forEach((id, r) => {
          const t = top.slice(); t[r] = 0;
          const z = zero.slice(); z[r] = maxOf(id);
          const vt = ev.evaluate(t);
          const vz = ev.evaluate(z);
          if (vt < fTop * (1 - 1e-12) || vz > f0 * (1 + 1e-12)) rel.add(id);
          // 外すと上がる・入れると下がる
          if (vt > fTop * (1 + 1e-9) || vz < f0 * (1 - 1e-9)) nonMonotone.add(id);
        });
        relCache.set(sig, rel);
      }
      wp.relSet = rel;
      wp.relSig = sig;
      for (const id of rel) relevant.add(id);
    }
  }
  // 発動に別のスキルが要るもの (requiresSkillId) は、その先も関係するスキルに入れる (評価器は無いスキルを「無い」と見る)
  for (const id of [...relevant]) {
    const q = effMap[String(id)]?.requiresSkillId;
    if (q != null && skillById.has(Number(q))) relevant.add(Number(q));
  }
  // 並び: 武器スキル → 防具スキル → シリーズ/グループ
  const kindRank = { weapon: 0, armor: 1, set: 2, group: 3 };
  const ids = [...relevant].sort((a, b) => ((kindRank[skillById.get(a).kind] ?? 4) - (kindRank[skillById.get(b).kind] ?? 4)) || a - b);
  const R = ids.length;
  if (R > 120) throw new Error('関係するスキルが多すぎる');
  const rOf = new Map(ids.map((id, r) => [id, r]));
  const kind = ids.map((id) => skillById.get(id).kind);
  const maxLv = new Int8Array(ids.map(maxOf));
  const reqLv = new Int8Array(R);
  for (const q of required) reqLv[rOf.get(q.skillId)] = Math.max(reqLv[rOf.get(q.skillId)], Math.min(q.level, maxLv[rOf.get(q.skillId)]));
  // 上界の前提が崩れる入力 (docs/SEARCH_DESIGN.md 4 章の 6)。fast は近似なのでそのまま動くが、exact の保証は無くなる
  const blunt = [...skillById.values()].find((s) => s.name === '鈍器使い');
  if (blunt && rOf.has(blunt.id) && hid != null && rOf.has(hid) && !fixedSharp) {
    warn('blunt-handicraft', '鈍器使いと匠が両方効く条件なので、探した結果の順位は目安です (斬れ味が上がると鈍器使いの効果が消えるため)');
  }
  if (nonMonotone.size) {
    const names = [...nonMonotone].map((id) => skillById.get(id)?.name ?? String(id));
    warn('non-monotone', `${names.join('・')} は Lv を上げると火力が下がることがある条件なので、探した結果の順位は目安です`
      + ' (同時に起きない条件の発動率や、マイナスの効果のため)', { skillIds: [...nonMonotone] });
  }

  // ---- 装飾品: 防具用は 1 スキル 1 Lv (スキルごとに一番小さいスロット)。武器用は 2 スキルのものもある
  const decoCount = o.decoCount || null;
  const decoOk = (d) => !decoCount || (decoCount[d.id] ?? 0) > 0;
  const armorDeco = new Array(R).fill(null); // {id, slot}
  const weaponDecos = [];
  for (const d of idx.decorations.values()) {
    if (!decoOk(d)) continue;
    const rel = (d.skills || []).filter((s) => rOf.has(s.skillId));
    if (!rel.length) continue;
    if (d.kind === 'armor') {
      for (const s of rel) {
        const r = rOf.get(s.skillId);
        if (!armorDeco[r] || d.slot < armorDeco[r].slot) armorDeco[r] = { id: d.id, slot: d.slot, name: d.name };
      }
    } else {
      const vec = new Int8Array(R);
      for (const s of rel) vec[rOf.get(s.skillId)] = Math.min(maxLv[rOf.get(s.skillId)], s.level);
      weaponDecos.push({ id: d.id, slot: d.slot, vec, name: d.name });
    }
  }
  // 武器用の珠の優越: スロットが小さいか同じで、スキルが全部以上
  const geVec = (a, b) => { for (let r = 0; r < R; r++) if (a[r] < b[r]) return false; return true; };
  const eqVec = (a, b) => { for (let r = 0; r < R; r++) if (a[r] !== b[r]) return false; return true; };
  const wDecosAll = weaponDecos.filter((d, i) => !weaponDecos.some((e, j) => j !== i && e.slot <= d.slot && geVec(e.vec, d.vec)
    && (!eqVec(e.vec, d.vec) || e.slot < d.slot || j < i)));

  // ---- 珠を考えた優越: A のスロットで「B のスロット + B にあって A に足りない防具スキルの Lv 分の珠」を全部入れられるか
  //      (防具用の珠は 1 個 1 Lv。珠の数に限りがあるときは使わない)
  function canEmulate(aLv, aSlots, bLv, bSlots, armorOnly = false) {
    const need = [0, 0, 0, 0];
    for (const x of bSlots) if (x > 0) need[x]++;
    for (let r = 0; r < R; r++) {
      if (kind[r] !== 'armor') { if (!armorOnly && aLv[r] < bLv[r]) return false; continue; }
      const d = bLv[r] - aLv[r];
      if (d <= 0) continue;
      if (!armorDeco[r] || decoCount) return false;
      need[armorDeco[r].slot] += d;
    }
    const have = [0, 0, 0, 0];
    for (const x of aSlots) if (x > 0) have[x]++;
    // 入れ子の大きさなので、しきい値ごとの個数の比較で足りる (Hall の条件)
    for (let t = 3; t >= 1; t--) {
      let n = 0, h = 0;
      for (let u = t; u <= 3; u++) { n += need[u]; h += have[u]; }
      if (n > h) return false;
    }
    return true;
  }

  // ---- シリーズ/グループ (関係するスキルのものだけ)
  const sets = [...idx.setBonuses.values()].filter((b) => rOf.has(b.skillId))
    .map((b) => ({ id: b.id, name: b.name, r: rOf.get(b.skillId), ranks: [...(b.ranks || [])].sort((x, y) => x.pieces - y.pieces) }));
  const groups = [...idx.groupBonuses.values()].filter((b) => rOf.has(b.skillId))
    .map((b) => ({ id: b.id, name: b.name, r: rOf.get(b.skillId), pieces: b.pieces ?? 3, level: b.level ?? 1 }));
  const setIdx = new Map(sets.map((s, i) => [s.id, i]));
  const groupIdx = new Map(groups.map((g, i) => [g.id, i]));

  // ---- 防具: 部位ごとに同値類 → domK 個以上に優越される類を捨てる
  const exclude = new Set((o.armorExclude || []).map(Number));
  const parts = {};
  const partStats = {};
  for (const part of o.light ? [] : ARMOR_PARTS) {
    const lbOn = wantsLB(o.limitBreak, part);
    const classes = new Map();
    let pieces = 0;
    for (const a of idx.armor.values()) {
      if (a.part !== part || exclude.has(a.id)) continue;
      pieces++;
      const slots = sortDesc(lbOn && Array.isArray(a.slotsLimitBreak) ? a.slotsLimitBreak : a.slots);
      while (slots.length < 3) slots.push(0);
      const lv = new Int8Array(R);
      for (const s of a.skills || []) if (rOf.has(s.skillId)) lv[rOf.get(s.skillId)] = Math.min(127, lv[rOf.get(s.skillId)] + s.level);
      const sIdx = setIdsOf(a).filter((id) => setIdx.has(id)).map((id) => setIdx.get(id)).sort((x, y) => x - y);
      const gIdx = groupIdx.has(a.groupBonusId) ? groupIdx.get(a.groupBonusId) : -1;
      const key = `${lv.join(',')}|${slots.join(',')}|${sIdx.join(',')}|${gIdx}`;
      let c = classes.get(key);
      if (!c) classes.set(key, (c = { lv, slots, sIdx, gIdx, members: [] }));
      c.members.push(a.id);
    }
    const list = [...classes.values()];
    const dom = (A, B) => B.sIdx.every((s) => A.sIdx.includes(s)) && (B.gIdx < 0 || B.gIdx === A.gIdx)
      && canEmulate(A.lv, A.slots, B.lv, B.slots);
    const kept = list.filter((B) => {
      let n = 0;
      for (const A of list) if (A !== B && dom(A, B) && ++n >= domK) return false;
      return true;
    });
    parts[part] = kept.map((c) => ({ ...c, slotCount: [0, 1, 2, 3].map((s) => c.slots.filter((x) => x === s).length) }));
    partStats[part] = { pieces, classes: list.length, kept: kept.length };
  }

  // ---- 護石: 所持 (+端末) と生産護石 (使う参照だけ)
  const cClasses = new Map();
  for (const ref of o.charmRefs || []) {
    const c = typeof ref === 'number' ? idx.charmsFixed.get(ref) : idx.charms.get(ref);
    if (!c) continue;
    const isFixed = !('armorSlots' in c) && !('weaponSlots' in c);
    const aSlots = isFixed ? [0, 0, 0] : sortDesc(c.armorSlots || []);
    while (aSlots.length < 3) aSlots.push(0);
    const wSlot = isFixed ? 0 : Math.max(0, ...(c.weaponSlots || []).map(Number));
    const lv = new Int8Array(R);
    for (const s of c.skills || []) if (rOf.has(s.skillId)) lv[rOf.get(s.skillId)] = Math.min(127, lv[rOf.get(s.skillId)] + s.level);
    const key = `${lv.join(',')}|${aSlots.join(',')}|${wSlot}`;
    let k = cClasses.get(key);
    if (!k) cClasses.set(key, (k = { lv, slots: aSlots, wSlot, members: [] }));
    k.members.push(ref);
  }
  // 護石が 1 つも無いときは「護石なし」を 1 つの類にする
  if (!cClasses.size) cClasses.set('none', { lv: new Int8Array(R), slots: [0, 0, 0], wSlot: 0, members: [null] });
  const cList = [...cClasses.values()];
  // 武器スキルは珠で置き換えを考えない (武器用スロット 1 つで足りるかの判定を省く)。防具スキルは防具用スロットの珠で置き換える
  const weaponGe = (a, b) => { for (let r = 0; r < R; r++) if (kind[r] === 'weapon' && a[r] < b[r]) return false; return true; };
  const cdom = (A, B) => A.wSlot >= B.wSlot && weaponGe(A.lv, B.lv) && canEmulate(A.lv, A.slots, B.lv, B.slots, true);
  const charms = cList.filter((B) => {
    let n = 0;
    for (const A of cList) if (A !== B && cdom(A, B) && ++n >= domK) return false;
    return true;
  }).map((c) => ({ ...c, slotCount: [0, 1, 2, 3].map((s) => c.slots.filter((x) => x === s).length) }));

  // ---- 会心率を動かすスキル (上限を外した評価器で上界を作る)
  const touchesAffinity = new Uint8Array(R);
  for (let r = 0; r < R; r++) {
    const e = effMap[String(ids[r])];
    if (!e) continue;
    for (const lv of e.levels || []) {
      for (const x of [lv, ...Object.values(lv.byState || {})]) {
        if ((x.affinityAdd || 0) !== 0 || (x.weakPointAffinity || 0) !== 0 || (x.woundAffinity || 0) !== 0) touchesAffinity[r] = 1;
      }
    }
  }

  // ---- 武器ごとのスキル・シリーズ/グループ・スロット
  for (const wp of weapons) {
    wp.lv = new Int8Array(R);
    for (const s of wp.w.skills || []) if (rOf.has(s.skillId)) wp.lv[rOf.get(s.skillId)] += s.level;
    wp.sIdx = setIdsOf(wp.w).filter((id) => setIdx.has(id)).map((id) => setIdx.get(id));
    wp.gIdx = groupIdx.has(wp.w.groupBonusId) ? groupIdx.get(wp.w.groupBonusId) : -1;
    wp.slots = sortDesc(wp.w.slots || []).filter((x) => x > 0);
  }

  // ---- 武器の支配除去 (武器も探すとき。整数計画の試作の wDom): 属性 (種類が同じで値が以上)・攻撃・会心・
  //      斬れ味 (匠 0〜5 の各 Lv で一番上の色)・スロット・スキル・シリーズ/グループが全部以上なら、下の武器は要らない
  //      (期待値はどれについても増える向きにしか動かない)。鈍器使いが関係するときは斬れ味の色が全部同じときだけ。
  const weaponsBefore = weapons.length;
  if (weapons.length > 1 && o.weaponDominance !== false && !none) {
    const bluntRel = !!(blunt && rOf.has(blunt.id));
    for (const wp of weapons) {
      wp.sharpIdx = [0, 1, 2, 3, 4, 5].map((h) => SHARP_ORDER.indexOf(wp.sharpFn ? wp.sharpFn(h) : wp.fixedSharp));
      const el = wp.dmg.element;
      wp.elem = el && ELEMENTAL.includes(el.type) ? el : null;
    }
    const wDom = (a, b) => {
      if (a.dmg.attack < b.dmg.attack || a.dmg.affinity < b.dmg.affinity) return false;
      // 属性: b に属性があれば、a も同じ種類で値が以上 (属性の種類で効くスキルが違うため)。b に無ければ a の属性は足しになるだけ
      if (b.elem && !(a.elem && a.elem.type === b.elem.type && a.elem.value >= b.elem.value)) return false;
      for (let h = 0; h < 6; h++) {
        if (bluntRel ? a.sharpIdx[h] !== b.sharpIdx[h] : a.sharpIdx[h] < b.sharpIdx[h]) return false;
      }
      if (!slotsGeNested(a.slots, b.slots)) return false;
      for (let r = 0; r < R; r++) if (a.lv[r] < b.lv[r]) return false;
      if (!b.sIdx.every((s) => a.sIdx.includes(s))) return false;
      if (b.gIdx >= 0 && b.gIdx !== a.gIdx) return false;
      return true;
    };
    const same = (a, b) => wDom(a, b) && wDom(b, a);
    weapons = weapons.filter((b, j) => !weapons.some((a, i) => a !== b && wDom(a, b) && (!same(a, b) || i < j)));
  }

  // ---- 武器ごと: 評価器 (上限あり / 全部外す / 攻撃・属性だけ外す)。条件のパターンの覚えは全部の評価器で使い回す (メモリ)
  const patternCache = new Map();
  for (const wp of weapons) {
    if (!none) {
      wp.ev = makeEvaluator(evalOpts(wp, ids, false, patternCache));
      if (!o.light) {
        wp.evU = makeEvaluator(evalOpts(wp, ids, true, patternCache));
        wp.evA = makeEvaluator(evalOpts(wp, ids, 'attack', patternCache));
      }
    }
    wp.mask = new Uint8Array(R);
    for (let r = 0; r < R; r++) wp.mask[r] = !wp.relSet || wp.relSet.has(ids[r]) || reqLv[r] > 0 ? 1 : 0;
    wp.maskKey = wp.relSig || 'all';
  }

  // ---- 武器用スロット (武器 + 護石の武器用) の珠の組: パレート最適な Lv の並びだけ
  const pwCache = new Map();
  /** mask: その武器で関係するスキル (Uint8Array)。関係しないスキルは 0 にしてから優越を見る (武器も探すとき珠の候補が減る) */
  function weaponSide(slotList, mask = null, maskKey = '') {
    const key = slotList.join(',') + '#' + maskKey;
    if (pwCache.has(key)) return pwCache.get(key);
    const S = slotList;
    let wDecos = wDecosAll;
    if (mask) {
      const proj = wDecosAll.map((d) => ({ ...d, vec: d.vec.map((v, r) => (mask[r] ? v : 0)) }))
        .filter((d) => d.vec.some((v) => v > 0));
      wDecos = proj.filter((d, i) => !proj.some((e, j) => j !== i && e.slot <= d.slot && geVec(e.vec, d.vec)
        && (!eqVec(e.vec, d.vec) || e.slot < d.slot || j < i)));
    }
    const out = [];
    const cur = new Int8Array(R);
    const pick = [];
    // 同じ大きさのスロットは順序を問わない (珠の並びの番号を減らさない)
    const rec2 = (i, minJ) => {
      if (i === S.length) { out.push({ vec: cur.slice(), decos: pick.slice() }); return; }
      const same = i > 0 && S[i] === S[i - 1];
      const start = same ? minJ : -1;
      for (let j = start; j < wDecos.length; j++) {
        if (j === -1) { pick.push(null); rec2(i + 1, -1); pick.pop(); continue; }
        const d = wDecos[j];
        if (d.slot > S[i]) continue;
        for (let r = 0; r < R; r++) cur[r] += d.vec[r];
        pick.push(d.id); rec2(i + 1, j); pick.pop();
        for (let r = 0; r < R; r++) cur[r] -= d.vec[r];
      }
    };
    rec2(0, -1);
    for (const p of out) for (let r = 0; r < R; r++) if (p.vec[r] > maxLv[r]) p.vec[r] = maxLv[r];
    // パレート (Lv の和の大きい順に並べて、前のものに優越されないものだけ残す)
    out.sort((a, b) => b.vec.reduce((t, v) => t + v, 0) - a.vec.reduce((t, v) => t + v, 0));
    const front = [];
    for (const p of out) {
      if (front.some((q) => geVec(q.vec, p.vec))) continue;
      front.push(p);
    }
    pwCache.set(key, front);
    return front;
  }

  return {
    patternCache, K, domK, idx, ids, R, rOf, kind, maxLv, touchesAffinity, reqLv, required, armorDeco, wDecos: wDecosAll, sets, groups,
    parts, partStats, charms, charmClassesBefore: cList.length, weapons, weaponsBefore, weaponSide, hid, warnings, opts: o, data,
    skillName: (r) => skillById.get(ids[r]).name,
  };
}

/**
 * 上界に使う「Lv 1 段ごとの増え方」の表を作る。
 * mode 'valid': 全スキル最大の所 (Top) で測る。会心率を動かすスキルは上限を全部外した評価器、それ以外は攻撃・属性の上限だけ
 *   外した評価器 (会心率は切る)。上限を外した期待値は Lv について優モジュラ (補い合う) なので、Top の増え方は
 *   どの途中の状態の増え方より大きい → 足し算の上界が成り立つ (前提: Lv を上げて火力が下がらない・同時に起きない条件の
 *   発動率の合計が 100% 以下)。
 * mode 'local': 上限ありの評価器で、ctx (Lv の並び) の所で測る。上界の保証は無い (近似)。
 * @returns {{delta: Float64Array[], hat: Float64Array[][]}}
 */
export function gainTable(P, wp, mode = 'valid', ctx = null) {
  const { R, maxLv } = P;
  const delta = [];
  if (mode === 'valid') {
    const top = new Int8Array(maxLv);
    for (let r = 0; r < R; r++) {
      const ev = P.touchesAffinity[r] ? wp.evU : wp.evA;
      const row = new Float64Array(maxLv[r]);
      for (let j = 0; j < maxLv[r]; j++) {
        const a = top.slice(); a[r] = j + 1;
        const b = top.slice(); b[r] = j;
        row[j] = Math.max(0, ev.evaluate(a) - ev.evaluate(b));
      }
      delta.push(row);
    }
  } else {
    const c = Int8Array.from(ctx);
    for (let r = 0; r < R; r++) {
      const row = new Float64Array(maxLv[r]);
      for (let j = 0; j < maxLv[r]; j++) {
        const a = c.slice(); a[r] = j + 1;
        const b = c.slice(); b[r] = j;
        row[j] = Math.max(0, wp.ev.evaluate(a) - wp.ev.evaluate(b));
      }
      delta.push(row);
    }
  }
  const hat = delta.map((row, r) => {
    const out = [];
    for (let base = 0; base <= maxLv[r]; base++) out.push(concaveSlopes(row, base));
    return out;
  });
  return { delta, hat };
}

/** row[j] = Lv j → j+1 の増え方。base から上げるときの凹の上包みの傾き (大きい順) */
export function concaveSlopes(row, base) {
  const g = [0];
  for (let j = base; j < row.length; j++) g.push(g[g.length - 1] + row[j]);
  // 上に凸な包み (点 (n, g[n]) の上側の凸包)
  const hull = [0];
  for (let n = 1; n < g.length; n++) {
    while (hull.length >= 2) {
      const a = hull[hull.length - 2], b = hull[hull.length - 1];
      // b が a→n の線分の下 (か上) にあるなら外す
      if ((g[b] - g[a]) * (n - a) <= (g[n] - g[a]) * (b - a)) hull.pop(); else break;
    }
    hull.push(n);
  }
  const slopes = [];
  for (let i = 1; i < hull.length; i++) {
    const a = hull[i - 1], b = hull[i];
    const s = (g[b] - g[a]) / (b - a);
    for (let n = a; n < b; n++) slopes.push(s);
  }
  return Float64Array.from(slopes);
}
