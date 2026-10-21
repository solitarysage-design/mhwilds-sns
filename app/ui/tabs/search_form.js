// 探すタブの純粋関数 (画面の部品を持たない。preact も state.js も import しない = node --test で確かめられる)。担当: ui-search (3e)。
// docs/RECOMMEND_DESIGN.md 4.3〜4.6 節・5.1 節: state → (おすすめの Plan) → Job、必須の行、結果の見せ方 (いまとの差・変わる部位)。
// 探索の入力の形は docs/SEARCH_DESIGN.md 3.2 節、Worker に渡す Job は docs/RECOMMEND_DESIGN.md 5.5 節。
//
// モンスターを選んでいて「相手に合わせたおすすめを使う」がオンなら、recommend.js の buildPlan → planToJob の Job (kind 'plan') で探す。
// それ以外 (相手なし・手入力の肉質・おすすめを使わない・Plan を作れない) は段階 2 の形 (createSearch の入力 1 つ = kind 'search') で、
// 武器の範囲・狙う部位・倒していない歴戦王の γ 防具の除外をここで state から作る。
import { computeBuild, ARMOR_PARTS, DECO_TARGETS } from '../../model/build.js';
import { resolveWeaponRef, damageWeapon, autoSharpness, sharpnessResolver } from '../../model/weapon.js';
import {
  individualOf, elementRecommendationOf, hitzoneFor, monsterById, questById, archTemperedRewards, gammaIndex,
} from '../../model/hunt.js';
import { mixTotal } from './power_calc.js';
import {
  resolveTargetMix, monsterStatusOf, defaultPartKey, visibleParts, findPart, partLabel, recommendationView,
  WEAK_POINT_MIN, CLOSE_GAP, ELEMENT_KEYS,
} from './target_mix.js';
import { DEFAULT_TARGET, DEFAULT_HITZONE_TEXT, weaponName, skillName } from './equip_logic.js';
import { PART_LABEL, ELEMENT_LABEL, DECO_TARGET_LABEL, formatNumber } from '../components/labels.js';

const isObj = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

// ---------------------------------------------------------------- 選び方の文言 (state.search の値 → 画面の文字)

export const PRESET_OPTIONS = Object.freeze([
  { value: 'power', label: '火力優先' }, { value: 'balance', label: 'バランス' }, { value: 'safe', label: '安全' },
]);
export const WEAPON_MODE_OPTIONS = Object.freeze([
  { value: 'auto', label: 'おまかせ' }, { value: 'current', label: 'いまの武器' },
  { value: 'element', label: 'おすすめの属性' }, { value: 'all', label: '片手剣すべて' },
]);
export const PARTS_POLICY_OPTIONS = Object.freeze([
  { value: 'asSelected', label: '相手タブの部位' }, { value: 'weak1', label: '弱点 1 か所' }, { value: 'main3', label: '主な部位 3 か所' },
]);
export const LIMIT_BREAK_OPTIONS = Object.freeze([
  { value: 'build', label: '装備タブと同じ' }, { value: 'all', label: '全部する' }, { value: 'none', label: 'しない' },
]);
export const PLACEHOLDER_OPTIONS = Object.freeze([
  { value: 'zero', label: '仮の条件は 0% にする (既定)' }, { value: 'keep', label: '火力タブの値で探す' },
]);
export const TWO_WEAPON_OPTIONS = Object.freeze([
  { value: 'auto', label: 'おまかせ' }, { value: 'on', label: '2 本の案も出す' }, { value: 'off', label: '1 本だけ' },
]);
/** 探す時間の目安 (秒) と出す件数の選び方 */
export const BUDGET_CHOICES = Object.freeze([3, 6, 12, 20]);
export const K_CHOICES = Object.freeze([5, 10, 20]);

/** 段階 (progress().phase) → 画面の文。「ビーム」などの言葉は出さない (docs/RECOMMEND_DESIGN.md 4.6 節) */
export const PHASE_TEXT = Object.freeze({
  prepare: '準備しています', beam1: '候補を絞っています', beam2: '候補を絞っています', polish1: '仕上げています',
  dfs: 'もっと良い組を探しています', polish2: '仕上げています', done: 'まとめています',
  // 相手に合わせて探すとき (recommend.js の createPlanRunner の段階)
  merge: 'まとめています', twoWeapons: '武器 2 本の組み合わせを合わせています', cost: '守りのスキルの火力の差を測っています',
});
/** 進み具合の帯の目安: 段階が始まった時点の割合 (dfs の間は予算に対する経過で伸ばす) */
const PHASE_AT = Object.freeze({
  prepare: 0, beam1: 0.08, beam2: 0.25, polish1: 0.45, dfs: 0.55, polish2: 0.9, done: 1, merge: 0.9, twoWeapons: 0.92, cost: 0.95,
});

// ---------------------------------------------------------------- 仮置きの発動率

function stateLabel(g, id) {
  const s = (g.states || []).find((x) => x.id === id);
  return (s && s.label) || id;
}

/** 発動率の値を「50%」/「1〜4 ヒット 50%・5 ヒット以降 50%」に */
export function uptimeText(g, value) {
  if (!g) return '';
  if (g.type === 'categorical') {
    const v = isObj(value) ? value : {};
    const parts = (g.states || []).filter((s) => s.id !== g.offState)
      .map((s) => `${stateLabel(g, s.id)} ${Math.round((Number(v[s.id]) || 0) * 100)}%`);
    return parts.join('・') || '0%';
  }
  const n = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value);
  return `${Math.round((Number.isFinite(n) ? n : 0) * 100)}%`;
}

/**
 * 仮置き (根拠の無い既定値) の条件の一覧 (skill_effects.json の rules.conditionGroups の placeholder: true)。
 * fromInput = 本人が火力タブで値を入れた条件 (どちらの探し方でもその値をそのまま使う)。
 * @returns {{id, label, type, fromInput, defaultText, valueText, skills: string[]}[]}
 */
export function placeholderConditions(effects, uptimes = {}) {
  const groups = (effects && effects.rules && Array.isArray(effects.rules.conditionGroups)) ? effects.rules.conditionGroups : [];
  const u = isObj(uptimes) ? uptimes : {};
  return groups.filter((g) => isObj(g) && g.placeholder === true).map((g) => {
    const set = Object.prototype.hasOwnProperty.call(u, g.id) && u[g.id] != null;
    return {
      id: g.id, label: g.label || g.id, type: g.type, fromInput: set,
      defaultText: uptimeText(g, g.defaultUptime), valueText: uptimeText(g, set ? u[g.id] : g.defaultUptime),
      skills: (g.skills || []).map((s) => s && s.name).filter(Boolean),
    };
  });
}

