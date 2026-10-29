// アプリ全体の状態を 1 か所で持つ小さなストア。
// - 状態は変更関数 (setWeapon など) でだけ変える。直接書き換えない (毎回新しいオブジェクトを作る = 不変更新)。
// - 画面からは useAppState(セレクタ) で購読する (Preact の hooks)。
// - IndexedDB (store.js) の "mhwilds-sns:state" に少し遅らせて保存し、次回 initState() で戻す。保存に失敗しても動く。
// 状態の形と関数の一覧は docs/UI_API.md の「state.js」節。

import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ARMOR_PARTS, DECO_TARGETS } from './model/build.js';
import { SHARPNESS_ORDER } from './model/damage.js';
import {
  hitzoneFor, individualOf, defaultQuestId, questById, subjectIndexOf, clampPlayers, INDIVIDUAL_KINDS,
} from './model/hunt.js';
import { kvGet, kvSet, kvDelete, isDbAvailable, onLateOpen } from './store.js';

export { ARMOR_PARTS, DECO_TARGETS, SHARPNESS_ORDER, INDIVIDUAL_KINDS };

export const STATE_KEY = 'mhwilds-sns:state';
export const STATE_SCHEMA = 1;
/** 研ぐまでに攻撃する秒数の既定 (2026-10-29。斬れ味の減り方を入れた。0 = 減らない = 一番上の色のまま) */
export const DEFAULT_SHARPNESS_INTERVAL = 60;
/** 研ぐまでに攻撃する秒数の上限 */
export const MAX_SHARPNESS_INTERVAL = 3600;
/** 画面下のタブ (並び順どおり) */
export const TABS = ['equip', 'power', 'target', 'search', 'charms', 'settings'];
/** 手入力の肉質で持つ項目 (0〜100) */
export const HITZONE_KEYS = ['slash', 'blunt', 'fire', 'water', 'thunder', 'ice', 'dragon'];
/**
 * 探すタブの選び方 (state.search の値の候補。先頭が既定ではないので既定は defaultSearch() を見る)。
 *   preset      守りのスキルの段: power (火力優先) / balance (バランス) / safe (安全)
 *   weaponMode  探す武器: auto (相手に合わせて決める) / current (いまの武器) / element (おすすめの属性から) / all (全部から)
 *   twoWeapons  多頭で武器を 2 本にする案: auto (属性の違う相手がいれば出す) / on / off
 *   partsPolicy 狙う部位: asSelected (相手タブで選んだ部位) / weak1 (弱点 1 か所) / main3 (主な部位 3 か所)
 *   limitBreak  限界突破: build (装備タブと同じ) / all (全部する) / none (しない)
 *   placeholders 仮置きの発動率の条件: zero (0% で探す) / keep (火力タブの値のまま)
 */
export const SEARCH_CHOICES = Object.freeze({
  preset: ['power', 'balance', 'safe'],
  weaponMode: ['auto', 'current', 'element', 'all'],
  twoWeapons: ['auto', 'on', 'off'],
  partsPolicy: ['asSelected', 'weak1', 'main3'],
  limitBreak: ['build', 'all', 'none'],
  placeholders: ['zero', 'keep'],
});
/** 1 つの装備に付く装飾品スロットの最大数 */
const MAX_SLOTS = 3;
const SAVE_DELAY_MS = 300;
/** 多頭クエストの相手の行の番号の上限 (mission.targets の行。いまは最大 5 行) */
const MAX_QUEST_TARGETS = 16;
/** 自分で足す必須スキルの数の上限と、Lv の上限 (スキルの最大 Lv は画面で絞る) */
const MAX_REQUIRED = 30;
const MAX_LEVEL = 10;
/** toggles / levels などのキーの長さと数の上限 (保存データを信用しない) */
const MAX_KEY = 100;
const MAX_KEYS = 300;

// ---------------------------------------------------------------- 初期値

function emptyArmor(fill) {
  const o = {};
  for (const p of ARMOR_PARTS) o[p] = fill;
  return o;
}

function emptyDecorations() {
  const o = {};
  for (const t of DECO_TARGETS) o[t] = [];
  return o;
}

/** 装備一式の初期値 (マイセットにはこの形で入る) */
export function emptyBuild() {
  return {
    weapon: null,                 // 数値 = weapons_sns.json の id / 文字列 = my_weapons.json の id
    armor: emptyArmor(null),      // {head, chest, arms, waist, legs}: armor.json の id
    limitBreak: emptyArmor(false), // 部位ごとの限界突破の有無 (computeBuild の limitBreak にそのまま渡せる)
    charm: null,                  // 文字列 = charms.json の id / 数値 = charms_fixed.json の id
    decorations: emptyDecorations(), // {weapon: [id|null, ...], head: [...], ..., charmArmor, charmWeapon}
  };
}

function defaultManual() {
  return {
    name: '手入力',
    hitzone: { slash: 45, blunt: 45, fire: 20, water: 20, thunder: 20, ice: 20, dragon: 20 },
    wound: null,                  // 傷口の肉質 (手入力)。null = 傷口ができない (傷口の段も傷口なしで計算する)
  };
}

/** 相手の初期値 */
export function emptyTarget() {
  return {
    mode: 'monster',              // 'monster' = モンスターと部位を選ぶ / 'manual' = 肉質を手入力
    monsterId: null,              // monsters.json の id
    partKey: null,                // monsters.json の parts[].key
    isWound: false,               // 傷口を狙うか
    questId: null,                // quests.json の id。クエストを選んでいなければ null
    manual: defaultManual(),
    // 段階 3 (docs/RECOMMEND_DESIGN.md 5.6 節)
    individual: null,             // monsters.json の individuals[].kind (null = 通常)。'tempered' | 'arch-tempered' | 'frenzied' | 'alpha'
    questTargetIndex: 0,          // 多頭のとき、相手タブの下のカードに出す相手 (mission.targets の行の番号)
    players: 1,                   // 人数 1〜4 (体力の表示だけ)
    useUncertainWound: false,     // 確度の低い傷口の置き換え (歴戦王アルシュベルド) を計算に使う
  };
}

