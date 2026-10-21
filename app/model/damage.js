// ダメージ期待値の計算 (純粋関数)。片手剣用。
// ブラウザでも node でも動く ES module。DOM にも node 専用モジュールにも触らない。
// データの形は docs/ARCHITECTURE.md の「データの形 (契約)」、使い方は docs/MODEL_API.md の「damage.js」節。
//
// 式 (docs/ARCHITECTURE.md「計算モデルの方針」):
//   攻撃力 = 武器攻撃力 × min(乗算, 4.0) + min(加算, 400) (乗算が先)
//   物理   = 攻撃力 × MV/100 × 物理肉質/100 × 斬れ味物理補正 × 会心期待値 × (心眼・飛燕・鈍器使い)
//   属性   = 属性値(表示)/10 × 技の属性補正 × 属性肉質/100 × 斬れ味属性補正 × 会心撃【属性】期待値
//   属性値 = 元 × min(乗算, 2.3) + min(加算, 400)   (攻撃と同じく倍率と加算を別々に切る)
// 条件つきスキルの発動率は「条件ごと」(skill_effects.json の rules.conditionGroups) に持ち、
// 条件の組み合わせ (パターン) の加重平均を出す。
// 秒あたり DPS は技の時間が非公開なので出さない。代表コンボ 1 回の期待値と、その比 (%) を出す。

/** ゲームデータ (PlayerStatusParam / EmCommonData) の値。data/skill_effects.json の rules で上書きできる。 */
export const DEFAULT_RULES = Object.freeze({
  criticalBase: 1.25,
  criticalNegative: 0.75,
  affinityMin: -100,
  affinityMax: 100,
  elementRateLimit: 2.3,
  elementAddLimit: 400,
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
  conditionGroups: Object.freeze([]),
});

/** 斬れ味の色 (低い順) */
export const SHARPNESS_ORDER = ['red', 'orange', 'yellow', 'green', 'blue', 'white', 'purple'];

/** ダメージになる属性 (状態異常の属性は属性ダメージ 0 として扱う) */
export const ELEMENTAL_TYPES = ['fire', 'water', 'thunder', 'ice', 'dragon'];

/** 条件の組み合わせ (パターン) の数の上限。超えたら例外 */
export const MAX_PATTERNS = 1 << 14;

/** 重みがこれ以下のパターンは捨てる (浮動小数のごみ) */
const EPS = 1e-12;

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

/**
 * スキル込みの属性値 (表示) = 元 × min(乗算, 2.3) + min(加算, 400)。
 * 攻撃 (_PhysicalAttack_RateLimit / _AddLimit) と同じく、倍率と加算を別々に切る
 * (PlayerStatusParam._ElementAttack_RateLimit=2.3 / _ElementAttack_AddLimit=40 → 表示 400。確度 medium)。
 */
