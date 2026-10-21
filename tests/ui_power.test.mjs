// 火力タブ・相手タブの計算 (app/ui/tabs/power_calc.js・target_mix.js) のテスト。node --test tests/*.test.mjs で回す。
// 点検 (2026-10-21) の指摘を直したところを残す:
//   匠を効き目・火力表に入れる / 条件の割合は効く段だけ / 同時に起きない条件で本人の値を残す /
//   狂竜症のもとが無ければ 0% / 部位不明の名前 / おすすめ属性の同点 / 部位の割合のつまみ / 弱点はヒットごと
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computeBuild, indexEquipData } from '../app/model/build.js';
import { comboExpected } from '../app/model/damage.js';
import * as L from '../app/ui/tabs/equip_logic.js';
import * as P from '../app/ui/tabs/power_calc.js';
import * as T from '../app/ui/tabs/target_mix.js';

const readJson = (rel) => JSON.parse(fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'));
const raw = {
  skills: readJson('data/skills.json'), armor: readJson('data/armor.json'), weapons: readJson('data/weapons_sns.json'),
  decorations: readJson('data/decorations.json'), bonuses: readJson('data/bonuses.json'),
  charmsFixed: readJson('data/charms_fixed.json'), charms: readJson('data/charms.json'), myWeapons: readJson('data/my_weapons.json'),
};
const EFFECTS = readJson('data/skill_effects.json');
const MOTIONS = readJson('data/motions_sns.json');
const COMBOS = readJson('data/combos_sns.json').combos;
const MONSTERS = readJson('data/monsters.json');
const THREATS = readJson('data/monster_threats.json');
const idx = indexEquipData(raw);
const skillId = (name) => raw.skills.skills.find((s) => s.name === name).id;
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `expected ${b}, got ${a}`);
const TARGET = [{ weight: 1, target: L.DEFAULT_TARGET }];
const targetData = { monsters: MONSTERS, threats: THREATS, lists: { monsters: MONSTERS.monsters, threats: THREATS.monsters } };
const monsterByName = (name) => MONSTERS.monsters.find((m) => m.name === name);

// 護雷剣シーカガルデ (素の斬れ味は青、匠 Lv1 で白) + 雷光・匠珠【3】(匠 Lv1)
function shikaInput() {
  const w = raw.weapons.weapons.find((x) => x.name === '護雷剣シーカガルデ');
  const deco = raw.decorations.decorations.find((d) => d.name.startsWith('雷光・匠珠'));
  const weapon = L.resolveWeaponRef(w.id, idx);
  const build = computeBuild({ weapon: w.id, decorations: { weapon: [deco.id] } }, idx);
  return {
    weapon: L.damageWeapon(weapon), sharpness: L.autoSharpness(weapon, idx, build.skillLevels).color,
    skills: build.skills, uptimes: {}, effects: EFFECTS, motions: MOTIONS, combo: COMBOS[0],
    perSkills: L.sharpnessResolver(weapon, idx, null), handicraft: L.handicraftInfo(idx),
  };
}

test('匠: 斬れ味が自動なら、スキルなし・外したときの色を決め直し、効き目と火力表に匠の行を出す', () => {
  const input = shikaInput();
  assert.equal(input.sharpness, 'white');
  const hid = skillId('匠');
  const c = P.mixContribution(input, TARGET);
  // スキルなしは青で計算する
  const blue = comboExpected({ ...input, sharpness: 'blue', skills: [], target: L.DEFAULT_TARGET }).total;
  close(c.noSkills, blue);
  // 匠は「火力に関係しない」に入らず、外すと白 → 青に下がる
  assert.ok(!c.unknown.some((s) => s.skillId === hid));
  const hc = c.removeEach.find((x) => x.skillId === hid);
  assert.ok(hc && hc.name === '匠' && hc.dropPct > 5, JSON.stringify(hc));
  // 火力表に匠の行。Lv1 で青 → 白
  const cands = P.skillTableCandidates(EFFECTS, input.weapon, { handicraft: input.handicraft });
  const row = cands.rows.find((r) => r.skillId === hid);
  assert.ok(row && row.sharpnessSkill);
  const tr = P.skillTableRow(input, TARGET, row, P.tableContext(input, TARGET));
  assert.equal(tr.currentLevel, 1);
  assert.ok(tr.levels[1].vsZeroPct > 5);
  // 斬れ味を固定したら (perSkills なし) 匠は効かない
  const fixed = P.mixContribution({ ...input, perSkills: null }, TARGET);
  close(fixed.removeEach.find((x) => x.skillId === hid).dropPct, 0);
});

