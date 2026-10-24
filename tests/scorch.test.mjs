// 灼熱化 (火竜の力) の計算 (docs/sources/damage.md「灼熱化」・2026-10-24 の仕様) のテスト。期待値は手計算 (式はコメントに書く)。
// 判定の重み (checkWeights / planCheckWeights)・1 回のダメージ (火の属性スキル)・comboExpected の 2 つの道・速い評価器との一致。
// 実行: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  CHECK_EPS, checkWeights, planCheckWeights, comboPlan, comboExpected, hitDamage, computeStats, aggregateModifiers,
  extraDamageOnce, DEFAULT_RULES,
} from '../app/model/damage.js';
import { makeEvaluator } from '../app/model/search/evaluator.js';
import { mixExpected, extraHintText } from '../app/ui/tabs/power_calc.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (name) => JSON.parse(readFileSync(join(ROOT, 'data', name), 'utf8'));
const EFFECTS = load('skill_effects.json');
const MOTIONS = load('motions_sns.json');
const COMBOS = load('combos_sns.json').combos;
const comboById = (id) => COMBOS.find((c) => c.id === id);

const close = (actual, expected, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);
const closeAll = (actual, expected, eps = 1e-9) => {
  assert.equal(actual.length, expected.length);
  expected.forEach((e, i) => close(actual[i], e, eps));
};
const rel = (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(b));

function skillIdByName(name) {
  const hit = Object.entries(EFFECTS.effects).find(([, e]) => e.name === name);
  assert.ok(hit, `skill_effects.json に ${name} が無い`);
  return Number(hit[0]);
}
const SCORCH = skillIdByName('火竜の力');
const FIRE_UP = skillIdByName('火属性攻撃強化');
const DRAGON_UP = skillIdByName('龍属性攻撃強化');
const CHAIN = skillIdByName('連撃');
const GOGMA = skillIdByName('巨戟龍の黙示録');
const CURE = skillIdByName('災禍転福');
const lvOf = (id, level) => EFFECTS.effects[String(id)].levels.find((l) => l.level === level);
const SPEC2 = lvOf(SCORCH, 2).extraDamage;
const HZ = { slash: 45, blunt: 45, fire: 20, water: 10, thunder: 10, ice: 10, dragon: 25 };

// ---------------------------------------------------------------- 判定の重み (純関数)

test('checkWeights: 0.5 秒おきのヒット・待ち 2.4 秒 → 2.5 秒おきに判定する', () => {
  // 1 周 2.0 秒に 0 / 0.5 / 1.0 / 1.5 秒。判定は 0 → 2.5 (2 周目の 2 つ目) → 5.0 (3 周目の 3 つ目) → 7.5 (4 周目の 4 つ目)
  // → 10.0 (6 周目の 1 つ目 = 最初と同じ形)。5 周に 4 回で、どのヒットも 5 周に 1 回 → 0.2
  closeAll([...checkWeights([0, 0.5, 1.0, 1.5], 2.0, 2.4)], [0.2, 0.2, 0.2, 0.2]);
  // 1 周 2.5 秒に 5 ヒット (0.5 秒おき): 毎周 1 つ目だけが判定 (2.5 ≥ 2.4)
  closeAll([...checkWeights([0, 0.5, 1.0, 1.5, 2.0], 2.5, 2.4)], [1, 0, 0, 0, 0]);
  // 当たっても外れても待つので、1 周の判定の回数の上限は 周の秒数 / 待ち (ここでは 2.0 / 2.5 = 0.8)
});

test('checkWeights: 1 周に対象 1 回なら、周が 2.4 秒以上で毎周、1.5 秒で 2 周に 1 回、1.0 秒で 3 周に 1 回', () => {
  closeAll([...checkWeights([0.3], 2.78, 2.4)], [1]);
  // 1.5 秒: 前の判定から 1.5 秒 (< 2.4) では判定せず、3.0 秒で判定 → 0.5
  closeAll([...checkWeights([0.25], 1.5, 2.4)], [0.5]);
  // 1.0 秒: 1.0・2.0 秒は待ち、3.0 秒で判定 → 1/3
  closeAll([...checkWeights([0.1], 1.0, 2.4)], [1 / 3]);
});