export function effectiveElement(base, mul = 1, add = 0, rules = DEFAULT_RULES) {
  if (!base) return 0;
  const m = Math.min(mul, rules.elementRateLimit ?? Infinity);
  const a = Math.min(add, rules.elementAddLimit ?? Infinity);
  return base * m + a;
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

/** skills を [{skillId, level}] にそろえる。{skillId: level} の形も受ける。発動率はここでは持たない (uptimes で渡す)。 */
export function normalizeSkills(skills) {
  if (!skills) return [];
  if (Array.isArray(skills)) {
    return skills
      .filter((s) => s && s.skillId != null && (s.level ?? 0) > 0)
      .map((s) => ({ skillId: Number(s.skillId), level: Number(s.level) }));
  }
  return Object.entries(skills)
    .filter(([, lv]) => Number(lv) > 0)
    .map(([id, lv]) => ({ skillId: Number(id), level: Number(lv) }));
}

function isLowConfidence(entry, lv) {
  return entry.confidence === 'low' || lv.confidence === 'low'
    || !!(lv.extraDamage && lv.extraDamage.confidence === 'low');
}

/**
 * 装備のスキル一覧を skill_effects と突き合わせる。
 * @returns {{active: Array, unsupported: Array, unknown: Array, lowConfidence: Array}}
 *   active[]: {skillId, name, level, confidence, entry, lv, conditional, conditionGroup, activeStates}
 *   lowConfidence[]: {skillId, name, level, confidence, reason}  確度 low の値で計算したスキル (画面で「未確定」)
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
    if (isLowConfidence(entry, lv)) out.lowConfidence.push({ ...info, confidence: 'low', reason: entry.note || '' });
    out.active.push({
      ...info, entry, lv, conditional: !!entry.conditional,
      conditionGroup: entry.conditional ? (entry.conditionGroup ?? null) : null,
      activeStates: entry.conditional && Array.isArray(entry.activeStates) ? entry.activeStates : null,
    });
  }
  return out;
}

// ------------------------------------------------------------------ 条件グループ (発動率は条件ごと)

const BINARY_STATES = [{ id: 'off', label: '発動していない' }, { id: 'on', label: '発動中' }];

function normalizeGroupDef(g) {
  const categorical = g.type === 'categorical';
  const states = categorical
    ? (g.states || []).map((s) => (typeof s === 'string' ? { id: s, label: s } : { id: s.id, label: s.label ?? s.id }))
    : BINARY_STATES.map((s) => ({ ...s }));
  const src = g.sources && typeof g.sources === 'object' ? g.sources : null;
  return {
    id: g.id, label: g.label ?? g.id, type: categorical ? 'categorical' : 'binary', states,
    offState: categorical ? (g.offState ?? (states[0] ? states[0].id : 'none')) : 'off',
    defaultUptime: g.defaultUptime ?? (categorical ? {} : 0.5),
    placeholder: !!g.placeholder, uptimeBasis: g.uptimeBasis ?? '', note: g.note ?? '',
    exclusiveWith: new Set(g.exclusiveWith || []),
    sources: src ? {
      skillIds: (Array.isArray(src.skillIds) ? src.skillIds : []).map(Number),
      monsterStatus: Array.isArray(src.monsterStatus) ? src.monsterStatus : [],
      label: src.label ?? '', inactiveText: src.inactiveText ?? '',
    } : null,
  };
}

/**
 * 条件のもと (sources) が無いか。sources のある条件 (狂竜症など) は、そのスキルを装備しておらず、
 * 相手もその状態異常を使わないときは起きない。
 * @param def 条件グループの定義 (conditionGroupDefs の値)
 * @param {Set<number>} skillIds 装備しているスキルの id
 * @param monsterStatus 相手が使う状態異常のキーの配列。null / undefined = 分からない (このときは決めつけない)
 * @returns 起きないなら true
 */
export function conditionSourceMissing(def, skillIds, monsterStatus) {
  const src = def && def.sources;
  if (!src) return false;
  if (src.skillIds.some((id) => skillIds.has(id))) return false;
  if (!Array.isArray(monsterStatus)) return false;
  return !src.monsterStatus.some((k) => monsterStatus.includes(k));
}

/**
 * 条件グループの定義を id → 定義 の Map にする (並びはデータの順)。
 * exclusiveWith は片側にだけ書かれていても両側に効かせる。
 * @param {object} src skill_effects.json 丸ごと / rules / conditionGroups の配列
 */
export function conditionGroupDefs(src) {
  let list = [];
  if (Array.isArray(src)) list = src;
  else if (src && src.rules && Array.isArray(src.rules.conditionGroups)) list = src.rules.conditionGroups;
  else if (src && Array.isArray(src.conditionGroups)) list = src.conditionGroups;
  const defs = new Map();
  for (const g of list) if (g && g.id) defs.set(g.id, normalizeGroupDef(g));
  for (const d of defs.values()) for (const o of d.exclusiveWith) if (defs.has(o)) defs.get(o).exclusiveWith.add(d.id);
  return defs;
}

/** 発動率として読める値なら 0〜1 に切って返す。読めなければ null。 */
function toProb(x) {
  if (typeof x === 'boolean') return x ? 1 : 0;
  if (typeof x === 'string' && x.trim() !== '') x = Number(x);
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  return Math.min(1, Math.max(0, x));
}

function nonOffStates(def) {
  return def.states.map((s) => s.id).filter((s) => s !== def.offState);
}

/**
 * 1 グループの段ごとの割合 {段 id: 割合} (offState は残り)。raw が undefined なら既定値。
 * binary は数 (0〜1、真偽値も可)、categorical は {段 id: 割合}。渡さない段は 0。合計が 1 を超えたら縮める。
 */
function groupProbs(def, raw, warnings) {
  const nonOff = nonOffStates(def);
  const probs = {};
  const bad = () => warnings.push({
    code: 'bad-uptime', groupId: def.id, message: `「${def.label}」の発動率が読めないので、既定の値で計算しました`,
  });
  if (def.type === 'binary') {
    let p = raw === undefined ? null : toProb(raw);
    if (p == null) {
      if (raw !== undefined) bad();
      p = toProb(def.defaultUptime) ?? 0.5;
    }
    probs.on = p;
  } else {
    let src = raw;
    if (src !== undefined && (src === null || typeof src !== 'object' || Array.isArray(src))) { bad(); src = undefined; }
    if (src === undefined) src = def.defaultUptime || {};
    else {
      for (const k of Object.keys(src)) {
        if (k !== def.offState && !nonOff.includes(k)) {
          warnings.push({ code: 'unknown-state', groupId: def.id, message: `「${def.label}」に「${k}」という段は無いので無視しました` });
        }
      }
    }
    let sum = 0;
    for (const s of nonOff) { const p = toProb(src[s]) ?? 0; probs[s] = p; sum += p; }
    if (sum > 1 + 1e-9) {
      for (const s of nonOff) probs[s] /= sum;
      warnings.push({
        code: 'uptime-over-100', groupId: def.id,
        message: `「${def.label}」の段ごとの割合の合計が 100% を超えているので、合計 100% に縮めて計算しました`,
      });
    }
  }
  probs[def.offState] = Math.max(0, 1 - nonOff.reduce((t, s) => t + probs[s], 0));
  return probs;
}

/**
 * 条件つきスキル (resolveSkills の active) が使う条件グループを集め、発動率を決める。
 * @param {Array} active resolveSkills(...).active
 * @param {object} src skill_effects.json 丸ごと / rules / conditionGroups の配列
 * @param {object} uptimes {グループ id: 発動率}。binary は 0〜1、categorical は {段 id: 割合}
 *   (または平らなキー {"<グループ id>.<段 id>": 割合})。省略は既定値
 * @param {object} [ctx] {skillIds: 装備しているスキルの id の配列, monsterStatus: 相手が使う状態異常のキーの配列 | null}
 *   条件のもと (sources) を確かめるのに使う。sources のある条件は、もとが無ければ「発動していない」100% にする
 * @returns {{active: Array, groups: Array, warnings: Array}}
 *   active は conditionGroup / activeStates を確定させたもの。
 *   groups[]: {id, label, type, states, offState, probs, uptime, defaultUptime, fromInput, placeholder,
 *              uptimeBasis, exclusiveWith, skills, note, inactive, inactiveReason}
 *   inactive = 条件のもとが無いので 0% で計算した (inactiveReason は画面に出せる日本語)。
 *   conditionGroup の無い条件つきスキルは、そのスキルだけのグループ "skill:<skillId>" として扱う。
 */
export function resolveConditions(active, src, uptimes, ctx = {}) {
  const defs = conditionGroupDefs(src);
  const input = uptimes && typeof uptimes === 'object' ? uptimes : {};
  const warnings = [];
  const used = new Map(); // id -> {def, skills}
  const outActive = active.map((a) => {
    if (!a.conditional) return a;
    const gid = a.conditionGroup ?? `skill:${a.skillId}`;
    let u = used.get(gid);
    if (!u) {
      let def = defs.get(gid);
      if (!def) {
        if (a.conditionGroup != null) {
          warnings.push({
            code: 'unknown-condition-group', groupId: gid, skillId: a.skillId,
            message: `${a.name} の条件 (${gid}) が skill_effects.json に無いので、このスキルだけの条件として計算しました`,
          });
        }
        const e = a.entry || {};
        def = normalizeGroupDef({
          id: gid, label: `${a.name} の発動条件`, type: 'binary',
          defaultUptime: e.defaultUptime ?? 0.5, placeholder: true, uptimeBasis: e.uptimeBasis ?? '',
        });
      }
      used.set(gid, (u = { def, skills: [] }));
    }
    u.skills.push({ skillId: a.skillId, name: a.name });
    const stateIds = u.def.states.map((s) => s.id);
    const activeStates = a.activeStates && a.activeStates.length
      ? a.activeStates : (u.def.type === 'binary' ? ['on'] : nonOffStates(u.def));
    for (const s of activeStates) {
      if (!stateIds.includes(s)) {
        warnings.push({
          code: 'unknown-state', groupId: gid, skillId: a.skillId,
          message: `${a.name} の発動する段「${s}」が「${u.def.label}」に無い`,
        });
      }
    }
    return { ...a, conditionGroup: gid, activeStates };
  });

  const order = [...[...defs.keys()].filter((id) => used.has(id)), ...[...used.keys()].filter((id) => !defs.has(id))];
  const haveIds = new Set((ctx.skillIds || active.map((a) => a.skillId)).map(Number));
  const groups = order.map((id) => {
    const { def, skills } = used.get(id);
    if (conditionSourceMissing(def, haveIds, ctx.monsterStatus)) {
      // もとが無い: 入れた発動率に関係なく「発動していない」100%
      const probs = { [def.offState]: 1 };
      for (const s of nonOffStates(def)) probs[s] = 0;
      return {
        id, label: def.label, type: def.type, states: def.states.map((s) => ({ ...s })), offState: def.offState,
        probs, uptime: def.type === 'binary' ? 0 : Object.fromEntries(nonOffStates(def).map((s) => [s, 0])),
        defaultUptime: def.defaultUptime, fromInput: false, placeholder: false,
        uptimeBasis: def.uptimeBasis, exclusiveWith: [...def.exclusiveWith].filter((o) => used.has(o)),
        skills, note: def.note, inactive: true,
        inactiveReason: def.sources.inactiveText
          || `「${def.label}」のもとになるスキルも相手の攻撃も無いので、起きない (0%) として計算しています。`,
      };
    }
    let raw = Object.prototype.hasOwnProperty.call(input, id) && input[id] != null ? input[id] : undefined;
    // categorical は数だけの入れ物にも置けるよう "<グループ id>.<段 id>" の平らなキーも受ける
    if (raw === undefined && def.type === 'categorical') {
      const flat = {};
      for (const s of nonOffStates(def)) {
        const k = `${id}.${s}`;
        if (Object.prototype.hasOwnProperty.call(input, k) && input[k] != null) flat[s] = input[k];
      }
      if (Object.keys(flat).length) raw = flat;
    }
    const fromInput = raw !== undefined;
    const probs = groupProbs(def, raw, warnings);
    return {
      id, label: def.label, type: def.type, states: def.states.map((s) => ({ ...s })), offState: def.offState,
      probs,
      uptime: def.type === 'binary' ? probs.on : Object.fromEntries(nonOffStates(def).map((s) => [s, probs[s]])),
      defaultUptime: def.defaultUptime, fromInput, placeholder: !fromInput && def.placeholder,
      uptimeBasis: def.uptimeBasis, exclusiveWith: [...def.exclusiveWith].filter((o) => used.has(o)),
      skills, note: def.note, inactive: false, inactiveReason: '',
    };
  });
  return { active: outActive, groups, warnings };
}

/** 同時に起きない条件の合計が 100% を超えたとき、どれを先に決めて保つか (小さいほど先) */
function keepRank(g) {
  if (g.fromInput) return 0;      // 本人が入れた値
  if (!g.placeholder) return 1;   // 根拠のある既定値
  return 2;                       // 根拠の無い仮置き (ここから減らす)
}

/**
 * 条件グループの段の全組み合わせ (パターン) と重みを出す。
 * 互いに関係の無い条件は独立と仮定する。exclusiveWith (同時に起きない) の組は「両方発動」に重みを付けない:
 * 先に決めた相手が全部「発動していない」パターンの中だけで発動させ、各条件の発動率 (周辺確率) は保つ。
 * 決める順は 本人が入れた条件 → 根拠のある既定値 → 仮置き (同じ扱いどうしはデータの並び)。
 * 発動率の合計が 100% を超えて保てないときは、後に決める条件 (仮置きなど) を減らして warnings に書く。
 * @param {Array} groups resolveConditions(...).groups
 * @returns {{patterns: Array<{weight:number, states:Object}>, warnings: Array}}  states は {グループ id: 段 id}
 */
export function enumeratePatterns(groups) {
  const warnings = [];
  let partials = [{ weight: 1, states: {} }];
  const done = [];
  const ordered = groups.map((g, i) => ({ g, i }))
    .sort((a, b) => keepRank(a.g) - keepRank(b.g) || a.i - b.i).map((x) => x.g);
  for (const g of ordered) {
    const nonOff = nonOffStates(g);
    const excl = g.exclusiveWith || [];
    const partners = done.filter((d) => excl.includes(d.id) || (d.exclusiveWith || []).includes(g.id));
    const isFree = (p) => partners.every((d) => p.states[d.id] === d.offState);
    const cond = {};
    for (const s of nonOff) cond[s] = g.probs[s] || 0;
    if (partners.length) {
      const want = nonOff.reduce((t, s) => t + cond[s], 0);
      const q = partials.reduce((t, p) => t + (isFree(p) ? p.weight : 0), 0);
      let conflict = false;
      if (q <= EPS) {
        for (const s of nonOff) cond[s] = 0;
        conflict = want > EPS;
      } else {
        for (const s of nonOff) cond[s] /= q;
        const sum = nonOff.reduce((t, s) => t + cond[s], 0);
        if (sum > 1 + 1e-9) {
          for (const s of nonOff) cond[s] /= sum;
          conflict = true;
        }
      }
      if (conflict) {
        warnings.push({
          code: 'exclusive-conflict', groupId: g.id, with: partners.map((d) => d.id),
          message: `「${g.label}」と「${partners.map((d) => d.label).join('」「')}」は同時に起きないのに、`
            + `発動率の合計が 100% を超えています。「${g.label}」を減らして計算しました`,
        });
      }
    }
    const offCond = Math.max(0, 1 - nonOff.reduce((t, s) => t + cond[s], 0));
    const next = [];
    for (const p of partials) {
      if (!isFree(p)) {
        next.push({ weight: p.weight, states: { ...p.states, [g.id]: g.offState } });
        continue;
      }
      if (offCond > EPS) next.push({ weight: p.weight * offCond, states: { ...p.states, [g.id]: g.offState } });
      for (const s of nonOff) {
        if (cond[s] > EPS) next.push({ weight: p.weight * cond[s], states: { ...p.states, [g.id]: s } });
      }
    }
    if (next.length > MAX_PATTERNS) {
      throw new Error(`条件の組み合わせが多すぎる (${next.length} > ${MAX_PATTERNS})`);
    }
    partials = next;
    done.push(g);
  }
  return { patterns: partials.filter((p) => p.weight > EPS), warnings };
}

/** そのパターンで効いている効果の一覧。段ごとの効果 (byState) があればそれ、主効果の段なら levels[] の値。 */
function effectsFor(active, states) {
  const list = [];
  for (const a of active) {
    if (!a.conditional) { list.push(a.lv); continue; }
    const s = states[a.conditionGroup];
    const byState = a.lv.byState && a.lv.byState[s];
    if (byState) list.push(byState);
    else if (a.activeStates.includes(s)) list.push(a.lv);
  }
  return list;
}

function elementMatches(fx, weaponElementType) {
  return !fx.elementType || fx.elementType === weaponElementType;
}

/** 有効な効果 (レベルの値か段ごとの値) の集まりを、1 つの補正値にまとめる。 */
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
  return (combo && combo.steps) || [];
}