/**
 * 探すタブの条件の初期値 (docs/RECOMMEND_DESIGN.md 5.6 節。小さいので state に置く)。
 * 既定は本人の決定 (2026-10-21): 守りはバランス・歴戦王 5 体とも倒した扱い・仮置きの発動率は 0% で探す・
 * 多頭で属性が違えば武器 2 本の案も出す。
 */
export function defaultSearch() {
  return {
    useTarget: true,              // 相手に合わせたおすすめを使う (false = 段階 2: 自分で条件を決める)
    preset: 'balance',            // 守りのスキルの段 (SEARCH_CHOICES.preset)
    toggles: {},                  // {要件の key: true|false} プリセットから変えたものだけ
    levels: {},                   // {要件の key: Lv} 軽減の Lv を選んだものだけ
    required: [],                 // 自分で足した必須スキル [{skillId, level}]
    weaponMode: 'auto',           // 探す武器 (SEARCH_CHOICES.weaponMode)
    twoWeapons: 'auto',           // 多頭で武器を 2 本にする案 (SEARCH_CHOICES.twoWeapons)
    partsPolicy: 'asSelected',    // 狙う部位 (SEARCH_CHOICES.partsPolicy)
    charms: { owned: true, local: true, fixed: true }, // 持っている護石 (charms.json) / この端末で足した護石 / 生産する護石
    limitBreak: 'build',          // 限界突破 (SEARCH_CHOICES.limitBreak)
    archTemperedHunted: {},       // {monsterId: false} 倒していない歴戦王だけ (無い = 倒した扱い。γ 防具・狩猟証γ の護石を使う)
    armorExclude: [],             // 使わない防具の id
    placeholders: 'zero',         // 仮置きの発動率の条件 (SEARCH_CHOICES.placeholders)
    budgetSec: 6,                 // 探す時間の目安 (秒)
    K: 10,                        // 出す件数
    autoStart: null,              // 「この相手で装備を探す」から来た印 {id, from, at}。探すタブが takeSearchRequest で消す (保存からは戻さない)
  };
}

export function defaultState() {
  return {
    schema: STATE_SCHEMA,
    tab: 'equip',
    build: emptyBuild(),
    target: emptyTarget(),
    search: defaultSearch(),
    combo: null,                  // combos_sns.json の id (文字列) か 技 id の配列。null = 先頭の代表コンボ
    uptimes: {},                  // {条件グループ id: 発動率}。damage.js の uptimes にそのまま渡せる (docs/MODEL_API.md)
    sharpness: null,              // null = 武器から自動 / 'red'〜'purple' = 固定
    sharpnessInterval: DEFAULT_SHARPNESS_INTERVAL, // 研ぐまでに攻撃する秒数 (自動のとき。0 = 減らない = 一番上の色のまま)
    mySets: [],                   // [{id, name, savedAt, build}]
    tabs: {},                     // タブごとの小さな画面状態 {equip: {...}, power: {...}} (setTabState)
  };
}

// ---------------------------------------------------------------- 値の検査 (保存データ・読み込みデータを信用しない)

const isObj = (x) => x != null && typeof x === 'object' && !Array.isArray(x);

function refOrNull(x) {
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (typeof x === 'string' && x.trim() !== '') return x;
  return null;
}

/**
 * 発動率の 0〜1。読めない値は null (= 入れていない。既定の値で計算する)。damage.js の toProb と同じ読み方:
 * null・空の文字・配列などを Number で 0 にして「0% を入れた」にしない (既定が 100% の条件で 100 ポイントずれるため)
 */
function clamp01(x) {
  if (typeof x === 'boolean') return x ? 1 : 0;
  const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

/** min〜max の整数に丸める (数でなければ fallback) */
function intIn(x, min, max, fallback) {
  if (x == null || x === '' || typeof x === 'boolean') return fallback;
  const n = Number(x);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

const pick = (list, v, fallback) => (list.includes(v) ? v : fallback);
const okKey = (k) => typeof k === 'string' && k.length > 0 && k.length <= MAX_KEY;
const individualKind = (k) => (INDIVIDUAL_KINDS.includes(k) ? k : null);
/** スキルの id (数) か null */
const skillIdOf = (x) => {
  if (x == null || x === '' || typeof x === 'boolean') return null;
  const n = Number(x);
  return Number.isInteger(n) && n >= 0 ? n : null;
};
/** 必須スキルの Lv (1〜MAX_LEVEL の整数) か null */
const levelOf = (x) => {
  if (x == null || x === '' || typeof x === 'boolean') return null;
  const n = Number(x);
  return Number.isInteger(n) && n >= 1 && n <= MAX_LEVEL ? n : null;
};

function sanitizeHitzone(raw, fallback) {
  if (!isObj(raw)) return fallback;
  const out = {};
  for (const k of HITZONE_KEYS) {
    const n = Number(raw[k]);
    out[k] = Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : (fallback ? fallback[k] : 0);
  }
  return out;
}

function sanitizeDecoList(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_SLOTS).map(refOrNull);
}

/** 装備一式を正しい形にそろえる (足りない項目は初期値)。 */
export function sanitizeBuild(raw) {
  const b = emptyBuild();
  if (!isObj(raw)) return b;
  b.weapon = refOrNull(raw.weapon);
  b.charm = refOrNull(raw.charm);
  for (const p of ARMOR_PARTS) {
    if (isObj(raw.armor)) b.armor[p] = refOrNull(raw.armor[p]);
    if (isObj(raw.limitBreak)) b.limitBreak[p] = raw.limitBreak[p] === true;
    else if (raw.limitBreak === true) b.limitBreak[p] = true;
  }
  if (isObj(raw.decorations)) {
    for (const t of DECO_TARGETS) b.decorations[t] = sanitizeDecoList(raw.decorations[t]);
  }
  return b;
}

function sanitizeTarget(raw) {
  const t = emptyTarget();
  if (!isObj(raw)) return t;
  t.mode = raw.mode === 'manual' ? 'manual' : 'monster';
  t.monsterId = refOrNull(raw.monsterId);
  t.partKey = typeof raw.partKey === 'string' && raw.partKey ? raw.partKey : null;
  t.isWound = raw.isWound === true;
  t.questId = refOrNull(raw.questId);
  if (isObj(raw.manual)) {
    t.manual = {
      name: typeof raw.manual.name === 'string' ? raw.manual.name.slice(0, 40) : t.manual.name,
      hitzone: sanitizeHitzone(raw.manual.hitzone, t.manual.hitzone),
      wound: raw.manual.wound == null ? null : sanitizeHitzone(raw.manual.wound, t.manual.hitzone),
    };
  }
  // 段階 3 の項目 (古い保存データには無い → 初期値)
  t.individual = individualKind(raw.individual);
  t.questTargetIndex = intIn(raw.questTargetIndex, 0, MAX_QUEST_TARGETS - 1, 0);
  t.players = raw.players == null ? 1 : clampPlayers(raw.players);
  t.useUncertainWound = raw.useUncertainWound === true;
  return t;
}

/** {キー: true|false} (toggles) */
function sanitizeFlagMap(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw).slice(0, MAX_KEYS)) {
    if (okKey(k) && typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** {キー: Lv} (levels) */
function sanitizeLevelMap(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw).slice(0, MAX_KEYS)) {
    const lv = levelOf(v);
    if (okKey(k) && lv != null) out[k] = lv;
  }
  return out;
}

