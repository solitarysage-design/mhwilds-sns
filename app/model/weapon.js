// 武器の解決と斬れ味の自動 (純粋関数。DOM にも preact にも触らない)。
// 探索 (app/model/search/) と Worker からも使うので app/model/ に置く (相対パスの import だけ)。
// もとは app/ui/tabs/equip_logic.js にあったもの。画面は今までどおり equip_logic.js から import できる (再 export)。
// 使い方は docs/MODEL_API.md の「weapon.js」節。
import { SHARPNESS_ORDER } from './damage.js';

/** 斬れ味ゲージの長さの単位 (匠 1 Lv で伸びる長さ) */
export const HANDICRAFT_STEP = 10;

const isObj = (x) => x != null && typeof x === 'object' && !Array.isArray(x);

// ---------------------------------------------------------------- 武器

/** 所持武器 (my_weapons) の元の武器 (weapons_sns)。無ければ null */
export function baseWeaponOf(w, idx) {
  if (!w || w.baseWeaponId == null) return null;
  return idx.weapons.get(w.baseWeaponId) || null;
}

/**
 * 武器の参照 (数値 = weapons_sns の id / 文字列 = 所持武器の id) → 画面と計算に使う武器。
 * 所持武器は元の武器の攻撃力・スロット・斬れ味などで足りない所を補う。見つからなければ null。
 */
export function resolveWeaponRef(ref, idx) {
  if (ref == null) return null;
  const w = typeof ref === 'number' ? idx.weapons.get(ref) : idx.myWeapons.get(ref);
  if (!w) return null;
  const base = baseWeaponOf(w, idx);
  if (!base) return w;
  return {
    ...w,
    attack: w.attack ?? base.attack,
    affinity: w.affinity ?? base.affinity,
    rarity: w.rarity ?? base.rarity,
    slots: w.slots ?? base.slots,
    skills: w.skills ?? base.skills,
    sharpness: w.sharpness ?? base.sharpness,
    artian: !!(w.artian || base.artian),
    gogmaArtian: !!(w.gogmaArtian || base.gogmaArtian),
  };
}

/** damage.js に渡す武器 ({attack, affinity, element}) */
export function damageWeapon(w) {
  if (!w) return { attack: 0, affinity: 0, element: null };
  const el = w.element && w.element.type ? { type: w.element.type, value: Number(w.element.value) || 0 } : null;
  return { attack: Number(w.attack) || 0, affinity: Number(w.affinity) || 0, element: el };
}

// ---------------------------------------------------------------- 斬れ味

function pad6(a) {
  const out = (Array.isArray(a) ? a : []).slice(0, 7).map((v) => Math.max(0, Number(v) || 0));
  while (out.length < 6) out.push(0);
  return out;
}

const sameArr = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * 武器の斬れ味ゲージ {base, handicraftMax}。各色の長さの配列 [赤, 橙, 黄, 緑, 青, 白] (データの順)。
 * 所持武器 (配列だけ持つ) は、元の武器と同じゲージなら元の武器の匠の伸びしろも使う。
 */
export function sharpnessGauge(w, idx) {
  if (!w) return null;
  const base = baseWeaponOf(w, idx);
  const s = w.sharpness ?? (base ? base.sharpness : null);
  if (Array.isArray(s)) {
    const bs = base && base.sharpness;
    const hm = bs && sameArr(bs.base, s) ? bs.handicraftMax : null;
    return { base: pad6(s), handicraftMax: hm ? pad6(hm) : null };
  }
  if (isObj(s) && Array.isArray(s.base)) {
    return { base: pad6(s.base), handicraftMax: Array.isArray(s.handicraftMax) ? pad6(s.handicraftMax) : null };
  }
  return null;
}

