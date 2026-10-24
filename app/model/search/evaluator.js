// 速い評価器 (docs/SEARCH_DESIGN.md 2.3 節): 関係するスキルの Lv の並び (Int8Array) → コンボ 1 回の期待値
// (狙う部位の割合で加重平均)。damage.js の comboExpected と同じ値 (相対 1e-13 程度。足し順だけ違う) を、
// 条件のパターンを全部並べずに出す。
//  - 条件の組み合わせ (パターン) と重みは damage.js の resolveSkills / resolveConditions / enumeratePatterns を
//    そのまま呼んで作り、使う条件グループの組ごとに覚える。
//  - 同時に起きない条件 (exclusiveWith) でつながったグループの塊ごとに独立な因子に分け、会心率などの分布を畳み込む。
//  - ヒットは「肉質・傷口・会心できるか・斬れ味補正・飛燕・追加ダメージ」が同じものをまとめる (式が MV と属性補正に線形なので同じ値)。
//    ヒットの並べ方 (傷口・時刻) は damage.js の comboPlan をそのまま使う。灼熱化 (model 'checks') の判定の割合は
//    damage.js の planCheckWeights で相手ごとに出し、組ごとに「判定の割合 × 部位の割合」の和で持つ (追加ダメージは線形なので組にまとめてよい)。
//    灼熱化の火の倍率・加算 (火に効く属性スキルを武器の属性と関係なく集めたもの) も、攻撃・属性と同じくパターンの期待値で持つ (上限なし)。
//    1 回分の式は damage.js の extraDamageOnce をそのまま呼ぶ。
//    速い道ではさらに、会心の期待値が同じになるヒット (会心率の足し・会心できるか が同じ) の係数を足してから会心率の分布を回る。
//  - 攻撃・属性の上限に当たりうるとき・条件つきスキルが会心倍率などを変えるときは、全パターンを回る遅い道に落ちる。
//  - uncapped: true で上限 (攻撃 ×4.0/+400・属性 ×2.3/+400・会心率 ±100) を外した版、'attack' で攻撃・属性の上限だけ外した版
//    (分枝限定の上界用)。
// damage.js の aggregateModifiers / computeStats / hitDamage の式を写しているので、damage.js を直したらここも直す
// (tests/search_eval.test.mjs がずれを見張る)。import は相対パスだけ (Worker から読むため)。
import {
  resolveSkills, resolveConditions, enumeratePatterns, mergeRules, conditionGroupDefs, comboPlan, planCheckWeights, extraDamageOnce,
  SHARPNESS_ORDER, ELEMENTAL_TYPES,
} from '../damage.js';

// 効果のチャネル (aggregateModifiers が使う項目)。C_FMUL / C_FADD = 灼熱化の火の分の倍率・加算 (aggregateModifiers の fireMul / fireAdd)
const C_AMUL = 0, C_AADD = 1, C_AFF = 2, C_CRIT = 3, C_EMUL = 4, C_EADD = 5, C_WPA = 6, C_WA = 7, C_WPMIN = 8,
  C_CEM = 9, C_HPM = 10, C_HPMAX = 11, C_JUMP = 12, C_LSM = 13, C_LSC = 14, C_FMUL = 15, C_FADD = 16, NCH = 17;

/** 遅い道で並べるパターンの数の上限 (comboExpected の MAX_PATTERNS より大きくてよい。因子の積で作るので例外にはしない) */
const SLOW_MAX_PATTERNS = 1 << 18;
/** 覚えるパターンの組の数の上限 (超えたら全部忘れる。メモリの上限) */
const PATTERN_CACHE_MAX = 4096;
/** 遅い道の全パターンを覚えるのは、この数までのとき */
const SLOW_KEEP_PATTERNS = 4096;

/** skill_effects の 1 段の効果 → チャネルの配列 (aggregateModifiers と同じ既定値)。武器の属性と合わない属性強化は 0 にする */
function channelOf(raw, weaponElementType) {
  if (!raw) return null;
  const fx = {
    attackAdd: 0, attackMul: 1, affinityAdd: 0, critMul: null, elementAdd: 0, elementMul: 1,
    weakPointAffinity: 0, woundAffinity: 0, critElementMul: null, ...raw,
  };
  const c = new Float64Array(NCH);
  c[C_AMUL] = fx.attackMul ?? 1;
  c[C_AADD] = fx.attackAdd ?? 0;
  c[C_AFF] = fx.affinityAdd ?? 0;
  c[C_CRIT] = fx.critMul != null ? fx.critMul : NaN;
  const match = !fx.elementType || fx.elementType === weaponElementType;
  c[C_EMUL] = match ? (fx.elementMul ?? 1) : 1;
  c[C_EADD] = match ? (fx.elementAdd ?? 0) : 0;
  c[C_WPA] = fx.weakPointAffinity ?? 0;
  c[C_WA] = fx.woundAffinity ?? 0;
  c[C_WPMIN] = fx.weakPointMinHitzone != null ? fx.weakPointMinHitzone : NaN;
  c[C_CEM] = fx.critElementMul != null ? fx.critElementMul : NaN;
  c[C_HPM] = fx.hardPartMul != null ? fx.hardPartMul : NaN;
  c[C_HPMAX] = fx.hardPartMaxHitzone != null ? fx.hardPartMaxHitzone : NaN;
  c[C_JUMP] = fx.jumpMul != null ? fx.jumpMul : 1;
  c[C_LSM] = fx.lowSharpnessMul != null ? fx.lowSharpnessMul : NaN;
  c[C_LSC] = fx.lowSharpnessMul != null ? SHARPNESS_ORDER.indexOf(fx.lowSharpnessMaxColor ?? 'yellow') : -1;
  const fire = !fx.elementType || fx.elementType === 'fire';
  c[C_FMUL] = fire ? (fx.elementMul ?? 1) : 1;
  c[C_FADD] = fire ? (fx.elementAdd ?? 0) : 0;
  return { c, extra: fx.extraDamage || null };
}

