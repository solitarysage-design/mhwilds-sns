// ダメージ期待値の計算 (純粋関数)。片手剣用。
// ブラウザでも node でも動く ES module。DOM にも node 専用モジュールにも触らない。
// データの形は docs/ARCHITECTURE.md の「データの形 (契約)」、使い方は docs/MODEL_API.md の「damage.js」節。
//
// 式 (docs/ARCHITECTURE.md「計算モデルの方針」):
//   攻撃力 = 武器攻撃力 × 乗算 + 加算 (乗算が先)
//   物理   = 攻撃力 × MV/100 × 物理肉質/100 × 斬れ味物理補正 × 会心期待値 × (心眼・飛燕・鈍器使い)
//   属性   = 属性値(表示)/10 × 技の属性補正 × 属性肉質/100 × 斬れ味属性補正 × 会心撃【属性】期待値
//   属性値 = min(元 × 乗算 + 加算, max(元 + 400, 元 × 2.3))
// 秒あたり DPS は技の時間が非公開なので出さない。代表コンボ 1 回の期待値と、その比 (%) を出す。

/** ゲームデータ (PlayerStatusParam / EmCommonData) の値。data/skill_effects.json の rules で上書きできる。 */
export const DEFAULT_RULES = Object.freeze({
  criticalBase: 1.25,
  criticalNegative: 0.75,
  affinityMin: -100,
  affinityMax: 100,
  elementCapRate: 2.3,
  elementCapAdd: 400,
  physicalRateLimit: 4.0,
  physicalAddLimit: 400,
  weakPointMinHitzone: 45,
  hardPartMaxHitzone: 44,
  sharpness: Object.freeze({
    red: { physical: 0.5, element: 0.25 },
    orange: { physical: 0.75, element: 0.5 },
    yellow: { physical: 1.0, element: 0.75 },
    green: { physical: 1.05, element: 1.0 },
    blue: { physical: 1.2, element: 1.0625 },
    white: { physical: 1.32, element: 1.15 },
    purple: { physical: 1.39, element: 1.25 },
  }),
});

/** 斬れ味の色 (低い順) */
export const SHARPNESS_ORDER = ['red', 'orange', 'yellow', 'green', 'blue', 'white', 'purple'];

/** ダメージになる属性 (状態異常の属性は属性ダメージ 0 として扱う) */
export const ELEMENTAL_TYPES = ['fire', 'water', 'thunder', 'ice', 'dragon'];

/** 条件つきスキルの組み合わせを全列挙する上限 (2^n 通り) */
export const MAX_CONDITIONAL = 14;

/** rules を既定値とまぜる。skill_effects.json 丸ごと / rules だけ / undefined のどれでもよい。 */
export function mergeRules(r) {
  const src = r && r.rules ? r.rules : r || {};
  return { ...DEFAULT_RULES, ...src, sharpness: { ...DEFAULT_RULES.sharpness, ...(src.sharpness || {}) } };
}

/** 会心率 (%) を下限/上限で切る。既定は -100〜100。 */
export function clampAffinity(affinity, rules = DEFAULT_RULES) {
  const lo = rules.affinityMin ?? -100;
  const hi = rules.affinityMax ?? 100;
  return Math.min(hi, Math.max(lo, Number(affinity) || 0));
}

/**
 * 物理の会心期待値。会心率 p (%) が正なら 1 + p/100 × (会心倍率 − 1)、
 * 負なら 1 + |p|/100 × (マイナス会心倍率 − 1)。会心率は先に切る。
 */
export function critExpectation(affinity, critMul = DEFAULT_RULES.criticalBase, rules = DEFAULT_RULES) {
  const p = clampAffinity(affinity, rules) / 100;
  if (p >= 0) return 1 + p * ((critMul ?? rules.criticalBase) - 1);
  return 1 + -p * (rules.criticalNegative - 1);
}