test('checkWeights: ε の境目 (ちょうど 2.4 秒は判定。CHECK_EPS までのずれは同じ扱い、それより遅いと待つ)', () => {
  // 144 フレーム = 2.4 秒 (60fps)。毎周判定
  closeAll([...checkWeights([0], 144 / 60, 2.4)], [1]);
  // 0.8 秒おき 3 ヒット (1 周 0.8 × 3 = 2.4000000000000004 秒): 毎周 1 つ目が判定
  closeAll([...checkWeights([0, 0.8, 1.6], 0.8 * 3, 2.4)], [1, 0, 0]);
  // 待ちが幅の半分だけ長い: 同じ扱い
  closeAll([...checkWeights([0, 0.8, 1.6], 2.4, 2.4 + CHECK_EPS / 2)], [1, 0, 0]);
  // 待ちが幅の 10 倍長い: 2.4 秒後の 1 つ目は待ちの中。判定は 0 → 3.2 → 6.4 → 9.6 (5 周目の 1 つ目 = 最初と同じ形)
  // → 4 周に 3 回で、どのヒットも 4 周に 1 回 → 0.25
  closeAll([...checkWeights([0, 0.8, 1.6], 2.4, 2.4 + 10 * CHECK_EPS)], [0.25, 0.25, 0.25]);
});

test('checkWeights: 周を超える時刻は後の周の同じ位置と同じ。空の入力・待ち 0 秒', () => {
  closeAll([...checkWeights([2.5 + 0.1, 0.6], 2.5, 2.4)], [...checkWeights([0.1, 0.6], 2.5, 2.4)]);
  assert.equal(checkWeights([], 2.0, 2.4).length, 0);
  // 待ちが無ければ全部判定
  closeAll([...checkWeights([0, 0.3, 0.9], 1.0, 0)], [1, 1, 1]);
});

// ---------------------------------------------------------------- 本物のデータのコンボ

test('planCheckWeights: 代表コンボの判定の割合 (技のフレームとつなぎの見積もり mid から手で数えた値)', () => {
  const tg = { hitzone: HZ };
  const one = (id) => {
    const warnings = [];
    const r = planCheckWeights(comboPlan(MOTIONS, comboById(id), tg, warnings), SPEC2, warnings);
    return { ...r, warnings };
  };
  // △連携: 斬り下ろし (つなぎ 33f・判定 15f) → 横斬り (24f・6f) → 斜め斬り上げ (38f・20f) → 斜め斬り下ろし (45f・18f)。
  // 対象ヒットの時刻 15 / 39 / 77 / 113f (0.25 / 0.65 / 1.283 / 1.883 秒)、1 周 140f = 2.333 秒。
  // 判定: 0.25 → 2.983 (2 周目の横斬り) → 5.95 (3 周目の斜め斬り上げ) → 8.883 (4 周目の斜め斬り下ろし)
  //       → 11.917 (6 周目の斬り下ろし = 0.25 + 5 周)。5 周に 4 回、どのヒットも 5 周に 1 回
  const g = one('ground_basic');
  close(g.cycleSec, 140 / 60, 1e-12);
  closeAll(g.perHit.map((a) => a[0]), [0.2, 0.2, 0.2, 0.2]);
  close(g.checksPerCycle, 0.8);
  assert.deepEqual(g.warnings, []);
  assert.equal(g.estimated, false);
  // ジャストラッシュ (1〜3 段): 1 周 72 + 30 + 65 = 167f = 2.783 秒、対象は 3 段目の剣 (102 + 28 = 130f) だけ → 毎周 (2.783 ≥ 2.4)
  const j = one('just_rush_perfect');
  close(j.cycleSec, 167 / 60, 1e-12);
  assert.deepEqual(j.perHit.map((a) => [...a]), [[0, 0, 0], [0], [1, 0, 0]]);
  // 溜め斬り落とし: 1 周 90f = 1.5 秒、対象は斬り上げ (15f) だけ → 2 周に 1 回
  const c = one('charged_chop');
  close(c.cycleSec, 1.5, 1e-12);
  assert.deepEqual(c.perHit.map((a) => [...a]), [[0.5, 0, 0]]);
  // 集中弱点攻撃 (傷口): 対象ヒットが無い → 0、秒数の警告なし (この相手には傷口が無いので no-wound だけ)
  const f = one('focus_wound');
  assert.equal(f.checksPerCycle, 0);
  assert.deepEqual(f.warnings.map((w) => w.code), ['no-wound']);
  // コンボの cycleSec (画面と確かめ用) は、技の linkSec の和と同じ
  for (const cb of COMBOS) close(cb.cycleSec.mid, one(cb.id).cycleSec, 1e-5);
});