function physicalHitzone(hz, type) {
  if (!hz) return 0;
  if (type === 'slash') return hz.slash ?? 0;
  if (type === 'blow' || type === 'blunt') return hz.blunt ?? hz.blow ?? 0;
  if (type === 'shot') return hz.shot ?? 0;
  return 0;
}

/**
 * ヒットをまとめた「ヒット組」を作る。ヒットの並びは damage.js の comboPlan (傷口の無い部位は傷口なし、傷口でだけ出るヒットは
 * 傷口の段だけ。段の時刻も) をそのまま使う。
 * targets: [{weight, target: {hitzone, wound, isWound}}] (weight は足して 1)
 * @returns {{classes, plans}} plans[相手] = comboPlan の結果。classes[].members = [{ti, si, hi, w}] (判定の割合を足し合わせるのに使う)
 */
function buildHitClasses(motions, combo, targets, elemType) {
  const classes = new Map();
  const plans = targets.map((t) => comboPlan(motions, combo, t.target, []));
  targets.forEach((t, ti) => {
    plans[ti].forEach((st, si) => {
      const isWound = st.isWound;
      const hz = st.hitzone || {};
      st.hits.forEach((h, hi) => {
        const physHz = physicalHitzone(hz, h.type);
        const elemHz = elemType ? (hz[elemType] ?? 0) : 0;
        const key = [ti, isWound ? 'w' : 'n', physHz, h.canCrit === false ? 0 : 1, h.sharpnessMul === false ? 0 : 1,
          h.hien ? 1 : 0, h.additionalDamage ? 1 : 0].join('|');
        let k = classes.get(key);
        if (!k) {
          classes.set(key, (k = {
            hz, physHz, elemHz, isWound, canCrit: h.canCrit !== false, sharp: h.sharpnessMul !== false,
            hien: !!h.hien, addDmg: !!h.additionalDamage, smv: 0, srate: 0, sfix: 0, scnt: 0, members: [],
          }));
        }
        const cnt = (h.count ?? 1) * t.weight;
        const rate = h.usesElement === false ? 0 : (h.elementRate ?? 0);
        k.smv += h.mv * cnt;
        k.srate += (rate > 0 ? rate : 0) * cnt;
        k.sfix += (h.fixed || 0) * cnt;
        k.scnt += cnt;
        k.members.push({ ti, si, hi, w: t.weight });
      });
    });
  });
  return { classes: [...classes.values()], plans };
}

/**
 * resolveConditions のグループ → 独立な因子 (docs/SEARCH_DESIGN.md 2.3 節)。
 * 因子 = exclusiveWith でつながるグループの塊。enumeratePatterns は同時に起きない相手の状態だけで条件つき確率を決めるので、
 * 塊どうしは独立で、塊ごとに enumeratePatterns を呼んだものが全体の周辺分布と同じになる (全体を数え上げない)。
 * 返す物は覚えるので、resolveConditions の結果 (大きい) を持たない形にする。
 * @returns {{nG, gposByKey, factors: [{pos, states: [{w, st}], w: Float64Array}], facOf, facPos, pats: null}}
 */
function factorize(groups, condGroupIds) {
  const gids = groups.map((g) => g.id);
  const gposByKey = condGroupIds.map((gid) => gids.indexOf(gid));
  const comp = gids.map((_, i) => i);
  const find = (i) => (comp[i] === i ? i : (comp[i] = find(comp[i])));
  groups.forEach((g, i) => {
    for (const o2 of g.exclusiveWith || []) { const j = gids.indexOf(o2); if (j >= 0) comp[find(i)] = find(j); }
  });
  const roots = [...new Set(gids.map((_, i) => find(i)))];
  const factors = roots.map((rt) => {
    const pos = gids.map((_, i) => i).filter((i) => find(i) === rt);
    const en = enumeratePatterns(pos.map((i) => groups[i]));
    const states = en.patterns.map((p) => ({ w: p.weight, st: pos.map((i) => p.states[gids[i]]) }));
    return { pos, states, w: Float64Array.from(states.map((x) => x.w)) };
  });
  // グループの位置 → (因子の番号, 因子の中の位置)
  const facOf = new Int16Array(gids.length); const facPos = new Int16Array(gids.length);
  factors.forEach((f, fi) => f.pos.forEach((gp, j) => { facOf[gp] = fi; facPos[gp] = j; }));
  return { nG: gids.length, gposByKey, factors, facOf, facPos, pats: null };
}

