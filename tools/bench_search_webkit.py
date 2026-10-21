"""装備探索のベンチ (WebKit の Worker)。docs/SEARCH_DESIGN.md 5.2 節。手で回す (テストには入れない)。

Playwright の WebKit (iPhone の Safari と同じエンジン。Windows 版) で app/search_worker.js を動かし、
データを読み終えるまで (ready)・途中の結果 (partial)・終わり (done) の時刻を測る。中止の効き (cancel を送ってから done までの時間) も測れる。

使い方:
  PYTHONIOENCODING=utf-8 python tools/bench_search_webkit.py [--cases B1,B5,S1] [--runs 3] [--ms 6000]
                                                             [--browser webkit|chromium] [--cancel-at ms]

- リポを 127.0.0.1 の空いているポートで配信し、ベンチのページ (/__bench__/index.html) は このスクリプトの中の HTML を返す。
- ページは data/*.json を読んで tests/search_cases.mjs の makeCases で B1〜B5 の入力を作り、Worker に start を送る。
  S1〜S3 (相手に合わせて探す。docs/RECOMMEND_DESIGN.md 6.4 節) は makePlanCases の Job (kind 'plan') を送る (--ms は Job 全体の予算)。
- 1 回ごとに新しいページ (新しい Worker) にする。メモリは WebKit では測れない (performance.memory が無い)。
"""
import argparse
import http.server
import json
import posixpath
import statistics
import sys
import threading
import urllib.parse
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
MIME = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8'}

