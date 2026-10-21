// 探すタブの純粋関数 (app/ui/tabs/search_form.js) と、探索の出し入れ (search_client.js のコントローラ) のテスト。
// 実行: node --test tests/*.test.mjs  (Node 24 では tests/ とディレクトリで渡すと落ちる)
// search_client.js は 'preact/hooks' を名前で import する (ブラウザでは index.html の import map)。node では
// module.registerHooks で app/vendor の同じファイルに向ける (state.test.mjs と同じ)。
// 探索の本体はまだ無いので、コントローラは作り物の探索 (tests/fixtures/fake_search_worker.js の createEngine) でつなぐ。
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
  assert.ok(all.length >= 20, `仮の条件が ${all.length} 個`);
  assert.ok(all.every((p) => !p.fromInput));
  assert.ok(all.some((p) => p.id === 'chain' && p.type === 'categorical'));
  const mine = F.placeholderConditions(raw.skillEffects, { enraged: 0.7 });
  assert.equal(mine.find((p) => p.id === 'enraged').fromInput, true);
  assert.equal(mine.find((p) => p.id === 'enraged').valueText, '70%');

  const z = F.searchUptimes(raw.skillEffects, { enraged: 0.7 }, 'zero');
  assert.equal(z.enraged, 0.7, '本人が入れた値はそのまま');
  assert.equal(z.hpFull, 0);
  assert.deepEqual(z.chain, {}, '段階のある条件は全部の段 0%');
  assert.equal('beforeGuts' in z, false, '仮置きでない条件は触らない');
  assert.deepEqual(F.searchUptimes(raw.skillEffects, { enraged: 0.7 }, 'keep'), { enraged: 0.7 });

  // 0% にすると条件つきのスキル (挑戦者) は効かない = そのスキルが無いときと同じ値
  const z0 = F.searchUptimes(raw.skillEffects, {}, 'zero');
  const w = L.damageWeapon(L.resolveWeaponRef(FIRE_WEAPON.id, idx));
  const base = { weapon: w, sharpness: 'white', effects: raw.skillEffects, motions: raw.motions, combo: COMBOS.combos[0],
    target: { hitzone: L.DEFAULT_HITZONE, wound: null } };
  const withSkill = comboExpected({ ...base, skills: [{ skillId: skillId('挑戦者'), level: 5 }], uptimes: z0 }).total;
  const none = comboExpected({ ...base, skills: [], uptimes: z0 }).total;
  close(withSkill, none);
  const kept = comboExpected({ ...base, skills: [{ skillId: skillId('挑戦者'), level: 5 }], uptimes: {} }).total;
  assert.ok(kept > none, '火力タブの値 (仮 50%) のままなら効く');
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
  assert.deepEqual(inp.budget, { ms: 6000, activeMs: 6000 });
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

test('Job: おすすめ (recommend.js) があれば plan の Job にし、無い・壊れていれば段階 2 で探す', () => {
  const ark = monsterByName('アルシュベルド');
  const target = { ...emptyTarget(), monsterId: ark.id, partKey: 'head' };
  const build = { ...emptyBuild(), weapon: FIRE_WEAPON.id };
  const seen = {};
  const recommend = {
    buildPlan: (p) => { seen.plan = p; return { requirements: [{ key: 'r1', label: '耳栓 Lv2', on: true }], notes: [], subjects: [] }; },
    planToJob: (plan, o) => { seen.opts = o; return { runs: [{ label: 'a', input: { weapons: [1], targets: [], K: 10 } }, { label: 'b', input: { weapons: [1], targets: [], K: 10 } }], merge: { mode: 'single' }, K: 10 }; },
  };
  const f = F.buildJob(ctxOf({ build, target, recommend, localCharms: [{ id: 'cl1', skills: [] }] }));
  assert.equal(f.job.kind, 'plan');
  assert.equal(f.job.runs.length, 2);
  assert.equal(f.job.runs[0].input.weapons[0], 1, 'planToJob の入力が優先');
  assert.deepEqual(f.job.runs[0].input.budget, { ms: 6000, activeMs: 6000 });
  assert.equal(f.job.runs[0].input.charms.extra.length, 1, '端末の護石は足す');
  assert.equal(f.job.runs[0].input.current, build);
  assert.equal(seen.plan.search.preset, 'balance');
  assert.equal(seen.opts.placeholders, 'zero');
  assert.equal(f.plan.requirements[0].key, 'r1');

  // 置き場の buildPlan (null) → 段階 2
  assert.equal(F.buildJob(ctxOf({ build, target, recommend: { buildPlan: () => null } })).job.kind, 'search');
  // 相手に合わせない → 段階 2
  assert.equal(F.buildJob(ctxOf({ build, target, recommend, search: { ...defaultSearch(), useTarget: false } })).job.kind, 'search');
  // 壊れた buildPlan → 段階 2 と注意
  const broken = F.buildJob(ctxOf({ build, target, recommend: { buildPlan: () => { throw new Error('x'); }, planToJob: () => null } }));
  assert.equal(broken.job.kind, 'search');
  assert.ok(broken.notes.some((n) => n.code === 'plan-error'));
});

// ---------------------------------------------------------------- 必須スキルの行

test('必須スキル: 行と、足す一覧 (シリーズ/グループは準備中で選べない)', () => {
  const rows = F.requiredRows([{ skillId: skillId('耐震'), level: 2 }, { skillId: 99999, level: 1 }], idx);
  assert.equal(rows[0].name, '耐震');
  assert.equal(rows[0].maxLevel, idx.skills.get(skillId('耐震')).maxLevel);
  assert.equal(rows[1].missing, true);
  const items = F.requiredPickerItems(raw.skills.skills, [{ skillId: skillId('耐震'), level: 2 }]);
  assert.equal(items.length, raw.skills.skills.length);
  assert.ok(items.filter((i) => i.disabled).every((i) => /準備中/.test(i.group)));
  assert.equal(items.filter((i) => i.disabled).length, raw.skills.skills.filter((s) => s.kind === 'set' || s.kind === 'group').length);
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

test('画面のスレッドで回す探索 (createModelEngine): 本体が「準備中」ならエラー、作り物の本体なら同じ形で返す', async () => {
  const f = jobFor();
  // 本物の search.js (いまは置き場で「準備中」の例外)
  const real = [];
  const e1 = C.createModelEngine((m) => real.push(m), { getData: () => C.searchData(core) });
  await e1.handle({ type: 'start', id: 'a', job: f.job });
  assert.equal(real.at(-1).type, 'error');
  assert.match(real.at(-1).message, /準備中/);
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
  // plan の Job は recommend.js の createPlanRunner が無ければエラー
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
