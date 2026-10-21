// 探索の本体 (docs/SEARCH_DESIGN.md 2.4〜2.6 節): 絞り込み + ビーム + 深さ優先の分枝限定 (B&B) + 厳密な仕上げ。
//
// 木: 武器 (武器も探すときだけ) → 護石 → 防具 5 部位 (partOrder の順) → 葉: 装飾品を詰める (武器用の珠の組 × 防具用の珠)。
// 上界 = いまの Lv での正確な期待値 f(L0) + 「残りの部位・護石・珠で足せる Lv」の増え方の和 (ナップサック。防具用の珠は
//        入れ子のスロットなので貪欲で最適)。増え方の表は problem.js の gainTable。
//
// mode 'fast' (画面で使う。2.5 節の順):
//   beam1 (幅 60。表は「武器の Lv と、シリーズ/グループ以外を最大の半分」の所で測る) → beam2 (幅 200。表はいまの最良の所で測り直す)
//   → polish1 (上位 2K 件の葉を厳密に解き直して並べ直す。ここで途中の結果 partialReady)
//   → dfs (近似の上界の深さ優先。予算まで) → polish2 (dfs で入ったものを厳密に解き直す) → 終わり
// mode 'exact': 保証のある表 (全スキル最大の所で、上限を外した評価器で測る) で深さ優先 1 回。小さい問題では総当たりと一致する。
// objective 'none' (泣シミュ型): 必須スキルを満たす構成を K 件集める。上界は「満たせるか」だけ。
//
// step(ms) で時間を区切って進める (Web Worker から少しずつ呼ぶと、途中経過を出せて、中止も受け付けられる)。
// import は相対パスだけ。
import { ARMOR_PARTS } from '../build.js';
import { gainTable, concaveSlopes } from './problem.js';

const NEG = -Infinity;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** 覚え (メモリ) の上限: 葉の珠詰めの覚えの合計件数・武器側の増え方の覚え・葉の表の数 (武器ごと) */
export const MEMO_LIMITS = Object.freeze({ leafMemo: 60000, weaponGain: 20000, leafTables: 64 });

export class BnbSolver {
  /**
   * @param P prepare() の結果
   * @param o {
   *   mode: 'fast' | 'exact', objective: 'damage' | 'none', K (既定 P.K), M (厳密に解き直す候補の数。既定 2K),
   *   beam: [幅, ...] (fast。既定 [60, 200]), margin (fast の刈り込みの余裕。既定 0.01),
   *   budget: {ms, activeMs, work} (dfs を打ち切る。ms = 始めてからの時間、activeMs = 計算した時間の合計、
   *            work = dfs の中で上界を求めた回数。どれも無ければ最後まで), minDfsMs (dfs を最低これだけ回す。既定 300),
   *   stopAfter: 'partial' (polish1 で止める), partOrder, maxSolutions (none で集める数。既定 K), eps (exact で刈る許し)
   * }
   */
  constructor(P, o = {}) {
    this.P = P;
    this.o = o;
    this.mode = o.mode || 'fast';
    this.objective = o.objective || 'damage';
    this.none = this.objective === 'none';
    this.K = o.K ?? P.K;
    this.M = this.mode === 'fast' && !this.none ? (o.M ?? this.K * 2) : this.K;
    this.eps = o.eps || 0;
    this.margin = this.mode === 'fast' && !this.none ? (o.margin ?? 0.01) : 0;
    this.list = []; // 上位 (fast では M 件。exact が false のものは近似の葉の値 = 下限)
    this.keys = new Map();
    this.stats = {
      nodes: 0, boundCalls: 0, leaves: 0, decoCalls: 0, decoMemo: 0, decoNodes: 0, weaponsSkipped: 0,
      solutions: 0, pieceSolutions: 0, firstSolutionMs: null, memoClears: 0, leafTables: 0, phases: [],
    };
    this.partOrder = o.partOrder || [...ARMOR_PARTS];
    this.done = false;
    this.started = false;
    this.partialReady = false;
    this.dfsFinished = false;
    this.infeasible = false;
    this.cut = false;
    this.activeMs = 0;
    const R = P.R;
    this.raw = new Int16Array(R);
    this.L = new Int8Array(R);
    this.setCnt = new Int8Array(P.sets.length);
    this.grpCnt = new Int8Array(P.groups.length);
    this.slot = [0, 0, 0, 0];
    this.wSlot = 0;
    this.chosen = new Array(6).fill(-1);
    const sparse = (lv) => { const a = []; for (let r = 0; r < R; r++) if (lv[r]) a.push(r, lv[r]); return a; };
    this.partCls = this.partOrder.map((p) => P.parts[p].map((c) => ({ ...c, sk: sparse(c.lv) })));
    this.charmCls = P.charms.map((c) => ({ ...c, sk: sparse(c.lv) }));
    this.armorR = [];
    this.weaponR = [];
    this.reqR = [];
    for (let r = 0; r < R; r++) {
      if (P.kind[r] === 'armor' && P.armorDeco[r]) this.armorR.push(r);
      if (P.kind[r] === 'weapon') this.weaponR.push(r);
      if (P.reqLv[r] > 0) this.reqR.push(r);
    }
    this.armorSz = Int8Array.from(this.armorR.map((r) => P.armorDeco[r].slot));
    this.partMaxLv = this.partCls.map((cls) => { const m = new Int8Array(R); for (const c of cls) for (let r = 0; r < R; r++) if (c.lv[r] > m[r]) m[r] = c.lv[r]; return m; });
    this.partMaxSlots = this.partCls.map((cls) => [0, 1, 2].map((i) => Math.max(0, ...cls.map((c) => c.slots[i]))));
    this.charmMaxLv = new Int8Array(R);
    for (const c of this.charmCls) for (let r = 0; r < R; r++) if (c.lv[r] > this.charmMaxLv[r]) this.charmMaxLv[r] = c.lv[r];
    this.charmMaxSlots = [0, 1, 2].map((i) => Math.max(0, ...this.charmCls.map((c) => c.slots[i])));
    this.charmMaxW = Math.max(0, ...this.charmCls.map((c) => c.wSlot));
    this.partHasSet = this.partCls.map((cls) => P.sets.map((_, s) => cls.some((c) => c.sIdx.includes(s))));
    this.partHasGrp = this.partCls.map((cls) => P.groups.map((_, g) => cls.some((c) => c.gIdx === g)));
    // シリーズ/グループスキルの必須 (珠では埋められない): r → そのスキルを出すシリーズ/グループ
    this.reqSG = this.reqR.filter((r) => P.kind[r] === 'set' || P.kind[r] === 'group').map((r) => ({
      r, sets: P.sets.map((s, i) => (s.r === r ? i : -1)).filter((i) => i >= 0),
      groups: P.groups.map((g, i) => (g.r === r ? i : -1)).filter((i) => i >= 0),
    }));
    this.leafExact = this.mode === 'exact';
    this.memoSize = 0;
    this.wws = P.weapons.map(() => ({ gt: null, memoA: new Map(), memoE: new Map(), leafCache: new Map() }));
  }

