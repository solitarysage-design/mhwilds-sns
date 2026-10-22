// 探すタブの純粋関数 (app/ui/tabs/search_form.js) と、探索の出し入れ (search_client.js のコントローラ) のテスト。
// 実行: node --test tests/*.test.mjs  (Node 24 では tests/ とディレクトリで渡すと落ちる)
// search_client.js は 'preact/hooks' を名前で import する (ブラウザでは index.html の import map)。node では
// module.registerHooks で app/vendor の同じファイルに向ける (state.test.mjs と同じ)。
// コントローラの順番 (途中の結果・やめる・続けて探す) は、決まった結果を返す作り物の探索 (tests/fixtures/fake_search_worker.js の
// createEngine) でつなぐ。本物の探索 (search.js / recommend.js) は Job の作り方と、画面のスレッドで回す道で確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const VENDOR = {
  preact: new URL('../app/vendor/preact.module.js', import.meta.url).href,
  'preact/hooks': new URL('../app/vendor/hooks.module.js', import.meta.url).href,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (VENDOR[specifier]) return nextResolve(VENDOR[specifier], context);
    return nextResolve(specifier, context);
  },
});

const { indexEquipData, computeBuild } = await import('../app/model/build.js');
const { comboExpected } = await import('../app/model/damage.js');
const F = await import('../app/ui/tabs/search_form.js');
const L = await import('../app/ui/tabs/equip_logic.js');
const T = await import('../app/ui/tabs/target_mix.js');
const C = await import('../app/ui/tabs/search_client.js');
const FAKE = await import('./fixtures/fake_search_worker.js');
const R = await import('../app/model/recommend.js');

const readJson = (rel) => JSON.parse(readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'));
const raw = {
  skills: readJson('data/skills.json'), armor: readJson('data/armor.json'), weapons: readJson('data/weapons_sns.json'),
  decorations: readJson('data/decorations.json'), bonuses: readJson('data/bonuses.json'),
  charmsFixed: readJson('data/charms_fixed.json'), charms: readJson('data/charms.json'), myWeapons: readJson('data/my_weapons.json'),
  skillEffects: readJson('data/skill_effects.json'), motions: readJson('data/motions_sns.json'),
};
const COMBOS = readJson('data/combos_sns.json');
const MONSTERS = readJson('data/monsters.json');
const QUESTS = readJson('data/quests.json');
const THREATS = readJson('data/monster_threats.json');
const idx = indexEquipData(raw);
// data.js の core データと同じ形 (使うところだけ)
const core = {
  ...raw, combos: COMBOS, index: idx,
  lists: {
    skills: raw.skills.skills, armor: raw.armor.armor, weapons: raw.weapons.weapons, charms: raw.charms.charms,
    charmsFixed: raw.charmsFixed.charms, myWeapons: raw.myWeapons.weapons, combos: COMBOS.combos,
  },
  meta: { skills: raw.skills.meta, armor: raw.armor.meta, charms: { schema: 1 } },
};
const targetData = {
  monsters: MONSTERS, quests: QUESTS, threats: THREATS,
  lists: { monsters: MONSTERS.monsters, quests: QUESTS.quests, threats: THREATS.monsters },
};
const monsterByName = (name) => MONSTERS.monsters.find((m) => m.name === name);
const skillId = (name) => raw.skills.skills.find((s) => s.name === name).id;
const close = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `expected ${b}, got ${a}`);

function emptyBuild() {
  return {
    weapon: null, armor: { head: null, chest: null, arms: null, waist: null, legs: null },
    limitBreak: { head: false, chest: false, arms: false, waist: false, legs: false }, charm: null,
    decorations: { weapon: [], head: [], chest: [], arms: [], waist: [], legs: [], charmArmor: [], charmWeapon: [] },
  };
}
function defaultSearch() {
  return {
    useTarget: true, preset: 'balance', toggles: {}, levels: {}, required: [], weaponMode: 'auto', twoWeapons: 'auto',
    partsPolicy: 'asSelected', charms: { owned: true, local: true, fixed: true }, limitBreak: 'build',
    archTemperedHunted: {}, armorExclude: [], placeholders: 'zero', budgetSec: 6, K: 10, autoStart: null,
  };
}
function emptyTarget() {
  return {
    mode: 'monster', monsterId: null, partKey: null, isWound: false, questId: null,
    manual: { name: '手入力', hitzone: { slash: 45, blunt: 45, fire: 20, water: 20, thunder: 20, ice: 20, dragon: 20 }, wound: null },
    individual: null, questTargetIndex: 0, players: 1, useUncertainWound: false,
  };
}
function ctxOf({ build = emptyBuild(), target = emptyTarget(), search = defaultSearch(), uptimes = {}, sharpness = null, tabs = {}, ...rest } = {}) {
  return {
    state: { build, target, search, combo: null, uptimes, sharpness, tabs }, core, idx, targetData,
    combo: COMBOS.combos[0], localCharms: [], localWeapons: [], recommend: null, ...rest,
  };
}
const FIRE_WEAPON = raw.weapons.weapons.find((w) => w.element && w.element.type === 'fire' && w.rarity === 8);

// ---------------------------------------------------------------- 仮置きの発動率

test('仮置きの発動率: 仮の条件の一覧と、0% にして探すときの発動率', () => {
  const all = F.placeholderConditions(raw.skillEffects, {});
  assert.equal(all.length, raw.skillEffects.rules.conditionGroups.filter((g) => g.placeholder).length);
  assert.ok(all.length >= 20, `仮の条件が ${all.length} 個`);
  assert.ok(all.every((p) => !p.fromInput));
  assert.ok(all.some((p) => p.id === 'frenzy' && p.type === 'categorical'));
  for (const id of ['enraged', 'chain', 'staminaFull']) assert.ok(!all.some((p) => p.id === id), `${id} は本人の前提なので仮の一覧に出ない`);
  const mine = F.placeholderConditions(raw.skillEffects, { hpLow: 0.7 });
  assert.equal(mine.find((p) => p.id === 'hpLow').fromInput, true);
  assert.equal(mine.find((p) => p.id === 'hpLow').valueText, '70%');

  const z = F.searchUptimes(raw.skillEffects, { hpLow: 0.7 }, 'zero');
  assert.equal(z.hpLow, 0.7, '本人が入れた値はそのまま');
  assert.equal(z.hpFull, 0);
  assert.deepEqual(z.frenzy, {}, '段階のある条件は全部の段 0%');
  assert.equal('beforeGuts' in z, false, '仮置きでない条件は触らない');
  assert.equal('enraged' in z, false, '本人の前提も触らない (既定の 100% で探す)');
  assert.deepEqual(F.searchUptimes(raw.skillEffects, { hpLow: 0.7 }, 'keep'), { hpLow: 0.7 });

  // 0% にすると条件つきのスキル (火事場力) は効かない = そのスキルが無いときと同じ値
  const z0 = F.searchUptimes(raw.skillEffects, {}, 'zero');
  const w = L.damageWeapon(L.resolveWeaponRef(FIRE_WEAPON.id, idx));
  const base = { weapon: w, sharpness: 'white', effects: raw.skillEffects, motions: raw.motions, combo: COMBOS.combos[0],
    target: { hitzone: L.DEFAULT_HITZONE, wound: null } };
  const withSkill = comboExpected({ ...base, skills: [{ skillId: skillId('火事場力'), level: 5 }], uptimes: z0 }).total;
  const none = comboExpected({ ...base, skills: [], uptimes: z0 }).total;
  close(withSkill, none);
  const kept = comboExpected({ ...base, skills: [{ skillId: skillId('火事場力'), level: 5 }], uptimes: {} }).total;
  assert.ok(kept > none, '火力タブの値 (仮 50%) のままなら効く');
});

