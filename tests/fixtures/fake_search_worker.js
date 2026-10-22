// 探すタブのスモークテスト用の「作り物の Worker」(本番の経路では使わない。アプリはこのファイルを読まない)。
// tests/smoke_ui.py が init script で window.__mhwSearchWorker = {url: './tests/fixtures/fake_search_worker.js?step=120'} を置くと、
// app/ui/tabs/search_client.js が本物の app/search_worker.js の代わりにこれを Worker として作る。
// Worker が無い端末のまね (window.Worker を消す) では、同じファイルを module として読み、createEngine で画面のスレッドで回す。
//
// メッセージは本物と同じ (docs/SEARCH_DESIGN.md 3.5 節・docs/RECOMMEND_DESIGN.md 5.5 節):
//   受ける: start {id, job, input?} / cancel {id} / extend {id, budget}
//   返す:   ready / progress {id, phase, elapsedMs, best} / partial {id, result} / done {id, result} / error {id, message}
// 結果は決まった作り方の候補を、本物の計算モデル (app/model/) で計算した値で並べる (画面の「装備に入れる」のあと、
// 火力タブの値と同じになるかを確かめられる)。候補は値の順に並べ、次のように出し分ける:
//   途中の結果 (partial) = 3 番目から / 終わり (done) = 2 番目から / 続けて探す (extend) の後 = 1 番目から
//   → 段が進むたびに 1 位が良くなる (「もっと良い組が見つかりました」を確かめられる)。
//
// url の ? の後ろで動きを変える:
//   step=ms        段階を進める間隔 (既定 120。やめる・裏に回すの確認は大きくする)
//   fail=start     start を受けたら error を返す
//   fail=crash     ready を返したあと、例外で落ちる (Worker の error イベント)
//   result=infeasible  必須を満たせない (status: 'infeasible')
//   result=empty   候補が 0 件
//   complete=1     終わりの結果を「B&B を最後まで回り終えた」(extendable: false。画面は「続けて探す」を出さない) にする
//   warn=1         結果に警告 (evaluator-mismatch) を 1 つ付ける
// import は相対パスだけ (Worker に import map が効かない)。
import { computeBuild, indexEquipData, ARMOR_PARTS } from '../../app/model/build.js';
import { comboExpected } from '../../app/model/damage.js';
import { resolveWeaponRef, damageWeapon, autoSharpness } from '../../app/model/weapon.js';

const FILES = {
  skills: 'skills.json', armor: 'armor.json', weapons: 'weapons_sns.json', decorations: 'decorations.json',
  bonuses: 'bonuses.json', charmsFixed: 'charms_fixed.json', charms: 'charms.json', myWeapons: 'my_weapons.json',
  skillEffects: 'skill_effects.json', motions: 'motions_sns.json',
};
const PHASES = ['prepare', 'beam1', 'beam2', 'polish1', 'dfs', 'polish2'];
/** 作る候補の数 */
const N_CANDIDATES = 14;

/** url の ? の後ろ → 動きの設定 */
export function configFromUrl(href) {
  let q;
  try {
    q = new URL(href).searchParams;
  } catch {
    q = new URLSearchParams('');
  }
  const step = Number(q.get('step'));
  return {
    step: Number.isFinite(step) && step >= 0 ? Math.min(step, 10000) : 120,
    fail: q.get('fail') || '', result: q.get('result') || 'ok', warn: q.get('warn') === '1', complete: q.get('complete') === '1',
  };
}

let dataPromise = null;
/** data/*.json を読む (この Worker のファイルからの相対) */
function loadData() {
  if (!dataPromise) {
    dataPromise = Promise.all(Object.entries(FILES).map(async ([key, file]) => {
      const res = await fetch(new URL(`../../data/${file}`, import.meta.url));
      if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
      return [key, await res.json()];
    })).then((pairs) => Object.fromEntries(pairs)).catch((e) => {
      dataPromise = null;
      throw e;
    });
  }
  return dataPromise;
}

