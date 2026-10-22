// 締めた上界 (docs/SEARCH_DESIGN.md 2.4 節「締めた上界」) の確かめの共通部分 (tests/search_bound.test.mjs・search_bound_random.test.mjs)。
// 小さい問題の部分状態で、
//   - 上界 ≥ その節から届く本当の最良 (ソルバのコードを使わない総当たり)
//   - 前の上界 (tight: false) 以下
//   - 子を測る前のふるい (部位を 1 つ決めた上界) も、類ごとにその枝の本当の最良以上
//   - 覚え (表の行・武器の珠の上積み) を使った上界が、毎回表を作り直した上界と同じ (dfs のように親 → 子 → 兄弟と歩く)
//   - 足す順の表の行が、その所の本当の増え方以上 (全体の上界の余裕に隠れる誤りも見える)
// を mode 'exact' (保証のある表) で、防具スキルどうしを順にしない形 (chainArmor 0) でも確かめる。
import assert from 'node:assert/strict';
import { TIGHT } from '../app/model/search/solver.js';
import { makeRng } from './search_brute.mjs';

/** 1 つの問題で確かめる部分状態の数 */
const STATES = 150;
// 締めた上界の決まりの変え方: いまの決まり・防具スキルどうしを順にしない形 (G.blockA。仮置き 50% のケースで通る道)・λ の回を全部の深さで
// 試す形 (いまの決まりでは浅い所だけで、上界と本当の最良の差が大きく、λ の回の誤りが見えにくい)
const VARIANTS = [{ name: '既定' }, { name: '防具スキルを順にしない', t: { chainArmor: 0 } },
  { name: 'λ を全部の深さで', t: { zeroDepth: 5, uniDepth: 5, uniEvals: 9 } }];
const le = (a, b) => a === -Infinity || a <= b + 1e-9 * Math.max(1, Math.abs(b));
const same = (a, b) => a === b || Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a));

/** 部分状態の列: 半分は乱数、半分は dfs のような歩き (子へ・兄弟へ・根へ。表の行の覚えの差し替えを通す) */
function statesOf(S, rnd, n) {
  const out = [];
  let cur = { charmDone: true, d: 0, ch: 0, parts: [-1, -1, -1, -1, -1] };
  for (let i = 0; i < n; i++) {
    if (rnd() < 0.5) {
      const charmDone = rnd() < 0.85;
      const d = charmDone ? Math.floor(rnd() * 6) : 0;
      const ch = charmDone ? Math.floor(rnd() * S.charmCls.length) : -1;
      cur = { charmDone, d, ch, parts: [0, 1, 2, 3, 4].map((pi) => (pi < d ? Math.floor(rnd() * S.partCls[pi].length) : -1)) };
    } else {
      const x = rnd();
      const p = cur.parts.slice();
      if (!cur.charmDone || cur.d >= 5 || x < 0.15) cur = { charmDone: true, d: 0, ch: Math.floor(rnd() * S.charmCls.length), parts: [-1, -1, -1, -1, -1] };
      else if (x < 0.6 || cur.d === 0) { p[cur.d] = Math.floor(rnd() * S.partCls[cur.d].length); cur = { ...cur, d: cur.d + 1, parts: p }; }
      else { p[cur.d - 1] = Math.floor(rnd() * S.partCls[cur.d - 1].length); cur = { ...cur, parts: p }; }
    }
    out.push(cur);
  }
  return out;
}

/** 状態 st の上界 (tight で締めた上界か前の上界)。kid: 部位 st.d の類ごとのふるいの値も返す */
function ubAt(S, st, tight, kid = false) {
  S.tight = tight;
  S.list = []; S.keys = new Map(); S.phase = 'dfs';
  S.load({ wi: 0, charm: st.ch, parts: st.parts });
  const ub = S.bound(st.charmDone, st.d);
  if (!kid || !st.charmDone || st.d >= 5) return { ub, kid: null };
  return { ub, kid: S.bound(st.charmDone, st.d, st.d) > -Infinity ? S.kidUbOf(st.d).slice() : null };
}

/**
 * 足す順の表 (boundTable) の行を直接比べる: スキル r の行の累積 ≥ 「前のスキルは最大・後のスキルはいまの Lv」の所で、本当の評価器で
 * r だけ x 上げた増え方。比べた回数を返す
 */
