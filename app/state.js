// アプリ全体の状態を 1 か所で持つ小さなストア。
// - 状態は変更関数 (setWeapon など) でだけ変える。直接書き換えない (毎回新しいオブジェクトを作る = 不変更新)。
// - 画面からは useAppState(セレクタ) で購読する (Preact の hooks)。
// - IndexedDB (store.js) の "mhwilds-sns:state" に少し遅らせて保存し、次回 initState() で戻す。保存に失敗しても動く。
// 状態の形と関数の一覧は docs/UI_API.md の「state.js」節。

import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ARMOR_PARTS, DECO_TARGETS } from './model/build.js';
import { SHARPNESS_ORDER } from './model/damage.js';
import { kvGet, kvSet, kvDelete, isDbAvailable, onLateOpen } from './store.js';

export { ARMOR_PARTS, DECO_TARGETS, SHARPNESS_ORDER };

export const STATE_KEY = 'mhwilds-sns:state';
export const STATE_SCHEMA = 1;
/** 画面下のタブ (並び順どおり) */
export const TABS = ['equip', 'power', 'target', 'charms', 'settings'];
/** 手入力の肉質で持つ項目 (0〜100) */
export const HITZONE_KEYS = ['slash', 'blunt', 'fire', 'water', 'thunder', 'ice', 'dragon'];
/** 1 つの装備に付く装飾品スロットの最大数 */
const MAX_SLOTS = 3;
const SAVE_DELAY_MS = 300;

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
    questId: null,                // quests.json の id (多頭クエスト用。まだ使わない)
    manual: defaultManual(),
  };
}

export function defaultState() {
  return {
    schema: STATE_SCHEMA,
    tab: 'equip',
    build: emptyBuild(),
    target: emptyTarget(),
    combo: null,                  // combos_sns.json の id (文字列) か 技 id の配列。null = 先頭の代表コンボ
    uptimes: {},                  // {条件グループ id: 発動率}。damage.js の uptimes にそのまま渡せる (docs/MODEL_API.md)
    sharpness: null,              // null = 武器から自動 / 'red'〜'purple' = 固定
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

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

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
  return t;
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

/** 保存データや読み込んだデータを、今の版の状態の形にそろえる。 */
export function sanitizeState(raw) {
  const s = defaultState();
  if (!isObj(raw)) return s;
  s.tab = TABS.includes(raw.tab) ? raw.tab : 'equip';
  s.build = sanitizeBuild(raw.build);
  s.target = sanitizeTarget(raw.target);
  s.combo = sanitizeCombo(raw.combo);
  s.uptimes = sanitizeUptimes(raw.uptimes);
  s.sharpness = SHARPNESS_ORDER.includes(raw.sharpness) ? raw.sharpness : null;
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

/** モンスターを選ぶ (部位は partKey、省くと未選択)。傷口の指定は外す。 */
export function selectMonster(monsterId, partKey = null) {
  withTarget((t) => ({
    ...t, mode: 'monster', monsterId: refOrNull(monsterId),
    partKey: typeof partKey === 'string' && partKey ? partKey : null, isWound: false,
  }));
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
 * @returns {{hitzone, wound, isWound, label, monster?, part?} | null}
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
  return {
    hitzone: part.hitzone, wound: part.wound || null, isWound: t.isWound,
    label: `${monster.name} ${part.name}`, monster, part,
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
