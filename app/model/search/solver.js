// 探索の本体 (docs/SEARCH_DESIGN.md 2.4〜2.6 節): 絞り込み + ビーム + 深さ優先の分枝限定 (B&B) + 厳密な仕上げ。
//
// 木: 武器 (武器も探すときだけ) → 護石 → 防具 5 部位 (partOrder の順) → 葉: 装飾品を詰める (武器用の珠の組 × 防具用の珠)。
// 上界 = いまの Lv での正確な期待値 f(L0) + 「残りの部位・護石・珠で足せる Lv」の増え方の和 (ナップサック。防具用の珠は
//        入れ子のスロットなので貪欲で最適)。増え方の表は problem.js の gainTable。
//        dfs (と exact) では締めた上界 (docs/SEARCH_DESIGN.md 2.4 節「締めた上界」): スキルに足す順を決めて測った表 (boundTable)・
//        同じスキルの段を源ごとに重ねて数えないラグランジュ緩和・子を測る前のふるい (部位を 1 つ決めた上界。screenClasses)。
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

/** 覚え (メモリ) の上限: 葉の珠詰めの覚えの合計件数・武器側の増え方の覚え・葉の表の数 (武器ごと)・締めた上界の表の行の数 (全部の武器の合計) */
export const MEMO_LIMITS = Object.freeze({ leafMemo: 60000, weaponGain: 20000, leafTables: 64, boundRows: 30000 });

/**
 * 締めた上界の決まり (docs/SEARCH_DESIGN.md 2.4 節): zeroDepth = λ = 0 の回を測る深さ (決めた部位の数がこれ以下)、
 * uniDepth / uniEvals = 全部の防具スキルで同じ λ を黄金分割で探す深さと測る回数、chainArmor = 防具スキルどうしにも足す順を
 * 付ける数の上限 (これより多いと行が増えすぎるので順にしない)、screen = 子を測る前のふるい
 */
export const TIGHT = Object.freeze({ zeroDepth: 2, uniDepth: 2, uniEvals: 5, chainArmor: 8, screen: true });

/**
 * ビームの状態 (上界の大きい順) から W 個を選ぶ: まず護石の類ごとに一番上界の大きい状態を 1 つずつ (上界の順に W 個まで)、
 * 残りを上界の順に足す。戻り値も上界の大きい順 (docs/SEARCH_DESIGN.md 2.13 節)
 */
export function spreadByCharm(states, W) {
  if (states.length <= W) return states.slice();
  const seen = new Set();
  const pick = [];
  const rest = [];
  for (const s of states) {
    if (s.charm >= 0 && !seen.has(s.charm) && pick.length < W) { seen.add(s.charm); pick.push(s); } else rest.push(s);
  }
  for (const s of rest) { if (pick.length >= W) break; pick.push(s); }
  return pick.sort((x, y) => y.ub - x.ub);
}