/** 匠 Lv を入れたゲージ (1 Lv で 10 ずつ、handicraftMax まで。伸びる色の低い順に) */
export function gaugeWithHandicraft(gauge, level = 0) {
  if (!gauge) return null;
  const out = [...gauge.base];
  if (!gauge.handicraftMax || !(level > 0)) return out;
  let budget = level * HANDICRAFT_STEP;
  for (let i = 0; i < out.length && budget > 0; i++) {
    const room = Math.max(0, (gauge.handicraftMax[i] || 0) - gauge.base[i]);
    const add = Math.min(room, budget);
    out[i] += add;
    budget -= add;
  }
  return out;
}

/** ゲージの一番上の色 ('white' など)。ゲージが無ければ null */
export function topSharpness(gauge) {
  if (!Array.isArray(gauge)) return null;
  for (let i = gauge.length - 1; i >= 0; i--) if (gauge[i] > 0) return SHARPNESS_ORDER[i] || null;
  return null;
}

/** 匠のスキル id (名前で探す。無ければ null) */
export function handicraftSkillId(idx) {
  for (const s of idx.skills.values()) if (s.name === '匠') return s.id;
  return null;
}

/**
 * 斬れ味の色をスキルの組から決める関数 (power_calc.js の input.perSkills)。
 * 斬れ味を固定しているとき (fixedColor がある)・武器が無いときは null (色は変わらない)。
 * 自動のときは匠の Lv で色が変わるので、スキルを外したとき・スキルなしのときの色を決め直すのに使う。
 * opts.intervalSec (研ぐまでに攻撃する秒数) が正なら、匠込みのゲージも返す ({sharpness, sharpnessUse: {gauge, intervalSec}}。
 * damage.js の comboExpected が研ぐまでの色の割合で混ぜる)。
 */
export function sharpnessResolver(weapon, idx, fixedColor, opts = {}) {
  if (fixedColor || !weapon) return null;
  const hid = handicraftSkillId(idx);
  const intervalSec = Number(opts.intervalSec) > 0 ? Number(opts.intervalSec) : 0;
  const cache = new Map();
  return (skills) => {
    let lv = 0;
    for (const s of skills || []) if (hid != null && Number(s.skillId) === hid) lv = Number(s.level) || 0;
    if (!cache.has(lv)) {
      const a = autoSharpness(weapon, idx, hid != null ? { [hid]: lv } : {});
      cache.set(lv, intervalSec && a.gauge
        ? { sharpness: a.color || 'white', sharpnessUse: { gauge: a.gauge, intervalSec } }
        : { sharpness: a.color || 'white' });
    }
    return cache.get(lv);
  };
}

/**
 * 研ぐまでの斬れ味の減り方の入力 (damage.js の comboExpected の sharpnessUse)。
 * 斬れ味を固定しているとき・秒数が 0 か無いとき・ゲージの分からない武器は null (一番上の色のまま)。
 * @param skillLevels computeBuild(...).skillLevels (匠の Lv を見る)
 */
export function sharpnessUseOf(w, idx, skillLevels, intervalSec, fixedColor = null) {
  if (fixedColor || !w || !(Number(intervalSec) > 0)) return null;
  const a = autoSharpness(w, idx, skillLevels || {});
  return a.gauge ? { gauge: a.gauge, intervalSec: Number(intervalSec) } : null;
}

/**
 * 斬れ味の自動の色: いまの装備で出る一番上の色 (匠の Lv を含む)。
 * @param skillLevels computeBuild(...).skillLevels
 * @returns {{color: string|null, handicraft: number, gauge: number[]|null, maxGauge: number[]|null}}
 */
export function autoSharpness(w, idx, skillLevels = {}) {
  const g = sharpnessGauge(w, idx);
  const hid = handicraftSkillId(idx);
  const handicraft = hid != null ? Number(skillLevels[hid]) || 0 : 0;
  const gauge = gaugeWithHandicraft(g, handicraft);
  return {
    color: topSharpness(gauge), handicraft, gauge,
    baseGauge: g ? g.base : null, maxGauge: g ? (g.handicraftMax || g.base) : null,
  };
}