  // ---------------------------------------------------------------- 上位の並び
  /** 刈るしきい値 = K 番目の値。fast は仕上げの候補を残すため少し下げる (margin) */
  threshold() {
    if (this.polishing || this.list.length < this.K) return NEG;
    const v = this.list[this.K - 1].value;
    return this.margin ? v * (1 - this.margin) : v;
  }
  prune(ub, extra = NEG) {
    const t = Math.max(this.threshold(), extra);
    return ub * (1 - this.eps) <= t + Math.abs(t) * 1e-12;
  }
  keyOf(e) { return `${e.wi}|${e.charm}|${e.parts.join(',')}`; }
  insert(e) {
    const k = this.keyOf(e);
    const old = this.keys.get(k);
    if (old) { if (old.value >= e.value) return; this.list.splice(this.list.indexOf(old), 1); }
    let i = this.list.length;
    while (i > 0 && this.list[i - 1].value < e.value) i--;
    this.list.splice(i, 0, e);
    this.keys.set(k, e);
    while (this.list.length > this.M) this.keys.delete(this.keyOf(this.list.pop()));
  }
  get top() { return this.list.slice(0, this.K); }

  // ---------------------------------------------------------------- 状態
  setWeapon(wi) {
    const P = this.P;
    const wp = P.weapons[wi];
    this.wi = wi; this.wp = wp; this.ws = this.wws[wi];
    this.gt = this.ws.gt;
    this.raw.fill(0); this.setCnt.fill(0); this.grpCnt.fill(0); this.slot = [0, 0, 0, 0]; this.wSlot = 0;
    for (let r = 0; r < P.R; r++) this.raw[r] = wp.lv[r];
    for (const s of wp.sIdx) this.setCnt[s]++;
    if (wp.gIdx >= 0) this.grpCnt[wp.gIdx]++;
    this.chosen.fill(-1);
  }
  applyCharm(c, sign) {
    for (let i = 0; i < c.sk.length; i += 2) this.raw[c.sk[i]] += sign * c.sk[i + 1];
    for (let s = 1; s <= 3; s++) this.slot[s] += sign * c.slotCount[s];
    this.wSlot = sign > 0 ? c.wSlot : 0;
  }
  applyPiece(c, sign) {
    for (let i = 0; i < c.sk.length; i += 2) this.raw[c.sk[i]] += sign * c.sk[i + 1];
    for (let s = 1; s <= 3; s++) this.slot[s] += sign * c.slotCount[s];
    for (const s of c.sIdx) this.setCnt[s] += sign;
    if (c.gIdx >= 0) this.grpCnt[c.gIdx] += sign;
  }
  applyAt(d, idx, sign = +1) {
    if (d === 0) this.applyCharm(this.charmCls[idx], sign); else this.applyPiece(this.partCls[d - 1][idx], sign);
    this.chosen[d] = sign > 0 ? idx : -1;
  }
  /** 状態 {wi, charm, parts} を当てはめ直す (parts の -1 は未決) */
  load(st) {
    this.setWeapon(st.wi);
    if (st.charm >= 0) this.applyAt(0, st.charm);
    st.parts.forEach((k, i) => { if (k >= 0) this.applyAt(i + 1, k); });
  }

  levels() {
    const P = this.P; const L = this.L; const raw = this.raw;
    for (let r = 0; r < P.R; r++) L[r] = raw[r];
    for (let s = 0; s < P.sets.length; s++) {
      const c = this.setCnt[s]; if (!c) continue;
      let lv = 0; for (const rk of P.sets[s].ranks) if (c >= rk.pieces) lv = Math.max(lv, rk.level);
      L[P.sets[s].r] += lv;
    }
    for (let g = 0; g < P.groups.length; g++) if (this.grpCnt[g] >= P.groups[g].pieces) L[P.groups[g].r] += P.groups[g].level;
    for (let r = 0; r < P.R; r++) if (L[r] > P.maxLv[r]) L[r] = P.maxLv[r];
    return L;
  }
  hatSum(r, base, n) {
    const h = this.gt.hat[r][base > this.P.maxLv[r] ? this.P.maxLv[r] : base];
    let s = 0; const m = Math.min(n, h.length);
    for (let i = 0; i < m; i++) s += h[i];
    return s;
  }
  wsList(chSlot) {
    const m = this.ws.wsl || (this.ws.wsl = new Map());
    let l = m.get(chSlot);
    if (!l) {
      l = this.P.weaponSide([...this.wp.slots, ...(chSlot > 0 ? [chSlot] : [])].sort((a, b) => b - a), this.wp.mask, this.wp.maskKey);
      m.set(chSlot, l);
    }
    return l;
  }

