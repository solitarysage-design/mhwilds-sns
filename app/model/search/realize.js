// 探索の結果 → 装備一式 (珠の位置まで)・同じ類のほかの防具 (alternatives)・空きスロット、
// computeBuild + comboExpected での計算し直し (docs/SEARCH_DESIGN.md 3.4 節)。
// ソルバの中の評価 (速い評価器・Lv の足し算) とずれていないかをここで確かめる。import は相対パスだけ。
import { computeBuild, ARMOR_PARTS } from '../build.js';
import { comboExpected, sharpnessPlan } from '../damage.js';
import { resolveWeaponRef, damageWeapon, autoSharpness, sharpnessUseOf } from '../weapon.js';

const DECO_LISTS = ['weapon', ...ARMOR_PARTS, 'charmArmor', 'charmWeapon'];

/**
 * 珠をスロットに入れる: 大きい珠から、入る一番小さいスロットへ (「Lv t 以上の珠の数 ≤ Lv t 以上のスロットの数」なら必ず入る)。
 * @param slots [{t (入れ先), i (何番目), size}]、list [珠 (decorations.json の要素) | null]
 * @returns [{t, i, id}] 入れた所 (入らない珠があれば例外)
 */
export function placeDecos(slots, list) {
  const free = slots.filter((s) => s.size > 0).sort((a, b) => a.size - b.size);
  const sorted = list.filter((d) => d != null).sort((a, b) => b.slot - a.slot);
  const out = [];
  for (const d of sorted) {
    const k = free.findIndex((s) => s.size >= d.slot);
    if (k < 0) throw new Error(`珠 ${d.name} が入らない`);
    const s = free.splice(k, 1)[0];
    out.push({ t: s.t, i: s.i, id: d.id });
  }
  return out;
}

/**
 * ソルバの結果の 1 件 (e = {wi, charm, parts, ws, deco}) を装備一式にする。ソルバの状態には触らない
 * (探索の途中で呼んでもよい)。
 * @param P prepare() の結果、S ソルバ (類の並び partCls / charmCls / partOrder を読むだけ)
 * @param avoid {armor: Set<防具 id>, charms: Set<護石の参照>} (省略可) 同じ類にほかがあれば代表にしないもの
 *   (歴戦王の素材が要る γ 防具・狩猟証γ の護石。同じ値になる γ でない防具があればそちらを出す)
 * @returns {{build, alternatives}}  build は computeBuild にそのまま渡せる (state.build と同じ形)
 */
