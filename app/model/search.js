// 装備探索の入口 (段階 2): createSearch と定数。API は docs/SEARCH_DESIGN.md 3 章、使い方は docs/MODEL_API.md の「search.js」節。
// DOM も Worker も知らない純粋な JS (node --test で動く)。import は相対パスだけ (Worker から読むため)。
// 中身は app/model/search/ (evaluator.js = 速い評価器・problem.js = 下ごしらえ・solver.js = ビームと分枝限定・
// realize.js = 結果の組み立てと計算し直し) に分けてある。
import { indexEquipData, computeBuild, ARMOR_PARTS } from './build.js';
import { resolveConditions, resolveSkills, enumeratePatterns, conditionGroupDefs, SHARPNESS_ORDER } from './damage.js';
import { prepare } from './search/problem.js';
import { BnbSolver } from './search/solver.js';
import { makeEvaluator } from './search/evaluator.js';
import { realizeEntry, checkBuild, summarize, placeDecos } from './search/realize.js';

/** 探索の段階 (progress().phase)。prepare → beam1 → beam2 → polish1 (途中の結果) → dfs → polish2 → done */
export const PHASES = Object.freeze(['prepare', 'beam1', 'beam2', 'polish1', 'dfs', 'polish2', 'done']);

/** 画面で使う時間の予算の既定 (ms) */
export const DEFAULT_BUDGET_MS = 6000;

/** 計算し直しで、速い評価器の値とずれたとみなす相対差 */
export const MISMATCH_REL = 1e-9;

/** 上界の前提が崩れる入力の警告 (docs/SEARCH_DESIGN.md 4 章の 6)。これがあると mode 'exact' でも quality は 'heuristic' */
export const PREMISE_WARNINGS = Object.freeze(['exclusive-over-100', 'blunt-handicraft', 'non-monotone']);

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const isObj = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const listOf = (x, key) => (x == null ? [] : Array.isArray(x) ? x : Array.isArray(x[key]) ? x[key] : []);

/** data (data.js の core と同じ形でも、{index, effects, motions} でもよい) から索引と効果を取り出す */
function coreOf(data) {
  if (!data) throw new Error('探索のデータがありません');
  const index = data.index && data.index.__equipIndex ? data.index : indexEquipData({
    skills: data.skills, decorations: data.decorations, bonuses: data.bonuses, armor: data.armor, weapons: data.weapons,
    myWeapons: data.myWeapons, charms: data.charms, charmsFixed: data.charmsFixed,
  });
  const effects = data.effects || data.skillEffects;
  if (!effects || !data.motions) throw new Error('スキルの効果か技のモーション値のデータがありません');
  return { index, effects, motions: data.motions };
}

/** targets の重みを足して 1 にそろえる (target の無いもの・重みが負のものは捨てる。全部 0 なら等分。power_calc.js の normalizeMix と同じ) */
function normalizeTargets(targets) {
  const list = (Array.isArray(targets) ? targets : []).filter((t) => t && t.target && t.target.hitzone);
  const w = list.map((t) => { const n = Number(t.weight); return Number.isFinite(n) && n > 0 ? n : 0; });
  const sum = w.reduce((a, b) => a + b, 0);
  return list.map((t, i) => ({ ...t, weight: sum > 0 ? w[i] / sum : 1 / list.length })).filter((t) => t.weight > 0);
}