test('条件の割合 (火力表の名前の欄): スキルが効く段だけを数え、段ごとに出す', () => {
  const muga = EFFECTS.effects[String(skillId('無我の境地'))];
  const koku = EFFECTS.effects[String(skillId('黒蝕竜の力'))];
  const chain = EFFECTS.effects[String(skillId('連撃'))];
  const up = { frenzy: { infected: 0.3, overcome: 0.6 }, chain: { hit1to4: 0.2, hit5plus: 0.7 } };
  const m = P.conditionSummary(EFFECTS, up, 'frenzy', { entry: muga });
  assert.deepEqual(m.parts.map((x) => [x.id, x.p]), [['overcome', 0.6]]);
  close(m.on, 0.6);
  // 黒蝕竜の力は克服後 (主効果) と感染中 (Lv2 の段ごとの効果) の両方
  assert.deepEqual(P.conditionSummary(EFFECTS, up, 'frenzy', { entry: koku }).parts.map((x) => x.id), ['overcome', 'infected']);
  // 連撃は 5 ヒット以降段 (主効果) → 1〜4 ヒット段
  const c = P.conditionSummary(EFFECTS, up, 'chain', { entry: chain });
  assert.deepEqual(c.parts.map((x) => [x.label, x.p]), [['5 ヒット以降段', 0.7], ['1〜4 ヒット段', 0.2]]);
  // 入れていない条件は既定値 (仮置き)
  const d = P.conditionSummary(EFFECTS, {}, 'frenzy', { entry: muga });
  assert.equal(d.placeholder, true);
  close(d.on, 0.5);
  // 平らなキー "chain.hit5plus" も読む
  close(P.conditionSummary(EFFECTS, { 'chain.hit5plus': 0.4 }, 'chain', { entry: chain }).parts[0].p, 0.4);
});

test('狂竜症: 黒蝕竜の力も狂竜症を使う相手もいなければ 0% (無我の境地は効かない)', () => {
  const muga = skillId('無我の境地');
  const koku = skillId('黒蝕竜の力');
  const base = {
    weapon: { attack: 200, affinity: 0, element: null }, sharpness: 'white', uptimes: {},
    effects: EFFECTS, motions: MOTIONS, combo: COMBOS[0], target: L.DEFAULT_TARGET,
  };
  const none = comboExpected({ ...base, skills: [] }).total;
  // 相手が分からない (monsterStatus なし) ときは決めつけない
  assert.ok(comboExpected({ ...base, skills: [{ skillId: muga, level: 3 }] }).total > none);
  // 狂竜症を使わない相手 → 起きない
  const off = comboExpected({ ...base, skills: [{ skillId: muga, level: 3 }], monsterStatus: ['poison'] });
  close(off.total, none);
  const g = off.conditions.find((x) => x.id === 'frenzy');
  assert.equal(g.inactive, true);
  assert.equal(g.placeholder, false);
  assert.match(g.inactiveReason, /黒蝕竜の力/);
  // 狂竜症を使う相手・黒蝕竜の力がある → 起きる
  assert.ok(comboExpected({ ...base, skills: [{ skillId: muga, level: 3 }], monsterStatus: ['frenzy'] }).total > none);
  const both = [{ skillId: muga, level: 3 }, { skillId: koku, level: 1 }];
  const withKoku = comboExpected({ ...base, skills: both, monsterStatus: [] });
  assert.equal(withKoku.conditions.find((x) => x.id === 'frenzy').inactive, false);
  // 黒蝕竜の力を外すと狂竜症にもかからない (外したときの低下に、狂竜症の分も入る)
  const c = P.mixContribution({ ...base, skills: both, monsterStatus: [] }, TARGET);
  const drop = c.removeEach.find((x) => x.skillId === koku);
  close(drop.total, none);
  // 相手が使う状態異常: ゴア・マガラ (狂竜症)・狂竜化の個体がいるモンスター・手入力は []
  const gore = monsterByName('ゴア・マガラ');
  assert.ok(T.monsterStatusOf({ mode: 'monster', monsterId: gore.id }, targetData).includes('frenzy'));
  const frenzied = MONSTERS.monsters.find((m) => (m.variants || []).includes('frenzied'));
  assert.ok(T.monsterStatusOf({ mode: 'monster', monsterId: frenzied.id }, targetData).includes('frenzy'));
  const arch = monsterByName('アルシュベルド');
  assert.ok(!T.monsterStatusOf({ mode: 'monster', monsterId: arch.id }, targetData).includes('frenzy'));
  assert.deepEqual(T.monsterStatusOf({ mode: 'manual' }, targetData), []);
  assert.equal(T.monsterStatusOf({ mode: 'monster', monsterId: arch.id }, null), null, 'データが無ければ分からない');
});

