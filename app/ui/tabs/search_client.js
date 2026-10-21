// 探索の Worker の出し入れ (作る・start・cancel・extend・作り直し・Worker が無いときの代わり) と hook useSearchRun。
// 担当: ui-search (3e)。Worker は app/search_worker.js (メッセージは docs/SEARCH_DESIGN.md 3.5 節と docs/RECOMMEND_DESIGN.md 5.5 節)。
// 使い方は docs/UI_API.md の「探すタブ」節。
//
// - 探索は 1 つだけ (コントローラはモジュールに 1 つ。タブを隠しても・描き直しても続く)。新しく始めると前のものは捨てる。
// - Worker が作れない端末では、画面のスレッドで 16ms ずつ区切って回す (遅いが動く。結果に「画面の処理で探しました」と出す)。
// - 一度も返事をしないまま Worker が落ちた (読み込めなかった) ときも、画面のスレッドで回し直す。それも失敗したら
//   (電波が無いなど)、「もう一度」と次に本人が始めたときに Worker から作り直す (再読み込みしなくても、電波が戻れば探せる)。
// - 「やめる」は Worker に cancel を送り、止まらなければ (CANCEL_GRACE_MS) Worker を作り直す。
// - 返事が STALL_MS 来ない (画面が見えている間だけ数える) ときは、止まったものとして知らせる。
// - 終わったら、結果を store.js の search-last に、かかった時間を search-timing (この端末だけ) に残す。
//
// テストの差し替え (本番の経路では使わない): tests/smoke_ui.py が init script で
//   window.__mhwSearchWorker = { url: './tests/fixtures/fake_search_worker.js?step=120' }
// を置くと、その url の Worker (作り物) を使う。Worker が無いときは同じ url を module として読み、createEngine で回す。
import { useEffect, useState } from 'preact/hooks';
import { saveSearchLast, loadSearchLast, appendSearchTiming } from '../../store.js';
import { getCoreData } from '../../data.js';
import { normalizeResult, topChanged, bestOfProgress, timingEntry } from './search_form.js';

/** 本物の Worker */
export const WORKER_URL = new URL('../../search_worker.js', import.meta.url).href;
/** 画面のスレッドで回すときの 1 回の長さ (ms) */
export const SLICE_MS = 16;
/** 「やめる」のあと、これだけ待っても止まらなければ Worker を作り直す (ms) */
export const CANCEL_GRACE_MS = 2500;
/** 返事がこれだけ来なければ止まったものとして扱う (画面が見えている間だけ数える。ms) */
export const STALL_MS = 20000;
/** 画面のスレッドで回すときの途中経過の間隔 (ms。Worker の決まりと同じ) */
const PROGRESS_EVERY_MS = 500;

const isObj = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const messageOf = (e) => (e && e.message ? e.message : String(e ?? ''));

/** 探す処理 (search.js など) を読み込めなかったときの文 (英語のまま出さない。くわしくに元の文を出す) */
export const LOAD_ERROR_TEXT = '探す処理を読み込めませんでした。電波の良い所で「もう一度」を押すか、アプリを再読み込みしてください。';

/** 探索の結果の status → 画面の状態 */
const STATUS_OF = { done: 'done', partial: 'done', stopped: 'stopped', cancelled: 'cancelled', infeasible: 'infeasible' };

/**
 * 計算中の「いまの最良」を、1 つの探索の中で悪くならないように残す (期待値は大きい方、回数は小さい方)。
 * 回をまたぐと上位が上下する (属性やられの 2 回目の方が低いなど) ため。種類が変わったら新しい値にする。
 */
export function keepBest(prev, prevKind, next, nextKind) {
  const kind = nextKind === 'combos' ? 'combos' : 'damage';
  if (next == null) return { best: prev, kind: prevKind };
  if (prev == null || (prevKind || 'damage') !== kind) return { best: next, kind };
  return { best: kind === 'combos' ? Math.min(prev, next) : Math.max(prev, next), kind };
}

