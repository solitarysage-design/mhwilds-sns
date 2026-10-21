// Worker (app/search_worker.js) の job.kind 'plan' (docs/RECOMMEND_DESIGN.md 5.3 節・5.5 節) を node で確かめる。
// recommend.js の本物 (createPlanRunner) は別の担当が書いているので、このテストのプロセスの中だけ、5.3 節の形の作り物に
// 差し替える (module.registerHooks)。作り物は Worker から受け取った createSearch で runs を順に回し、progress に run を足す。
// self と fetch も作り物 (tests/search_worker.test.mjs と同じ)。node --test はファイルごとに別のプロセス。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { loadRepoData, makeCases } from './search_cases.mjs';

// ---- recommend.js の作り物 (5.3 節: createPlanRunner(job, data, {createSearch, optimizeWeaponSide}) → step/progress/result/cancel/extend)
const FAKE_RECOMMEND = `
export function buildPlan() { return null; }
export function createPlanRunner(job, data, deps) {
  globalThis.__planCalls.push({ kind: job.kind, runs: job.runs.length, createSearch: typeof deps.createSearch,
    optimizeWeaponSide: typeof deps.optimizeWeaponSide, hasIndex: !!(data && data.index && data.index.__equipIndex),
    effects: !!(data && data.skillEffects), motions: !!(data && data.motions) });
  if (job.fail) throw new Error('作り物の Plan が作れない');
  const runs = job.runs.map((r) => ({ ...r, search: null, result: null }));
  let i = 0; let cancelled = false; let extending = false;
  const cur = () => runs[Math.min(i, runs.length - 1)];
  const finished = () => cancelled || i >= runs.length;
  function step(ms) {
    if (finished()) return true;
    const r = runs[i];
    if (!r.search) r.search = deps.createSearch(r.input, data);
    if (r.search.step(ms)) { r.result = r.search.result(); i++; }
    return finished();
  }
  function progress() {
    const r = cur();
    const sub = r.search ? r.search.progress() : null;
    // 段階は変えない (回が変わったことだけで progress が来るかを見るため)
    return { phase: 'dfs', elapsedMs: sub ? sub.elapsedMs : 0, best: sub ? sub.best : [],
      partialReady: !!(runs[0].result || (i === 0 && sub && sub.partialReady)),
      run: { index: Math.min(i, runs.length - 1), count: runs.length, label: r.label, key: r.key } };
  }
  function result() {
    const all = runs.flatMap((r) => (r.result || (r.search ? r.search.result() : { results: [] })).results.map((x) => ({ ...x, run: r.key })));
    all.sort((a, b) => b.value - a.value);
    const status = cancelled ? 'cancelled' : !finished() ? 'partial' : 'done';
    return { status, quality: 'heuristic', merge: job.merge, warnings: [],
      results: all.slice(0, job.K).map((x, k) => ({ ...x, rank: k + 1, score: { kind: 'damage', value: x.value, better: 'higher' },
        perSubject: [], weapons: [x.weapon], builds: [x.build], defense: null })),
      stats: { runs: runs.map((r) => ({ key: r.key, label: r.label, status: r.result ? r.result.status : null })), extended: extending } };
  }
  function cancel() { cancelled = true; const r = cur(); if (r && r.search) r.search.cancel(); }
  function extend(b) {
    if (!finished() || cancelled) return false;
    const ok = runs.filter((r) => r.search && r.search.extend(b));
    if (!ok.length) return false;
    extending = true;
    i = runs.indexOf(ok[0]);
    for (const r of runs) if (ok.includes(r)) r.result = null;
    return true;
  }
  return { step, progress, result, cancel, extend };
}
`;
globalThis.__planCalls = [];
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/app/model/recommend.js')) return { format: 'module', source: FAKE_RECOMMEND, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const raw = await loadRepoData();
const { cases, skillId } = makeCases(raw);