test('同時に起きない条件: 本人が入れた値 (赤ゲージ・35% 以下) を残し、仮置き (体力満タン) から減らす', () => {
  const skills = ['逆恨み', '火事場力'].map((n) => ({ skillId: skillId(n), level: 5 }));
  const base = {
    weapon: { attack: 200, affinity: 0, element: null }, sharpness: 'white', effects: EFFECTS, motions: MOTIONS,
    combo: COMBOS[0], target: L.DEFAULT_TARGET, uptimes: { redHp: 0.8, hpLow: 0.6 },
  };
  const full = { skillId: skillId('フルチャージ'), level: 5 };
  // フルチャージを足すとき: 体力満タン (仮置き 50%) と合計が 100% を超える → 体力満タンの方を減らして警告
  const r = comboExpected({ ...base, skills: [...skills, full] });
  const w = r.warnings.filter((x) => x.code === 'exclusive-conflict');
  assert.equal(w.length, 1);
  assert.equal(w[0].groupId, 'hpFull');
  // 赤ゲージ・35% 以下は入れた値のまま (フルチャージが無いときと同じ期待値の上に、満タンの分が少し乗るだけ)
  const without = comboExpected({ ...base, skills }).total;
  assert.ok(r.total >= without - 1e-9, `${r.total} < ${without}`);
  // 火力表のフルチャージの行に印が付き、マイナスにならない
  const ctx = P.tableContext({ ...base, skills }, TARGET);
  const cand = P.skillTableCandidates(EFFECTS, base.weapon).rows.find((x) => x.skillId === full.skillId);
  const row = P.skillTableRow({ ...base, skills }, TARGET, cand, ctx);
  assert.ok(row.conflict);
  assert.ok(row.levels.slice(1).every((l) => l.vsZeroPct >= -1e-9), JSON.stringify(row.levels.map((l) => l.vsZeroPct)));
  // 合計が 100% 以内なら印は付かない
  const ok = P.skillTableRow({ ...base, skills, uptimes: { redHp: 0.3, hpLow: 0.2 } }, TARGET, cand, ctx);
  assert.equal(ok.conflict, null);
});

test('部位不明の部位は内部名を出さず「部位不明 1」のように番号にする', () => {
  const m = MONSTERS.monsters.find((x) => x.parts.some((p) => p.unknownPart));
  const unknown = m.parts.filter((p) => p.unknownPart).sort((a, b) => a.ordinal - b.ordinal);
  assert.equal(T.partLabel(unknown[0], m), '部位不明 1');
  if (unknown[1]) assert.equal(T.partLabel(unknown[1], m), '部位不明 2');
  const named = m.parts.find((p) => !p.unknownPart);
  assert.equal(T.partLabel(named, m), named.name);
  const r = T.resolveTargetMix({ mode: 'monster', monsterId: m.id, partKey: unknown[0].key }, {}, targetData);
  assert.equal(r.label, `${m.name} 部位不明 1`);
  assert.ok(!/[a-z]/.test(r.label), r.label);
});

