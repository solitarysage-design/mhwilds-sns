// 装備探索のベンチ (docs/SEARCH_DESIGN.md 5 章)。node --test には入れない (手で回す)。
//
//   node --expose-gc tools/bench_search.mjs [--cases B1,B2,B3,B4,B4x,B5] [--runs 3] [--mode time|work|both]
//                                           [--ms 2500] [--work 60000] [--out 結果.jsonl]
//   node --expose-gc tools/bench_search.mjs --make-ref [--cases B1,B2,B3,B5] [--ref-ms 120000]
//   node --expose-gc tools/bench_search.mjs --weapon-side [--runs 3]   (武器の側だけを選び直す optimizeWeaponSide。WS / WSz)
//
// - ケースごとに毎回新しいプロセス (同じ node) で走らせる (前のケースの覚えやキャッシュを持ち越さない)。
// - 時間 (--mode time): 予算は時間 (--ms。画面と同じ「始めてからの時間」)。partial / done の時刻・段階ごとの時刻。
//   値 (--mode work): 予算は仕事量 (--work = B&B の中で上界を求めた回数)。端末の速さで結果が変わらないので、基準と比べる。
// - メモリ: ヒープの増え (探索の前に gc した値からの最大。step ごとに測る) と、終わって gc した後に残った分。
// - 基準 (tests/fixtures/search_ref.json) はデータのハッシュと一緒に持つ。データが変わっていたら「基準が古い」と出す (失敗にしない)。
//   --make-ref で作り直す (幅の広いビーム + B&B を --ref-ms まで。時間がかかる)。
// - ほかの node が動いているとぶれる (試作の測定は 1.8 倍ぶれた)。測る前と最中の CPU の使われ方 (全コアの平均) を出す。
import { spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const REF_PATH = new URL('tests/fixtures/search_ref.json', ROOT);
const SELF = fileURLToPath(import.meta.url);

/** 目標 (docs/SEARCH_DESIGN.md 5.1 節) */
const TARGETS = {
  B1: { partialMs: 1000, doneMs: 3000, heapMB: 200 }, B2: { partialMs: 1000, doneMs: 3000, heapMB: 200 },
  B5: { partialMs: 1000, doneMs: 3000, heapMB: 200 }, B3: { partialMs: 3000, doneMs: 4000, heapMB: 300 },
  B4: { firstMs: 100 }, B4x: { doneMs: 50 },
};
const VALUE_TOL = { top1: 0.003, rank: 0.02 };
/** 既知の最良 (証明は無い。docs/SEARCH_DESIGN.md 5.1 節の基準。3 方式の試作で見つかった値) */
const KNOWN_BEST = {
  B1: [920.804, '整数計画・目標列挙・B&B の長時間の試作で一致した値'],
  B2: [866.030, 'B&B の試作の 90 秒 (報告)'],
  B3: [1102.952, 'B&B と整数計画の試作で一致した値'],
  B5: [927.686, 'B&B と整数計画の試作で一致した値'],
};

function args() {
  const a = process.argv.slice(2);
  const o = { cases: null, runs: 3, mode: 'both', ms: 2500, work: 60000, out: null, makeRef: false, refMs: 120000, child: null };
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    const v = () => a[++i];
    if (k === '--cases') o.cases = v().split(',');
    else if (k === '--runs') o.runs = Number(v());
    else if (k === '--mode') o.mode = v();
    else if (k === '--ms') o.ms = Number(v());
    else if (k === '--work') o.work = Number(v());
    else if (k === '--out') o.out = v();
    else if (k === '--make-ref') o.makeRef = true;
    else if (k === '--ref-ms') o.refMs = Number(v());
    else if (k === '--child') o.child = JSON.parse(v());
    else if (k === '--weapon-side') o.weaponSide = true;
  }
  return o;
}

const med = (a) => { const b = a.filter((x) => x != null).sort((x, y) => x - y); return b.length ? b[b.length >> 1] : null; };
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

/** 全コアの CPU の使われ方 (0〜1) を測る入れ物 */
function cpuMeter() {
  const snap = () => os.cpus().map((c) => c.times);
  const a = snap();
  return () => {
    const b = snap();
    let busy = 0, all = 0;
    b.forEach((t, i) => {
      const d = (k) => t[k] - a[i][k];
      const tot = d('user') + d('nice') + d('sys') + d('idle') + d('irq');
      busy += tot - d('idle'); all += tot;
    });
    return all > 0 ? busy / all : null;
  };
}