/** 入力を確かめてそろえる。続けられない問題 (武器・相手・コンボが無い) は例外、ほかは warnings に入れて続ける */
function normalizeInput(input, core, warnings) {
  const inp = isObj(input) ? input : {};
  const warn = (code, message, extra = {}) => warnings.push({ code, message, ...extra });
  const base = core.index;
  // 端末の所持アーティア・護石を足した索引 (computeBuild でも引けるように)
  const extraWeapons = listOf(inp.extraWeapons, 'weapons').filter((w) => w && w.id != null);
  const charmsOpt = isObj(inp.charms) ? inp.charms : {};
  const extraCharms = listOf(charmsOpt.extra, 'charms').filter((c) => c && c.id != null);
  const idx = extraWeapons.length || extraCharms.length ? {
    ...base,
    myWeapons: new Map([...base.myWeapons, ...extraWeapons.map((w) => [w.id, w])]),
    charms: new Map([...base.charms, ...extraCharms.map((c) => [c.id, c])]),
  } : base;

  const objective = inp.objective === 'none' ? 'none' : 'damage';
  const mode = inp.mode === 'exact' ? 'exact' : 'fast';
  // 武器
  let weapons = inp.weapons;
  if (weapons === 'sns-all') {
    weapons = [...base.weapons.keys(), ...base.myWeapons.keys(), ...extraWeapons.map((w) => w.id)];
  } else if (!Array.isArray(weapons)) weapons = weapons == null ? [] : [weapons];
  weapons = [...new Set(weapons.filter((x) => x != null))];
  if (!weapons.length) throw new Error('探す武器が決まっていません');
  // 相手・コンボ
  const targets = normalizeTargets(inp.targets);
  if (objective === 'damage' && !targets.length) throw new Error('相手 (肉質) が決まっていません');
  const combo = inp.combo || null;
  if (objective === 'damage' && !(Array.isArray(combo) ? combo.length : combo && Array.isArray(combo.steps))) {
    throw new Error('コンボが決まっていません');
  }
  // 必須スキル (知らない id は外す。Lv は最大で切る。同じスキルは高い方)
  const required = [];
  for (const q of Array.isArray(inp.required) ? inp.required : []) {
    if (!q) continue;
    const id = Number(q.skillId);
    const s = idx.skills.get(id);
    if (!s) { warn('unknown-skill', `必須スキル (id ${q.skillId}) が見つからないので外しました`, { skillId: q.skillId }); continue; }
    let lv = Math.floor(Number(q.level) || 0);
    if (lv <= 0) continue;
    if (s.maxLevel != null && lv > s.maxLevel) {
      warn('required-over-max', `${s.name} の最大は Lv${s.maxLevel} なので、Lv${s.maxLevel} で探しました`, { skillId: id });
      lv = s.maxLevel;
    }
    const old = required.find((x) => x.skillId === id);
    if (old) old.level = Math.max(old.level, lv); else required.push({ skillId: id, level: lv });
  }
  // 護石: 所持 (charms.json) / 端末で足した分 / 生産護石 (使わないものを除く)
  const fixedExclude = new Set(listOf(charmsOpt.fixedExclude).map(Number));
  const charmRefs = [];
  const extraIds = new Set(extraCharms.map((c) => c.id));
  if (charmsOpt.owned !== false) for (const id of base.charms.keys()) if (!extraIds.has(id)) charmRefs.push(id);
  for (const c of extraCharms) charmRefs.push(c.id);
  if (charmsOpt.fixed !== false) for (const id of base.charmsFixed.keys()) if (!fixedExclude.has(id)) charmRefs.push(id);
  // 限界突破 (true/false か部位ごと)
  const lb = inp.limitBreak;
  const limitBreak = Object.fromEntries(ARMOR_PARTS.map((p) => [p, isObj(lb) ? !!lb[p] : !!lb]));
  // 斬れ味 (null = 自動)
  let sharpness = inp.sharpness || null;
  if (sharpness && !SHARPNESS_ORDER.includes(sharpness)) {
    warn('unknown-sharpness', `斬れ味の色 (${sharpness}) が分からないので、自動で探しました`);
    sharpness = null;
  }
  // 珠の所持数 (null = 全部いくつでも持っている)
  const deco = isObj(inp.decorations) ? inp.decorations : {};
  const decoCount = isObj(deco.owned) ? deco.owned : null;
  // 予算
  const b = isObj(inp.budget) ? inp.budget : {};
  const budget = {};
  for (const k of ['ms', 'activeMs', 'work']) if (Number.isFinite(Number(b[k])) && b[k] != null) budget[k] = Math.max(0, Number(b[k]));
  if (!Object.keys(budget).length && mode === 'fast' && objective === 'damage') budget.ms = DEFAULT_BUDGET_MS;
  const K = Math.max(1, Math.min(100, Math.floor(Number(inp.K) || 10)));
  return {
    idx, objective, mode, weapons, targets, combo, required, charmRefs, limitBreak, sharpness, decoCount, budget, K,
    uptimes: isObj(inp.uptimes) ? inp.uptimes : {},
    monsterStatus: Array.isArray(inp.monsterStatus) ? inp.monsterStatus : undefined,
    buffs: isObj(inp.buffs) ? inp.buffs : {},
    armorExclude: listOf(inp.armorExclude).map(Number),
    stopAfter: inp.stopAfter === 'partial' ? 'partial' : null,
    current: isObj(inp.current) ? inp.current : null,
    gamma: gammaOf(inp.gamma),
    // テスト用: ビームの幅 / 優越の除去をしない (総当たりと同じ数え方にする) / 武器も探すときの 2 段のふるい (false でしない)
    beam: Array.isArray(inp.beam) ? inp.beam : undefined,
    dominance: inp.dominance !== false,
    sieve: inp.sieve === false ? false : (isObj(inp.sieve) ? inp.sieve : undefined),
  };
}