test('count 2 以上の対象ヒットは 0.1 秒おき (multiHitTimer があればそのフレーム) に並べる', () => {
  const mk = (hit) => ({ moves: [{ id: 'm', name: 'M', timing: { fps: 60, frameCount: 360, linkSec: { low: 6, mid: 6, high: 6 } },
    hits: [{ mv: 10, type: 'slash', elementRate: 0, additionalDamage: true, atSec: 0, ...hit }] }] });
  const w = (motions) => planCheckWeights(comboPlan(motions, ['m'], { hitzone: HZ }), SPEC2).perHit[0][0];
  // 3 回が 0 / 0.1 / 0.2 秒: 判定は最初の 1 回だけ (1 周 6 秒なので毎周)
  close(w(mk({ count: 3, multiHitTimer: 0 })), 1);
  // 2 回が 150 フレーム (2.5 秒) おき: どちらも判定 (2.5 ≥ 2.4、次の周まで 3.5 秒) → 1 周に 2 回
  close(w(mk({ count: 2, multiHitTimer: 150 })), 2);
});

test('no-timing: 秒数の分からない技は全長か 1.0 秒で数え、警告を出す (灼熱化が無ければ出さない)', () => {
  // ジャンプ斬り = モーションが決められない (長さ 1.0 秒・時刻 0)。回転斬り = つなぎの見積もりが無い (後隙込みの全長 70f)
  const base = {
    weapon: { attack: 200, affinity: 0, element: null }, sharpness: 'white', effects: EFFECTS, motions: MOTIONS,
    combo: ['jump_slash', 'spin_slash'], target: { hitzone: HZ },
  };
  const r = comboExpected({ ...base, skills: [{ skillId: SCORCH, level: 2 }] });
  const nt = r.warnings.filter((w) => w.code === 'no-timing');
  assert.deepEqual(nt.map((w) => w.move), ['jump_slash', 'spin_slash']);
  assert.match(nt[0].message, /1\.0 秒/);
  assert.match(nt[0].message, /当たる時刻を技の始まり/);
  assert.match(nt[1].message, /後隙込み 1\.17 秒/);
  assert.equal(r.extraChecks.length, 1);
  assert.equal(r.extraChecks[0].estimated, true);
  close(r.extraChecks[0].cycleSec, 1.0 + 70 / 60, 1e-12);
  const none = comboExpected({ ...base, skills: [] });
  assert.equal(none.warnings.filter((w) => w.code === 'no-timing').length, 0);
  assert.deepEqual(none.extraChecks, []);
});

// ---------------------------------------------------------------- 1 回のダメージ (火の属性スキル)

