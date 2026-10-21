// IndexedDB の薄いラッパ (キーと値の保存)。
// - DB 名は "mhwilds-sns:db"。キーは必ず "mhwilds-sns:" で始める (同じ github.io オリジンに別のサイトがあるため)。
// - IndexedDB が使えない環境 (プライベートブラウズ・容量切れ・ブロックなど) ではメモリに置き、画面は動き続ける。
//   その場合は storageInfo().available が false になる (設定タブで表示)。
// - 全データの書き出しはテキスト (.txt / text/plain)。iOS の共有シートで .json が渡せないことがあるため。
// 使い方は docs/UI_API.md の「store.js」節。

export const PREFIX = 'mhwilds-sns:';
export const DB_NAME = 'mhwilds-sns:db';
const DB_VERSION = 1;
const STORE = 'kv';
const PERSIST_KEY = 'mhwilds-sns:persist-asked';
/** 書き出しファイルの印 (読み込み時に別物を弾く) */
export const BACKUP_KIND = 'mhwilds-sns-backup';
export const BACKUP_FORMAT = 1;

// ---------------------------------------------------------------- 状態
const memory = new Map();       // IndexedDB が使えないときの置き場 (使えるときも書き込み失敗の保険に使う)
let dbPromise = null;
let available = null;           // null = まだ試していない
let lastError = null;
const lateListeners = new Set(); // 時間切れの後に開けたときに呼ぶ (state.js が保存してある状態を読み直す)
/** 書き出さない「この端末だけの記録」のキー */
const DEVICE_ONLY_KEYS = new Set([PERSIST_KEY, 'mhwilds-sns:hint-home-screen']);

function assertKey(key) {
  if (typeof key !== 'string' || !key.startsWith(PREFIX)) {
    throw new Error(`保存のキーは "${PREFIX}" で始めること: ${String(key)}`);
  }
}

function errText(e) {
  if (!e) return '';
  return e.name ? `${e.name}: ${e.message || ''}` : String(e);
}

/** 開いている接続を捨てる (次の読み書きで開き直す)。切れた接続 (iPhone で長く裏に回した後など) に使う */
function dropDb(db) {
  try { if (db) db.close(); } catch { /* 何もしない */ }
  dbPromise = null;
}

/** 時間切れで先に進んだあと、遅れて開けたときに fn() を呼ぶ。戻り値は購読をやめる関数 */
export function onLateOpen(fn) {
  lateListeners.add(fn);
  return () => lateListeners.delete(fn);
}

/** IndexedDB に保存できる状態か (開けていれば true。まだ試していない・使えないなら false) */
export function isDbAvailable() {
  return available === true;
}

function openDb() {
  if (dbPromise) return dbPromise;
  let timedOut = false;
  const p = new Promise((resolve) => {
    let idb = null;
    try {
      idb = globalThis.indexedDB;
    } catch (e) {
      lastError = errText(e);
    }
    if (!idb) {
      available = false;
      lastError = lastError || 'このブラウザでは IndexedDB が使えません';
      resolve(null);
      return;
    }
    let req;
    try {
      req = idb.open(DB_NAME, DB_VERSION);
    } catch (e) {
      available = false;
      lastError = errText(e);
      resolve(null);
      return;
    }
    // 開くのが止まったまま (他のタブがブロックなど) でも画面は先に進める
    const timer = setTimeout(() => {
      timedOut = true;
      available = false;
      lastError = 'IndexedDB を開くのに時間がかかりすぎました';
      resolve(null);
    }, 4000);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      const db = req.result;
      // 別のタブで版が上がったら閉じる (次に開き直す)
      db.onversionchange = () => dropDb(db);
      // ブラウザが接続を切ったら (Safari は長く裏に回すと切ることがある)、次の読み書きで開き直す
      db.onclose = () => {
        if (dbPromise === p || dbPromise === late) dbPromise = null;
      };
      if (timedOut) {
        // 時間切れの後に開けた: これからの読み書きはこの接続を使う
        late = Promise.resolve(db);
        dbPromise = late;
        available = true;
        lastError = null;
        for (const fn of [...lateListeners]) {
          try { fn(); } catch (e) { console.warn(e); }
        }
        return;
      }
      available = true;
      resolve(db);
    };
    req.onerror = () => {
      clearTimeout(timer);
      if (timedOut) return;
      available = false;
      lastError = errText(req.error);
      resolve(null);
    };
    req.onblocked = () => {
      lastError = '他のタブが古い版の保存領域を開いています';
    };
  });
  let late = null;
  dbPromise = p;
  return p;
}

// 開き直してもう一度試す価値の無い失敗 (容量切れ・保存できない値)
const NO_RETRY = new Set(['QuotaExceededError', 'DataCloneError']);

/**
 * 1 回の読み書き。接続が切れていた (InvalidStateError / UnknownError など) ときは、開き直して 1 回だけやり直す。
 * @returns {Promise<{ok: boolean, value?: any}>} IndexedDB が使えないときは {ok: false}。それ以外の失敗は投げる
 */