/** input.gamma (gammaIndexOf の結果) → {armor: Map<id, {monsterId, name}>, charms: Map<id, {...}>} か null */
function gammaOf(g) {
  if (!isObj(g)) return null;
  const toMap = (o) => new Map(Object.entries(isObj(o) ? o : {}).filter(([, v]) => isObj(v)).map(([k, v]) => [Number(k), v]));
  const armor = toMap(g.armor);
  const charms = toMap(g.charmsFixed);
  return armor.size || charms.size ? { armor, charms } : null;
}

/** 装備の γ 防具・狩猟証γ の護石 → [{part, armorId | charmId, monsterId, name}] (recommend.js の印と同じ形) */
function gammaMarks(build, gamma) {
  if (!gamma || !build) return [];
  const out = [];
  for (const part of ARMOR_PARTS) {
    const id = build.armor ? build.armor[part] : null;
    const g = id != null ? gamma.armor.get(Number(id)) : null;
    if (g) out.push({ part, armorId: id, monsterId: g.monsterId, name: g.name });
  }
  const c = build.charm;
  const gc = typeof c === 'number' ? gamma.charms.get(c) : null;
  if (gc) out.push({ part: 'charm', charmId: c, monsterId: gc.monsterId, name: gc.name });
  return out;
}

/** 発動率の注意: 仮置きの値で探した条件・同時に起きない条件の合計が 100% 超え */
function uptimeWarnings(P, n, core, warnings) {
  const effMap = core.effects.effects || {};
  const cond = P.ids.filter((id) => effMap[String(id)]?.conditional).map((id) => ({ skillId: id, level: 1 }));
  if (!cond.length) return;
  const groupSrc = (core.effects.rules && core.effects.rules.conditionGroups) || [];
  const res = resolveConditions(resolveSkills(cond, core.effects).active, groupSrc, n.uptimes, {
    skillIds: P.ids, monsterStatus: n.monsterStatus,
  });
  const ph = res.groups.filter((g) => g.placeholder && !g.inactive);
  if (ph.length) {
    warnings.push({
      code: 'placeholder-uptimes', groups: ph.map((g) => g.id),
      message: `根拠の無い仮の発動率で探しました: ${ph.map((g) => `${g.label} (${Math.round((typeof g.uptime === 'number' ? g.uptime : 1 - (g.probs[g.offState] ?? 1)) * 100)}%)`).join('・')}。`
        + '実際の発動率に近づけると結果が変わります',
    });
  }
  const defs = conditionGroupDefs(core.effects);
  const conflicts = enumeratePatterns(res.groups.filter((g) => (defs.get(g.id)?.exclusiveWith?.size ?? 0) > 0))
    .warnings.filter((w) => w.code === 'exclusive-conflict');
  for (const w of conflicts) {
    warnings.push({ code: 'exclusive-over-100', groupId: w.groupId,
      message: `${w.message}。探した結果の順位は目安です (上界の前提が崩れるため)` });
  }
}

/**
 * 装備探索を作る (docs/SEARCH_DESIGN.md 3 章)。計算は step(ms) で少しずつ進める。
 * @param input 3.2 節の入力 (weapons・targets・combo・uptimes・monsterStatus・buffs・sharpness・required・charms・extraWeapons・
 *   limitBreak・decorations・armorExclude・objective・K・budget・mode・stopAfter・current)
 * @param data data.js の core のデータ (生データ + index + skillEffects + motions) か {index, effects, motions}
 * @returns {{step(ms): boolean, progress(), result(), cancel(), extend(budget): boolean}}
 */