/** 属性の会心期待値。会心撃【属性】が無ければ 1 (会心は属性に掛からない)。マイナス会心は属性に掛からない扱い。 */
export function critElementExpectation(affinity, critElementMul, rules = DEFAULT_RULES) {
  if (!critElementMul) return 1;
  const p = Math.max(0, clampAffinity(affinity, rules)) / 100;
  return 1 + p * (critElementMul - 1);
}

/** 斬れ味の色 → {physical, element}。知らない色は白扱いにせず例外。 */
export function sharpnessMultipliers(color, rules = DEFAULT_RULES) {
  const t = (rules.sharpness || DEFAULT_RULES.sharpness)[color];
  if (!t) throw new Error(`斬れ味の色が不明: ${color}`);
  return { physical: t.physical, element: t.element };
}

/** 属性値 (表示) の上限 = max(元 + 400, 元 × 2.3)。 */
export function elementCap(base, rules = DEFAULT_RULES) {
  return Math.max(base + rules.elementCapAdd, base * rules.elementCapRate);
}

/** スキル込みの属性値 (表示)。乗算が先、上限で切る。 */
export function effectiveElement(base, mul = 1, add = 0, rules = DEFAULT_RULES) {
  if (!base) return 0;
  return Math.min(base * mul + add, elementCap(base, rules));
}

/** スキル込みの攻撃力 = 武器攻撃力 × 乗算 + 加算。乗算・加算はゲームデータの上限 (4.0 倍 / +400) で切る。 */
export function effectiveAttack(base, mul = 1, add = 0, rules = DEFAULT_RULES) {
  const m = Math.min(mul, rules.physicalRateLimit ?? Infinity);
  const a = Math.min(add, rules.physicalAddLimit ?? Infinity);
  return base * m + a;
}

// ------------------------------------------------------------------ スキルの解決

const EMPTY_FIELDS = {
  attackAdd: 0, attackMul: 1, affinityAdd: 0, critMul: null, elementAdd: 0, elementMul: 1,
  weakPointAffinity: 0, woundAffinity: 0, critElementMul: null,
};

function effectsMap(effects) {
  if (!effects) return {};
  return effects.effects || effects;
}

/** skills を [{skillId, level, uptime?}] にそろえる。{skillId: level} の形も受ける。 */
export function normalizeSkills(skills) {
  if (!skills) return [];
  if (Array.isArray(skills)) {
    return skills
      .filter((s) => s && s.skillId != null && (s.level ?? 0) > 0)
      .map((s) => ({ skillId: Number(s.skillId), level: Number(s.level), uptime: s.uptime }));
  }
  return Object.entries(skills)
    .filter(([, lv]) => Number(lv) > 0)
    .map(([id, lv]) => ({ skillId: Number(id), level: Number(lv) }));
}

/**
 * 装備のスキル一覧を skill_effects と突き合わせる。
 * @returns {{active: Array, unsupported: Array, unknown: Array, lowConfidence: Array}}
 *   active[]: {skillId, name, level, entry, lv, conditional, uptime}
 */
export function resolveSkills(skills, effects) {
  const map = effectsMap(effects);
  const list = normalizeSkills(skills);
  const have = new Set(list.map((s) => s.skillId));
  const out = { active: [], unsupported: [], unknown: [], lowConfidence: [] };
  for (const s of list) {
    const entry = map[String(s.skillId)];
    if (!entry) { out.unknown.push({ skillId: s.skillId, level: s.level }); continue; }
    const levels = entry.levels || [];
    if (!levels.length) continue;
    const level = Math.min(s.level, levels[levels.length - 1].level);
    const lv = levels.find((l) => l.level === level) || levels[levels.length - 1];
    const info = { skillId: s.skillId, name: entry.name, level, confidence: entry.confidence };
    if (entry.supported === false) { out.unsupported.push({ ...info, reason: entry.note || '' }); continue; }
    if (entry.requiresSkillId != null && !have.has(Number(entry.requiresSkillId))) {
      out.unsupported.push({ ...info, reason: `必要なスキル (id ${entry.requiresSkillId}) が無いので効かない` });
      continue;
    }
    if (entry.confidence === 'low') out.lowConfidence.push(info);
    let uptime = entry.conditional ? (s.uptime ?? entry.defaultUptime ?? 0.5) : 1;
    uptime = Math.min(1, Math.max(0, Number(uptime)));
    out.active.push({ ...info, entry, lv, conditional: !!entry.conditional, uptime });
  }
  return out;
}