/**
 * 探すときの発動率。policy 'zero' なら、本人が値を入れていない仮置きの条件を 0% にする
 * (binary は 0、段階のある条件は {} = 全部の段が 0%)。'keep' なら火力タブの値 (state.uptimes) のまま。
 */
export function searchUptimes(effects, uptimes, policy) {
  const out = isObj(uptimes) ? { ...uptimes } : {};
  if (policy !== 'zero') return out;
  for (const p of placeholderConditions(effects, out)) {
    if (!p.fromInput) out[p.id] = p.type === 'categorical' ? {} : 0;
  }
  return out;
}

// ---------------------------------------------------------------- 限界突破・歴戦王の γ 防具

/** 探すときの限界突破 (部位ごと)。mode: 'build' (装備タブと同じ) | 'all' | 'none' */
export function limitBreakFor(mode, build) {
  const out = {};
  for (const p of ARMOR_PARTS) {
    if (mode === 'all') out[p] = true;
    else if (mode === 'none') out[p] = false;
    else out[p] = !!(build && build.limitBreak && build.limitBreak[p] === true);
  }
  return out;
}

/**
 * 歴戦王の素材が要る防具・護石 (monsters.json の individuals[].rewards)。表は hunt.js の archTemperedRewards / gammaIndex
 * (探索・おすすめと同じもの)。
 * @returns {{armor: Map<id, entry>, charms: Map<id, entry>, monsters: entry[], index: gammaIndex の結果 (探索の入力 gamma に渡す)}}
 *   entry = {monsterId, name (「レ・ダウ（歴戦王）」), monsterName, armorIds, charmFixedIds, setNames, groupSkills (名前)}
 */
export function gammaInfo(targetData) {
  const armor = new Map();
  const charms = new Map();
  const monsters = archTemperedRewards(targetData).map((r) => ({
    monsterId: r.monsterId, name: r.name, monsterName: r.monster, armorIds: r.armorIds, charmFixedIds: r.charmFixedIds,
    setNames: r.armorSets, groupSkills: r.groupSkills.map((g) => g.name).filter(Boolean),
  }));
  for (const e of monsters) {
    for (const id of e.armorIds) armor.set(id, e);
    for (const id of e.charmFixedIds) charms.set(id, e);
  }
  return { armor, charms, monsters, index: gammaIndex(targetData) };
}

/**
 * 倒していない歴戦王 (state.search.archTemperedHunted の {monsterId: false}) の γ 防具・狩猟証γ の護石を外す。
 * @returns {{armor: number[], charmsFixed: number[], monsters: entry[]}}
 */
export function huntedExclusions(gamma, hunted) {
  const h = isObj(hunted) ? hunted : {};
  const out = { armor: [], charmsFixed: [], monsters: [] };
  for (const e of (gamma && gamma.monsters) || []) {
    if (h[String(e.monsterId)] !== false) continue;
    out.monsters.push(e);
    out.armor.push(...e.armorIds);
    out.charmsFixed.push(...e.charmFixedIds);
  }
  return out;
}

/** 装備一式の中の、歴戦王の素材が要るもの → 歴戦王の名前の一覧 (重なりなし) */
export function gammaMarksOf(build, gamma) {
  if (!build || !gamma) return [];
  const names = new Set();
  for (const p of ARMOR_PARTS) {
    const id = build.armor && build.armor[p];
    const e = id != null ? gamma.armor.get(id) : null;
    if (e) names.add(e.name);
  }
  const c = gamma.charms.get(build.charm);
  if (typeof build.charm === 'number' && c) names.add(c.name);
  return [...names];
}

// ---------------------------------------------------------------- 相手 (狙う部位)

/** 主な部位: 名前のある部位で切断 45 以上の上位 3 か所 (無ければ []) */
export function mainParts(monster) {
  return visibleParts(monster, { sort: 'slash' })
    .filter((p) => (Number(p.hitzone && p.hitzone.slash) || 0) >= WEAK_POINT_MIN).slice(0, 3);
}

function defaultTargets(t, reason) {
  return {
    targets: [{ weight: 1, label: '既定の肉質', partKey: null, target: { ...DEFAULT_TARGET, isWound: !!(t && t.isWound) } }],
    label: `既定の肉質 (${DEFAULT_HITZONE_TEXT})`, source: 'default', reason, monster: null, kind: null,
    policy: null, fallback: null, marks: [],
  };
}

/**
 * 探すときの相手 (狙う部位の割合)。個体 (歴戦王など) の傷口の置き換えは hunt.js の hitzoneFor で入れる。
 * @param policy 'asSelected' (相手タブの部位・割合) | 'weak1' (弱点 1 か所) | 'main3' (主な部位 3 か所を等分)
 * @returns {{targets: [{weight, label, partKey, target, mark}], label, source: 'monster'|'manual'|'default', reason,
 *            monster, kind, policy (実際に使った決め方), fallback ('no-part' = 部位が無いので弱点にした), marks}
 *          | {loading: true}}  相手のデータを読み込み中なら loading
 */