export function createSearch(input, data) {
  const core = coreOf(data);
  const warnings = [];
  const n = normalizeInput(input, core, warnings);
  const t0 = now();
  let P = null;
  let S = null;
  let prepareMs = null;
  let cancelled = false;
  let failed = null;
  const checkCache = new Map();
  const ctx = {
    idx: n.idx, effects: core.effects, motions: core.motions, combo: n.combo, targets: n.targets,
    uptimes: n.uptimes, monsterStatus: n.monsterStatus, buffs: n.buffs, sharpness: n.sharpness,
  };

  function ensure() {
    if (S) return;
    const tp = now();
    P = prepare({ idx: n.idx, effects: core.effects, motions: core.motions }, {
      weapons: n.weapons, targets: n.targets, combo: n.combo, uptimes: n.uptimes, monsterStatus: n.monsterStatus,
      buffs: n.buffs, required: n.required, limitBreak: n.limitBreak, sharpness: n.sharpness, charmRefs: n.charmRefs,
      armorExclude: n.armorExclude, decoCount: n.decoCount, objective: n.objective, K: n.K,
      ...(n.dominance ? {} : { domK: Infinity, weaponDominance: false }),
    });
    prepareMs = now() - tp;
    for (const w of P.warnings) warnings.push(w);
    if (n.objective === 'damage') uptimeWarnings(P, n, core, warnings);
    S = new BnbSolver(P, {
      mode: n.mode, objective: n.objective, K: n.K, budget: n.budget, stopAfter: n.stopAfter, beam: n.beam, sieve: n.sieve,
    });
  }

  /** 1 件を組み立てて計算し直す (同じ構成は覚えておく) */
  function realized(e) {
    const key = `${S.keyOf(e)}|${e.ws ? e.ws.decos.join(',') : ''}|${e.deco ? e.deco.join(',') : ''}`;
    let x = checkCache.get(key);
    if (!x) {
      const { build, alternatives } = realizeEntry(P, S, e, n.gamma ? { armor: n.gamma.armor, charms: n.gamma.charms } : null);
      const c = checkBuild(build, ctx);
      x = { build, alternatives, c, ...summarize(c.r) };
      if (checkCache.size > 300) checkCache.clear();
      checkCache.set(key, x);
    }
    return x;
  }

  function statusOf() {
    if (failed) return 'error';
    if (cancelled) return 'cancelled';
    if (!S) return 'partial';
    if (provenInfeasible()) return 'infeasible';
    if (!S.done) return 'partial';
    if (n.stopAfter === 'partial' && !S.dfsRan) return 'partial';
    return S.cut ? 'stopped' : 'done';
  }

  /** 満たす構成が無いと分かった (最初の上界で -∞、または木を最後まで回って 1 件も無い) */
  function provenInfeasible() {
    return !!(S && (S.infeasible || (S.done && S.dfsFinished && !S.cut && !S.list.length)));
  }

  function infeasibleInfo() {
    if (!provenInfeasible()) return null;
    // 必須を 1 つずつ外して判定し直す: それだけで届かないもの・外すと届くもの を「足りない」として出す
    const reqs = n.required.filter((q) => P.rOf.has(q.skillId));
    const only = (keep) => {
      const lv = new Int8Array(P.R);
      for (const q of keep) lv[P.rOf.get(q.skillId)] = P.reqLv[P.rOf.get(q.skillId)];
      return lv;
    };
    const kindReason = (q) => {
      const kind = n.idx.skills.get(q.skillId)?.kind;
      const r = P.rOf.get(q.skillId);
      if (kind === 'weapon') return '武器・護石・武器スロットの珠を合わせても届きません';
      if (kind === 'set' || kind === 'group') {
        // 使わない防具 (倒していない歴戦王の γ 防具など) にそのシリーズ/グループの防具があれば、そう書く
        const bonusOf = (a) => (kind === 'set'
          ? [...(a.setBonusIds || []), a.setBonusId].filter((x) => x != null).map((id) => n.idx.setBonuses.get(id))
          : [n.idx.groupBonuses.get(a.groupBonusId)]).filter(Boolean);
        const excluded = n.armorExclude.some((id) => {
          const a = n.idx.armor.get(id);
          return a && bonusOf(a).some((b) => b.skillId === q.skillId);
        });
        return excluded ? 'この防具の組み合わせ (部位の数) では届きません。使わない防具 (倒していない歴戦王の γ 防具など) を外したためです'
          : 'この防具の組み合わせ (部位の数) では届きません';
      }
      return P.armorDeco[r] ? '防具・護石・珠を合わせても届きません' : 'この防具スキルの珠が無く、防具と護石だけでは届きません';
    };
    // 必須を 1 つずつ外して判定し直し、外しても満たせないままなら外す → 残ったものが「同時には届かない」最小の組
    let culprits = reqs.slice();
    for (const q of reqs) {
      const rest = culprits.filter((x) => x !== q);
      if (rest.length && !S.rootFeasible(only(rest))) culprits = rest;
    }
    const nameOf = (q) => `${n.idx.skills.get(q.skillId)?.name ?? q.skillId}${q.level}`;
    const missing = culprits.map((q) => ({
      skillId: q.skillId, name: n.idx.skills.get(q.skillId)?.name ?? String(q.skillId), level: q.level,
      reason: culprits.length === 1 ? `これだけでも${kindReason(q)}`
        : `${culprits.filter((x) => x !== q).map(nameOf).join('・')} と同時には届きません`,
    }));
    return { missing };
  }

  function assemble() {
    const out = [];
    const extraWarnings = [];
    if (!S || failed) return { results: out, extraWarnings };
    let mismatch = 0;
    const list = S.list;
    for (const e of list) {
      if (out.length >= n.K) break;
      let x;
      try {
        x = realized(e);
      } catch (err) {
        extraWarnings.push({ code: 'realize-failed', message: `組み立てに失敗した候補を外しました (${String((err && err.message) || err)})` });
        continue;
      }
      const c = x.c;
      if (c.error) {
        extraWarnings.push({ code: 'check-failed', message: `火力タブの計算で確かめられなかった候補を外しました (${c.error})` });
        continue;
      }
      let value = e.value;
      let relDiff = 0;
      if (n.objective === 'damage' && c.value != null) {
        relDiff = Math.abs(c.value - e.value) / Math.max(1, Math.abs(c.value));
        if (relDiff > MISMATCH_REL) { mismatch++; value = c.value; }
      }
      const item = {
        rank: 0, value: n.objective === 'damage' ? value : null, exact: !!e.exact, weapon: x.build.weapon, build: x.build,
        alternatives: x.alternatives, skills: x.skills, freeSlots: x.freeSlots,
        check: { value: c.value, relDiff, factored: c.factored, errors: c.r.errors, warnings: c.r.warnings },
      };
      if (c.perGroup) item.perGroup = c.perGroup;
      if (n.gamma) item.gamma = gammaMarks(x.build, n.gamma);
      out.push(item);
    }
    if (n.objective === 'none') {
      // 泣シミュ型: 空きスロットの多い順 (追加で珠を入れられる余地)
      const free = (it) => it.freeSlots.armor[1] + 2 * it.freeSlots.armor[2] + 3 * it.freeSlots.armor[3]
        + it.freeSlots.weapon[1] + 2 * it.freeSlots.weapon[2] + 3 * it.freeSlots.weapon[3];
      out.sort((a, b) => free(b) - free(a));
    } else if (mismatch) {
      out.sort((a, b) => b.value - a.value);
    }
    out.forEach((it, i) => { it.rank = i + 1; });
    if (mismatch) {
      extraWarnings.push({ code: 'evaluator-mismatch', count: mismatch,
        message: `探索の中の計算と火力タブの計算が ${mismatch} 件で食い違ったので、火力タブの計算で並べ直しました` });
    }
    return { results: out, extraWarnings };
  }

  const api = {
    /** ms だけ進める。終わったら (中止・失敗を含む) true */
    step(ms = 80) {
      if (cancelled || failed) return true;
      try {
        if (!S) { ensure(); return false; }
        return S.step(ms);
      } catch (e) {
        failed = String((e && e.message) || e);
        return true;
      }
    },
    /** 途中経過 { phase, elapsedMs, best: [{value, exact}], partialReady, stats } */
    progress() {
      const phase = !S ? 'prepare' : S.done ? 'done' : (S.phase || 'prepare');
      return {
        phase, elapsedMs: now() - t0, partialReady: !!(S && (S.partialReady || S.done)),
        best: S ? S.list.slice(0, n.K).map((e) => ({ value: e.value, exact: !!e.exact })) : [],
        stats: S ? { nodes: S.stats.nodes, leaves: S.stats.leaves, boundCalls: S.stats.boundCalls } : {},
      };
    },
    /** その時点の結果 (3.4 節の形)。途中で呼んでもよい */
    result() {
      const status = statusOf();
      const { results, extraWarnings } = assemble();
      const ws = [...warnings, ...extraWarnings];
      if (status === 'stopped') {
        ws.push({ code: 'budget-stopped', message: '時間で打ち切りました。もっと良い組み合わせが残っていることがあります (「続けて探す」で続きを探せます)' });
      }
      // 武器も探すときの 2 段のふるい (docs/SEARCH_DESIGN.md 2.7 節): 外した武器が残っていれば知らせる
      if (S && S.stats.sieve && S.sieveRest && S.sieveRest.length) {
        ws.push({ code: 'weapons-sieved', kept: S.stats.sieve.weapons.length, rest: S.sieveRest.length,
          message: `武器は ${P.weapons.length} 本のうち、見込みの高い ${S.stats.sieve.weapons.length} 本に絞ってくわしく探しました`
            + ' (「続けて探す」でほかの武器もくわしく探します)' });
      }
      if (failed) ws.push({ code: 'error', message: `探索の途中でエラーが起きました: ${failed}` });
      let baseline = null;
      if (n.current && n.objective === 'damage') {
        try {
          const c = checkBuild(n.current, ctx);
          baseline = c.value != null ? { value: c.value } : null;
        } catch (e) { baseline = null; }
      }
      return {
        status, results, infeasible: infeasibleInfo(), warnings: ws, baseline,
        quality: S && n.mode === 'exact' && S.done && !S.cut && !warnings.some((w) => PREMISE_WARNINGS.includes(w.code))
          ? 'exact' : 'heuristic',
        stats: S ? {
          prepareMs, elapsedMs: now() - t0, activeMs: S.activeMs + (prepareMs || 0),
          phases: S.stats.phases.map((p) => ({ ...p, endMs: p.endMs + (prepareMs || 0) })),
          classes: Object.fromEntries(Object.entries(P.partStats).map(([k, v]) => [k, v.kept])),
          charms: P.charms.length, relevantSkills: P.R, weapons: { before: P.weaponsBefore, after: P.weapons.length },
          nodes: S.stats.nodes, leaves: S.stats.leaves, boundCalls: S.stats.boundCalls, memoClears: S.stats.memoClears,
          firstSolutionMs: S.stats.firstSolutionMs,
          // 2 段のふるい: 測り直した防具・護石の組の数・測った武器の数・dfs を回した武器 (参照)
          sieve: S.stats.sieve ? { ...S.stats.sieve, weapons: S.stats.sieve.weapons.map((wi) => P.weapons[wi].ref) } : null,
        } : { prepareMs, elapsedMs: now() - t0 },
      };
    },
    /** 中止 (次の step で止まる。result().status = 'cancelled') */
    cancel() { cancelled = true; },
    /** 「続けて探す」: dfs の続きと仕上げ 2 をもう一度。続ける所が無ければ false */
    extend(budget) {
      if (cancelled || failed || !S) return false;
      return S.extend(isObj(budget) ? budget : { ms: DEFAULT_BUDGET_MS });
    },
    /** 終わったか */
    get done() { return !!(cancelled || failed || (S && S.done)); },
  };
  return api;
}