  /**
   * 必須スキルの Lv を差し替えて、最初の上界で満たせる見込みがあるか (満たせない説明を作るため。docs/SEARCH_DESIGN.md 2.8 節)。
   * false なら本当に満たせない (上界はゆるいので、true でも満たせるとは限らない)。
   * @param reqLv Int8Array (P.reqLv と同じ並び)
   */
  rootFeasible(reqLv) {
    const P = this.P;
    const save = { reqLv: P.reqLv, reqR: this.reqR, reqSG: this.reqSG, none: this.none, phase: this.phase };
    P.reqLv = reqLv;
    this.reqR = [];
    for (let r = 0; r < P.R; r++) if (reqLv[r] > 0) this.reqR.push(r);
    this.reqSG = save.reqSG.filter((q) => reqLv[q.r] > 0);
    this.none = true;
    this.phase = null;
    try {
      return P.weapons.some((_, wi) => { this.setWeapon(wi); return this.bound(false, 0) > NEG; });
    } finally {
      P.reqLv = save.reqLv; this.reqR = save.reqR; this.reqSG = save.reqSG; this.none = save.none; this.phase = save.phase;
      this.needRestore = true;
    }
  }

  // ---------------------------------------------------------------- 上界
  /**
   * シリーズ/グループスキルの必須を、残りの部位で満たせるか (docs/SEARCH_DESIGN.md 2.8 節)。
   * シリーズごとに「いまの部位数 + 残りの部位のうちそのシリーズを持つ類がある部位の数」で届く段を見る (部位の取り合いは見ない
   * ゆるい判定なので、満たせる枝を捨てることは無い)。
   */
  setGroupFeasible(from) {
    const P = this.P;
    for (const q of this.reqSG) {
      let lv = 0;
      for (const s of q.sets) {
        let avail = 0;
        for (let pi = from; pi < 5; pi++) if (this.partHasSet[pi][s]) avail++;
        const n = this.setCnt[s] + avail;
        let best = 0;
        for (const rk of P.sets[s].ranks) if (n >= rk.pieces) best = Math.max(best, rk.level);
        lv += best;
      }
      for (const g of q.groups) {
        let avail = 0;
        for (let pi = from; pi < 5; pi++) if (this.partHasGrp[pi][g]) avail++;
        if (this.grpCnt[g] + avail >= P.groups[g].pieces) lv += P.groups[g].level;
      }
      // 防具・護石に付いている分 (ふつうは無い)
      lv += this.raw[q.r];
      if (Math.min(lv, P.maxLv[q.r]) < P.reqLv[q.r]) return false;
    }
    return true;
  }

  /** 必須スキルのうち珠で埋める分 [r, Lv, ...] と武器スキルの不足。満たせないなら null */
  requiredNeeds(L, charmDone, from, pessimistic) {
    const P = this.P;
    const forced = [];
    let wNeed = null;
    for (const r of this.reqR) {
      const k = P.kind[r];
      if (k === 'set' || k === 'group') continue; // setGroupFeasible で見る
      let opt = L[r];
      for (let pi = from; pi < 5; pi++) opt += this.partMaxLv[pi][r];
      if (!charmDone) opt += this.charmMaxLv[r];
      // 珠で埋められない防具スキルは、残りの部位と護石で届くかだけを見る
      if (k === 'armor' && !P.armorDeco[r]) { if (opt < P.reqLv[r]) return null; continue; }
      const need = P.reqLv[r] - (pessimistic ? L[r] : opt);
      if (need <= 0) continue;
      if (k === 'weapon') { (wNeed || (wNeed = [])).push(r, need); continue; }
      forced.push(r, need);
    }
    return { forced, wNeed };
  }

  /** いまの状態 (護石を選んだか charmDone、残りの部位 = partOrder[from..4]) の上界。満たせないなら -Infinity */
  bound(charmDone, from) {
    const P = this.P;
    this.stats.boundCalls++;
    const L = this.levels();
    if (this.reqSG.length && !this.setGroupFeasible(from)) return NEG;
    const budget = [0, this.slot[1], this.slot[2], this.slot[3]];
    for (let pi = from; pi < 5; pi++) for (const x of this.partMaxSlots[pi]) if (x > 0) budget[x]++;
    if (!charmDone) for (const x of this.charmMaxSlots) if (x > 0) budget[x]++;
    // ビームの並べ替え (近似) では、必須スキルを残りの部位が持ってくれる見込みを入れない (珠で埋める前提で評価する)。
    // ただしそれで珠が入りきらないときは、見込みを入れて「満たせるか」だけは正しく見る (ビームで満たせる枝を捨てない)
    const pessimistic = !!(this.phase && this.phase.startsWith('beam'));
    let need = this.reqR.length ? this.requiredNeeds(L, charmDone, from, pessimistic) : { forced: [], wNeed: null };
    if (!need) return NEG;
    const wOk = (nd) => !nd.wNeed || this.wsList(charmDone ? this.wSlot : this.charmMaxW).some((w) => {
      for (let i = 0; i < nd.wNeed.length; i += 2) if (w.vec[nd.wNeed[i]] < nd.wNeed[i + 1]) return false;
      return true;
    });
    if (this.none) {
      if (wOk(need) && this.forcedFeasible(need.forced, budget)) return Infinity;
      if (!pessimistic) return NEG;
      need = this.requiredNeeds(L, charmDone, from, false);
      return need && wOk(need) && this.forcedFeasible(need.forced, budget) ? Infinity : NEG;
    }
    let g = wOk(need) ? this.decoGreedy(L, budget, need.forced) : NEG;
    if (g === NEG && pessimistic && this.reqR.length) {
      need = this.requiredNeeds(L, charmDone, from, false);
      if (!need || !wOk(need)) return NEG;
      g = this.decoGreedy(L, budget, need.forced);
    }
    if (g === NEG) return NEG;
    const f0 = this.wp.ev.evaluate(L);
    let gain = 0;
    if (!charmDone) {
      let best = 0;
      for (const c of this.charmCls) {
        let v = 0;
        for (let i = 0; i < c.sk.length; i += 2) v += this.hatSum(c.sk[i], L[c.sk[i]], c.sk[i + 1]);
        if (v > best) best = v;
      }
      gain += best;
    }
    gain += this.weaponGain(charmDone ? this.wSlot : this.charmMaxW, L);
    const setCredit = this.setCredits(L, from);
    const grpCredit = this.groupCredits(L, from);
    for (let pi = from; pi < 5; pi++) {
      let best = 0;
      for (const c of this.partCls[pi]) {
        let v = 0;
        for (let i = 0; i < c.sk.length; i += 2) v += this.hatSum(c.sk[i], L[c.sk[i]], c.sk[i + 1]);
        for (const s of c.sIdx) v += setCredit[s];
        if (c.gIdx >= 0) v += grpCredit[c.gIdx];
        if (v > best) best = v;
      }
      gain += best;
    }
    return f0 + gain + g;
  }