export function searchTargets({ target, tabTarget = null, targetData = null, policy = 'asSelected' }) {
  const t = target || {};
  if (t.mode === 'manual') {
    const r = resolveTargetMix(t, tabTarget, targetData);
    return { ...r, source: 'manual', reason: null, monster: null, kind: null, policy: 'manual', fallback: null, marks: [] };
  }
  if (t.monsterId == null) return defaultTargets(t, 'unset');
  if (!targetData) return { loading: true };
  const monster = monsterById(targetData, t.monsterId);
  if (!monster) return defaultTargets(t, 'not-found');
  const kind = t.individual ?? null;
  const useUncertain = t.useUncertainWound === true;
  const ind = kind != null ? individualOf(monster, kind) : null;
  let picks = null;
  let used = ['asSelected', 'weak1', 'main3'].includes(policy) ? policy : 'asSelected';
  let fallback = null;
  if (used === 'asSelected') {
    const mix = resolveTargetMix({ ...t, mode: 'monster' }, tabTarget, targetData);
    if (mix && mix.targets.length) picks = mix.targets.map((x) => ({ key: x.partKey, weight: x.weight }));
    else {
      fallback = 'no-part';
      used = 'weak1';
    }
  }
  if (!picks && used === 'main3') {
    const parts = mainParts(monster);
    if (parts.length) picks = parts.map((p) => ({ key: p.key, weight: 1 / parts.length }));
    else used = 'weak1';
  }
  if (!picks) {
    const k = defaultPartKey(monster);
    if (k) picks = [{ key: k, weight: 1 }];
  }
  if (!picks) return defaultTargets(t, 'no-part');
  const targets = [];
  const marks = new Set();
  for (const x of picks) {
    const part = findPart(monster, x.key);
    if (!part) continue;
    const hz = hitzoneFor(monster, part, kind, { useUncertain });
    if (hz.mark) marks.add(hz.mark);
    targets.push({
      weight: x.weight, label: partLabel(part, monster), partKey: part.key, mark: hz.mark,
      target: { hitzone: hz.hitzone, wound: hz.wound || null, isWound: !!t.isWound },
    });
  }
  if (!targets.length) return defaultTargets(t, 'no-part');
  const name = (ind && ind.name) || monster.name;
  const total = targets.reduce((a, x) => a + x.weight, 0) || 1;
  const partsText = targets.length === 1 ? targets[0].label
    : targets.map((x) => `${x.label} ${Math.round((x.weight / total) * 100)}%`).join('・');
  return {
    targets, label: `${name} ${partsText}`, name, partsText, source: 'monster', reason: null, monster, kind,
    policy: used, fallback, marks: [...marks],
  };
}

// ---------------------------------------------------------------- 武器の範囲

/** 武器の属性 (ダメージになる属性だけ。無ければ null) */
function weaponElementOf(w) {
  const t = w && w.element && w.element.type;
  return ELEMENT_KEYS.includes(t) ? t : null;
}

/**
 * 探す武器の範囲 (段階 2 の決め方。docs/RECOMMEND_DESIGN.md 2.3 節の表の 1 体の行)。
 * @param p {mode: state.search.weaponMode, build, idx, weapons (weapons_sns の配列), myWeapons (所持武器の配列。ファイル + 端末),
 *           monster, kind, useUncertain}
 * @returns {{mode (実際の決め方 'current'|'element'|'all'), weapons: ref[] | 'sns-all', elements: string[], text, blocker,
 *            view (recommendationView の結果 | null), current (いまの武器 | null)}}
 */
export function weaponChoice({ mode = 'auto', build, idx, weapons = [], myWeapons = [], monster = null, kind = null, useUncertain = false }) {
  const current = build && build.weapon != null ? resolveWeaponRef(build.weapon, idx) : null;
  const rec = monster ? elementRecommendationOf(monster, kind, { useUncertain }) : null;
  const view = rec ? recommendationView(rec, weaponElementOf(current)) : null;
  const clear = !!view && view.kind === 'clear';
  let m = mode;
  if (m === 'auto') {
    if (!current) m = clear ? 'element' : 'all';
    else if (clear && (view.weapon === 'other' || view.weapon == null)) m = 'element';
    else m = 'current';
  }
  if (m === 'element' && !clear) m = current ? 'current' : 'all';
  if (m === 'current') {
    if (!current) {
      return {
        mode: 'current', weapons: [], elements: [], view, current,
        text: '', blocker: { code: 'no-weapon', message: '武器を選んでいません。装備タブで武器を選ぶか、「片手剣すべて」で探してください。' },
      };
    }
    return { mode: 'current', weapons: [build.weapon], elements: [], view, current, blocker: null, text: `いまの武器 (${weaponName(current)}) で探します。` };
  }
  if (m === 'all') {
    return {
      mode: 'all', weapons: 'sns-all', elements: [], view, current, blocker: null,
      text: current ? '片手剣すべてから探します (時間がかかります)。'
        : '武器を選んでいないので、片手剣すべてから探します (時間がかかります)。',
    };
  }
  // おすすめの属性から: 1 位と差が CLOSE_GAP 以内の属性の片手剣 + 同じ属性の所持武器 + いまの武器 (比べるため)
  const order = (rec && Array.isArray(rec.order)) ? rec.order : [];
  const top = order.length ? order[0].avg : null;
  const elements = order.filter((o) => ELEMENT_KEYS.includes(o.type) && top != null && top - o.avg <= CLOSE_GAP).map((o) => o.type);
  const refs = [];
  const seen = new Set();
  const add = (ref) => {
    if (ref == null || seen.has(ref)) return;
    seen.add(ref);
    refs.push(ref);
  };
  for (const w of weapons || []) if (elements.includes(weaponElementOf(w))) add(w.id);
  for (const w of myWeapons || []) {
    const r = resolveWeaponRef(w.id, idx);
    if (r && elements.includes(weaponElementOf(r))) add(w.id);
  }
  if (current) add(build.weapon);
  const names = elements.map((e) => ELEMENT_LABEL[e] || e).join('・');
  const cur = weaponElementOf(current);
  return {
    mode: 'element', weapons: refs, elements, view, current, blocker: null,
    text: `おすすめの属性 (${names}) の片手剣 ${refs.length} 本から探します${current ? `。いまの武器は${cur ? ELEMENT_LABEL[cur] : '無属性'}です` : ''}。`,
  };
}

// ---------------------------------------------------------------- 探す条件 → Job

/** state.search.budgetSec → 探索の予算。test = window.__mhwSearchBudget (テストだけ。{work: n} で仕事量の予算) */
export function budgetOf(budgetSec, test = null) {
  if (isObj(test) && (num(test.work) != null || num(test.ms) != null || num(test.activeMs) != null)) return { ...test };
  // activeMs = 計算した時間だけで数える予算 (iPhone で裏に回っていた時間を数えない。docs/RECOMMEND_DESIGN.md 5.4 節)。
  // 始めてからの時間 (ms) は入れない (裏に回っている間に予算を使い切らないように)
  return { activeMs: Math.max(1, Number(budgetSec) || 6) * 1000 };
}

/** budgetOf の結果 → 予算の ms (時間の予算でなければ null) */
function budgetMsOf(budget) {
  return num(budget && budget.activeMs) ?? num(budget && budget.ms);
}

/** 必須スキルを入力の形に (知らないスキル・Lv 0 は外す) */
function requiredInput(required, idx) {
  return (Array.isArray(required) ? required : [])
    .filter((r) => isObj(r) && idx.skills.has(r.skillId) && Number(r.level) > 0)
    .map((r) => ({ skillId: r.skillId, level: Number(r.level) }));
}

/**
 * データの版 (各ファイルの meta.generatedAt をつないだもの。inputKey に入れる)。
 * 持っている護石・アーティア武器 (charms.json / my_weapons.json) は meta に日付が無いので id の並びを足す。
 */