test('おすすめの属性: 1 位と 2 位が近い・どれも低いときは 1 つを大きく出さない', () => {
  const view = (name, el) => T.recommendationView(monsterByName(name).elementRecommendation, el);
  // アルシュベルドは全属性 2.5 → どれもほとんど効かない。いまの武器が火でも「大差なし」
  const a = view('アルシュベルド', 'fire');
  assert.equal(a.kind, 'weak');
  assert.equal(a.weapon, 'close');
  // ゴア・マガラは 火 16.7 / 龍 15 (差 2 以下) → ほぼ同じ
  assert.equal(view('ゴア・マガラ', 'dragon').kind, 'close');
  assert.equal(view('ゴア・マガラ', 'dragon').weapon, 'close');
  // はっきり差があるモンスター
  const clear = MONSTERS.monsters.find((m) => {
    const o = m.elementRecommendation.order;
    return o.length > 1 && o[0].avg >= T.WEAK_AVG && o[0].avg - o[1].avg > T.CLOSE_GAP && !m.elementRecommendation.tieBreak;
  });
  const v = T.recommendationView(clear.elementRecommendation, null);
  assert.equal(v.kind, 'clear');
  assert.equal(v.weapon, null);
  const worst = clear.elementRecommendation.order[clear.elementRecommendation.order.length - 1];
  if (clear.elementRecommendation.order[0].avg - worst.avg > T.CLOSE_GAP) {
    assert.equal(T.recommendationView(clear.elementRecommendation, worst.type).weapon, 'other');
  }
});

test('部位の割合のつまみ: つまみの値 = その部位の割合。ほかは比のまま残りを分け、合計はいつも 100%', () => {
  const sum = (w) => Object.values(w).reduce((a, b) => a + b, 0);
  // 2 部位: 頭を 60% → 尻尾 40%
  assert.deepEqual(T.setShare({ head: 1, tail: 0.5 }, 'head', 0.6), { head: 0.6, tail: 0.4 });
  // 3 部位: 頭を 50% → 残り 50% を 2:1 で
  const three = T.setShare({ head: 0.25, tail: 0.5, wing: 0.25 }, 'head', 0.5);
  close(three.head, 0.5);
  close(three.tail / three.wing, 2, 0.05);
  close(sum(three), 1, 1e-9);
  // 下限・上限 (ほかの部位を 5% 未満にしない)
  assert.deepEqual(T.setShare({ head: 0.5, tail: 0.5 }, 'head', 1), { head: 0.95, tail: 0.05 });
  // 足すと等分に近づく・外すと残りで 100%
  assert.deepEqual(T.addShare({ head: 1 }, 'tail'), { head: 0.5, tail: 0.5 });
  const added = T.addShare({ head: 0.5, tail: 0.5 }, 'wing');
  close(added.wing, 0.33, 0.02);
  close(sum(added), 1, 1e-9);
  assert.deepEqual(T.removeShare({ head: 0.6, tail: 0.4 }, 'tail'), { head: 1 });
});

test('弱点特効はヒットごと: 剣は切断・盾は打撃、傷口を狙うときは傷口の肉質', () => {
  const part = { hitzone: { slash: 45, blunt: 40 }, wound: { slash: 60, blunt: 60 } };
  assert.deepEqual(T.weakInfo(part), { sword: true, shield: false, woundSword: true, woundShield: true });
  assert.deepEqual(T.weakInfo({ hitzone: { slash: 42, blunt: 50 }, wound: null }),
    { sword: false, shield: true, woundSword: null, woundShield: null });
});