/** 自分で足した必須スキル [{skillId, level}] (同じスキルは先のものだけ) */
function sanitizeRequired(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    if (!isObj(r)) continue;
    const id = skillIdOf(r.skillId);
    const lv = levelOf(r.level);
    if (id == null || lv == null || seen.has(id)) continue;
    seen.add(id);
    out.push({ skillId: id, level: lv });
    if (out.length >= MAX_REQUIRED) break;
  }
  return out;
}

/** {monsterId: false} 倒していない歴戦王だけ残す (true や知らない値は「倒した扱い」= 書かない) */
function sanitizeHunted(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw).slice(0, MAX_KEYS)) {
    if (/^\d{1,6}$/.test(k) && v === false) out[k] = false;
  }
  return out;
}

/** 防具の id の配列 (数だけ・重複なし) */
function sanitizeIdList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const x of raw) {
    const n = skillIdOf(x);
    if (n == null || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= 2000) break;
  }
  return out;
}

/**
 * 探すタブの条件をそろえる。autoStart (自動で探し始める印) は戻さない
 * (保存から戻したとき・読み込んだときに勝手に探し始めないため。印は requestSearch だけが置く)。
 */
export function sanitizeSearch(raw) {
  const s = defaultSearch();
  if (!isObj(raw)) return s;
  s.useTarget = raw.useTarget !== false;
  s.preset = pick(SEARCH_CHOICES.preset, raw.preset, s.preset);
  s.toggles = sanitizeFlagMap(raw.toggles);
  s.levels = sanitizeLevelMap(raw.levels);
  s.required = sanitizeRequired(raw.required);
  s.weaponMode = pick(SEARCH_CHOICES.weaponMode, raw.weaponMode, s.weaponMode);
  s.twoWeapons = pick(SEARCH_CHOICES.twoWeapons, raw.twoWeapons, s.twoWeapons);
  s.partsPolicy = pick(SEARCH_CHOICES.partsPolicy, raw.partsPolicy, s.partsPolicy);
  if (isObj(raw.charms)) {
    s.charms = { owned: raw.charms.owned !== false, local: raw.charms.local !== false, fixed: raw.charms.fixed !== false };
  }
  s.limitBreak = pick(SEARCH_CHOICES.limitBreak, raw.limitBreak, s.limitBreak);
  s.archTemperedHunted = sanitizeHunted(raw.archTemperedHunted);
  s.armorExclude = sanitizeIdList(raw.armorExclude);
  s.placeholders = pick(SEARCH_CHOICES.placeholders, raw.placeholders, s.placeholders);
  s.budgetSec = intIn(raw.budgetSec, 1, 60, s.budgetSec);
  s.K = intIn(raw.K, 1, 50, s.K);
  return s;
}

function sanitizeCombo(raw) {
  if (typeof raw === 'string' && raw) return raw;
  if (Array.isArray(raw)) {
    const moves = raw.filter((m) => typeof m === 'string' && m);
    return moves.length ? moves : null;
  }
  return null;
}

/** 発動率の値: binary のグループは 0〜1 の数、categorical のグループは {段 id: 0〜1} */
function sanitizeUptimeValue(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  if (isObj(v)) {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      const n = clamp01(x);
      if (n != null && k.length <= 100) o[k] = n;
    }
    return o;
  }
  return clamp01(v);
}

function sanitizeUptimes(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const n = sanitizeUptimeValue(v);
    if (n != null && k.length <= 100) out[k] = n;
  }
  return out;
}

function sanitizeMySets(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const s of raw) {
    if (!isObj(s) || typeof s.id !== 'string' || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push({
      id: s.id,
      name: typeof s.name === 'string' && s.name.trim() ? s.name.slice(0, 60) : '名前なし',
      savedAt: typeof s.savedAt === 'string' ? s.savedAt : new Date().toISOString(),
      build: sanitizeBuild(s.build),
    });
  }
  return out;
}

function sanitizeTabs(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) if (isObj(v)) out[k] = v;
  return out;
}

/** 研ぐまでに攻撃する秒数 (0〜上限の整数。無い・数でない値は既定。前の版の保存データには無いので既定になる) */
export function sanitizeSharpnessInterval(v) {
  if (v === 0 || v === '0') return 0;
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n) || n < 0) return DEFAULT_SHARPNESS_INTERVAL;
  return Math.min(MAX_SHARPNESS_INTERVAL, Math.round(n));
}

/** 保存データや読み込んだデータを、今の版の状態の形にそろえる。 */
export function sanitizeState(raw) {
  const s = defaultState();
  if (!isObj(raw)) return s;
  s.tab = TABS.includes(raw.tab) ? raw.tab : 'equip';
  s.build = sanitizeBuild(raw.build);
  s.target = sanitizeTarget(raw.target);
  s.search = sanitizeSearch(raw.search);
  s.combo = sanitizeCombo(raw.combo);
  s.uptimes = sanitizeUptimes(raw.uptimes);
  s.sharpness = SHARPNESS_ORDER.includes(raw.sharpness) ? raw.sharpness : null;
  s.sharpnessInterval = sanitizeSharpnessInterval(raw.sharpnessInterval);
  s.mySets = sanitizeMySets(raw.mySets);
  s.tabs = sanitizeTabs(raw.tabs);
  return s;
}