/** ほかの node の数 (自分と子は除く) */
function otherNodes() {
  try {
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH', { encoding: 'utf8' });
      return out.split(/\r?\n/).filter((l) => l.includes('node.exe')).length - 1;
    }
    const out = execSync('pgrep -c node', { encoding: 'utf8' });
    return Number(out.trim()) - 1;
  } catch (e) { return null; }
}

// ---------------------------------------------------------------- 子プロセス: optimizeWeaponSide (武器 2 本の案の合わせ)
// docs/RECOMMEND_DESIGN.md 3.3 節・5.4 節: 1 回目の探索の上位 5 件の防具の組それぞれに、片手剣 95 本 + 所持アーティアから
// 武器と武器の珠を選び直す (相手 2 体・T を小さくする採点)。目標は防具の組 1 つあたり 0.1 秒以内 (Node)。
async function childWeaponSide(spec) {
  const { createSearch, optimizeWeaponSide } = await import(new URL('app/model/search.js', ROOT).href);
  const { loadRepoData, makeCases, searchDataOf } = await import(new URL('tests/search_cases.mjs', ROOT).href);
  const raw = await loadRepoData();
  const { cases, artian, targetOf } = makeCases(raw);
  const data = searchDataOf(raw);
  const base = spec.case === 'WSz' ? cases.B1z : cases.B1;
  const targets = [
    { weight: 0.5, group: 'a', target: targetOf('アルシュベルド', 'head') },
    { weight: 0.5, group: 'b', target: targetOf('ゴア・マガラ', 'head') },
  ];
  const s = createSearch({ ...base, targets, beam: [20, 60], budget: { work: 3000 } }, data);
  while (!s.step(1e9));
  const builds = s.result().results.slice(0, 5).map((x) => x.build);
  const H = { a: 30000, b: 20000 };
  const score = (pg) => -(H.a / pg.a + H.b / pg.b);
  const input = { ...base, targets, weapons: 'sns-all', extraWeapons: [artian] };
  const fixedOf = (b) => ({ armor: b.armor, charm: b.charm, limitBreak: b.limitBreak, decorations: b.decorations });
  const t0 = performance.now();
  optimizeWeaponSide(input, fixedOf(builds[0]), data, { score, N: 1, check: false });
  const firstMs = performance.now() - t0;
  const perSet = builds.map((b) => {
    const t = performance.now();
    const list = optimizeWeaponSide(input, fixedOf(b), data, { score, N: 1, check: false });
    return { ms: performance.now() - t, weapon: list[0] ? list[0].weapon : null };
  });
  const perSetChecked = builds.map((b) => {
    const t = performance.now();
    optimizeWeaponSide(input, fixedOf(b), data, { score, N: 1 });
    return performance.now() - t;
  });
  const out = {
    case: spec.case, sets: builds.length, firstMs, perSetMs: perSet.map((x) => x.ms), perSetCheckedMs: perSetChecked,
    weapons: perSet.map((x) => x.weapon),
  };
  process.stdout.write(`${JSON.stringify(out)}
`);
}