const isObj = (x) => x != null && typeof x === 'object' && !Array.isArray(x);

/** 割合を足して 1 に */
function normTargets(targets) {
  const list = (Array.isArray(targets) ? targets : []).filter((t) => t && t.target && t.target.hitzone);
  const sum = list.reduce((a, t) => a + (Number(t.weight) > 0 ? Number(t.weight) : 0), 0);
  return list.map((t) => ({ ...t, weight: sum > 0 ? (Number(t.weight) > 0 ? Number(t.weight) : 0) / sum : 1 / list.length }))
    .filter((t) => t.weight > 0);
}

/**
 * 候補を作って計算する (決まった作り方。乱数は使わない)。
 * @returns {{sorted: Array, baseline: number|null}}
 */
export function computeCandidates(input, raw) {
  const extraWeapons = Array.isArray(input.extraWeapons) ? input.extraWeapons : [];
  const charmsIn = isObj(input.charms) ? input.charms : {};
  const extraCharms = Array.isArray(charmsIn.extra) ? charmsIn.extra : [];
  const idx = indexEquipData({
    skills: raw.skills, decorations: raw.decorations, bonuses: raw.bonuses, armor: raw.armor, weapons: raw.weapons,
    charmsFixed: raw.charmsFixed, myWeapons: [...raw.myWeapons.weapons, ...extraWeapons], charms: [...raw.charms.charms, ...extraCharms],
  });
  const targets = normTargets(input.targets);
  const valueOf = (build) => {
    const w = resolveWeaponRef(build.weapon, idx);
    if (!w) return null;
    const br = computeBuild(build, idx);
    const sharpness = input.sharpness || autoSharpness(w, idx, br.skillLevels).color;
    let total = 0;
    for (const t of targets) {
      total += t.weight * comboExpected({
        weapon: damageWeapon(w), sharpness, skills: br.skills, uptimes: input.uptimes || {}, effects: raw.skillEffects,
        motions: raw.motions, combo: input.combo, target: t.target, monsterStatus: input.monsterStatus, buffs: input.buffs,
      }).total;
    }
    return { value: total, br };
  };
  // 武器: 決まっていればその先頭 3 本、「片手剣すべて」なら攻撃の高い 3 本
  let weaponRefs = Array.isArray(input.weapons) ? input.weapons.slice(0, 3) : [];
  if (!weaponRefs.length) {
    weaponRefs = raw.weapons.weapons.slice().sort((a, b) => b.attack - a.attack || a.id - b.id).slice(0, 3).map((w) => w.id);
  }
  const exclude = new Set(Array.isArray(input.armorExclude) ? input.armorExclude : []);
  const byPart = {};
  for (const p of ARMOR_PARTS) {
    byPart[p] = raw.armor.armor.filter((a) => a.part === p && (a.rarity ?? 0) >= 7 && !exclude.has(a.id)).sort((a, b) => a.id - b.id);
  }
  const fixedExclude = new Set(Array.isArray(charmsIn.fixedExclude) ? charmsIn.fixedExclude : []);
  const charmRefs = [
    ...(charmsIn.owned !== false ? raw.charms.charms.map((c) => c.id) : []),
    ...extraCharms.map((c) => c.id),
    ...(charmsIn.fixed !== false ? raw.charmsFixed.charms.filter((c) => !fixedExclude.has(c.id)).map((c) => c.id) : []),
  ];
  const gammaHead = byPart.head.find((a) => String(a.name).includes('γ'));
  const out = [];
  const seen = new Set();
  for (let i = 0; i < N_CANDIDATES; i++) {
    const armor = {};
    ARMOR_PARTS.forEach((p, pi) => {
      const list = byPart[p];
      armor[p] = list.length ? list[(i * 5 + pi * 3) % list.length].id : null;
    });
    if (i === 0 && gammaHead) armor.head = gammaHead.id; // 歴戦王の素材が要る防具の印を確かめるため
    const build = {
      weapon: weaponRefs[i % weaponRefs.length], armor, limitBreak: { ...(input.limitBreak || {}) },
      charm: charmRefs.length ? charmRefs[(i * 7) % charmRefs.length] : null, decorations: {},
    };
    const key = JSON.stringify(build);
    if (seen.has(key)) continue;
    seen.add(key);
    let v = null;
    try {
      v = valueOf(build);
    } catch { /* 計算できない組 (条件の組み合わせが多すぎるなど) は出さない */ }
    if (!v || !(v.value > 0)) continue;
    const sum = (k) => ({ 1: v.br.slotSummary[k].freeBySize[1] || 0, 2: v.br.slotSummary[k].freeBySize[2] || 0, 3: v.br.slotSummary[k].freeBySize[3] || 0 });
    out.push({
      value: v.value, build,
      skills: v.br.skills.filter((s) => s.level > 0).map((s) => ({ skillId: s.skillId, name: s.name, level: s.level })),
      freeSlots: { weapon: sum('weapon'), armor: sum('armor') },
    });
  }
  out.sort((a, b) => b.value - a.value);
  const cur = isObj(input.current) && input.current.weapon != null ? valueOf(input.current) : null;
  return { sorted: out, baseline: cur ? cur.value : null };
}