// ---------------------------------------------------------------- 武器の側だけを選び直す (武器 2 本の案)

/** 下ごしらえの覚え (同じ input の物で何度も呼ぶとき、評価器と武器の珠の組を使い回す) */
const weaponSideCache = new WeakMap();

/** 相手の行を group ごとにまとめる ([{key, W (割合の和), targets (割合を足して 1 にそろえたもの)}]。group の無い行は key null) */
function groupsOf(targets) {
  const map = new Map();
  for (const t of targets) {
    const key = t.group == null ? null : t.group;
    let g = map.get(key);
    if (!g) map.set(key, (g = { key, W: 0, rows: [] }));
    g.W += t.weight;
    g.rows.push(t);
  }
  return [...map.values()].filter((g) => g.W > 0)
    .map((g) => ({ key: g.key, W: g.W, targets: g.rows.map((t) => ({ ...t, weight: t.weight / g.W })) }));
}

function weaponSidePrep(input, data) {
  const prev = weaponSideCache.get(input);
  if (prev && prev.data === data) return prev;
  const core = coreOf(data);
  // 入力の注意 (知らない必須を外した など) は返さない (createSearch で同じ入力を探したときに出る)
  const n = normalizeInput(input, core, []);
  const P = prepare({ idx: n.idx, effects: core.effects, motions: core.motions }, {
    weapons: n.weapons, targets: n.targets, combo: n.combo, uptimes: n.uptimes, monsterStatus: n.monsterStatus,
    buffs: n.buffs, required: n.required, limitBreak: n.limitBreak, sharpness: n.sharpness, charmRefs: [],
    armorExclude: [], decoCount: n.decoCount, objective: 'damage', K: 1, light: true,
    ...(n.dominance ? {} : { weaponDominance: false }),
  });
  const groups = groupsOf(n.targets);
  const hIdx = P.ids.indexOf(P.hid);
  // 武器ごと・group ごとの評価器 (group が 1 つなら下ごしらえの評価器をそのまま使う。条件のパターンの覚えは共有)
  const evs = P.weapons.map((wp) => (groups.length === 1 ? [wp.ev] : groups.map((g) => makeEvaluator({
    effects: core.effects, motions: core.motions, combo: n.combo, targets: g.targets, weapon: wp.dmg, uptimes: n.uptimes,
    monsterStatus: n.monsterStatus, buffs: n.buffs, relevantIds: P.ids, sharpness: wp.sharpFn || wp.fixedSharp || 'white',
    handicraftIndex: hIdx, patternCache: P.patternCache,
  }))));
  const ctx = {
    idx: n.idx, effects: core.effects, motions: core.motions, combo: n.combo, targets: n.targets,
    uptimes: n.uptimes, monsterStatus: n.monsterStatus, buffs: n.buffs, sharpness: n.sharpness,
  };
  const prep = { data, n, P, groups, evs, ctx };
  weaponSideCache.set(input, prep);
  return prep;
}