  forcedFeasible(forced, budget) {
    const c = [0, 0, 0, 0];
    for (let i = 0; i < forced.length; i += 2) c[this.P.armorDeco[forced[i]].slot] += forced[i + 1];
    return c[3] <= budget[3] && c[3] + c[2] <= budget[3] + budget[2] && c[1] + c[2] + c[3] <= budget[1] + budget[2] + budget[3];
  }

  /** 防具用の珠の増え方の上界 (貪欲)。forced = [r, 必要 Lv, ...] は先に入れる。入らなければ -Infinity */
  decoGreedy(L, budget, forced) {
    const P = this.P;
    const c = [0, 0, 0, 0];
    let v = 0;
    const used = this._used || (this._used = new Int8Array(P.R));
    used.fill(0);
    for (let i = 0; i < forced.length; i += 2) {
      const r = forced[i]; const n = forced[i + 1];
      c[P.armorDeco[r].slot] += n; used[r] = n;
      v += this.hatSum(r, L[r], n);
    }
    const B3 = budget[3], B23 = budget[3] + budget[2], B123 = budget[1] + budget[2] + budget[3];
    if (!(c[3] <= B3 && c[3] + c[2] <= B23 && c[1] + c[2] + c[3] <= B123)) return NEG;
    // 値の大きい順に入れる貪欲。スキルごとの増え方 (凹の上包みの傾き) は大きい順に並んでいるので、並べ替えずに
    // スキルの先頭どうしを比べて取る (入れ子のスロットへの割り当ては matroid なので、同じ値の取り方の順で合計は変わらない)。
    // 入らなかった大きさの珠は、後の珠も入らない (空きは減るだけ) ので、その大きさごと閉じる
    const nA = this.armorR.length;
    const heads = this._heads || (this._heads = new Array(nA));
    const pos = this._pos || (this._pos = new Int8Array(nA));
    for (let k = 0; k < nA; k++) {
      const r = this.armorR[k];
      const base = L[r] + used[r];
      heads[k] = this.gt.hat[r][base > P.maxLv[r] ? P.maxLv[r] : base];
      pos[k] = 0;
    }
    let free = B123 - c[1] - c[2] - c[3];
    let open3 = true, open2 = true;
    while (free > 0) {
      let bk = -1, bv = 0;
      for (let k = 0; k < nA; k++) {
        const h = heads[k];
        const j = pos[k];
        if (j >= h.length || !(h[j] > bv)) continue;
        const sz = this.armorSz[k];
        if ((sz === 3 && !open3) || (sz === 2 && !open2)) continue;
        bk = k; bv = h[j];
      }
      if (bk < 0) break;
      const sz = this.armorSz[bk];
      if (sz === 3) { if (c[3] + 1 > B3 || c[3] + c[2] + 1 > B23) { open3 = false; continue; } c[3]++; }
      else if (sz === 2) { if (c[3] + c[2] + 1 > B23) { open2 = false; open3 = false; continue; } c[2]++; }
      else c[1]++;
      v += bv; pos[bk]++; free--;
    }
    return v;
  }

  weaponGain(chSlot, L) {
    // 武器スキルは防具で変わらないので、(武器・護石の武器用スロット・武器スキルの Lv・表) ごとに覚える
    let key = chSlot;
    for (const r of this.weaponR) key = key * 8 + L[r];
    const cache = this.gt.wg || (this.gt.wg = new Map());
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const v = this.weaponGain0(chSlot, L);
    if (cache.size >= MEMO_LIMITS.weaponGain) cache.clear();
    cache.set(key, v);
    return v;
  }
  weaponGain0(chSlot, L) {
    let best = 0;
    for (const w of this.wsList(chSlot)) {
      let v = 0;
      for (const r of this.weaponR) if (w.vec[r]) v += this.hatSum(r, L[r], w.vec[r]);
      if (v > best) best = v;
    }
    return best;
  }

  setCredits(L, from) {
    const P = this.P;
    // 入れ物は使い回す (bound の中で呼ばれ、次に呼ぶまでに読み終える)
    const out = this._setBuf || (this._setBuf = new Float64Array(P.sets.length));
    out.fill(0);
    for (let s = 0; s < P.sets.length; s++) {
      const S = P.sets[s];
      let avail = 0;
      for (let pi = from; pi < 5; pi++) if (this.partHasSet[pi][s]) avail++;
      if (!avail) continue;
      const c = this.setCnt[s];
      let cur = 0; for (const rk of S.ranks) if (c >= rk.pieces) cur = Math.max(cur, rk.level);
      for (const rk of S.ranks) {
        if (rk.pieces <= c || rk.pieces - c > avail || rk.level <= cur) continue;
        const v = this.hatSum(S.r, L[S.r], rk.level - cur) / (rk.pieces - c);
        if (v > out[s]) out[s] = v;
      }
    }
    return out;
  }
  groupCredits(L, from) {
    const P = this.P;
    const out = this._grpBuf || (this._grpBuf = new Float64Array(P.groups.length));
    out.fill(0);
    for (let g = 0; g < P.groups.length; g++) {
      const G = P.groups[g];
      const c = this.grpCnt[g];
      if (c >= G.pieces) continue;
      let avail = 0;
      for (let pi = from; pi < 5; pi++) if (this.partHasGrp[pi][g]) avail++;
      if (G.pieces - c > avail) continue;
      out[g] = this.hatSum(G.r, L[G.r], G.level) / (G.pieces - c);
    }
    return out;
  }

