// 装備探索の Worker (app/search_worker.js) のメッセージ (docs/SEARCH_DESIGN.md 3.5 節・docs/RECOMMEND_DESIGN.md 5.5 節) を
// node で確かめる。self と fetch を作り物にして Worker のモジュールを読み込む (node --test はファイルごとに別のプロセス)。
// 送るものは structuredClone できること (postMessage で渡せる) も確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadRepoData, makeCases } from './search_cases.mjs';

const raw = await loadRepoData();
const { cases } = makeCases(raw);

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
let fetchCount = 0;
globalThis.fetch = async (url) => {
  fetchCount++;
  const buf = fs.readFileSync(new URL(url));
  return { ok: true, status: 200, json: async () => JSON.parse(buf.toString('utf8')) };
};
const send = (data) => handler({ data: structuredClone(data) });
const waitFor = (pred, ms = 20000) => new Promise((resolve, reject) => {
  const hit = msgs.find(pred);
  if (hit) { resolve(hit); return; }
  const w = { pred, resolve };
  waiters.push(w);
  setTimeout(() => reject(new Error('メッセージが来ない')), ms).unref();
});

await import('../app/search_worker.js');
const LIGHT = { beam: [10, 30], budget: { work: 3000 } };

test('作られたらデータを読んで ready を送る (data/*.json を 1 回だけ読む)', async () => {
  await waitFor((m) => m.type === 'ready');
  assert.equal(fetchCount, 10);
});

test('start → progress → partial → done (同じ id)。extend で続きを探してもう一度 done', async () => {
  // B&B の続きが何区切りかかるように時間の予算にする (仕上げ 1 の結果は途中で届く)
  send({ type: 'start', id: 'a1', job: { kind: 'search', input: { ...cases.B1, beam: [10, 30], budget: { ms: 600 } } } });
  const done = await waitFor((m) => m.type === 'done' && m.id === 'a1');
  const mine = msgs.filter((m) => m.id === 'a1');
  const iPartial = mine.findIndex((m) => m.type === 'partial');
  const iDone = mine.findIndex((m) => m.type === 'done');
  assert.ok(mine.some((m) => m.type === 'progress' && Array.isArray(m.best) && m.phase));
  assert.ok(iPartial >= 0 && iPartial < iDone, '仕上げ 1 の結果が先');
  assert.equal(mine[iPartial].result.status, 'partial');
  assert.equal(done.result.status, 'stopped');
  assert.equal(done.result.results.length, 10);
  const calls = done.result.stats.boundCalls;
  send({ type: 'extend', id: 'a1', budget: { ms: 300 } });
  const done2 = await waitFor((m) => m.type === 'done' && m.id === 'a1' && m !== done && m.result.stats.boundCalls > calls);
  assert.ok(done2.result.results[0].value >= done.result.results[0].value - 1e-9);
  assert.equal(fetchCount, 10, 'データは読み直さない');
});

test('cancel: 次の区切りで止まり、status: cancelled の done が来る', async () => {
  send({ type: 'start', id: 'c1', input: { ...cases.B1, budget: { ms: 60000 } } });
  await waitFor((m) => m.type === 'progress' && m.id === 'c1');
  send({ type: 'cancel', id: 'c1' });
  const done = await waitFor((m) => m.type === 'done' && m.id === 'c1');
  assert.equal(done.result.status, 'cancelled');
});

test('新しい start が来たら前の探索は捨てる (前の id の done は来ない)', async () => {
  send({ type: 'start', id: 'old', input: { ...cases.B1, budget: { ms: 60000 } } });
  send({ type: 'start', id: 'new', input: { ...cases.B1z, ...LIGHT } });
  await waitFor((m) => m.type === 'done' && m.id === 'new');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!msgs.some((m) => m.id === 'old' && (m.type === 'done' || m.type === 'partial')));
});

test('入力の誤り・まだ無い探し方 (plan) は error', async () => {
  send({ type: 'start', id: 'e1', input: { ...cases.B1, weapons: [] } });
  const e1 = await waitFor((m) => m.type === 'error' && m.id === 'e1');
  assert.match(e1.message, /武器/);
  send({ type: 'start', id: 'e2', job: { kind: 'plan', runs: [], merge: { mode: 'single' }, K: 10 } });
  const e2 = await waitFor((m) => m.type === 'error' && m.id === 'e2');
  assert.match(e2.message, /準備中/);
});