test('本人の前提 (2026-10-22「基本発動する前提で」): 探すタブの既定 (仮は 0%) でも挑戦者・連撃・渾身は 100% で効き、本人が入れた値が優先', () => {
  const z0 = F.searchUptimes(raw.skillEffects, {}, 'zero');
  const w = L.damageWeapon(L.resolveWeaponRef(FIRE_WEAPON.id, idx));
  const base = { weapon: w, sharpness: 'white', effects: raw.skillEffects, motions: raw.motions, combo: COMBOS.combos[0],
    target: { hitzone: L.DEFAULT_HITZONE, wound: null } };
  const none = comboExpected({ ...base, skills: [], uptimes: z0 }).total;
  for (const [name, lv] of [['挑戦者', 5], ['連撃', 5], ['渾身', 3]]) {
    const skills = [{ skillId: skillId(name), level: lv }];
    const inSearch = comboExpected({ ...base, skills, uptimes: z0 }).total;
    assert.ok(inSearch > none * 1.01, `${name} は探索でも効く (${inSearch} / ${none})`);
    close(inSearch, comboExpected({ ...base, skills, uptimes: {} }).total); // 火力タブの既定と同じ値
  }
  // 本人が入れた値 (怒り 40%) が優先: 探す発動率にもそのまま入り、怒り 100% と 0% の 4:6
  const mine = F.searchUptimes(raw.skillEffects, { enraged: 0.4 }, 'zero');
  assert.equal(mine.enraged, 0.4);
  const ch = [{ skillId: skillId('挑戦者'), level: 5 }];
  close(comboExpected({ ...base, skills: ch, uptimes: mine }).total,
    0.4 * comboExpected({ ...base, skills: ch, uptimes: z0 }).total + 0.6 * none);
  // 発動率のカードに出す「仮でない条件」(根拠のある既定値 2 つ + 本人の前提 3 つ)
  const fixed = F.fixedConditions(raw.skillEffects, {});
  assert.deepEqual(fixed.map((p) => p.id).sort(), ['beforeGuts', 'chain', 'enraged', 'festival', 'staminaFull']);
  assert.ok(fixed.every((p) => !p.fromInput));
  assert.equal(fixed.find((p) => p.id === 'chain').valueText, '5 ヒット以降段 100%');
  assert.equal(fixed.find((p) => p.id === 'enraged').valueText, '100%');
  assert.match(fixed.find((p) => p.id === 'staminaFull').basis, /^基本発動する前提で計算 \(2026-10-22/);
  // 火力タブで値を入れたもの (平らなキーも) は fromInput で、入れた値の文
  const set = F.fixedConditions(raw.skillEffects, { enraged: 0.4, 'chain.hit1to4': 0.3, 'chain.hit5plus': 0.5 });
  assert.deepEqual([set.find((p) => p.id === 'enraged').fromInput, set.find((p) => p.id === 'enraged').valueText], [true, '40%']);
  assert.deepEqual([set.find((p) => p.id === 'chain').fromInput, set.find((p) => p.id === 'chain').valueText],
    [true, '1〜4 ヒット段 30%・5 ヒット以降段 50%']);
  assert.equal(set.find((p) => p.id === 'staminaFull').fromInput, false);
  // 平らなキーは「発動していない」段のもの ("chain.none") を読まない (damage.js と同じ。前は画面だけ「入れた・0%」になった)
  const offKey = F.fixedConditions(raw.skillEffects, { 'chain.none': 0.5 }).find((p) => p.id === 'chain');
  assert.deepEqual([offKey.fromInput, offKey.valueText], [false, '5 ヒット以降段 100%']);
  const up = { 'chain.none': 0.5 };
  assert.equal(comboExpected({ ...base, skills: [{ skillId: skillId('連撃'), level: 5 }], uptimes: up }).conditions
    .find((c) => c.id === 'chain').fromInput, false, '計算も「入れていない」');
  // null は入れていない扱い
  assert.equal(F.fixedConditions(raw.skillEffects, { enraged: null, 'chain.hit5plus': null }).filter((p) => p.fromInput).length, 0);
});

test('探すタブの発動率のカードの行: 仮の条件・火力タブで入れた条件・仮でない条件の既定 に分ける', () => {
  const ph = F.placeholderConditions(raw.skillEffects, { hpLow: 0.3 });
  const fixed = F.fixedConditions(raw.skillEffects, { enraged: 0.4 });
  const rows = F.uptimeCardRows(ph, fixed);
  assert.equal(rows.still.length, ph.length - 1);
  assert.ok(rows.still.every((p) => !p.fromInput));
  // 火力タブで入れた条件は、仮置き (体力 35% 以下) も本人の前提 (怒り) も「入れた条件」の行に出す
  assert.deepEqual(rows.mine.map((p) => [p.id, p.valueText]), [['hpLow', '30%'], ['enraged', '40%']]);
  // 怒りは「仮でない条件」の行には出さない (入れた値で探すため)
  assert.deepEqual(rows.preset.map((p) => p.id).sort(), ['beforeGuts', 'chain', 'festival', 'staminaFull']);
  assert.deepEqual(F.uptimeCardRows(), { still: [], mine: [], preset: [] });
  assert.deepEqual(F.uptimeCardRows(null, 'x'), { still: [], mine: [], preset: [] });
});

// ---------------------------------------------------------------- 限界突破・歴戦王

test('限界突破の決め方と、倒していない歴戦王の γ 防具・狩猟証γ の護石の除外', () => {
  const b = { ...emptyBuild(), limitBreak: { head: true, chest: false, arms: true, waist: false, legs: false } };
  assert.deepEqual(F.limitBreakFor('build', b), b.limitBreak);
  assert.ok(Object.values(F.limitBreakFor('all', b)).every((x) => x === true));
  assert.ok(Object.values(F.limitBreakFor('none', b)).every((x) => x === false));

  const g = F.gammaInfo(targetData);
  assert.equal(g.monsters.length, 5, '歴戦王は 5 体');
  assert.equal(g.armor.size, 25);
  assert.equal(g.charms.size, 10);
  const ark = monsterByName('アルシュベルド');
  const ex = F.huntedExclusions(g, { [String(ark.id)]: false });
  assert.deepEqual(ex.armor.sort((a, b) => a - b), [705, 706, 707, 708, 709]);
  assert.deepEqual(ex.charmsFixed.sort((a, b) => a - b), [186, 187]);
  assert.deepEqual(F.huntedExclusions(g, {}).armor, [], '既定は全部倒した扱い');
  const marks = F.gammaMarksOf({ ...emptyBuild(), armor: { ...emptyBuild().armor, head: 705 }, charm: 61 }, g);
  assert.deepEqual(marks.sort(), ['アルシュベルド（歴戦王）', 'レ・ダウ（歴戦王）'].sort());
  assert.deepEqual(F.gammaMarksOf({ ...emptyBuild(), charm: 'c0001' }, g), [], '持っている護石 (文字の id) は γ ではない');
});

// ---------------------------------------------------------------- 相手

test('相手: 未選択は既定の肉質、手入力、部位の割合、弱点 1 か所、主な部位 3 か所', () => {
  const none = F.searchTargets({ target: emptyTarget(), targetData });
  assert.equal(none.source, 'default');
  assert.deepEqual(none.targets[0].target.hitzone, L.DEFAULT_HITZONE);

  const manual = F.searchTargets({ target: { ...emptyTarget(), mode: 'manual' }, targetData });
  assert.equal(manual.source, 'manual');
  assert.equal(manual.targets[0].target.hitzone.slash, 45);

  assert.deepEqual(F.searchTargets({ target: { ...emptyTarget(), monsterId: 20, partKey: 'head' }, targetData: null }), { loading: true });

  const ark = monsterByName('アルシュベルド');
  const sel = F.searchTargets({ target: { ...emptyTarget(), monsterId: ark.id, partKey: 'head' }, targetData });
  assert.equal(sel.policy, 'asSelected');
  assert.equal(sel.targets.length, 1);
  assert.deepEqual(sel.targets[0].target.hitzone, ark.parts.find((p) => p.key === 'head').hitzone);

  // 割合で混ぜる指定 (相手タブ) は火力タブと同じ割合になる
  const named = ark.parts.filter((p) => !p.unknownPart);
  const tabs = { mix: { on: true, monsterId: ark.id, weights: { [named[0].key]: 0.75, [named[1].key]: 0.25 } } };
  const mixed = F.searchTargets({ target: { ...emptyTarget(), monsterId: ark.id, partKey: named[0].key }, tabTarget: tabs, targetData });
  const mix = T.resolveTargetMix({ ...emptyTarget(), monsterId: ark.id, partKey: named[0].key }, tabs, targetData);
  assert.deepEqual(mixed.targets.map((x) => [x.partKey, x.weight]), mix.targets.map((x) => [x.partKey, x.weight]));

  const noPart = F.searchTargets({ target: { ...emptyTarget(), monsterId: ark.id }, targetData });
  assert.equal(noPart.fallback, 'no-part');
  assert.equal(noPart.targets[0].partKey, T.defaultPartKey(ark));

  const weak = F.searchTargets({ target: { ...emptyTarget(), monsterId: ark.id, partKey: 'head' }, targetData, policy: 'weak1' });
  assert.equal(weak.targets[0].partKey, T.defaultPartKey(ark));
  const main = F.searchTargets({ target: { ...emptyTarget(), monsterId: ark.id, partKey: 'head' }, targetData, policy: 'main3' });
  assert.ok(main.targets.length >= 1 && main.targets.length <= 3);
  assert.ok(main.targets.every((x) => ark.parts.find((p) => p.key === x.partKey).hitzone.slash >= T.WEAK_POINT_MIN));
  close(main.targets.reduce((a, x) => a + x.weight, 0), 1);
});

test('相手: 歴戦王ウズ・トゥナの頭の傷口は置き換え後 (弾 70・雷 20) で、印は未確認', () => {
  const uth = monsterByName('ウズ・トゥナ');
  const r = F.searchTargets({ target: { ...emptyTarget(), monsterId: uth.id, partKey: 'head', individual: 'arch-tempered', isWound: true }, targetData });
  assert.equal(r.targets[0].target.wound.shot, 70);
  assert.equal(r.targets[0].target.wound.thunder, 20);
  assert.equal(r.targets[0].target.isWound, true);
  assert.deepEqual(r.marks, ['unverified']);
  assert.ok(r.label.startsWith('ウズ・トゥナ（歴戦王）'));
  const normal = F.searchTargets({ target: { ...emptyTarget(), monsterId: uth.id, partKey: 'head' }, targetData });
  assert.equal(normal.targets[0].target.wound.thunder, 25);
});

// ---------------------------------------------------------------- 武器の範囲

test('武器の範囲: おまかせ・いまの武器・おすすめの属性・片手剣すべて', () => {
  const lists = { weapons: raw.weapons.weapons, myWeapons: [] };
  const noW = F.weaponChoice({ mode: 'auto', build: emptyBuild(), idx, ...lists });
  assert.equal(noW.weapons, 'sns-all', '武器が無ければ片手剣すべて');
  const cur = F.weaponChoice({ mode: 'current', build: emptyBuild(), idx, ...lists });
  assert.equal(cur.blocker.code, 'no-weapon');

  const b = { ...emptyBuild(), weapon: FIRE_WEAPON.id };
  assert.deepEqual(F.weaponChoice({ mode: 'auto', build: b, idx, ...lists }).weapons, [FIRE_WEAPON.id], '相手が無ければいまの武器');
  assert.equal(F.weaponChoice({ mode: 'all', build: b, idx, ...lists }).weapons, 'sns-all');

  // 歴戦王ウズ・トゥナは雷がはっきり → 火の武器なら おまかせ = おすすめの属性から (いまの武器も比べるため入れる)
  const uth = monsterByName('ウズ・トゥナ');
  const el = F.weaponChoice({ mode: 'auto', build: b, idx, ...lists, monster: uth, kind: 'arch-tempered' });
  assert.equal(el.mode, 'element');
  assert.ok(el.elements.includes('thunder'));
  assert.ok(el.weapons.includes(FIRE_WEAPON.id));
  const thunder = raw.weapons.weapons.filter((w) => w.element && w.element.type === 'thunder');
  assert.ok(thunder.every((w) => el.weapons.includes(w.id)));
  // 雷の武器を持っていれば おまかせ = いまの武器
  const tw = thunder.find((w) => w.rarity === 8) || thunder[0];
  assert.deepEqual(F.weaponChoice({ mode: 'auto', build: { ...b, weapon: tw.id }, idx, ...lists, monster: uth, kind: 'arch-tempered' }).weapons, [tw.id]);
});

// ---------------------------------------------------------------- 探す条件 → Job

test('Job: 段階 2 の入力 (createSearch の形) と inputKey', () => {
  const ark = monsterByName('アルシュベルド');
  const build = { ...emptyBuild(), weapon: FIRE_WEAPON.id, limitBreak: { ...emptyBuild().limitBreak, head: true } };
  const search = { ...defaultSearch(), required: [{ skillId: skillId('耐震'), level: 3 }, { skillId: 99999, level: 1 }],
    archTemperedHunted: { [String(ark.id)]: false }, armorExclude: [10] };
  const localCharms = [{ id: 'cl1', name: '護石', skills: [], armorSlots: [1, 0, 0], weaponSlots: [0] }];
  const f = F.buildJob(ctxOf({ build, search, target: { ...emptyTarget(), monsterId: ark.id, partKey: 'head' }, localCharms, uptimes: { enraged: 0.6 } }));
  assert.equal(f.ok, true, JSON.stringify(f.blockers));
  assert.equal(f.job.kind, 'search');
  const inp = f.job.input;
  assert.deepEqual(inp.weapons, [FIRE_WEAPON.id]);
  assert.equal(inp.targets.length, 1);
  assert.equal(inp.combo, COMBOS.combos[0]);
  assert.equal(inp.uptimes.enraged, 0.6);
  assert.equal(inp.uptimes.hpFull, 0, '仮の条件は 0%');
  assert.deepEqual(inp.required, [{ skillId: skillId('耐震'), level: 3 }], '知らないスキルは外す');
  assert.deepEqual(inp.charms.extra, localCharms);
  assert.equal(inp.charms.owned, true);
  assert.ok([186, 187].every((id) => inp.charms.fixedExclude.includes(id)));
  assert.ok([10, 705, 706, 707, 708, 709].every((id) => inp.armorExclude.includes(id)));
  assert.equal(inp.limitBreak.head, true);
  assert.equal(inp.limitBreak.chest, false);
  assert.deepEqual(inp.decorations, { owned: null });
  assert.equal(inp.objective, 'damage');
  assert.equal(inp.K, 10);
  assert.deepEqual(inp.budget, { activeMs: 6000 }, '予算は計算した時間で数える (裏に回っていた時間を数えない)');
  assert.equal(Object.keys(inp.gamma.armor).length, 25, 'γ の印の表を渡す');
  assert.equal(inp.current, build);
  assert.deepEqual(inp.monsterStatus, T.monsterStatusOf({ ...emptyTarget(), monsterId: ark.id, partKey: 'head' }, targetData));
  assert.equal(f.summary.zeroed, F.placeholderConditions(raw.skillEffects, { enraged: 0.6 }).filter((p) => !p.fromInput).length);
  // structuredClone (Worker に送れる形) ができる
  assert.doesNotThrow(() => structuredClone(f.job));

  // inputKey: 予算・いまの装備では変わらず、条件 (必須・発動率の扱い) で変わる
  const again = F.buildJob(ctxOf({ build, search, target: { ...emptyTarget(), monsterId: ark.id, partKey: 'head' }, localCharms, uptimes: { enraged: 0.6 } }));
  assert.equal(again.inputKey, f.inputKey);
  const budget = F.buildJob(ctxOf({ build, search: { ...search, budgetSec: 20 }, target: { ...emptyTarget(), monsterId: ark.id, partKey: 'head' }, localCharms, uptimes: { enraged: 0.6 } }));
  assert.equal(budget.inputKey, f.inputKey);
  const armorChanged = F.buildJob(ctxOf({ build: { ...build, armor: { ...build.armor, head: 1 } }, search, target: { ...emptyTarget(), monsterId: ark.id, partKey: 'head' }, localCharms, uptimes: { enraged: 0.6 } }));
  assert.equal(armorChanged.inputKey, f.inputKey, '「装備に入れる」で防具が変わっても、条件は同じ');
  const keep = F.buildJob(ctxOf({ build, search: { ...search, placeholders: 'keep' }, target: { ...emptyTarget(), monsterId: ark.id, partKey: 'head' }, localCharms, uptimes: { enraged: 0.6 } }));
  assert.notEqual(keep.inputKey, f.inputKey);
  assert.equal(keep.job.input.uptimes.hpFull, undefined, '火力タブの値のまま (仮の 50%)');
  const req = F.buildJob(ctxOf({ build, search: { ...search, required: [] }, target: { ...emptyTarget(), monsterId: ark.id, partKey: 'head' }, localCharms, uptimes: { enraged: 0.6 } }));
  assert.notEqual(req.inputKey, f.inputKey);
  assert.equal(F.inputKeyOf(f.job, 'v1'), F.inputKeyOf(structuredClone(f.job), 'v1'));
  assert.notEqual(F.inputKeyOf(f.job, 'v1'), F.inputKeyOf(f.job, 'v2'), 'データの版が変われば変わる');
});

test('条件が変わったか: 結果の組を装備に入れただけなら、探し始めた時の装備で比べ直すと同じ条件', () => {
  // 歴戦王ウズ・トゥナ (雷がはっきり) を火の武器で → おまかせ = おすすめの属性から。雷の武器の結果を入れると、
  // いまの装備で作った条件は「いまの武器」(雷 1 本) に変わる → startBuild で作り直すと元の条件と同じ
  const uth = monsterByName('ウズ・トゥナ');
  const target = { ...emptyTarget(), monsterId: uth.id, partKey: 'head', individual: 'arch-tempered' };
  const build = { ...emptyBuild(), weapon: FIRE_WEAPON.id };
  const f = F.buildJob(ctxOf({ build, target }));
  assert.equal(f.weapon.mode, 'element');
  assert.equal(f.summary.startBuild, build);
  const tw = raw.weapons.weapons.find((w) => w.element && w.element.type === 'thunder' && f.job.input.weapons.includes(w.id));
  const applied = { ...emptyBuild(), weapon: tw.id, armor: { ...emptyBuild().armor, head: 1 } };
  const result = F.normalizeResult({ status: 'done', results: [{ value: 500, build: applied }] });
  assert.equal(F.isResultBuild(result, applied), true);
  assert.equal(F.isResultBuild(result, { ...applied, charm: 186 }), false, '護石を替えたら結果の組ではない');
  assert.equal(F.isResultBuild(result, build), false);
  // 2 本目の武器の組 (builds[1]) も結果の組
  const two = F.normalizeResult({ status: 'done', results: [{ value: 500, build, builds: [build, applied] }] });
  assert.equal(F.isResultBuild(two, applied), true);
  const now = F.buildJob(ctxOf({ build: applied, target }));
  assert.notEqual(now.inputKey, f.inputKey, 'いまの装備で作ると武器の範囲が変わる');
  const again = F.buildJob(ctxOf({ build: f.summary.startBuild, target }));
  assert.equal(again.inputKey, f.inputKey, '探し始めた時の装備で作り直せば同じ条件');
});

test('Job: 探せないとき (武器が無い・装備固定のクエスト) と、相手のデータを読み込み中', () => {
  const noW = F.buildJob(ctxOf({ search: { ...defaultSearch(), weaponMode: 'current' } }));
  assert.equal(noW.ok, false);
  assert.equal(noW.job, null);
  assert.equal(noW.blockers[0].code, 'no-weapon');
  // 装備固定のクエスト
  const fixed = QUESTS.quests.find((q) => q.fixedEquipment === true && q.targets.some((t) => t.monsterId != null));
  const mid = fixed.targets.find((t) => t.monsterId != null).monsterId;
  const r = F.buildJob(ctxOf({ build: { ...emptyBuild(), weapon: FIRE_WEAPON.id }, target: { ...emptyTarget(), monsterId: mid, questId: fixed.id } }));
  assert.ok(r.blockers.some((b) => b.code === 'fixed-equipment'));
  const loading = F.buildJob(ctxOf({ target: { ...emptyTarget(), monsterId: 20, partKey: 'head' }, targetData: null }));
  assert.equal(loading.loading, true);
});

test('Job: 相手に合わせるときは本物の recommend.js の Plan → Job (kind plan)。相手が無い・おすすめを使わない・壊れていれば段階 2', () => {
  const nu = monsterByName('ヌ・エグドラ');
  const quest = QUESTS.quests.find((q) => q.name === '黒き揺り篭の吾子');
  const target = { ...emptyTarget(), monsterId: nu.id, individual: 'arch-tempered', questId: quest.id };
  const build = { ...emptyBuild(), weapon: FIRE_WEAPON.id };
  const localCharms = [{ id: 'cl1', name: '端末の護石', rarity: 5, skills: [], slots: { armor: [], weapon: [] } }];
  const f = F.buildJob(ctxOf({ build, target, recommend: R, localCharms }));
  assert.equal(f.ok, true, JSON.stringify(f.blockers));
  assert.equal(f.job.kind, 'plan');
  // 環境適応 Lv2 + 火属性やられ (バランス) → 属性やられの「または」で探索 2 回 + 守りの火力の差を測る回
  assert.deepEqual(f.job.runs.map((r) => r.key), ['blight-skill', 'blight-resist']);
  assert.ok(f.job.costRun);
  assert.deepEqual(f.job.subjects.map((x) => x.name), ['ヌ・エグドラ（歴戦王）']);
  assert.ok(f.job.requirements.some((x) => x.label.includes('環境適応')));
  assert.ok(f.job.gamma && Object.keys(f.job.gamma.armor).length === 25, 'γ の印の表');
  for (const r of f.job.runs) {
    assert.deepEqual(r.input.budget, { activeMs: Math.round((6000 * R.RUN_SHARE) / 2) }, '予算は回の数で分ける (火力の差の回の分を残す)');
    assert.equal(r.input.charms.extra.length, 1, '端末の護石は足す');
    assert.equal(r.input.current, build);
    assert.ok(r.input.gamma);
    assert.ok(r.input.targets.every((x) => x.group === f.job.subjects[0].key));
  }
  assert.ok(f.plan.requirements.some((x) => x.on && x.label.includes('環境適応')));
  assert.match(f.weaponText, /おすすめの属性 \(水\)/, f.weaponText);
  assert.doesNotThrow(() => structuredClone(f.job), 'Worker に送れる形');
  // 倒していない歴戦王の γ 防具・狩猟証γ の護石は探索の入力から外れる
  const hunted = F.buildJob(ctxOf({ build, target, recommend: R, search: { ...defaultSearch(), archTemperedHunted: { [String(nu.id)]: false } } }));
  const gNu = F.gammaInfo(targetData).monsters.find((x) => x.monsterId === nu.id);
  for (const r of hunted.job.runs) {
    assert.ok(gNu.armorIds.every((id) => r.input.armorExclude.includes(id)));
    assert.ok(gNu.charmFixedIds.every((id) => r.input.charms.fixedExclude.includes(id)));
  }
  assert.notEqual(hunted.inputKey, f.inputKey);
  // 歴戦王ウズ・トゥナの傷口 (woundOverrides) が探索の targets に入る (頭の傷口 弾 88 → 70)
  const uth = monsterByName('ウズ・トゥナ');
  const tu = F.buildJob(ctxOf({ build, target: { ...emptyTarget(), monsterId: uth.id, individual: 'arch-tempered', partKey: 'head', isWound: true }, recommend: R }));
  assert.equal(tu.job.kind, 'plan');
  assert.equal(tu.job.runs[0].input.targets[0].target.wound.shot, 70);
  assert.equal(tu.job.runs[0].input.targets[0].target.isWound, true);
  // 多頭 (英雄の証): 武器 2 本の案
  const hero = QUESTS.quests.find((q) => q.name === '英雄の証');
  const first = hero.mission.targets.find((x) => x.monsterId != null);
  const heroTarget = { ...emptyTarget(), monsterId: first.monsterId, individual: first.variant, questId: hero.id };
  const multi = F.buildJob(ctxOf({ build, target: heroTarget, recommend: R }));
  assert.equal(multi.job.merge.mode, 'twoWeapons');
  assert.equal(multi.job.subjects.length, 4);
  assert.equal(multi.summary.multi, true);
  const one = F.buildJob(ctxOf({ build, target: heroTarget, recommend: R, search: { ...defaultSearch(), twoWeapons: 'off' } }));
  assert.equal(one.job.merge.mode, 'multi', '1 本だけにも切り替えられる');

  // 時間の目安: 既定 (仮置き 0%) はそのまま、火力タブの値のまま相手に合わせると「もっとかかる」
  assert.match(F.startHintText(f, defaultSearch()), /^6 秒くらい \(途中/);
  const keep = { ...defaultSearch(), placeholders: 'keep' };
  assert.match(F.startHintText(F.buildJob(ctxOf({ build, target, recommend: R, search: keep })), keep), /もっとかかる/);

  // 相手に合わせない → 段階 2
  assert.equal(F.buildJob(ctxOf({ build, target, recommend: R, search: { ...defaultSearch(), useTarget: false } })).job.kind, 'search');
  // 相手を選んでいない → 段階 2 (既定の肉質)
  assert.equal(F.buildJob(ctxOf({ build, recommend: R })).job.kind, 'search');
  // 武器が無くても、Plan で探すときはほかの武器から (段階 2 の「武器を選んでいません」で止めない)
  const noW = F.buildJob(ctxOf({ target, recommend: R, search: { ...defaultSearch(), weaponMode: 'current' } }));
  assert.equal(noW.ok, true, JSON.stringify(noW.blockers));
  assert.equal(noW.job.kind, 'plan');
  // 壊れた buildPlan → 段階 2 と注意
  const broken = F.buildJob(ctxOf({ build, target, recommend: { buildPlan: () => { throw new Error('x'); }, planToJob: () => null } }));
  assert.equal(broken.job.kind, 'search');
  assert.ok(broken.notes.some((n) => n.code === 'plan-error'));
  // Plan を作れない (null) → 段階 2
  assert.equal(F.buildJob(ctxOf({ build, target, recommend: { buildPlan: () => null } })).job.kind, 'search');
});

test('結果の見せ方: 守りのチェック・多頭の回数の差・守りの火力の差', () => {
  const view = F.defenseView(
    { ok: true, rows: [{ key: 'a', label: '環境適応 Lv2', status: 'ok', on: true, text: '環境適応 Lv2' }, { key: 'b', label: '耳栓 Lv2', status: 'missing', on: false, text: 'なし' }] },
    { ok: false, rows: [{ key: 'a', label: '環境適応 Lv2', status: 'missing', on: true, text: 'なし' }] },
  );
  assert.equal(view.ok, false, '2 本目の装備で足りなければ満たしていない');
  assert.deepEqual(view.items.map((x) => [x.key, x.status]), [['a', 'missing']], 'オフの行は出さない・悪い方を出す');
  assert.equal(F.defenseText(F.defenseView({ ok: true, rows: [{ key: 'a', label: '火属性やられを防ぐ', status: 'ok', on: true, text: '火耐性の合計 22' }] })), '✓火耐性の合計 22');
  assert.equal(F.defenseView(null), null);
  assert.match(F.costOfDefenseText({ kind: 'damage', main: 900, free: 950 }), /火力 −5\.3%/);
  assert.match(F.costOfDefenseText({ kind: 'combos', main: 110, free: 100 }), /約 10(\.0)?% 増えます/);
  assert.equal(F.costOfDefenseText({ kind: 'damage', main: 950, free: 950 }), null, '差が無ければ出さない');
  const rows = F.resultRows(F.normalizeResult({
    status: 'done', results: [{ rank: 1, value: 50, build: emptyBuild(), score: { kind: 'combos', value: 140.2, better: 'lower' },
      combosTotal: 142, baseline: { value: 150, combos: 151 }, perSubject: [{ key: 'a', name: 'A', value: 300, combos: 50, weapon: 1 }] }],
  }), { idx, currentBuild: emptyBuild(), currentSkills: [] });
  assert.equal(rows[0].scoreKind, 'combos');
  assert.equal(rows[0].diffPct, null);
  assert.equal(rows[0].diffCombos, -9);
  assert.equal(F.valueText(rows[0].value, 'combos'), '約 141 回');
  assert.equal(F.rowValueText(rows[0]), '約 142 回', '多頭は相手ごとに切り上げた回数の合計 (相手タブと同じ数え方)');
});

// ---------------------------------------------------------------- 必須スキルの行

test('必須スキル: 行と、足す一覧 (シリーズ/グループも選べる。段の Lv と要る部位の数を添える)', () => {
  const rows = F.requiredRows([{ skillId: skillId('耐震'), level: 2 }, { skillId: 99999, level: 1 }], idx);
  assert.equal(rows[0].name, '耐震');
  assert.equal(rows[0].maxLevel, idx.skills.get(skillId('耐震')).maxLevel);
  assert.equal(rows[1].missing, true);
  const items = F.requiredPickerItems(raw.skills.skills, [{ skillId: skillId('耐震'), level: 2 }], raw.bonuses);
  assert.equal(items.length, raw.skills.skills.length);
  assert.ok(items.every((i) => !i.disabled), 'シリーズ/グループも選べる (探索が対応した。docs/SEARCH_DESIGN.md 11 章)');
  assert.match(items.find((i) => i.value === skillId('黒蝕竜の力')).sub, /Lv1 = 2 部位・Lv2 = 4 部位/);
  assert.match(items.find((i) => i.value === skillId('ヌシの魂')).sub, /Lv1 = 3 部位/);
  assert.equal(items.find((i) => i.value === skillId('ヌシの魂')).group, 'グループスキル');
  assert.match(items.find((i) => i.value === skillId('耐震')).sub, /いま Lv2/);
  assert.equal(items[0].group, '防具スキル');
});

// ---------------------------------------------------------------- 結果の見せ方

test('結果: 壊れた値を捨て、いまとの差・変わる部位・スキルの差・空きスロットを出す', () => {
  assert.equal(F.normalizeResult(null), null);
  assert.equal(F.normalizeResult('x'), null);
  const n = F.normalizeResult({ results: [null, { value: 'x', build: {} }, { value: 10, build: { weapon: 1 } }, { value: 5 }], warnings: [1, { message: 'a' }] });
  assert.equal(n.results.length, 1);
  assert.equal(n.status, 'done');
  assert.deepEqual(n.warnings, [{ message: 'a' }]);

  const cur = { ...emptyBuild(), weapon: FIRE_WEAPON.id, armor: { ...emptyBuild().armor, head: 670, chest: 671 } };
  const next = { ...cur, armor: { ...cur.armor, chest: 1, waist: 5 }, charm: 187 };
  const d = F.buildDiff(cur, next);
  assert.deepEqual(d.parts, ['chest', 'waist']);
  assert.equal(d.charm, true);
  assert.equal(d.weapon, false);
  assert.equal(F.changeText(d), '武器はそのまま・胴 腰 護石が変わる');
  assert.equal(F.changeText(F.buildDiff(cur, structuredClone(cur))), 'いまの装備と同じ');
  assert.equal(F.changeText(F.buildDiff(cur, { ...cur, decorations: { ...cur.decorations, weapon: [1] } })), '武器はそのまま・装飾品だけが変わる');

  const sd = F.skillDiff([{ skillId: 1, name: 'A', level: 3 }, { skillId: 2, name: 'B', level: 2 }, { skillId: 3, name: 'C', level: 1 }],
    [{ skillId: 1, name: 'A', level: 5 }, { skillId: 3, name: 'C', level: 1 }, { skillId: 4, name: 'D', level: 2 }]);
  assert.deepEqual(sd.map((s) => [s.skillId, s.change]), [[4, 'new'], [1, 'up'], [2, 'gone'], [3, 'same']]);
  assert.equal(F.mainSkillsText([{ name: '攻撃', level: 5 }, { name: '見切り', level: 3 }], 1), '攻撃5 …');
  assert.equal(F.freeSlotsText({ weapon: { 1: 0, 2: 0, 3: 0 }, armor: { 1: 2, 2: 0, 3: 1 } }), '武器用 なし・防具用 ③×1 ①×2');
  assert.equal(F.topChanged({ results: [{ value: 1, build: cur }] }, { results: [{ value: 1, build: cur }] }), false);
  assert.equal(F.topChanged({ results: [{ value: 1, build: cur }] }, { results: [{ value: 2, build: cur }] }), true);
  assert.equal(F.bestOfProgress([{ value: 3 }]), 3);
  assert.equal(F.bestOfProgress([4, 2]), 4);
  assert.equal(F.bestOfProgress([]), null);
  const pv = F.progressView({ phase: 'dfs', elapsedMs: 3000, best: 900 }, 6000);
  assert.equal(pv.text, 'もっと良い組を探しています');
  assert.ok(pv.share > 0.55 && pv.share < 0.9);
  assert.equal(F.progressView({ phase: 'nope' }, 6000).text, '準備しています');
});

test('結果: いまの装備の値 (baselineValue) は火力タブの計算 (summarizePower) と同じ', () => {
  const ark = monsterByName('アルシュベルド');
  const build = {
    ...emptyBuild(), weapon: FIRE_WEAPON.id, armor: { head: 670, chest: 671, arms: 672, waist: 673, legs: 674 },
    limitBreak: { head: true, chest: false, arms: false, waist: false, legs: false }, charm: 187,
  };
  const f = F.buildJob(ctxOf({ build, target: { ...emptyTarget(), monsterId: ark.id, partKey: 'head' }, search: { ...defaultSearch(), placeholders: 'keep' }, uptimes: { enraged: 0.4 } }));
  const v = F.baselineValue(f.job.input, build, idx, core);
  const w = L.resolveWeaponRef(build.weapon, idx);
  const br = computeBuild(build, idx);
  const p = L.summarizePower({
    weapon: w, sharpness: L.autoSharpness(w, idx, br.skillLevels).color, skills: br.skills, uptimes: { enraged: 0.4 }, data: core,
    combo: COMBOS.combos[0], targets: f.job.input.targets, perSkills: L.sharpnessResolver(w, idx, null), monsterStatus: f.job.input.monsterStatus,
  });
  close(v, p.total);
  assert.equal(F.baselineValue(f.job.input, emptyBuild(), idx, core), null, '武器が無ければ null');

  // resultRows: 差 (%)・γ の印・2 本目の武器
  const g = F.gammaInfo(targetData);
  const other = { ...build, armor: { ...build.armor, head: 705 } };
  const rows = F.resultRows(F.normalizeResult({
    status: 'done', results: [{ rank: 1, value: v * 1.1, build: other, builds: [other, { ...other, weapon: raw.weapons.weapons[0].id }] }],
  }), { idx, currentBuild: build, currentSkills: br.skills, baseline: v, gamma: g });
  close(rows[0].diffPct, 10, 1e-9);
  assert.equal(rows[0].changeText, '武器はそのまま・頭が変わる');
  assert.deepEqual(rows[0].gamma, ['アルシュベルド（歴戦王）']);
  assert.ok(rows[0].second && rows[0].second.weaponName);
  assert.ok(rows[0].skills.length > 0, 'skills が無ければ computeBuild から');
  assert.ok(rows[0].freeSlots && rows[0].freeSlots.armor);
  const lines = F.buildLines(other, idx);
  assert.deepEqual(lines.map((l) => l.key), ['weapon', 'head', 'chest', 'arms', 'waist', 'legs', 'charm']);
  assert.equal(lines[1].limitBreak, true);
});

// ---------------------------------------------------------------- 2026-10-22 の点検の直し (いまとの比べ・壊れた保存データ・計算中の表示)

const modelData = { index: idx, effects: raw.skillEffects, motions: raw.motions };

test('結果: 装備に入れたあとは、いまの装備で計算し直した基準で「いまより」を出す (1 体・討伐までの回数)', () => {
  const nu = monsterByName('ヌ・エグドラ');
  const quest = QUESTS.quests.find((q) => q.name === '黒き揺り篭の吾子');
  const start = { ...emptyBuild(), weapon: FIRE_WEAPON.id };
  const f = F.buildJob(ctxOf({ build: start, target: { ...emptyTarget(), monsterId: nu.id, individual: 'arch-tempered', questId: quest.id }, recommend: R }));
  assert.equal(f.job.kind, 'plan');
  const next = { ...start, armor: { head: 670, chest: 671, arms: 672, waist: 673, legs: 674 }, charm: 187 };
  const bStart = R.planBaseline(f.job, start, modelData);
  const bNext = R.planBaseline(f.job, next, modelData);
  assert.ok(bStart && bNext && Math.abs(bNext.value - bStart.value) > 1, `${bStart && bStart.value} / ${bNext && bNext.value}`);
  assert.ok(bNext.combos > 0, 'クエストを選んでいれば討伐までの回数');
  const key = f.job.subjects[0].key;
  const res = F.normalizeResult({ status: 'done', results: [{
    rank: 1, value: bNext.value, build: next, score: { kind: 'damage', value: bNext.value }, baseline: bStart,
    perSubject: [{ key, value: bNext.value, combos: bNext.combos }],
  }] });
  // 探し始めた時の装備のまま: 結果の行の基準 (探し始めた時の装備) と比べる
  const before = F.resultRows(res, { idx, currentBuild: start, currentSkills: [], baseline: bStart, startBuild: start });
  close(before[0].diffPct, (bNext.value / bStart.value - 1) * 100, 1e-9);
  // 1 位を装備に入れたあと: 行の基準は探し始めた時の装備のものなので使わず、いまの装備 (= 1 位) で計算し直した基準と比べる
  const after = F.resultRows(res, { idx, currentBuild: next, currentSkills: [], baseline: bNext, startBuild: start });
  assert.equal(after[0].changeText, 'いまの装備と同じ');
  assert.ok(Math.abs(after[0].diffPct) < 1e-9, `入れたあとも「いまより ${after[0].diffPct}%」`);
  assert.equal(after[0].killCombos, bNext.combos, '1 体でも討伐までの回数を出す (設計 4.3 節)');
  assert.equal(after[0].baseCombos, bNext.combos);
  assert.match(F.baseText(after[0], { zeroed: 3, players: 1 }), /^いまの装備 [\d,]+\.\d・討伐まで 約 [\d,]+ 回 \(仮の条件は 0% で計算\)$/);
});

test('結果: 多頭も装備に入れたあとは、いまの装備の回数と比べる (回数の差 0)', () => {
  const hero = QUESTS.quests.find((q) => q.name === '英雄の証');
  const first = hero.mission.targets.find((x) => x.monsterId != null);
  const start = { ...emptyBuild(), weapon: FIRE_WEAPON.id };
  const f = F.buildJob(ctxOf({ build: start, target: { ...emptyTarget(), monsterId: first.monsterId, individual: first.variant, questId: hero.id }, recommend: R }));
  assert.equal(f.job.subjects.length, 4);
  const thunder = raw.weapons.weapons.find((w) => w.element && w.element.type === 'thunder' && w.rarity === 8);
  const next = { ...start, weapon: thunder.id, armor: { head: 670, chest: 671, arms: 672, waist: 673, legs: 674 } };
  const bStart = R.planBaseline(f.job, start, modelData);
  const bNext = R.planBaseline(f.job, next, modelData);
  assert.equal(bNext.kind, 'combos');
  const ranked = R.rerankMulti([{ value: 1, build: next, perGroup: bNext.perGroup }], f.job.subjects)[0];
  const res = F.normalizeResult({ status: 'done', results: [{ ...ranked, baseline: bStart }] });
  const before = F.resultRows(res, { idx, currentBuild: start, currentSkills: [], baseline: bStart, startBuild: start });
  assert.equal(before[0].diffCombos, ranked.combosTotal - bStart.combos);
  assert.notEqual(before[0].diffCombos, 0);
  const after = F.resultRows(res, { idx, currentBuild: next, currentSkills: [], baseline: bNext, startBuild: start });
  assert.equal(after[0].changeText, 'いまの装備と同じ');
  assert.equal(after[0].diffCombos, 0, '入れたあとも「いまより n 回少ない」のまま');
});

test('結果: 体力の分からない相手がいる多頭の「いまより」(全員不明 = 期待値どうし、1 体不明 = 回数の割合)', () => {
  const rowOf = (score, baseline, extra = {}) => F.resultRows(F.normalizeResult({ status: 'done', results: [{
    rank: 1, value: 1, build: emptyBuild(), score, baseline, perSubject: [{ key: 'a', value: 1 }, { key: 'b', value: 1 }], ...extra,
  }] }), { idx, currentBuild: emptyBuild(), currentSkills: [] })[0];
  // 全員分からない: 結果も基準も期待値の調和平均 (recommend.js の baselineView)
  close(rowOf({ kind: 'damage', value: 200 }, { kind: 'damage', value: 100, T: null, combos: null }).diffPct, 100, 1e-12);
  // 前の版で保存した結果 (基準に kind が無く T が入っている) は単位が違うので出さない (前は +14,595,152% のように出ていた)
  assert.equal(rowOf({ kind: 'damage', value: 200 }, { value: 0.02, combos: null }).diffPct, null);
  // 1 体だけ分からない: 回数の合計は出せないので T の割合 (+ なら回数が少ない)
  const one = rowOf({ kind: 'combos', value: 210 }, { kind: 'combos', value: 233, T: 233, combos: null }, { combosTotal: null });
  assert.equal(one.diffCombos, null);
  close(one.diffTPct, (1 - 210 / 233) * 100, 1e-12);
  // 回数の合計が両方あれば回数の差
  const both = rowOf({ kind: 'combos', value: 209.1 }, { kind: 'combos', value: 268.2, T: 268.2, combos: 269 }, { combosTotal: 210 });
  assert.equal(both.diffCombos, -59);
  assert.equal(both.diffTPct, null);
  assert.equal(F.baseText(both, { zeroed: 1, players: 4 }), 'いまの装備 約 269 回 (4 人のとき) (仮の条件は 0% で計算)');
});

test('結果: 1 位と同じ値の行に印・同じ値の件数', () => {
  const b = emptyBuild();
  const rows = F.resultRows(F.normalizeResult({ status: 'done', results: [
    { rank: 1, value: 900, build: b }, { rank: 2, value: 900 * (1 + 1e-12), build: b }, { rank: 3, value: 899, build: b },
  ] }), { idx, currentBuild: b, currentSkills: [], baseline: 800 });
  assert.deepEqual(rows.map((r) => r.sameAsTop), [false, true, false]);
  assert.equal(F.tiesWithTop(rows), 2);
  assert.equal(F.baseText(rows[0], { zeroed: 20 }), 'いまの装備 800.0 (仮の条件は 0% で計算)');
  assert.equal(F.tiesWithTop([]), 0);
  assert.deepEqual(F.tieRuns(rows), []);
  assert.deepEqual(F.tieRuns([]), []);
});

test('結果: 1 位とは違う値で同じ値が続く順位 (2〜10 位など) にも印と注', () => {
  // 2026-10-22 の本人の前提の後、探すタブの既定で「1 位 911.3・2〜10 位が全部 901.8」のような並びが出る (点検の指摘)
  const b = emptyBuild();
  const vals = [911.3, 901.8, 901.8, 901.8, 890, 880, 880, 870, 870, 870];
  const rows = F.resultRows(F.normalizeResult({ status: 'stopped', results: vals.map((value, i) => ({ rank: i + 1, value, build: b })) }),
    { idx, currentBuild: b, currentSkills: [], baseline: 800 });
  assert.deepEqual(rows.map((r) => r.sameAsTop), vals.map(() => false));
  assert.deepEqual(rows.map((r) => r.sameAsPrev), [false, false, true, true, false, false, true, false, true, true]);
  assert.equal(F.tiesWithTop(rows), 1);
  assert.deepEqual(F.tieRuns(rows), [{ from: 2, to: 4 }, { from: 6, to: 7 }, { from: 8, to: 10 }]);
  // 1 位と同じ値のまとまりは tiesWithTop で数え、tieRuns には入れない
  const top = F.resultRows(F.normalizeResult({ results: [900, 900, 900, 850, 850].map((value, i) => ({ rank: i + 1, value, build: b })) }),
    { idx, currentBuild: b, currentSkills: [] });
  assert.equal(F.tiesWithTop(top), 3);
  assert.deepEqual(F.tieRuns(top), [{ from: 4, to: 5 }]);
});

test('結果: 壊れた保存データ (行の中の配列に null・装飾品の形が違う など) でも行を作れる', () => {
  const broken = [
    { results: [{ build: emptyBuild(), value: 900, skills: [null] }] },
    { status: 'infeasible', results: [], infeasible: { missing: [null, 5] } },
    { results: [{ build: emptyBuild(), value: 900, perSubject: [null, 5], builds: [null, 3], defense: { ok: true, rows: [null] }, defense2: 'x',
      alternatives: { head: 'x', chest: [1, null] } }] },
    { results: [{ build: { ...emptyBuild(), decorations: { weapon: 5, head: null }, armor: 'x', limitBreak: 3 }, value: 900, score: 3, baseline: 'x' }] },
  ];
  for (const raw0 of broken) {
    const n = F.normalizeResult(raw0);
    let rows;
    assert.doesNotThrow(() => { rows = F.resultRows(n, { idx, currentBuild: emptyBuild(), currentSkills: [] }); }, JSON.stringify(raw0));
    for (const r of rows) {
      assert.doesNotThrow(() => F.buildLines(r.raw.build, idx));
      assert.ok(r.skills.every((s) => s && typeof s === 'object'));
      assert.ok(r.perSubject.every((p) => p && typeof p === 'object'));
    }
  }
  assert.deepEqual(F.normalizeResult(broken[1]).infeasible.missing, []);
  assert.deepEqual(F.normalizeResult(broken[2]).results[0].alternatives, { chest: [1] });
  // 相手に合わせて探した Job の満たせない理由 (回ごとの配列) も missing にまとめる (同じスキルは 1 つ)
  const n3 = F.normalizeResult({ status: 'infeasible', results: [],
    infeasible: [{ run: 'a', missing: [{ skillId: 1, level: 2, name: 'x' }] }, { run: 'b', missing: [{ skillId: 1, level: 2, name: 'x' }, null] }] });
  assert.deepEqual(n3.infeasible.missing.map((m) => m.skillId), [1]);
});

test('計算中: 帯は Job 全体で数える (回が変わっても戻らない)・回目は回の数をこえない・多頭のいまの最良は回数', () => {
  const B = 6000;
  const a = F.progressView({ phase: 'polish2', elapsedMs: 2000, run: { index: 0, count: 3 } }, B);
  const b = F.progressView({ phase: 'prepare', elapsedMs: 2100, run: { index: 1, count: 3 } }, B);
  const m = F.progressView({ phase: 'twoWeapons', elapsedMs: 4000, run: { index: 1, count: 3 } }, B);
  const c = F.progressView({ phase: 'cost', elapsedMs: 4300, run: { index: 2, count: 3, label: '守りのスキルの火力の差を測っています' } }, B);
  assert.ok(a.share < b.share && b.share < m.share && m.share < c.share && c.share < 1, JSON.stringify([a.share, b.share, m.share, c.share]));
  assert.equal(c.runText, '3 / 3 回目: 守りのスキルの火力の差を測っています');
  const d1 = F.progressView({ phase: 'dfs', elapsedMs: 2100, run: { index: 1, count: 3 } }, B);
  const d2 = F.progressView({ phase: 'dfs', elapsedMs: 3900, run: { index: 1, count: 3 } }, B);
  assert.ok(b.share < d1.share && d1.share < d2.share && d2.share <= 2 / 3);
  assert.equal(F.progressView({ phase: 'merge', best: 209.1, bestKind: 'combos' }, B).bestText, '全部倒すまで 約 210 回');
  assert.equal(F.progressView({ phase: 'dfs', best: 1192.12 }, B).bestText, '1,192.1');
  assert.equal(F.progressView({ phase: 'dfs' }, B).bestText, '');
  // いまの最良は 1 つの探索の中で悪くならない (期待値は大きい方・回数は小さい方。種類が変われば新しい値)
  assert.deepEqual(C.keepBest(1192, 'damage', 1157, 'damage'), { best: 1192, kind: 'damage' });
  assert.deepEqual(C.keepBest(230, 'combos', 210, 'combos'), { best: 210, kind: 'combos' });
  assert.deepEqual(C.keepBest(1192, 'damage', 210, 'combos'), { best: 210, kind: 'combos' });
  assert.deepEqual(C.keepBest(1192, 'damage', null, undefined), { best: 1192, kind: 'damage' });
  // くわしくの段階の名前は日本語
  for (const k of ['prepare', 'beam1', 'beam2', 'polish1', 'dfs', 'polish2', 'done', 'merge', 'twoWeapons', 'cost']) {
    assert.ok(F.PHASE_SHORT[k] && !/[a-z]/i.test(F.PHASE_SHORT[k].replace(/\d/g, '')), k);
  }
});

test('相手: 一時的な部位 (水膜) は弱点 1 か所・主な部位 3 か所の自動の選び方で選ばない', () => {
  const uth = monsterByName('ウズ・トゥナ');
  assert.ok(uth.parts.some((p) => p.transient === true));
  assert.equal(T.defaultPartKey(uth), 'right-front-leg');
  const main = F.mainParts(uth);
  assert.equal(main.length, 3);
  assert.ok(main.every((p) => p.transient !== true));
  const weak = F.searchTargets({ target: { ...emptyTarget(), monsterId: uth.id }, targetData, policy: 'weak1' });
  assert.equal(weak.targets[0].partKey, 'right-front-leg');
  // 自分で選べば水膜も狙える
  const film = uth.parts.find((p) => p.transient === true);
  const own = F.searchTargets({ target: { ...emptyTarget(), monsterId: uth.id, partKey: film.key }, targetData, policy: 'asSelected' });
  assert.equal(own.targets[0].partKey, film.key);
});

// ---------------------------------------------------------------- 作り物の探索 (fixture) とコントローラ

const fakeData = Promise.resolve(raw);
/** 作り物の探索を画面のスレッドでつなぐ makeTransport */
function fakeTransport(config) {
  return (handlers) => C.createInlineTransport(
    (post) => FAKE.createEngine(post, { inline: true, config, loadData: () => fakeData }), handlers);
}
function jobFor(extra = {}) {
  const ark = monsterByName('アルシュベルド');
  return F.buildJob(ctxOf({
    build: { ...emptyBuild(), weapon: FIRE_WEAPON.id }, target: { ...emptyTarget(), monsterId: ark.id, partKey: 'head' }, ...extra,
  }));
}
/** 状態が cond を満たすまで待つ */
function waitFor(ctrl, cond, ms = 8000) {
  return new Promise((resolve, reject) => {
    if (cond(ctrl.getSnapshot())) {
      resolve(ctrl.getSnapshot());
      return;
    }
    const timer = setTimeout(() => {
      off();
      reject(new Error(`待ちきれませんでした: ${JSON.stringify({ status: ctrl.getSnapshot().status, phase: ctrl.getSnapshot().phase })}`));
    }, ms);
    const off = ctrl.subscribe((s) => {
      if (cond(s)) {
        clearTimeout(timer);
        off();
        resolve(s);
      }
    });
  });
}

test('コントローラ: 途中の結果 → 終わり (1 位が良くなる) → 続けて探す → さらに良くなる', async () => {
  const f = jobFor();
  const news = [];
  const finished = [];
  const ctrl = C.createSearchController({
    makeTransport: fakeTransport({ step: 2 }), onNews: (s) => news.push(s.status), onFinish: (s) => finished.push(s.status),
  });
  ctrl.start(f.job, { inputKey: f.inputKey, summary: f.summary });
  assert.equal(ctrl.getSnapshot().status, 'running');
  assert.equal(ctrl.getSnapshot().inline, true);
  const partial = await waitFor(ctrl, (s) => s.partial);
  assert.ok(partial.result.results.length > 0);
  const pTop = partial.result.results[0].value;
  const done = await waitFor(ctrl, (s) => s.status === 'done');
  assert.ok(done.result.results[0].value > pTop, '終わりの 1 位は途中の結果より良い');
  assert.equal(done.improved, true);
  assert.equal(done.canExtend, true);
  assert.equal(done.inputKey, f.inputKey);
  assert.ok(done.phases.map((p) => p.name).includes('polish1'));
  assert.ok(done.partialMs != null && done.doneMs != null && done.doneMs >= done.partialMs);
  assert.deepEqual(finished, ['done']);
  assert.ok(news.length >= 2, '途中の結果と終わりで知らせる');
  // 値は本物の計算モデルの値 (火力タブと同じ式): 1 位の装備をいまの装備として計算し直すと同じ
  const top = done.result.results[0];
  close(F.baselineValue(f.job.input, top.build, idx, core), top.value, 1e-12);

  assert.equal(ctrl.extend({ ms: 10 }), true);
  assert.equal(ctrl.getSnapshot().extending, true);
  const ext = await waitFor(ctrl, (s) => s.status === 'done');
  assert.ok(ext.result.results[0].value > top.value);
  assert.equal(ext.improved, true);
  assert.equal(ext.extended, 1);
  assert.equal(finished.length, 2);
  ctrl.dispose();
});

test('コントローラ: 続ける所が無い結果 (B&B を最後まで回り終えた。extendable: false) には「続けて探す」を出さない', async () => {
  const f = jobFor();
  const ctrl = C.createSearchController({ makeTransport: fakeTransport({ step: 2, complete: true }) });
  ctrl.start(f.job, { inputKey: f.inputKey });
  const done = await waitFor(ctrl, (s) => s.status === 'done');
  assert.equal(done.result.extendable, false);
  assert.equal(done.canExtend, false);
  assert.equal(ctrl.extend({ ms: 10 }), false);
  ctrl.dispose();
});

test('コントローラ: やめる (途中の結果を残す)・もう一度・エラーとやり直し・満たせない', async () => {
  const f = jobFor();
  const ctrl = C.createSearchController({ makeTransport: fakeTransport({ step: 30 }) });
  ctrl.start(f.job, { inputKey: f.inputKey });
  await waitFor(ctrl, (s) => s.partial);
  ctrl.cancel();
  assert.equal(ctrl.getSnapshot().status, 'cancelling');
  const c = await waitFor(ctrl, (s) => s.status === 'cancelled');
  assert.ok(c.result.results.length > 0, 'それまでの組を残す');
  assert.equal(c.canExtend, false);
  // もう一度 (同じつなぎ方を使い回す)
  ctrl.start(f.job, { inputKey: f.inputKey });
  await waitFor(ctrl, (s) => s.status === 'done');
  ctrl.dispose();

  // start で error → やり直し (retry) でつなぎ方を作り直す
  let made = 0;
  const flaky = (handlers) => {
    made += 1;
    return fakeTransport(made === 1 ? { step: 1, fail: 'start' } : { step: 1 })(handlers);
  };
  const c2 = C.createSearchController({ makeTransport: flaky });
  c2.start(f.job);
  const err = await waitFor(c2, (s) => s.status === 'error');
  assert.match(err.error.message, /エラー/);
  c2.retry();
  await waitFor(c2, (s) => s.status === 'done');
  assert.equal(made, 2);
  c2.dispose();

  // 満たせない
  const c3 = C.createSearchController({ makeTransport: fakeTransport({ step: 1, result: 'infeasible' }) });
  const f3 = jobFor({ search: { ...defaultSearch(), required: [{ skillId: skillId('耐震'), level: 3 }] } });
  c3.start(f3.job);
  const inf = await waitFor(c3, (s) => s.status === 'infeasible');
  assert.equal(inf.result.infeasible.missing[0].name, '耐震');
  c3.dispose();
});

test('コントローラ: 止まらないときは作り直す・返事が無ければ止まったと知らせる・Worker を読めなければ画面で回す', async () => {
  const f = jobFor();
  // 何も返さないつなぎ方
  const silent = () => {
    const t = { inline: false, posted: [], terminated: false, post: (m) => t.posted.push(m), terminate: () => { t.terminated = true; } };
    silent.last = t;
    return t;
  };
  const ctrl = C.createSearchController({ makeTransport: silent, cancelGraceMs: 30, stallMs: 1e9 });
  ctrl.start(f.job);
  ctrl.cancel();
  const c = await waitFor(ctrl, (s) => s.status === 'cancelled');
  assert.equal(c.result.results.length, 0, 'まだ組が無い');
  assert.equal(silent.last.terminated, true, 'やめられないので作り直す');
  assert.deepEqual(silent.last.posted.map((m) => m.type), ['start', 'cancel']);
  assert.ok(silent.last.posted[0].job && silent.last.posted[0].input, 'start には job と input (search のとき) を入れる');
  ctrl.dispose();

  // 返事が来ない (見えている間) → 止まったと知らせる。見えていない間は数えない
  let visible = true;
  const c2 = C.createSearchController({ makeTransport: silent, stallMs: 40, watchEveryMs: 10, isVisible: () => visible });
  visible = false;
  c2.start(f.job);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(c2.getSnapshot().status, 'running', '裏に回っている間は止まったとしない');
  visible = true;
  c2.onVisibility(true);
  const st = await waitFor(c2, (s) => s.status === 'error');
  assert.match(st.error.message, /止まって/);
  c2.dispose();

  // Worker が一度も返事をせずに落ちた → 画面のスレッドで回し直す
  const calls = [];
  const factory = (handlers, opts) => {
    calls.push(opts.forceInline);
    if (!opts.forceInline) {
      setTimeout(() => handlers.onError({ message: 'load failed' }), 5);
      return { inline: false, post: () => {}, terminate: () => {} };
    }
    return fakeTransport({ step: 1 })(handlers);
  };
  const c3 = C.createSearchController({ makeTransport: factory });
  c3.start(f.job);
  const d = await waitFor(c3, (s) => s.status === 'done');
  assert.equal(d.inline, true);
  assert.deepEqual(calls, [false, true]);
  c3.dispose();
});

test('コントローラ: Worker も画面の処理も読み込めなかったら、もう一度・次に始めたときは Worker から作り直す。読み込めない文は日本語', async () => {
  const f = jobFor();
  const offline = () => Promise.reject(new Error('Importing a module script failed.'));
  // 画面の処理: search.js を読み込めない (電波が無い) → 日本語の文 + code 'load' + 元の文はくわしく
  const msgs = [];
  const eng = C.createModelEngine((m) => msgs.push(m), { getData: () => C.searchData(core), loadModules: offline });
  await eng.handle({ type: 'start', id: 'z', job: f.job });
  const err = msgs.find((m) => m.type === 'error');
  assert.equal(err.code, 'load');
  assert.equal(err.message, C.LOAD_ERROR_TEXT);
  assert.equal(err.detail, 'Importing a module script failed.');
  eng.dispose();

  const calls = [];
  let online = false;
  const factory = (handlers, opts) => {
    calls.push(opts.forceInline ? 'inline' : 'worker');
    if (opts.forceInline) {
      return C.createInlineTransport((post) => C.createModelEngine(post, { getData: () => C.searchData(core), loadModules: offline }), handlers);
    }
    if (!online) {
      // 返事をしないまま落ちる Worker (読み込めなかった)
      setTimeout(() => handlers.onError({ message: '' }), 5);
      return { inline: false, post: () => {}, terminate: () => {} };
    }
    const t = fakeTransport({ step: 1 })(handlers);
    return { ...t, inline: false };
  };
  // もう一度
  const ctrl = C.createSearchController({ makeTransport: factory });
  ctrl.start(f.job);
  const e1 = await waitFor(ctrl, (s) => s.status === 'error');
  assert.equal(e1.error.code, 'load');
  assert.equal(e1.error.detail, 'Importing a module script failed.');
  assert.deepEqual(calls, ['worker', 'inline']);
  online = true;
  ctrl.retry();
  await waitFor(ctrl, (s) => s.status === 'done');
  assert.deepEqual(calls, ['worker', 'inline', 'worker'], 'もう一度は Worker から作り直す (前は画面の処理のままで失敗し続けた)');
  ctrl.dispose();
  // 次に本人が始めたとき (start) も同じ
  calls.length = 0;
  online = false;
  const c2 = C.createSearchController({ makeTransport: factory });
  c2.start(f.job);
  await waitFor(c2, (s) => s.status === 'error');
  online = true;
  c2.start(f.job);
  await waitFor(c2, (s) => s.status === 'done');
  assert.deepEqual(calls, ['worker', 'inline', 'worker']);
  c2.dispose();
});

test('コントローラ: 前の探索の知らせは無視・保存した結果を出す・作り物の Worker でも同じ順', async () => {
  let handlers = null;
  const manual = (h) => {
    handlers = h;
    return { inline: false, post: () => {}, terminate: () => {} };
  };
  const ctrl = C.createSearchController({ makeTransport: manual, stallMs: 1e9 });
  const f = jobFor();
  const id1 = ctrl.start(f.job);
  const id2 = ctrl.start(f.job);
  assert.notEqual(id1, id2);
  handlers.onMessage({ type: 'done', id: id1, result: { status: 'done', results: [{ value: 1, build: {} }] } });
  assert.equal(ctrl.getSnapshot().status, 'running', '前の探索の done は無視');
  handlers.onMessage({ type: 'progress', id: id2, phase: 'beam1', elapsedMs: 50, best: [12.5] });
  assert.equal(ctrl.getSnapshot().phase, 'beam1');
  assert.equal(ctrl.getSnapshot().best, 12.5);
  handlers.onMessage({ type: 'done', id: id2, result: { status: 'stopped', results: [{ value: 2, build: {} }] } });
  assert.equal(ctrl.getSnapshot().status, 'stopped');
  ctrl.clear();
  assert.equal(ctrl.restore({ savedAt: '2026-10-21T00:00:00Z', inputKey: 'k1', summary: { label: 'x' }, result: { status: 'done', results: [{ value: 3, build: {} }] } }), true);
  const r = ctrl.getSnapshot();
  assert.equal(r.status, 'done');
  assert.equal(r.restored.savedAt, '2026-10-21T00:00:00Z');
  assert.equal(r.canExtend, false, '保存から戻した結果は続けて探せない');
  assert.equal(ctrl.restore({ result: { results: [] } }), false, 'もう結果があれば戻さない');
  ctrl.dispose();

  // 作り物の探索のメッセージの順 (progress → partial → progress… → done)
  const msgs = [];
  const eng = FAKE.createEngine((m) => msgs.push(m), { config: { step: 0 }, loadData: () => fakeData, inline: true });
  await eng.handle({ type: 'start', id: 'x', job: f.job });
  for (let i = 0; i < 300 && !msgs.some((m) => m.type === 'done'); i++) await new Promise((r) => setTimeout(r, 10));
  const types = msgs.map((m) => m.type);
  assert.equal(types[0], 'ready');
  assert.ok(types.indexOf('partial') > types.indexOf('progress'));
  assert.equal(types[types.length - 1], 'done');
  assert.deepEqual(msgs.filter((m) => m.type === 'progress').map((m) => m.phase), ['prepare', 'beam1', 'beam2', 'polish1', 'dfs', 'polish2']);
  eng.dispose();
});

test('画面のスレッドで回す探索 (createModelEngine): 本物の search.js / recommend.js で回る。作り物の本体でも同じ形で返す', async () => {
  const f = jobFor();
  // 本物の search.js (段階 2 の入力。軽くするためビームを狭く・仕事量の予算で)
  const real = [];
  const e1 = C.createModelEngine((m) => real.push(m), { getData: () => C.searchData(core), sliceMs: 50 });
  const light = { ...f.job, input: { ...f.job.input, beam: [10, 30], budget: { work: 500 } } };
  await e1.handle({ type: 'start', id: 'a', job: light });
  for (let i = 0; i < 600 && !real.some((m) => m.type === 'done' || m.type === 'error'); i++) await new Promise((r) => setTimeout(r, 10));
  const last = real.at(-1);
  assert.equal(last.type, 'done', JSON.stringify(last).slice(0, 300));
  assert.ok(last.result.results.length > 0);
  assert.ok(real.some((m) => m.type === 'ready'));
  e1.dispose();

  // createSearch と同じ形の作り物 (step を 3 回で終わり。2 回目で途中の結果)
  const stub = (input) => {
    let n = 0;
    let cancelled = false;
    return {
      step: () => { n += 1; return cancelled || n >= 3; },
      progress: () => ({ phase: ['prepare', 'beam1', 'polish1', 'done'][n] || 'done', elapsedMs: n, best: [{ value: n }], partialReady: n >= 2 }),
      result: () => ({ status: cancelled ? 'cancelled' : 'done', results: [{ value: 9, build: { weapon: input.weapons[0] } }] }),
      cancel: () => { cancelled = true; },
      extend: () => { n = 0; },
    };
  };
  const msgs = [];
  const e2 = C.createModelEngine((m) => msgs.push(m), {
    getData: () => C.searchData(core), loadModules: async () => ({ search: { createSearch: stub }, recommend: {} }), sliceMs: 1,
  });
  await e2.handle({ type: 'start', id: 'b', job: f.job });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(msgs.map((m) => m.type).filter((t) => t !== 'progress'), ['ready', 'partial', 'done']);
  assert.equal(msgs.at(-1).id, 'b');
  // plan の Job は recommend.js の createPlanRunner が無ければエラー (差し替えた作り物の recommend に無い)
  await e2.handle({ type: 'start', id: 'c', job: { kind: 'plan', runs: [], K: 10 } });
  assert.match(msgs.at(-1).message, /準備中/);
  e2.dispose();
});

test('テストの差し替え (window.__mhwSearchWorker) は同じオリジンの url だけ使う', () => {
  const loc = { href: 'https://example.github.io/mhwilds-sns/', origin: 'https://example.github.io' };
  assert.equal(C.workerOverride({ location: loc }), null);
  assert.equal(C.workerOverride({ location: loc, __mhwSearchWorker: { url: './tests/fixtures/fake_search_worker.js?step=1' } }).url,
    'https://example.github.io/mhwilds-sns/tests/fixtures/fake_search_worker.js?step=1');
  assert.equal(C.workerOverride({ location: loc, __mhwSearchWorker: { url: 'https://evil.example/x.js' } }), null);
  assert.equal(C.workerOverride({ location: loc, __mhwSearchWorker: 'x' }), null);
  assert.ok(C.WORKER_URL.endsWith('/app/search_worker.js'));
});