const WOUND_ONLY_LABEL = /^(傷口|白傷)の追加ヒット/;

/**
 * 傷口 (白傷) に当てたときだけ出るヒットか。hits[].woundOnly があればそれ、
 * 無ければ motions_sns.json のラベル (「傷口の追加ヒット」「白傷の追加ヒット…」) で見分ける。
 */
export function isWoundOnlyHit(hit) {
  if (typeof hit.woundOnly === 'boolean') return hit.woundOnly;
  return WOUND_ONLY_LABEL.test(hit.label || '');
}

function pushWarning(warnings, w) {
  if (!warnings.some((x) => x.code === w.code && x.move === w.move)) warnings.push(w);
}

/**
 * コンボの段ごとに、使う肉質・傷口かどうか・数えるヒットを決める。
 * 傷口の段 (onWound か target.isWound) でも、部位に傷口が無い (target.wound が null) なら傷口なしで計算し、
 * 傷口でだけ出るヒットと弱点特効の傷口分は入れない。傷口でない段でも傷口でだけ出るヒットは数えない。
 */
function planSteps(steps, moves, target, warnings) {
  return steps.map((s) => {
    const mv = moves.get(s.move);
    if (!mv) throw new Error(`技 ${s.move} が motions に無い`);
    const wantWound = !!(s.onWound || target.isWound);
    const isWound = wantWound && target.wound != null;
    if (wantWound && !isWound) {
      pushWarning(warnings, {
        code: 'no-wound', move: s.move,
        message: `この部位には傷口ができません。「${mv.name}」は傷口なしで計算しました`
          + ' (傷口でだけ出るヒットと、弱点特効の傷口の分は入れていません)',
      });
    }
    const hits = mv.hits.filter((h) => isWound || !isWoundOnlyHit(h));
    if (!wantWound && hits.length < mv.hits.length) {
      pushWarning(warnings, {
        code: 'wound-only-hits-skipped', move: s.move,
        message: `「${mv.name}」は傷口に当てない段なので、傷口でだけ出るヒットは数えていません`,
      });
    }
    return { move: s.move, name: mv.name, hitzone: isWound ? target.wound : target.hitzone, isWound, hits };
  });
}