// ---------------------------------------------------------------- ストア本体

let state = defaultState();
const listeners = new Set();
let saveTimer = null;
let hydrated = false;
let changedSinceBoot = false;   // 起動してから本人が何か変えたか (遅れて保存領域が開けたときに読み直してよいか)
/** 保存の状態: 'idle' | 'saved' | 'memory' (端末に保存できずメモリだけ) */
let saveStatus = { status: 'idle', at: null };

/** 今の状態 (読むだけ。書き換えない)。 */
export function getState() {
  return state;
}

/** 変わるたびに fn(state) を呼ぶ。戻り値は購読をやめる関数。 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function commit(next, { persist = true } = {}) {
  if (next === state) return;
  state = next;
  for (const fn of [...listeners]) {
    try {
      fn(state);
    } catch (e) {
      console.warn('状態の購読でエラー', e);
    }
  }
  if (persist) scheduleSave();
}

/** 部分を書き換えた新しい状態で commit する小道具 */
function update(fn, opts) {
  const next = fn(state);
  if (next && next !== state) commit(next, opts);
}

function scheduleSave() {
  if (!hydrated) return; // 復元前に初期値で上書きしない
  changedSinceBoot = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushState();
  }, SAVE_DELAY_MS);
}

const saveListeners = new Set();

function setSaveStatus(next) {
  const prev = saveStatus;
  saveStatus = next;
  for (const fn of [...saveListeners]) {
    try {
      fn(next, prev);
    } catch (e) {
      console.warn('保存の状態の購読でエラー', e);
    }
  }
}

/** 今すぐ保存する (ふつうは自動。書き出しの前・再読み込みの前などに呼ぶ)。 */
export async function flushState() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    const ok = await kvSet(STATE_KEY, state);
    setSaveStatus({ status: ok ? 'saved' : 'memory', at: new Date().toISOString() });
  } catch (e) {
    setSaveStatus({ status: 'memory', at: new Date().toISOString() });
    console.warn('状態を保存できませんでした', e);
  }
  return saveStatus;
}

/** 保存の状態 {status: 'idle'|'saved'|'memory', at} */
export function getSaveStatus() {
  return saveStatus;
}

/**
 * 保存の状態が変わるたびに fn(next, prev) を呼ぶ (shell.js が「この端末に保存できていません」を出すのに使う)。
 * 戻り値は購読をやめる関数。
 */
export function subscribeSaveStatus(fn) {
  saveListeners.add(fn);
  return () => saveListeners.delete(fn);
}

/**
 * 起動時に 1 回呼ぶ。保存してある状態を戻す (無い・壊れている・読めないときは初期値)。
 * @returns {Promise<{restored: boolean}>}
 */
export async function initState() {
  let restored = false;
  try {
    const raw = await kvGet(STATE_KEY);
    if (raw !== undefined) {
      commit(sanitizeState(raw), { persist: false });
      restored = true;
    }
  } catch (e) {
    console.warn('保存した状態を読めませんでした', e);
  }
  hydrated = true;
  // 保存領域を開くのが時間切れになった (iPhone の起動直後に遅いことがある) あとで開けたら、
  // まだ何も変えていなければ保存してある状態を読み直す (変えていたらそちらを残す)
  if (!isDbAvailable()) {
    const off = onLateOpen(() => {
      off();
      if (!changedSinceBoot) reloadState().catch(() => {});
    });
  }
  // 裏に回ったら (iPhone はそのまま終了されることがある) すぐ保存する
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && saveTimer) flushState();
    });
    window.addEventListener('pagehide', () => {
      if (saveTimer) flushState();
    });
  } catch { /* DOM が無い環境 */ }
  return { restored };
}

/** 保存領域から読み直す (全データの読み込みの後に呼ぶ)。 */
export async function reloadState() {
  let raw;
  try {
    raw = await kvGet(STATE_KEY);
  } catch { /* 下で初期値 */ }
  commit(sanitizeState(raw), { persist: false });
}

/** 初期化 (全部初期値に戻して保存も消す)。開いているタブはそのまま (設定タブで続けて読み込みなどができるように)。 */
export async function resetState() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  commit({ ...defaultState(), tab: state.tab }, { persist: false });
  await kvDelete(STATE_KEY);
  setSaveStatus({ status: 'idle', at: null });
}

// ---------------------------------------------------------------- 購読 (Preact hooks)

const identity = (s) => s;

/**
 * 状態を読む hook。selector の戻り値が変わったときだけ描き直す (Object.is で比べる)。
 * 毎回新しい配列/オブジェクトを返す selector は避ける (state の一部をそのまま返すか、プリミティブを返す)。
 * 例: const weapon = useAppState((s) => s.build.weapon);
 */
export function useAppState(selector = identity) {
  const [, setTick] = useState(0);
  const selRef = useRef(selector);
  selRef.current = selector;
  const value = selector(state);
  const valRef = useRef(value);
  valRef.current = value;
  useLayoutEffect(() => {
    const check = () => {
      let next;
      try {
        next = selRef.current(state);
      } catch {
        setTick((t) => t + 1);
        return;
      }
      if (!Object.is(next, valRef.current)) setTick((t) => t + 1);
    };
    const off = subscribe(check);
    check(); // 描いてから購読までの間に変わった分
    return off;
  }, []);
  return value;
}

// ---------------------------------------------------------------- 変更関数: タブ

/** 開いているタブ (次回もこのタブで開く)。 */
export function setTab(tab) {
  if (!TABS.includes(tab)) return;
  update((s) => (s.tab === tab ? s : { ...s, tab }));
}

/** タブごとの小さな画面状態を足す (浅いマージ)。例: setTabState('power', {showDetail: true}) */
export function setTabState(tab, patch) {
  if (typeof tab !== 'string' || !isObj(patch)) return;
  update((s) => ({ ...s, tabs: { ...s.tabs, [tab]: { ...(s.tabs[tab] || {}), ...patch } } }));
}

// ---------------------------------------------------------------- 変更関数: 装備

function withBuild(fn) {
  update((s) => {
    const b = fn(s.build);
    return b === s.build ? s : { ...s, build: b };
  });
}