/** 遅い道で使う全パターン: 因子の積で作る (塊どうしは独立なので enumeratePatterns(全部) と同じ分布) */
function productPatterns(ps) {
  let acc = [{ w: 1, st: new Array(ps.nG) }];
  for (const f of ps.factors) {
    const next = [];
    for (const a of acc) {
      for (const s of f.states) {
        const st = a.st.slice();
        f.pos.forEach((gp, j) => { st[gp] = s.st[j]; });
        next.push({ w: a.w * s.w, st });
      }
    }
    if (next.length > SLOW_MAX_PATTERNS) throw new Error(`条件の組み合わせが多すぎる (${next.length})`);
    acc = next;
  }
  return acc;
}

/**
 * 評価器を作る。
 * @param {object} o
 *   effects (skill_effects.json 丸ごと), motions, combo, targets ([{weight, target}]。weight は足して 1),
 *   weapon ({attack, affinity, element}), uptimes, monsterStatus, buffs,
 *   relevantIds (スキル id の配列。Lv の並びの添字。requiresSkillId の先も入れておくこと。無いと「無い」扱い)
 *   sharpness: 固定の色 (文字列) か、匠の Lv → 色 の関数。handicraftIndex: relevantIds の中の匠の添字 (-1 = 無し)
 *   uncapped: true なら上限を全部外した版、'attack' なら攻撃・属性の上限だけ外した版
 *   patternCache: 条件のパターンの覚え (Map) を評価器どうしで使い回すとき渡す (同じ relevantIds の配列・effects・uptimes・monsterStatus)
 * @returns {{evaluate(levels: Int8Array): number, R, ids, classes, evals, slowEvals, patternSets}}
 */