  // ---------------------------------------------------------------- 葉: 装飾品を詰める
  /**
   * 葉の箱 (珠だけ動く) の保証のある表: 箱の上 = 武器スキルは武器用の珠の組で届く最大、珠のある防具スキルは最大 Lv、
   * それ以外はいまの Lv。上限を外した評価器で測る。箱の上が同じ葉 (兄弟の多く) は使い回す。
   */
  leafTable(L0) {
    const P = this.P;
    const top = Int8Array.from(L0);
    for (const w of this.wsList(this.wSlot)) for (const r of this.weaponR) top[r] = Math.max(top[r], Math.min(P.maxLv[r], L0[r] + w.vec[r]));
    for (const r of this.armorR) top[r] = P.maxLv[r];
    const key = top.join(',');
    const hit = this.ws.leafCache.get(key);
    if (hit) return hit;
    this.stats.leafTables++;
    const delta = []; const hat = [];
    for (let r = 0; r < P.R; r++) {
      const free = P.kind[r] === 'weapon' || (P.kind[r] === 'armor' && P.armorDeco[r]);
      if (!free) { delta.push(null); hat.push(null); continue; }
      const ev = P.touchesAffinity[r] ? this.wp.evU : this.wp.evA;
      const row = new Float64Array(P.maxLv[r]);
      for (let j = 0; j < P.maxLv[r]; j++) {
        const a = top.slice(); a[r] = j + 1;
        const b = top.slice(); b[r] = j;
        row[j] = Math.max(0, ev.evaluate(a) - ev.evaluate(b));
      }
      delta.push(row);
      const h = [];
      for (let base = 0; base <= P.maxLv[r]; base++) h.push(concaveSlopes(row, base));
      hat.push(h);
    }
    const t = { delta, hat };
    if (this.ws.leafCache.size >= MEMO_LIMITS.leafTables) this.ws.leafCache.clear();
    this.ws.leafCache.set(key, t);
    return t;
  }

  /** 葉の覚えを足す (合計が上限を超えたら全部の武器の覚えを忘れる) */
  memoSet(memo, key, val) {
    if (!memo.has(key)) {
      if (this.memoSize >= MEMO_LIMITS.leafMemo) {
        for (const ws of this.wws) { ws.memoA.clear(); ws.memoE.clear(); }
        this.memoSize = 0;
        this.stats.memoClears++;
      }
      this.memoSize++;
    }
    memo.set(key, val);
  }

  /**
   * いまの装備で、武器用の珠の組 × 防具用の珠を選んで最大にする。exact なら保証のある葉の表で厳密、
   * そうでなければ近似の表で刈る (実際に入る詰め方なので下限)。しきい値以下なら null。
   * @returns {{value, ws, deco: Int8Array, exact}|null}
   */
  decoOpt(exact, T = this.threshold()) {
    const P = this.P;
    this.stats.decoCalls++;
    const none = this.none;
    const L0 = Int8Array.from(this.levels());
    const budget = [0, this.slot[1], this.slot[2], this.slot[3]];
    const key = `${L0.join(',')}|${budget.join(',')}|${this.wSlot}`;
    const memo = exact ? this.ws.memoE : this.ws.memoA;
    // 実際に刈るしきい値 (覚えるときも、使うときもこれで比べる)
    const E = Math.max(this.threshold(), T);
    const m = memo.get(key);
    if (m) {
      if (m.sol) { this.stats.decoMemo++; return m.sol; }
      if (m.infeasible || m.below <= E) { this.stats.decoMemo++; return null; }
      // 前より低いしきい値なので解き直す
    }
    let best = NEG; let bestSol = null;
    const lim = () => Math.max(T, best);
    const gtSave = this.gt;
    if (exact && !none) this.gt = this.leafTable(L0);
    try {
      const f0 = none ? 0 : this.wp.ev.evaluate(L0);
      const wl = this.wsList(this.wSlot).map((w) => {
        let v = 0;
        if (!none) for (const r of this.weaponR) if (w.vec[r]) v += this.hatSum(r, L0[r], w.vec[r]);
        return { w, v };
      }).sort((a, b) => b.v - a.v);
      const forced = [];
      for (const r of this.reqR) {
        if (P.kind[r] !== 'armor') continue;
        const need = P.reqLv[r] - L0[r];
        if (need > 0) { if (!P.armorDeco[r]) { this.memoSet(memo, key, { infeasible: true }); return null; } forced.push(r, need); }
      }
      const g0 = none ? 0 : this.decoGreedy(L0, budget, forced);
      if (g0 === NEG || (none && !this.forcedFeasible(forced, budget))) { this.memoSet(memo, key, { infeasible: true }); return null; }
      const L1 = new Int8Array(P.R);
      for (const { w, v } of wl) {
        if (!none && this.prune(f0 + v + g0, lim())) break;
        let ok = true;
        for (const r of this.reqR) if (P.kind[r] === 'weapon' && Math.min(P.maxLv[r], L0[r] + w.vec[r]) < P.reqLv[r]) ok = false;
        if (!ok) continue;
        for (let r = 0; r < P.R; r++) L1[r] = Math.min(P.maxLv[r], L0[r] + w.vec[r]);
        if (!none) {
          const f1 = this.wp.ev.evaluate(L1);
          if (this.prune(f1 + g0, lim())) continue;
        }
        const res = this.armorDfs(L1, budget, forced, lim);
        if (res && res.value > best) { best = res.value; bestSol = { value: res.value, ws: w, deco: res.deco, exact }; }
        if (none && bestSol) break;
      }
    } finally { this.gt = gtSave; }
    this.memoSet(memo, key, bestSol ? { sol: bestSol } : { below: E });
    return bestSol;
  }