function withDecos(b, target, list) {
  return { ...b, decorations: { ...b.decorations, [target]: list } };
}

/**
 * 武器を選ぶ。ref は weapons_sns.json の id (数値) か my_weapons.json の id (文字列)。null で外す。
 * 既定では武器の装飾品を外す (スロットが変わるため)。{keepDecorations: true} で残す。
 * {decorations: [...]} を渡すと、武器の装飾品をその並びにする (新しい武器に入る珠だけ残すとき。
 * 装備タブは equip_logic.js の refitDecorations で決めて渡す)。
 */
export function setWeapon(ref, { keepDecorations = false, decorations = null } = {}) {
  const v = refOrNull(ref);
  withBuild((b) => {
    if (b.weapon === v && !Array.isArray(decorations)) return b;
    const nb = { ...b, weapon: v };
    if (Array.isArray(decorations)) return withDecos(nb, 'weapon', sanitizeDecoList(decorations));
    return keepDecorations ? nb : withDecos(nb, 'weapon', []);
  });
}

/**
 * 防具を選ぶ。part は 'head'|'chest'|'arms'|'waist'|'legs'、ref は armor.json の id。null で外す。
 * 既定ではその部位の装飾品を外す ({keepDecorations: true} で残す。{decorations: [...]} でその並びにする)。
 * 限界突破の有無は部位に付いたまま残す (別の防具に替えても同じ。{resetLimitBreak: true} で外す)。
 */
export function setArmor(part, ref, { keepDecorations = false, resetLimitBreak = false, decorations = null } = {}) {
  if (!ARMOR_PARTS.includes(part)) return;
  const v = refOrNull(ref);
  withBuild((b) => {
    if (b.armor[part] === v && !Array.isArray(decorations)) return b;
    let nb = { ...b, armor: { ...b.armor, [part]: v } };
    if (resetLimitBreak) nb = { ...nb, limitBreak: { ...nb.limitBreak, [part]: false } };
    if (Array.isArray(decorations)) return withDecos(nb, part, sanitizeDecoList(decorations));
    return keepDecorations ? nb : withDecos(nb, part, []);
  });
}

/**
 * 防具の限界突破の有無。part を渡すとその部位だけ、part = null で全部位。
 * 限界突破後のスロットは armor.json の slotsLimitBreak (computeBuild が使う。不明な防具は警告 limit-break-unknown)。
 */
export function setLimitBreak(part, on) {
  if (part == null) {
    withBuild((b) => (ARMOR_PARTS.every((p) => b.limitBreak[p] === !!on) ? b : { ...b, limitBreak: emptyArmor(!!on) }));
    return;
  }
  if (!ARMOR_PARTS.includes(part)) return;
  withBuild((b) => (b.limitBreak[part] === !!on ? b : { ...b, limitBreak: { ...b.limitBreak, [part]: !!on } }));
}

/**
 * 護石を選ぶ。ref は charms.json の id (文字列) か charms_fixed.json の id (数値)。null で外す。
 * 既定では護石の装飾品 (charmArmor / charmWeapon) を外す。
 * {decorations: {charmArmor: [...], charmWeapon: [...]}} を渡すと、その並びにする (新しい護石に入る珠だけ残すとき)。
 */
export function setCharm(ref, { keepDecorations = false, decorations = null } = {}) {
  const v = refOrNull(ref);
  withBuild((b) => {
    if (b.charm === v && !isObj(decorations)) return b;
    const nb = { ...b, charm: v };
    if (isObj(decorations)) {
      return { ...nb, decorations: { ...nb.decorations,
        charmArmor: sanitizeDecoList(decorations.charmArmor), charmWeapon: sanitizeDecoList(decorations.charmWeapon) } };
    }
    return keepDecorations ? nb : { ...nb, decorations: { ...nb.decorations, charmArmor: [], charmWeapon: [] } };
  });
}

/**
 * 装飾品を 1 つ入れる。target は 'weapon'|'head'|...|'legs'|'charmArmor'|'charmWeapon'、
 * index はその装備のスロットの番号 (0 から)、decoId は decorations.json の id。null で外す。
 * スロットに入るかの検査はしない (computeBuild の errors で見る。入れる前に絞るなら decorationFitError)。
 */
export function setDecoration(target, index, decoId) {
  if (!DECO_TARGETS.includes(target)) return;
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= MAX_SLOTS) return;
  const v = refOrNull(decoId);
  withBuild((b) => {
    const list = [...(b.decorations[target] || [])];
    while (list.length <= i) list.push(null);
    if (list[i] === v) return b;
    list[i] = v;
    return withDecos(b, target, list);
  });
}

/** 装飾品をまとめて入れ替える (list の i 番目 = i 番目のスロット)。 */
export function setDecorations(target, list) {
  if (!DECO_TARGETS.includes(target)) return;
  withBuild((b) => withDecos(b, target, sanitizeDecoList(list)));
}

/** 装飾品を外す。target を省くと全部外す。 */
export function clearDecorations(target) {
  withBuild((b) => {
    if (target == null) return { ...b, decorations: emptyDecorations() };
    if (!DECO_TARGETS.includes(target)) return b;
    return withDecos(b, target, []);
  });
}

/** 装備一式を丸ごと入れ替える (探索の結果を使うときなど)。形は emptyBuild() と同じ。 */
export function setBuild(build) {
  const b = sanitizeBuild(build);
  update((s) => ({ ...s, build: b }));
}

/** 装備を全部外す。 */
export function clearBuild() {
  update((s) => ({ ...s, build: emptyBuild() }));
}

// ---------------------------------------------------------------- 変更関数: 相手

function withTarget(fn) {
  update((s) => {
    const t = fn(s.target);
    return t === s.target ? s : { ...s, target: t };
  });
}

/** 相手の項目をまとめて変える (浅いマージ。形は emptyTarget() と同じ)。 */
export function setTarget(patch) {
  if (!isObj(patch)) return;
  withTarget((t) => sanitizeTarget({ ...t, ...patch }));
}

/** 'monster' (モンスターと部位) か 'manual' (肉質を手入力) に切り替える。 */
export function setTargetMode(mode) {
  withTarget((t) => (t.mode === mode || !['monster', 'manual'].includes(mode) ? t : { ...t, mode }));
}