export class BnbSolver {
  /**
   * @param P prepare() の結果
   * @param o {
   *   mode: 'fast' | 'exact', objective: 'damage' | 'none', K (既定 P.K), M (厳密に解き直す候補の数。既定 2K),
   *   beam: [幅, ...] (fast。既定 [60, 200]), margin (fast の刈り込みの余裕。既定 0.01),
   *   budget: {ms, activeMs, work} (dfs を打ち切る。ms = 始めてからの時間、activeMs = 計算した時間の合計、
   *            work = dfs の中で上界を求めた回数。どれも無ければ最後まで), minDfsMs (dfs を最低これだけ回す。既定 300),
   *   stopAfter: 'partial' (polish1 で止める), partOrder, maxSolutions (none で集める数。既定 K), eps (exact で刈る許し),
   *   sieve: 武器も探すときの 2 段のふるい (docs/SEARCH_DESIGN.md 2.7 節)。{top: 測り直す防具・護石の組の数 (既定 50),
   *          weapons: dfs を回す武器の数 (既定 3)} か false (ふるわない。全部の武器で dfs),
   *   tight: false (締めた上界を使わない。比べる・テスト用) か TIGHT の一部を差し替えるもの,
   *   floor: これ以下の値の構成は要らない (刈るしきい値の下限。相手タブで、前の回の上位 K 番目の値を後の回に渡す。
   *          docs/RECOMMEND_DESIGN.md 5.3 節。dfs の間だけ使い、fast は margin も同じく掛ける。ビームは近似の表で珠の詰め方を
   *          刈るので、外から来たしきい値で刈ると満たせる葉まで落とすことがある (確かめた) ため使わない),
   *   spread: false (護石の類をばらして探す工夫をしない。比べる・テスト用。docs/SEARCH_DESIGN.md 2.13 節。既定は fast でする:
   *          最初のビームで護石の類ごとに一番上界の高い状態を先に 1 つずつ残し、dfs の根では護石の類を「それまでに見つかった値」の
   *          高い順に回る。所持護石が 250 個になると、上界の高い暫定の護石の類がビームと dfs の先頭を埋めて、生産する護石の類の
   *          良い組が予算の外になったため。刈る規則は変えないので、最後まで探したときの上位は変わらない)
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
    this.floor = !this.none && o.floor != null && Number.isFinite(Number(o.floor)) ? Number(o.floor) : null;
    this.spread = this.mode === 'fast' && !this.none && o.spread !== false;
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
    this.partCls = this.partOrder.map((p, pi) => P.parts[p].map((c) => ({ ...c, sk: sparse(c.lv), pi })));
    this.charmCls = P.charms.map((c) => ({ ...c, sk: sparse(c.lv) }));
    // 護石の類ごとの、見つかった構成の一番良い値 (ビーム・ふるい・dfs の葉。近似の値。spread で dfs の根を回る順に使う)
    this.charmBest = new Float64Array(this.charmCls.length).fill(NEG);
    this.armorR = [];
    this.weaponR = [];
    this.reqR = [];
    for (let r = 0; r < R; r++) {
      if (P.kind[r] === 'armor' && P.armorDeco[r]) this.armorR.push(r);
      if (P.kind[r] === 'weapon') this.weaponR.push(r);
      if (P.reqLv[r] > 0) this.reqR.push(r);
    }
    this.armorSz = Int8Array.from(this.armorR.map((r) => P.armorDeco[r].slot));
    // 締めた上界 (docs/SEARCH_DESIGN.md 2.4 節): ラグランジュ緩和の対象 = 防具スキル (護石・部位・防具の珠から来る)
    this.tightOpt = { ...TIGHT, ...(o.tight && typeof o.tight === 'object' ? o.tight : {}) };
    this.tight = o.tight !== false;
    this.lagOn = new Uint8Array(R);
    this.lagR = [];
    this.sgR = [];
    for (let r = 0; r < R; r++) {
      if (P.kind[r] === 'armor') { this.lagOn[r] = 1; this.lagR.push(r); }
      if (P.kind[r] === 'set' || P.kind[r] === 'group') this.sgR.push(r);
    }
    this.lagLam = new Float64Array(R);
    this.lagCap = new Int8Array(R);
    // 必須の防具スキルの数 (screenClasses の覚えの鍵の桁)
    this.reqArmorN = this.reqR.filter((r) => P.kind[r] === 'armor').length;
    // 上界の表のスキルの順 (boundTable): 防具スキル (とほか) → シリーズ/グループ → 武器スキル (並びの後ろから)
    const rest = [];
    for (let r = 0; r < R; r++) if (!this.lagOn[r] && !this.sgR.includes(r) && !this.weaponR.includes(r)) rest.push(r);
    this.chainGroups = [[...rest, ...this.lagR], this.sgR, [...this.weaponR].reverse()];
    this.boundRowsN = 0;
    this.stats.lagEvals = 0;
    this.stats.boundRows = 0;
    this.stats.boundRowClears = 0;
    this.stats.kidsScreened = 0;
    this.partMaxLv = this.partCls.map((cls) => { const m = new Int8Array(R); for (const c of cls) for (let r = 0; r < R; r++) if (c.lv[r] > m[r]) m[r] = c.lv[r]; return m; });
    this.partMaxSlots = this.partCls.map((cls) => [0, 1, 2].map((i) => Math.max(0, ...cls.map((c) => c.slots[i]))));
    // 防具の耐性の合計の下限 (P.resMin。相手タブの耐性の回だけ。docs/SEARCH_DESIGN.md 2.12 節)。
    // res = 決めた部位の「類の中で一番耐性の高い防具」の和 (属性ごと)、resSuffix[from] = 部位 from から後の、部位ごとの類の最大の和。
    // res + resSuffix が下限に届かない枝は満たせない。属性が 1 つなら葉では正確 (類の中で一番高い防具を選べばよい)。
    // 属性が 2 つ以上なら、葉で類の中の防具の耐性の並び (resFront) から本当に選べるかを確かめる (resistLeafOk)
    this.resN = P.resE ? P.resE.length : 0;
    this.res = new Int16Array(this.resN);
    this.selCls = new Array(5).fill(null);
    this.resSuffix = Array.from({ length: 6 }, () => new Int16Array(this.resN));
    if (this.resN) {
      for (let pi = 4; pi >= 0; pi--) {
        for (let e = 0; e < this.resN; e++) {
          let m = -32768;
          for (const c of this.partCls[pi]) if (c.resMax[e] > m) m = c.resMax[e];
          this.resSuffix[pi][e] = this.resSuffix[pi + 1][e] + (this.partCls[pi].length ? m : 0);
        }
      }
    }
    this.stats.resistCut = 0;
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
    // 1 つのシリーズ/グループだけから出る必須 (いまのデータは全部これ) は、「どの部位をどのボーナスに数えるか」の割り当てで
    // まとめて判定する (目標列挙の試作 oracle.mjs の考え方。1 部位で 2 つのボーナスに数える防具 (ゴグα/β) もある)。
    // sgMasks[部位] = その部位の類が同時に数えられるボーナスの組 (ビット) のうち極大のもの、sgAvail[部位] = その部位から後で
    // ボーナス b を持てる部位の数
    this.sgBits = this.reqSG.filter((q) => q.sets.length + q.groups.length === 1)
      .map((q) => ({ r: q.r, set: q.sets.length ? q.sets[0] : -1, group: q.groups.length ? q.groups[0] : -1 }));
    const nb = this.sgBits.length;
    this.sgMasks = this.partCls.map((cls) => {
      const ms = [...new Set(cls.map((c) => {
        let m = 0;
        this.sgBits.forEach((q, b) => { if ((q.set >= 0 && c.sIdx.includes(q.set)) || (q.group >= 0 && c.gIdx === q.group)) m |= 1 << b; });
        return m;
      }))];
      return ms.filter((m) => !ms.some((o) => o !== m && (o & m) === m));
    });
    this.sgAvail = [];
    for (let pi = 0; pi <= 5; pi++) {
      const a = new Int8Array(nb);
      for (let pj = pi; pj < 5; pj++) for (let b = 0; b < nb; b++) if (this.sgMasks[pj].some((m) => m & (1 << b))) a[b]++;
      this.sgAvail.push(a);
    }
    this.sgNeed = new Int8Array(nb);
    this.sgMemo = new Map();
    this.leafExact = this.mode === 'exact';
    // 武器も探すときの 2 段のふるい (fast だけ)。ビームの葉 (防具・護石の組) を覚えておき、dfs の前に残った武器で測り直す
    const sv = o.sieve === false ? null : { top: 50, weapons: 3, ...(o.sieve || {}) };
    this.sieveOpt = this.mode === 'fast' && !this.none && sv && P.weapons.length > sv.weapons ? sv : null;
    this.beamLeaves = new Map();
    this.memoSize = 0;
    this.wws = P.weapons.map(() => ({ gt: null, memoA: new Map(), memoE: new Map(), leafCache: new Map() }));
  }

  // ---------------------------------------------------------------- 上位の並び
  /** 刈るしきい値 = K 番目の値。fast は仕上げの候補を残すため少し下げる (margin) */
  threshold() {
    if (this.polishing) return NEG;
    const f = this.floor == null || this.phase !== 'dfs' ? NEG : this.margin ? this.floor * (1 - this.margin) : this.floor;
    if (this.list.length < this.K) return f;
    const v = this.list[this.K - 1].value;
    const t = this.margin ? v * (1 - this.margin) : v;
    return t > f ? t : f;
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
    this.raw.fill(0); this.setCnt.fill(0); this.grpCnt.fill(0); this.slot = [0, 0, 0, 0]; this.wSlot = 0; this.res.fill(0);
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
    if (this.resN) {
      for (let e = 0; e < this.resN; e++) this.res[e] += sign * c.resMax[e];
      this.selCls[c.pi] = sign > 0 ? c : null;
    }
  }
  /** 防具の耐性の合計の下限に、残りの部位 (partOrder[from..4]) で届くか (from = 5 で属性が 2 つ以上なら、選べる防具の組で確かめる) */
  resistFeasible(from) {
    const min = this.P.resMin;
    const suf = this.resSuffix[from];
    for (let e = 0; e < this.resN; e++) if (this.res[e] + suf[e] < min[e]) return false;
    return from < 5 || this.resN === 1 || this.resistLeafOk();
  }
  /** 5 部位の類を決めたとき、類の中の防具を選んで全部の属性の下限を満たせるか (類ごとの耐性の並び resFront を深さ優先で) */
  resistLeafOk() {
    const n = this.resN;
    const min = this.P.resMin;
    const sel = this.selCls;
    const acc = this._resAcc || (this._resAcc = new Int16Array(n));
    // 後ろの部位の最大の和 (枝を刈る)
    const tail = this._resTail || (this._resTail = Array.from({ length: 6 }, () => new Int16Array(n)));
    for (let pi = 4; pi >= 0; pi--) for (let e = 0; e < n; e++) tail[pi][e] = tail[pi + 1][e] + sel[pi].resMax[e];
    acc.fill(0);
    const rec = (pi) => {
      if (pi === 5) return true;
      for (const v of sel[pi].resFront) {
        let ok = true;
        for (let e = 0; e < n; e++) if (acc[e] + v[e] + tail[pi + 1][e] < min[e]) { ok = false; break; }
        if (!ok) continue;
        for (let e = 0; e < n; e++) acc[e] += v[e];
        const r = rec(pi + 1);
        for (let e = 0; e < n; e++) acc[e] -= v[e];
        if (r) return true;
      }
      return false;
    };
    return rec(0);
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
   * シリーズ/グループスキルの必須を、残りの部位 (partOrder[from..4]) で満たせるか (docs/SEARCH_DESIGN.md 2.8 節)。
   * 1 つのシリーズ/グループから出る必須は、要る部位の数を出してから、残りの部位をどのボーナスに数えるかを割り当てて判定する
   * (部位の取り合いも見る。満たせるなら必ず true なので、満たせる枝を捨てることは無い)。
   * 複数のシリーズ/グループから出る必須 (いまのデータには無い) は、ボーナスごとに「いまの部位数 + 残りの部位のうちそれを持つ類が
   * ある部位の数」で届く段を見るゆるい判定。
   */
  setGroupFeasible(from) {
    const P = this.P;
    const nb = this.sgBits.length;
    if (nb) {
      const need = this.sgNeed;
      let key = from;
      let any = false;
      for (let b = 0; b < nb; b++) {
        const q = this.sgBits[b];
        // 防具・護石に付いている分 (ふつうは無い) を引いた、ボーナスで出す Lv
        const lvNeed = P.reqLv[q.r] - this.raw[q.r];
        let pieces = 0;
        if (lvNeed > 0) {
          pieces = Infinity;
          if (q.set >= 0) { for (const rk of P.sets[q.set].ranks) if (rk.level >= lvNeed && rk.pieces < pieces) pieces = rk.pieces; }
          else if (P.groups[q.group].level >= lvNeed) pieces = P.groups[q.group].pieces;
          if (pieces === Infinity) return false;
        }
        const have = q.set >= 0 ? this.setCnt[q.set] : this.grpCnt[q.group];
        need[b] = pieces > have ? pieces - have : 0;
        if (need[b] > this.sgAvail[from][b]) return false;
        if (need[b] > 0) any = true;
        key = key * 8 + need[b];
      }
      if (any) {
        let ok = this.sgMemo.get(key);
        if (ok === undefined) {
          ok = this.sgAssign(from, need);
          if (this.sgMemo.size >= 20000) this.sgMemo.clear();
          this.sgMemo.set(key, ok);
        }
        if (!ok) return false;
      }
    }
    for (const q of this.reqSG) {
      if (q.sets.length + q.groups.length === 1) continue;
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

  /**
   * 部位の割り当て: 部位 pi から後の部位に、その部位の類が持つボーナスの組 (sgMasks) を 1 つずつ選んで、
   * 足りない部位の数 need (ボーナスごと) を全部埋められるか。need は書き換えて戻す。
   */
  sgAssign(pi, need) {
    const nb = need.length;
    let done = true;
    for (let b = 0; b < nb; b++) {
      if (need[b] <= 0) continue;
      done = false;
      if (need[b] > this.sgAvail[pi][b]) return false;
    }
    if (done) return true;
    if (pi >= 5) return false;
    for (const m of this.sgMasks[pi]) {
      for (let b = 0; b < nb; b++) if (m & (1 << b)) need[b]--;
      const ok = this.sgAssign(pi + 1, need);
      for (let b = 0; b < nb; b++) if (m & (1 << b)) need[b]++;
      if (ok) return true;
    }
    return false;
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

  /**
   * いまの状態 (護石を選んだか charmDone、残りの部位 = partOrder[from..4]) の上界。満たせないなら -Infinity。
   * rec: 部位 rec (partOrder の番号) の類ごとに「その部位だけ類を決めた上界」を kidUbOf(rec) に入れる (子を測る前のふるい。dfsStep)
   */
  bound(charmDone, from, rec = -1) {
    const P = this.P;
    this.stats.boundCalls++;
    if (this.resN && !this.resistFeasible(from)) { this.stats.resistCut++; return NEG; }
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
    // 締めた上界 (docs/SEARCH_DESIGN.md 2.4 節): ビームの並べ替えは前と同じ上界 (途中の結果を変えない)
    const tight = this.tight && !pessimistic;
    // 火力に効かない必須スキル (耐性など) の珠の数を、珠の大きさごとにまとめて見た分 (jointForced)
    const extra = tight && this.reqR.length ? this.jointForced(L, charmDone, from, need.forced) : null;
    // 必須を珠で埋めきれない枝は、表を引く前に捨てる (下の decoGreedy と同じ判定)
    if (tight && (!wOk(need) || !this.forcedFeasible(need.forced, budget, extra))) return NEG;
    const gtSave = this.gt;
    if (tight) this.gt = this.boundTable(L);
    // いまの Lv からの累積和 (スキルごと。締めた上界のときだけ)
    const cp = tight ? this._cp || (this._cp = new Array(P.R)) : null;
    if (cp) for (let r = 0; r < P.R; r++) cp[r] = this.gt.pre[r][L[r] > P.maxLv[r] ? P.maxLv[r] : L[r]];
    try {
      let g = wOk(need) ? this.decoGreedy(L, budget, need.forced, null, null, extra) : NEG;
      if (g === NEG && pessimistic && this.reqR.length) {
        need = this.requiredNeeds(L, charmDone, from, false);
        if (!need || !wOk(need)) return NEG;
        g = this.decoGreedy(L, budget, need.forced);
      }
      if (g === NEG) return NEG;
      const f0 = this.wp.ev.evaluate(L);
      const wg = this.weaponGain(charmDone ? this.wSlot : this.charmMaxW, L);
      const setCredit = this.setCredits(L, from);
      const grpCredit = this.groupCredits(L, from);
      let ub = f0 + wg + g + this.sourceGain(L, charmDone, from, setCredit, grpCredit, null, rec, cp);
      const kid = rec >= 0 ? this.kidUbOf(rec) : null;
      // ふるいの類ごとの見直し (screenClasses) に使う: 素の上界と、一番小さかった λ の回の値・部位 rec の最大・類ごとの値・珠の分・λ
      const sv = kid && tight ? (this._sv || (this._sv = [{}, {}])) : null;
      const keep = (o, U, gg, t) => { o.U = U; o.best = this.recBest; o.v = (o.v && o.v.length >= this.recV.length ? o.v : new Float64Array(this.recV.length)); o.v.set(this.recV); o.g = gg; o.t = t; };
      if (kid) {
        for (let k = 0; k < kid.length; k++) kid[k] = ub - this.recBest + this.recV[k];
        if (sv) { keep(sv[0], ub, g, Infinity); sv[1].U = Infinity; }
      }
      if (!tight) return ub;
      // ラグランジュ緩和: 防具スキル r の上積みの合計 X_r を、源 (護石・部位・防具の珠) ごとの x に分けて数えると、
      // H_r(Σx) ≤ H*_r(λ) + Σ min(λx, H_r(x))  (H*_r(λ) = max_x H_r(x) - λx。どの λ ≥ 0 でも成り立つ) なので、
      // 源ごとに独立に最大にしても、急な最初の段を源の数だけ重ねて数えない。λ を何通りか試して一番小さい値を使う
      // しきい値 (これ以下と分かれば締めるのをやめる)
      const thr = this.threshold();
      const lam = this.lagLam;
      const cap = this.lagCap;
      let anyCap = false;
      for (const r of this.lagR) {
        // 残りの源で足せる Lv の合計の上限 (上限までの空きでも切る)
        let u = charmDone ? 0 : this.charmMaxLv[r];
        for (let pi = from; pi < 5; pi++) u += this.partMaxLv[pi][r];
        if (P.armorDeco[r]) for (let z = P.armorDeco[r].slot; z <= 3; z++) u += budget[z];
        const len = cp[r].length - 1;
        cap[r] = u < len ? u : len;
        if (cap[r] > 0) anyCap = true;
      }
      if (anyCap) {
        const base = f0 + wg;
        const pass = (t) => {
          for (const r of this.lagR) lam[r] = cap[r] > 0 ? t : Infinity;
          this.stats.lagEvals++;
          const v = this.lagEval(base, L, charmDone, from, budget, need.forced, setCredit, grpCredit, rec, cp, extra);
          if (v < ub) ub = v;
          if (kid) {
            for (let k = 0; k < kid.length; k++) { const x = v - this.recBest + this.recV[k]; if (x < kid[k]) kid[k] = x; }
            if (sv && v < sv[1].U) keep(sv[1], v, this.lastDeco, t);
          }
          return v;
        };
        // λ = 0: スキルごとに上限 (足せる分) まで 1 回だけ数える
        if (!this.prune(ub, thr) && from <= this.tightOpt.zeroDepth) pass(0);
        // 浅い所 (残りの部位が多い) は、全部の防具スキルで同じ λ = t (珠のスロット 1 つの値段のようなもの) を黄金分割で探す
        const to = this.tightOpt;
        const n = from <= to.uniDepth ? to.uniEvals : 0;
        if (n >= 2 && !this.prune(ub, thr)) {
          let tmax = 0;
          for (const r of this.lagR) if (cap[r] > 0) { const h = this.gt.hat[r][L[r] > P.maxLv[r] ? P.maxLv[r] : L[r]]; if (h[0] > tmax) tmax = h[0]; }
          const gr = 0.6180339887498949;
          let a = 0, b = tmax;
          let x1 = b - gr * (b - a), x2 = a + gr * (b - a);
          let f1 = pass(x1), f2 = pass(x2);
          for (let k = 2; k < n && !this.prune(ub, thr); k++) {
            if (f1 <= f2) { b = x2; x2 = x1; f2 = f1; x1 = b - gr * (b - a); f1 = pass(x1); }
            else { a = x1; x1 = x2; f1 = f2; x2 = a + gr * (b - a); f2 = pass(x2); }
          }
        }
      }
      if (sv && !this.prune(ub, thr)) this.screenClasses(kid, L, charmDone, from, rec, sv, cp, thr, need.forced, extra);
      return ub;
    } finally { this.gt = gtSave; }
  }

  /**
   * 子を測る前のふるいの見直し: 部位 rec の類ごとに、その類の Lv とスロットで「必須を珠で埋める分」と珠の詰め方を測り直す
   * (bound の珠の分は、部位 rec のスロットと必須のスキルを類の最大で見ている)。必須を満たせない類は -Infinity。
   * 見直す回は、素の上界と一番小さかった λ の回 (sv)。どちらも、珠の分だけを類ごとの値に差し替えた上界になる
   */
  screenClasses(kid, L, charmDone, from, rec, sv, cp, thr, forced0, extra0) {
    const P = this.P;
    const cls = this.partCls[rec];
    const base = [0, this.slot[1], this.slot[2], this.slot[3]];
    for (let pi = from; pi < 5; pi++) if (pi !== rec) for (const x of this.partMaxSlots[pi]) if (x > 0) base[x]++;
    if (!charmDone) for (const x of this.charmMaxSlots) if (x > 0) base[x]++;
    const mx = [0, 0, 0, 0];
    for (const x of this.partMaxSlots[rec]) if (x > 0) mx[x]++;
    const budget = [0, 0, 0, 0];
    const forced = this._forcedK || (this._forcedK = []);
    const lam = this.lagLam;
    // 珠の分は (類のスロットの数, 必須の珠) だけで決まるので、この呼び出しの中で覚える。鍵は 1 つの数 (スロット 9 ビット + 必須の防具
    // スキル 1 つにつき 3 ビット + 耐性の珠の下限 18 ビット) なので、53 ビットに入らないとき (必須の防具スキルが 9 個以上) は覚えない
    const memo = this.reqArmorN <= 8 ? this._scrMemo || (this._scrMemo = new Map()) : null;
    if (memo) memo.clear();
    // 耐性の珠の下限 (jointForced) の、部位 rec 以外が埋める分 (類によらないので、この呼び出しの中で覚える)
    const jc = this._jointCov || (this._jointCov = [0, 0, 0, 0]);
    jc.fill(-1);
    if (sv[1].U < Infinity) for (const r of this.lagR) lam[r] = this.lagCap[r] > 0 ? sv[1].t : Infinity;
    for (let k = 0; k < cls.length; k++) {
      if (kid[k] === NEG || this.prune(kid[k], thr)) continue;
      const cl = cls[k];
      forced.length = 0;
      let ok = true;
      let key = (cl.slotCount[1] * 8 + cl.slotCount[2]) * 8 + cl.slotCount[3];
      for (const r of this.reqR) {
        if (P.kind[r] !== 'armor') continue;
        let opt = L[r] + cl.lv[r];
        for (let pi = from; pi < 5; pi++) if (pi !== rec) opt += this.partMaxLv[pi][r];
        if (!charmDone) opt += this.charmMaxLv[r];
        const need = P.reqLv[r] - opt;
        key = key * 8 + (need > 0 ? need : 0);
        if (need <= 0) continue;
        if (!P.armorDeco[r]) { ok = false; break; }
        forced.push(r, need);
      }
      if (!ok) { kid[k] = NEG; continue; }
      const extra = this.jointForced(L, charmDone, from, forced, rec, cl, jc);
      if (extra) key = ((key * 64 + extra[1]) * 64 + extra[2]) * 64 + extra[3];
      let m = memo ? memo.get(key) : undefined;
      if (m === undefined) {
        for (let z = 1; z <= 3; z++) budget[z] = base[z] + cl.slotCount[z];
        if (!this.forcedFeasible(forced, budget, extra)) m = null;
        else if (!extra && !extra0 && cl.slotCount[1] === mx[1] && cl.slotCount[2] === mx[2] && cl.slotCount[3] === mx[3]
          && forced.length === forced0.length && forced.every((x, i) => x === forced0[i])) m = false;
        else {
          m = [this.decoGreedy(L, budget, forced, null, null, extra), sv[1].U < Infinity ? this.decoGreedy(L, budget, forced, lam, cp, extra) : 0];
        }
        if (memo) memo.set(key, m);
      }
      if (m === null) { kid[k] = NEG; continue; }
      if (m === false) continue;
      let x = sv[0].U - sv[0].best + sv[0].v[k] - sv[0].g + m[0];
      if (sv[1].U < Infinity) { const y = sv[1].U - sv[1].best + sv[1].v[k] - sv[1].g + m[1]; if (y < x) x = y; }
      if (x < kid[k]) kid[k] = x;
    }
  }

  /**
   * 火力に効かない必須スキル (耐性など。増え方が 0 なので珠の値は 0) の珠の数の下限を、珠の大きさごとにまとめて見る。
   * requiredNeeds はスキルごとに「残りの部位それぞれの一番多い類」を足すので、1 つの部位が別々の類で何種類もの耐性を持つ形を数える。
   * ここでは部位ごとに「1 つの類で、その大きさの耐性をまとめて何 Lv 埋められるか」の最大を足して、足りない分を珠で埋めるとする。
   * 返り値: スキルごとの forced の和に上乗せする、どのスキルとも決めない珠の数 [0, 大きさ 1, 2, 3] か null。
   * rec / cl: 部位 rec の類を cl に決めたとき (screenClasses)。jc: 部位 rec 以外が埋める分の覚え (大きさごと。-1 = まだ。screenClasses の
   * 1 回の呼び出しの中で類によらない)
   */
  jointForced(L, charmDone, from, forced, rec = -1, cl = null, jc = null) {
    const P = this.P;
    const G = this.ws.chainG || (this.ws.chainG = this.chainGroupsOf());
    if (!G.reqBySize) {
      const fl = new Uint8Array(P.R);
      for (const r of G.flat) fl[r] = 1;
      G.reqBySize = [1, 2, 3].map((z) => this.reqR.filter((r) => fl[r] && P.kind[r] === 'armor' && P.armorDeco[r] && P.armorDeco[r].slot === z))
        .map((list) => (list.length >= 2 ? list : null));
    }
    let out = null;
    for (let z = 1; z <= 3; z++) {
      const S = G.reqBySize[z - 1];
      if (!S) continue;
      let need = 0;
      for (const r of S) { const d = P.reqLv[r] - L[r]; if (d > 0) need += d; }
      if (!need) continue;
      const cover = (c) => {
        let v = 0;
        for (const r of S) { const d = P.reqLv[r] - L[r]; if (d > 0) v += c.lv[r] < d ? c.lv[r] : d; }
        return v;
      };
      let cov = jc ? jc[z] : -1;
      if (cov < 0) {
        cov = 0;
        if (!charmDone) for (const c of this.charmCls) { const v = cover(c); if (v > cov) cov = v; }
        for (let pi = from; pi < 5; pi++) {
          if (pi === rec) continue;
          let best = 0;
          for (const c of this.partCls[pi]) { const v = cover(c); if (v > best) best = v; }
          cov += best;
        }
        if (jc) jc[z] = cov;
      }
      if (rec >= from && rec < 5) cov += cover(cl);
      let per = 0;
      for (let i = 0; i < forced.length; i += 2) if (S.includes(forced[i])) per += forced[i + 1];
      const e = need - cov - per;
      if (e > 0) { if (!out) out = [0, 0, 0, 0]; out[z] = e; }
    }
    return out;
  }

  /** 部位 pi の類ごとの「その部位だけ類を決めた上界」の入れ物 */
  kidUbOf(pi) {
    const a = this._kidUb || (this._kidUb = []);
    return a[pi] || (a[pi] = new Float64Array(this.partCls[pi].length));
  }

  /**
   * 護石と残りの部位で足せる分: 源ごとに類の値 (スキルの増え方 + シリーズ/グループの見込み) の最大の和。
   * lam があれば、ラグランジュ緩和の対象の防具スキルは min(λx, H(x)) で数える。
   * 部位 rec は類ごとの値を this.recV に、その最大を this.recBest に入れる。cp = スキルごとのいまの Lv からの累積和 (締めた上界のとき)
   */
  sourceGain(L, charmDone, from, setCredit, grpCredit, lam, rec, cp) {
    let gain = 0;
    // 締めた上界のときは、火力に効かないスキルを除いた類のスキルの並び (boundTable)
    const csk = cp ? this.ws.csk : null;
    if (!charmDone) {
      let best = 0;
      for (let k = 0; k < this.charmCls.length; k++) {
        const v = this.classGain(csk ? csk.charm[k] : this.charmCls[k].sk, L, lam, cp);
        if (v > best) best = v;
      }
      gain += best;
    }
    for (let pi = from; pi < 5; pi++) {
      const cls = this.partCls[pi];
      let rv = null;
      if (pi === rec) rv = this.recV && this.recV.length >= cls.length ? this.recV : (this.recV = new Float64Array(cls.length + 64));
      let best = 0;
      for (let k = 0; k < cls.length; k++) {
        const c = cls[k];
        let v = this.classGain(csk ? csk.parts[pi][k] : c.sk, L, lam, cp);
        for (const s of c.sIdx) v += setCredit[s];
        if (c.gIdx >= 0) v += grpCredit[c.gIdx];
        if (rv) rv[k] = v;
        if (v > best) best = v;
      }
      if (rv) this.recBest = best;
      gain += best;
    }
    return gain;
  }
  /** 類のスキル sk = [r, Lv, ...] の増え方 (lam があれば、ラグランジュ緩和の対象の防具スキルは min(λx, H(x))) */
  classGain(sk, L, lam, cp) {
    let v = 0;
    if (!cp) {
      for (let i = 0; i < sk.length; i += 2) v += this.hatSum(sk[i], L[sk[i]], sk[i + 1]);
      return v;
    }
    for (let i = 0; i < sk.length; i += 2) {
      const r = sk[i];
      const pre = cp[r];
      const x = sk[i + 1] < pre.length ? sk[i + 1] : pre.length - 1;
      const lr = lam ? lam[r] : Infinity;
      if (lr !== Infinity && this.lagOn[r]) { const t = lr * x; v += t < pre[x] ? t : pre[x]; } else v += pre[x];
    }
    return v;
  }
  /** λ を決めたときの上界: base (f0 + 武器の珠) + Σ H*_r(λ_r) (足せる分で切る) + 源ごとの Σ min(λx, H(x)) の最大 */
  lagEval(base, L, charmDone, from, budget, forced, setCredit, grpCredit, rec, cp, extra) {
    const P = this.P;
    const lam = this.lagLam;
    let v = base;
    for (const r of this.lagR) {
      const lr = lam[r];
      if (lr === Infinity) continue;
      const h = this.gt.hat[r][L[r] > P.maxLv[r] ? P.maxLv[r] : L[r]];
      const m = this.lagCap[r];
      for (let j = 0; j < m; j++) if (h[j] > lr) v += h[j] - lr;
    }
    v += this.sourceGain(L, charmDone, from, setCredit, grpCredit, lam, rec, cp);
    this.lastDeco = this.decoGreedy(L, budget, forced, lam, cp, extra);
    return v + this.lastDeco;
  }

  forcedFeasible(forced, budget, extra = null) {
    const c = extra ? extra.slice() : [0, 0, 0, 0];
    for (let i = 0; i < forced.length; i += 2) c[this.P.armorDeco[forced[i]].slot] += forced[i + 1];
    return c[3] <= budget[3] && c[3] + c[2] <= budget[3] + budget[2] && c[1] + c[2] + c[3] <= budget[1] + budget[2] + budget[3];
  }

  /**
   * 防具用の珠の増え方の上界 (貪欲)。forced = [r, 必要 Lv, ...] は先に入れる。入らなければ -Infinity。
   * lam があれば、ラグランジュ緩和の対象のスキルは min(λx, H(x)) (x = そのスキルの珠の数) の傾きで数える
   */
  decoGreedy(L, budget, forced, lam = null, cp = null, extra = null) {
    const P = this.P;
    let c1 = 0, c2 = 0, c3 = 0;
    if (extra) { c1 = extra[1]; c2 = extra[2]; c3 = extra[3]; }
    let v = 0;
    const used = this._used || (this._used = new Int8Array(P.R));
    for (let i = 0; i < forced.length; i += 2) {
      const r = forced[i]; const n = forced[i + 1];
      const sz = P.armorDeco[r].slot;
      if (sz === 3) c3 += n; else if (sz === 2) c2 += n; else c1 += n;
      used[r] = n;
      if (lam && this.lagOn[r] && lam[r] !== Infinity) {
        const pre = cp[r];
        const x = n < pre.length - 1 ? n : pre.length - 1;
        v += Math.min(lam[r] * x, pre[x]);
      } else v += this.hatSum(r, L[r], n);
    }
    const B3 = budget[3], B23 = budget[3] + budget[2], B123 = budget[1] + budget[2] + budget[3];
    if (!(c3 <= B3 && c3 + c2 <= B23 && c1 + c2 + c3 <= B123)) { for (let i = 0; i < forced.length; i += 2) used[forced[i]] = 0; return NEG; }
    // 値の大きい順に入れる貪欲。スキルごとの増え方 (凹の上包みの傾き) は大きい順に並んでいるので、並べ替えずに
    // スキルの先頭どうしを比べて取る (入れ子のスロットへの割り当ては matroid なので、同じ値の取り方の順で合計は変わらない)。
    // 入らなかった大きさの珠は、後の珠も入らない (空きは減るだけ) ので、その大きさごと閉じる。増え方が 0 のスキルは見ない
    const nA = this.armorR.length;
    const heads = this._heads || (this._heads = new Array(nA));
    const hl = this._hl || (this._hl = new Int8Array(nA));
    const pos = this._pos || (this._pos = new Int8Array(nA));
    const act = this._act || (this._act = new Int16Array(nA));
    const pb = this._phiBuf || (this._phiBuf = Array.from({ length: nA }, () => new Float64Array(16)));
    let nAct = 0;
    for (let k = 0; k < nA; k++) {
      const r = this.armorR[k];
      let h, n;
      if (lam && this.lagOn[r] && lam[r] !== Infinity) {
        // min(λx, H(x)) の傾き (凹なので大きい順)。x は forced の分の続きから
        const pre = cp[r];
        const len = pre.length - 1;
        if (!(pre[len] > 0)) continue;
        const lr = lam[r];
        h = pb[k];
        n = 0;
        const u = used[r] < len ? used[r] : len;
        let prev = Math.min(lr * u, pre[u]);
        for (let x = u + 1; x <= len; x++) { const cur = Math.min(lr * x, pre[x]); h[n++] = cur - prev; prev = cur; }
      } else {
        const base = L[r] + used[r];
        h = this.gt.hat[r][base > P.maxLv[r] ? P.maxLv[r] : base];
        n = h.length;
      }
      if (n > 0 && h[0] > 0) { heads[k] = h; hl[k] = n; pos[k] = 0; act[nAct++] = k; }
    }
    for (let i = 0; i < forced.length; i += 2) used[forced[i]] = 0;
    let free = B123 - c1 - c2 - c3;
    let open3 = true, open2 = true;
    while (free > 0) {
      let bk = -1, bv = 0;
      for (let a = 0; a < nAct; a++) {
        const k = act[a];
        const j = pos[k];
        if (j >= hl[k]) continue;
        const x = heads[k][j];
        if (!(x > bv)) continue;
        const sz = this.armorSz[k];
        if ((sz === 3 && !open3) || (sz === 2 && !open2)) continue;
        bk = k; bv = x;
      }
      if (bk < 0) break;
      const sz = this.armorSz[bk];
      if (sz === 3) { if (c3 + 1 > B3 || c3 + c2 + 1 > B23) { open3 = false; continue; } c3++; }
      else if (sz === 2) { if (c3 + c2 + 1 > B23) { open2 = false; open3 = false; continue; } c2++; }
      else c1++;
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
      const ctx = this.mode === 'exact' ? null : ctxOf(wp, i);
      this.wws[i].gt = this.mode === 'exact'
        ? (this.wws[i].gtValid || (this.wws[i].gtValid = gainTable(P, wp, 'valid')))
        : gainTable(P, wp, 'local', ctx);
      this.wws[i].ctx = ctx;
      this.wws[i].bt = null;
      this.wws[i].chainG = null;
      this.wws[i].csk = null;
    });
  }
  /**
   * 上界の表 (docs/SEARCH_DESIGN.md 2.4 節「締めた上界」)。スキルに足す順 (chainGroups) を決めて、
   * f(L + X) - f(L) = Σ_k [k 番目のスキルを足した分] と分けると、k 番目のスキルの増え方は「前のスキルは上の所 (足した後の Lv 以上)、
   * 後のスキルはいまの Lv」の所で測ればよい (補い合う形なら、その所の増え方は本当の増え方より小さくない)。
   * 全部のスキルを上の所で測る setTables の表は、会心率 (防具スキル・見切り) と超会心のように補い合う組を両方とも上の値で数えるが、
   * この表ではどちらか一方だけになる。上の所は exact なら全部最大 (保証のある表と同じ評価器)、fast ならいまの最良の所 (ctx)。
   * 順は 防具スキル → シリーズ/グループ → 武器スキル (武器スキルは並びの後ろから)。兇爪竜の力のように別のスキル (連撃) が
   * 前提の効果は、前提のスキルの行に入らず、シリーズの行に入る。
   * 行は「後のスキルの Lv」ごとに覚え、武器ごとに 1 つの表 (ws.bt) を、変わった組 (防具・シリーズ/グループ・武器) の行だけ差し替える。
   */
  boundTable(L) {
    const P = this.P;
    // 覚えの上限: 超えていたら、引く前に全部の武器の行を忘れる (この呼び出しで作る行は、上限をこえても最後まで使う)
    if (this.boundRowsN > MEMO_LIMITS.boundRows) this.clearBoundRows();
    const ws = this.ws;
    const G = ws.chainG || (ws.chainG = this.chainGroupsOf());
    if (!ws.csk) {
      const fl = new Uint8Array(P.R);
      for (const r of G.flat) fl[r] = 1;
      const cut = (sk) => { const a = []; for (let i = 0; i < sk.length; i += 2) if (!fl[sk[i]]) a.push(sk[i], sk[i + 1]); return a; };
      ws.csk = { charm: this.charmCls.map((c) => cut(c.sk)), parts: this.partCls.map((cls) => cls.map((c) => cut(c.sk))) };
    }
    let bt = ws.bt;
    if (!bt) {
      bt = ws.bt = { hat: ws.gt.hat.slice(), pre: new Array(P.R).fill(null), wg: new Map(), code: [null, null, null], id: [0, 0], rows: [new Map(), new Map(), new Map()], ids: [new Map(), new Map()] };
      // 火力に効かないスキル (必須だけのもの) は先頭に置いて、全部を上の所で測る (後のスキルの行は Lv で引かない)
      for (const r of G.flat) { const row = this.chainRow(r, L, -1, 0); bt.hat[r] = row.h; bt.pre[r] = row.p; }
    }
    // 組ごとの Lv の並びの符号 (1 スキル 3 ビット。入らなければ文字列)
    const codeOf = (list) => {
      if (list.length * 3 > 51) return list.map((r) => (L[r] > P.maxLv[r] ? P.maxLv[r] : L[r])).join(',');
      let x = 0;
      for (const r of list) x = x * 8 + (L[r] > P.maxLv[r] ? P.maxLv[r] : L[r]);
      return x;
    };
    let dirty = false;
    for (let g = 2; g >= 0; g--) {
      // 防具スキルどうしを順にしないとき (G.blockA) は、防具スキルの行は後の組だけで決まる (防具スキルの Lv では引かない) ので、
      // 後の組が変わっていなければ引き直さない
      if (g === 0 && G.blockA && !dirty && bt.code[0] !== null) continue;
      const code = codeOf(G[g]);
      if (!dirty && code === bt.code[g]) continue;
      dirty = true;
      bt.code[g] = code;
      // この組の行: 後の組は番号 (id) で、同じ組の後のスキルは Lv で引く
      const outer = g === 2 ? 0 : g === 1 ? bt.id[1] : bt.id[0] * 65536 + bt.id[1];
      let m = bt.rows[g].get(outer);
      if (!m) bt.rows[g].set(outer, (m = new Map()));
      const list = G[g];
      // 防具スキルが多いときは、防具スキルどうしは順にしない (行の数が増えすぎるので。ほかの防具スキルは上の所で測る)
      const block = g === 0 && G.blockA;
      let suffix = 0;
      for (let i = list.length - 1; i >= 0; i--) {
        const r = list[i];
        const key = block ? i : typeof code === 'number' ? suffix * 64 + i : `${list.slice(i + 1).map((x) => L[x]).join(',')}|${i}`;
        let row = m.get(key);
        if (!row) {
          row = this.chainRow(r, L, g, i);
          m.set(key, row);
          this.boundRowsN++;
        }
        bt.hat[r] = row.h;
        bt.pre[r] = row.p;
        if (typeof code === 'number') suffix = suffix * 8 + (L[r] > P.maxLv[r] ? P.maxLv[r] : L[r]);
      }
      // 後の組から見たこの組の番号
      if (g > 0) {
        const idm = bt.ids[g - 1];
        let id = idm.get(code);
        if (id === undefined) idm.set(code, (id = idm.size));
        bt.id[g === 2 ? 1 : 0] = id;
      }
    }
    return bt;
  }
  /** 表の行を忘れる (全部の武器の分。覚えの上限) */
  clearBoundRows() {
    for (const ws of this.wws) ws.bt = null;
    this.boundRowsN = 0;
    this.stats.boundRowClears++;
  }
  /**
   * 上界の表のスキルの順 (いまの武器): 組 [防具スキル (とほか), シリーズ/グループ, 武器スキル (並びの後ろから)] と、
   * その前に置く「火力に効かないスキル」(flat。上限を外した評価器で、全部最大から 0 にしても、何も無い所に入れても値が変わらない。
   * 必須だけで入っている耐性スキルなど。下ごしらえの「関係するスキル」と同じ見方)
   */
  chainGroupsOf() {
    const P = this.P;
    const ev = this.wp.evU || this.wp.ev;
    const top = Int8Array.from(P.maxLv);
    const zero = new Int8Array(P.R);
    const fTop = ev.evaluate(top);
    const f0 = ev.evaluate(zero);
    const flat = [];
    for (let r = 0; r < P.R; r++) {
      const t = top.slice(); t[r] = 0;
      const z = zero.slice(); z[r] = P.maxLv[r];
      if (Math.abs(ev.evaluate(t) - fTop) <= Math.abs(fTop) * 1e-12 && Math.abs(ev.evaluate(z) - f0) <= Math.abs(f0) * 1e-12) flat.push(r);
    }
    const isFlat = new Uint8Array(P.R);
    for (const r of flat) isFlat[r] = 1;
    const G = this.chainGroups.map((list) => list.filter((r) => !isFlat[r]));
    G.flat = flat;
    G.blockA = G[0].length > this.tightOpt.chainArmor;
    return G;
  }
  /**
   * 足す順の i 番目 (組 g の中) のスキル r の行: 前のスキルは上の所、後のスキルはいまの Lv で測った増え方の凹の上包み (と累積和)。
   * g = -1 は全部を上の所で測る
   */
  chainRow(r, L, g, i) {
    const P = this.P;
    const exact = this.mode === 'exact';
    const c = exact ? Int8Array.from(P.maxLv) : Int8Array.from(this.ws.ctx);
    const G = this.ws.chainG;
    for (let gg = g; gg >= 0 && gg < 3; gg++) {
      if (gg === 0 && G.blockA) continue;
      const list = G[gg];
      for (let j = gg === g ? i + 1 : 0; j < list.length; j++) { const x = list[j]; c[x] = L[x] > P.maxLv[x] ? P.maxLv[x] : L[x]; }
    }
    const ev = exact ? (P.touchesAffinity[r] ? this.wp.evU : this.wp.evA) : this.wp.ev;
    const f = new Float64Array(P.maxLv[r] + 1);
    for (let j = 0; j <= P.maxLv[r]; j++) { c[r] = j; f[j] = ev.evaluate(c); }
    const d = new Float64Array(P.maxLv[r]);
    for (let j = 0; j < P.maxLv[r]; j++) d[j] = Math.max(0, f[j + 1] - f[j]);
    const h = []; const p = [];
    for (let base = 0; base <= P.maxLv[r]; base++) {
      const s = concaveSlopes(d, base);
      const a = new Float64Array(s.length + 1);
      for (let k = 0; k < s.length; k++) a[k + 1] = a[k] + s[k];
      h.push(s); p.push(a);
    }
    this.stats.boundRows++;
    return { h, p };
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
    if (this.chosen[0] >= 0 && sol.value > this.charmBest[this.chosen[0]]) this.charmBest[this.chosen[0]] = sol.value;
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
    // 最初の上界で -∞ (どの武器でも必須を満たせない) なら、すぐ「無い」。満たせるかだけを見るので、前の上界で測る
    // (締めた上界は武器ごとに表の行を作るので、武器が多いと途中の結果が遅れる)
    const tight = this.tight;
    this.tight = false;
    let roots;
    try { roots = this.P.weapons.map((wp, wi) => { this.setWeapon(wi); return this.bound(false, 0); }); } finally { this.tight = tight; }
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
        } else if (this.phase.startsWith('polish')) {
          if (this.polishStep(end)) {
            const wasPolish1 = this.phase === 'polish1';
            this.nextPhase();
            // 途中の結果 (partialReady) が出たら、dfs を始める前にいったん返す。同じ区切りで dfs を回すと、呼んだ側が
            // 読む前に厳密でない葉 (近似の値) が上位に入り、途中の結果に混ざる (所持護石が増えると起きやすい)
            if (wasPolish1 && !this.done) return false;
          }
        }
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
  /**
   * 「続けて探す」で続ける所があるか (extend が true を返すか。状態は変えない)。dfs を最後まで回り終えて、2 段のふるいで外した武器も
   * 残っていなければ false (画面は「続けて探す」を出さない)
   */
  canExtend() {
    if (!this.done || this.none || this.infeasible || this.mode !== 'fast') return false;
    const queueDone = !!this.weaponQueue && !this.stack && this.wq >= this.weaponQueue.length;
    if ((this.dfsFinished || queueDone) && this.sieveRest && this.sieveRest.length) return true;
    return !this.dfsFinished && !queueDone;
  }
  extend(budget) {
    if (!this.done || this.none || this.infeasible || this.mode !== 'fast') return false;
    // 2 段のふるいで外した武器は、選んだ武器の dfs を回り終えてから回す
    const queueDone = this.weaponQueue && !this.stack && this.wq >= this.weaponQueue.length;
    if ((this.dfsFinished || queueDone) && this.sieveRest && this.sieveRest.length) {
      this.weaponQueue.push(...this.sieveRest);
      this.sieveRest = [];
      this.dfsFinished = false;
    } else if (this.dfsFinished) return false;
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
    b.states = this.spread && this.phase === 'beam1' ? spreadByCharm(next, b.W) : next.slice(0, b.W);
    b.level++;
    if (b.level <= 5) return false;
    // 葉: 近似の珠詰め
    for (const st of b.states) {
      this.load(st);
      this.stats.leaves++;
      const sol = this.decoOpt(false, NEG);
      if (sol) {
        this.record(sol);
        // 2 段のふるい用: 防具・護石の組ごとの一番良い値 (どの武器でも)
        if (this.sieveOpt) {
          const k = `${st.charm}|${st.parts.join(',')}`;
          const old = this.beamLeaves.get(k);
          if (!old || old.value < sol.value) this.beamLeaves.set(k, { charm: st.charm, parts: st.parts.slice(), value: sol.value });
        }
      }
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
    this.sieveRest = [];
    // 2 段のふるい: ビームの上位の防具・護石の組を残った武器で測り直して、dfs を回す武器を絞る (sieveStep)
    if (this.sieveOpt) {
      const combos = new Map();
      for (const e of this.list) combos.set(`${e.charm}|${e.parts.join(',')}`, { charm: e.charm, parts: e.parts, value: e.value });
      for (const [k, x] of [...this.beamLeaves].sort((a, b) => b[1].value - a[1].value)) {
        if (combos.size >= this.sieveOpt.top) break;
        if (!combos.has(k)) combos.set(k, x);
      }
      this.beamLeaves = new Map();
      if (combos.size) {
        this.sieve = { cands: this.weaponQueue.filter((w) => w.ub > NEG), i: 0, combos: [...combos.values()], best: [], measured: 0 };
      }
    }
  }

  /**
   * 2 段のふるい (docs/SEARCH_DESIGN.md 2.7 節): ビームの上位の防具・護石の組 (sieveOpt.top 件) を、残った武器ごとに近似の葉
   * (珠の詰め方) で測り直し、一番良い値の大きい武器 sieveOpt.weapons 本だけで dfs を回す。いまの 1 位の武器は必ず残す。
   * 測った組は上位にも入れる (ビームが別の武器で見た組を、この武器で使える)。根の上界が 3 本目の値以下の武器は測らない。
   * 残りの武器は「続けて探す」(extend) で回す。区切りの時刻 end を過ぎたら false (続きは次の step)。
   */
  sieveStep(end) {
    const sv = this.sieve;
    const nW = this.sieveOpt.weapons;
    while (sv.i < sv.cands.length) {
      if (now() > end) return false;
      const w = sv.cands[sv.i++];
      const third = sv.best.length >= nW ? sv.best[nW - 1].score : NEG;
      if (w.ub <= third) continue;
      let score = NEG;
      for (const c of sv.combos) {
        this.load({ wi: w.wi, charm: c.charm, parts: c.parts });
        this.stats.leaves++;
        const sol = this.decoOpt(false, Math.max(score, third));
        if (sol) {
          this.record(sol);
          if (sol.value > score) score = sol.value;
        }
      }
      sv.measured++;
      if (score > NEG) {
        let k = sv.best.length;
        while (k > 0 && sv.best[k - 1].score < score) k--;
        sv.best.splice(k, 0, { wi: w.wi, score });
        if (sv.best.length > nW) sv.best.pop();
      }
    }
    // dfs を回す武器 = 上位 nW 本 + いまの 1 位の武器 (根の上界の大きい順のまま)
    const keep = new Set(sv.best.map((x) => x.wi));
    if (this.list.length) keep.add(this.list[0].wi);
    this.sieveRest = this.weaponQueue.filter((w) => !keep.has(w.wi));
    this.weaponQueue = this.weaponQueue.filter((w) => keep.has(w.wi));
    this.stats.sieve = { combos: sv.combos.length, measured: sv.measured, weapons: this.weaponQueue.map((w) => w.wi) };
    this.stats.phases.push({ name: 'sieve', endMs: now() - this.t0, best: this.list[0]?.value ?? null });
    this.sieve = null;
    return true;
  }
  beginWeapon(wi) {
    this.setWeapon(wi);
    const kids = [];
    const rec = this.tight && !this.none && this.tightOpt.screen ? 0 : -1;
    for (let ci = 0; ci < this.charmCls.length; ci++) {
      this.applyAt(0, ci);
      const ub = this.bound(true, 0, rec);
      this.applyAt(0, ci, -1);
      this.stats.nodes++;
      if (ub > NEG && !(!this.none && this.prune(ub))) kids.push({ idx: ci, ub, screen: rec >= 0 ? this.kidUbOf(rec).slice() : null });
    }
    if (!this.none) kids.sort((a, b) => b.ub - a.ub);
    // spread: 根は見つかった値の高い順 (同じなら上界の順)。上界の順ではなくなるので、根では刈れる子を 1 つずつ飛ばす (anyOrder)
    let anyOrder = false;
    if (this.spread) {
      const cb = this.charmBest;
      kids.sort((a, b) => (cb[a.idx] === cb[b.idx] ? b.ub - a.ub : cb[b.idx] > cb[a.idx] ? 1 : -1));
      anyOrder = true;
    }
    this.stack = [{ d: 0, kids, i: 0, applied: -1, anyOrder }];
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
    if (this.sieve) {
      if (!this.sieveStep(end)) return false;
      if (this.overBudget(stepStart)) { this.cut = true; return true; }
    }
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
      // 子は上界の大きい順なので、刈れる子の後ろも全部刈れる (anyOrder の節 = spread の根だけは、その子だけ飛ばす)
      if (!this.none && this.prune(kid.ub)) { if (!fr.anyOrder) fr.i = fr.kids.length; continue; }
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
      // 子を測る前のふるい: いまの節の上界を「部位 pi だけ類を決めた」形で類ごとに出し、それで刈れる子は測らない
      // (どの λ の上界も、部位 pi をその類に決めた枝の上界になる)
      // (この節の上界を測ったときに覚えておいたもの。無ければ測り直す)
      const screenOn = this.tight && !this.none && this.tightOpt.screen;
      let screen = screenOn ? kid.screen : null;
      if (screenOn && !screen) {
        const ub0 = this.bound(true, pi, pi);
        screen = ub0 === NEG || this.prune(ub0) ? 'all' : this.kidUbOf(pi).slice();
      }
      const rec = screenOn && pi + 1 < 5 ? pi + 1 : -1;
      for (let k = 0; k < cls.length; k++) {
        if (screen && (screen === 'all' || this.prune(screen[k]))) { this.stats.nodes++; this.stats.kidsScreened++; continue; }
        this.applyPiece(cls[k], +1);
        const ub = this.bound(true, pi + 1, rec);
        this.applyPiece(cls[k], -1);
        this.stats.nodes++;
        if (ub > NEG && !(!this.none && this.prune(ub))) kids.push({ idx: k, ub, screen: rec >= 0 ? this.kidUbOf(rec).slice() : null });
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