test('1 回のダメージ: 火属性攻撃強化 Lv0〜3 は火の内部値に倍率 → 加算の順で掛かる (Ⅱ・火肉質 20)', () => {
  const D = (fireLv) => {
    const list = [lvOf(SCORCH, 2), ...(fireLv ? [lvOf(FIRE_UP, fireLv)] : [])];
    return extraDamageOnce(SPEC2, aggregateModifiers(list, 'dragon'), { fire: 20 });
  };
  // 固定 40 + (1200 × 倍率 + 加算)/10 × 0.20
  close(D(0), 40 + 1200 / 10 * 0.2);              // 64
  close(D(1), 40 + (1200 * 1.0 + 40) / 10 * 0.2);  // 64.8
  close(D(2), 40 + (1200 * 1.1 + 50) / 10 * 0.2);  // 67.4 (加算が先なら (1200 + 50) × 1.1 → 67.5)
  close(D(3), 40 + (1200 * 1.2 + 60) / 10 * 0.2);  // 70
  close(D(2), 67.4);
  // 1 ヒットを単独で見る hitDamage (判定の割合なし) は 0.5 × 1 回分。武器の攻撃力・会心・斬れ味は関係しない
  const st = (w) => computeStats(w, aggregateModifiers([lvOf(SCORCH, 2), lvOf(FIRE_UP, 3)], w.element?.type), DEFAULT_RULES);
  const hit = { mv: 0, count: 1, type: 'slash', elementRate: 0, canCrit: true, sharpnessMul: true, additionalDamage: true };
  close(hitDamage(hit, st({ attack: 300, affinity: 100, element: null }), { hitzone: { slash: 45, fire: 20 }, sharpness: 'red' }).extra, 35);
  close(hitDamage(hit, st({ attack: 100, affinity: -50, element: { type: 'fire', value: 500 } }), { hitzone: { slash: 45, fire: 20 }, sharpness: 'purple' }).extra, 35);
});

test('武器が龍属性でも、火属性攻撃強化は灼熱化の火の分にだけ効く (龍属性攻撃強化は効かない)', () => {
  const inp = (skills, weapon = { attack: 200, affinity: 0, element: { type: 'dragon', value: 300 } }) => comboExpected({
    weapon, sharpness: 'white', skills, effects: EFFECTS, motions: MOTIONS, combo: comboById('ground_basic'), target: { hitzone: HZ },
  });
  const s2 = { skillId: SCORCH, level: 2 };
  const f3 = { skillId: FIRE_UP, level: 3 };
  const a = inp([s2]);
  const b = inp([s2, f3]);
  // △連携 (1 周に判定 0.8 回): 0.5 × 0.8 × 64 = 25.6 → 0.5 × 0.8 × 70 = 28
  close(a.extra, 25.6);
  close(b.extra, 28);
  close(b.physical, a.physical);
  close(b.element, a.element);
  // 龍属性攻撃強化は武器の龍属性に効き、灼熱化には効かない
  const c = inp([s2, { skillId: DRAGON_UP, level: 3 }]);
  close(c.extra, 25.6);
  assert.ok(c.element > a.element);
  // 火竜の力が無ければ、龍属性の武器に火属性攻撃強化は何も効かない
  close(inp([f3]).total, inp([]).total);
  // 火属性の武器なら両方に効く
  const fireW = { attack: 200, affinity: 0, element: { type: 'fire', value: 300 } };
  const d = inp([s2], fireW);
  const e = inp([s2, f3], fireW);
  close(e.extra, 28);
  assert.ok(e.element > d.element);
  // 無属性の武器でも同じ
  close(inp([s2, f3], { attack: 200, affinity: 0, element: null }).extra, 28);
});