export function realizeEntry(P, S, e, avoid = null) {
  const idx = P.idx;
  const wp = P.weapons[e.wi];
  /** 類の代表 (avoid に無いものを先に) と、残り (alternatives。元の並び) */
  const pick = (members, set) => {
    const k = set && set.size ? members.findIndex((m) => !set.has(m)) : 0;
    const i = k < 0 ? 0 : k;
    return [members[i], members.filter((_, j) => j !== i)];
  };
  const charmCls = S.charmCls[e.charm];
  const [charmRef, charmAlt] = pick(charmCls.members, avoid && avoid.charms);
  const armor = {};
  const alternatives = {};
  S.partOrder.forEach((part, i) => {
    const cls = S.partCls[i][e.parts[i]];
    [armor[part], alternatives[part]] = pick(cls.members, avoid && avoid.armor);
  });
  // 防具の耐性の合計の下限 (P.resMin。相手タブの耐性の回) があれば、類の中から下限を満たす防具を選び直す。同じ値になる防具 (alternatives)
  // も、入れ替えても下限を満たすものだけ
  if (P.resE && P.resE.length) {
    const picked = pickByResist(P, S, e, avoid && avoid.armor);
    if (picked) {
      S.partOrder.forEach((part, i) => {
        const cls = S.partCls[i][e.parts[i]];
        armor[part] = picked.ids[i];
        alternatives[part] = cls.members.filter((m, j) => m !== picked.ids[i] && picked.swapOk(i, cls.mres[j]));
      });
    }
  }
  alternatives.charm = charmAlt;
  const charm = charmRef == null ? null : (typeof charmRef === 'number' ? idx.charmsFixed.get(charmRef) : idx.charms.get(charmRef));
  const isFixed = !charm || (!('armorSlots' in charm) && !('weaponSlots' in charm));

  const decos = Object.fromEntries(DECO_LISTS.map((k) => [k, []]));
  const placeInto = (slots, list) => {
    for (const p of placeDecos(slots, list)) decos[p.t][p.i] = p.id;
  };
  // 武器用の珠: 武器スロット + 護石の武器用スロット
  const wSlots = (wp.w.slots || []).map((x, i) => ({ t: 'weapon', i, size: Number(x) || 0 }));
  const cwSlots = isFixed ? [] : (charm.weaponSlots || []).map((x, i) => ({ t: 'charmWeapon', i, size: Number(x) || 0 }));
  placeInto([...wSlots, ...cwSlots], (e.ws ? e.ws.decos : []).map((id) => (id == null ? null : idx.decorations.get(id))));
  // 防具用の珠: 防具 5 部位 (限界突破の指定どおりのスロット) + 護石の防具用スロット
  const aSlots = [];
  const lbOf = (part) => {
    const lb = P.opts.limitBreak;
    return lb && typeof lb === 'object' ? !!lb[part] : !!lb;
  };
  for (const part of ARMOR_PARTS) {
    const a = idx.armor.get(armor[part]);
    const sl = lbOf(part) && Array.isArray(a.slotsLimitBreak) ? a.slotsLimitBreak : a.slots;
    (sl || []).forEach((x, i) => aSlots.push({ t: part, i, size: Number(x) || 0 }));
  }
  if (!isFixed) (charm.armorSlots || []).forEach((x, i) => aSlots.push({ t: 'charmArmor', i, size: Number(x) || 0 }));
  const aList = [];
  for (let r = 0; r < P.R; r++) for (let n = 0; n < (e.deco ? e.deco[r] : 0); n++) aList.push(idx.decorations.get(P.armorDeco[r].id));
  placeInto(aSlots, aList);
  // 空きは null で、スロットの数まで埋める
  const lenOf = (k) => {
    if (k === 'weapon') return (wp.w.slots || []).length;
    if (k === 'charmArmor') return isFixed ? 0 : (charm.armorSlots || []).length;
    if (k === 'charmWeapon') return isFixed ? 0 : (charm.weaponSlots || []).length;
    const a = idx.armor.get(armor[k]);
    return (lbOf(k) && Array.isArray(a.slotsLimitBreak) ? a.slotsLimitBreak : a.slots || []).length;
  };
  for (const k of DECO_LISTS) {
    const n = Math.max(lenOf(k), decos[k].length);
    for (let i = 0; i < n; i++) if (decos[k][i] === undefined) decos[k][i] = null;
  }
  // 限界突破は実際に使った部位だけ true (限界突破後のスロットが分からない防具は通常のスロットで探しているので false)
  const limitBreak = Object.fromEntries(ARMOR_PARTS.map((p) => [p, lbOf(p) && Array.isArray(idx.armor.get(armor[p]).slotsLimitBreak)]));
  const build = { weapon: wp.ref, armor, charm: charmRef, decorations: decos, limitBreak };
  return { build, alternatives };
}

/**
 * 防具の耐性の合計の下限 (P.resMin) を満たすように、5 部位の類の中から防具を選ぶ (avoid に無いもの → 元の並びの順に試す深さ優先)。
 * → {ids: [部位ごとの防具 id (partOrder の順)], swapOk(i, 耐性の並び): 部位 i をその耐性の防具に替えても下限を満たすか} | null
 */
function pickByResist(P, S, e, avoidSet) {
  const n = P.resE.length;
  const min = P.resMin;
  const cls = S.partOrder.map((_, i) => S.partCls[i][e.parts[i]]);
  const order = cls.map((c) => {
    const idx = c.members.map((_, j) => j);
    return avoidSet && avoidSet.size ? [...idx.filter((j) => !avoidSet.has(c.members[j])), ...idx.filter((j) => avoidSet.has(c.members[j]))] : idx;
  });
  const tail = Array.from({ length: 6 }, () => new Array(n).fill(0));
  for (let i = 4; i >= 0; i--) for (let k = 0; k < n; k++) tail[i][k] = tail[i + 1][k] + cls[i].resMax[k];
  const acc = new Array(n).fill(0);
  const pick = new Array(5).fill(-1);
  const rec = (i) => {
    if (i === 5) return true;
    for (const j of order[i]) {
      const v = cls[i].mres[j];
      let ok = true;
      for (let k = 0; k < n; k++) if (acc[k] + v[k] + tail[i + 1][k] < min[k]) { ok = false; break; }
      if (!ok) continue;
      for (let k = 0; k < n; k++) acc[k] += v[k];
      pick[i] = j;
      if (rec(i + 1)) return true;
      for (let k = 0; k < n; k++) acc[k] -= v[k];
    }
    return false;
  };
  if (!rec(0)) return null;
  // acc = 選んだ防具の耐性の合計
  return {
    ids: pick.map((j, i) => cls[i].members[j]),
    swapOk: (i, v) => {
      const cur = cls[i].mres[pick[i]];
      for (let k = 0; k < n; k++) if (acc[k] - cur[k] + v[k] < min[k]) return false;
      return true;
    },
  };
}

