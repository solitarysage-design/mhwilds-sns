// data/*.json を読んで配る。
// - URL はこのファイルからの相対 (GitHub Pages のプロジェクトサイトは /mhwilds-sns/ の下に置かれるため、先頭 / の絶対パスは使わない)。
// - 装備・スキル・火力の計算に使うもの (core) は起動時に読む。
// - モンスター・クエスト・脅威 (target) は「相手」タブを開いたときに初めて読む (遅延読み込み)。
// - 読み込み中・失敗は useData() / useTargetData() の status で分かる。retry() で読み直せる。
// 使い方は docs/UI_API.md の「data.js」節。

import { useEffect, useState } from 'preact/hooks';
import { indexEquipData } from './model/build.js';

/**
 * 読むファイルの一覧。key は data のプロパティ名、group は 'core' (起動時) / 'target' (相手タブで遅延)。
 * label は設定タブの表示用。
 */
export const DATA_FILES = [
  { key: 'skills', file: 'skills.json', group: 'core', label: 'スキル' },
  { key: 'armor', file: 'armor.json', group: 'core', label: '防具' },
  { key: 'weapons', file: 'weapons_sns.json', group: 'core', label: '片手剣' },
  { key: 'decorations', file: 'decorations.json', group: 'core', label: '装飾品' },
  { key: 'bonuses', file: 'bonuses.json', group: 'core', label: 'シリーズ・グループスキル' },
  { key: 'charmsFixed', file: 'charms_fixed.json', group: 'core', label: '生産する護石' },
  { key: 'talismanRules', file: 'talisman_rules.json', group: 'core', label: '鑑定護石の規則' },
  { key: 'charms', file: 'charms.json', group: 'core', label: '持っている護石' },
  { key: 'myWeapons', file: 'my_weapons.json', group: 'core', label: '持っているアーティア武器' },
  { key: 'skillEffects', file: 'skill_effects.json', group: 'core', label: 'スキルの効果 (火力計算)' },
  { key: 'motions', file: 'motions_sns.json', group: 'core', label: '技のモーション値' },
  { key: 'combos', file: 'combos_sns.json', group: 'core', label: '代表コンボ' },
  { key: 'monsters', file: 'monsters.json', group: 'target', label: 'モンスター・肉質' },
  { key: 'quests', file: 'quests.json', group: 'target', label: 'クエスト' },
  { key: 'threats', file: 'monster_threats.json', group: 'target', label: 'モンスターの咆哮・風圧など' },
];

const FETCH_TIMEOUT_MS = 30000;

/** data/ の中のファイルの URL (このモジュールからの相対) */
export function dataUrl(file) {
  return new URL(`../data/${file}`, import.meta.url).href;
}

/**
 * データを読めなかったときのエラー。画面は kind で案内を変える:
 *   'network' / 'timeout' = 通信できなかった (電波の良い所でもう一度)
 *   'http' / 'broken'     = 通信はできたが、ファイルが無い・壊れている (アプリの更新がうまくいっていない疑い。再読み込み)
 * message は画面に出す日本語 (ファイル名や HTTP の番号は入れない)。それらは detail (「くわしく」の中に出す)。
 */
export class DataLoadError extends Error {
  constructor(entry, kind, detail) {
    const label = entry.label || entry.file;
    const why = {
      network: '通信できませんでした',
      timeout: '時間がかかりすぎました',
      http: 'サーバーにファイルがありませんでした',
      broken: 'ファイルの中身が壊れていました',
    }[kind] || '読めませんでした';
    super(`「${label}」のデータを読み込めませんでした (${why})`);
    this.name = 'DataLoadError';
    this.file = entry.file;
    this.kind = kind;
    this.detail = `${entry.file}: ${detail}`;
  }

  /** 電波のせい (もう一度試せば直るかもしれない) か */
  get isNetwork() {
    return this.kind === 'network' || this.kind === 'timeout';
  }
}

async function fetchJson(entry) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS) : null;
  let res;
  try {
    res = await fetch(dataUrl(entry.file), ctrl ? { signal: ctrl.signal } : undefined);
  } catch (e) {
    if (e && e.name === 'AbortError') throw new DataLoadError(entry, 'timeout', `${FETCH_TIMEOUT_MS / 1000} 秒で時間切れ`);
    throw new DataLoadError(entry, 'network', e && e.message ? e.message : String(e));
  } finally {
    if (timer) clearTimeout(timer);
  }
  // Service Worker が電波なしで返す 503 は「通信できなかった」として扱う
  if (res.status === 503) throw new DataLoadError(entry, 'network', 'HTTP 503 (オフライン)');
  if (!res.ok) throw new DataLoadError(entry, 'http', `HTTP ${res.status}`);
  try {
    return await res.json();
  } catch (e) {
    throw new DataLoadError(entry, 'broken', `JSON として読めません (${e && e.message ? e.message : e})`);
  }
}

function filesOf(group) {
  return DATA_FILES.filter((f) => f.group === group);
}