/**
 * モンスターを選ぶ (部位は partKey、省くと未選択)。傷口の指定は外す。
 * 個体は通常に戻し、クエストからも外す (多頭の途中で別のモンスターを選んだらクエストから外れる)。
 * 多頭クエストの相手を切り替えるとき (クエストは残す) は selectQuest(questId, {targetIndex, monsterId, ...})。
 */
export function selectMonster(monsterId, partKey = null) {
  withTarget((t) => ({
    ...t, mode: 'monster', monsterId: refOrNull(monsterId),
    partKey: typeof partKey === 'string' && partKey ? partKey : null, isWound: false,
    individual: null, questId: null, questTargetIndex: 0,
  }));
}

const TARGET_FIELDS = ['mode', 'monsterId', 'partKey', 'isWound', 'questId', 'individual', 'questTargetIndex', 'players', 'useUncertainWound'];
const sameTarget = (a, b) => TARGET_FIELDS.every((k) => a[k] === b[k]) && a.manual === b.manual;

/**
 * 個体を選ぶ (kind: null = 通常 / 'tempered' / 'arch-tempered' / 'frenzied' / 'alpha')。クエストも選び直す:
 *   {questId} を渡せばそのクエスト (null で外す)。
 *   {targetData} (data.js の useTargetData().data) を渡せば hunt.js の defaultQuestId の規則で選ぶ (無ければ null)。
 *   どちらも無ければクエストから外す。
 * questTargetIndex はそのクエストの中のこの個体の行 (分からなければ 0)。
 */
export function selectIndividual(kind, { targetData = null, questId } = {}) {
  const k = individualKind(kind);
  withTarget((t) => {
    let q = null;
    if (questId !== undefined) q = refOrNull(questId);
    else if (targetData && t.monsterId != null) q = defaultQuestId(targetData, t.monsterId, k);
    let idx = 0;
    if (q != null && targetData) {
      const i = subjectIndexOf(questById(targetData, q), t.monsterId, k);
      if (i != null) idx = i;
    }
    const next = { ...t, individual: k, questId: q, questTargetIndex: Math.min(idx, MAX_QUEST_TARGETS - 1) };
    return sameTarget(t, next) ? t : next;
  });
}

/**
 * クエストを選ぶ (null で外す)。targetIndex = 下のカードに出す相手 (mission.targets の行の番号。hunt.js の questSubjects の index)。
 * {monsterId, individual, partKey} を渡すと、モンスター・個体・部位もいっしょに替える (渡さないものはそのまま):
 *   「クエストの名前から選ぶ」で選んだとき (大型の 1 体目にする) や、多頭の相手の行をタップしたとき (クエストは残す) に使う。
 *   モンスターが替わると、部位 (partKey を渡さなければ未選択) と傷口の指定を外す。
 */
export function selectQuest(questId, { targetIndex = 0, monsterId, individual, partKey } = {}) {
  withTarget((t) => {
    const next = {
      ...t, questId: refOrNull(questId), questTargetIndex: intIn(targetIndex, 0, MAX_QUEST_TARGETS - 1, 0),
    };
    if (monsterId !== undefined) {
      const id = refOrNull(monsterId);
      next.mode = 'monster';
      if (id !== t.monsterId) {
        next.monsterId = id;
        next.partKey = null;
        next.isWound = false;
      }
    }
    if (individual !== undefined) next.individual = individualKind(individual);
    if (partKey !== undefined) next.partKey = typeof partKey === 'string' && partKey ? partKey : null;
    return sameTarget(t, next) ? t : next;
  });
}

/** 人数 (1〜4。体力の表示だけに使う)。 */
export function setPlayers(n) {
  withTarget((t) => {
    const p = clampPlayers(n);
    return t.players === p ? t : { ...t, players: p };
  });
}

/** 確度の低い傷口の置き換え (歴戦王アルシュベルド) を計算に使うか。 */
export function setUseUncertainWound(on) {
  withTarget((t) => (t.useUncertainWound === !!on ? t : { ...t, useUncertainWound: !!on }));
}

/** 部位を選ぶ (monsters.json の parts[].key)。 */
export function selectPart(partKey) {
  withTarget((t) => ({ ...t, partKey: typeof partKey === 'string' && partKey ? partKey : null }));
}

/** 傷口を狙うか。 */
export function setWound(on) {
  withTarget((t) => (t.isWound === !!on ? t : { ...t, isWound: !!on }));
}

/**
 * 手入力の肉質を変える (浅いマージ。値は 0〜100 に丸める)。
 * {wound: true} なら傷口の肉質を変える。setManualHitzone(null, {wound: true}) で傷口の手入力をやめる。
 */
export function setManualHitzone(patch, { wound = false } = {}) {
  withTarget((t) => {
    const m = t.manual;
    if (wound && patch == null) return { ...t, manual: { ...m, wound: null } };
    if (!isObj(patch)) return t;
    const base = wound ? (m.wound || m.hitzone) : m.hitzone;
    const hz = sanitizeHitzone({ ...base, ...patch }, base);
    return { ...t, manual: wound ? { ...m, wound: hz } : { ...m, hitzone: hz } };
  });
}

/**
 * 相手の状態を、damage.js に渡す target ({hitzone, wound, isWound}) にする。
 * monsters は data.js の useTargetData().data (または monsters.json 丸ごと / monsters 配列)。
 * 決まらないとき (未選択・データ未読み込み) は null。
 * 個体 (target.individual) があれば hunt.js の hitzoneFor で傷口を置き換える (歴戦王ウズ・トゥナなど。
 * 歴戦王アルシュベルドの置き換えは target.useUncertainWound のときだけ)。ラベルは「ウズ・トゥナ（歴戦王） 頭」。
 * @returns {{hitzone, wound, isWound, label, monster?, part?, individual?, woundSource?, woundMark?} | null}
 *   woundSource / woundMark は hitzoneFor の woundSource / mark (印: 'unverified' = 未確認・'uncertain' = 未確定)
 */