export function makeEvaluator(o) {
  const rules = mergeRules(o.effects.rules || {});
  const groupSrc = (o.effects.rules && o.effects.rules.conditionGroups) || [];
  const effMap = o.effects.effects || o.effects;
  const weapon = o.weapon || { attack: 0, affinity: 0, element: null };
  const elemType = weapon.element ? weapon.element.type : null;
  const elemBase = weapon.element ? Number(weapon.element.value) || 0 : 0;
  const elemental = ELEMENTAL_TYPES.includes(elemType);
  const wAtk = Number(weapon.attack) || 0;
  const wAff = Number(weapon.affinity) || 0;
  const buffs = o.buffs || {};
  const uncapped = o.uncapped || false;
  const forceSlow = !!o.forceSlow;
  const atkMulCap = uncapped ? Infinity : (rules.physicalRateLimit ?? Infinity);
  const atkAddCap = uncapped ? Infinity : (rules.physicalAddLimit ?? Infinity);
  const elMulCap = uncapped ? Infinity : (rules.elementRateLimit ?? Infinity);
  const elAddCap = uncapped ? Infinity : (rules.elementAddLimit ?? Infinity);
  // uncapped === 'attack': 攻撃・属性の上限だけ外す (会心率は ±100 で切ったまま)
  const affLo = uncapped === true ? -Infinity : (rules.affinityMin ?? -100);
  const affHi = uncapped === true ? Infinity : (rules.affinityMax ?? 100);
  const critBase = rules.criticalBase;
  const critNeg = rules.criticalNegative;
  const wpMinRule = rules.weakPointMinHitzone;
  const hardMaxRule = rules.hardPartMaxHitzone;
  const sharpTable = SHARPNESS_ORDER.map((c) => rules.sharpness[c]);

  const { classes, plans } = buildHitClasses(o.motions, o.combo, o.targets, elemType);
  const nClass = classes.length;
  const cPhysHz = new Float64Array(classes.map((k) => k.physHz));
  const cElemHz = new Float64Array(classes.map((k) => k.elemHz));
  const cWound = classes.map((k) => k.isWound);
  const cCrit = classes.map((k) => k.canCrit);
  const cSharp = classes.map((k) => k.sharp);
  const cHien = classes.map((k) => k.hien);
  const cAdd = classes.map((k) => k.addDmg);
  const cSmv = new Float64Array(classes.map((k) => k.smv));
  const cSrate = new Float64Array(classes.map((k) => k.srate));
  const cSfix = new Float64Array(classes.map((k) => k.sfix));
  const cScnt = new Float64Array(classes.map((k) => k.scnt));
  const cHz = classes.map((k) => k.hz);
  // 判定のある追加ダメージ (灼熱化) の、組ごとの「判定の割合 × 部位の割合」の和 (spec ごとに 1 回だけ出す。武器・スキルに関係しない)
  const checkMemo = new Map();
  function classChecks(x) {
    let arr = checkMemo.get(x);
    if (arr) return arr;
    const per = plans.map((pl) => planCheckWeights(pl, x, []).perHit);
    arr = new Float64Array(nClass);
    classes.forEach((k, ki) => { for (const m of k.members) arr[ki] += m.w * per[m.ti][m.si][m.hi]; });
    checkMemo.set(x, arr);
    return arr;
  }

  // ---- スキルごとの表: tab[r][L] = {main (主効果のチャネル), byState (段ごとのチャネル), conditional}
  const ids = o.relevantIds;
  const R = ids.length;
  const hIdx = o.handicraftIndex ?? -1;
  const sharpFn = typeof o.sharpness === 'function' ? o.sharpness : null;
  const fixedColorIdx = sharpFn ? -1 : SHARPNESS_ORDER.indexOf(o.sharpness || 'white');
  if (!sharpFn && fixedColorIdx < 0) throw new Error(`斬れ味の色が不明: ${o.sharpness}`);
  const tab = [];
  const requires = new Int16Array(R).fill(-1); // requiresSkillId の添字 (-2 = R に無い → 常に満たさない)
  const supported = new Uint8Array(R);
  for (let r = 0; r < R; r++) {
    const e = effMap[String(ids[r])];
    const row = [null];
    if (e && (e.levels || []).length && e.supported !== false) {
      supported[r] = 1;
      if (e.requiresSkillId != null) {
        const j = ids.indexOf(Number(e.requiresSkillId));
        requires[r] = j >= 0 ? j : -2;
      }
      const levels = e.levels;
      const maxLv = levels[levels.length - 1].level;
      for (let L = 1; L <= 7; L++) {
        const level = Math.min(L, maxLv);
        const lv = levels.find((x) => x.level === level) || levels[levels.length - 1];
        const byState = {};
        if (lv.byState) for (const [s, v] of Object.entries(lv.byState)) byState[s] = channelOf(v, elemType);
        row.push({ main: channelOf(lv, elemType), byState, conditional: !!e.conditional });
      }
    }
    tab.push(row);
  }

  // ---- 条件つきスキルのグループと発動する段 (resolveConditions と同じ決め方。スキルごとに固定)
  const defs = conditionGroupDefs(o.effects);
  const groupKeyOf = new Array(R).fill(null); // 条件グループの通し番号
  const actStatesOf = new Array(R).fill(null);
  const condGroupIds = [];
  for (let r = 0; r < R; r++) {
    const e = effMap[String(ids[r])];
    if (!e || !e.conditional || e.supported === false || !(e.levels || []).length) continue;
    const gid = e.conditionGroup ?? `skill:${ids[r]}`;
    let gi = condGroupIds.indexOf(gid);
    if (gi < 0) { gi = condGroupIds.length; condGroupIds.push(gid); }
    groupKeyOf[r] = gi;
    const def = defs.get(gid);
    const nonOff = def && def.type === 'categorical' ? def.states.map((x) => x.id).filter((x) => x !== def.offState) : ['on'];
    actStatesOf[r] = Array.isArray(e.activeStates) && e.activeStates.length ? e.activeStates : nonOff;
  }
  if (condGroupIds.length > 50) throw new Error('条件グループが多すぎる (50 まで)');
  // 条件つきスキルが「単純」(攻撃の加算/乗算・会心率・属性の乗算/加算しか変えない) か。単純でないと速い道を使えない
  const complexCond = new Uint8Array(R);
  const isSimple = (ch) => !ch || (Number.isNaN(ch.c[C_CRIT]) && ch.c[C_WPA] === 0 && ch.c[C_WA] === 0 && Number.isNaN(ch.c[C_WPMIN])
    && Number.isNaN(ch.c[C_CEM]) && Number.isNaN(ch.c[C_HPM]) && ch.c[C_JUMP] === 1 && Number.isNaN(ch.c[C_LSM]) && !ch.extra);
  for (let r = 0; r < R; r++) {
    if (groupKeyOf[r] == null) continue;
    for (let L = 1; L < tab[r].length; L++) {
      const row = tab[r][L];
      if (!isSimple(row.main) || Object.values(row.byState).some((ch) => !isSimple(ch))) complexCond[r] = 1;
    }
  }
  // 条件のもとになるスキル (sources.skillIds) の添字
  const srcIdx = [];
  for (const g of groupSrc) {
    if (!g.sources || !Array.isArray(g.sources.skillIds)) continue;
    for (const sid of g.sources.skillIds) {
      const j = ids.indexOf(Number(sid));
      if (j >= 0 && !srcIdx.includes(j)) srcIdx.push(j);
    }
  }
  if (srcIdx.length > 8) throw new Error('条件のもとのスキルが多すぎる');

  // ---- パターンのキャッシュ (使う条件グループの組 + 条件のもとの有無 ごと)。o.patternCache を渡すと、同じ relevantIds・effects・
  //      uptimes・monsterStatus の評価器どうしで使い回す (パターンは武器・相手・上限に関係しない。problem.js が武器ごとの評価器で共有する)
  const patCache = o.patternCache || new Map();
  if (o.patternCache) {
    if (patCache.ids && patCache.ids !== ids) throw new Error('patternCache は同じ relevantIds の評価器だけで使い回せる');
    patCache.ids = ids;
  }
  // 因子の状態ごとのチャネルの覚え (パターンの組ごと。チャネルは武器の属性で変わるので評価器ごと)
  const chanMaps = new WeakMap();
  const present = new Uint8Array(R);
  const gseen = new Uint8Array(condGroupIds.length);
  function patternsFor(levels) {
    // 実際のスキルの並び (Lv>0) で resolveSkills → resolveConditions → enumeratePatterns (damage.js のまま)
    const list = [];
    for (let r = 0; r < R; r++) if (levels[r] > 0) list.push({ skillId: ids[r], level: levels[r] });
    const resolved = resolveSkills(list, o.effects);
    const cond = resolveConditions(resolved.active, groupSrc, o.uptimes || {}, {
      skillIds: list.map((s) => s.skillId), monsterStatus: o.monsterStatus,
    });
    return factorize(cond.groups, condGroupIds);
  }
  let evals = 0;
  let slowCount = 0;
  // 因子ごとの状態の寄与 (使い回す入れ物)
  const MAXS = 64;
  const fM = new Float64Array(MAXS), fA = new Float64Array(MAXS), fF = new Float64Array(MAXS), fEM = new Float64Array(MAXS),
    fEA = new Float64Array(MAXS), fW = new Float64Array(MAXS), fFM = new Float64Array(MAXS), fFA = new Float64Array(MAXS);
  // 会心率の分布 (値ごとに P, E[攻撃乗算の積], E[攻撃加算の和], E[属性乗算の積], E[属性加算の和])
  const DMAX = 512;
  let dV = new Float64Array(DMAX), dP = new Float64Array(DMAX), dM = new Float64Array(DMAX), dA = new Float64Array(DMAX),
    dEM = new Float64Array(DMAX), dEA = new Float64Array(DMAX);
  let nV = new Float64Array(DMAX), nP = new Float64Array(DMAX), nM = new Float64Array(DMAX), nA = new Float64Array(DMAX),
    nEM = new Float64Array(DMAX), nEA = new Float64Array(DMAX);
  // ヒット組をまとめた箱ごとの物理・属性の係数 (箱 = 弱点特効の肉質か + 傷口か×2 + 会心できるか×4)
  const bP = new Float64Array(8), bE = new Float64Array(8);
  // 因子ごとの条件つきスキル (因子の数は条件グループの数まで)
  const MAXF = 64;
  const fCnt = new Int16Array(MAXF), fItem = new Int16Array(MAXF * Math.max(1, R));

  // 速い道。厳密に出せないとき (上限に当たる・状態が多すぎる) は null
  /** 条件つきスキル r (Lv lv) の、因子の状態ごとのチャネル (発動しない状態は null) */
  function chanList(ps, r, lv) {
    const gp = ps.gposByKey[groupKeyOf[r]];
    const F = ps.factors[ps.facOf[gp]];
    const fp = ps.facPos[gp];
    const row = tab[r][lv];
    return F.states.map((x) => {
      const st = x.st[fp];
      const ch = row.byState[st] || (actStatesOf[r].includes(st) ? row.main : null);
      return ch ? ch.c : null;
    });
  }

  function fastPath(ps, levels, condList, b) {
    let maxAm = b.am0, maxAa = b.aa0, maxEm = b.em0, maxEa = b.ea0;
    // 火 (灼熱化) の倍率・加算: sP = E[1]、sFM = E[倍率の積]、sFA = E[加算の和] (因子どうしは独立なので因子ごとの期待値の積と和)
    let sP = 1, sFM = b.fm0, sFA = b.fa0;
    let n = 1;
    dV[0] = b.af0; dP[0] = 1; dM[0] = b.am0; dA[0] = b.aa0; dEM[0] = b.em0; dEA[0] = b.ea0;
    const nF = ps.factors.length;
    if (nF > MAXF) return null;
    let chanMap = chanMaps.get(ps);
    if (!chanMap) chanMaps.set(ps, (chanMap = new Map()));
    // 条件つきスキルを因子ごとに分ける
    fCnt.fill(0, 0, nF);
    for (let i = 0; i < condList.length; i++) {
      const r = condList[i];
      const fi = ps.facOf[ps.gposByKey[groupKeyOf[r]]];
      fItem[fi * R + fCnt[fi]++] = r;
    }
    for (let fi = 0; fi < nF; fi++) {
      const cnt = fCnt[fi];
      if (!cnt) continue;
      const F = ps.factors[fi];
      const S = F.states.length;
      if (S > MAXS) return null;
      const fw = F.w;
      for (let j = 0; j < S; j++) { fM[j] = 1; fA[j] = 0; fF[j] = 0; fEM[j] = 1; fEA[j] = 0; fW[j] = fw[j]; fFM[j] = 1; fFA[j] = 0; }
      for (let t = 0; t < cnt; t++) {
        const r = fItem[fi * R + t];
        const lv = levels[r] > 7 ? 7 : levels[r];
        const key = r * 8 + lv;
        let chans = chanMap.get(key);
        if (!chans) { chans = chanList(ps, r, lv); chanMap.set(key, chans); }
        for (let j = 0; j < S; j++) {
          const c = chans[j];
          if (c === null) continue;
          fM[j] *= c[C_AMUL]; fA[j] += c[C_AADD]; fF[j] += c[C_AFF]; fEM[j] *= c[C_EMUL]; fEA[j] += c[C_EADD];
          fFM[j] *= c[C_FMUL]; fFA[j] += c[C_FADD];
        }
      }
      let qP = 0, qFM = 0, qFA = 0;
      for (let j = 0; j < S; j++) {
        const q = fW[j];
        if (q <= 0) continue;
        qP += q; qFM += q * fFM[j]; qFA += q * fFA[j];
      }
      sFA = sFA * qP + sP * qFA; sFM *= qFM; sP *= qP;
      let mM = 0, mA = -Infinity, mEM = 0, mEA = -Infinity;
      for (let j = 0; j < S; j++) {
        if (fM[j] > mM) mM = fM[j];
        if (fA[j] > mA) mA = fA[j];
        if (fEM[j] > mEM) mEM = fEM[j];
        if (fEA[j] > mEA) mEA = fEA[j];
      }
      maxAm *= mM; maxAa += mA; maxEm *= mEM; maxEa += mEA;
      // 畳み込み (同じ会心率はまとめる)
      let m = 0;
      for (let x = 0; x < n; x++) {
        const P = dP[x], M = dM[x], A = dA[x], EM = dEM[x], EA = dEA[x], V = dV[x];
        for (let j = 0; j < S; j++) {
          const q = fW[j];
          if (q <= 0) continue;
          const nv = V + fF[j];
          let y = 0;
          while (y < m && nV[y] !== nv) y++;
          if (y === m) {
            if (m >= DMAX) return null;
            nV[y] = nv; nP[y] = 0; nM[y] = 0; nA[y] = 0; nEM[y] = 0; nEA[y] = 0; m++;
          }
          nP[y] += q * P; nM[y] += q * fM[j] * M; nA[y] += q * (A + fA[j] * P);
          nEM[y] += q * fEM[j] * EM; nEA[y] += q * (EA + fEA[j] * P);
        }
      }
      let t;
      t = dV; dV = nV; nV = t; t = dP; dP = nP; nP = t; t = dM; dM = nM; nM = t; t = dA; dA = nA; nA = t;
      t = dEM; dEM = nEM; nEM = t; t = dEA; dEA = nEA; nEA = t;
      n = m;
    }
    // 上限に当たるかもしれないなら遅い道へ (min(乗算, 上限) が線形でなくなる)
    if (wAtk > 0 && maxAm > atkMulCap) return null;
    if (maxAa > atkAddCap) return null;
    const useElem = elemental && elemBase;
    if (useElem && (maxEm > elMulCap || maxEa > elAddCap)) return null;

    const critMul = Number.isNaN(b.cm0) ? critBase : b.cm0;
    const cem = b.cem0;
    const wpMin = Number.isNaN(b.wpmin0) ? wpMinRule : b.wpmin0;
    const hardMax = Number.isNaN(b.hpmax0) ? hardMaxRule : b.hpmax0;
    const lowOn = b.lsm0 !== 1 && b.lsc0 >= 0 && b.colorIdx <= b.lsc0;
    const sh = b.sh;
    // 灼熱化の 1 回分は火の倍率と加算に線形なので、パターンの期待値 = E[1] × 1 回分 (倍率 = E[積]/E[1]・加算 = E[和]/E[1])
    const fireMods = sP > 0 ? { fireMul: sFM / sP, fireAdd: sFA / sP } : null;
    let total = 0;
    // ヒット組を「会心率の足し (弱点特効・傷口) と会心できるか」の 8 つの箱にまとめる (箱の中では会心の期待値が同じなので、
    // MV などの係数を足してから会心率の分布を 1 回だけ回る。ヒット組 × 分布の点 → 箱 × 分布の点)
    bP.fill(0); bE.fill(0);
    for (let k = 0; k < nClass; k++) {
      const physHz = cPhysHz[k];
      const box = (physHz >= wpMin ? 1 : 0) + (cWound[k] ? 2 : 0) + (cCrit[k] ? 4 : 0);
      const sp = cSharp[k] ? sh.physical : 1;
      const se = cSharp[k] ? sh.element : 1;
      let physMul = 1;
      if (b.hpm0 !== 1 && physHz <= hardMax) physMul *= b.hpm0;
      if (cHien[k]) physMul *= b.jm0;
      if (lowOn) physMul *= b.lsm0;
      bP[box] += (cSmv[k] / 100) * (physHz / 100) * sp * physMul;
      if (useElem && cSrate[k] > 0) bE[box] += cSrate[k] * (cElemHz[k] / 100) * se / 10;
      total += cSfix[k];
      if (b.extras0.length) {
        for (const xd of b.extras0) {
          if (xd.appliesTo === 'additionalDamageHits' && !cAdd[k]) continue;
          if (xd.model === 'checks') {
            const chk = classChecks(xd)[k];
            if (chk > 0 && fireMods) total += (xd.perCheck ?? 0.5) * chk * sP * extraDamageOnce(xd, fireMods, cHz[k]);
            continue;
          }
          const xHz = xd.elementType ? (cHz[k][xd.elementType] ?? 0) : 0;
          total += cScnt[k] * (xd.chance ?? 1) * ((xd.fixed || 0) + ((xd.element || 0) / 10) * (xHz / 100));
        }
      }
    }
    for (let box = 0; box < 8; box++) {
      const kPhys = bP[box];
      const kEl = bE[box];
      if (kPhys === 0 && kEl === 0) continue;
      const canCrit = box >= 4;
      if (!canCrit) {
        // 会心しないヒット: 会心率に関係なく E[攻撃力] × 係数
        for (let x = 0; x < n; x++) {
          total += (wAtk * dM[x] + dA[x]) * kPhys;
          if (kEl > 0) total += (elemBase * dEM[x] + dEA[x]) * kEl;
        }
        continue;
      }
      const off = (box & 1 ? b.wpa0 : 0) + (box & 2 ? b.wa0 : 0);
      for (let x = 0; x < n; x++) {
        const a = wAff + dV[x] + off;
        const aff = a < affLo ? affLo : (a > affHi ? affHi : a);
        const pr = aff / 100;
        const critExp = pr >= 0 ? 1 + pr * (critMul - 1) : 1 + -pr * (critNeg - 1);
        // E[攻撃力 × 1{会心率 = v}] = 武器攻撃力 × E[乗算の積 ×1] + E[加算の和 ×1] (上限に当たらないとき)
        total += (wAtk * dM[x] + dA[x]) * kPhys * critExp;
        if (kEl > 0) {
          const critE = cem ? 1 + (aff > 0 ? aff : 0) / 100 * (cem - 1) : 1;
          total += (elemBase * dEM[x] + dEA[x]) * kEl * critE;
        }
      }
    }
    return total;
  }

  function evaluate(levels) {
    evals++;
    // 発動するスキル (resolveSkills と同じ: Lv>0・対応・必要なスキルあり)
    let mask = 0;
    gseen.fill(0);
    for (let r = 0; r < R; r++) {
      present[r] = levels[r] > 0 && supported[r] ? 1 : 0;
    }
    for (let r = 0; r < R; r++) {
      if (!present[r]) continue;
      const q = requires[r];
      if (q === -2 || (q >= 0 && !(levels[q] > 0))) present[r] = 0;
    }
    for (let r = 0; r < R; r++) {
      const g = groupKeyOf[r];
      if (present[r] && g != null && !gseen[g]) { gseen[g] = 1; mask += 2 ** g; }
    }
    let key = mask * 256;
    for (let i = 0; i < srcIdx.length; i++) if (levels[srcIdx[i]] > 0) key += 2 ** i;
    let ps = patCache.get(key);
    if (!ps) {
      if (patCache.size >= PATTERN_CACHE_MAX) patCache.clear();
      ps = patternsFor(levels);
      patCache.set(key, ps);
    }

    // 斬れ味
    const colorIdx = sharpFn ? SHARPNESS_ORDER.indexOf(sharpFn(hIdx >= 0 ? levels[hIdx] : 0) || 'white') : fixedColorIdx;
    const sh = sharpTable[colorIdx];

    // 条件なしの効果を先にまとめる
    let am0 = buffs.attackMul ?? 1, aa0 = buffs.attackAdd ?? 0, af0 = buffs.affinityAdd ?? 0, cm0 = NaN;
    let em0 = buffs.elementMul ?? 1, ea0 = buffs.elementAdd ?? 0, wpa0 = 0, wa0 = 0, wpmin0 = NaN, cem0 = NaN;
    let hpm0 = 1, hpmax0 = NaN, jm0 = 1, lsm0 = 1, lsc0 = -1, fm0 = 1, fa0 = 0;
    const extras0 = [];
    const condList = [];
    for (let r = 0; r < R; r++) {
      if (!present[r]) continue;
      const row = tab[r][levels[r] > 7 ? 7 : levels[r]];
      if (groupKeyOf[r] != null) { condList.push(r); continue; }
      const c = row.main.c;
      am0 *= c[C_AMUL]; aa0 += c[C_AADD]; af0 += c[C_AFF];
      if (!Number.isNaN(c[C_CRIT])) cm0 = Number.isNaN(cm0) ? c[C_CRIT] : Math.max(cm0, c[C_CRIT]);
      em0 *= c[C_EMUL]; ea0 += c[C_EADD]; wpa0 += c[C_WPA]; wa0 += c[C_WA];
      if (!Number.isNaN(c[C_WPMIN])) wpmin0 = c[C_WPMIN];
      if (!Number.isNaN(c[C_CEM])) cem0 = Number.isNaN(cem0) ? c[C_CEM] : Math.max(cem0, c[C_CEM]);
      if (!Number.isNaN(c[C_HPM]) && c[C_HPM] > hpm0) { hpm0 = c[C_HPM]; hpmax0 = c[C_HPMAX]; }
      jm0 *= c[C_JUMP];
      if (!Number.isNaN(c[C_LSM]) && c[C_LSM] >= lsm0) { lsm0 = c[C_LSM]; lsc0 = c[C_LSC]; }
      fm0 *= c[C_FMUL]; fa0 += c[C_FADD];
      if (row.main.extra) extras0.push(row.main.extra);
    }
    if (Number.isNaN(cem0)) cem0 = 0;

    // ---- 速い道: 条件つきスキルが単純で、攻撃・属性の上限に当たらないなら、会心率の分布の畳み込みで厳密に出す
    let fast = !forceSlow;
    for (let i = 0; fast && i < condList.length; i++) if (complexCond[condList[i]]) fast = false;
    if (fast) {
      const v = fastPath(ps, levels, condList, {
        am0, aa0, af0, cm0, em0, ea0, wpa0, wa0, wpmin0, cem0, hpm0, hpmax0, jm0, lsm0, lsc0, fm0, fa0, extras0, colorIdx, sh,
      });
      if (v !== null) return v;
    }
    slowCount++;
    let total = 0;
    const pats = ps.pats || productPatterns(ps);
    // 全パターンは小さいときだけ覚える (大きいものを覚えるとメモリを食う。遅い道はまれ)
    if (!ps.pats && pats.length <= SLOW_KEEP_PATTERNS) ps.pats = pats;
    for (let pi = 0; pi < pats.length; pi++) {
      const p = pats[pi];
      let am = am0, aa = aa0, af = af0, cm = cm0, em = em0, ea = ea0, wpa = wpa0, wa = wa0, wpmin = wpmin0, cem = cem0;
      let hpm = hpm0, hpmax = hpmax0, jm = jm0, lsm = lsm0, lsc = lsc0, fm = fm0, fa = fa0;
      let extras = extras0;
      for (let i = 0; i < condList.length; i++) {
        const r = condList[i];
        const row = tab[r][levels[r] > 7 ? 7 : levels[r]];
        const s = p.st[ps.gposByKey[groupKeyOf[r]]];
        let ch = row.byState[s];
        if (!ch) { if (actStatesOf[r].includes(s)) ch = row.main; else continue; }
        const c = ch.c;
        am *= c[C_AMUL]; aa += c[C_AADD]; af += c[C_AFF];
        if (!Number.isNaN(c[C_CRIT])) cm = Number.isNaN(cm) ? c[C_CRIT] : Math.max(cm, c[C_CRIT]);
        em *= c[C_EMUL]; ea += c[C_EADD]; wpa += c[C_WPA]; wa += c[C_WA];
        if (!Number.isNaN(c[C_WPMIN])) wpmin = c[C_WPMIN];
        if (!Number.isNaN(c[C_CEM])) cem = Math.max(cem, c[C_CEM]);
        if (!Number.isNaN(c[C_HPM]) && c[C_HPM] > hpm) { hpm = c[C_HPM]; hpmax = c[C_HPMAX]; }
        jm *= c[C_JUMP];
        if (!Number.isNaN(c[C_LSM]) && c[C_LSM] >= lsm) { lsm = c[C_LSM]; lsc = c[C_LSC]; }
        fm *= c[C_FMUL]; fa += c[C_FADD];
        if (ch.extra) { if (extras === extras0) extras = extras0.slice(); extras.push(ch.extra); }
      }
      // computeStats
      const fireMods = { fireMul: fm, fireAdd: fa };
      const attack = wAtk * Math.min(am, atkMulCap) + Math.min(aa, atkAddCap);
      const affBase = wAff + af;
      const critMul = Number.isNaN(cm) ? critBase : cm;
      const element = elemental && elemBase ? elemBase * Math.min(em, elMulCap) + Math.min(ea, elAddCap) : 0;
      const wpMin = Number.isNaN(wpmin) ? wpMinRule : wpmin;
      const hardMax = Number.isNaN(hpmax) ? hardMaxRule : hpmax;
      const lowOn = lsm !== 1 && lsc >= 0 && colorIdx <= lsc;
      let sub = 0;
      for (let k = 0; k < nClass; k++) {
        const physHz = cPhysHz[k];
        let a = affBase;
        if (physHz >= wpMin) a += wpa;
        if (cWound[k]) a += wa;
        const aff = a < affLo ? affLo : (a > affHi ? affHi : a);
        const sp = cSharp[k] ? sh.physical : 1;
        const se = cSharp[k] ? sh.element : 1;
        let critExp = 1;
        if (cCrit[k]) {
          const pr = aff / 100;
          critExp = pr >= 0 ? 1 + pr * (critMul - 1) : 1 + -pr * (critNeg - 1);
        }
        let physMul = 1;
        if (hpm !== 1 && physHz <= hardMax) physMul *= hpm;
        if (cHien[k]) physMul *= jm;
        if (lowOn) physMul *= lsm;
        let d = attack * (cSmv[k] / 100) * (physHz / 100) * sp * critExp * physMul + cSfix[k];
        if (cSrate[k] > 0 && element > 0) {
          let critE = 1;
          if (cCrit[k] && cem) critE = 1 + (aff > 0 ? aff : 0) / 100 * (cem - 1);
          d += (element / 10) * cSrate[k] * (cElemHz[k] / 100) * se * critE;
        }
        if (extras.length) {
          for (const x of extras) {
            if (x.appliesTo === 'additionalDamageHits' && !cAdd[k]) continue;
            if (x.model === 'checks') {
              const chk = classChecks(x)[k];
              if (chk > 0) d += (x.perCheck ?? 0.5) * chk * extraDamageOnce(x, fireMods, cHz[k]);
              continue;
            }
            const xHz = x.elementType ? (cHz[k][x.elementType] ?? 0) : 0;
            d += cScnt[k] * (x.chance ?? 1) * ((x.fixed || 0) + ((x.element || 0) / 10) * (xHz / 100));
          }
        }
        sub += d;
      }
      total += p.w * sub;
    }
    return total;
  }

  return {
    evaluate, R, ids, classes: nClass,
    get evals() { return evals; },
    get slowEvals() { return slowCount; },
    get patternSets() { return patCache.size; },
  };
}