BENCH_HTML = """<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>装備探索のベンチ</title></head>
<body><pre id="log"></pre>
<script type="module">
import { makeCases, makePlanCases, CASE_DATA_FILES } from '/tests/search_cases.mjs';
const q = new URLSearchParams(location.search);
const name = q.get('case') || 'B1';
const budget = JSON.parse(q.get('budget') || '{"ms":6000}');
const cancelAt = Number(q.get('cancelAt') || 0);
const log = (s) => { document.getElementById('log').textContent += s + '\\n'; };
try {
  const entries = await Promise.all(Object.entries(CASE_DATA_FILES).map(async ([k, f]) => [k, await (await fetch('/data/' + f)).json()]));
  const raw = Object.fromEntries(entries);
  let job;
  if (/^S\\d/.test(name)) {
    // 相手に合わせて探す: 画面と同じ buildPlan → planToJob の Job。予算 (計算した時間) は Job 全体
    const { jobs } = await makePlanCases(raw, { budgetMs: budget.ms });
    job = jobs[name];
  } else {
    const { cases } = makeCases(raw);
    job = { kind: 'search', input: { ...cases[name], budget } };
  }
  const t0 = performance.now();
  const w = new Worker('/app/search_worker.js', { type: 'module' });
  const events = [];
  let tStart = null;
  let partial = null;
  w.onerror = (e) => { window.__result = { type: 'error', message: String(e.message || e) }; };
  w.onmessage = (e) => {
    const m = e.data;
    const at = tStart == null ? null : performance.now() - tStart;
    events.push({ type: m.type, at, phase: m.phase || null, best: m.best && m.best.length ? m.best[0] : null });
    if (m.type === 'ready') {
      window.__readyMs = performance.now() - t0;
      tStart = performance.now();
      w.postMessage({ type: 'start', id: 'bench', job });
      if (cancelAt) setTimeout(() => { window.__cancelSentAt = performance.now() - tStart; w.postMessage({ type: 'cancel', id: 'bench' }); }, cancelAt);
    } else if (m.type === 'partial') {
      partial = { at, top: m.result.results.map((x) => (x.score ? x.score.value : x.value)) };
    } else if (m.type === 'done' || m.type === 'error') {
      const r = m.result || {};
      window.__result = {
        type: m.type, message: m.message || null, readyMs: window.__readyMs, doneMs: at, partialMs: partial ? partial.at : null,
        cancelSentAt: window.__cancelSentAt ?? null, status: r.status || null,
        top: (r.results || []).map((x) => (x.score ? x.score.value : x.value)), partialTop: partial ? partial.top : null,
        twoWeapons: (r.results || []).filter((x) => x.twoWeapons).length,
        stats: r.stats ? { prepareMs: r.stats.prepareMs, activeMs: r.stats.activeMs, phases: r.stats.phases, relevantSkills: r.stats.relevantSkills,
          nodes: r.stats.nodes, leaves: r.stats.leaves, weapons: r.stats.weapons, mergeMs: r.stats.mergeMs, twoWeaponsMs: r.stats.twoWeaponsMs,
          runs: r.stats.runs ? r.stats.runs.map((x) => ({ key: x.key, status: x.status, ms: Math.round(x.ms) })) : null } : null,
        progress: events.filter((x) => x.type === 'progress').map((x) => [Math.round(x.at), x.phase, x.best == null ? null : Math.round(x.best * 1000) / 1000]),
      };
      log(JSON.stringify(window.__result));
    }
  };
} catch (e) {
  window.__result = { type: 'error', message: String((e && e.stack) || e) };
}
</script></body></html>
"""


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == '/__bench__/index.html':
            body = BENCH_HTML.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', MIME['.html'])
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        rel = posixpath.normpath(path).lstrip('/')
        f = (ROOT / rel).resolve()
        if (ROOT in f.parents) and f.is_file() and rel.split('/')[0] in ('app', 'data', 'tests'):
            data = f.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', MIME.get(f.suffix, 'application/octet-stream'))
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)
            return
        self.send_response(404)
        self.end_headers()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cases', default='B1')
    ap.add_argument('--runs', type=int, default=3)
    ap.add_argument('--ms', type=int, default=6000, help='時間の予算 (画面の既定は 6 秒)')
    ap.add_argument('--browser', default='webkit')
    ap.add_argument('--cancel-at', type=int, default=0, help='始めてからこの ms で cancel を送る (中止の効きを測る)')
    a = ap.parse_args()
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    out = []
    with sync_playwright() as p:
        browser = getattr(p, a.browser).launch()
        for name in a.cases.split(','):
            runs = []
            for i in range(a.runs):
                page = browser.new_page()
                errs = []
                page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
                qs = urllib.parse.urlencode({'case': name, 'budget': json.dumps({'ms': a.ms}), 'cancelAt': a.cancel_at})
                page.goto(f'http://127.0.0.1:{port}/__bench__/index.html?{qs}')
                page.wait_for_function('window.__result', timeout=600000)
                res = page.evaluate('window.__result')
                res['consoleErrors'] = errs
                runs.append(res)
                page.close()
                print(json.dumps({'case': name, 'run': i + 1, **{k: res.get(k) for k in ('type', 'status', 'readyMs', 'partialMs', 'doneMs', 'cancelSentAt')},
                                  'top1': res['top'][0] if res.get('top') else None, 'message': res.get('message')}, ensure_ascii=False))
            ok = [r for r in runs if r.get('type') == 'done']
            med = lambda k: round(statistics.median([r[k] for r in ok if r.get(k) is not None])) if any(r.get(k) is not None for r in ok) else None
            line = {
                'case': name, 'browser': a.browser, 'budgetMs': a.ms, 'runs': len(runs), 'ok': len(ok),
                'readyMs': med('readyMs'), 'partialMs': med('partialMs'), 'doneMs': med('doneMs'),
                'runsDoneMs': [round(r['doneMs']) for r in ok if r.get('doneMs') is not None],
                'status': ok[0]['status'] if ok else None, 'top': [round(v, 3) for v in ok[0]['top']] if ok else None,
                'sameTop1': len({round(r['top'][0], 6) for r in ok if r.get('top')}) <= 1,
                'phases': ' '.join(f"{x['name']}@{round(x['endMs'])}" for x in ((ok[0]['stats'] or {}).get('phases') or [])) if ok else None,
                'planRuns': (ok[0]['stats'] or {}).get('runs') if ok else None,
                'twoWeapons': ok[0].get('twoWeapons') if ok else None,
                'cancel': ({'sentAt': ok[0].get('cancelSentAt'), 'doneAt': ok[0].get('doneMs')} if a.cancel_at and ok else None),
                'consoleErrors': sum(len(r['consoleErrors']) for r in runs),
            }
            out.append(line)
            print(json.dumps(line, ensure_ascii=False))
        browser.close()
    srv.shutdown()
    return 0 if all(x['ok'] == x['runs'] for x in out) else 1


if __name__ == '__main__':
    sys.exit(main())