  /** 防具用の珠: スキルを 1 つずつ、入れる Lv を多い順に決める。上界 = f(いま) + 残りの貪欲 (並べた品を使い回す) */
  armorDfs(L1, budget, forced, lim) {
    const P = this.P;
    const ev = this.wp.ev;
    const none = this.none;
    const needOf = new Int8Array(P.R);
    for (let i = 0; i < forced.length; i += 2) needOf[forced[i]] = forced[i + 1];
    const hat = this.gt ? this.gt.hat : null;
    const sk = this.armorR.filter((r) => L1[r] < P.maxLv[r] && (needOf[r] > 0 || (!none && hat[r][L1[r]].some((x) => x > 0))))
      .sort((a, b) => (needOf[b] > 0) - (needOf[a] > 0) || (none ? 0 : (hat[b][L1[b]][0] || 0) - (hat[a][L1[a]][0] || 0)));
    const it = [];
    if (!none) {
      for (const r of sk) {
        const h = hat[r][L1[r]];
        for (let j = 0; j < h.length; j++) it.push({ v: h[j], s: P.armorDeco[r].slot, r, j });
      }
      it.sort((x, y) => y.v - x.v);
    }
    const nIt = it.length;
    const iv = new Float64Array(nIt), is = new Int8Array(nIt), ir = new Int16Array(nIt), ij = new Int8Array(nIt);
    it.forEach((x, k) => { iv[k] = x.v; is[k] = x.s; ir[k] = x.r; ij[k] = x.j; });
    const pre = new Map();
    if (!none) for (const r of sk) { const h = hat[r][L1[r]]; const a = [0]; for (let j = 0; j < h.length; j++) a.push(a[j] + h[j]); pre.set(r, a); }
    const decided = new Uint8Array(P.R);
    const L = Int8Array.from(L1);
    const c = [0, 0, 0, 0];
    const deco = new Int8Array(P.R);
    let best = null;
    const B3 = budget[3], B23 = budget[3] + budget[2], B123 = budget[1] + budget[2] + budget[3];
    const okNested = () => c[3] <= B3 && c[3] + c[2] <= B23 && c[1] + c[2] + c[3] <= B123;
    const rest = (i) => {
      let x3 = c[3], x2 = c[2], x1 = c[1];
      let v = 0;
      for (let k = i; k < sk.length; k++) {
        const r = sk[k]; const need = needOf[r];
        if (need > 0) {
          const sz = P.armorDeco[r].slot;
          if (sz === 3) x3 += need; else if (sz === 2) x2 += need; else x1 += need;
          const a = pre.get(r); v += a[Math.min(need, a.length - 1)];
        }
      }
      if (!(x3 <= B3 && x3 + x2 <= B23 && x1 + x2 + x3 <= B123)) return NEG;
      let free = B123 - x1 - x2 - x3;
      for (let k = 0; k < nIt && free > 0; k++) {
        const r = ir[k];
        if (decided[r] || ij[k] < needOf[r]) continue;
        const sz = is[k];
        if (sz === 3) { if (x3 + 1 > B3 || x3 + x2 + 1 > B23) continue; x3++; }
        else if (sz === 2) { if (x3 + x2 + 1 > B23) continue; x2++; }
        else x1++;
        v += iv[k]; free--;
      }
      return v;
    };
    const dfs = (i) => {
      this.stats.decoNodes++;
      if (i === sk.length) {
        const v = none ? 0 : ev.evaluate(L);
        if (!best || v > best.value) best = { value: v, deco: deco.slice() };
        return;
      }
      if (!none) {
        const g = rest(i);
        if (g === NEG) return;
        if (this.prune(ev.evaluate(L) + g, Math.max(lim(), best ? best.value : NEG))) return;
      }
      const r = sk[i]; const s = P.armorDeco[r].slot;
      const room = P.maxLv[r] - L[r];
      let maxN = room;
      for (let n = 0; n <= room; n++) { c[s] += n; const ok = okNested(); c[s] -= n; if (!ok) { maxN = n - 1; break; } }
      const minN = needOf[r];
      if (maxN < minN) return;
      decided[r] = 1;
      // 泣シミュ型は必須の分だけ入れて次へ (余りは問わない)
      const hiN = none ? minN : maxN;
      for (let n = hiN; n >= minN; n--) {
        L[r] += n; c[s] += n; deco[r] = n;
        dfs(i + 1);
        L[r] -= n; c[s] -= n; deco[r] = 0;
        if (none && best) break;
      }
      decided[r] = 0;
    };
    dfs(0);
    if (!best) return null;
    if (!none && this.prune(best.value, lim())) return null;
    return best;
  }

  // ---------------------------------------------------------------- 表
  setTables(ctxOf) {
    const P = this.P;
    if (this.none) return;
    P.weapons.forEach((wp, i) => {
      this.wws[i].gt = this.mode === 'exact'
        ? (this.wws[i].gtValid || (this.wws[i].gtValid = gainTable(P, wp, 'valid')))
        : gainTable(P, wp, 'local', ctxOf(wp, i));
    });
  }
  /** 仮の所: 武器の Lv と、シリーズ/グループ以外を最大の半分 */
  halfContext(wp) {
    const P = this.P;
    const L = new Int8Array(P.R);
    for (let r = 0; r < P.R; r++) {
      L[r] = Math.min(P.maxLv[r], wp.lv[r]);
      if (P.kind[r] !== 'set' && P.kind[r] !== 'group') L[r] = Math.max(L[r], Math.ceil(P.maxLv[r] / 2));
    }
    return L;
  }
  /** 構成の最後の Lv (珠込み) */
  finalLevels(e) {
    this.load(e);
    const L = Int8Array.from(this.levels());
    for (let r = 0; r < this.P.R; r++) L[r] = Math.min(this.P.maxLv[r], L[r] + (e.ws ? e.ws.vec[r] : 0) + e.deco[r]);
    return L;
  }

  record(sol) {
    const e = {
      value: sol.value, exact: !!sol.exact, wi: this.wi, charm: this.chosen[0], parts: this.chosen.slice(1, 6),
      ws: sol.ws, deco: sol.deco, foundMs: now() - this.t0, phase: this.phase,
    };
    if (this.none) {
      this.stats.solutions++;
      let pieces = this.charmCls[e.charm].members.length;
      e.parts.forEach((k, i) => { pieces *= this.partCls[i][k].members.length; });
      this.stats.pieceSolutions += pieces;
      if (this.stats.firstSolutionMs == null) this.stats.firstSolutionMs = e.foundMs;
      if (this.list.length < this.K) this.list.push(e);
      return;
    }
    this.insert(e);
  }