/**
 * 防具・護石・防具と護石の珠を固定したまま、武器と武器スロットの珠を選び直す (docs/RECOMMEND_DESIGN.md 3.3 節・5.4 節。
 * 武器 2 本の案で、1 回目の探索の防具の組に 2 本目の武器を合わせる)。
 * - 候補の武器は input.weapons (createSearch と同じ。'sns-all' も可)。武器の支配除去 (problem.js) をしてから測る。
 * - 武器の珠は武器スロットの分だけ選ぶ (護石の武器用スロットの珠は fixed のまま。2 本で共有する扱い)。
 * - 必須スキル (input.required) を満たさない組は出さない。
 * - 刈り込みは「武器の珠で届く Lv の箱の上」での score で行う。score は各 group の値について単調 (値が上がって下がらない)
 *   であること (T を小さくする採点 -Σ H_i / D_i はそう)。
 * - 同じ input の物で何度も呼ぶと、下ごしらえ (評価器・武器の珠の組) を使い回す。
 * @param input createSearch の入力 (weapons・extraWeapons・targets (group つき)・combo・uptimes・monsterStatus・buffs・
 *   sharpness・required・decorations。防具・護石の項目は使わない)
 * @param fixed {armor: {head, chest, arms, waist, legs}, charm, limitBreak, decorations: {head, ..., charmArmor, charmWeapon}}
 *   (decorations.weapon は無視する。limitBreak が無ければ input.limitBreak)
 * @param data createSearch と同じ
 * @param o {score(perGroup, value) → 大きいほど良い (既定 = value)、N (既定 5)、
 *   check (既定 true。false なら computeBuild + comboExpected での計算し直しを省く。仮置きの発動率のままだと 1 件 50〜100ms かかる
 *   ので、途中で何度も呼ぶときは false にして、最後に出す物だけ確かめる)}
 * @returns [{weapon, decorations: {weapon: [珠の id | null]}, build, perGroup, value, score, check: {value, perGroup, relDiff,
 *   factored, error, errors} | null}] score の大きい順。武器 1 本につき一番良い珠の組 1 件。perGroup は group の無い入力では null
 */