/** 何もしていないときの状態 */
export const IDLE = Object.freeze({
  status: 'idle',        // 'idle' | 'running' | 'cancelling' | 'done' | 'stopped' | 'cancelled' | 'infeasible' | 'error'
  busy: false,           // running か cancelling
  id: null, job: null, inputKey: null, summary: null,
  phase: null, elapsedMs: null, best: null, bestKind: null, run: null,
  result: null,          // いま出す結果 (normalizeResult の形。途中の結果のこともある)
  partial: false,        // result が途中の結果 (まだ続いている)
  improved: false,       // 途中の結果 (または「続けて探す」の前) から 1 位が変わった
  extended: 0, extending: false, canExtend: false,
  error: null,           // {message, detail, code ('load' = 探す処理を読み込めなかった)}
  inline: false,         // 画面のスレッドで回した
  phases: [],            // [{name, atMs}] 段階が変わった時刻 (計算した時間。裏に回っていた時間は数えない)
  partialMs: null, doneMs: null, startedAt: null,
  restored: null,        // 保存してあった結果を出している {savedAt, appVersion}
});

// ---------------------------------------------------------------- テストの差し替え

/**
 * テストだけの差し替え (window.__mhwSearchWorker = {url})。同じオリジンの url だけ使う。無ければ null。
 */
