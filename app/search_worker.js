// 装備探索の Web Worker (モジュール Worker)。メッセージは docs/SEARCH_DESIGN.md 3.5 節と docs/RECOMMEND_DESIGN.md 5.5 節。
// 作り方: new Worker(new URL('./search_worker.js', import.meta.url), { type: 'module' })。
// Worker には import map が効かないので、import は相対パスだけ ('./model/search.js' など)。
// app/data.js は preact を読むので使わない (data/*.json は Worker が自分で fetch する。Service Worker のキャッシュから返る)。
//
// 画面 → Worker: {type: 'start', id, job}  job = {kind: 'search', input} (createSearch の入力) | {kind: 'plan', runs, merge, K}
//                 (job の代わりに input だけでもよい = kind 'search')
//                {type: 'cancel', id} / {type: 'extend', id, budget}
// Worker → 画面: {type: 'ready'} (データを読み終えた) / {type: 'progress', id, phase, elapsedMs, best: [値...], run?}
//                (段階か plan の回 (run.index) が変わったときと 0.5 秒ごと) / {type: 'partial', id, result} (仕上げ 1 の後) /
//                {type: 'done', id, result} /
//                {type: 'error', id, message}
// 中止: Worker は計算中にメッセージを受け取れないので、STEP_MS ごとに setTimeout(0) で手を離して cancel を受ける。
// 同時に走らせるのは 1 つだけ。新しい start が来たら前の探索は捨てる (結果も送らない)。
import { createSearch, optimizeWeaponSide } from './model/search.js';
import { indexEquipData } from './model/build.js';
import * as recommend from './model/recommend.js';

/** 1 回の step で計算する時間 (ms)。これごとに手を離して中止のメッセージを受ける */
export const STEP_MS = 80;
/** 途中経過を送る間隔 (ms) */
const PROGRESS_MS = 500;

/** 読む data/*.json (data.js の core と同じ名前。護石の規則・コンボは探索に要らない) */
const CORE_FILES = {
  skills: 'skills.json', armor: 'armor.json', weapons: 'weapons_sns.json', decorations: 'decorations.json',
  bonuses: 'bonuses.json', charmsFixed: 'charms_fixed.json', charms: 'charms.json', myWeapons: 'my_weapons.json',
  skillEffects: 'skill_effects.json', motions: 'motions_sns.json',
};

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const post = (msg) => self.postMessage(msg);
const errText = (e) => String((e && e.message) || e);

// ---------------------------------------------------------------- データ (1 回だけ読んで、索引も使い回す)

let dataPromise = null;

function loadData() {
  if (!dataPromise) {
    dataPromise = (async () => {
      const entries = await Promise.all(Object.entries(CORE_FILES).map(async ([key, file]) => {
        let res;
        try {
          res = await fetch(new URL(`../data/${file}`, import.meta.url).href);
        } catch (e) {
          throw new Error(`探すためのデータを読み込めませんでした (通信できませんでした: ${file})`);
        }
        if (!res.ok) throw new Error(`探すためのデータを読み込めませんでした (${file}: HTTP ${res.status})`);
        return [key, await res.json()];
      }));
      const raw = Object.fromEntries(entries);
      const index = indexEquipData({
        skills: raw.skills, decorations: raw.decorations, bonuses: raw.bonuses, armor: raw.armor, weapons: raw.weapons,
        myWeapons: raw.myWeapons, charms: raw.charms, charmsFixed: raw.charmsFixed,
      });
      return { ...raw, index };
    })();
    // 失敗したら次の start で読み直す
    dataPromise.catch(() => { dataPromise = null; });
  }
  return dataPromise;
}

// ---------------------------------------------------------------- job

/** job の種類で探し方を選ぶ。'search' = createSearch、'plan' = recommend.js の createPlanRunner (段階 3。探索と武器の側の選び直しを渡す) */
export function makeRunner(job, data) {
  const kind = (job && job.kind) || 'search';
  if (kind === 'search') return createSearch(job.input, data);
  if (kind === 'plan') {
    if (typeof recommend.createPlanRunner !== 'function') throw new Error('相手に合わせたおすすめの探し方は準備中です');
    return recommend.createPlanRunner(job, data, { createSearch, optimizeWeaponSide });
  }
  throw new Error(`知らない探し方です (${kind})`);
}

let current = null; // {id, runner, cancelRequested, superseded, running, finished}

const yieldToEvents = () => new Promise((resolve) => setTimeout(resolve, 0));

async function runLoop(j) {
  j.running = true;
  let lastPost = -Infinity;
  let lastPhase = null;
  let lastRun = null;
  try {
    while (true) {
      if (j.superseded) return;
      if (j.cancelRequested) j.runner.cancel();
      const fin = j.runner.step(STEP_MS);
      if (j.superseded) return;
      const p = j.runner.progress();
      const t = now();
      // 段階か、plan の回 (run.index) が変わったときと、0.5 秒ごと
      const runIndex = p.run ? p.run.index : null;
      if (!fin && (p.phase !== lastPhase || runIndex !== lastRun || t - lastPost >= PROGRESS_MS)) {
        lastPhase = p.phase;
        lastRun = runIndex;
        lastPost = t;
        post({ type: 'progress', id: j.id, phase: p.phase, elapsedMs: p.elapsedMs, best: (p.best || []).map((b) => b.value),
          ...(p.run ? { run: p.run } : {}) });
      }
      if (!fin && !j.partialSent && p.partialReady) {
        j.partialSent = true;
        post({ type: 'partial', id: j.id, result: j.runner.result() });
      }
      if (fin) {
        j.finished = true;
        post({ type: 'done', id: j.id, result: j.runner.result() });
        return;
      }
      await yieldToEvents();
    }
  } catch (e) {
    j.finished = true;
    post({ type: 'error', id: j.id, message: `探索の途中でエラーが起きました: ${errText(e)}` });
  } finally {
    j.running = false;
  }
}

async function start(msg) {
  if (current) current.superseded = true;
  const j = { id: msg.id ?? null, runner: null, cancelRequested: false, superseded: false, running: false, finished: false };
  current = j;
  let data;
  try {
    data = await loadData();
  } catch (e) {
    if (!j.superseded) post({ type: 'error', id: j.id, message: errText(e) });
    return;
  }
  if (j.superseded) return;
  try {
    j.runner = makeRunner(msg.job || { kind: 'search', input: msg.input }, data);
  } catch (e) {
    post({ type: 'error', id: j.id, message: errText(e) });
    return;
  }
  if (j.cancelRequested) j.runner.cancel();
  runLoop(j);
}

function extend(msg) {
  const j = current;
  if (!j || j.id !== (msg.id ?? null) || !j.runner || j.running || j.superseded) return;
  let ok = false;
  try {
    ok = j.runner.extend(msg.budget);
  } catch (e) {
    post({ type: 'error', id: j.id, message: errText(e) });
    return;
  }
  if (!ok) {
    // 続ける所が無い (最後まで探した・中止した): いまの結果をもう一度送る
    post({ type: 'done', id: j.id, result: j.runner.result() });
    return;
  }
  j.finished = false;
  runLoop(j);
}

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'start') start(msg);
  else if (msg.type === 'cancel') { if (current && current.id === (msg.id ?? null)) current.cancelRequested = true; }
  else if (msg.type === 'extend') extend(msg);
});

// 作られたらすぐデータを読み始める (読み終えたら ready)
loadData().then(() => post({ type: 'ready' }), (e) => post({ type: 'error', id: null, message: errText(e) }));