async function loadGroup(group) {
  const files = filesOf(group);
  const loaded = await Promise.all(files.map((f) => fetchJson(f)));
  const out = { meta: {} };
  files.forEach((f, i) => {
    out[f.key] = loaded[i];
    out.meta[f.key] = loaded[i] && (loaded[i].meta || (loaded[i].schema != null ? { schema: loaded[i].schema } : null));
  });
  return out;
}

const listOf = (x, key) => (x && Array.isArray(x[key]) ? x[key] : []);

function byId(list) {
  const m = new Map();
  for (const e of list) m.set(e.id, e);
  return m;
}

/** core の生データに索引と配列の近道を足す */
function buildCore(raw) {
  const lists = {
    skills: listOf(raw.skills, 'skills'),
    armor: listOf(raw.armor, 'armor'),
    weapons: listOf(raw.weapons, 'weapons'),
    decorations: listOf(raw.decorations, 'decorations'),
    charms: listOf(raw.charms, 'charms'),
    charmsFixed: listOf(raw.charmsFixed, 'charms'),
    myWeapons: listOf(raw.myWeapons, 'weapons'),
    combos: listOf(raw.combos, 'combos'),
    moves: listOf(raw.motions, 'moves'),
  };
  const index = indexEquipData({
    skills: raw.skills, decorations: raw.decorations, bonuses: raw.bonuses, armor: raw.armor,
    weapons: raw.weapons, myWeapons: raw.myWeapons, charms: raw.charms, charmsFixed: raw.charmsFixed,
  });
  return { ...raw, lists, index };
}

function buildTarget(raw) {
  const lists = {
    monsters: listOf(raw.monsters, 'monsters'),
    quests: listOf(raw.quests, 'quests'),
    threats: listOf(raw.threats, 'monsters'),
  };
  return {
    ...raw, lists,
    index: { monsters: byId(lists.monsters), quests: byId(lists.quests) },
  };
}

// ---------------------------------------------------------------- 読み込みの状態 (グループごと)

function makeSlot(group, build) {
  return { group, build, status: 'idle', data: null, error: null, promise: null, listeners: new Set() };
}

const slots = {
  core: makeSlot('core', buildCore),
  target: makeSlot('target', buildTarget),
};

function notify(slot) {
  for (const fn of [...slot.listeners]) {
    try {
      fn();
    } catch (e) {
      console.warn(e);
    }
  }
}

function load(slot, { force = false } = {}) {
  if (slot.promise && !force) return slot.promise;
  if (slot.status === 'ready' && !force) return Promise.resolve(slot.data);
  slot.status = 'loading';
  slot.error = null;
  notify(slot);
  slot.promise = loadGroup(slot.group)
    .then((raw) => {
      slot.data = slot.build(raw);
      slot.status = 'ready';
      notify(slot);
      return slot.data;
    })
    .catch((e) => {
      slot.status = 'error';
      slot.error = e;
      slot.promise = null; // 次に呼ばれたら読み直す
      notify(slot);
      throw e;
    });
  return slot.promise;
}

/** 装備・スキル・火力のデータを読む (起動時に main.js が呼ぶ)。同時に何度呼んでも 1 回だけ読む。 */
export function loadCoreData(opts) {
  return load(slots.core, opts);
}

/** モンスター・クエスト・脅威のデータを読む (相手タブを開いたとき)。 */
export function loadTargetData(opts) {
  return load(slots.target, opts);
}

/** 読み終わっていれば core のデータ、まだなら null (hook を使えない所用)。 */
export function getCoreData() {
  return slots.core.data;
}

/** 読み終わっていれば target のデータ、まだなら null。 */
export function getTargetData() {
  return slots.target.data;
}

function snapshot(slot) {
  return {
    status: slot.status, // 'idle' | 'loading' | 'ready' | 'error'
    data: slot.data,
    error: slot.error,
    retry: () => load(slot, { force: true }).catch(() => {}),
  };
}

function useSlot(slot, autoLoad) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    slot.listeners.add(fn);
    if (autoLoad && slot.status === 'idle') load(slot).catch(() => {});
    fn(); // 描いてから購読までの間に変わった分
    return () => slot.listeners.delete(fn);
  }, [slot, autoLoad]);
  const snap = snapshot(slot);
  // 初回の描画で 'idle' と出さない (すぐ読み始めるので)
  if (autoLoad && snap.status === 'idle') snap.status = 'loading';
  return snap;
}

/**
 * 装備・スキル・火力のデータ。{status, data, error, retry}
 * status: 'loading' | 'ready' | 'error'
 */
export function useData() {
  return useSlot(slots.core, true);
}

/**
 * モンスター・クエスト・脅威のデータ。初めて使われたときに読み始める。{status, data, error, retry}
 * {load: false} なら読み始めない (設定タブで「読み込み済みなら表示」に使う)。
 */
export function useTargetData({ load: autoLoad = true } = {}) {
  return useSlot(slots.target, autoLoad);
}
