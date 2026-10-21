// 装備探索のテストの変異テスト (docs/SEARCH_DESIGN.md 6.5 節)。手で回す (node --test には入れない)。
//
//   node tools/mutate_search.mjs [--dir 作業用のフォルダ] [--only 名前,名前]
//
// リポ (app/・data/・tests/) を作業用のフォルダに写し、1 か所だけ壊してテストを回す。テストが落ちれば「見つけた」。
// 落ちなかった変異は、テストを足すか、なぜ見えないかを書く (結果の表の「理由」)。
// 作業用のフォルダは既定で OS の一時フォルダの下に作り、終わったら消す。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TESTS = ['tests/search_eval.test.mjs', 'tests/search_small.test.mjs', 'tests/search_required.test.mjs', 'tests/search_api.test.mjs',
  'tests/search_weapon_side.test.mjs'];

/** 変異: file の find (1 か所だけ) を replace に。why = 見つけるはずのテスト */
const MUTANTS = [
  // ---- damage.js (評価器が写している式。search_eval.test.mjs で落ちるはず)
  { name: 'damage: 弱点特効の肉質の境 (>= → >)', file: 'app/model/damage.js',
    find: 'if (physHz >= wpMin) aff += m.weakPointAffinity;', replace: 'if (physHz > wpMin) aff += m.weakPointAffinity;', why: '6.1' },
  { name: 'damage: 攻撃の加算の上限 400 → 399', file: 'app/model/damage.js',
    find: 'const a = Math.min(add, rules.physicalAddLimit ?? Infinity);', replace: 'const a = Math.min(add, (rules.physicalAddLimit ?? Infinity) - 1);', why: '6.1' },
  { name: 'damage: 会心の倍率', file: 'app/model/damage.js',
    find: 'if (p >= 0) return 1 + p * ((critMul ?? rules.criticalBase) - 1);', replace: 'if (p >= 0) return 1 + p * ((critMul ?? rules.criticalBase) - 1.01);', why: '6.1' },
  { name: 'damage: 斬れ味の補正 (白を青で)', file: 'app/model/damage.js',
    find: ': sharpnessMultipliers(color, rules);', replace: ": sharpnessMultipliers(color === 'white' ? 'blue' : color, rules);", why: '6.1' },
  { name: 'damage: 属性の加算の上限を外す', file: 'app/model/damage.js',
    find: 'const a = Math.min(add, rules.elementAddLimit ?? Infinity);', replace: 'const a = add;', why: '6.1' },
  // ---- 評価器 (速い道)
  { name: '評価器: 速い道の弱点特効の境 (>= → >)', file: 'app/model/search/evaluator.js',
    find: 'const box = (physHz >= wpMin ? 1 : 0)', replace: 'const box = (physHz > wpMin ? 1 : 0)', why: '6.1' },
  { name: '評価器: 段のある条件 (byState) を主効果で数える', file: 'app/model/search/evaluator.js',
    find: 'const ch = row.byState[st] || (actStatesOf[r].includes(st) ? row.main : null);',
    replace: 'const ch = actStatesOf[r].includes(st) ? row.main : null;', why: '6.1' },
  { name: '評価器: 同時に起きない条件を独立に扱う (因子に分けない)', file: 'app/model/search/evaluator.js',
    find: 'for (const o2 of g.exclusiveWith || []) { const j = gids.indexOf(o2); if (j >= 0) comp[find(i)] = find(j); }',
    replace: 'for (const o2 of []) { const j = gids.indexOf(o2); if (j >= 0) comp[find(i)] = find(j); }', why: '6.1' },
  // ---- 探索 (6.2・6.3 で落ちるはず)
  { name: '探索: 葉で Lv3 スロットを 1 つ数え落とす', file: 'app/model/search/solver.js',
    find: "    const budget = [0, this.slot[1], this.slot[2], this.slot[3]];\n    const key = `${L0.join(',')}",
    replace: "    const budget = [0, this.slot[1], this.slot[2], Math.max(0, this.slot[3] - 1)];\n    const key = `${L0.join(',')}", why: '6.2' },
  { name: '探索: 防具用の珠の上界で、大きさ 3 の珠を入らないとみなす (上界が低すぎる)', file: 'app/model/search/solver.js',
    find: 'if (sz === 3) { if (c[3] + 1 > B3 || c[3] + c[2] + 1 > B23) { open3 = false; continue; } c[3]++; }',
    replace: 'if (sz === 3) { open3 = false; continue; }', why: '6.2' },
  { name: '探索: 限界突破を無視する', file: 'app/model/search/problem.js',
    find: 'const slots = sortDesc(lbOn && Array.isArray(a.slotsLimitBreak) ? a.slotsLimitBreak : a.slots);',
    replace: 'const slots = sortDesc(a.slots);', why: '6.2' },
  { name: '探索: シリーズの部位数を 1 つずらす', file: 'app/model/search/solver.js',
    find: 'let lv = 0; for (const rk of P.sets[s].ranks) if (c >= rk.pieces) lv = Math.max(lv, rk.level);',
    replace: 'let lv = 0; for (const rk of P.sets[s].ranks) if (c + 1 >= rk.pieces) lv = Math.max(lv, rk.level);', why: '6.2' },
  { name: '探索: 優越の除去で珠の大きさを全部 1 とみなす', file: 'app/model/search/problem.js',
    find: 'need[armorDeco[r].slot] += d;', replace: 'need[1] += d;', why: '6.2' },
  { name: '探索: 武器用の珠を防具 (頭) のスロットに入れる', file: 'app/model/search/realize.js',
    find: "const wSlots = (wp.w.slots || []).map((x, i) => ({ t: 'weapon', i, size: Number(x) || 0 }));",
    replace: "const wSlots = (wp.w.slots || []).map((x, i) => ({ t: 'head', i, size: Number(x) || 0 }));", why: '6.2' },
  { name: '探索: 防具用の珠の DFS で必須の分を試さない', file: 'app/model/search/solver.js',
    find: 'for (let n = hiN; n >= minN; n--) {', replace: 'for (let n = hiN; n > minN; n--) {', why: '6.2/6.3' },
  { name: '探索: シリーズの必須の判定で残りの部位を数えない', file: 'app/model/search/solver.js',
    find: 'for (let pi = from; pi < 5; pi++) if (this.partHasSet[pi][s]) avail++;\n        const n = this.setCnt[s] + avail;',
    replace: 'for (let pi = from; pi < 5; pi++) if (this.partHasSet[pi][s]) avail += 0;\n        const n = this.setCnt[s] + avail;', why: '6.3' },
  { name: '探索: 武器スキルの必須を武器用の珠で確かめない', file: 'app/model/search/solver.js',
    find: "for (const r of this.reqR) if (P.kind[r] === 'weapon' && Math.min(P.maxLv[r], L0[r] + w.vec[r]) < P.reqLv[r]) ok = false;",
    replace: '', why: '6.3' },
  // ---- 武器の側だけを選び直す (search_weapon_side.test.mjs で落ちるはず)
  { name: '武器の側: 珠の組で必須を確かめない', file: 'app/model/search.js',
    find: 'if (L[r] < P.reqLv[r]) ok = false;', replace: '', why: 'weapon_side' },
  { name: '武器の側: 上界を最後の珠の組だけで作る (上界にならない)', file: 'app/model/search.js',
    find: 'for (const c of combos) if (c.vec[r] > top) top = c.vec[r];', replace: 'if (combos.length) top = combos[combos.length - 1].vec[r];',
    why: 'weapon_side' },
  { name: '武器の側: group ごとの値を全体の割合で混ぜない', file: 'app/model/search.js',
    find: 'groups.forEach((g, gi) => { vals[gi] = evs[wi][gi].evaluate(L); value += g.W * vals[gi]; });',
    replace: 'groups.forEach((g, gi) => { vals[gi] = evs[wi][gi].evaluate(L); value += vals[gi]; });', why: 'weapon_side' },
];