const msgs = [];
let handler = null;
const waiters = [];
globalThis.self = {
  postMessage: (m) => {
    msgs.push(structuredClone(m));
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  },
  addEventListener: (type, fn) => { if (type === 'message') handler = fn; },
};
globalThis.fetch = async (url) => {
  const buf = fs.readFileSync(new URL(url));
  return { ok: true, status: 200, json: async () => JSON.parse(buf.toString('utf8')) };
};
const send = (data) => handler({ data: structuredClone(data) });
const waitFor = (pred, ms = 30000) => new Promise((resolve, reject) => {
  const hit = msgs.find(pred);
  if (hit) { resolve(hit); return; }
  const w = { pred, resolve };
  waiters.push(w);
  setTimeout(() => reject(new Error('メッセージが来ない')), ms).unref();
});

await import('../app/search_worker.js');

const LIGHT = { beam: [10, 30] };
const planJob = (extra = {}) => ({
  kind: 'plan', K: 10, merge: { mode: 'single' },
  runs: [
    { key: 'main', label: '属性やられ耐性で', input: { ...cases.B1z, ...LIGHT, budget: { work: 2000 } } },
    // 2 回目はすぐ終わる (0.5 秒ごとの progress を待たずに、回が変わったときの progress が来るか)
    { key: 'alt', label: '耐性スキルで', input: { ...cases.B1z, beam: [2, 2], budget: { work: 0 }, required: [{ skillId: skillId('耐震'), level: 3 }] } },
  ],
  ...extra,
});

test('plan: createPlanRunner に createSearch・optimizeWeaponSide・データ (索引つき) を渡し、progress に run が付く。partial → done', async () => {
  await waitFor((m) => m.type === 'ready');
  send({ type: 'start', id: 'p1', job: planJob() });
  const done = await waitFor((m) => m.type === 'done' && m.id === 'p1');
  const call = globalThis.__planCalls.at(-1);
  assert.deepEqual(call, { kind: 'plan', runs: 2, createSearch: 'function', optimizeWeaponSide: 'function', hasIndex: true, effects: true, motions: true });
  const mine = msgs.filter((m) => m.id === 'p1');
  const prog = mine.filter((m) => m.type === 'progress');
  assert.ok(prog.length > 0);
  for (const p of prog) {
    assert.equal(p.run.count, 2);
    assert.ok(p.run.index === 0 || p.run.index === 1);
    assert.equal(p.run.label, p.run.index === 0 ? '属性やられ耐性で' : '耐性スキルで');
  }
  assert.ok(prog.some((p) => p.run.index === 1), `2 回目の progress も来る ${JSON.stringify(prog.map((p) => [p.phase, p.run.index]))}`);
  const iPartial = mine.findIndex((m) => m.type === 'partial');
  assert.ok(iPartial >= 0 && iPartial < mine.findIndex((m) => m.type === 'done'), `partial が done より先 ${JSON.stringify(mine.map((m) => m.type + (m.run ? m.run.index : '')))}`);
  assert.equal(done.result.status, 'done');
  assert.equal(done.result.results.length, 10);
  assert.ok(done.result.results.every((r) => r.score.kind === 'damage' && Array.isArray(r.builds)));
  assert.deepEqual(done.result.stats.runs.map((r) => r.key), ['main', 'alt']);
});

test('plan: extend で続きを探してもう一度 done・cancel で cancelled', async () => {
  send({ type: 'extend', id: 'p1', budget: { work: 500 } });
  const again = await waitFor((m) => m.type === 'done' && m.id === 'p1' && m.result.stats.extended === true);
  assert.equal(again.result.status, 'done');
  send({ type: 'start', id: 'p2', job: planJob({ runs: [{ key: 'long', label: '長い', input: { ...cases.B1, budget: { ms: 60000 } } }] }) });
  await waitFor((m) => m.type === 'progress' && m.id === 'p2');
  send({ type: 'cancel', id: 'p2' });
  const done = await waitFor((m) => m.type === 'done' && m.id === 'p2');
  assert.equal(done.result.status, 'cancelled');
});

test('plan: createPlanRunner が投げたら error (同じ id)', async () => {
  send({ type: 'start', id: 'p3', job: planJob({ fail: true }) });
  const e = await waitFor((m) => m.type === 'error' && m.id === 'p3');
  assert.match(e.message, /作り物の Plan が作れない/);
});