export function workerOverride(g = globalThis) {
  try {
    const o = g.__mhwSearchWorker;
    if (!isObj(o) || typeof o.url !== 'string' || !o.url) return null;
    const loc = g.location;
    const u = new URL(o.url, loc ? loc.href : undefined);
    if (loc && u.origin !== loc.origin) return null;
    return { url: u.href };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- つなぎ方 (Worker / 画面のスレッド)

/** Worker でつなぐ。作れなければ例外 */
function createWorkerTransport(WorkerCtor, url, { onMessage, onError }) {
  const w = new WorkerCtor(url, { type: 'module' });
  w.addEventListener('message', (e) => onMessage(e.data));
  w.addEventListener('error', (e) => {
    try { e.preventDefault(); } catch { /* 何もしない */ }
    onError({ message: (e && e.message) || '', kind: 'worker' });
  });
  w.addEventListener('messageerror', () => onError({ message: 'メッセージを読めませんでした', kind: 'message' }));
  return { inline: false, post: (m) => w.postMessage(m), terminate: () => w.terminate() };
}

/**
 * 画面のスレッドでつなぐ。engineFactory(post) → {handle(msg), dispose()} (Promise でもよい)。
 * 返事は setTimeout で後から届ける (Worker と同じく、送った直後には届かない)。
 */
export function createInlineTransport(engineFactory, { onMessage, onError }) {
  let engine = null;
  let dead = false;
  const queue = [];
  const post = (m) => {
    if (!dead) setTimeout(() => { if (!dead) onMessage(m); }, 0);
  };
  const send = (m) => {
    try {
      const r = engine.handle(m);
      if (r && typeof r.catch === 'function') r.catch((e) => !dead && onError({ message: messageOf(e), kind: 'inline' }));
    } catch (e) {
      onError({ message: messageOf(e), kind: 'inline' });
    }
  };
  Promise.resolve().then(() => engineFactory(post)).then((e) => {
    if (dead) {
      if (e && e.dispose) e.dispose();
      return;
    }
    engine = e;
    for (const m of queue.splice(0)) send(m);
  }).catch((e) => {
    if (!dead) onError({ message: messageOf(e), kind: 'inline-load' });
  });
  return {
    inline: true,
    post: (m) => (engine ? send(m) : queue.push(m)),
    terminate: () => {
      dead = true;
      if (engine && engine.dispose) engine.dispose();
    },
  };
}

/** createSearch に渡すデータ (docs/SEARCH_DESIGN.md 3.2 節の data)。core は data.js の core データ */
export function searchData(core) {
  if (!core) return null;
  return {
    index: core.index, effects: core.skillEffects, motions: core.motions, decorations: core.decorations,
    bonuses: core.bonuses, weapons: core.weapons, charms: core.charms, charmsFixed: core.charmsFixed,
    skills: core.skills, armor: core.armor, myWeapons: core.myWeapons, combos: core.combos,
  };
}

function defaultModules() {
  return Promise.all([import('../../model/search.js'), import('../../model/recommend.js')])
    .then(([search, recommend]) => ({ search, recommend }));
}

/**
 * Worker が無いときに画面のスレッドで探索を回すもの (Worker と同じメッセージを受けて、同じメッセージを返す)。
 * 探索の本体は model の createSearch (plan のときは recommend.js の createPlanRunner)。sliceMs ずつ区切って setTimeout で回す。
 * @param post (msg) => void
 * @param opts {loadModules: () => Promise<{search, recommend}>, getData: () => data | null, sliceMs, now}
 */
export function createModelEngine(post, { loadModules = defaultModules, getData = () => searchData(getCoreData()), sliceMs = SLICE_MS, now = () => Date.now() } = {}) {
  let cur = null;
  let disposed = false;
  let readySent = false;
  const stop = (c) => {
    if (c && c.timer) clearTimeout(c.timer);
    if (c) c.timer = null;
  };
  const fail = (c, e, extra = null) => {
    stop(c);
    if (cur === c) cur = null;
    post({ type: 'error', id: c.id, message: messageOf(e), ...(extra || {}) });
  };
  const loop = (c) => {
    if (disposed || cur !== c) return;
    let finished = false;
    try {
      finished = c.runner.step(sliceMs) === true;
    } catch (e) {
      fail(c, e);
      return;
    }
    let p = null;
    try {
      p = c.runner.progress();
    } catch { /* 途中経過が取れなくても続ける */ }
    if (p) {
      const t = now();
      if (p.phase !== c.lastPhase || t - c.lastProgressAt >= PROGRESS_EVERY_MS) {
        c.lastPhase = p.phase;
        c.lastProgressAt = t;
        post({
          type: 'progress', id: c.id, phase: p.phase, elapsedMs: p.elapsedMs,
          best: (Array.isArray(p.best) ? p.best : []).map((b) => (isObj(b) ? b.value : b)), run: p.run,
          ...(p.bestKind ? { bestKind: p.bestKind } : {}),
        });
      }
      if (p.partialReady && !c.partialSent && !finished) {
        c.partialSent = true;
        try {
          post({ type: 'partial', id: c.id, result: c.runner.result() });
        } catch (e) {
          fail(c, e);
          return;
        }
      }
    }
    if (finished) {
      c.finished = true;
      try {
        post({ type: 'done', id: c.id, result: c.runner.result() });
      } catch (e) {
        fail(c, e);
      }
      return;
    }
    c.timer = setTimeout(() => loop(c), 0);
  };
  return {
    async handle(msg) {
      if (disposed || !isObj(msg)) return;
      if (msg.type === 'start') {
        stop(cur);
        const c = { id: msg.id, runner: null, timer: null, lastPhase: null, lastProgressAt: 0, partialSent: false, finished: false };
        cur = c;
        let mods;
        try {
          mods = await loadModules();
        } catch (e) {
          // 動的 import の失敗 (電波が無いなど)。WebKit の文は英語なので、日本語の文にして元の文はくわしくへ
          fail(c, new Error(LOAD_ERROR_TEXT), { code: 'load', detail: messageOf(e) });
          return;
        }
        if (cur !== c || disposed) return;
        const data = getData();
        if (!data) {
          fail(c, new Error('データをまだ読み込めていません'));
          return;
        }
        if (!readySent) {
          readySent = true;
          post({ type: 'ready' });
        }
        const job = isObj(msg.job) ? msg.job : { kind: 'search', input: msg.input };
        try {
          if (job.kind === 'plan') {
            if (!mods.recommend || typeof mods.recommend.createPlanRunner !== 'function') {
              throw new Error('相手に合わせて探す機能は準備中です');
            }
            c.runner = mods.recommend.createPlanRunner(job, data, {
              createSearch: mods.search.createSearch, optimizeWeaponSide: mods.search.optimizeWeaponSide,
            });
          } else {
            c.runner = mods.search.createSearch(job.input, data);
          }
        } catch (e) {
          fail(c, e);
          return;
        }
        loop(c);
      } else if (msg.type === 'cancel') {
        const c = cur;
        if (!c || c.id !== msg.id || !c.runner || c.finished) return;
        try {
          c.runner.cancel(); // 次の step で止まる (status: cancelled)
        } catch (e) {
          fail(c, e);
        }
      } else if (msg.type === 'extend') {
        const c = cur;
        if (!c || c.id !== msg.id || !c.runner) {
          post({ type: 'error', id: msg.id ?? null, message: '続けて探せません。もう一度探してください。' });
          return;
        }
        try {
          c.runner.extend(msg.budget);
        } catch (e) {
          fail(c, e);
          return;
        }
        stop(c);
        c.finished = false;
        c.partialSent = true;
        loop(c);
      }
    },
    dispose() {
      disposed = true;
      stop(cur);
      cur = null;
    },
  };
}

/**
 * つなぎ方を作る関数 (コントローラが探索を始めるたびに、無ければ作る)。
 * 既定: Worker (テストの差し替えがあればその url)。Worker が無い・作れない・forceInline なら画面のスレッド。
 */
export function defaultTransportFactory({ getOverride = workerOverride, getWorker = () => globalThis.Worker, loadModules = defaultModules } = {}) {
  return (handlers, { forceInline = false } = {}) => {
    const ov = getOverride();
    const WorkerCtor = getWorker();
    if (!forceInline && typeof WorkerCtor === 'function') {
      try {
        return createWorkerTransport(WorkerCtor, ov ? ov.url : WORKER_URL, handlers);
      } catch (e) {
        console.warn('Worker を作れないので、画面の処理で探します', e);
      }
    }
    const factory = ov
      ? (post) => import(ov.url).then((m) => {
        if (typeof m.createEngine !== 'function') throw new Error('差し替えの Worker に createEngine がありません');
        return m.createEngine(post, { url: ov.url, inline: true });
      })
      : (post) => createModelEngine(post, { loadModules });
    return createInlineTransport(factory, handlers);
  };
}

// ---------------------------------------------------------------- コントローラ

function defaultVisible() {
  try {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden';
  } catch {
    return true;
  }
}

/**
 * 探索を 1 つ回す入れ物。画面の部品から切り離してあるので、タブを移っても・描き直しても続く。
 * @param opts {makeTransport (defaultTransportFactory の結果), now, setTimer, clearTimer, isVisible,
 *              onNews (途中の結果・終わりが出たとき), onFinish (終わったとき。保存など), cancelGraceMs, stallMs, watchEveryMs}
 * @returns {{start(job, meta) → id, cancel(), extend(budget) → bool, retry(), restore(last), clear(),
 *            onVisibility(visible), getSnapshot(), subscribe(fn) → off, dispose()}}
 */
export function createSearchController({
  makeTransport, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t),
  isVisible = defaultVisible, onNews = null, onFinish = null, cancelGraceMs = CANCEL_GRACE_MS, stallMs = STALL_MS,
  watchEveryMs = 1000,
} = {}) {
  let snap = IDLE;
  const listeners = new Set();
  let transport = null;
  let gotMessage = false;    // いまのつなぎ方から一度でも返事が来たか (来ないまま落ちた = 読み込めなかった)
  let fellBack = false;      // Worker を読み込めなかったので、画面のスレッドで回している
  let seq = 0;
  let lastMsgAt = 0;
  let hiddenAt = null;       // 裏に回った時刻 (計算した時間から除く)
  let hiddenMs = 0;
  let cancelTimer = null;
  let watchTimer = null;
  let prevResult = null;     // 「続けて探す」の前の結果 (1 位が変わったかを見る)

  const emit = () => {
    for (const fn of [...listeners]) {
      try {
        fn(snap);
      } catch (e) {
        console.warn('探すタブの購読でエラー', e);
      }
    }
  };
  const set = (patch) => {
    snap = { ...snap, ...patch };
    emit();
  };
  /** 始めてから計算した時間 (裏に回っていた時間を除く) */
  const activeMs = () => {
    if (snap.startedAt == null) return 0;
    const hidden = hiddenMs + (hiddenAt != null ? now() - hiddenAt : 0);
    return Math.max(0, now() - snap.startedAt - hidden);
  };
  const clearTimers = () => {
    if (cancelTimer != null) clearTimer(cancelTimer);
    if (watchTimer != null) clearTimer(watchTimer);
    cancelTimer = null;
    watchTimer = null;
  };
  const dropTransport = () => {
    if (!transport) return;
    try {
      transport.terminate();
    } catch { /* 何もしない */ }
    transport = null;
  };
  const news = () => {
    if (onNews) {
      try {
        onNews(snap);
      } catch (e) {
        console.warn(e);
      }
    }
  };
  const finished = () => {
    if (onFinish) {
      try {
        const r = onFinish(snap);
        if (r && typeof r.catch === 'function') r.catch((e) => console.warn(e));
      } catch (e) {
        console.warn(e);
      }
    }
  };

  function watch() {
    if (watchTimer != null) clearTimer(watchTimer);
    watchTimer = setTimer(() => {
      watchTimer = null;
      if (!snap.busy) return;
      if (isVisible() && now() - lastMsgAt > stallMs) {
        dropTransport();
        fail('探すのが止まってしまいました。もう一度探してください。', '返事がありませんでした');
        return;
      }
      watch();
    }, watchEveryMs);
  }

  function fail(message, detail = null, code = null) {
    clearTimers();
    set({
      status: 'error', busy: false, partial: false, extending: false, canExtend: false,
      error: { message: message || '探せませんでした。', detail, code },
    });
    finished();
  }

  function finish(raw) {
    clearTimers();
    const r = normalizeResult(raw);
    if (!r) {
      fail('探した結果を読めませんでした。もう一度探してください。');
      return;
    }
    let status = STATUS_OF[r.status] || 'done';
    if (snap.status === 'cancelling') status = 'cancelled';
    // 結果の無い「やめた」は、それまでの途中の結果を残す
    const result = status === 'cancelled' && !r.results.length && snap.result
      ? { ...snap.result, status: 'cancelled' } : r;
    const before = snap.extending ? prevResult : (snap.partial ? snap.result : null);
    const el = activeMs();
    set({
      status, busy: false, result, partial: false, extending: false,
      improved: !!before && topChanged(before, result),
      canExtend: (status === 'done' || status === 'stopped') && result.results.length > 0 && !!transport,
      doneMs: snap.doneMs ?? el, phase: 'done',
      phases: snap.extending ? snap.phases : [...snap.phases, { name: 'done', atMs: el }],
    });
    prevResult = null;
    news();
    finished();
  }

  function onMessage(msg) {
    if (!isObj(msg)) return;
    gotMessage = true;
    lastMsgAt = now();
    if (msg.type === 'ready') return;
    if (!snap.busy) return;                        // 終わった後・やめた後に届いたもの
    if (msg.id != null && msg.id !== snap.id) return; // 前の探索の知らせ
    if (msg.id == null && msg.type !== 'error') return;
    if (msg.type === 'progress') {
      const el = num(msg.elapsedMs) ?? activeMs();
      const phase = typeof msg.phase === 'string' ? msg.phase : snap.phase;
      const b = keepBest(snap.best, snap.bestKind, bestOfProgress(msg.best), msg.bestKind);
      set({
        phase, elapsedMs: el, best: b.best, bestKind: b.kind, run: isObj(msg.run) ? msg.run : snap.run,
        phases: phase !== snap.phase && !snap.extending ? [...snap.phases, { name: phase, atMs: activeMs() }] : snap.phases,
      });
    } else if (msg.type === 'partial') {
      const r = normalizeResult(msg.result);
      if (!r) return;
      set({ result: r, partial: true, partialMs: snap.partialMs ?? activeMs() });
      news();
    } else if (msg.type === 'done') {
      finish(msg.result);
    } else if (msg.type === 'error') {
      fail(typeof msg.message === 'string' && msg.message ? msg.message : '探せませんでした。',
        typeof msg.detail === 'string' ? msg.detail : null, typeof msg.code === 'string' ? msg.code : null);
    }
  }

  function onTransportError(e) {
    const loadFailure = !gotMessage && transport && !transport.inline;
    dropTransport();
    if (!snap.busy) return;
    if (loadFailure && !fellBack && snap.job) {
      // 一度も返事をしないまま落ちた = Worker を読み込めなかった → 画面のスレッドで回し直す
      console.warn('探す処理 (Worker) を読み込めなかったので、画面の処理で探します', e && e.message);
      fellBack = true;
      begin(snap.job, { inputKey: snap.inputKey, summary: snap.summary });
      return;
    }
    fail('探す処理でエラーが起きました。もう一度試してください。', e && e.message ? e.message : null);
  }

  function ensureTransport() {
    if (transport) return transport;
    gotMessage = false;
    transport = makeTransport({ onMessage, onError: onTransportError }, { forceInline: fellBack });
    return transport;
  }

  /**
   * 本人が始めた探索。画面の処理に切り替えたあと (Worker を読み込めなかった) でも、それも失敗していたら
   * (電波が無かったなど) Worker から作り直す (電波が戻れば、再読み込みしなくても探せるように)
   */
  function start(job, meta = {}) {
    if (fellBack && snap.status === 'error') {
      fellBack = false;
      dropTransport();
    }
    return begin(job, meta);
  }

  function begin(job, { inputKey = null, summary = null } = {}) {
    if (!isObj(job)) return null;
    clearTimers();
    prevResult = null;
    seq += 1;
    const id = `s${now().toString(36)}-${seq}`;
    let t;
    try {
      t = ensureTransport();
    } catch (e) {
      snap = { ...IDLE, id, job, inputKey, summary };
      fail('探す処理を始められませんでした。', messageOf(e));
      return id;
    }
    hiddenMs = 0;
    hiddenAt = isVisible() ? null : now();
    snap = {
      ...IDLE, status: 'running', busy: true, id, job, inputKey, summary, startedAt: now(), inline: !!t.inline,
      phase: 'prepare', phases: [{ name: 'prepare', atMs: 0 }],
    };
    emit();
    lastMsgAt = now();
    try {
      t.post({ type: 'start', id, job, input: job.kind === 'search' ? job.input : undefined });
    } catch (e) {
      dropTransport();
      fail('探す処理を始められませんでした。', messageOf(e));
      return id;
    }
    watch();
    return id;
  }

  function cancel() {
    if (!snap.busy || snap.status === 'cancelling') return;
    try {
      if (transport) transport.post({ type: 'cancel', id: snap.id });
    } catch { /* 下の時間切れで作り直す */ }
    set({ status: 'cancelling' });
    if (cancelTimer != null) clearTimer(cancelTimer);
    cancelTimer = setTimer(() => {
      cancelTimer = null;
      if (snap.status !== 'cancelling') return;
      // 止まらない (Worker が計算中で受け取れない) → 作り直す。データは次に始めたときに読み直す
      dropTransport();
      finish({ status: 'cancelled', results: [] });
    }, cancelGraceMs);
  }

  function extend(budget) {
    if (snap.busy || !snap.canExtend || !transport) return false;
    prevResult = snap.result;
    set({ status: 'running', busy: true, extending: true, extended: snap.extended + 1, improved: false, canExtend: false, phase: 'dfs' });
    lastMsgAt = now();
    try {
      transport.post({ type: 'extend', id: snap.id, budget });
    } catch (e) {
      dropTransport();
      fail('続けて探せませんでした。もう一度探してください。', messageOf(e));
      return false;
    }
    watch();
    return true;
  }

  return {
    start,
    cancel,
    extend,
    /** 同じ条件でもう一度 (エラーのあと)。つなぎ方は Worker から作り直す */
    retry() {
      if (!snap.job) return null;
      dropTransport();
      fellBack = false;
      return begin(snap.job, { inputKey: snap.inputKey, summary: snap.summary });
    },
    /** 保存してあった結果 (store.js の loadSearchLast) を出す。探していないときだけ */
    restore(last) {
      if (snap.busy || snap.result || !isObj(last)) return false;
      const r = normalizeResult(last.result);
      if (!r) return false;
      set({
        ...IDLE, status: STATUS_OF[r.status] || 'done', result: r, inputKey: last.inputKey ?? null, summary: last.summary ?? null,
        restored: { savedAt: last.savedAt ?? null, appVersion: last.appVersion ?? null },
      });
      return true;
    },
    /** 結果を消して何もしていない状態に (探している途中なら何もしない) */
    clear() {
      if (snap.busy) return;
      clearTimers();
      snap = IDLE;
      emit();
    },
    /** 画面が見えた / 裏に回った (document の visibilitychange) */
    onVisibility(visible) {
      const t = now();
      if (visible) {
        if (hiddenAt != null) hiddenMs += t - hiddenAt;
        hiddenAt = null;
        lastMsgAt = t; // 裏に回っていた間は返事が来なくても数えない
      } else if (hiddenAt == null) {
        hiddenAt = t;
      }
    },
    getSnapshot: () => snap,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose() {
      clearTimers();
      dropTransport();
      listeners.clear();
    },
  };
}

// ---------------------------------------------------------------- アプリの中のコントローラ (1 つ)

/** 端末の種類 (時間の記録に残す。iPhone での実測を見るため) */
function deviceText() {
  try {
    return String(navigator.userAgent || '').slice(0, 160);
  } catch {
    return '';
  }
}

async function appVersionText() {
  try {
    const m = await import('../components/app-update.js');
    return (await m.getAppVersion({ cached: true })) || null;
  } catch {
    return null;
  }
}

/** 終わったときに残すもの: 時間の記録 (この端末だけ) と、結果 (書き出しに入る) */
async function persistFinished(snap) {
  try {
    await appendSearchTiming(timingEntry(snap, { device: deviceText() }));
  } catch (e) {
    console.warn('探した時間を記録できませんでした', e);
  }
  const r = snap.result;
  if (!r || (!r.results.length && snap.status !== 'infeasible')) return;
  try {
    await saveSearchLast({ inputKey: snap.inputKey, summary: snap.summary, result: r, appVersion: await appVersionText() });
  } catch (e) {
    console.warn('探した結果を保存できませんでした', e);
  }
}

let controller = null;

/** アプリの中で 1 つのコントローラ (初めて呼ばれたときに作る) */
export function getSearchController() {
  if (controller) return controller;
  controller = createSearchController({
    makeTransport: defaultTransportFactory(),
    // 探すタブ以外を見ているときに結果が出たら、タブの絵に点を付ける (開いているタブには shell.js が付けない)
    onNews: () => {
      import('../shell.js').then((m) => m.setTabDot('search')).catch(() => {});
    },
    onFinish: persistFinished,
  });
  try {
    document.addEventListener('visibilitychange', () => controller.onVisibility(document.visibilityState !== 'hidden'));
  } catch { /* DOM が無い環境 */ }
  return controller;
}

let restoreTried = false;

/**
 * 探すタブの hook。{snap (コントローラの状態), ctrl (start / cancel / extend / retry …)}。
 * 初めて使われたときに、保存してある最後の結果 (search-last) を読んで出す (探していなければ)。
 */
export function useSearchRun() {
  const ctrl = getSearchController();
  const [snap, setSnap] = useState(() => ctrl.getSnapshot());
  useEffect(() => {
    setSnap(ctrl.getSnapshot());
    const off = ctrl.subscribe((s) => setSnap(s));
    if (!restoreTried) {
      restoreTried = true;
      loadSearchLast().then((last) => {
        if (last) ctrl.restore(last);
      }).catch((e) => console.warn('前回の結果を読めませんでした', e));
    }
    return off;
  }, [ctrl]);
  return { snap, ctrl };
}