export function resolveTarget(target, monsters) {
  const t = target || state.target;
  if (t.mode === 'manual') {
    const m = t.manual;
    return { hitzone: m.hitzone, wound: m.wound, isWound: t.isWound, label: m.name || '手入力' };
  }
  if (t.monsterId == null || !t.partKey || !monsters) return null;
  const list = Array.isArray(monsters) ? monsters
    : Array.isArray(monsters.monsters) ? monsters.monsters
      : monsters.monsters && Array.isArray(monsters.monsters.monsters) ? monsters.monsters.monsters : [];
  const monster = list.find((x) => x.id === t.monsterId);
  const part = monster && (monster.parts || []).find((p) => p.key === t.partKey);
  if (!part) return null;
  const kind = individualKind(t.individual);
  const hz = hitzoneFor(monster, part, kind, { useUncertain: t.useUncertainWound === true });
  const ind = kind != null ? individualOf(monster, kind) : null;
  return {
    hitzone: hz.hitzone, wound: hz.wound || null, isWound: t.isWound,
    label: `${(ind && ind.name) || monster.name} ${part.name}`, monster, part,
    individual: kind, woundSource: hz.woundSource, woundMark: hz.mark,
  };
}

// ---------------------------------------------------------------- 変更関数: 火力の条件

/** コンボを選ぶ。combos_sns.json の id か 技 id の配列。null で既定 (先頭の代表コンボ)。 */
export function setCombo(combo) {
  const v = sanitizeCombo(combo);
  update((s) => (s.combo === v ? s : { ...s, combo: v }));
}

/**
 * state.combo を damage.js の combo 引数にする。combos は combos_sns.json 丸ごと (data.combos)。
 * null や見つからない id のときは先頭の代表コンボ。コンボが 1 つも無ければ null。
 */
export function resolveCombo(combo, combos) {
  const list = combos && Array.isArray(combos.combos) ? combos.combos : Array.isArray(combos) ? combos : [];
  const c = combo === undefined ? state.combo : combo;
  if (Array.isArray(c) && c.length) return c;
  return (typeof c === 'string' && list.find((x) => x.id === c)) || list[0] || null;
}

/**
 * 条件グループの発動率。groupId は skill_effects.json の rules.conditionGroups[].id (例 'enraged')。
 * binary のグループは 0〜1 の数、categorical のグループは {段 id: 0〜1} (例 setUptime('chain', {hit1to4: 0.2, hit5plus: 0.7}))。
 */
export function setUptime(groupId, value) {
  const v = sanitizeUptimeValue(value);
  if (typeof groupId !== 'string' || !groupId || v == null) return;
  update((s) => (s.uptimes[groupId] === v ? s : { ...s, uptimes: { ...s.uptimes, [groupId]: v } }));
}

/** categorical のグループの 1 つの段の割合を変える (他の段はそのまま)。例 setUptimeState('chain', 'hit5plus', 0.7) */
export function setUptimeState(groupId, stateId, ratio) {
  const n = clamp01(ratio);
  if (typeof groupId !== 'string' || !groupId || typeof stateId !== 'string' || !stateId || n == null) return;
  update((s) => {
    const cur = isObj(s.uptimes[groupId]) ? s.uptimes[groupId] : {};
    if (cur[stateId] === n) return s;
    return { ...s, uptimes: { ...s.uptimes, [groupId]: { ...cur, [stateId]: n } } };
  });
}

/** 発動率を既定 (skill_effects.json の defaultUptime) に戻す。groupId を省くと全部。 */
export function resetUptime(key) {
  update((s) => {
    if (key == null) return Object.keys(s.uptimes).length ? { ...s, uptimes: {} } : s;
    if (!(key in s.uptimes)) return s;
    const u = { ...s.uptimes };
    delete u[key];
    return { ...s, uptimes: u };
  });
}

/** 条件グループの発動率を読む (未設定なら fallback)。数か {段 id: 割合}。 */
export function uptimeOf(key, fallback = null, s = state) {
  return key in s.uptimes ? s.uptimes[key] : fallback;
}

/** 斬れ味の色を固定する ('red'〜'purple')。null で武器から自動。 */
export function setSharpness(color) {
  const v = SHARPNESS_ORDER.includes(color) ? color : null;
  update((s) => (s.sharpness === v ? s : { ...s, sharpness: v }));
}

/** 研ぐまでに攻撃する秒数 (斬れ味が自動のときの減り方。0 = 減らない = 一番上の色のまま) */
export function setSharpnessInterval(sec) {
  const v = sanitizeSharpnessInterval(sec);
  update((s) => (s.sharpnessInterval === v ? s : { ...s, sharpnessInterval: v }));
}

// ---------------------------------------------------------------- 変更関数: 探すタブ (段階 2・3)

function withSearch(fn) {
  update((s) => {
    const n = fn(s.search);
    return n === s.search ? s : { ...s, search: n };
  });
}

/**
 * 探すタブの条件をまとめて変える (浅いマージ。charms だけは中身もマージする)。値は sanitizeSearch でそろえる。
 * 例: setSearch({preset: 'safe'}) / setSearch({charms: {fixed: false}})
 * autoStart はここでは変えない (requestSearch / takeSearchRequest で)。
 */
export function setSearch(patch) {
  if (!isObj(patch)) return;
  withSearch((cur) => {
    const merged = { ...cur, ...patch };
    if (isObj(patch.charms)) merged.charms = { ...cur.charms, ...patch.charms };
    const next = { ...sanitizeSearch(merged), autoStart: cur.autoStart };
    return JSON.stringify(next) === JSON.stringify(cur) ? cur : next;
  });
}

/** 守りの要件 1 つのオン/オフ (プリセットより優先)。on = null でプリセットの値に戻す。 */
export function setSearchToggle(key, on) {
  if (!okKey(key)) return;
  withSearch((cur) => {
    const toggles = { ...cur.toggles };
    if (on == null) {
      if (!(key in toggles)) return cur;
      delete toggles[key];
    } else {
      if (toggles[key] === !!on) return cur;
      toggles[key] = !!on;
    }
    return { ...cur, toggles };
  });
}