function elementMatches(fx, weaponElementType) {
  return !fx.elementType || fx.elementType === weaponElementType;
}

/** 有効な効果 (レベルの値か whenInactive) の集まりを、1 つの補正値にまとめる。 */
export function aggregateModifiers(effectList, weaponElementType, buffs = {}) {
  const m = {
    attackMul: buffs.attackMul ?? 1, attackAdd: buffs.attackAdd ?? 0,
    affinityAdd: buffs.affinityAdd ?? 0, critMul: null,
    elementMul: buffs.elementMul ?? 1, elementAdd: buffs.elementAdd ?? 0,
    weakPointAffinity: 0, woundAffinity: 0, weakPointMinHitzone: null,
    critElementMul: null, hardPartMul: 1, hardPartMaxHitzone: null, jumpMul: 1,
    lowSharpnessMul: 1, lowSharpnessMaxColor: null, extraDamage: [],
  };
  for (const raw of effectList) {
    const fx = { ...EMPTY_FIELDS, ...raw };
    m.attackMul *= fx.attackMul ?? 1;
    m.attackAdd += fx.attackAdd ?? 0;
    m.affinityAdd += fx.affinityAdd ?? 0;
    if (fx.critMul != null) m.critMul = Math.max(m.critMul ?? 0, fx.critMul);
    if (elementMatches(fx, weaponElementType)) {
      m.elementMul *= fx.elementMul ?? 1;
      m.elementAdd += fx.elementAdd ?? 0;
    }
    m.weakPointAffinity += fx.weakPointAffinity ?? 0;
    m.woundAffinity += fx.woundAffinity ?? 0;
    if (fx.weakPointMinHitzone != null) m.weakPointMinHitzone = fx.weakPointMinHitzone;
    if (fx.critElementMul != null) m.critElementMul = Math.max(m.critElementMul ?? 0, fx.critElementMul);
    if (fx.hardPartMul != null && fx.hardPartMul > m.hardPartMul) {
      m.hardPartMul = fx.hardPartMul;
      m.hardPartMaxHitzone = fx.hardPartMaxHitzone ?? null;
    }
    if (fx.jumpMul != null) m.jumpMul *= fx.jumpMul;
    if (fx.lowSharpnessMul != null && fx.lowSharpnessMul >= m.lowSharpnessMul) {
      m.lowSharpnessMul = fx.lowSharpnessMul;
      m.lowSharpnessMaxColor = fx.lowSharpnessMaxColor ?? 'yellow';
    }
    if (fx.extraDamage) m.extraDamage.push(fx.extraDamage);
  }
  return m;
}

/**
 * 武器 + 補正値 → 計算用の数値。
 * @param {object} weapon {attack, affinity, element: {type, value}|null}  attack は係数なし、element.value は表示値
 */
export function computeStats(weapon, mods, rules = DEFAULT_RULES) {
  const elemType = weapon.element ? weapon.element.type : null;
  const elemBase = weapon.element ? Number(weapon.element.value) || 0 : 0;
  const elemValue = ELEMENTAL_TYPES.includes(elemType)
    ? effectiveElement(elemBase, mods.elementMul, mods.elementAdd, rules) : 0;
  return {
    attack: effectiveAttack(Number(weapon.attack) || 0, mods.attackMul, mods.attackAdd, rules),
    affinity: (Number(weapon.affinity) || 0) + mods.affinityAdd,
    critMul: mods.critMul ?? rules.criticalBase,
    elementType: elemType,
    element: elemValue,
    elementBase: elemBase,
    mods,
  };
}