/** 画面に出す形の条件グループ (probs は残す。exclusiveWith は使っているグループだけ)。 */
function publicGroup(g) {
  return { ...g, states: g.states.map((s) => ({ ...s })) };
}

/**
 * 代表コンボ 1 回の期待ダメージ。
 * @param {object} input
 *   weapon:    {attack, affinity, element: {type, value}|null}  (weapons_sns.json / my_weapons.json の 1 件)
 *   sharpness: 'white' など (今の斬れ味の色)
 *   skills:    [{skillId, level}] か {skillId: level}  (build.js の skills / skillLevels をそのまま渡せる)
 *   uptimes:   {条件グループ id: 発動率}。binary は 0〜1、categorical は {段 id: 割合}。省略したものは既定値
 *   effects:   data/skill_effects.json (丸ごと)
 *   motions:   data/motions_sns.json (丸ごと)
 *   combo:     data/combos_sns.json の combos[] の 1 件、または技 id の配列
 *   target:    {hitzone: {slash, blunt, fire, ...}, wound?: {...}|null, isWound?: bool}
 *   buffs:     {attackAdd, attackMul, affinityAdd, elementAdd, elementMul} (アイテム等。省略可)
 *   monsterStatus: 相手が使う状態異常のキーの配列 (['frenzy'] など)。省略 = 分からない。
 *              条件のもと (sources) が装備にも相手にも無い条件 (狂竜症) は 0% にする。分からないときは決めつけない
 *   rules:     既定は effects.rules → DEFAULT_RULES
 * @returns {{total, physical, element, extra, patterns, steps, conditions, warnings, unsupported, unknown, lowConfidence}}
 */