function args() {
  const a = process.argv.slice(2);
  const o = { dir: null, only: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--dir') o.dir = a[++i];
    else if (a[i] === '--only') o.only = a[++i].split(',');
  }
  return o;
}

function copyRepo(dst) {
  for (const sub of ['app', 'data', 'tests']) {
    fs.cpSync(path.join(ROOT, sub), path.join(dst, sub), {
      recursive: true, filter: (src) => !/[\\/](artifacts|__pycache__)([\\/]|$)/.test(src),
    });
  }
}

function runTests(dir) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, ['--test', ...TESTS], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const failed = (res.stdout.match(/^✖ (?!failing tests)(.+)$/gm) || []).map((l) => l.replace(/^✖ /, '').replace(/ \([\d.]+ms\)$/, ''));
  return { code: res.status, failed: [...new Set(failed)], ms: Date.now() - t0 };
}

function main() {
  const o = args();
  const made = !o.dir;
  const dir = o.dir ? path.resolve(o.dir) : fs.mkdtempSync(path.join(os.tmpdir(), 'mhwilds-mutate-'));
  fs.mkdirSync(dir, { recursive: true });
  copyRepo(dir);
  try {
    const base = runTests(dir);
    console.log(JSON.stringify({ mutant: '(壊さない)', testsPass: base.code === 0, ms: base.ms, failed: base.failed }));
    if (base.code !== 0) throw new Error('壊す前にテストが落ちている');
    const rows = [];
    for (const m of MUTANTS) {
      if (o.only && !o.only.some((x) => m.name.includes(x))) continue;
      const file = path.join(dir, m.file);
      const orig = fs.readFileSync(file, 'utf8');
      const n = orig.split(m.find).length - 1;
      if (n !== 1) { rows.push({ mutant: m.name, error: `置き換える所が ${n} か所` }); console.log(JSON.stringify(rows.at(-1))); continue; }
      fs.writeFileSync(file, orig.replace(m.find, m.replace));
      try {
        const r = runTests(dir);
        rows.push({ mutant: m.name, detected: r.code !== 0, expectedBy: m.why, failed: r.failed.slice(0, 4), ms: r.ms });
      } finally {
        fs.writeFileSync(file, orig);
      }
      console.log(JSON.stringify(rows.at(-1)));
    }
    const survived = rows.filter((r) => r.detected === false);
    console.log(`見つけた ${rows.filter((r) => r.detected).length} / ${rows.length}。見逃し: ${survived.map((r) => r.mutant).join(' / ') || 'なし'}`);
  } finally {
    if (made) fs.rmSync(dir, { recursive: true, force: true });
  }
}

main();