// ------------------------------------------------------------------ 1 ヒット

function physicalHitzone(hz, type) {
  if (!hz) return 0;
  if (type === 'slash') return hz.slash ?? 0;
  if (type === 'blow' || type === 'blunt') return hz.blunt ?? hz.blow ?? 0;
  if (type === 'shot') return hz.shot ?? 0;
  return 0;
}

/**
 * 1 ヒットの期待ダメージ (count 回分の合計)。
 * @param {object} hit motions_sns.json の moves[].hits[] の 1 件
 * @param {object} stats computeStats の結果
 * @param {object} ctx {hitzone, isWound, sharpness, rules}
 *   hitzone: {slash, blunt, fire, water, thunder, ice, dragon} (0〜100)。傷口なら傷口の肉質を渡す
 * @returns {{physical, element, extra, total, affinity, critExp}}
 */
export function hitDamage(hit, stats, ctx) {
  const rules = ctx.rules || DEFAULT_RULES;
  const hz = ctx.hitzone || {};
  const m = stats.mods;
  const color = ctx.sharpness || 'white';
  const count = hit.count ?? 1;
  const physHz = physicalHitzone(hz, hit.type);

  // 会心率: 武器 + スキル + 弱点特効 (肉質しきい値以上) + 傷口の追加分
  const wpMin = m.weakPointMinHitzone ?? rules.weakPointMinHitzone;
  let aff = stats.affinity;
  if (physHz >= wpMin) aff += m.weakPointAffinity;
  if (ctx.isWound) aff += m.woundAffinity;
  const affinity = clampAffinity(aff, rules);

  const sharp = hit.sharpnessMul === false ? { physical: 1, element: 1 } : sharpnessMultipliers(color, rules);
  const critExp = hit.canCrit === false ? 1 : critExpectation(affinity, stats.critMul, rules);

  let physMul = 1;
  const hardMax = m.hardPartMaxHitzone ?? rules.hardPartMaxHitzone;
  if (m.hardPartMul !== 1 && physHz <= hardMax) physMul *= m.hardPartMul;
  if (hit.hien) physMul *= m.jumpMul;
  if (m.lowSharpnessMul !== 1 && m.lowSharpnessMaxColor
      && SHARPNESS_ORDER.indexOf(color) <= SHARPNESS_ORDER.indexOf(m.lowSharpnessMaxColor)) {
    physMul *= m.lowSharpnessMul;
  }
  const physical = stats.attack * (hit.mv / 100) * (physHz / 100) * sharp.physical * critExp * physMul
    + (hit.fixed || 0);

  let element = 0;
  const rate = hit.usesElement === false ? 0 : (hit.elementRate ?? 0);
  if (rate > 0 && stats.element > 0 && ELEMENTAL_TYPES.includes(stats.elementType)) {
    const elemHz = hz[stats.elementType] ?? 0;
    const critE = hit.canCrit === false ? 1 : critElementExpectation(affinity, m.critElementMul, rules);
    element = (stats.element / 10) * rate * (elemHz / 100) * sharp.element * critE;
  }

  // 灼熱化などの追加ダメージ: 固定 + 属性(表示/10) × その属性の肉質。確率で掛ける。クールタイムは入れない。
  let extra = 0;
  for (const x of m.extraDamage) {
    if (x.appliesTo === 'additionalDamageHits' && !hit.additionalDamage) continue;
    const xHz = x.elementType ? (hz[x.elementType] ?? 0) : 0;
    extra += (x.chance ?? 1) * ((x.fixed || 0) + ((x.element || 0) / 10) * (xHz / 100));
  }
  return {
    physical: physical * count, element: element * count, extra: extra * count,
    total: (physical + element + extra) * count, affinity, critExp,
  };
}