export function optimizeWeaponSide(input, fixed, data, o = {}) {
  const prep = weaponSidePrep(input, data);
  const { n, P, groups, evs, ctx } = prep;
  const N = Math.max(1, Math.floor(Number(o.N) || 5));
  const score = typeof o.score === 'function' ? o.score : (_pg, value) => value;
  const R = P.R;
  const hasGroups = groups.some((g) => g.key != null);
  const fixedDecos = { ...((fixed && fixed.decorations) || {}) };
  delete fixedDecos.weapon;
  const limitBreak = fixed && fixed.limitBreak != null ? fixed.limitBreak : n.limitBreak;
  const baseBuild = (ref) => ({ weapon: ref, armor: { ...((fixed && fixed.armor) || {}) }, charm: fixed ? fixed.charm ?? null : null,
    decorations: { ...fixedDecos, weapon: [] }, limitBreak });
  const L = new Int8Array(R);
  const vals = new Float64Array(groups.length);
  /** L の値 → [score, value, perGroup] */
  const scoreOf = (wi) => {
    let value = 0;
    groups.forEach((g, gi) => { vals[gi] = evs[wi][gi].evaluate(L); value += g.W * vals[gi]; });
    const perGroup = hasGroups ? Object.fromEntries(groups.filter((g) => g.key != null).map((g) => [g.key, vals[groups.indexOf(g)]])) : null;
    return [score(perGroup, value), value, perGroup];
  };

  // 武器ごと: 固定した側と合わせた Lv (武器の珠なし) と、武器の珠で届く Lv の箱の上での score (上界)
  const cand = [];
  P.weapons.forEach((wp, wi) => {
    const r0 = computeBuild(baseBuild(wp.ref), n.idx);
    if (r0.errors.length) throw new Error(`固定した装備に誤りがあります: ${r0.errors.map((e) => e.message).join(' / ')}`);
    const L0 = new Int8Array(R);
    for (let r = 0; r < R; r++) L0[r] = Math.min(P.maxLv[r], r0.skillLevels[P.ids[r]] || 0);
    const combos = P.weaponSide(wp.slots, wp.mask, wp.maskKey);
    for (let r = 0; r < R; r++) {
      let top = 0;
      for (const c of combos) if (c.vec[r] > top) top = c.vec[r];
      L[r] = Math.min(P.maxLv[r], L0[r] + top);
    }
    // 必須を箱の上でも満たせない武器は外す
    for (let r = 0; r < R; r++) if (L[r] < P.reqLv[r]) return;
    cand.push({ wi, wp, L0, combos, ub: scoreOf(wi)[0] });
  });
  cand.sort((a, b) => b.ub - a.ub);

  const best = []; // score の大きい順 (N 件まで)
  for (const c of cand) {
    if (best.length >= N && c.ub <= best[N - 1].score) break;
    let top = null;
    for (const w of c.combos) {
      let ok = true;
      for (let r = 0; r < R; r++) {
        L[r] = Math.min(P.maxLv[r], c.L0[r] + w.vec[r]);
        if (L[r] < P.reqLv[r]) ok = false;
      }
      if (!ok) continue;
      const [s, value, perGroup] = scoreOf(c.wi);
      if (!top || s > top.score) top = { score: s, value, perGroup, decos: w.decos };
    }
    if (!top) continue;
    let i = best.length;
    while (i > 0 && best[i - 1].score < top.score) i--;
    best.splice(i, 0, { ...top, c });
    if (best.length > N) best.pop();
  }

  // 珠の位置を決めて、computeBuild + comboExpected で計算し直す
  return best.map((b) => {
    const wp = b.c.wp;
    const slots = (wp.w.slots || []).map((x, i) => ({ t: 'weapon', i, size: Number(x) || 0 }));
    const weaponDecos = slots.map(() => null);
    for (const p of placeDecos(slots, b.decos.map((id) => (id == null ? null : n.idx.decorations.get(id))))) weaponDecos[p.i] = p.id;
    const build = baseBuild(wp.ref);
    build.decorations.weapon = weaponDecos;
    const out = { weapon: wp.ref, decorations: { weapon: weaponDecos }, build, perGroup: b.perGroup, value: b.value, score: b.score, check: null };
    if (o.check !== false) {
      const chk = checkBuild(build, ctx);
      const relDiff = chk.value == null ? null : Math.abs(chk.value - b.value) / Math.max(1, Math.abs(chk.value));
      out.check = { value: chk.value, perGroup: chk.perGroup, relDiff, factored: chk.factored, error: chk.error, errors: chk.r.errors };
    }
    return out;
  });
}