async function withDb(mode, fn) {
  for (let attempt = 0; ; attempt++) {
    const db = await openDb();
    if (!db) return { ok: false };
    try {
      return { ok: true, value: await tx(db, mode, fn) };
    } catch (e) {
      if (attempt >= 1 || (e && NO_RETRY.has(e.name))) throw e;
      lastError = errText(e);
      dropDb(db);
    }
  }
}

// 1 回の読み書き。失敗したら reject (呼び出し側の関数で握って memory に回す)
function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    let result;
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const r = fn(store);
    if (r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('保存が中断されました'));
  });
}

// ---------------------------------------------------------------- 読み書き (すべて失敗しても投げない)

/** 値を読む。無ければ undefined。 */
export async function kvGet(key) {
  assertKey(key);
  try {
    const r = await withDb('readonly', (s) => s.get(key));
    if (r.ok && r.value !== undefined) return r.value;
  } catch (e) {
    lastError = errText(e);
  }
  return memory.get(key);
}

/** 値を書く (構造化複製できる値。関数や DOM は不可)。保存できたら true、メモリだけなら false。 */
export async function kvSet(key, value) {
  assertKey(key);
  memory.set(key, value);
  try {
    return (await withDb('readwrite', (s) => s.put(value, key))).ok;
  } catch (e) {
    lastError = errText(e);
    return false;
  }
}

/** 値を消す。 */
export async function kvDelete(key) {
  assertKey(key);
  memory.delete(key);
  try {
    return (await withDb('readwrite', (s) => s.delete(key))).ok;
  } catch (e) {
    lastError = errText(e);
    return false;
  }
}

/** 保存してあるキーの一覧 ("mhwilds-sns:" で始まるものだけ)。 */
export async function kvKeys() {
  const keys = new Set(memory.keys());
  try {
    const r = await withDb('readonly', (s) => s.getAllKeys());
    if (r.ok) for (const k of r.value || []) keys.add(k);
  } catch (e) {
    lastError = errText(e);
  }
  return [...keys].filter((k) => typeof k === 'string' && k.startsWith(PREFIX)).sort();
}