// ---------------------------------------------------------------- 子プロセス: 1 ケースを 1 回
async function child(spec) {
  if (spec.case === 'WS' || spec.case === 'WSz') { await childWeaponSide(spec); return; }
  const { createSearch } = await import(new URL('app/model/search.js', ROOT).href);
  const { loadRepoData, makeCases, searchDataOf } = await import(new URL('tests/search_cases.mjs', ROOT).href);
  const raw = await loadRepoData();
  const { cases } = makeCases(raw);
  const data = searchDataOf(raw);
  const input = { ...cases[spec.case], ...spec.override };
  const gc = globalThis.gc || (() => {});
  gc(); gc();
  const heap0 = process.memoryUsage().heapUsed;
  let peak = heap0;
  const t0 = performance.now();
  const s = createSearch(input, data);
  let partialMs = null;
  while (!s.step(spec.stepMs ?? 80)) {
    const h = process.memoryUsage().heapUsed;
    if (h > peak) peak = h;
    if (partialMs == null && s.progress().partialReady) partialMs = performance.now() - t0;
  }
  const doneMs = performance.now() - t0;
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  const r = s.result();
  const resultMs = performance.now() - t0;
  gc(); gc();
  const retained = process.memoryUsage().heapUsed - heap0;
  const out = {
    case: spec.case, mode: spec.mode, status: r.status, partialMs, doneMs, resultMs,
    prepareMs: r.stats.prepareMs, phases: (r.stats.phases || []).map((p) => `${p.name}@${Math.round(p.endMs)}=${p.best == null ? '-' : p.best.toFixed(2)}`).join(' '),
    top: r.results.map((x) => x.value), heapPeakMB: (peak - heap0) / 1e6, heapRetainedMB: retained / 1e6,
    relevantSkills: r.stats.relevantSkills, classes: r.stats.classes, charms: r.stats.charms, weapons: r.stats.weapons,
    nodes: r.stats.nodes, leaves: r.stats.leaves, boundCalls: r.stats.boundCalls, memoClears: r.stats.memoClears,
    sieve: r.stats.sieve || null,
    firstSolutionMs: r.stats.firstSolutionMs != null ? r.stats.firstSolutionMs + (r.stats.prepareMs || 0) : null,
    maxRelDiff: Math.max(0, ...r.results.map((x) => x.check.relDiff)), errors: r.results.reduce((t, x) => t + x.check.errors.length, 0),
    warnings: r.warnings.map((w) => w.code), infeasible: r.infeasible ? r.infeasible.missing.map((m) => `${m.name}${m.level}`) : null,
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function runChild(spec) {
  const res = spawnSync(process.execPath, ['--expose-gc', SELF, '--child', JSON.stringify(spec)], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: fileURLToPath(ROOT),
  });
  if (res.status !== 0) throw new Error(`子プロセスが失敗: ${spec.case}\n${res.stderr}`);
  const line = res.stdout.trim().split(/\r?\n/).pop();
  return JSON.parse(line);
}

async function hashes() {
  const { dataHashes } = await import(new URL('tests/search_cases.mjs', ROOT).href);
  return dataHashes();
}

function loadRef() {
  try { return JSON.parse(fs.readFileSync(REF_PATH, 'utf8')); } catch (e) { return null; }
}

/** 値の比較: 上位 1 件と既知の最良、各順位と基準の並び */
function compare(top, ref) {
  if (!ref || !top.length) return null;
  const best = ref.best ?? ref.top[0];
  const gaps = ref.top.map((v, i) => (top[i] == null ? 1 : (v - top[i]) / v));
  return {
    top1Gap: (best - top[0]) / best, maxRankGap: Math.max(...gaps), rankGaps: gaps.map((g) => Math.round(g * 1e5) / 1e5),
    ok: (best - top[0]) / best <= VALUE_TOL.top1 && Math.max(...gaps) <= VALUE_TOL.rank,
  };
}

async function main() {
  const o = args();
  if (o.child) { await child(o.child); return; }
  const H = await hashes();
  const ref = loadRef();
  const stale = ref && JSON.stringify(ref.dataHashes) !== JSON.stringify(H);

  if (o.makeRef) {
    const names = o.cases || ['B1', 'B2', 'B3', 'B5'];
    const out = { note: '', generatedAt: new Date().toISOString().slice(0, 10), dataHashes: H, method: '', cases: {} };
    for (const name of names) {
      const t = performance.now();
      const res = runChild({ case: name, mode: 'ref', override: { beam: [60, 200, 600], budget: { ms: o.refMs } } });
      const known = KNOWN_BEST[name];
      const top = res.top.map((v) => Math.round(v * 1e6) / 1e6);
      const best = known && known[0] > top[0] ? { best: known[0], bestSource: known[1] }
        : { best: top[0], bestSource: 'この基準の長時間の探索' };
      out.cases[name] = { ...best, top, runMs: Math.round(performance.now() - t) };
      console.log(name, res.top.map((v) => v.toFixed(3)).join(' '));
    }
    out.note = '装備探索の基準値 (docs/SEARCH_DESIGN.md 5.2 節)。top = 長時間の探索の上位 10 件 (類の組み合わせで数える)。'
      + 'best = 既知の最良の 1 位。どちらも最適の証明は無い。データが変わったらベンチは「基準が古い」と出す';
    out.method = `幅 [60, 200, 600] のビーム + B&B ${o.refMs / 1000} 秒 (tools/bench_search.mjs --make-ref)。best は既知の最良 (試作の値)`;
    fs.mkdirSync(new URL('tests/fixtures/', ROOT), { recursive: true });
    fs.writeFileSync(REF_PATH, `${JSON.stringify(out, null, 1)}\n`);
    console.log('基準を書いた', fileURLToPath(REF_PATH));
    return;
  }

  if (o.weaponSide) {
    console.log(JSON.stringify({ env: { node: process.version, cpus: os.cpus().length, otherNodesBefore: otherNodes() }, runs: o.runs }));
    for (const name of o.cases || ['WSz', 'WS']) {
      const meter = cpuMeter();
      const runs = [];
      for (let i = 0; i < o.runs; i++) runs.push(runChild({ case: name }));
      const per = runs.map((x) => med(x.perSetMs));
      const perChk = runs.map((x) => med(x.perSetCheckedMs));
      const line = {
        case: name, firstMs: Math.round(med(runs.map((x) => x.firstMs))), perSetMedianMs: r3(med(per)),
        perSetMaxMs: r3(Math.max(...runs.flatMap((x) => x.perSetMs))), perSetCheckedMedianMs: r3(med(perChk)),
        perSetCheckedMaxMs: r3(Math.max(...runs.flatMap((x) => x.perSetCheckedMs))), weapons: runs[0].weapons,
        target: { perSetMs: 100 }, meets: { perSet: Math.max(...runs.flatMap((x) => x.perSetMs)) <= 100 },
        cpuBusyDuring: r3(meter()), otherNodes: otherNodes(),
      };
      console.log(JSON.stringify(line));
    }
    return;
  }

  const names = o.cases || ['B1', 'B2', 'B3', 'B4', 'B4x', 'B5'];
  const modes = o.mode === 'both' ? ['time', 'work'] : [o.mode];
  const env = { node: process.version, cpus: os.cpus().length, otherNodesBefore: otherNodes(), refStale: !!stale };
  console.log(JSON.stringify({ env, budget: { ms: o.ms, work: o.work }, runs: o.runs }));
  if (stale) console.log('注意: データが基準 (tests/fixtures/search_ref.json) を作った時と違う。値の比較は参考 (--make-ref で作り直す)');
  const lines = [];
  for (const name of names) {
    const objectiveNone = name === 'B4' || name === 'B4x';
    for (const mode of objectiveNone ? ['time'] : modes) {
      const override = mode === 'time' ? (objectiveNone ? {} : { budget: { ms: o.ms } }) : { budget: { work: o.work } };
      const meter = cpuMeter();
      const runs = [];
      for (let i = 0; i < o.runs; i++) runs.push(runChild({ case: name, mode, override }));
      const load = meter();
      const r0 = runs[0];
      const sig = (x) => JSON.stringify(x.top.map((v) => (v == null ? null : v.toFixed(9))));
      const same = runs.every((x) => sig(x) === sig(r0));
      const line = {
        case: name, mode, status: r0.status,
        partialMs: Math.round(med(runs.map((x) => x.partialMs)) ?? NaN) || null, doneMs: Math.round(med(runs.map((x) => x.doneMs))),
        resultMs: Math.round(med(runs.map((x) => x.resultMs))), runsDoneMs: runs.map((x) => Math.round(x.doneMs)),
        prepareMs: Math.round(med(runs.map((x) => x.prepareMs))), heapPeakMB: r3(med(runs.map((x) => x.heapPeakMB))),
        heapRetainedMB: r3(med(runs.map((x) => x.heapRetainedMB))), sameAcrossRuns: same,
        top: r0.top.map(r3), phases: r0.phases, relevantSkills: r0.relevantSkills, classes: r0.classes, charms: r0.charms,
        weapons: r0.weapons, sieve: r0.sieve, nodes: r0.nodes, leaves: r0.leaves, boundCalls: r0.boundCalls, memoClears: r0.memoClears,
        maxRelDiff: r0.maxRelDiff, errors: r0.errors, warnings: r0.warnings,
        firstSolutionMs: r0.firstSolutionMs != null ? r3(med(runs.map((x) => x.firstSolutionMs))) : null,
        infeasible: r0.infeasible, cpuBusyDuring: load == null ? null : r3(load), otherNodes: otherNodes(),
      };
      if (!objectiveNone && ref && ref.cases[name]) line.vsRef = compare(r0.top, ref.cases[name]);
      const tg = TARGETS[name.replace(/z$/, '')];
      if (tg && mode === 'time') {
        line.target = tg;
        line.meets = {
          ...(tg.partialMs ? { partial: line.partialMs != null && line.partialMs <= tg.partialMs } : {}),
          ...(tg.doneMs ? { done: line.doneMs <= tg.doneMs } : {}),
          ...(tg.firstMs ? { first: line.firstSolutionMs != null && line.firstSolutionMs <= tg.firstMs } : {}),
          ...(tg.heapMB ? { heap: line.heapPeakMB <= tg.heapMB } : {}),
        };
      }
      lines.push(line);
      console.log(JSON.stringify(line));
    }
  }
  if (o.out) fs.writeFileSync(o.out, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