// ------------------------------------------------------------------ 条件つきスキルの加重平均

/**
 * 条件つきスキルの発動/非発動の全パターン (独立と仮定) を列挙する。発動率 0 と 1 は固定扱い。
 * @returns {Array<{weight:number, on:boolean[]}>}  on[i] は active[i] が発動しているか
 */
export function enumeratePatterns(active) {
  const varIdx = [];
  const base = active.map((a, i) => {
    if (!a.conditional || a.uptime >= 1) return true;
    if (a.uptime <= 0) return false;
    varIdx.push(i);
    return null;
  });
  if (varIdx.length > MAX_CONDITIONAL) {
    throw new Error(`条件つきスキルが多すぎる (${varIdx.length} > ${MAX_CONDITIONAL})`);
  }
  const out = [];
  const n = 1 << varIdx.length;
  for (let mask = 0; mask < n; mask++) {
    const on = base.slice();
    let w = 1;
    varIdx.forEach((idx, k) => {
      const isOn = ((mask >> k) & 1) === 1;
      on[idx] = isOn;
      w *= isOn ? active[idx].uptime : 1 - active[idx].uptime;
    });
    if (w > 0) out.push({ weight: w, on });
  }
  return out;
}

function effectsFor(active, on) {
  const list = [];
  active.forEach((a, i) => {
    if (on[i]) list.push(a.lv);
    else if (a.lv.whenInactive) list.push(a.lv.whenInactive);
  });
  return list;
}

// ------------------------------------------------------------------ コンボ

function movesMap(motions) {
  const list = motions ? (motions.moves || motions) : [];
  const m = new Map();
  for (const mv of list) m.set(mv.id, mv);
  return m;
}

/** コンボを [{move, onWound}] の並びにする。combo は combos_sns.json の 1 件か、技 id の配列。 */
function comboSteps(combo) {
  if (Array.isArray(combo)) return combo.map((s) => (typeof s === 'string' ? { move: s } : s));
  return combo.steps || [];
}

/**
 * 代表コンボ 1 回の期待ダメージ。
 * @param {object} input
 *   weapon:    {attack, affinity, element: {type, value}|null}  (weapons_sns.json / my_weapons.json の 1 件)
 *   sharpness: 'white' など (今の斬れ味の色)
 *   skills:    [{skillId, level, uptime?}] か {skillId: level}  (build.js の skills / skillLevels をそのまま渡せる)
 *   effects:   data/skill_effects.json (丸ごと)
 *   motions:   data/motions_sns.json (丸ごと)
 *   combo:     data/combos_sns.json の combos[] の 1 件、または技 id の配列
 *   target:    {hitzone: {slash, blunt, fire, ...}, wound?: {...}, isWound?: bool}
 *   buffs:     {attackAdd, attackMul, affinityAdd, elementAdd, elementMul} (アイテム等。省略可)
 *   rules:     既定は effects.rules → DEFAULT_RULES
 * @returns {{total, physical, element, extra, patterns, steps, unsupported, unknown, lowConfidence}}
 */