// ---------------------------------------------------------------- 歴戦王の素材 (γ 防具・狩猟証γ の護石。docs/SEARCH_DESIGN.md 4 章の 4)

/**
 * monsters.json の individuals[].rewards (歴戦王だけにある) から、作るのに歴戦王の素材 (狩猟証γ) が要る防具・固定護石の表を作る。
 * armor / charmsFixed の形は recommend.js の gammaIndex と同じ。createSearch の input.gamma に渡すと、結果に印
 * (results[].gamma = [{part, armorId | charmId, monsterId, name}]) が付き、同じ類に γ でない防具・護石があればそちらを代表にする。
 * 外すとき (倒していない歴戦王) は、monsters[].armorIds を input.armorExclude に、charmFixedIds を input.charms.fixedExclude に入れる。
 * @param targetData data.js の target データ ({monsters: monsters.json 丸ごと}) / monsters.json 丸ごと / monsters の配列
 * @returns {{armor: {[armorId]: {monsterId, name}}, charmsFixed: {[charmId]: {monsterId, name}},
 *            monsters: [{monsterId, name, certificate, armorIds, charmFixedIds, groupSkills: [{skillId, name}]}]}}
 *   name は個体の名前 (例「アルシュベルド（歴戦王）」)
 */
export function gammaIndexOf(targetData) {
  const td = targetData && targetData.monsters !== undefined ? targetData.monsters : targetData;
  const list = Array.isArray(td) ? td : listOf(td, 'monsters');
  const armor = {};
  const charmsFixed = {};
  const monsters = [];
  for (const m of list) {
    for (const ind of (m && m.individuals) || []) {
      const r = ind && ind.rewards;
      if (!isObj(r)) continue;
      const name = ind.name || m.name;
      const armorIds = (r.armorSets || []).flatMap((x) => x.armorIds || []);
      const charmFixedIds = [...(r.charmFixedIds || [])];
      for (const id of armorIds) armor[id] = { monsterId: m.id, name };
      for (const id of charmFixedIds) charmsFixed[id] = { monsterId: m.id, name };
      monsters.push({
        monsterId: m.id, name, certificate: r.certificate ? r.certificate.name : null, armorIds, charmFixedIds,
        groupSkills: (r.groupSkills || []).map((g) => ({ skillId: g.skillId, name: g.name })),
      });
    }
  }
  return { armor, charmsFixed, monsters };
}