export function comboExpected(input) {
  const effectsRules = (input.effects && input.effects.rules) || {};
  const rules = mergeRules(input.rules || effectsRules);
  const groupSrc = (input.rules && input.rules.conditionGroups) || effectsRules.conditionGroups || [];
  const resolved = resolveSkills(input.skills, input.effects);
  const cond = resolveConditions(resolved.active, groupSrc, input.uptimes, {
    skillIds: normalizeSkills(input.skills).map((s) => s.skillId), monsterStatus: input.monsterStatus,
  });
  const enumerated = enumeratePatterns(cond.groups);
  const warnings = [...cond.warnings, ...enumerated.warnings];
  const moves = movesMap(input.motions);
  const target = input.target || {};
  const plan = planSteps(comboSteps(input.combo), moves, target, warnings);
  const weapon = input.weapon || { attack: 0, affinity: 0, element: null };
  const elemType = weapon.element ? weapon.element.type : null;
  const sharpness = input.sharpness || 'white';

  const stepTotals = plan.map((st) => ({ move: st.move, name: st.name, isWound: st.isWound,
    total: 0, physical: 0, element: 0, extra: 0 }));
  let total = 0; let physical = 0; let element = 0; let extra = 0;
  for (const p of enumerated.patterns) {
    const mods = aggregateModifiers(effectsFor(cond.active, p.states), elemType, input.buffs || {});
    const stats = computeStats(weapon, mods, rules);
    plan.forEach((st, si) => {
      for (const hit of st.hits) {
        const d = hitDamage(hit, stats, { hitzone: st.hitzone, isWound: st.isWound, sharpness, rules });
        const acc = stepTotals[si];
        acc.total += p.weight * d.total; acc.physical += p.weight * d.physical;
        acc.element += p.weight * d.element; acc.extra += p.weight * d.extra;
        total += p.weight * d.total; physical += p.weight * d.physical;
        element += p.weight * d.element; extra += p.weight * d.extra;
      }
    });
  }
  return {
    total, physical, element, extra,
    patterns: enumerated.patterns.length,
    steps: stepTotals,
    conditions: cond.groups.map(publicGroup),
    warnings,
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
 * スキルの寄与を出す。発動率は input.uptimes (条件グループごと) をそのまま使う。
 * @param {object} input comboExpected と同じ
 * @returns {{
 *   total, noSkills, vsNoSkillsPct,
 *   removeEach: Array<{skillId, name, level, total, dropPct}>,
 *   perLevel: Array<{skillId, name, level, maxLevel, levels: Array<{level, total, gainPctVsNone, gainPctVsPrev}>}>,
 *   conditions, warnings, unsupported, unknown, lowConfidence
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
    conditions: base.conditions, warnings: base.warnings,
    unsupported: base.unsupported, unknown: base.unknown, lowConfidence: base.lowConfidence,
  };
}