  // ---------------------------------------------------------------- 段階
  start() {
    this.started = true;
    this.t0 = now();
    this.phaseQueue = [];
    if (this.mode === 'fast' && !this.none) {
      const widths = this.o.beam ?? [60, 200];
      widths.forEach((w, i) => this.phaseQueue.push({ name: `beam${i + 1}`, width: w }));
      this.phaseQueue.push({ name: 'polish1' });
      if (this.o.stopAfter !== 'partial') {
        if (this.o.dfs !== false) this.phaseQueue.push({ name: 'dfs' });
        this.phaseQueue.push({ name: 'polish2' });
      }
      this.setTables((wp) => this.halfContext(wp));
    } else {
      this.phaseQueue.push({ name: 'dfs' });
      this.setTables(() => null);
    }
    // 最初の上界で -∞ (どの武器でも必須を満たせない) なら、すぐ「無い」
    const roots = this.P.weapons.map((wp, wi) => { this.setWeapon(wi); return this.bound(false, 0); });
    if (roots.every((ub) => ub === NEG)) {
      this.infeasible = true;
      this.dfsFinished = true;
      this.phaseQueue = [];
    }
    this.nextPhase();
  }

  nextPhase() {
    if (this.phase) this.stats.phases.push({ name: this.phase, endMs: now() - this.t0, best: this.list[0]?.value ?? null });
    if (this.phase === 'polish1') this.partialReady = true;
    // dfs を離れたら、次に戻ったとき木の途中の状態を当てはめ直す (仕上げが状態を書き換えるため)
    if (this.phase === 'dfs') this.needRestore = true;
    const ph = this.phaseQueue.shift();
    if (!ph) { this.done = true; this.phase = 'done'; this.elapsed = now() - this.t0; return; }
    this.phase = ph.name;
    // fast: 段階の頭で、いまの最良の所で表を測り直す
    if (this.mode === 'fast' && !this.none && this.list.length && !ph.name.startsWith('polish')) {
      const ctx = this.finalLevels(this.list[0]);
      this.setTables(() => ctx);
    }
    if (ph.name.startsWith('beam')) this.beamInit(ph.width);
    else if (ph.name === 'dfs') this.dfsBegin(ph);
    else if (ph.name.startsWith('polish')) this.polishInit(ph.name === 'polish2');
  }

  /** dfs の予算を超えたか */
  overBudget(stepStart) {
    const lim = this.dfsLimit;
    if (!lim) return false;
    const t = now();
    if (t - this.dfsStart < (this.o.minDfsMs ?? 300) && lim.work == null) return false;
    if (lim.work != null && this.stats.boundCalls - this.dfsBound0 > lim.work) return true;
    if (lim.wallEnd != null && t > lim.wallEnd) return true;
    if (lim.activeEnd != null && this.activeMs + (t - stepStart) > lim.activeEnd) return true;
    return false;
  }
  setBudget(b, fromNow) {
    const t = now();
    const lim = {};
    if (b && b.work != null) lim.work = b.work;
    if (b && b.ms != null) lim.wallEnd = (fromNow ? t : this.t0) + b.ms;
    if (b && b.activeMs != null) lim.activeEnd = (fromNow ? this.activeMs : 0) + b.activeMs;
    this.dfsLimit = Object.keys(lim).length ? lim : null;
  }

  step(ms = 50) {
    if (this.done) return true;
    const stepStart = now();
    const end = stepStart + ms;
    try {
      if (!this.started) this.start();
      while (!this.done) {
        if (now() > end) return false;
        if (this.phase.startsWith('beam')) { if (this.beamStep()) this.nextPhase(); }
        else if (this.phase === 'dfs') {
          if (this.overBudget(stepStart)) { this.cut = true; this.nextPhase(); continue; }
          if (this.dfsStep(end, stepStart)) { if (!this.cut) this.dfsFinished = true; this.nextPhase(); }
        } else if (this.phase.startsWith('polish')) { if (this.polishStep(end)) this.nextPhase(); }
      }
      return true;
    } finally {
      this.activeMs += now() - stepStart;
    }
  }
  run() { while (!this.step(1e9)); return this; }

  /**
   * 「続けて探す」: dfs の続き (まだ始めていなければ始める) と polish2 をもう一度。
   * dfs が最後まで回っている・終わっていない・泣シミュ型・厳密モードなら何もしない (false)。budget は今から数える。
   */
  extend(budget) {
    if (!this.done || this.dfsFinished || this.none || this.infeasible || this.mode !== 'fast') return false;
    if (this.weaponQueue && !this.stack && this.wq >= this.weaponQueue.length) { this.dfsFinished = true; return false; }
    this.done = false;
    this.cut = false;
    this.stats.phases.push({ name: 'extend', endMs: now() - this.t0, best: this.list[0]?.value ?? null });
    this.phase = null;
    this.phaseQueue = [{ name: 'dfs', budget: budget || {}, fromNow: true }, { name: 'polish2' }];
    this.nextPhase();
    return true;
  }

  // ---------------------------------------------------------------- ビーム
  beamInit(W) {
    const P = this.P;
    this.beam = { W, level: 0, states: [] };
    // 武器 (複数なら根の上界の大きい順に W 本)
    const ws = P.weapons.map((wp, wi) => { this.setWeapon(wi); return { wi, charm: -1, parts: [-1, -1, -1, -1, -1], ub: this.bound(false, 0) }; })
      .filter((s) => s.ub > NEG).sort((a, b) => b.ub - a.ub).slice(0, W);
    this.beam.states = ws;
  }
  /** ビームを 1 段進める。終わったら true */
  beamStep() {
    const b = this.beam;
    const next = [];
    const d = b.level; // 0 = 護石, 1..5 = 部位
    for (const st of b.states) {
      this.load(st);
      const n = d === 0 ? this.charmCls.length : this.partCls[d - 1].length;
      for (let k = 0; k < n; k++) {
        this.applyAt(d, k);
        const ub = this.bound(true, d);
        this.applyAt(d, k, -1);
        this.stats.nodes++;
        if (ub === NEG) continue;
        const ns = { wi: st.wi, charm: d === 0 ? k : st.charm, parts: st.parts.slice(), ub };
        if (d > 0) ns.parts[d - 1] = k;
        next.push(ns);
      }
    }
    next.sort((x, y) => y.ub - x.ub);
    b.states = next.slice(0, b.W);
    b.level++;
    if (b.level <= 5) return false;
    // 葉: 近似の珠詰め
    for (const st of b.states) {
      this.load(st);
      this.stats.leaves++;
      const sol = this.decoOpt(false, NEG);
      if (sol) this.record(sol);
    }
    this.beam = null;
    return true;
  }