function checkRows(S, st) {
  const P = S.P;
  S.tight = true;
  S.load({ wi: 0, charm: st.ch, parts: st.parts });
  const L = Int8Array.from(S.levels(), (v, r) => Math.min(v, P.maxLv[r]));
  const bt = S.boundTable(L);
  const G = S.ws.chainG;
  let n = 0;
  for (let g = 0; g < 3; g++) {
    G[g].forEach((r, i) => {
      const c = Int8Array.from(P.maxLv);
      for (let gg = g; gg < 3; gg++) {
        if (gg === 0 && G.blockA) continue;
        for (let j = gg === g ? i + 1 : 0; j < G[gg].length; j++) c[G[gg][j]] = L[G[gg][j]];
      }
      const base = L[r];
      const pre = bt.pre[r][base];
      c[r] = base;
      const f0 = S.wp.ev.evaluate(c);
      for (let x = 1; base + x <= P.maxLv[r]; x++) {
        c[r] = base + x;
        const inc = S.wp.ev.evaluate(c) - f0;
        assert.ok(inc <= pre[x] + 1e-9 * Math.max(1, Math.abs(f0)), `表の行 (組 ${g} の ${i} 番目・Lv ${base} + ${x}): ${pre[x]} < 本当の増え方 ${inc}`);
        n++;
      }
    });
  }
  return n;
}

/**
 * 1 つの問題を確かめる (頭の 5 つ)。S = createSearch が作った mode 'exact' のソルバ、brute = bruteForce の結果。
 * slack: 上界・ふるいと本当の最良の差の一番小さいもの (相対) を入れる入れ物 {ub, kid} (乱数で作る問題の検出力を見る)。返り値: 数えたもの
 */
export function checkProblem(S, brute, seed, slack = null) {
  assert.equal(S.mode, 'exact');
  const rnd = makeRng(seed * 7919 + 13);
  const states = statesOf(S, rnd, STATES);
  const wants = states.map((st) => {
    const inState = (b, also = null) => (st.ch < 0 || S.charmCls[st.ch].members.includes(b.charm))
      && st.parts.every((k, pi) => k < 0 || S.partCls[pi][k].members.includes(b.armor[S.partOrder[pi]])) && (!also || also(b));
    const bestOf = (also) => { const b = brute.all.find((x) => inState(x, also)); return b ? b.value : -Infinity; };
    return { want: bestOf(), kids: st.charmDone && st.d < 5 ? S.partCls[st.d].map((c) => bestOf((b) => c.members.includes(b.armor[S.partOrder[st.d]]))) : null };
  });
  const ub0 = states.map((st) => ubAt(S, st, false).ub);
  const out = { states: 0, tighter: 0, screened: 0, rows: 0 };
  for (const v of VARIANTS) {
    S.tightOpt = { ...TIGHT, ...(v.t || {}) };
    S.setTables(() => null);
    // 覚えを使う回 (表を作り直さずに状態を次々に) と、毎回表を作り直す回
    const cached = states.map((st) => ubAt(S, st, true, true));
    const fresh = states.map((st) => { S.setTables(() => null); return ubAt(S, st, true, true); });
    states.forEach((st, i) => {
      const where = `${v.name}・護石 ${st.ch}・部位 ${st.parts.join(',')}`;
      const { ub, kid } = cached[i];
      assert.ok(same(ub, fresh[i].ub), `覚えを使った上界 ${ub} と作り直した上界 ${fresh[i].ub} が違う (${where})`);
      assert.equal(!kid, !fresh[i].kid);
      if (kid) kid.forEach((x, k) => assert.ok(same(x, fresh[i].kid[k]), `覚えを使ったふるい ${x} と作り直したもの ${fresh[i].kid[k]} が違う (${where}・類 ${k})`));
      const { want, kids } = wants[i];
      assert.ok(le(want, ub), `上界 ${ub} < 本当の最良 ${want} (${where})`);
      if (!v.t) {
        assert.ok(le(ub, ub0[i]), `前の上界 ${ub0[i]} より大きい ${ub} (${where})`);
        if (ub < ub0[i] - 1e-9) out.tighter++;
        out.states++;
      }
      if (slack && want > -Infinity) slack.ub = Math.min(slack.ub, (ub - want) / Math.abs(want));
      if (kid && kids) {
        kids.forEach((w, k) => {
          assert.ok(w === -Infinity || kid[k] >= w - 1e-9 * Math.max(1, Math.abs(w)), `ふるい ${kid[k]} < 本当の最良 ${w} (${where}・類 ${k})`);
          if (slack && w > -Infinity) slack.kid = Math.min(slack.kid, (kid[k] - w) / Math.abs(w));
          out.screened++;
        });
      }
    });
    // 表の行: 10 状態に 1 つ
    for (let i = 0; i < states.length; i += 10) out.rows += checkRows(S, states[i]);
  }
  S.tightOpt = { ...TIGHT };
  S.setTables(() => null);
  S.tight = true;
  return out;
}