export function comboExpected(input) {
  const rules = mergeRules(input.rules || (input.effects && input.effects.rules));
  const resolved = resolveSkills(input.skills, input.effects);
  const moves = movesMap(input.motions);
  const steps = comboSteps(input.combo);
  const target = input.target || {};
  const weapon = input.weapon || { attack: 0, affinity: 0, element: null };
  const elemType = weapon.element ? weapon.element.type : null;
  const patterns = enumeratePatterns(resolved.active);

  const stepTotals = steps.map((s) => ({ move: s.move, name: moves.get(s.move)?.name ?? s.move,
    total: 0, physical: 0, element: 0, extra: 0 }));
  let total = 0; let physical = 0; let element = 0; let extra = 0;
  for (const p of patterns) {
    const mods = aggregateModifiers(effectsFor(resolved.active, p.on), elemType, input.buffs || {});
    const stats = computeStats(weapon, mods, rules);
    steps.forEach((s, si) => {
      const mv = moves.get(s.move);
      if (!mv) throw new Error(`技 ${s.move} が motions に無い`);
      const onWound = !!(s.onWound || target.isWound);
      const hitzone = onWound && target.wound ? target.wound : target.hitzone;
      for (const hit of mv.hits) {
        const d = hitDamage(hit, stats, { hitzone, isWound: onWound, sharpness: input.sharpness || 'white', rules });
        const st = stepTotals[si];
        st.total += p.weight * d.total; st.physical += p.weight * d.physical;
        st.element += p.weight * d.element; st.extra += p.weight * d.extra;
        total += p.weight * d.total; physical += p.weight * d.physical;
        element += p.weight * d.element; extra += p.weight * d.extra;
      }
    });
  }
  return {
    total, physical, element, extra,
    patterns: patterns.length,
    steps: stepTotals,
    unsupported: resolved.unsupported,
    unknown: resolved.unknown,
    lowConfidence: resolved.lowConfidence,
  };
}

function pct(a, b) {
  return b > 0 ? (a / b - 1) * 100 : 0;
}

function maxLevelOf(effects, skillId) {
  const e = effectsMap(effects)[String(skillId)];
  const lv = e && e.levels ? e.levels : [];
  return lv.length ? lv[lv.length - 1].level : 0;
}

/**
 * スキルの寄与を出す。
 * @param {object} input comboExpected と同じ
 * @returns {{
 *   total, noSkills, vsNoSkillsPct,
 *   removeEach: Array<{skillId, name, level, total, dropPct}>,
 *   perLevel: Array<{skillId, name, level, maxLevel, levels: Array<{level, total, gainPctVsNone, gainPctVsPrev}>}>,
 *   unsupported, unknown, lowConfidence
 * }}
 *   vsNoSkillsPct: スキル全部あり ÷ スキルなし − 1 (%)
 *   dropPct:       そのスキルだけ外したときの低下 (%)。正の数ほど効いている
 *   gainPctVsNone: そのスキルだけ Lv を変えたときの、Lv0 比の上昇 (%)
 */
export function skillContribution(input) {
  const list = normalizeSkills(input.skills);
  const base = comboExpected({ ...input, skills: list });
  const none = comboExpected({ ...input, skills: [] });
  const removeEach = [];
  const perLevel = [];
  for (const s of list) {
    const entry = effectsMap(input.effects)[String(s.skillId)];
    const others = list.filter((o) => o.skillId !== s.skillId);
    const without = comboExpected({ ...input, skills: others });
    removeEach.push({
      skillId: s.skillId, name: entry ? entry.name : String(s.skillId), level: s.level,
      total: without.total, dropPct: base.total > 0 ? (1 - without.total / base.total) * 100 : 0,
    });
    const maxLevel = maxLevelOf(input.effects, s.skillId);
    const levels = [{ level: 0, total: without.total, gainPctVsNone: 0, gainPctVsPrev: 0 }];
    for (let lv = 1; lv <= maxLevel; lv++) {
      const r = comboExpected({ ...input, skills: [...others, { ...s, level: lv }] });
      levels.push({
        level: lv, total: r.total,
        gainPctVsNone: pct(r.total, without.total),
        gainPctVsPrev: pct(r.total, levels[levels.length - 1].total),
      });
    }
    perLevel.push({ skillId: s.skillId, name: entry ? entry.name : String(s.skillId), level: s.level, maxLevel, levels });
  }
  removeEach.sort((a, b) => b.dropPct - a.dropPct);
  return {
    total: base.total, noSkills: none.total, vsNoSkillsPct: pct(base.total, none.total),
    removeEach, perLevel,
    unsupported: base.unsupported, unknown: base.unknown, lowConfidence: base.lowConfidence,
  };
}