export function dataVersionOf(core) {
  const meta = (core && core.meta) || {};
  const ids = (list) => (Array.isArray(list) ? list.map((x) => x && x.id).join(',') : '');
  const lists = (core && core.lists) || {};
  return [
    ...Object.keys(meta).sort().map((k) => `${k}:${(meta[k] && (meta[k].generatedAt || meta[k].schema)) ?? ''}`),
    `charms:${ids(lists.charms)}`, `myWeapons:${ids(lists.myWeapons)}`,
  ].join('|');
}

/** キーの並びをそろえた JSON (同じ中身なら同じ文字列) */
export function stableStringify(x) {
  if (x === undefined) return 'null';
  if (x === null || typeof x !== 'object') return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(stableStringify).join(',')}]`;
  return `{${Object.keys(x).filter((k) => x[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(x[k])}`).join(',')}}`;
}

/** 32 ビットの FNV-1a (短いハッシュ。暗号ではない) */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 入力から、比べるのに要らないもの (予算・いまの装備) を除く */
function keyInput(input) {
  if (!isObj(input)) return input;
  const { budget, current, ...rest } = input;
  return rest;
}

/**
 * 探す条件の短いハッシュ (docs/RECOMMEND_DESIGN.md 5.7 節)。保存した結果の inputKey と今の条件の inputKey が違えば
 * 「条件が変わりました」。予算 (時間) といまの装備 (「装備に入れる」で変わる) は入れない。
 */
export function inputKeyOf(job, dataVersion = '') {
  if (!isObj(job)) return null;
  const body = job.kind === 'plan'
    ? { kind: 'plan', K: job.K, merge: job.merge, runs: (job.runs || []).map((r) => ({ label: r.label, input: keyInput(r.input) })) }
    : { kind: 'search', K: job.K, input: keyInput(job.input) };
  const s = stableStringify({ v: dataVersion, job: body });
  return `k${fnv1a(s).toString(36)}${(s.length % 1296).toString(36)}`;
}

/**
 * state などから、探す条件 (Job) を作る。
 * モンスターを選んでいて「相手に合わせたおすすめを使う」がオンなら、recommend.js の buildPlan → planToJob の Job (kind 'plan'。
 * docs/RECOMMEND_DESIGN.md 5.3 節。守りのスキル・武器の属性・多頭の重み・武器 2 本・γ の除外が入る)。
 * それ以外は段階 2 の入力 1 つ (kind 'search')。
 * @param ctx {state: {build, target, search, combo, uptimes, sharpness, tabs}, core (data.js の core データ),
 *             idx (useEquipIndex の idx。端末の武器・護石も入った索引), targetData (data.js の target データ | null),
 *             combo (resolveCombo の結果), localCharms, localWeapons, recommend (recommend.js の名前空間 | null),
 *             budgetTest (window.__mhwSearchBudget | null)}
 * @returns {{ok, loading, blockers: [{code, message}], notes: [{code, message}], job, inputKey, summary,
 *            targets (searchTargets の結果), weapon (weaponChoice の結果), weaponText, weaponMode, placeholders, exclusions, gamma,
 *            plan, planError}}
 */
export function buildJob(ctx) {
  const { state, core, idx, targetData = null, combo, localCharms = [], localWeapons = [], recommend = null, budgetTest = null } = ctx;
  const s = state.search;
  const blockers = [];
  const notes = [];
  const gamma = gammaInfo(targetData);
  const exclusions = huntedExclusions(gamma, s.archTemperedHunted);
  const placeholders = placeholderConditions(core.skillEffects, state.uptimes);
  const targets = searchTargets({
    target: state.target, tabTarget: state.tabs && state.tabs.target, targetData, policy: s.partsPolicy,
  });
  if (targets.loading) {
    return {
      ok: false, loading: true, blockers, notes, job: null, inputKey: null, summary: null, targets, weapon: null, weaponText: '',
      weaponMode: null, placeholders, exclusions, gamma, plan: null, planError: null,
    };
  }
  const weapon = weaponChoice({
    mode: s.weaponMode, build: state.build, idx, weapons: core.lists.weapons,
    myWeapons: [...(core.lists.myWeapons || []), ...(localWeapons || [])],
    monster: targets.monster, kind: targets.kind, useUncertain: state.target.useUncertainWound === true,
  });
  if (!combo) blockers.push({ code: 'no-combo', message: '代表コンボのデータがありません。再読み込みしてください。' });
  const quest = state.target.questId != null && targetData ? questById(targetData, state.target.questId) : null;
  if (quest && quest.fixedEquipment === true) {
    blockers.push({ code: 'fixed-equipment', message: `「${quest.name}」は装備が決められたクエストなので、装備を探せません。` });
  }
  if (targets.fallback === 'no-part') notes.push({ code: 'no-part', message: '狙う部位を選んでいないので、弱点 1 か所で探します。' });
  if (targets.source === 'default') notes.push({ code: 'default-target', message: `相手を選んでいないので、${targets.label}で探します。` });

  const uptimes = searchUptimes(core.skillEffects, state.uptimes, s.placeholders);
  const zeroed = s.placeholders === 'zero' ? placeholders.filter((p) => !p.fromInput).length : 0;
  const K = Math.max(1, Math.min(50, Number(s.K) || 10));
  const budget = budgetOf(s.budgetSec, budgetTest);
  const extraCharms = s.charms.local ? (localCharms || []) : [];
  const input = {
    weapons: weapon.weapons,
    targets: targets.targets.map((x) => ({ weight: x.weight, label: x.label, partKey: x.partKey, target: x.target })),
    combo, uptimes,
    monsterStatus: monsterStatusOf(state.target, targetData) || [],
    buffs: {}, sharpness: state.sharpness || null,
    required: requiredInput(s.required, idx),
    charms: {
      owned: s.charms.owned !== false, extra: extraCharms, fixed: s.charms.fixed !== false, fixedExclude: exclusions.charmsFixed,
    },
    extraWeapons: localWeapons || [],
    decorations: { owned: null },
    budget, current: state.build, mode: 'fast',
    limitBreak: limitBreakFor(s.limitBreak, state.build),
    armorExclude: [...new Set([...(s.armorExclude || []), ...exclusions.armor])],
    objective: 'damage', K,
    // γ の印の表 (結果に「歴戦王の素材が要る」の印が付き、同じ値の γ でない防具・護石が代表になる)
    ...(targetData ? { gamma: gamma.index } : {}),
  };

  // 相手に合わせたおすすめ (recommend.js)。Plan を作れないとき (相手なし・壊れた入力) は段階 2 の入力 1 つで探す
  let plan = null;
  let planError = null;
  let job = { kind: 'search', input, K };
  if (s.useTarget && recommend && typeof recommend.buildPlan === 'function' && targetData && targets.source === 'monster') {
    try {
      plan = recommend.buildPlan({
        target: state.target, tabTarget: state.tabs && state.tabs.target, search: s, targetData,
        core: { index: idx, skillEffects: core.skillEffects, motions: core.motions, combos: core.combos },
        current: { build: state.build, combo, uptimes: state.uptimes, sharpness: state.sharpness, extraWeapons: localWeapons || [] },
      }) || null;
      if (plan && typeof recommend.planToJob === 'function' && !plan.blocked) {
        const ms = budgetMsOf(budget);
        const pj = recommend.planToJob(plan, {
          K, budgetMs: ms ?? s.budgetSec * 1000, ...(ms == null ? { budget } : {}), placeholders: s.placeholders,
          userRequired: s.required, extraCharms, extraWeapons: localWeapons || [], current: state.build,
        });
        if (pj && !pj.blocked && Array.isArray(pj.runs) && pj.runs.length) job = pj;
        else if (!pj || !pj.blocked || pj.blocked.code !== 'fixed-equipment') plan = null;
      }
    } catch (e) {
      planError = e;
      plan = null;
      notes.push({ code: 'plan-error', message: '相手に合わせたおすすめを作れなかったので、相手の肉質だけで探します。' });
    }
  }
  // 武器の範囲 (Plan で探すときは Plan が決める。武器が無くてもほかの武器から探す)
  const usePlan = job.kind === 'plan';
  if (!usePlan && weapon.blocker) blockers.push(weapon.blocker);
  const weaponMode = usePlan ? plan.element.mode : weapon.mode;
  const nWeapons = usePlan && Array.isArray(plan.element.weapons) ? plan.element.weapons.length : null;
  const weaponText = usePlan
    ? `${plan.element.text}${nWeapons != null && weaponMode === 'element' ? ` (${nWeapons} 本)` : ''}。`
    : weapon.text;

  // startBuild = 探し始めた時の装備 (結果の組を「装備に入れた」あとに、条件が変わったかをこの装備で比べ直す。isResultBuild)
  const summary = {
    label: targets.label, weaponText: weaponMode === 'all' ? '片手剣すべて' : weaponMode === 'element'
      ? `おすすめの属性 (${usePlan ? nWeapons : weapon.weapons.length} 本)` : (weapon.current ? weaponName(weapon.current) : ''),
    weaponMode, placeholders: s.placeholders, zeroed, K, budgetSec: s.budgetSec,
    required: input.required.length, kind: job.kind, preset: s.preset, startBuild: state.build || null,
    multi: usePlan && plan.mode === 'multi',
  };
  const inputKey = blockers.length ? null : inputKeyOf(job, dataVersionOf(core));
  return {
    ok: blockers.length === 0, loading: false, blockers, notes, job: blockers.length ? null : job, inputKey, summary,
    targets, weapon, weaponText, weaponMode, placeholders, exclusions, gamma, plan, planError,
  };
}

// ---------------------------------------------------------------- 必須スキルの行

/** スキルの最大 Lv (skills.json の maxLevel か levels の数) */
export function maxLevelOf(skill) {
  if (!skill) return 1;
  return Number(skill.maxLevel) || (Array.isArray(skill.levels) ? skill.levels.length : 0) || 1;
}

/**
 * シリーズ/グループスキルの段 (Lv → 要る部位の数) の文 (bonuses.json から。無ければ '')。
 * 探索はシリーズ/グループの必須も扱う (部位の取り合いまで見る。docs/SEARCH_DESIGN.md 2.8 節・11 章)。
 */
export function bonusLevelsText(skill, bonuses) {
  if (!skill || !isObj(bonuses)) return '';
  if (skill.kind === 'set') {
    const b = (bonuses.setBonuses || []).find((x) => x && x.skillId === skill.id);
    return b && Array.isArray(b.ranks) ? b.ranks.map((r) => `Lv${r.level} = ${r.pieces} 部位`).join('・') : '';
  }
  if (skill.kind === 'group') {
    const b = (bonuses.groupBonuses || []).find((x) => x && x.skillId === skill.id);
    return b ? `Lv${b.level} = ${b.pieces} 部位` : '';
  }
  return '';
}

/**
 * 自分で足した必須スキルの行。
 * @returns {{skillId, name, level, maxLevel, kind, missing}[]}  missing = スキルのデータに無い (外して探す)
 */
export function requiredRows(required, idx) {
  return (Array.isArray(required) ? required : []).map((r) => {
    const sk = idx && idx.skills ? idx.skills.get(r.skillId) : null;
    return {
      skillId: r.skillId, name: sk ? sk.name : `不明なスキル (${r.skillId})`, level: r.level,
      maxLevel: maxLevelOf(sk), kind: sk ? sk.kind : null, missing: !sk,
    };
  });
}

const KIND_GROUP = { armor: '防具スキル', weapon: '武器スキル', set: 'シリーズスキル', group: 'グループスキル' };
const KIND_ORDER = { armor: 0, weapon: 1, set: 2, group: 3 };

/**
 * 「スキルを足す」の一覧 (Picker の items)。種類で見出し。シリーズ/グループは段の Lv と要る部位の数を添える。
 * @param bonuses bonuses.json (無ければ段の文を出さない)
 */
export function requiredPickerItems(skills, required = [], bonuses = null) {
  const have = new Map((required || []).map((r) => [r.skillId, r.level]));
  return (skills || []).filter((s) => isObj(s) && s.id != null)
    .slice().sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || String(a.name).localeCompare(String(b.name), 'ja'))
    .map((s) => {
      const ranks = bonusLevelsText(s, bonuses);
      return {
        value: s.id, label: s.name, group: KIND_GROUP[s.kind] || 'そのほか',
        sub: `最大 Lv${maxLevelOf(s)}${ranks ? ` (${ranks})` : ''}${have.has(s.id) ? `・いま Lv${have.get(s.id)} で足しています` : ''}`,
      };
    });
}

// ---------------------------------------------------------------- 結果の見せ方

/** 保存してあった結果・Worker の結果を、画面で使える形にそろえる (壊れた値で画面を落とさない) */
export function normalizeResult(raw) {
  if (!isObj(raw)) return null;
  const results = (Array.isArray(raw.results) ? raw.results : [])
    .filter((r) => isObj(r) && isObj(r.build) && num(Number(isObj(r.score) ? r.score.value : r.value)) != null);
  return {
    ...raw,
    status: typeof raw.status === 'string' ? raw.status : 'done',
    results,
    warnings: (Array.isArray(raw.warnings) ? raw.warnings : []).filter((w) => isObj(w) && typeof w.message === 'string'),
    infeasible: isObj(raw.infeasible) ? raw.infeasible : null,
    stats: isObj(raw.stats) ? raw.stats : {},
  };
}

/** 結果の 1 件の値 (多頭の「回数」なら score.value) */
export function valueOf(r) {
  if (!r) return null;
  return num(Number(isObj(r.score) ? r.score.value : r.value));
}

/** 2 つの結果の 1 位が違うか (値か装備が違う) */
export function topChanged(prev, next) {
  const a = prev && prev.results && prev.results[0];
  const b = next && next.results && next.results[0];
  if (!a || !b) return !!b && !a;
  const va = valueOf(a);
  const vb = valueOf(b);
  if (va == null || vb == null) return false;
  return Math.abs(va - vb) > 1e-9 * Math.max(1, Math.abs(va)) || stableStringify(a.build) !== stableStringify(b.build);
}

const decoList = (b, t) => {
  const list = [...((b && b.decorations && b.decorations[t]) || [])];
  while (list.length && list[list.length - 1] == null) list.pop();
  return list.map((x) => x ?? null);
};

/** いまの装備 cur と結果の装備 next の違い */
export function buildDiff(cur, next) {
  const c = cur || {};
  const n = next || {};
  const parts = ARMOR_PARTS.filter((p) => ((c.armor && c.armor[p]) ?? null) !== ((n.armor && n.armor[p]) ?? null));
  const limitBreak = ARMOR_PARTS.filter((p) => !!(c.limitBreak && c.limitBreak[p]) !== !!(n.limitBreak && n.limitBreak[p])
    && ((n.armor && n.armor[p]) ?? null) != null);
  const decorations = DECO_TARGETS.filter((t) => JSON.stringify(decoList(c, t)) !== JSON.stringify(decoList(n, t)));
  const weapon = (c.weapon ?? null) !== (n.weapon ?? null);
  const charm = (c.charm ?? null) !== (n.charm ?? null);
  return { weapon, parts, charm, decorations, limitBreak, same: !weapon && !charm && !parts.length && !decorations.length && !limitBreak.length };
}

/**
 * いまの装備が結果の組のどれか (武器 2 本の案の 2 本目の組も) と同じか (= 結果から「装備に入れた」)。
 * そのときは「条件が変わりました」を、探し始めた時の装備 (summary.startBuild) で作った条件で比べる
 * (武器の範囲・限界突破はいまの装備から決まるので、結果を入れただけで条件が変わったことにしないため)。
 */
export function isResultBuild(result, build) {
  if (!result || !Array.isArray(result.results) || !build) return false;
  return result.results.some((r) => (isObj(r.build) && buildDiff(r.build, build).same)
    || (Array.isArray(r.builds) && r.builds.some((b) => isObj(b) && buildDiff(b, build).same)));
}

/** 違いを「武器はそのまま・頭 胴 腰 護石が変わる」のような文に */
export function changeText(diff) {
  if (!diff) return '';
  if (diff.same) return 'いまの装備と同じ';
  const changed = [...diff.parts.map((p) => PART_LABEL[p]), ...(diff.charm ? ['護石'] : [])];
  const head = diff.weapon ? '武器も変わる' : '武器はそのまま';
  if (changed.length) return `${head}・${changed.join(' ')}が変わる`;
  if (diff.weapon) return '武器が変わる';
  if (diff.limitBreak.length) return `${head}・限界突破が変わる`;
  return `${head}・装飾品だけが変わる`;
}

/**
 * スキルをいまと比べる。
 * @returns {{skillId, name, level, before, change: 'new'|'up'|'down'|'gone'|'same'}[]} 増えた → 減った → 同じ の順
 */
export function skillDiff(curSkills, nextSkills) {
  const cur = new Map((curSkills || []).filter((s) => s && s.level > 0).map((s) => [s.skillId, s]));
  const nxt = new Map((nextSkills || []).filter((s) => s && s.level > 0).map((s) => [s.skillId, s]));
  const out = [];
  for (const [id, s] of nxt) {
    const b = cur.get(id);
    const before = b ? b.level : 0;
    const change = !b ? 'new' : s.level > before ? 'up' : s.level < before ? 'down' : 'same';
    out.push({ skillId: id, name: s.name || (b && b.name) || '', level: s.level, before, change });
  }
  for (const [id, b] of cur) {
    if (!nxt.has(id)) out.push({ skillId: id, name: b.name || '', level: 0, before: b.level, change: 'gone' });
  }
  const rank = { new: 0, up: 1, down: 2, gone: 3, same: 4 };
  return out.sort((a, b) => rank[a.change] - rank[b.change] || b.level - a.level || a.skillId - b.skillId);
}

/** 主なスキル (Lv の高い順に n 個) を「攻撃5 見切り3 …」に */
export function mainSkillsText(skills, n = 6) {
  const list = (skills || []).filter((s) => s && s.level > 0).slice().sort((a, b) => b.level - a.level);
  const head = list.slice(0, n).map((s) => `${s.name}${s.level}`).join(' ');
  return list.length > n ? `${head} …` : head;
}

/** 空きスロット ({weapon: {1,2,3}, armor: {1,2,3}}) を「防具用 ①×2・武器用 なし」に */
export function freeSlotsText(freeSlots) {
  if (!isObj(freeSlots)) return '';
  const mark = { 1: '①', 2: '②', 3: '③' };
  const side = (label, x) => {
    const parts = [3, 2, 1].filter((n) => isObj(x) && Number(x[n]) > 0).map((n) => `${mark[n]}×${x[n]}`);
    return `${label} ${parts.length ? parts.join(' ') : 'なし'}`;
  };
  return `${side('武器用', freeSlots.weapon)}・${side('防具用', freeSlots.armor)}`;
}

/** computeBuild の slotSummary → freeSlots の形 */
export function freeSlotsOf(br) {
  const f = (x) => ({ 1: (x && x.freeBySize && x.freeBySize[1]) || 0, 2: (x && x.freeBySize && x.freeBySize[2]) || 0, 3: (x && x.freeBySize && x.freeBySize[3]) || 0 });
  return { weapon: f(br && br.slotSummary && br.slotSummary.weapon), armor: f(br && br.slotSummary && br.slotSummary.armor) };
}

/**
 * いまの装備の値 (結果と同じ条件 = 探した時の入力で計算する。「いまより +12.4%」の基準)。武器が無ければ null。
 * @param input createSearch の入力 (Job の input)
 */
export function baselineValue(input, build, idx, core) {
  try {
    if (!input || !build || build.weapon == null || !Array.isArray(input.targets) || !input.targets.length) return null;
    const w = resolveWeaponRef(build.weapon, idx);
    if (!w) return null;
    const br = computeBuild(build, idx);
    const sharpness = input.sharpness || autoSharpness(w, idx, br.skillLevels).color;
    const v = mixTotal({
      weapon: damageWeapon(w), sharpness, skills: br.skills, uptimes: input.uptimes || {},
      effects: core.skillEffects, motions: core.motions, combo: input.combo, monsterStatus: input.monsterStatus,
      buffs: input.buffs, perSkills: sharpnessResolver(w, idx, input.sharpness || null),
    }, input.targets);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** 装備の名前 (武器・防具・護石・珠) */
export function armorNameOf(idx, id) {
  const a = id != null && idx ? idx.armor.get(id) : null;
  return a ? a.name : id != null ? `見つからない防具 (${id})` : 'なし';
}

export function charmNameOf(idx, ref) {
  if (ref == null) return 'なし';
  const c = typeof ref === 'number' ? idx.charmsFixed.get(ref) : idx.charms.get(ref);
  return c ? (c.name || '護石') : '見つからない護石';
}

export function decoNamesOf(idx, build, target) {
  return decoList(build, target).filter((x) => x != null)
    .map((id) => { const d = idx.decorations.get(id); return d ? d.name : '見つからない装飾品'; });
}

/**
 * 結果の一覧の行。
 * @param result normalizeResult の結果
 * @param ctx {idx, currentBuild, currentSkills (computeBuild(いまの装備).skills), baseline (いまの装備の値 | null), gamma}
 */
export function resultRows(result, ctx) {
  const { idx, currentBuild, currentSkills = [], baseline = null, gamma = null } = ctx;
  if (!result) return [];
  return result.results.map((r, i) => {
    const value = valueOf(r);
    const scoreKind = isObj(r.score) && r.score.kind === 'combos' ? 'combos' : 'damage';
    const base = isObj(r.baseline) && num(r.baseline.value) != null ? r.baseline.value : baseline;
    const diffPct = scoreKind === 'damage' && base > 0 && value != null ? (value / base - 1) * 100 : null;
    // 多頭 (全部倒すまでの回数): いまの装備の回数との差 (相手ごとに切り上げた回数の合計どうし)
    const baseCombos = scoreKind === 'combos' && isObj(r.baseline) ? num(r.baseline.combos) : null;
    const combosTotal = num(r.combosTotal);
    const diffCombos = baseCombos != null && combosTotal != null ? combosTotal - baseCombos : null;
    let br = null;
    try {
      br = computeBuild(r.build, idx);
    } catch { /* 下で空 */ }
    const skills = Array.isArray(r.skills) && r.skills.length
      ? r.skills.map((s) => ({ ...s, name: s.name || skillName(idx, s.skillId) }))
      : (br ? br.skills.map((s) => ({ skillId: s.skillId, name: s.name, level: s.level })) : []);
    const diff = buildDiff(currentBuild, r.build);
    const w = r.build.weapon != null ? resolveWeaponRef(r.build.weapon, idx) : null;
    const second = Array.isArray(r.builds) && isObj(r.builds[1]) ? r.builds[1] : null;
    const w2 = second && second.weapon != null ? resolveWeaponRef(second.weapon, idx) : null;
    return {
      rank: Number(r.rank) || i + 1, index: i, value, scoreKind, diffPct, diffCombos, combosTotal, diff, changeText: changeText(diff),
      skills, skillsText: mainSkillsText(skills), skillDiff: skillDiff(currentSkills, skills),
      freeSlots: isObj(r.freeSlots) ? r.freeSlots : (br ? freeSlotsOf(br) : null),
      weaponName: w ? weaponName(w) : '武器なし',
      second: second ? { build: second, weaponName: w2 ? weaponName(w2) : '武器なし', decorations: decoNamesOf(idx, second, 'weapon') } : null,
      gamma: gammaMarksOf(r.build, gamma),
      errors: br ? br.errors : [],
      check: isObj(r.check) ? r.check : null, exact: r.exact !== false,
      alternatives: isObj(r.alternatives) ? r.alternatives : {},
      perSubject: Array.isArray(r.perSubject) ? r.perSubject : [],
      defense: defenseView(r.defense, r.defense2),
      raw: r,
    };
  });
}

/**
 * 守りのチェック (recommend.js の defenseCheck の結果) → 行の短い文。武器 2 本なら 2 本目の装備でも満たすかを見る。
 * @returns {{ok, items: [{key, label, status: 'ok'|'mitigated'|'missing', text}]} | null}
 */
export function defenseView(defense, defense2 = null) {
  if (!isObj(defense) || !Array.isArray(defense.rows)) return null;
  const rows2 = isObj(defense2) && Array.isArray(defense2.rows) ? new Map(defense2.rows.map((x) => [x.key, x])) : null;
  const rank = { ok: 0, mitigated: 1, missing: 2 };
  const items = defense.rows.filter((x) => isObj(x) && x.on !== false).map((x) => {
    const y = rows2 ? rows2.get(x.key) : null;
    const status = y && (rank[y.status] ?? 2) > (rank[x.status] ?? 2) ? y.status : x.status;
    return { key: x.key, label: x.label || '', status, text: x.text || '', user: !!x.user };
  });
  if (!items.length) return null;
  return { ok: defense.ok !== false && (!isObj(defense2) || defense2.ok !== false), items };
}

/** 守りのチェックの行を「✓環境適応 Lv2・✓火耐性の合計 22」に */
export function defenseText(view) {
  if (!view) return '';
  const mark = { ok: '✓', mitigated: '△', missing: '✗' };
  return view.items.filter((x) => !x.user).map((x) => `${mark[x.status] || ''}${x.text && x.status === 'ok' ? x.text : x.label}`).join('・');
}

/**
 * 守りのスキルの火力の差 (createPlanRunner の result().costOfDefense) → 文。差が無ければ null。
 * kind 'damage' = 1 コンボの期待値 (守りなしの方が高い)、'combos' = 全部倒すまでの回数 (守りありの方が多い)。
 */
export function costOfDefenseText(cost) {
  if (!isObj(cost) || num(cost.main) == null || num(cost.free) == null || !(cost.main > 0) || !(cost.free > 0)) return null;
  if (cost.kind === 'combos') {
    const pct = (cost.main / cost.free - 1) * 100;
    return pct >= 0.05 ? `守りのスキルのために、全部倒すまでの回数が 約 ${formatNumber(pct, 1)}% 増えます (目安)` : null;
  }
  const pct = (1 - cost.main / cost.free) * 100;
  return pct >= 0.05 ? `守りのスキルのために火力 −${formatNumber(pct, 1)}% (目安)` : null;
}

/** 結果の 1 件の装備の行 (詳しくのシート用) */
export function buildLines(build, idx) {
  const lines = [];
  const w = build.weapon != null ? resolveWeaponRef(build.weapon, idx) : null;
  lines.push({ key: 'weapon', label: '武器', name: w ? weaponName(w) : 'なし', decorations: decoNamesOf(idx, build, 'weapon'), limitBreak: false });
  for (const p of ARMOR_PARTS) {
    const id = build.armor && build.armor[p];
    lines.push({
      key: p, label: PART_LABEL[p], name: armorNameOf(idx, id), decorations: decoNamesOf(idx, build, p),
      limitBreak: id != null && !!(build.limitBreak && build.limitBreak[p]),
    });
  }
  lines.push({
    key: 'charm', label: '護石', name: charmNameOf(idx, build.charm),
    decorations: [...decoNamesOf(idx, build, 'charmArmor'), ...decoNamesOf(idx, build, 'charmWeapon')], limitBreak: false,
  });
  return lines;
}

/** 同じ値になるほかの防具・護石 (alternatives) の名前 */
export function alternativeNames(alternatives, idx, key) {
  const list = isObj(alternatives) && Array.isArray(alternatives[key]) ? alternatives[key] : [];
  return list.map((id) => (key === 'charm' ? charmNameOf(idx, id) : armorNameOf(idx, id)));
}

/**
 * 計算中の見せ方。p = progress (phase / elapsedMs / best / run)。budgetMs は予算 (dfs の伸びに使う)。
 * @returns {{text, share (0〜1), seconds, best, runText}}
 */
export function progressView(p, budgetMs) {
  const phase = p && Object.prototype.hasOwnProperty.call(PHASE_AT, p.phase) ? p.phase : 'prepare';
  let share = PHASE_AT[phase];
  const el = p && num(p.elapsedMs);
  if (phase === 'dfs' && budgetMs > 0 && el != null) {
    share = PHASE_AT.dfs + (PHASE_AT.polish2 - PHASE_AT.dfs) * Math.min(1, el / budgetMs);
  }
  const run = p && isObj(p.run) && p.run.count > 1 ? p.run : null;
  return {
    text: PHASE_TEXT[phase] || '探しています', share, seconds: el != null ? el / 1000 : null,
    best: p ? num(p.best) : null,
    runText: run ? `${run.index + 1} / ${run.count} 回目${run.label ? `: ${run.label}` : ''}` : '',
  };
}

/** progress の best ([値...] か [{value}] か 数) → いまの最良の値 */
export function bestOfProgress(best) {
  if (num(best) != null) return best;
  if (!Array.isArray(best) || !best.length) return null;
  const b = best[0];
  return num(isObj(b) ? Number(b.value) : Number(b));
}

/** 値の書き方 (コンボ 1 回の期待値は小数 1 桁) */
export function valueText(v, scoreKind = 'damage') {
  if (v == null) return '—';
  return scoreKind === 'combos' ? `約 ${formatNumber(Math.ceil(v), 0)} 回` : formatNumber(v, 1);
}

/**
 * 結果の行の値の文。多頭 (回数) は相手ごとに切り上げた回数の合計 (combosTotal。相手タブの「全部倒すまで」と同じ数え方。
 * いまとの差 diffCombos も同じ数え方) を出し、無ければ T の切り上げ。
 */
export function rowValueText(row) {
  if (!row) return '—';
  if (row.scoreKind === 'combos' && row.combosTotal != null) return valueText(row.combosTotal, 'combos');
  return valueText(row.value, row.scoreKind);
}

/**
 * 「この条件で探す」の下の時間の目安。予算 (計算した時間) は守るが、予算で切れない段 (候補を絞る・仕上げる・武器 2 本の合わせ・
 * 守りの火力の差) は端末の速さで延びる。仮置きの発動率を火力タブの値のまま (keep) にすると、条件つきのスキルが増えて
 * その段が重くなり、相手に合わせて探す Job や片手剣すべてでは iPhone で 10 秒をこえる見込み (docs/SEARCH_DESIGN.md 5.3 節)。
 */
export function startHintText(form, search) {
  const sec = Number(search && search.budgetSec) || 6;
  const job = form && form.job;
  const heavy = !!job && ((form.weaponMode === 'all') || (job.kind === 'plan' && search.placeholders === 'keep'));
  if (!heavy) return `${sec} 秒くらい (途中で見つかった組を先に出します)`;
  const why = form.weaponMode === 'all' ? '片手剣すべてから探す' : '仮の発動率を火力タブの値のまま、相手に合わせて探す';
  return `${sec} 秒くらい。${why}ので、もっとかかることがあります (途中で見つかった組を先に出します)`;
}

/** 探すのにかかった時間の記録 (store.js の appendSearchTiming に渡す形) */
export function timingEntry(snap, { device = '' } = {}) {
  return {
    device: String(device || '').slice(0, 120), status: snap.status, kind: snap.job ? snap.job.kind : null,
    label: snap.summary ? snap.summary.label : null, weaponMode: snap.summary ? snap.summary.weaponMode : null,
    inline: !!snap.inline, extended: snap.extended || 0,
    partialMs: snap.partialMs ?? null, doneMs: snap.doneMs ?? null,
    phases: (snap.phases || []).map((x) => ({ name: x.name, atMs: Math.round(x.atMs) })),
    results: snap.result && Array.isArray(snap.result.results) ? snap.result.results.length : 0,
  };
}

/** 入れ先の名前 (詳しくのシートで珠の場所を出すとき) */
export function decoTargetLabel(t) {
  return DECO_TARGET_LABEL[t] || t;
}