/** 全部の {key: value}。 */
export async function kvGetAll() {
  const out = {};
  for (const k of await kvKeys()) {
    const v = await kvGet(k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** 全部消す (このアプリの DB だけ。ほかのサイトの保存には触らない)。 */
export async function kvClear() {
  memory.clear();
  try {
    return (await withDb('readwrite', (s) => s.clear())).ok;
  } catch (e) {
    lastError = errText(e);
    return false;
  }
}

// ---------------------------------------------------------------- 保存領域の状態

/**
 * 初回だけ navigator.storage.persist() を呼ぶ (iPhone が空き容量不足のときに勝手に消さないよう頼む)。
 * 2 回目以降は呼ばない。force=true なら今すぐ頼み直す (設定タブのボタン)。
 * @returns {Promise<boolean|null>} 守られているなら true、断られたら false、仕組みが無ければ null
 */
export async function requestPersist({ force = false } = {}) {
  const st = globalThis.navigator && navigator.storage;
  if (!st || typeof st.persist !== 'function') return null;
  try {
    if (typeof st.persisted === 'function' && (await st.persisted())) return true;
    if (!force) {
      const asked = await kvGet(PERSIST_KEY);
      if (asked) return false;
    }
    const ok = await st.persist();
    await kvSet(PERSIST_KEY, { at: new Date().toISOString(), granted: !!ok });
    return !!ok;
  } catch (e) {
    lastError = errText(e);
    return null;
  }
}

/**
 * 保存領域の状態 (設定タブで表示する)。
 * @returns {Promise<{available: boolean, persisted: boolean|null, usage: number|null, quota: number|null, error: string|null, keys: number}>}
 */
export async function storageInfo() {
  await openDb();
  const info = { available: !!available, persisted: null, usage: null, quota: null, error: lastError, keys: 0 };
  const st = globalThis.navigator && navigator.storage;
  try {
    if (st && typeof st.persisted === 'function') info.persisted = await st.persisted();
  } catch { /* 何もしない */ }
  try {
    if (st && typeof st.estimate === 'function') {
      const e = await st.estimate();
      info.usage = typeof e.usage === 'number' ? e.usage : null;
      info.quota = typeof e.quota === 'number' ? e.quota : null;
    }
  } catch { /* 何もしない */ }
  info.keys = (await kvKeys()).length;
  return info;
}

// ---------------------------------------------------------------- 書き出し / 読み込み

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 書き出しのファイル名 (端末の時刻): mhwilds-sns-backup-20261021-1530.txt */
export function backupFileName(date = new Date()) {
  const d = date;
  return `mhwilds-sns-backup-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.txt`;
}

/**
 * 保存してある全データを 1 つのテキストにする。
 * 形: {"kind": "mhwilds-sns-backup", "format": 1, "exportedAt": "...", "appVersion": "...", "entries": {"mhwilds-sns:state": {...}, ...}}
 * 書き出さないキー: persist-asked・hint-home-screen (端末ごとの記録)
 */
export async function exportAllText({ appVersion = null } = {}) {
  const entries = await kvGetAll();
  for (const k of DEVICE_ONLY_KEYS) delete entries[k];
  const obj = { kind: BACKUP_KIND, format: BACKUP_FORMAT, exportedAt: new Date().toISOString(), appVersion, entries };
  return JSON.stringify(obj, null, 1);
}

/**
 * 書き出したテキストを読んで中身を確かめる (まだ保存しない)。
 * @returns {{ok: true, backup: object, keys: string[]} | {ok: false, message: string}}
 */
export function parseBackupText(text) {
  let obj;
  try {
    // 先頭の BOM や前後の空白・コピー時に混ざる余計な文字を落とす
    const s = String(text || '').replace(/^﻿/, '').trim();
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end < start) return { ok: false, message: 'データが見つかりません (書き出したファイルの中身をそのまま渡してください)' };
    obj = JSON.parse(s.slice(start, end + 1));
  } catch (e) {
    return { ok: false, message: `読み取れませんでした (${errText(e)})` };
  }
  if (!obj || obj.kind !== BACKUP_KIND) return { ok: false, message: 'このアプリの書き出しファイルではありません' };
  if (typeof obj.format !== 'number' || obj.format > BACKUP_FORMAT) {
    return { ok: false, message: 'このファイルは新しい版のアプリで作られています。アプリを更新してから読み込んでください' };
  }
  const entries = obj.entries && typeof obj.entries === 'object' ? obj.entries : {};
  const keys = Object.keys(entries).filter((k) => k.startsWith(PREFIX) && !DEVICE_ONLY_KEYS.has(k));
  return { ok: true, backup: obj, keys };
}

/**
 * 読み込んだ書き出しを保存する。replace=true なら先に全部消す (端末だけの記録 persist-asked などは残す)。
 * 保存したあとは state.js の reloadState() で画面に反映する。
 */
export async function importBackup(backup, { replace = true } = {}) {
  const entries = backup.entries || {};
  if (replace) {
    const keep = [];
    for (const k of DEVICE_ONLY_KEYS) {
      const v = await kvGet(k);
      if (v !== undefined) keep.push([k, v]);
    }
    await kvClear();
    for (const [k, v] of keep) await kvSet(k, v);
  }
  let saved = 0;
  for (const [k, v] of Object.entries(entries)) {
    if (!k.startsWith(PREFIX) || DEVICE_ONLY_KEYS.has(k)) continue;
    await kvSet(k, v);
    saved += 1;
  }
  return saved;
}

/**
 * テキストをファイルとして端末に渡す。iPhone では共有シート (ファイルに保存・AirDrop など) を出し、
 * 使えなければダウンロードにする。
 * @returns {Promise<'shared'|'downloaded'|'cancelled'>}
 */
export async function saveTextFile(text, fileName) {
  const type = 'text/plain';
  const nav = globalThis.navigator;
  try {
    if (nav && typeof nav.share === 'function' && typeof File === 'function') {
      const file = new File([text], fileName, { type });
      if (!nav.canShare || nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: fileName });
        return 'shared';
      }
    }
  } catch (e) {
    // 利用者が共有シートを閉じた
    if (e && e.name === 'AbortError') return 'cancelled';
    // それ以外はダウンロードに切り替える
  }
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return 'downloaded';
}

/**
 * テキストをクリップボードに写す (共有もダウンロードも使えないときの逃げ道)。
 * text は文字列か、文字列になる Promise。iPhone の Safari はタップの処理の中ですぐ書き込まないと断るので、
 * 作るのに時間がかかる文字 (書き出しなど) は Promise のまま渡す (ClipboardItem に Promise を渡す形で、タップの中で書き込む)。
 */
export async function copyText(text) {
  const nav = globalThis.navigator;
  const clip = nav && nav.clipboard;
  if (text && typeof text.then === 'function') {
    try {
      if (clip && typeof clip.write === 'function' && typeof ClipboardItem === 'function') {
        const item = new ClipboardItem({ 'text/plain': text.then((t) => new Blob([String(t)], { type: 'text/plain' })) });
        await clip.write([item]);
        return true;
      }
    } catch { /* 下の方法を試す (文字ができるのを待ってから) */ }
    try {
      text = await text;
    } catch {
      return false;
    }
  }
  try {
    if (clip && typeof clip.writeText === 'function') {
      await clip.writeText(text);
      return true;
    }
  } catch { /* 下の方法を試す */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** File (input[type=file] で選んだもの) をテキストとして読む。 */
export function readFileText(file) {
  if (file && typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}