test('連撃・巨戟龍の黙示録・災禍転福 (属性の種類の無指定・条件つき) も火の分に掛かる (発動率の加重平均)', () => {
  const run = (skills, uptimes = {}) => comboExpected({
    weapon: { attack: 200, affinity: 0, element: { type: 'dragon', value: 300 } }, sharpness: 'white', effects: EFFECTS, motions: MOTIONS,
    combo: comboById('just_rush_perfect'), target: { hitzone: HZ }, skills: [{ skillId: SCORCH, level: 2 }, ...skills], uptimes,
  });
  // ジャストラッシュ (1 周に判定 1 回): extra = 0.5 × 1 回分
  close(run([]).extra, 0.5 * 64);
  // 連撃 Lv1: 5 ヒット以降段 +60、1〜4 ヒット段 +50 (表示)。半々なら加算の期待値 55 → 40 + (1200 + 55)/10 × 0.2 = 65.1
  close(run([{ skillId: CHAIN, level: 1 }], { chain: { hit1to4: 0.5, hit5plus: 0.5 } }).extra, 0.5 * 65.1);
  // 巨戟龍の黙示録 Ⅰ (怒り 100%): ×1.2 + 20 → 40 + (1440 + 20)/10 × 0.2 = 69.2。怒り 30% なら 64 × 0.7 + 69.2 × 0.3
  close(run([{ skillId: GOGMA, level: 1 }]).extra, 0.5 * 69.2);
  close(run([{ skillId: GOGMA, level: 1 }], { enraged: 0.3 }).extra, 0.5 * (64 * 0.7 + 69.2 * 0.3));
  // 災禍転福 Lv3 (×1.15) と火属性攻撃強化 Lv3 (×1.2 + 60) と連撃 Lv5 (5 段以降 +140): 倍率は積・加算は和
  // 40 + (1200 × 1.15 × 1.2 + 60 + 140)/10 × 0.2 = 40 + 1856/10 × 0.2 = 77.12
  close(run([{ skillId: CURE, level: 3 }, { skillId: FIRE_UP, level: 3 }, { skillId: CHAIN, level: 5 }],
    { afterAilmentCure: 1, chain: { hit1to4: 0, hit5plus: 1 } }).extra, 0.5 * 77.12);
});

test('comboExpected の灼熱化 = 0.5 × Σ 判定の割合 × 1 回分 (前の「対象ヒットごとに 33%」との比)', () => {
  const run = (id) => comboExpected({
    weapon: { attack: 200, affinity: 0, element: null }, sharpness: 'white', effects: EFFECTS, motions: MOTIONS,
    combo: comboById(id), target: { hitzone: HZ }, skills: [{ skillId: SCORCH, level: 2 }],
  });
  // 1 回分 = 40 + 120 × 0.2 = 64。前の数え方は 対象ヒットの数 × 0.33 × 64
  const g = run('ground_basic');
  close(g.extra, 0.5 * 0.8 * 64);   // 25.6 (前は 4 × 0.33 × 64 = 84.48。約 0.30 倍)
  close(run('just_rush_perfect').extra, 0.5 * 1 * 64);   // 32 (前は 21.12)
  close(run('charged_chop').extra, 0.5 * 0.5 * 64);      // 16 (前は 21.12)
  close(run('focus_wound').extra, 0);
  // 技ごとの内訳: △連携は 4 段とも 0.5 × 0.2 × 64 = 6.4
  closeAll(g.steps.map((s) => s.extra), [6.4, 6.4, 6.4, 6.4]);
  // 画面用の要約: 1 周 2.333 秒に判定 0.8 回 → 発動 0.4 回 → 約 5.83 秒に 1 回
  const x = g.extraChecks[0];
  assert.equal(x.skillId, SCORCH);
  close(x.cooldownSec, 2.4);
  close(x.checksPerCycle, 0.8);
  close(x.procsPerCycle, 0.4);
  close(x.secPerProc, (140 / 60) / 0.4);
  assert.equal(x.estimated, false);
  // 傷口の段は傷口の火肉質で数える (割合は同じ)
  const w = comboExpected({
    weapon: { attack: 200, affinity: 0, element: null }, sharpness: 'white', effects: EFFECTS, motions: MOTIONS,
    combo: comboById('ground_basic'), target: { hitzone: HZ, wound: { ...HZ, fire: 30 }, isWound: true },
    skills: [{ skillId: SCORCH, level: 2 }],
  });
  close(w.extra, 0.5 * 0.8 * (40 + 120 * 0.3));
});

test('火力タブの部位の割合の平均でも、判定の要約 (extraChecks) を出す', () => {
  const inp = {
    weapon: { attack: 200, affinity: 0, element: null }, sharpness: 'white', effects: EFFECTS, motions: MOTIONS,
    combo: comboById('ground_basic'), skills: [{ skillId: SCORCH, level: 2 }],
  };
  const m = mixExpected(inp, [{ weight: 0.6, target: { hitzone: HZ } }, { weight: 0.4, target: { hitzone: { ...HZ, fire: 0 } } }]);
  assert.equal(m.extraChecks.length, 1);
  close(m.extraChecks[0].checksPerCycle, 0.8);
  close(m.extraChecks[0].secPerProc, (140 / 60) / 0.4);
  close(m.extra, 0.6 * 0.5 * 0.8 * 64 + 0.4 * 0.5 * 0.8 * 40);
});