/**
 * 作り物の探索 (Worker でも画面のスレッドでも同じもの)。
 * @param post (msg) => void
 * @param opts {url (設定を読む url), inline (画面のスレッドで回すとき true。落ちるまねは error を返すだけにする), loadData}
 * @returns {{handle(msg), dispose()}}
 */
export function createEngine(post, opts = {}) {
  const config = { ...configFromUrl(opts.url || ''), ...(opts.config || {}) };
  const load = opts.loadData || loadData;
  let cur = null;
  let readySent = false;
  let disposed = false;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  const clear = (c) => {
    if (c && c.timer) clearTimeout(c.timer);
    if (c) c.timer = null;
  };
  const result = (c, status, from) => {
    const list = c.cands.slice(from, from + c.K);
    return {
      status,
      results: list.map((x, i) => ({
        rank: i + 1, value: x.value, exact: true, weapon: x.build.weapon, build: x.build, alternatives: {},
        skills: x.skills, freeSlots: x.freeSlots, check: { value: x.value, relDiff: 0, errors: [] },
      })),
      infeasible: null,
      warnings: config.warn ? [{ code: 'evaluator-mismatch', message: '(作り物) 計算し直した値と少し違う組がありました。並びは計算し直した値にしています。' }] : [],
      stats: { elapsedMs: now() - c.t0, phases: c.phases.slice(), fake: true, extended: c.extended },
      quality: 'heuristic', baseline: c.baseline != null ? { value: c.baseline } : null,
      ...(config.complete && status === 'done' ? { extendable: false } : {}),
    };
  };
  const progress = (c, phase) => {
    c.phases.push({ name: phase, endMs: now() - c.t0 });
    post({ type: 'progress', id: c.id, phase, elapsedMs: now() - c.t0, best: c.cands.slice(c.bestFrom, c.bestFrom + 3).map((x) => x.value) });
  };
  /** 段階を step ごとに進める。steps = [[phase, fn?], ...] */
  const run = (c, steps, done) => {
    let i = 0;
    const tick = () => {
      if (disposed || cur !== c || c.cancelled) return;
      if (i >= steps.length) {
        done();
        return;
      }
      const [phase, fn] = steps[i++];
      progress(c, phase);
      if (fn) fn();
      c.timer = setTimeout(tick, config.step);
    };
    tick();
  };

  return {
    async handle(msg) {
      if (disposed || !isObj(msg)) return;
      if (msg.type === 'start') {
        clear(cur);
        const job = isObj(msg.job) ? msg.job : { kind: 'search', input: msg.input };
        const input = job.kind === 'plan' ? (job.runs && job.runs[0] && job.runs[0].input) : job.input;
        const c = {
          id: msg.id, t0: now(), timer: null, cancelled: false, cands: [], K: 10, bestFrom: 2, partialSent: false,
          finished: false, extended: 0, phases: [], baseline: null,
        };
        cur = c;
        if (config.fail === 'start') {
          post({ type: 'error', id: c.id, message: '(作り物) 探す処理でエラーが起きました。' });
          return;
        }
        let raw;
        try {
          raw = await load();
        } catch (e) {
          post({ type: 'error', id: c.id, message: `データを読み込めませんでした (${e.message || e})` });
          return;
        }
        if (cur !== c || disposed) return;
        if (!readySent) {
          readySent = true;
          post({ type: 'ready' });
        }
        if (config.fail === 'crash') {
          if (opts.inline) post({ type: 'error', id: c.id, message: '(作り物) 探す処理が落ちました。' });
          else setTimeout(() => { throw new Error('(作り物) 探す処理が落ちました'); }, 0);
          return;
        }
        if (!isObj(input)) {
          post({ type: 'error', id: c.id, message: '探す条件がありません' });
          return;
        }
        try {
          c.K = Math.max(1, Math.min(50, Number(input.K || job.K) || 10));
          if (config.result !== 'empty' && config.result !== 'infeasible') {
            const r = computeCandidates(input, raw);
            c.cands = r.sorted;
            c.baseline = r.baseline;
          }
        } catch (e) {
          post({ type: 'error', id: c.id, message: `(作り物) 計算できませんでした: ${e.message || e}` });
          return;
        }
        if (config.result === 'infeasible') {
          run(c, [['prepare']], () => {
            c.finished = true;
            const req = Array.isArray(input.required) ? input.required : [];
            const names = new Map(raw.skills.skills.map((s) => [s.id, s.name]));
            post({
              type: 'done', id: c.id,
              result: {
                ...result(c, 'infeasible', 0), results: [],
                infeasible: {
                  missing: (req.length ? req : [{ skillId: null, level: null }]).map((q) => ({
                    skillId: q.skillId, name: names.get(q.skillId) || '必須のスキル', level: q.level, reason: '珠と防具で足りません',
                  })),
                },
              },
            });
          });
          return;
        }
        run(c, [
          ['prepare'], ['beam1'], ['beam2'],
          ['polish1', () => {
            c.partialSent = true;
            post({ type: 'partial', id: c.id, result: result(c, 'partial', 2) });
          }],
          ['dfs', () => { c.bestFrom = 1; }], ['polish2'],
        ], () => {
          c.finished = true;
          post({ type: 'done', id: c.id, result: result(c, 'done', 1) });
        });
      } else if (msg.type === 'cancel') {
        const c = cur;
        if (!c || c.id !== msg.id || c.finished || c.cancelled) return;
        c.cancelled = true;
        clear(c);
        c.finished = true;
        post({ type: 'done', id: c.id, result: c.partialSent ? result(c, 'cancelled', 2) : { ...result(c, 'cancelled', 0), results: [] } });
      } else if (msg.type === 'extend') {
        const c = cur;
        if (!c || c.id !== msg.id || !c.finished) {
          post({ type: 'error', id: msg.id ?? null, message: '続けて探せません' });
          return;
        }
        c.finished = false;
        c.cancelled = false;
        c.extended += 1;
        run(c, [['dfs', () => { c.bestFrom = 0; }], ['polish2']], () => {
          c.finished = true;
          post({ type: 'done', id: c.id, result: result(c, 'done', 0) });
        });
      }
    },
    dispose() {
      disposed = true;
      clear(cur);
      cur = null;
    },
  };
}

// Worker として読まれたときだけ、メッセージを受ける (画面のスレッドで module として読まれたときは何もしない)
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
  const engine = createEngine((m) => self.postMessage(m), { url: self.location.href });
  self.addEventListener('message', (e) => {
    engine.handle(e.data || {}).catch((err) => self.postMessage({ type: 'error', id: (e.data && e.data.id) ?? null, message: String(err && err.message ? err.message : err) }));
  });
}