/**
 * 装備一式を computeBuild + comboExpected で計算し直す (部位の割合で加重平均)。
 * @param ctx {idx, effects, motions, combo, targets: [{weight, group?, target}], uptimes, monsterStatus, buffs,
 *             sharpness: null (自動) | 色, sharpnessInterval: 研ぐまでに攻撃する秒数 (0・省略 = 一番上の色のまま)}
 * @returns {{value, perTarget: number[], perGroup, r (computeBuild の結果), sharpness, sharpnessPlan, factored: bool, error}}
 *   sharpnessPlan = 研ぐまでの減り方 (damage.js の sharpnessPlan。全部の相手をまとめて 1 つ。減り方を入れないときは null)
 *   value は相手・コンボが無ければ null。factored = 条件の組み合わせが MAX_PATTERNS を超えたので、comboExpected が因子分解の
 *   合計で出した (値は同じ。技ごとの内訳が無いだけ)。comboExpected が例外なら error に文 (value は null)
 */
export function checkBuild(build, ctx) {
  const r = computeBuild(build, ctx.idx);
  const w = resolveWeaponRef(build.weapon, ctx.idx) || (typeof build.weapon === 'object' ? build.weapon : null);
  const sharpness = ctx.sharpness || (w ? autoSharpness(w, ctx.idx, r.skillLevels).color : null) || 'white';
  const out = { value: null, perTarget: [], perGroup: null, r, sharpness, sharpnessPlan: null, factored: false, error: null };
  if (!ctx.targets || !ctx.targets.length || !ctx.combo) return out;
  const skills = r.skills.filter((s) => s.level > 0).map((s) => ({ skillId: s.skillId, level: s.level }));
  try {
    let v = 0;
    const base = {
      weapon: damageWeapon(w), sharpness, skills, uptimes: ctx.uptimes || {}, effects: ctx.effects,
      motions: ctx.motions, combo: ctx.combo, monsterStatus: ctx.monsterStatus, buffs: ctx.buffs,
      sharpnessUse: sharpnessUseOf(w, ctx.idx, r.skillLevels, ctx.sharpnessInterval, ctx.sharpness),
    };
    // 研ぐまでの減り方は全部の相手をまとめて 1 つ (ゲージは 1 本。探索の評価器と同じ)
    out.sharpnessPlan = sharpnessPlan(base, ctx.targets);
    if (out.sharpnessPlan) base.sharpnessShares = out.sharpnessPlan.shares;
    for (const t of ctx.targets) {
      const x = comboExpected({ ...base, target: t.target });
      if (x.factored) out.factored = true;
      out.perTarget.push(x.total);
      v += t.weight * x.total;
    }
    out.value = v;
  } catch (e) {
    out.error = String((e && e.message) || e);
    return out;
  }
  // 相手のまとまり (多頭の相手ごと) の値 = そのまとまりの行だけの加重平均
  const groups = new Map();
  ctx.targets.forEach((t, i) => {
    if (t.group == null) return;
    const g = groups.get(t.group) || { w: 0, v: 0 };
    g.w += t.weight; g.v += t.weight * out.perTarget[i];
    groups.set(t.group, g);
  });
  if (groups.size) out.perGroup = Object.fromEntries([...groups].map(([k, g]) => [k, g.w > 0 ? g.v / g.w : 0]));
  return out;
}

/** computeBuild の結果 → 結果に載せるスキルと空きスロット */
export function summarize(r) {
  const skills = r.skills.filter((s) => s.level > 0).map((s) => ({ skillId: s.skillId, name: s.name, level: s.level }));
  const fb = (k) => ({ ...r.slotSummary[k].freeBySize });
  return { skills, freeSlots: { weapon: fb('weapon'), armor: fb('armor') } };
}