test('火力タブの「追加」の説明: 結論 (約 N 秒に 1 回) → 判定の決まり → 見積もりの断り', () => {
  const inp = {
    weapon: { attack: 200, affinity: 0, element: null }, sharpness: 'white', effects: EFFECTS, motions: MOTIONS,
    skills: [{ skillId: SCORCH, level: 1 }],
  };
  // △連携: 2.333 秒 / 発動 0.4 回 = 5.83 秒
  const t = extraHintText(mixExpected({ ...inp, combo: comboById('ground_basic') }, [{ weight: 1, target: { hitzone: HZ } }]));
  assert.equal(t, '追加 = 灼熱化などスキルの追加ダメージです。灼熱化は、この連携を続けると約 5.8 秒に 1 回出ます。'
    + '2.4 秒に 1 回だけ判定し、平均すると 2 回に 1 回出るためです。技のつなぎの秒数は見積もりです。');
  // 秒数の分からない技があるときは、そう断る
  const u = extraHintText(mixExpected({ ...inp, combo: ['slash_1', 'jump_slash'] }, [{ weight: 1, target: { hitzone: HZ } }]));
  assert.match(u, /秒数の分からない技は、仮の長さで数えています。$/);
  // 灼熱化が無いとき
  assert.equal(extraHintText({ extraChecks: [] }), '追加 = スキルの追加ダメージです (発動の確率込み)。');
});

// ---------------------------------------------------------------- 2 つの道・評価器との一致

let seed = 20261024;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const IDS = [SCORCH, FIRE_UP, DRAGON_UP, CHAIN, GOGMA, CURE, skillIdByName('攻撃'), skillIdByName('見切り'), skillIdByName('挑戦者')];
const maxLv = (id) => EFFECTS.effects[String(id)].levels.length;
const WEAPONS = [
  { attack: 200, affinity: 10, element: { type: 'dragon', value: 300 } }, { attack: 190, affinity: 5, element: { type: 'fire', value: 440 } },
  { attack: 210, affinity: -10, element: null }, { attack: 180, affinity: 0, element: { type: 'poison', value: 300 } },
];
const TARGETS = [
  [{ weight: 1, target: { hitzone: HZ } }],
  [{ weight: 0.7, target: { hitzone: HZ, wound: { ...HZ, slash: 70, fire: 35 }, isWound: true } }, { weight: 0.3, target: { hitzone: { ...HZ, fire: 0 }, wound: null } }],
];
const CUSTOM = ['slash_1', 'jump_slash', 'spin_slash', { move: 'finish_slash', onWound: true }];
const UPTIMES = [{}, { chain: { hit1to4: 0.4, hit5plus: 0.5 }, enraged: 0.6, afterAilmentCure: 0.5 }, { chain: { hit1to4: 1 }, enraged: 0 }];
function randomLevels() {
  const lv = new Int8Array(IDS.length);
  IDS.forEach((id, r) => { if (r === 0 || rnd() < 0.6) lv[r] = Math.floor(rnd() * (maxLv(id) + 1)); });
  return lv;
}
const listOf = (lv) => IDS.map((id, r) => ({ skillId: id, level: lv[r] })).filter((s) => s.level > 0);