  // ---------------------------------------------------------------- 深さ優先 (B&B)
  dfsBegin(ph = {}) {
    const P = this.P;
    this.dfsRan = true;
    this.dfsStart = now();
    this.dfsBound0 = this.stats.boundCalls;
    this.setBudget(ph.budget || this.o.budget, !!ph.fromNow);
    if (this.weaponQueue) return; // 続き (extend)
    // 武器を根の上界の大きい順に
    this.weaponQueue = P.weapons.map((wp, wi) => { this.setWeapon(wi); return { wi, ub: this.bound(false, 0) }; })
      .sort((a, b) => b.ub - a.ub);
    this.wq = 0;
    this.stack = null;
  }
  beginWeapon(wi) {
    this.setWeapon(wi);
    const kids = [];
    for (let ci = 0; ci < this.charmCls.length; ci++) {
      this.applyAt(0, ci);
      const ub = this.bound(true, 0);
      this.applyAt(0, ci, -1);
      this.stats.nodes++;
      if (ub > NEG && !(!this.none && this.prune(ub))) kids.push({ idx: ci, ub });
    }
    if (!this.none) kids.sort((a, b) => b.ub - a.ub);
    this.stack = [{ d: 0, kids, i: 0, applied: -1 }];
  }
  /** 状態を作り直す (extend で表を測り直した後も、いまの位置から続ける) */
  restoreStack() {
    if (!this.stack || !this.stack.length) return;
    const cur = this.stack.map((fr) => fr.applied);
    this.setWeapon(this.stackWi);
    cur.forEach((a, d) => { if (a >= 0) this.applyAt(d, a); });
  }
  dfsStep(end, stepStart) {
    let iter = 0;
    if (this.needRestore) { this.restoreStack(); this.needRestore = false; }
    while (true) {
      if ((++iter & 15) === 0) {
        // 区切りの間にほかの処理 (結果の組み立てなど) が状態を書き換えてもよいように、戻ったら当てはめ直す
        if (now() > end) { this.needRestore = true; return false; }
        if (this.overBudget(stepStart)) { this.cut = true; return true; }
      }
      if (!this.stack) {
        while (this.wq < this.weaponQueue.length) {
          const w = this.weaponQueue[this.wq++];
          if (!this.none && this.prune(w.ub)) { this.stats.weaponsSkipped++; continue; }
          this.beginWeapon(w.wi);
          this.stackWi = w.wi;
          break;
        }
        if (!this.stack) return true;
      }
      const st = this.stack;
      if (!st.length) { this.stack = null; continue; }
      const fr = st[st.length - 1];
      if (fr.applied >= 0) { this.applyAt(fr.d, fr.applied, -1); fr.applied = -1; }
      if (fr.i >= fr.kids.length) { st.pop(); continue; }
      const kid = fr.kids[fr.i++];
      if (!this.none && this.prune(kid.ub)) { fr.i = fr.kids.length; continue; }
      this.applyAt(fr.d, kid.idx);
      fr.applied = kid.idx;
      if (fr.d === 5) {
        this.stats.leaves++;
        const sol = this.decoOpt(this.leafExact);
        if (sol) this.record(sol);
        if (this.none && this.stats.solutions >= (this.o.maxSolutions ?? this.K)) { this.stack = null; this.wq = Infinity; return true; }
        continue;
      }
      const pi = fr.d;
      const kids = [];
      const cls = this.partCls[pi];
      for (let k = 0; k < cls.length; k++) {
        this.applyPiece(cls[k], +1);
        const ub = this.bound(true, pi + 1);
        this.applyPiece(cls[k], -1);
        this.stats.nodes++;
        if (ub > NEG && !(!this.none && this.prune(ub))) kids.push({ idx: k, ub });
      }
      if (!this.none) kids.sort((a, b) => b.ub - a.ub);
      st.push({ d: fr.d + 1, kids, i: 0, applied: -1 });
    }
  }

  // ---------------------------------------------------------------- 仕上げ: 候補を厳密に解き直す
  /** onlyNew: 厳密でないものだけ解き直す (polish2) */
  polishInit(onlyNew) {
    this.polishQueue = onlyNew ? this.list.filter((e) => !e.exact) : this.list.slice();
    this.polished = onlyNew ? this.list.filter((e) => e.exact) : [];
    this.margin = 0;
    this.polishing = true;
  }
  polishStep(end) {
    // 上位 K 件に加えて、計算し直しで外れたときの繰り上げ用に少し多く残す
    const keep = this.K + Math.ceil(this.K / 2);
    while (this.polishQueue.length) {
      if (now() > end) return false;
      const e = this.polishQueue.shift();
      this.load(e);
      // しきい値: これまでに厳密にした keep 番目 (近似の値 ≤ 厳密の値なので、近似の大きい順に解けば早く締まる)
      const T = this.polished.length >= keep ? this.polished[keep - 1].value : NEG;
      const sol = this.decoOpt(true, T);
      if (sol) {
        const x = { ...e, value: sol.value, ws: sol.ws, deco: sol.deco, exact: true, approxValue: e.value };
        let i = this.polished.length;
        while (i > 0 && this.polished[i - 1].value < x.value) i--;
        this.polished.splice(i, 0, x);
      }
    }
    this.list = this.polished.slice(0, Math.max(keep, this.M));
    this.keys = new Map(this.list.map((x) => [this.keyOf(x), x]));
    this.polishing = false;
    this.margin = this.mode === 'fast' && !this.none ? (this.o.margin ?? 0.01) : 0;
    return true;
  }
}
