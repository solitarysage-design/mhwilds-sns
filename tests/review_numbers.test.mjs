// 数値の点検 (review-numbers) で確かめたことを残すテスト。
// - 同時に起きない条件 (体力満タン / 赤ゲージ / 35% 以下) の期待値が、同時分布を手で組んで
//   1 パターンずつ (発動率 0 か 1) 計算した加重平均と一致すること。
// (攻略サイトの装備例と発動スキルを照らし合わせる確認は、値を写すことになるのでリポの外で行う)
// 実行: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { comboExpected } from '../app/model/damage.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (name) => JSON.parse(readFileSync(join(ROOT, 'data', name), 'utf8'));
const SKILLS = load('skills.json');
const EFFECTS = load('skill_effects.json');
const MOTIONS = load('motions_sns.json');
const MONSTERS = load('monsters.json').monsters;

const close = (actual, expected, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= eps * Math.max(1, Math.abs(expected)), `expected ${expected}, got ${actual}`);

const skillId = (name) => {
  const s = SKILLS.skills.find((x) => x.name === name);
  assert.ok(s, `skills.json に ${name} が無い`);
  return s.id;
};

// 注: 体力の 3 条件で動くスキルは今のデータでは攻撃力だけ (加算・乗算) なので、期待値は各条件の発動率 (周辺確率) で決まり、
// 同時分布の形 (相関) には左右されない。このテストが守るのは「入れた発動率がそのまま効く」こと
// (満タンでない割合で割り忘れる、などの誤りで落ちる)。
test('同時に起きない条件の期待値 = 同時分布を手で組んだ 1 パターンずつの加重平均 (発動率を動かしても一致)', () => {
  const skills = [['フルチャージ', 5], ['逆恨み', 5], ['火事場力', 5], ['挑戦者', 5]]
    .map(([n, lv]) => ({ skillId: skillId(n), level: lv }));
  const part = MONSTERS.find((m) => m.name === 'ゴア・マガラ').parts.find((p) => p.key === 'head');
  const base = {
    weapon: { attack: 210, affinity: 15, element: { type: 'thunder', value: 250 } }, sharpness: 'white', skills,
    effects: EFFECTS, motions: MOTIONS, combo: ['slash_1', 'slash_2', 'just_rush_3_just'],
    target: { hitzone: part.hitzone, wound: part.wound },
  };
  for (const [f, red, low, enr] of [[0.3, 0.6, 0.5, 0.7], [0.5, 0.5, 0.5, 0.5], [0, 0.2, 0.9, 1], [0.8, 0.2, 0.1, 0.25]]) {
    const got = comboExpected({ ...base, uptimes: { hpFull: f, redHp: red, hpLow: low, enraged: enr } }).total;
    // 満タン f。満タンでないとき (1-f) に 赤 red/(1-f)・35% 以下 low/(1-f) が独立。怒りは独立
    const rc = f < 1 ? red / (1 - f) : 0;
    const lc = f < 1 ? low / (1 - f) : 0;
    const joint = [[f, 1, 0, 0]];
    for (const r of [1, 0]) for (const l of [1, 0]) joint.push([(1 - f) * (r ? rc : 1 - rc) * (l ? lc : 1 - lc), 0, r, l]);
    let want = 0;
    for (const [w, ff, r, l] of joint) {
      for (const e of [1, 0]) {
        const we = w * (e ? enr : 1 - enr);
        if (we <= 0) continue;
        want += we * comboExpected({ ...base, uptimes: { hpFull: ff, redHp: r, hpLow: l, enraged: e } }).total;
      }
    }
    close(got, want, 1e-12);
  }
});