/** 守りの要件 1 つの Lv (軽減の Lv を選んだとき)。level = null で既定 (無効にする Lv) に戻す。 */
export function setSearchLevel(key, level) {
  if (!okKey(key)) return;
  const lv = level == null ? null : levelOf(level);
  if (level != null && lv == null) return;
  withSearch((cur) => {
    const levels = { ...cur.levels };
    if (lv == null) {
      if (!(key in levels)) return cur;
      delete levels[key];
    } else {
      if (levels[key] === lv) return cur;
      levels[key] = lv;
    }
    return { ...cur, levels };
  });
}

/** 必須スキルを足す (もうあれば Lv を変える)。skillId は skills.json の id、level は 1 以上。 */
export function addRequired(skillId, level = 1) {
  const id = skillIdOf(skillId);
  const lv = levelOf(level);
  if (id == null || lv == null) return;
  withSearch((cur) => {
    const i = cur.required.findIndex((r) => r.skillId === id);
    if (i >= 0) {
      if (cur.required[i].level === lv) return cur;
      const required = [...cur.required];
      required[i] = { skillId: id, level: lv };
      return { ...cur, required };
    }
    if (cur.required.length >= MAX_REQUIRED) return cur;
    return { ...cur, required: [...cur.required, { skillId: id, level: lv }] };
  });
}

/** 足した必須スキルの Lv を変える (無ければ何もしない)。 */
export function setRequiredLevel(skillId, level) {
  const id = skillIdOf(skillId);
  const lv = levelOf(level);
  if (id == null || lv == null) return;
  withSearch((cur) => {
    const i = cur.required.findIndex((r) => r.skillId === id);
    if (i < 0 || cur.required[i].level === lv) return cur;
    const required = [...cur.required];
    required[i] = { skillId: id, level: lv };
    return { ...cur, required };
  });
}

/** 足した必須スキルを外す。 */
export function removeRequired(skillId) {
  const id = skillIdOf(skillId);
  if (id == null) return;
  withSearch((cur) => (cur.required.some((r) => r.skillId === id)
    ? { ...cur, required: cur.required.filter((r) => r.skillId !== id) } : cur));
}

/** 歴戦王を倒したか (倒していない = γ 防具・狩猟証γ の護石を使わない)。monsterId は monsters.json の id。 */
export function setArchTemperedHunted(monsterId, hunted) {
  const id = skillIdOf(monsterId);
  if (id == null) return;
  const key = String(id);
  withSearch((cur) => {
    const has = cur.archTemperedHunted[key] === false;
    if (hunted ? !has : has) return cur;
    const m = { ...cur.archTemperedHunted };
    if (hunted) delete m[key];
    else m[key] = false;
    return { ...cur, archTemperedHunted: m };
  });
}

/** 使わない防具に入れる / 外す (armor.json の id)。 */
export function setArmorExcluded(armorId, excluded) {
  const id = skillIdOf(armorId);
  if (id == null) return;
  withSearch((cur) => {
    const has = cur.armorExclude.includes(id);
    if (!!excluded === has) return cur;
    return { ...cur, armorExclude: excluded ? [...cur.armorExclude, id] : cur.armorExclude.filter((x) => x !== id) };
  });
}

/**
 * 「この相手で装備を探す」: 探すタブに「開いたら自動で探し始める」の印 (state.search.autoStart) を置く。
 * 相手に合わせたおすすめを使う (useTarget: true) にもする。呼んだ側はそのあと shell.js の goToTab('search', {top: true})。
 * 探すタブは autoStart を見て、takeSearchRequest(id) で印を消してから探し始める (探索の条件はその時の state から作る)。
 * 印は保存から戻したときには消える (sanitizeState が戻さない) ので、開き直しで勝手に探し始めることは無い。
 * @param from どこから来たか ('target' = 相手タブ。画面の文言を変えるのに使える)
 * @returns {string} 印の id
 */
export function requestSearch({ from = 'target' } = {}) {
  const id = `r${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
  const src = typeof from === 'string' && from ? from.slice(0, 20) : 'target';
  withSearch((cur) => ({ ...cur, useTarget: true, autoStart: { id, from: src, at: new Date().toISOString() } }));
  return id;
}

/**
 * 自動で探し始める印を受け取って消す (探すタブが 1 回だけ呼ぶ)。id を渡すとその印のときだけ消す。
 * @returns {{id, from, at} | null} 受け取った印 (無ければ null)
 */
export function takeSearchRequest(id) {
  let taken = null;
  withSearch((cur) => {
    if (!cur.autoStart || (id != null && cur.autoStart.id !== id)) return cur;
    taken = cur.autoStart;
    return { ...cur, autoStart: null };
  });
  return taken;
}

// ---------------------------------------------------------------- 変更関数: マイセット

function newSetId(existing) {
  const ids = new Set(existing.map((x) => x.id));
  let id;
  do {
    id = `s${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
  } while (ids.has(id));
  return id;
}

/**
 * 今の装備をマイセットに保存する。overwriteId を渡すとそのセットを上書きする。
 * @returns {string} セットの id
 */
export function saveMySet(name, { overwriteId = null } = {}) {
  const label = typeof name === 'string' && name.trim() ? name.trim().slice(0, 60) : `セット ${state.mySets.length + 1}`;
  const now = new Date().toISOString();
  let id = overwriteId;
  update((s) => {
    const build = sanitizeBuild(s.build);
    if (overwriteId && s.mySets.some((x) => x.id === overwriteId)) {
      return { ...s, mySets: s.mySets.map((x) => (x.id === overwriteId ? { ...x, name: label, savedAt: now, build } : x)) };
    }
    id = newSetId(s.mySets);
    return { ...s, mySets: [...s.mySets, { id, name: label, savedAt: now, build }] };
  });
  return id;
}

/** マイセットを今の装備にする。見つかれば true。 */
export function loadMySet(id) {
  const set = state.mySets.find((x) => x.id === id);
  if (!set) return false;
  update((s) => ({ ...s, build: sanitizeBuild(set.build) }));
  return true;
}

export function renameMySet(id, name) {
  if (typeof name !== 'string' || !name.trim()) return;
  update((s) => ({ ...s, mySets: s.mySets.map((x) => (x.id === id ? { ...x, name: name.trim().slice(0, 60) } : x)) }));
}

export function deleteMySet(id) {
  update((s) => (s.mySets.some((x) => x.id === id) ? { ...s, mySets: s.mySets.filter((x) => x.id !== id) } : s));
}