test('因子分解の道 = 全パターンの道 (判定の割合・条件つきの火の倍率と加算)', () => {
  let n = 0;
  for (let i = 0; i < 120; i++) {
    const inp = {
      weapon: pick(WEAPONS), sharpness: pick(['white', 'blue']), skills: listOf(randomLevels()), effects: EFFECTS, motions: MOTIONS,
      combo: pick([...COMBOS, CUSTOM]), target: pick(TARGETS)[0].target, uptimes: pick(UPTIMES),
    };
    const ref = comboExpected(inp);
    const fac = comboExpected({ ...inp, maxPatterns: 0 });
    for (const k of ['total', 'physical', 'element', 'extra']) assert.ok(rel(fac[k], ref[k]) <= 1e-12, `${k} ${fac[k]} / ${ref[k]}`);
    assert.deepEqual(fac.warnings.filter((w) => w.code !== 'many-patterns'), ref.warnings);
    assert.deepEqual(fac.extraChecks, ref.extraChecks);
    n++;
  }
  assert.equal(n, 120);
});

test('評価器 = comboExpected (灼熱化と火の属性スキル。龍・火・無属性・状態異常の武器、全コンボと自作のコンボ、速い道と遅い道)', () => {
  let compared = 0; let worst = 0; let withExtra = 0;
  for (let i = 0; i < 48; i++) {
    const weapon = WEAPONS[i % WEAPONS.length];
    const combo = [...COMBOS, CUSTOM][i % (COMBOS.length + 1)];
    const targets = pick(TARGETS);
    const uptimes = pick(UPTIMES);
    const opts = { effects: EFFECTS, motions: MOTIONS, combo, targets, weapon, uptimes, relevantIds: IDS, sharpness: 'white' };
    const evs = [makeEvaluator(opts), makeEvaluator({ ...opts, forceSlow: true })];
    const evU = makeEvaluator({ ...opts, uncapped: true });
    for (let t = 0; t < 8; t++) {
      const lv = randomLevels();
      let want = 0; let extra = 0;
      for (const tg of targets) {
        const r = comboExpected({ weapon, sharpness: 'white', skills: listOf(lv), effects: EFFECTS, motions: MOTIONS, combo, target: tg.target, uptimes });
        want += tg.weight * r.total; extra += tg.weight * r.extra;
      }
      if (extra > 0) withExtra++;
      for (const ev of evs) {
        const got = ev.evaluate(lv);
        const d = rel(got, want);
        worst = Math.max(worst, d);
        assert.ok(d <= 1e-12, `ずれ ${d} (${got} / ${want}) ${JSON.stringify(listOf(lv))} ${JSON.stringify(weapon)}`);
        compared++;
      }
      assert.ok(evU.evaluate(lv) >= want * (1 - 1e-12), '上限を外した評価器は下がらない');
    }
  }
  assert.ok(withExtra > 100, `灼熱化の出る組 ${withExtra}`);
  console.log(`  比べた ${compared} 件・最大の相対差 ${worst.toExponential(2)}`);
});

test('上界の前提: 火竜の力と火属性攻撃強化の Lv について値は下がらず、火でない武器では補い合う (優モジュラ)', () => {
  for (const weapon of WEAPONS) {
    for (const combo of COMBOS) {
      const ev = makeEvaluator({
        effects: EFFECTS, motions: MOTIONS, combo, targets: TARGETS[0], weapon, uptimes: {}, relevantIds: [SCORCH, FIRE_UP],
        sharpness: 'white', uncapped: 'attack',
      });
      const f = (a, b) => ev.evaluate(Int8Array.from([a, b]));
      for (let a = 0; a <= 2; a++) {
        for (let b = 0; b <= 3; b++) {
          if (a < 2) assert.ok(f(a + 1, b) >= f(a, b) - 1e-9, `火竜の力 ${a}→${a + 1} (火 ${b})`);
          if (b < 3) assert.ok(f(a, b + 1) >= f(a, b) - 1e-9, `火属性攻撃強化 ${b}→${b + 1} (火竜 ${a})`);
          // 火属性攻撃強化の増え方は火竜の力の Lv が高いほど大きい (補い合う形)
          if (a < 2 && b < 3) assert.ok(f(a + 1, b + 1) - f(a + 1, b) >= f(a, b + 1) - f(a, b) - 1e-9, `補い合う ${a} ${b}`);
        }
      }
      if (weapon.element?.type !== 'fire') close(f(0, 3), f(0, 0), 1e-9 * f(0, 0));
    }
  }
});
