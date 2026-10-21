// 相手に合わせたおすすめ (app/model/recommend.js) のテスト。docs/RECOMMEND_DESIGN.md 6.2 節。
// 実行: node --test tests/*.test.mjs  (Node 24 では tests/ とディレクトリで渡すと落ちる)
// 数字と脅威はこのリポのデータ (MHWS-in-json / Monster Hunter Wiki / MHDB) から作った値。Game8・Kiranico の値は入れていない
// (歴戦王の対策ページとの照合は docs/RECOMMEND_DESIGN.md 2.9 節の表のとおりリポの外で行う)。
// 探索 (createSearch・optimizeWeaponSide) はまだ本物が無いので、ここで作り物 (小さい問題を総当たりで解くもの・段を進めるだけのもの) を渡す。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { computeBuild, indexEquipData, ARMOR_PARTS } from '../app/model/build.js';
import { comboExpected } from '../app/model/damage.js';
import { autoSharpness, damageWeapon, resolveWeaponRef } from '../app/model/weapon.js';
import * as H from '../app/model/hunt.js';
import * as TM from '../app/ui/tabs/target_mix.js';
import * as L from '../app/ui/tabs/equip_logic.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// RECOMMEND_MODULE で別の recommend.js (変異を入れたコピー) を検査できる
const R = await import(process.env.RECOMMEND_MODULE
  ? pathToFileURL(process.env.RECOMMEND_MODULE).href : '../app/model/recommend.js');
const load = (name) => JSON.parse(readFileSync(join(ROOT, 'data', name), 'utf8'));

const monstersDoc = load('monsters.json');
const questsDoc = load('quests.json');
const threatsDoc = load('monster_threats.json');
const effects = load('skill_effects.json');
const motions = load('motions_sns.json');
const combos = load('combos_sns.json');
const armorDoc = load('armor.json');
const weaponsDoc = load('weapons_sns.json');
const charmsFixedDoc = load('charms_fixed.json');
const decorationsDoc = load('decorations.json');
const skillsDoc = load('skills.json');

// data.js の target データと同じ形
function targetDataOf(quests = questsDoc.quests) {
  return {
    monsters: monstersDoc, quests: { ...questsDoc, quests }, threats: threatsDoc,
    lists: { monsters: monstersDoc.monsters, quests, threats: threatsDoc.monsters },
    index: {
      monsters: new Map(monstersDoc.monsters.map((m) => [m.id, m])),
      quests: new Map(quests.map((q) => [q.id, q])),
    },
  };
}
const td = targetDataOf();
const index = indexEquipData({
  skills: skillsDoc, decorations: decorationsDoc, bonuses: load('bonuses.json'), armor: armorDoc,
  weapons: weaponsDoc, myWeapons: load('my_weapons.json'), charms: load('charms.json'), charmsFixed: charmsFixedDoc,
});
const core = { index, skillEffects: effects, motions, combos };
const data = { index, effects, motions };

const REY_DAU = 3;
const ARKVELD = 20;
const UTH_DUNA = 25;
const JIN_DAHAAD = 26;
const NU_UDRA = 27;
const AT = 'arch-tempered';
const AT_IDS = [REY_DAU, UTH_DUNA, NU_UDRA, JIN_DAHAAD, ARKVELD];
const skillId = (name) => skillsDoc.skills.find((s) => s.name === name).id;
const EARPLUGS = skillId('耳栓');
const WINDPROOF = skillId('風圧耐性');
const BIND_RES = skillId('拘束耐性');
const ADAPT = skillId('環境適応');
const BLIGHT_RES = skillId('属性やられ耐性');
const RESIST_ID = { fire: skillId('火耐性'), water: skillId('水耐性'), thunder: skillId('雷耐性'), ice: skillId('氷耐性'), dragon: skillId('龍耐性') };

function searchOf(patch = {}) {
  return {
    useTarget: true, preset: 'balance', toggles: {}, levels: {}, required: [], weaponMode: 'auto', twoWeapons: 'auto',
    partsPolicy: 'asSelected', charms: { owned: true, local: true, fixed: true }, limitBreak: 'build',
    archTemperedHunted: {}, armorExclude: [], placeholders: 'zero', ...patch,
  };
}
function targetOf(monsterId, kind = null, patch = {}) {
  return {
    mode: 'monster', monsterId, partKey: null, isWound: false, questId: H.defaultQuestId(td, monsterId, kind),
    individual: kind, questTargetIndex: 0, players: 1, useUncertainWound: false, ...patch,
  };
}
const emptyArmor = () => Object.fromEntries(ARMOR_PARTS.map((p) => [p, null]));
const FIRE_SNS = weaponsDoc.weapons.find((w) => w.element && w.element.type === 'fire').id;
const currentOf = (weapon = FIRE_SNS, patch = {}) => ({
  build: { weapon, armor: emptyArmor(), charm: null, decorations: {}, limitBreak: {}, ...patch },
  combo: null, uptimes: {}, sharpness: null,
});
function planOf(monsterId, kind, { search = {}, target = {}, current = currentOf(), tabTarget = {}, targetData = td } = {}) {
  return R.buildPlan({
    target: targetOf(monsterId, kind, target), tabTarget, search: searchOf(search), targetData, core, current,
  });
}
const reqByKey = (plan, key) => plan.requirements.find((r) => r.key === key);

// ---------------------------------------------------------------- 脅威 → 要件

test('咆哮【小】→ 耳栓 Lv2、咆哮【大】→ 耳栓 Lv3 (軽減の Lv を選べる)', () => {
  const rey = planOf(REY_DAU, null, { search: { preset: 'safe' } });
  const ear = reqByKey(rey, `skill:${EARPLUGS}`);
  assert.equal(ear.level, 2);
  assert.deepEqual(ear.levelChoices, [1, 2]);
  assert.deepEqual(ear.options, [[{ skillId: EARPLUGS, level: 2 }]]);
  assert.equal(ear.unconfirmed, false, '通常の個体の咆哮は未確認ではない');
  assert.equal(ear.provisional, false);
  const jin = planOf(JIN_DAHAAD, null, { search: { preset: 'safe' } });
  const ear3 = reqByKey(jin, `skill:${EARPLUGS}`);
  assert.equal(ear3.level, 3);
  assert.deepEqual(ear3.levelChoices, [2, 3]);
  // 軽減の Lv を選ぶ (levels) と Lv が下がり mitigated。選べない Lv は無視
  const jinL = planOf(JIN_DAHAAD, null, { search: { preset: 'safe', levels: { [`skill:${EARPLUGS}`]: 2 } } });
  assert.equal(reqByKey(jinL, `skill:${EARPLUGS}`).level, 2);
  assert.equal(reqByKey(jinL, `skill:${EARPLUGS}`).mitigated, true);
  const jinBad = planOf(JIN_DAHAAD, null, { search: { preset: 'safe', levels: { [`skill:${EARPLUGS}`]: 1 } } });
  assert.equal(reqByKey(jinBad, `skill:${EARPLUGS}`).level, 3, '咆哮【大】は Lv1 では軽くもならない');
});

test('ヌ・エグドラの歴戦王: 環境適応 Lv2 がバランスでオン (確度 high なので仮でも未確認でもない)', () => {
  const plan = planOf(NU_UDRA, AT);
  const r = reqByKey(plan, `skill:${ADAPT}`);
  assert.ok(r, '環境適応の行が無い');
  assert.equal(r.level, 2);
  assert.equal(r.tier, 'on');
  assert.equal(r.on, true);
  assert.equal(r.category, 'hazard');
  assert.equal(r.provisional, false);
  assert.equal(r.unconfirmed, false);
  // 火属性やられ (確定) もバランスでオン。歴戦王は「通常と同じ」と見ているので未確認・仮
  const b = reqByKey(plan, 'blight');
  assert.deepEqual(b.elements, ['fire']);
  assert.equal(b.on, true);
  assert.equal(b.unconfirmed, true);
  assert.deepEqual(b.options, [[{ skillId: BLIGHT_RES, level: 3 }], [{ skillId: RESIST_ID.fire, level: 3 }]]);
  // 咆哮は参考 (オフ)
  assert.equal(reqByKey(plan, `skill:${EARPLUGS}`).on, false);
  assert.equal(plan.notes.length, 0);
});

test('ジン・ダハドの歴戦王: 拘束耐性 Lv3 が 1 行 (理由 2 つ)・ノヴァは注意だけ・氷属性やられは参考で未確認', () => {
  for (const preset of ['power', 'balance', 'safe']) {
    const plan = planOf(JIN_DAHAAD, AT, { search: { preset } });
    const bind = plan.requirements.filter((r) => r.kind === 'skill' && r.skillId === BIND_RES);
    assert.equal(bind.length, 1, `${preset}: 拘束耐性の行が 1 つでない`);
    assert.equal(bind[0].level, 3);
    assert.deepEqual(bind[0].why.map((w) => w.type).sort(), ['hazard', 'status']);
    assert.equal(bind[0].on, preset !== 'power', `${preset}: 拘束耐性のオン/オフ`);
    assert.equal(bind[0].unconfirmed, true, 'つむじ風は確度 medium・凍結は「通常と同じ」と見ている');
    const nova = plan.notes.filter((n) => n.oneShot);
    assert.equal(nova.length, 1);
    assert.match(nova[0].text, /ノヴァ/);
    assert.ok(!plan.requirements.some((r) => r.why.some((w) => /ノヴァ/.test(w.text))), 'ノヴァが要件に入った');
    const ice = reqByKey(plan, 'blight-uncertain');
    assert.deepEqual(ice.elements, ['ice']);
    assert.equal(ice.on, false, `${preset}: 未確認の属性やられは参考`);
    assert.equal(ice.unconfirmed, true);
    assert.equal(reqByKey(plan, 'blight'), undefined);
  }
});

test('多頭: 同じスキルの要るものは 1 行にまとめ、Lv は大きい方・理由は全部の相手 (3.4 節)', () => {
  const subjects = [
    { key: 'r', monsterId: REY_DAU, kind: null, name: 'レ・ダウ' },
    { key: 'j', monsterId: JIN_DAHAAD, kind: null, name: 'ジン・ダハド' },
    { key: 'a', monsterId: ARKVELD, kind: null, name: 'アルシュベルド' },
  ];
  for (const order of [subjects, [...subjects].reverse()]) {
    const rows = R.requirementsFrom(R.collectThreats(threatsDoc, order), { preset: 'safe', effects });
    const ear = rows.filter((r) => r.skillId === EARPLUGS);
    assert.equal(ear.length, 1);
    assert.equal(ear[0].level, 3, '咆哮【大】(ジン・ダハド) の Lv3 にそろえる');
    assert.deepEqual(ear[0].why.map((w) => w.subjectKey).sort(), ['a', 'j', 'r']);
    assert.match(ear[0].reason, /咆哮【大】 \(ジン・ダハド\)/);
    assert.match(ear[0].reason, /咆哮【小】 \(.*レ・ダウ.*\)/);
    // 属性やられは属性が複数でも 1 行 (確定の分。未確認の氷は別の行)。耐性スキルの組は属性ごと
    const b = rows.filter((r) => r.key === 'blight');
    assert.equal(b.length, 1);
    assert.deepEqual([...b[0].elements].sort(), ['dragon', 'thunder']);
    assert.equal(b[0].byResist.length, 2);
    assert.deepEqual(rows.find((r) => r.key === 'blight-uncertain').elements, ['ice']);
  }
});

test('プリセット 3 つの表 (docs/RECOMMEND_DESIGN.md 2.4 節) をそのまま確かめる', () => {
  // 表の行ごとに当てはまる相手を data から探す
  const rows = threatsDoc.monsters;
  const find = (fn) => rows.find(fn).monsterId;
  const cases = [
    { category: 'hazard', monsterId: NU_UDRA, kind: AT, key: `skill:${ADAPT}` },
    { category: 'blight', monsterId: REY_DAU, kind: null, key: 'blight' },
    { category: 'roar', monsterId: REY_DAU, kind: null, key: `skill:${EARPLUGS}` },
    { category: 'wind', monsterId: ARKVELD, kind: null, key: `skill:${WINDPROOF}` },
    { category: 'tremor', monsterId: find((m) => m.tremor && m.tremor !== 'none' && m.roar === 'none'), kind: null, key: `skill:${skillId('耐震')}` },
    { category: 'status', monsterId: find((m) => m.statusEffects.some((s) => s.key === 'poison')), kind: null, key: `skill:${skillId('毒耐性')}` },
    { category: 'uncertain', monsterId: JIN_DAHAAD, kind: null, key: 'blight-uncertain' },
  ];
  const table = {
    power: { hazard: 'ref', blight: 'ref', roar: 'ref', wind: 'ref', tremor: 'ref', status: 'ref', uncertain: 'ref' },
    balance: { hazard: 'on', blight: 'on', roar: 'ref', wind: 'ref', tremor: 'ref', status: 'ref', uncertain: 'ref' },
    safe: { hazard: 'on', blight: 'on', roar: 'on', wind: 'on', tremor: 'on', status: 'on', uncertain: 'ref' },
  };
  assert.deepEqual(JSON.parse(JSON.stringify(R.PRESETS)), table);
  for (const [preset, row] of Object.entries(table)) {
    for (const c of cases) {
      const plan = planOf(c.monsterId, c.kind, { search: { preset } });
      const r = reqByKey(plan, c.key);
      assert.ok(r, `${c.category}: ${c.key} の行が無い (monsterId ${c.monsterId})`);
      assert.equal(r.category, c.category, `${c.key} の種類`);
      assert.equal(r.tier, row[c.category], `${preset} / ${c.category}`);
      assert.equal(r.on, row[c.category] === 'on');
    }
  }
  // 本人のオン/オフ (toggles) はプリセットより優先
  const off = planOf(NU_UDRA, AT, { search: { toggles: { [`skill:${ADAPT}`]: false, [`skill:${EARPLUGS}`]: true } } });
  assert.equal(reqByKey(off, `skill:${ADAPT}`).on, false);
  assert.equal(reqByKey(off, `skill:${ADAPT}`).userSet, true);
  assert.equal(reqByKey(off, `skill:${EARPLUGS}`).on, true);
});

test('歴戦王 5 体のプリセット「安全」の要件 (docs/RECOMMEND_DESIGN.md 2.9 節の「両方にある」+「こちらだけ」)', () => {
  // スキル名 Lv と属性やられの属性 (オンの行だけ)。こちらのデータ (wiki) から出るものだけを書く
  const want = {
    [REY_DAU]: ['耳栓 Lv2', '属性やられ:thunder'],
    [UTH_DUNA]: ['耳栓 Lv2', '属性やられ:water'],
    [NU_UDRA]: ['環境適応 Lv2', '耳栓 Lv2', '属性やられ:fire'],
    [JIN_DAHAAD]: ['拘束耐性 Lv3', '耳栓 Lv3'],
    [ARKVELD]: ['耳栓 Lv2', '属性やられ:dragon', '風圧耐性 Lv1'],
  };
  for (const id of AT_IDS) {
    const plan = planOf(id, AT, { search: { preset: 'safe' } });
    const got = plan.requirements.filter((r) => r.on)
      .map((r) => (r.kind === 'blight' ? `属性やられ:${r.elements.join(',')}` : r.label)).sort();
    assert.deepEqual(got, [...want[id]].sort(), `${plan.subjects[0].name}`);
  }
});

test('属性やられの「または」: オンなら探索が 2 回 (多頭で属性が 4 つでも 2 回)。オフなら 1 回', () => {
  const on = R.planToJob(planOf(NU_UDRA, AT));
  assert.deepEqual(on.runs.map((r) => r.key), ['blight-skill', 'blight-resist']);
  assert.deepEqual(on.runs[0].input.required, [{ skillId: ADAPT, level: 2 }, { skillId: BLIGHT_RES, level: 3 }]);
  assert.deepEqual(on.runs[1].input.required, [{ skillId: ADAPT, level: 2 }, { skillId: RESIST_ID.fire, level: 3 }]);
  assert.deepEqual(on.merge.alternatives, ['blight-skill', 'blight-resist']);
  assert.ok(on.costRun, '守りの火力の差を測る回が無い');
  assert.equal(on.costRun.input.stopAfter, 'partial');
  assert.deepEqual(on.costRun.input.required, []);
  // 『英雄の証』: 雷・水・火・龍の 4 属性でも 2 回。耐性スキルの回は 4 つとも Lv3
  const proof = planOf(REY_DAU, AT, { target: { questId: 'Proof of a Hero' }, search: { twoWeapons: 'off' } });
  const job = R.planToJob(proof);
  assert.equal(job.runs.length, 2);
  const resistReq = job.runs[1].input.required.filter((r) => Object.values(RESIST_ID).includes(r.skillId));
  assert.deepEqual(resistReq.map((r) => r.skillId).sort((a, b) => a - b),
    ['thunder', 'water', 'fire', 'dragon'].map((e) => RESIST_ID[e]).sort((a, b) => a - b));
  assert.ok(resistReq.every((r) => r.level === 3));
  // オフ (火力優先) なら 1 回で、火力の差の回も無い
  const off = R.planToJob(planOf(NU_UDRA, AT, { search: { preset: 'power' } }));
  assert.deepEqual(off.runs.map((r) => r.key), ['main']);
  assert.equal(off.costRun, null);
  // 自分で足した必須は全部の回に入り、同じスキルは Lv の大きい方
  const user = R.planToJob(planOf(NU_UDRA, AT), { userRequired: [{ skillId: ADAPT, level: 1 }, { skillId: EARPLUGS, level: 3 }] });
  for (const run of user.runs) {
    assert.ok(run.input.required.some((r) => r.skillId === ADAPT && r.level === 2));
    assert.ok(run.input.required.some((r) => r.skillId === EARPLUGS && r.level === 3));
  }
  assert.deepEqual(user.costRun.input.required, [{ skillId: ADAPT, level: 1 }, { skillId: EARPLUGS, level: 3 }]);
});

test('耐性スキルの値 (rules.resistSkills) は 5 属性で Lv1 +6・Lv2 +12・Lv3 +20 (MHDB の説明文と一致)', () => {
  const rs = effects.rules.resistSkills;
  assert.equal(Object.keys(rs).length, 5);
  for (const [e, id] of Object.entries(RESIST_ID)) {
    const def = rs[String(id)];
    assert.equal(def.element, e);
    assert.deepEqual(def.levels, { 1: 6, 2: 12, 3: 20 });
    const sk = skillsDoc.skills.find((s) => s.id === id);
    const fromText = sk.levels.map((l) => Number(l.description.normalize('NFKC').match(/耐性\+(\d+)/)[1]));
    assert.deepEqual(fromText, [6, 12, 20], `${sk.name} の説明文`);
  }
});

// ---------------------------------------------------------------- 守りのチェック・耐性の合計

const REY_GAMMA = [328, 329, 330, 331, 332];
const armorById = (id) => armorDoc.armor.find((a) => a.id === id);

test('resistTotals: 防具 5 部位の resist + 耐性スキルの手計算と一致。レダゼルトγ 5 部位で雷 20 → スキルなしでも雷属性やられ ✓', () => {
  const armor = Object.fromEntries(REY_GAMMA.map((id) => [armorById(id).part, id]));
  const build = { weapon: FIRE_SNS, armor, charm: null, decorations: {}, limitBreak: {} };
  const hand = { fire: 0, water: 0, thunder: 0, ice: 0, dragon: 0 };
  for (const id of REY_GAMMA) for (const e of Object.keys(hand)) hand[e] += armorById(id).resist[e];
  const got = R.resistTotals(build, index, effects);
  assert.deepEqual(got, hand);
  assert.equal(got.thunder, 20);
  const plan = planOf(REY_DAU, AT);
  const check = R.defenseCheck(build, plan.requirements, index, effects);
  const row = check.rows.find((x) => x.key === 'blight');
  assert.equal(row.status, 'ok');
  assert.equal(row.via, 'resist');
  assert.equal(row.have, 0, '属性やられ耐性は付いていない');
  // 防具を 1 部位外すと雷 16 → あと 4 足りない
  const four = { ...build, armor: { ...armor, legs: null } };
  const row4 = R.defenseCheck(four, plan.requirements, index, effects).rows.find((x) => x.key === 'blight');
  assert.equal(row4.status, 'missing');
  assert.deepEqual(row4.elements, [{ element: 'thunder', total: 16, ok: false, short: 4 }]);
  assert.match(row4.text, /あと 4/);
  // 雷耐性の珠を入れると +6 (Lv1) → 22
  const deco = decorationsDoc.decorations.find((d) => d.kind === 'armor' && d.skills.length === 1
    && d.skills[0].skillId === RESIST_ID.thunder && d.skills[0].level === 1);
  const slotPart = REY_GAMMA.map(armorById).find((a) => a.part !== 'legs' && a.slots[0] >= deco.slot);
  const withDeco = { ...four, decorations: { [slotPart.part]: [deco.id] } };
  const cb = computeBuild(withDeco, index);
  assert.equal(cb.errors.length, 0);
  assert.equal(R.resistTotals(withDeco, index, effects).thunder, 22);
  assert.equal(R.defenseCheck(withDeco, plan.requirements, index, effects).rows.find((x) => x.key === 'blight').status, 'ok');
});

test('defenseCheck: スキルの行は ok / mitigated / missing、属性やられ耐性 Lv3 なら耐性の値に関係なく ok', () => {
  const plan = planOf(JIN_DAHAAD, null, { search: { preset: 'safe' } });
  const ear = reqByKey(plan, `skill:${EARPLUGS}`);
  const deco = (sid, lv) => decorationsDoc.decorations.find((d) => d.kind === 'armor' && d.skills.length === 1
    && d.skills[0].skillId === sid && d.skills[0].level === lv);
  // 耳栓の珠を入れられる防具を探して、Lv2 (軽減) と Lv3 (無効) を作る
  const earDeco = deco(EARPLUGS, 1);
  const holder = armorDoc.armor.filter((a) => a.slots.filter((s) => s >= earDeco.slot).length >= 3).slice(0, 1)[0];
  const b = (n) => ({ weapon: FIRE_SNS, armor: { ...emptyArmor(), [holder.part]: holder.id }, charm: null,
    decorations: { [holder.part]: Array(n).fill(earDeco.id) }, limitBreak: {} });
  const own = computeBuild(b(0), index).skillLevels[EARPLUGS] || 0;
  const status = (n) => R.defenseCheck(b(n), [ear], index, effects).rows[0];
  for (let n = 0; n <= 3; n++) {
    const lv = Math.min(3, own + n);
    const want = lv >= 3 ? 'ok' : lv >= 2 ? 'mitigated' : 'missing';
    assert.equal(status(n).status, want, `耳栓 Lv${lv}`);
    assert.equal(status(n).meets, lv >= 3);
  }
  // 属性やられ耐性 Lv3 (珠は無いので、スキルの付いた防具を部位ごとに足していく)
  const nu = planOf(NU_UDRA, AT);
  const armor = emptyArmor();
  let lv = 0;
  for (const a of armorDoc.armor) {
    const s = a.skills.find((x) => x.skillId === BLIGHT_RES);
    if (!s || armor[a.part] != null || lv >= 3) continue;
    armor[a.part] = a.id;
    lv += s.level;
  }
  assert.ok(lv >= 3, '属性やられ耐性 Lv3 の防具の組が作れない');
  const bb = { weapon: FIRE_SNS, armor, charm: null, decorations: {}, limitBreak: {} };
  assert.ok(computeBuild(bb, index).skillLevels[BLIGHT_RES] >= 3);
  const row = R.defenseCheck(bb, nu.requirements, index, effects).rows.find((x) => x.key === 'blight');
  assert.equal(row.status, 'ok');
  assert.equal(row.via, 'skill');
  // Lv1 だけなら軽減 (mitigated)
  const one = Object.entries(armor).find(([, id]) => id != null && armorById(id).skills.some((x) => x.skillId === BLIGHT_RES && x.level === 1));
  if (one) {
    const b1 = { weapon: FIRE_SNS, armor: { ...emptyArmor(), [one[0]]: one[1] }, charm: null, decorations: {}, limitBreak: {} };
    assert.equal(R.defenseCheck(b1, nu.requirements, index, effects).rows.find((x) => x.key === 'blight').status, 'mitigated');
  }
});

// ---------------------------------------------------------------- γ 防具・歴戦王の傷口・部位

test('gammaExclusions: 倒していない歴戦王の γ 防具 5 個と固定護石が外れる。ヌシの魂の注意が出る', () => {
  const none = R.gammaExclusions(td, {});
  assert.deepEqual(none.armor, []);
  assert.equal(none.labels.length, 5);
  assert.ok(none.labels.every((l) => l.hunted));
  const one = R.gammaExclusions(td, { [NU_UDRA]: false });
  assert.deepEqual(one.armor, [648, 649, 650, 651, 652]);
  assert.deepEqual(one.charmsFixed, [178, 179]);
  assert.match(one.notes[0].message, /ヌ・エグドラ（歴戦王）/);
  assert.match(one.notes[0].message, /ヌシの魂 は残りの γ 防具だけで数えます/);
  const all = R.gammaExclusions(td, Object.fromEntries(AT_IDS.map((id) => [String(id), false])));
  assert.equal(all.armor.length, 25);
  assert.equal(all.charmsFixed.length, 10);
  assert.match(all.notes[0].message, /ヌシの魂 は使えません/);
  // Plan → Job: armorExclude と護石の fixedExclude に入る
  const job = R.planToJob(planOf(NU_UDRA, AT, { search: { archTemperedHunted: { 27: false }, armorExclude: [1] } }));
  assert.deepEqual(job.runs[0].input.armorExclude, [1, 648, 649, 650, 651, 652]);
  assert.deepEqual(job.runs[0].input.charms.fixedExclude, [178, 179]);
  // 結果の印に使う γ の一覧
  const g = R.gammaIndex(td);
  assert.equal(Object.keys(g.armor).length, 25);
  assert.equal(g.armor[648].name, 'ヌ・エグドラ（歴戦王）');
});

test('歴戦王の傷口: ウズ・トゥナの歴戦王の Plan の targets の傷口が置き換え後。アルシュベルドは既定で通常、useUncertain で置き換え', () => {
  const uth = H.monsterById(td, UTH_DUNA);
  const head = uth.parts.find((p) => p.key === 'head');
  const plan = planOf(UTH_DUNA, AT, { target: { partKey: 'head' } });
  const t = plan.subjects[0].targets;
  assert.equal(t.length, 1);
  assert.equal(t[0].partKey, 'head');
  assert.equal(t[0].target.wound.shot, 70);
  assert.equal(t[0].target.wound.thunder, 20);
  assert.equal(head.wound.shot, 88, '通常の傷口は 88 のまま');
  assert.equal(t[0].woundMark, 'unverified');
  const normal = planOf(UTH_DUNA, null, { target: { partKey: 'head' } });
  assert.equal(normal.subjects[0].targets[0].target.wound.shot, 88);
  // Job の targets にも置き換え後の傷口が入る
  assert.equal(R.planToJob(plan).runs[0].input.targets[0].target.wound.shot, 70);
  // アルシュベルドの歴戦王 (sameAsBase: null)
  const ark = H.monsterById(td, ARKVELD);
  const part = ark.parts.find((p) => p.wound && ark.individuals.find((i) => i.kind === AT).hitzone.woundOverrides[p.key]);
  const ov = ark.individuals.find((i) => i.kind === AT).hitzone.woundOverrides[part.key];
  const base = planOf(ARKVELD, AT, { target: { partKey: part.key } }).subjects[0].targets[0];
  assert.deepEqual(base.target.wound, part.wound);
  assert.equal(base.woundMark, 'uncertain');
  const use = planOf(ARKVELD, AT, { target: { partKey: part.key, useUncertainWound: true } }).subjects[0].targets[0];
  assert.deepEqual(use.target.wound, ov);
});

test('partsTargets: weak1 = target_mix の defaultPartKey、main3 = 切断 45 以上の上位 3 か所を等分、asSelected は相手タブの割合', () => {
  for (const m of monstersDoc.monsters) {
    const w = R.partsTargets(m, null, 'weak1', {}, false);
    assert.equal(w.length, 1);
    assert.equal(w[0].partKey, TM.defaultPartKey(m), m.name);
    const m3 = R.partsTargets(m, null, 'main3', {}, false);
    const main = TM.visibleParts(m, { sort: 'slash' }).filter((p) => p.hitzone.slash >= 45).slice(0, 3);
    if (main.length) {
      assert.deepEqual(m3.map((x) => x.partKey), main.map((p) => p.key), m.name);
      assert.ok(m3.every((x) => Math.abs(x.weight - 1 / main.length) < 1e-12));
    } else assert.deepEqual(m3.map((x) => x.partKey), [TM.defaultPartKey(m)]);
  }
  const rey = H.monsterById(td, REY_DAU);
  const [a, b] = rey.parts.filter((p) => !p.unknownPart).slice(0, 2);
  const memo = { [REY_DAU]: { partKey: a.key, mix: { on: true, monsterId: REY_DAU, weights: { [a.key]: 0.6, [b.key]: 0.2 } } } };
  const mixed = R.partsTargets(rey, null, 'asSelected', memo, true);
  assert.deepEqual(mixed.map((x) => [x.partKey, Math.round(x.weight * 100) / 100]), [[a.key, 0.75], [b.key, 0.25]]);
  assert.ok(mixed.every((x) => x.target.isWound === true));
  // 割合がオフなら選んだ部位 1 つ
  const one = R.partsTargets(rey, null, 'asSelected', { [REY_DAU]: { partKey: b.key, mix: null } }, false);
  assert.deepEqual(one.map((x) => x.partKey), [b.key]);
  // 部位の名前は target_mix の partLabel と同じ (部位不明は番号)
  for (const m of monstersDoc.monsters.slice(0, 10)) {
    for (const p of m.parts) {
      const got = R.partsTargets(m, null, 'asSelected', { [m.id]: { partKey: p.key } }, false)[0];
      assert.equal(got.label, TM.partLabel(p, m));
    }
  }
});

test('elementView は target_mix.js の recommendationView と同じ (全モンスター × 武器の属性)', () => {
  for (const m of monstersDoc.monsters) {
    for (const e of [null, 'fire', 'water', 'thunder', 'ice', 'dragon']) {
      assert.deepEqual(R.elementView(m.elementRecommendation, e), TM.recommendationView(m.elementRecommendation, e), `${m.name} ${e}`);
    }
  }
});

// ---------------------------------------------------------------- 武器の属性

test('elementPlan: いまの武器と同じ/近い → いまの武器、はっきり違う → おすすめの属性の片手剣 + いまの武器、効きにくい → いまの武器', () => {
  const nu = planOf(NU_UDRA, AT); // 水がはっきり、いまの武器は火
  assert.equal(nu.element.mode, 'element');
  assert.deepEqual(nu.element.types, ['water']);
  const waterIds = weaponsDoc.weapons.filter((w) => w.element && w.element.type === 'water').map((w) => w.id);
  assert.deepEqual([...nu.element.weapons].sort((a, b) => a - b), [...waterIds, FIRE_SNS].sort((a, b) => a - b));
  const WATER_SNS = waterIds[0];
  const same = planOf(NU_UDRA, AT, { current: currentOf(WATER_SNS) });
  assert.equal(same.element.mode, 'current');
  assert.deepEqual(same.element.weapons, [WATER_SNS]);
  const ark = planOf(ARKVELD, AT); // どれも効きにくい
  assert.equal(ark.subjects[0].element.view.kind, 'weak');
  assert.equal(ark.element.mode, 'current');
  const noWeapon = planOf(ARKVELD, AT, { current: currentOf(null) });
  assert.equal(noWeapon.element.weapons, 'sns-all');
  // 本人が選び直す
  assert.equal(planOf(NU_UDRA, AT, { search: { weaponMode: 'all' } }).element.weapons, 'sns-all');
  assert.deepEqual(planOf(NU_UDRA, AT, { search: { weaponMode: 'current' } }).element.weapons, [FIRE_SNS]);
  // 段階 2 (相手のおすすめを使わない): いまの武器・守りの要件なし
  const s2 = planOf(NU_UDRA, AT, { search: { useTarget: false } });
  assert.deepEqual(s2.element.weapons, [FIRE_SNS]);
  assert.deepEqual(s2.requirements, []);
  assert.equal(R.planToJob(s2).runs.length, 1);
  // この端末の所持アーティア (要素で渡す): weapons には id で入る。索引に入っているものは重ねない
  const artian = { id: 'w-local', name: '端末のアーティア', baseWeaponId: FIRE_SNS, attack: 170, affinity: 0, element: { type: 'water', value: 400 } };
  const ep = R.elementPlan([{ key: 'a', rec: nu.subjects[0].element.rec }], { build: { weapon: FIRE_SNS }, extraWeapons: [artian, artian] }, index);
  assert.ok(ep.weapons.includes('w-local'));
  assert.ok(ep.weapons.every((w) => typeof w !== 'object'), '要素ではなく id');
  assert.equal(ep.weapons.filter((w) => w === 'w-local').length, 1);
});

test('多頭『英雄の証』: 4 体・時間の比の重み・武器 2 本の案 (時間の割合の大きい 2 つの属性)', () => {
  const plan = planOf(REY_DAU, AT, { target: { questId: 'Proof of a Hero' } });
  assert.equal(plan.mode, 'multi');
  assert.deepEqual(plan.subjects.map((s) => [s.monsterId, s.healthForT.mid]),
    [[REY_DAU, 32850], [UTH_DUNA, 46574], [NU_UDRA, 40242], [ARKVELD, 71701]]);
  assert.deepEqual(plan.element.types.sort(), ['ice', 'thunder', 'water']);
  assert.equal(plan.element.twoWeapons.suggested, true);
  // 時間 (H / D_ref) の大きい 2 つの属性
  const timeByType = {};
  plan.subjects.forEach((s, i) => {
    const v = plan.element.perSubject[i].view;
    if (v.kind === 'clear') timeByType[v.best[0]] = (timeByType[v.best[0]] || 0) + plan.weights[i].time;
  });
  const top2 = Object.entries(timeByType).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([e]) => e);
  assert.deepEqual(plan.element.twoWeapons.groups.map((g) => g.element), top2);
  const job = R.planToJob(plan);
  assert.equal(job.merge.mode, 'twoWeapons');
  // 相手 × 部位の行の重みは w_i × 部位の割合 (group = 相手の key)
  const t = job.runs[0].input.targets;
  assert.equal(t.length, 4);
  plan.weights.forEach((w, i) => {
    assert.equal(t[i].group, w.key);
    assert.ok(Math.abs(t[i].weight - w.weight) < 1e-12);
  });
  // 武器 2 本をオフ
  assert.equal(R.planToJob(planOf(REY_DAU, AT, { target: { questId: 'Proof of a Hero' }, search: { twoWeapons: 'off' } })).merge.mode, 'multi');
  // 体力・回数・いまの装備の T
  assert.ok(plan.current.T > 0);
  assert.equal(plan.current.value, null);
});

// ---------------------------------------------------------------- 多頭の重み

test('multiWeights: H_i / D_ref_i² に比例。体力不明の相手は平均で置き、警告が出る。全員不明なら等分', () => {
  const subs = [
    { key: 'a', health: { mid: 30000 } }, { key: 'b', health: { mid: 12000 } }, { key: 'c', health: { mid: 20000 } },
  ];
  const d = { a: 800, b: 500, c: 600 };
  const w = R.multiWeights(subs, d);
  const raw = subs.map((s) => s.health.mid / d[s.key] ** 2);
  const sum = raw.reduce((x, y) => x + y, 0);
  w.forEach((x, i) => assert.ok(Math.abs(x.weight - raw[i] / sum) < 1e-12));
  assert.ok(Math.abs(w.reduce((x, y) => x + y.weight, 0) - 1) < 1e-12);
  // 体力不明 → 分かっている相手の平均
  const u = R.multiWeights([...subs.slice(0, 2), { key: 'c', health: { known: false } }], d);
  assert.equal(u[2].healthAssumed, true);
  assert.equal(u[2].health.mid, 21000);
  assert.match(u[2].reason, /平均/);
  // 全員不明 → 体力は全部 1 (D_ref だけで重み)
  const all = R.multiWeights(subs.map((s) => ({ key: s.key, health: null })), {});
  assert.ok(all.every((x) => Math.abs(x.weight - 1 / 3) < 1e-12));
  // 人数の倍率 (total) は、体力の分かる相手が全員持っているときだけ使う (1 体でも無ければ全員ソロの体力で比べる)
  const tot = (solo, total) => ({ known: true, solo: { mid: solo }, total: { mid: total } });
  assert.deepEqual(R.subjectHealths([{ key: 'a', health: tot(100, 300) }, { key: 'b', health: tot(200, 600) }]).map((h) => [h.health.mid, h.basis]),
    [[300, 'total'], [600, 'total']]);
  assert.deepEqual(R.subjectHealths([{ key: 'a', health: tot(100, 300) }, { key: 'b', health: { mid: 200 } }]).map((h) => [h.health.mid, h.basis]),
    [[100, 'solo'], [200, 'solo']]);
  // Plan: 『英雄の証』の 1 体の体力を消したクエストで、平均で置いた警告
  const quests = questsDoc.quests.map((q) => (q.id !== 'Proof of a Hero' ? q : {
    ...q, mission: { ...q.mission, targets: q.mission.targets.map((t, i) => (i === 1 ? { ...t, healthCalc: null } : t)) },
  }));
  const td2 = targetDataOf(quests);
  const plan = planOf(REY_DAU, AT, { target: { questId: 'Proof of a Hero' }, targetData: td2 });
  assert.equal(plan.subjects[1].healthAssumed, true);
  assert.equal(plan.subjects[1].healthForT.mid, (32850 + 40242 + 71701) / 3);
  assert.ok(plan.warnings.some((x) => x.code === 'health-assumed' && /ウズ・トゥナ/.test(x.message)));
  const job = R.planToJob(plan);
  assert.ok(job.warnings.some((x) => x.code === 'health-assumed'));
  assert.equal(job.subjects[1].healthAssumed, true);
});

test('装備固定のクエストは探さない (体力は出す)。相手を選んでいなければ既定の肉質で探す', () => {
  const plan = planOf(ARKVELD, AT, { target: { questId: 'Event: Unchained Arkveld' } });
  assert.equal(plan.blocked.code, 'fixed-equipment');
  assert.equal(plan.subjects[0].healthForT.mid, 28944);
  const job = R.planToJob(plan);
  assert.deepEqual(job.runs, []);
  assert.equal(job.blocked.code, 'fixed-equipment');
  const runner = R.createPlanRunner(job, data, { createSearch: () => { throw new Error('呼ばれてはいけない'); } });
  assert.equal(runner.step(10), true);
  assert.equal(runner.result().status, 'blocked');
  // 相手を選んでいない: 装備タブ・火力タブと同じ既定の肉質で探す (段階 2。守りの要件なし)。相手のデータが無くてもよい
  for (const targetData of [td, null]) {
    const none = R.buildPlan({ target: { mode: 'monster', monsterId: null, isWound: true }, search: searchOf(), targetData, core, current: currentOf() });
    assert.equal(none.status, 'no-target');
    assert.equal(none.blocked, null);
    assert.deepEqual(none.subjects.map((s) => s.key), ['default']);
    assert.deepEqual(none.subjects[0].targets[0].target, { ...L.DEFAULT_TARGET, isWound: true });
    assert.ok(none.subjects[0].targets[0].label.includes(L.DEFAULT_HITZONE_TEXT));
    assert.ok(none.warnings.some((w) => w.code === 'default-target'));
    assert.deepEqual(none.requirements, []);
    const job = R.planToJob(none);
    assert.equal(job.blocked, null);
    assert.deepEqual(job.runs.map((r) => r.key), ['main']);
    assert.deepEqual(job.runs[0].input.weapons, [FIRE_SNS]);
  }
  // モンスターは選んだがデータの読み込み中: 待つ (既定の肉質では探さない)
  const loading = R.buildPlan({ target: targetOf(NU_UDRA, AT), search: searchOf(), targetData: null, core, current: currentOf() });
  assert.equal(loading.status, 'no-data');
  assert.equal(R.planToJob(loading).blocked.code, 'no-target');
});

test('仮置きの発動率: 既定は 0% で探す (本人が入れた値はそのまま)。keep なら火力タブの値のまま', () => {
  const groups = effects.rules.conditionGroups.filter((g) => g.placeholder);
  const zero = R.searchUptimes(effects, { enraged: 0.7 }, 'zero');
  assert.equal(zero.uptimes.enraged, 0.7);
  assert.equal(zero.placeholders.length, groups.length - 1);
  for (const p of zero.placeholders) {
    const g = groups.find((x) => x.id === p.id);
    assert.deepEqual(zero.uptimes[p.id], g.type === 'categorical' ? {} : 0);
  }
  const keep = R.searchUptimes(effects, { enraged: 0.7 }, 'keep');
  assert.deepEqual(keep.uptimes, { enraged: 0.7 });
  assert.ok(keep.placeholders.every((p) => !p.zeroed));
  // 平らなキー ("chain.hit5plus") で入れた条件も本人の値として残す
  assert.equal(R.searchUptimes(effects, { 'chain.hit5plus': 0.3 }, 'zero').uptimes.chain, undefined);
  // planToJob で選び直せる
  const plan = planOf(NU_UDRA, AT);
  assert.equal(R.planToJob(plan).runs[0].input.uptimes.enraged, 0);
  assert.equal(R.planToJob(plan, { placeholders: 'keep' }).runs[0].input.uptimes.enraged, undefined);
});

// ---------------------------------------------------------------- 並べ直し

test('rerankMulti: T = Σ H_i / D_i の小さい順。武器 2 本は相手ごとに良い方', () => {
  const subjects = [{ key: 'a', name: 'A', health: { mid: 1000 } }, { key: 'b', name: 'B', health: { mid: 3000 } }];
  const res = [
    { rank: 1, value: 300, perGroup: { a: 400, b: 100 } }, // T = 2.5 + 30 = 32.5
    { rank: 2, value: 290, perGroup: { a: 100, b: 300 } }, // T = 10 + 10 = 20
    { rank: 3, value: 200, perGroup: { a: 200, b: 200 } }, // T = 5 + 15 = 20 (同じ T は元の順)
  ];
  const out = R.rerankMulti(res, subjects);
  assert.deepEqual(out.map((r) => r.value), [290, 200, 300]);
  assert.deepEqual(out.map((r) => r.rank), [1, 2, 3]);
  assert.equal(out[0].score.kind, 'combos');
  assert.equal(out[0].score.value, 20);
  assert.deepEqual(out[0].perSubject.map((p) => p.combos), [10, 10]);
  assert.equal(out[0].combosTotal, 20);
  const two = R.rerankMulti([{ value: 1, perGroup: { a: 400, b: 100 }, perGroup2: { a: 100, b: 300 } }], subjects, { twoWeapons: true });
  assert.equal(two[0].score.value, 1000 / 400 + 3000 / 300);
  assert.deepEqual(two[0].perSubject.map((p) => p.weapon), [1, 2]);
  // 相手が 1 体なら期待値の高い順
  const one = R.rerankMulti([{ value: 10 }, { value: 30 }], [{ key: 'a', health: { mid: 100 } }]);
  assert.deepEqual(one.map((r) => r.value), [30, 10]);
  assert.equal(one[0].score.kind, 'damage');
  assert.equal(one[0].perSubject[0].combos, 4);
});

// ---------------------------------------------------------------- createPlanRunner (作り物の探索)

const PHASES = ['prepare', 'beam1', 'beam2', 'polish1', 'dfs', 'polish2', 'done'];

/** 作り物の時計 (探索の 1 段で 10ms 進む。runner の step(ms) の区切りを決まった形で確かめるため) */
const fakeClock = () => {
  const c = { t: 0 };
  c.now = () => c.t;
  return c;
};

/** 段を 1 つずつ進めるだけの作り物の探索 (step 1 回で 1 段・時計を 10ms 進める)。results は input から作る */
function scriptedSearch(make, log, clock = null) {
  return (input, d) => {
    const me = { input, phase: 0, status: null, cancelled: false, extended: 0 };
    log.push(me);
    const partialAt = PHASES.indexOf('polish1');
    const out = () => (typeof make === 'function' ? make(input, me) : make);
    return {
      step() {
        if (clock) clock.t += 10;
        if (me.cancelled) { me.status = 'cancelled'; return true; }
        if (PHASES[me.phase] === 'done') return true;
        me.phase += 1;
        if (input.stopAfter === 'partial' && me.phase > partialAt) me.phase = PHASES.length - 1;
        if (PHASES[me.phase] === 'done') me.status = out().status || 'done';
        return PHASES[me.phase] === 'done';
      },
      progress() {
        return { phase: PHASES[me.phase], elapsedMs: 0, best: [], partialReady: me.phase >= partialAt, stats: {} };
      },
      result() {
        const o = out();
        return { status: me.status || (me.cancelled ? 'cancelled' : 'partial'), results: o.results || [], infeasible: o.infeasible || null, warnings: [], stats: {} };
      },
      cancel() { me.cancelled = true; },
      extend(b) { me.extended += 1; me.lastExtend = b; me.phase = PHASES.indexOf('dfs'); me.status = null; },
    };
  };
}

const simpleBuild = (weapon, head) => ({ weapon, armor: { ...emptyArmor(), head }, charm: null, decorations: {}, limitBreak: {} });

test('createPlanRunner: 回の順・途中の結果・段の進み方・終わり (属性やられの 2 回 + 火力の差の回)', () => {
  const job = R.planToJob(planOf(NU_UDRA, AT), { K: 5 });
  const log = [];
  const clock = fakeClock();
  const runner = R.createPlanRunner(job, data, {
    createSearch: scriptedSearch((input) => ({
      results: [{ rank: 1, value: input.stopAfter ? 900 : (input.required.some((r) => r.skillId === BLIGHT_RES) ? 800 : 810), build: simpleBuild(FIRE_SNS, 648), weapon: FIRE_SNS }],
    }), log, clock),
    now: clock.now,
  });
  const seen = [];
  let partialAt = null;
  let i = 0;
  while (!runner.step(5)) {
    const p = runner.progress();
    seen.push(`${p.run.key}:${p.phase}`);
    if (p.partialReady && partialAt == null) {
      partialAt = i;
      const r = runner.result();
      assert.equal(r.status, 'partial');
      assert.ok(r.results.length >= 1, '途中の結果が空');
    }
    i += 1;
    assert.ok(i < 200, '終わらない');
  }
  assert.ok(partialAt != null, '途中の結果が出なかった');
  assert.equal(log.length, 3, '探索は 2 回 + 火力の差の 1 回');
  assert.deepEqual(log.map((x) => x.input.required.map((r) => r.skillId)), [[ADAPT, BLIGHT_RES], [ADAPT, RESIST_ID.fire], []]);
  // 1 回目が終わるまで 2 回目は始まらない
  const firstRun2 = seen.findIndex((s) => s.startsWith('blight-resist'));
  assert.ok(firstRun2 > seen.lastIndexOf('blight-skill:polish1'));
  assert.ok(seen.includes('cost:cost'), '火力の差の回が progress に出ない');
  assert.ok(seen.indexOf('cost:cost') > seen.lastIndexOf('blight-resist:polish1'), '火力の差の回は最後');
  const r = runner.result();
  assert.equal(r.status, 'done');
  assert.equal(r.results.length, 1, '同じ組は 1 件にまとめる');
  assert.equal(r.results[0].value, 810);
  assert.equal(r.results[0].gamma[0].name, 'ヌ・エグドラ（歴戦王）');
  assert.equal(r.results[0].score.kind, 'damage');
  assert.ok(r.results[0].defense);
  assert.ok(Math.abs(r.costOfDefense.pct - (810 / 900 - 1) * 100) < 1e-9);
  assert.equal(r.stats.runs.length, 3);
  assert.equal(runner.progress().phase, 'done');
});

test('createPlanRunner: 中止 (それまでの上位を返す)・続けて探す (extend)・エラー・満たせない', () => {
  const job = R.planToJob(planOf(NU_UDRA, AT, { search: { preset: 'power' } }), { K: 5 });
  // 中止
  const log = [];
  const clock = fakeClock();
  const res = { results: [{ rank: 1, value: 700, build: simpleBuild(FIRE_SNS, 1), weapon: FIRE_SNS }] };
  const r1 = R.createPlanRunner(job, data, { createSearch: scriptedSearch(res, log, clock), now: clock.now });
  for (let k = 0; k < 3; k++) assert.equal(r1.step(5), false); // polish1 まで (1 回の step で 1 段)
  assert.equal(r1.progress().phase, 'polish1');
  assert.equal(r1.progress().partialReady, true);
  r1.cancel();
  assert.equal(r1.step(1), true);
  const c = r1.result();
  assert.equal(c.status, 'cancelled');
  assert.equal(c.results.length, 1, '途中の上位が消えた');
  assert.equal(log[0].cancelled, true);
  assert.equal(r1.extend({ ms: 100 }), false, '中止したあとは続けない');
  // 続けて探す
  const log2 = [];
  let value = 700;
  const r2 = R.createPlanRunner(job, data, { createSearch: scriptedSearch(() => ({ results: [{ rank: 1, value, build: simpleBuild(FIRE_SNS, 1), weapon: FIRE_SNS }] }), log2) });
  while (!r2.step(5));
  assert.equal(r2.result().results[0].value, 700);
  value = 750;
  assert.equal(r2.extend({ ms: 1000 }), true);
  assert.equal(r2.result().results[0].value, 700, '延長中も前の結果は残る');
  while (!r2.step(5));
  assert.equal(log2[0].extended, 1);
  assert.equal(r2.result().results[0].value, 750);
  assert.equal(r2.result().stats.extended, 1);
  // エラー (探索が作れない)
  const r3 = R.createPlanRunner(job, data, { createSearch: () => { throw new Error('装備を探す機能は準備中です'); } });
  assert.equal(r3.step(5), true);
  assert.equal(r3.result().status, 'error');
  assert.match(r3.result().message, /準備中/);
  const r3b = R.createPlanRunner(job, data, {});
  assert.equal(r3b.step(5), true);
  assert.equal(r3b.result().status, 'error');
  // 満たせない (2 回とも)
  const job2 = R.planToJob(planOf(NU_UDRA, AT), { K: 5, costRun: false });
  const r4 = R.createPlanRunner(job2, data, { createSearch: scriptedSearch({ status: 'infeasible', results: [], infeasible: { missing: [{ skillId: ADAPT }] } }, []) });
  while (!r4.step(5));
  assert.equal(r4.result().status, 'infeasible');
  assert.equal(r4.result().infeasible.length, 2);
  // 耐性スキルの回だけ満たせない → 警告
  const r5 = R.createPlanRunner(job2, data, {
    createSearch: scriptedSearch((input) => (input.required.some((r) => r.skillId === BLIGHT_RES)
      ? { results: [{ rank: 1, value: 600, build: simpleBuild(FIRE_SNS, 1), weapon: FIRE_SNS }] }
      : { status: 'infeasible', results: [] }), []),
  });
  while (!r5.step(5));
  assert.equal(r5.result().status, 'done');
  assert.ok(r5.result().warnings.some((w) => w.code === 'blight-resist-infeasible'));
});

test('createPlanRunner: 武器 2 本の 2 本目は、体力で重みを付けた T が小さくなる武器を選ぶ', () => {
  // 体力の小さい相手 a と大きい相手 b。1 本目 (武器 1) は両方に 50。候補 X (武器 2) は a に強く、Y (武器 3) は b に強い
  // 2 本目: X = 1000/200 + 100000/50 = 2005、Y = 1000/50 + 100000/60 ≒ 1686.7 → Y (体力を見ないと X を選んでしまう)
  // 続けて 1 本目を選び直す: Y と組むなら X = 1000/200 + 100000/60 ≒ 1671.7 が武器 1 (1686.7) より良い → [X, Y]
  const pg = { 1: { a: 50, b: 50 }, 2: { a: 200, b: 10 }, 3: { a: 10, b: 60 } };
  const job = {
    kind: 'plan', K: 5, costRun: null, blocked: null, warnings: [], requirements: [], gamma: null, baseline: null,
    subjects: [{ key: 'a', name: 'A', health: { mid: 1000 } }, { key: 'b', name: 'B', health: { mid: 100000 } }],
    merge: { mode: 'twoWeapons', subjects: ['a', 'b'], groups: [{ element: 'fire', weapons: [2] }, { element: 'water', weapons: [3] }] },
    runs: [{ key: 'main', label: '', input: { weapons: [1, 2, 3], targets: [], required: [] } }],
  };
  const build = (w) => ({ weapon: w, armor: emptyArmor(), charm: null, decorations: {}, limitBreak: {} });
  const seen = [];
  const runner = R.createPlanRunner(job, { index, effects, motions }, {
    createSearch: scriptedSearch({ results: [{ rank: 1, value: 50, weapon: 1, build: build(1), perGroup: pg[1] }] }, []),
    optimizeWeaponSide: (input, fixed, d, { score, N }) => {
      seen.push(input.weapons);
      return input.weapons.map((w) => ({ weapon: w, decorations: { weapon: [] }, perGroup: pg[w], score: score(pg[w]) }))
        .sort((x, y) => y.score - x.score).slice(0, N);
    },
  });
  while (!runner.step(50));
  const r = runner.result();
  assert.equal(r.results[0].twoWeapons, true);
  assert.deepEqual(r.results[0].weapons, [2, 3]);
  assert.ok(Math.abs(r.results[0].score.value - (1000 / 200 + 100000 / 60)) < 1e-9);
  assert.deepEqual(r.results[0].perSubject.map((p) => p.weapon), [1, 2]);
  assert.deepEqual(r.results[0].builds.map((b) => b.weapon), [2, 3]);
  assert.deepEqual(seen, [[1, 2, 3], [1, 2, 3]], '2 本目・1 本目の候補はその回の探索の武器');
  // 武器 1 本 (1 本目だけ) より少ない回数
  assert.ok(r.twoWeaponsGain.combos > 0);
});

test('createPlanRunner: 耐性の値が 20 に届かない組は下に並べる (「あと n 足りない」)', () => {
  const job = R.planToJob(planOf(REY_DAU, AT), { K: 5, costRun: false });
  const four = Object.fromEntries(REY_GAMMA.slice(0, 4).map((id) => [armorById(id).part, id]));
  const five = Object.fromEntries(REY_GAMMA.map((id) => [armorById(id).part, id]));
  const mk = (armor, value) => ({ rank: 1, value, weapon: FIRE_SNS, build: { weapon: FIRE_SNS, armor: { ...emptyArmor(), ...armor }, charm: null, decorations: {}, limitBreak: {} } });
  const runner = R.createPlanRunner(job, data, {
    createSearch: scriptedSearch((input) => (input.required.some((r) => r.skillId === BLIGHT_RES)
      ? { results: [] } : { results: [mk(four, 990), mk(five, 900)] }), []),
  });
  while (!runner.step(5));
  const r = runner.result();
  assert.deepEqual(r.results.map((x) => x.value), [900, 990]);
  assert.equal(r.results[0].defense.ok, true);
  assert.equal(r.results[1].defense.ok, false);
  assert.match(r.results[1].defense.rows.find((x) => x.key === 'blight').text, /あと 4/);
});

// ---------------------------------------------------------------- 小さい問題: 多頭の重みの近似 (総当たりとの差)

/** 小さな決まった乱数 (mulberry32) */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pickN = (rand, list, n) => {
  const a = [...list];
  const out = [];
  while (out.length < n && a.length) out.push(a.splice(Math.floor(rand() * a.length), 1)[0]);
  return out;
};

// 火力に効くスキル (skill_effects.json にあって計算できるもの)
const OFFENSE = new Set(Object.entries(effects.effects).filter(([, e]) => e.supported !== false).map(([id]) => Number(id)));
const hasOffense = (x) => (x.skills || []).some((s) => OFFENSE.has(s.skillId));

/** 独立の評価 (computeBuild + comboExpected。recommend.js の evaluateBuild は使わない) */
function makeEvaluator(input) {
  const cache = new Map();
  const groups = [...new Set(input.targets.map((t) => t.group))];
  return (build) => {
    const k = JSON.stringify(build);
    if (cache.has(k)) return cache.get(k);
    const cb = computeBuild(build, index);
    const w = resolveWeaponRef(build.weapon, index);
    const sharp = autoSharpness(w, index, cb.skillLevels).color;
    const perGroup = {};
    let value = 0;
    for (const g of groups) {
      const rows = input.targets.filter((t) => t.group === g);
      const sw = rows.reduce((a, t) => a + t.weight, 0);
      let v = 0;
      for (const t of rows) {
        v += t.weight * comboExpected({
          weapon: damageWeapon(w), sharpness: sharp, skills: cb.skillLevels, uptimes: input.uptimes, effects, motions,
          combo: input.combo, monsterStatus: input.monsterStatus, target: t.target,
        }).total;
      }
      perGroup[g] = v / sw;
      value += v;
    }
    const out = { value, perGroup, skillLevels: cb.skillLevels };
    cache.set(k, out);
    return out;
  };
}

// 相手ごとに効き方の違うスキル (属性攻撃強化は武器の属性しだい、弱点特効は柔らかい部位、心眼は硬い部位)。
// 防具をこれで絞ると「どの相手に合わせるか」の取り合いが起きる (重みの近似の差が出やすい)
const TRADE_OFF = new Set(['火属性攻撃強化', '水属性攻撃強化', '雷属性攻撃強化', '氷属性攻撃強化', '龍属性攻撃強化', '弱点特効', '心眼']
  .map((n) => skillsDoc.skills.find((s) => s.name === n)).filter(Boolean).map((s) => s.id));
const hasTradeOff = (x) => (x.skills || []).some((s) => TRADE_OFF.has(s.skillId));

/** 小さい問題 (武器 × 部位ごとの防具 × 護石)。weaponCount = 属性ごとの武器の数、armorCount = 部位ごとの防具の数 */
function smallSpace(seed, weaponCount, armorCount = [2, 2, 2, 3, 3]) {
  const rand = rng(seed);
  const weapons = Object.entries(weaponCount).flatMap(([e, n]) => pickN(rand,
    weaponsDoc.weapons.filter((w) => w.element && w.element.type === e && w.rarity >= 6), n).map((w) => w.id));
  const armor = {};
  ARMOR_PARTS.forEach((p, i) => {
    armor[p] = pickN(rand, armorDoc.armor.filter((a) => a.part === p && a.rarity >= 7 && hasTradeOff(a)), armorCount[i]).map((a) => a.id);
  });
  const charms = pickN(rand, charmsFixedDoc.charms.filter(hasOffense), 2).map((c) => c.id);
  const builds = [];
  const rec = (i, acc) => {
    if (i === ARMOR_PARTS.length) {
      for (const charm of charms) builds.push({ armor: { ...acc }, charm });
      return;
    }
    for (const id of armor[ARMOR_PARTS[i]]) rec(i + 1, { ...acc, [ARMOR_PARTS[i]]: id });
  };
  rec(0, {});
  return { weapons, armor, charms, builds };
}
const fullBuild = (w, b) => ({ weapon: w, armor: b.armor, charm: b.charm, decorations: {}, limitBreak: {} });

/** 総当たりで「重み付きの平均」の上位 K を返す作り物の探索 (ソルバの代わり) */
function bruteSearch(space) {
  return (input) => {
    const ev = makeEvaluator(input);
    let done = false;
    let res = null;
    return {
      step() {
        if (!done) {
          const list = [];
          for (const w of space.weapons) for (const b of space.builds) {
            const build = fullBuild(w, b);
            const e = ev(build);
            // perGroup を返さない (runner が計算し直す道も通す)
            list.push({ value: e.value, build, weapon: w });
          }
          list.sort((a, b) => b.value - a.value);
          res = list.slice(0, input.K).map((r, i) => ({ ...r, rank: i + 1, exact: true }));
          done = true;
        }
        return true;
      },
      progress: () => ({ phase: done ? 'done' : 'prepare', elapsedMs: 0, best: [], partialReady: done, stats: {} }),
      result: () => ({ status: 'done', results: res || [], warnings: [], stats: {} }),
      cancel() {},
      extend() {},
    };
  };
}

/** 武器 2 本の 2 本目を、防具を固定して総当たりで選ぶ作り物 (optimizeWeaponSide の代わり) */
function bruteWeaponSide(space) {
  return (input, fixed, d, { score, N = 1 }) => {
    const ev = makeEvaluator(input);
    const list = (Array.isArray(input.weapons) ? input.weapons : space.weapons).map((w) => {
      const e = ev({ weapon: w, armor: fixed.armor, charm: fixed.charm, decorations: {}, limitBreak: fixed.limitBreak || {} });
      return { weapon: w, decorations: { weapon: [] }, perGroup: e.perGroup, score: score(e.perGroup) };
    });
    list.sort((a, b) => b.score - a.score);
    return list.slice(0, N);
  };
}

// 『英雄の証』の 4 体 (氷・雷・水がはっきり、アルシュベルドはどれも効きにくい) に、属性の違う武器を混ぜる
const PROOF_WEAPONS = { ice: 2, thunder: 2, water: 2, fire: 1, dragon: 1 };

/** 名前のある部位で切断肉質が一番低い (硬い) 部位 */
const hardestPart = (id) => [...H.monsterById(td, id).parts].filter((p) => !p.unknownPart)
  .sort((a, b) => a.hitzone.slash - b.hitzone.slash || a.ordinal - b.ordinal)[0].key;

function proofPlan(space, twoWeapons) {
  const b0 = space.builds[0];
  // レ・ダウとヌ・エグドラは硬い部位、ウズ・トゥナとアルシュベルドは弱点を狙う (心眼と弱点特効の取り合いを作る)
  return planOf(REY_DAU, AT, {
    target: { questId: 'Proof of a Hero', partKey: hardestPart(REY_DAU) },
    tabTarget: { memo: { [NU_UDRA]: { partKey: hardestPart(NU_UDRA) } } },
    search: { preset: 'power', twoWeapons: twoWeapons ? 'on' : 'off' },
    current: { build: fullBuild(space.weapons[space.weapons.length - 1], b0), combo: null, uptimes: {}, sharpness: null },
  });
}

test('小さい問題 5 問: 多頭の重みで探して T で並べ直した 1 位と、総当たりの T の最小の差 (0.5% 以内)', (t) => {
  const diffs = { rerank: [], time: [], equal: [], health: [] };
  for (let seed = 1; seed <= 5; seed++) {
    const space = smallSpace(seed, PROOF_WEAPONS);
    const plan = proofPlan(space, false);
    const H = Object.fromEntries(plan.subjects.map((s) => [s.key, s.healthForT.mid]));
    const run = (p, K) => {
      const job = R.planToJob(p, { K });
      job.runs[0].input.weapons = space.weapons;
      const runner = R.createPlanRunner(job, data, { createSearch: bruteSearch(space) });
      while (!runner.step(1000));
      return runner.result();
    };
    // 総当たりの本当の T
    const ev = makeEvaluator(R.planToJob(plan).runs[0].input);
    let best = Infinity;
    for (const w of space.weapons) for (const b of space.builds) {
      const pg = ev(fullBuild(w, b)).perGroup;
      best = Math.min(best, Object.keys(H).reduce((a, k) => a + H[k] / pg[k], 0));
    }
    const r10 = run(plan, 10);
    const got = r10.results[0].score.value;
    assert.equal(r10.results[0].score.kind, 'combos');
    assert.ok(got >= best - 1e-9, '総当たりより小さい T が出た (計算がずれている)');
    // 並べ直しの順が正しい (T の小さい順)
    for (let i = 1; i < r10.results.length; i++) assert.ok(r10.results[i].score.value >= r10.results[i - 1].score.value);
    diffs.rerank.push((got / best - 1) * 100);
    // 並べ直しなし (K=1) で、重みの決め方ごとの近似の差 (時間の比 = 採用 / 等分 / 体力の比)
    const sumH = Object.values(H).reduce((a, b) => a + b, 0);
    const alt = {
      time: plan,
      equal: { ...plan, weights: plan.weights.map((w) => ({ ...w, weight: 1 / plan.weights.length })) },
      health: { ...plan, weights: plan.weights.map((w) => ({ ...w, weight: H[w.key] / sumH })) },
    };
    for (const [k, p] of Object.entries(alt)) diffs[k].push((run(p, 1).results[0].score.value / best - 1) * 100);
  }
  const show = (list) => list.map((x) => x.toFixed(3)).join(' / ');
  t.diagnostic(`T の差 (時間の比の重み・K=10 で並べ直し): ${show(diffs.rerank)} %`);
  t.diagnostic(`T の差 (並べ直しなし) 時間の比: ${show(diffs.time)} % / 等分: ${show(diffs.equal)} % / 体力の比: ${show(diffs.health)} %`);
  for (const d of diffs.rerank) assert.ok(d <= 0.5, `T の差 ${d.toFixed(3)}% が 0.5% を超えた`);
});

test('小さい問題 5 問: 武器 2 本の合わせ (上位 5 件の防具に 2 本目を合わせる) と、防具 × 武器 2 本の総当たりの T の差 (2% 以内)', (t) => {
  const diffs = [];
  const gains = [];
  for (let seed = 11; seed <= 15; seed++) {
    const space = smallSpace(seed, PROOF_WEAPONS);
    const plan = proofPlan(space, true);
    const job = R.planToJob(plan, { K: 10 });
    assert.equal(job.merge.mode, 'twoWeapons');
    job.runs[0].input.weapons = space.weapons;
    const runner = R.createPlanRunner(job, data, { createSearch: bruteSearch(space), optimizeWeaponSide: bruteWeaponSide(space) });
    while (!runner.step(1000));
    const r = runner.result();
    assert.equal(r.status, 'done');
    assert.ok(r.results[0].twoWeapons, '武器 2 本の結果になっていない');
    assert.equal(r.results[0].builds.length, 2);
    assert.deepEqual(r.results[0].builds[0].armor, r.results[0].builds[1].armor, '防具は共通');
    const H = Object.fromEntries(job.subjects.map((s) => [s.key, s.health.mid]));
    const ev = makeEvaluator(job.runs[0].input);
    // 防具の組を固定したときは、2 本目の選び方が総当たりと同じ (作り物の optimizeWeaponSide = 総当たりなので、合わせ方の確かめ)
    const top = r.results[0];
    const fixedB = { armor: top.builds[0].armor, charm: top.builds[0].charm };
    let bestFixed = Infinity;
    for (const w1 of space.weapons) for (const w2 of space.weapons) {
      const p1 = ev(fullBuild(w1, fixedB)).perGroup;
      const p2 = ev(fullBuild(w2, fixedB)).perGroup;
      bestFixed = Math.min(bestFixed, Object.keys(H).reduce((a, k) => a + H[k] / Math.max(p1[k], p2[k]), 0));
    }
    assert.ok(Math.abs(top.score.value - bestFixed) / bestFixed < 1e-9, '防具を固定した武器 2 本の総当たりと合わない');
    // 防具も含めた全組
    let best = Infinity;
    const pgs = new Map();
    for (const w of space.weapons) for (const b of space.builds) pgs.set(`${w}|${JSON.stringify(b)}`, ev(fullBuild(w, b)).perGroup);
    for (const b of space.builds) {
      const key = JSON.stringify(b);
      for (const w1 of space.weapons) for (const w2 of space.weapons) {
        const p1 = pgs.get(`${w1}|${key}`);
        const p2 = pgs.get(`${w2}|${key}`);
        best = Math.min(best, Object.keys(H).reduce((a, k) => a + H[k] / Math.max(p1[k], p2[k]), 0));
      }
    }
    diffs.push((top.score.value / best - 1) * 100);
    if (r.twoWeaponsGain) gains.push(r.twoWeaponsGain.combos);
  }
  t.diagnostic(`武器 2 本の T の差 (全組の総当たり比): ${diffs.map((x) => x.toFixed(4)).join(' / ')} %`);
  t.diagnostic(`武器 1 本で通したときとの回数の差: ${gains.map((x) => x.toFixed(1)).join(' / ')} 回`);
  for (const d of diffs) assert.ok(d <= 2, `武器 2 本の T の差 ${d.toFixed(3)}% が 2% を超えた`);
});

test('jobKey: 予算は入れない・条件が変われば変わる', () => {
  const plan = planOf(NU_UDRA, AT);
  const a = R.jobKey(R.planToJob(plan, { budgetMs: 3000 }), { dataVersion: 'v1' });
  const b = R.jobKey(R.planToJob(plan, { budgetMs: 9000 }), { dataVersion: 'v1' });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(R.jobKey(R.planToJob(plan), { dataVersion: 'v2' }), a);
  assert.notEqual(R.jobKey(R.planToJob(planOf(NU_UDRA, AT, { search: { preset: 'safe' } })), { dataVersion: 'v1' }), a);
});

test('守りのスキルを足す候補 (体力・回復系は自動で足さない) は skills.json に全部ある', () => {
  const list = R.defenseSkillChoices(index);
  // docs/RECOMMEND_DESIGN.md 2.4 節の一覧
  const names = ['回復速度', '体力回復量ＵＰ', '精霊の加護', '防御', 'ひるみ軽減', '回避性能', '回避距離ＵＰ', 'ガード性能', 'ガード強化'];
  assert.deepEqual([...R.DEFENSE_SKILL_NAMES], names);
  assert.deepEqual(list.map((s) => s.name), names);
  for (const id of AT_IDS) {
    const plan = planOf(id, AT, { search: { preset: 'safe' } });
    for (const r of plan.requirements) assert.ok(!R.DEFENSE_SKILL_NAMES.includes(r.skillName), `${r.label} が自動で足された`);
  }
});

test('通常の数体と多頭クエスト数件: Plan が作れて、Job の入力の形がそろっている', () => {
  const cases = [
    { monsterId: 31, kind: 'tempered', questId: 'A Flash of Brilliance' }, // ラギアクルスとレ・ダウの歴戦の個体
    { monsterId: 10, kind: 'tempered', questId: 'Every Hunter\'s Dream' }, // ケマトリス 4 頭 + 1
    { monsterId: 6, kind: null, questId: 'Frenzy or Be Frenzied Upon' },
    { monsterId: 1, kind: null },
    { monsterId: 12, kind: null },
  ];
  for (const c of cases) {
    const plan = planOf(c.monsterId, c.kind, c.questId ? { target: { questId: c.questId } } : {});
    assert.equal(plan.status, 'ok', JSON.stringify(c));
    assert.ok(plan.subjects.length >= 1);
    for (const s of plan.subjects) assert.ok(s.targets.length >= 1, `${s.name}: 部位が無い`);
    const job = R.planToJob(plan);
    assert.ok(job.runs.length >= 1);
    for (const run of job.runs) {
      const sum = run.input.targets.reduce((a, x) => a + x.weight, 0);
      assert.ok(Math.abs(sum - 1) < 1e-9, '部位の割合の合計が 1 でない');
      assert.ok(Array.isArray(run.input.required));
      assert.equal(run.input.objective, 'damage');
      assert.ok(run.input.budget.activeMs > 0, '予算は計算した時間の合計 (activeMs) で数える');
    }
    if (c.questId === 'Every Hunter\'s Dream') {
      assert.equal(plan.subjects.length, 5);
      // 同じモンスターが 4 頭でも体力の違う 4 行
      const kema = plan.subjects.filter((s) => s.monsterId === 10).map((s) => s.healthForT.mid);
      assert.deepEqual(kema, [19000, 16400, 14400, 12000]);
    }
  }
  // 狂竜化のもと (ゴア・マガラ) が相手にいると、monsterStatus に frenzy
  const fr = planOf(6, null, { target: { questId: 'Frenzy or Be Frenzied Upon' } });
  assert.ok(R.planToJob(fr).runs[0].input.monsterStatus.includes('frenzy'));
});

// ---------------------------------------------------------------- 武器 2 本の「続けて探す」・合わせたあとの結果・いまの装備との比べ

/** 防具 (頭) と武器ごとの相手別の期待値 (作り物)。頭 2 は武器 3 で b に強い (1 本目の探索では下に来る) */
const PG2 = {
  1: { 1: { a: 50, b: 50 }, 2: { a: 200, b: 10 }, 3: { a: 10, b: 60 } },
  2: { 1: { a: 40, b: 40 }, 2: { a: 180, b: 8 }, 3: { a: 8, b: 90 } },
};
function twoJob({ cost = false } = {}) {
  const t = (n) => ({ hitzone: { slash: n }, wound: null, isWound: false });
  return {
    kind: 'plan', K: 5, blocked: null, warnings: [], requirements: [], gamma: null, baseline: null,
    costRun: cost ? { key: 'cost', label: '火力の差', input: { weapons: [1, 2, 3], targets: [], required: [], stopAfter: 'partial' } } : null,
    subjects: [{ key: 'a', name: 'A', health: { mid: 1000 } }, { key: 'b', name: 'B', health: { mid: 100000 } }],
    merge: { mode: 'twoWeapons', subjects: ['a', 'b'], groups: [{ element: 'fire', weapons: [2] }, { element: 'water', weapons: [3] }] },
    runs: [{
      key: 'main', label: '', input: {
        weapons: [1, 2, 3], required: [], budget: { work: 100 },
        targets: [{ weight: 0.3, group: 'a', target: t(40) }, { weight: 0.5, group: 'b', target: t(50) }, { weight: 0.2, group: 'b', target: t(30) }],
      },
    }],
  };
}
const headBuild = (w, head) => ({ weapon: w, armor: { ...emptyArmor(), head }, charm: null, decorations: {}, limitBreak: {} });
const twoSide = (input, fixed, d, { score, N }) => input.weapons
  .map((w) => ({ weapon: w, decorations: { weapon: [] }, perGroup: PG2[fixed.armor.head][w], score: score(PG2[fixed.armor.head][w]) }))
  .sort((x, y) => y.score - x.score).slice(0, N);

test('createPlanRunner: 武器 2 本の「続けて探す」は 2 本目で倒す相手に合わせた回を足し、良くなれば上位が入れ替わる', () => {
  const log = [];
  // 全員を見る回は頭 1 だけ、2 本目の相手 (b) だけを見る回は頭 2 を返す
  const make = (input) => (input.targets.every((x) => x.group === 'b')
    ? { results: [{ rank: 1, value: 40, weapon: 1, build: headBuild(1, 2), perGroup: PG2[2][1] }] }
    : { results: [{ rank: 1, value: 50, weapon: 1, build: headBuild(1, 1), perGroup: PG2[1][1] }] });
  const runner = R.createPlanRunner(twoJob(), { index, effects, motions }, { createSearch: scriptedSearch(make, log), optimizeWeaponSide: twoSide });
  while (!runner.step(50));
  const r1 = runner.result();
  assert.deepEqual(r1.results[0].weapons, [2, 3]);
  assert.deepEqual(r1.results[0].perSubject.map((p) => p.weapon), [1, 2]);
  const T1 = r1.results[0].score.value;
  assert.ok(Math.abs(T1 - (1000 / 200 + 100000 / 60)) < 1e-9);
  assert.equal(runner.extend({ ms: 1000 }), true);
  // 延長中も武器 2 本の結果のまま (武器 1 本の並びに戻らない)
  const mid = runner.result();
  assert.equal(mid.status, 'partial');
  assert.equal(mid.results[0].twoWeapons, true);
  while (!runner.step(50));
  const r2 = runner.result();
  const focus = log.find((x) => x.input.targets.every((t) => t.group === 'b'));
  assert.ok(focus, '2 本目の相手に合わせた回が無い');
  // 相手 b だけ・部位の割合はそのまま (0.5 : 0.2)・足して 1・予算は元の回と同じ形 (work)
  assert.deepEqual(focus.input.targets.map((t) => Math.round(t.weight * 1e9) / 1e9), [0.714285714, 0.285714286]);
  assert.deepEqual(focus.input.budget, { work: 100 });
  assert.ok(r2.stats.runs.some((x) => x.key === 'two-focus:b'));
  assert.equal(r2.results[0].builds[0].armor.head, 2, '良くなった組に入れ替わらない');
  assert.ok(Math.abs(r2.results[0].score.value - (1000 / 180 + 100000 / 90)) < 1e-9);
  assert.ok(r2.results[0].score.value < T1);
  assert.equal(r2.results[1].builds[0].armor.head, 1, '前の組も残る');
  // 2 回目の延長では同じ相手に絞った回を増やさない (延長で回す)
  assert.equal(runner.extend({ ms: 1000 }), true);
  while (!runner.step(50));
  assert.equal(runner.result().stats.runs.filter((x) => x.key.startsWith('two-focus')).length, 1);
});

test('createPlanRunner: 2 本目の相手に合わせた回の重みは H_i / D_i² (いまの最良の組の値)・その回の組は武器 1 本の順位が低くても合わせる', () => {
  // 3 体。a は武器 2、b・c は武器 3 で倒す。頭 1・3〜6 は全員を見る回の上位 5 件、頭 2 は b・c に合わせた回だけが返す
  const pg = (head, w) => (head === 2
    ? { 1: { a: 40, b: 40, c: 40 }, 2: { a: 180, b: 8, c: 8 }, 3: { a: 8, b: 90, c: 85 } }[w]
    : { 1: { a: 50, b: 50, c: 50 }, 2: { a: 200, b: 10, c: 10 }, 3: { a: 10, b: 60, c: 55 } }[w]);
  const t = (n) => ({ hitzone: { slash: n }, wound: null, isWound: false });
  const job = {
    ...twoJob(), subjects: [{ key: 'a', name: 'A', health: { mid: 1000 } }, { key: 'b', name: 'B', health: { mid: 50000 } }, { key: 'c', name: 'C', health: { mid: 80000 } }],
    runs: [{
      key: 'main', label: '', input: {
        weapons: [1, 2, 3], required: [], budget: { ms: 100 },
        targets: [{ weight: 0.2, group: 'a', target: t(40) }, { weight: 0.3, group: 'b', target: t(50) }, { weight: 0.5, group: 'c', target: t(30) }],
      },
    }],
  };
  const log = [];
  const make = (input) => (input.targets.every((x) => x.group !== 'a')
    ? { results: [{ rank: 1, value: 40, weapon: 1, build: headBuild(1, 2), perGroup: pg(2, 1) }] }
    : { results: [1, 3, 4, 5, 6].map((h, i) => ({ rank: i + 1, value: 50, weapon: 1, build: headBuild(1, h), perGroup: pg(h, 1) })) });
  const side = (input, fixed, d, { score, N }) => input.weapons
    .map((w) => ({ weapon: w, decorations: { weapon: [] }, perGroup: pg(fixed.armor.head, w), score: score(pg(fixed.armor.head, w)) }))
    .sort((x, y) => y.score - x.score).slice(0, N);
  const runner = R.createPlanRunner(job, { index, effects, motions }, { createSearch: scriptedSearch(make, log), optimizeWeaponSide: side });
  while (!runner.step(50));
  const T1 = 1000 / 200 + 50000 / 60 + 80000 / 55;
  assert.ok(Math.abs(runner.result().results[0].score.value - T1) < 1e-9);
  runner.extend({ ms: 1000 });
  while (!runner.step(50));
  const focus = log.find((x) => x.input.targets.every((g) => g.group !== 'a'));
  const raw = { b: 50000 / 60 ** 2, c: 80000 / 55 ** 2 };
  const want = [raw.b / (raw.b + raw.c), raw.c / (raw.b + raw.c)];
  focus.input.targets.forEach((g, i) => assert.ok(Math.abs(g.weight - want[i]) < 1e-12, `${g.group}: ${g.weight} と ${want[i]}`));
  assert.deepEqual(focus.input.budget, { ms: 1000 / 2 });
  // activeMs (計算した時間の合計) で延長したら、足す回も activeMs で切る
  runner.extend({ activeMs: 900 });
  while (!runner.step(50));
  assert.deepEqual(log.map((x) => x.lastExtend), [{ activeMs: 900 / 2 }, { activeMs: 900 / 2 }]);
  const r = runner.result();
  assert.equal(r.results[0].builds[0].armor.head, 2, '2 本目の相手に合わせた回の組を合わせていない');
  assert.ok(Math.abs(r.results[0].score.value - (1000 / 180 + 50000 / 90 + 80000 / 85)) < 1e-9);
});

test('createPlanRunner: 合わせたあと (火力の差の回の途中) と、合わせの途中でやめたときも武器 2 本の結果を出す', () => {
  const make = () => ({ results: [{ rank: 1, value: 50, weapon: 1, build: headBuild(1, 1), perGroup: PG2[1][1] }] });
  const clock = fakeClock();
  const runner = R.createPlanRunner(twoJob({ cost: true }), { index, effects, motions }, {
    createSearch: scriptedSearch(make, [], clock), optimizeWeaponSide: twoSide, now: clock.now,
  });
  let sawCost = false;
  while (!runner.step(5)) {
    if (runner.progress().phase === 'cost') {
      sawCost = true;
      const r = runner.result();
      assert.equal(r.status, 'partial');
      assert.equal(r.results[0].twoWeapons, true, '火力の差の回の途中で武器 1 本の結果に戻った');
    }
  }
  assert.ok(sawCost);
  assert.equal(runner.result().results[0].twoWeapons, true);
  // 合わせの途中でやめる (合わせ 1 件で時計を 10ms 進める)
  const c2 = fakeClock();
  const two = R.createPlanRunner(twoJob(), { index, effects, motions }, {
    createSearch: scriptedSearch(() => ({ results: [1, 2].map((h, i) => ({ rank: i + 1, value: 50 - i, weapon: 1, build: headBuild(1, h), perGroup: PG2[h][1] })) }), [], c2),
    optimizeWeaponSide: (...a) => { c2.t += 5; return twoSide(...a); },
    now: c2.now,
  });
  // 合わせに入った step で 1 件だけ合わせて区切れる (2 件目は残っている)
  while (two.progress().phase !== 'twoWeapons') assert.equal(two.step(5), false);
  two.cancel();
  assert.equal(two.step(1), true);
  const c = two.result();
  assert.equal(c.status, 'cancelled');
  assert.equal(c.results[0].twoWeapons, true);
});

test('createPlanRunner: いまの装備との比べは探索の入力 (発動率の扱いも) と同じ式で出す', () => {
  for (const placeholders of ['zero', 'keep']) {
    const plan = planOf(NU_UDRA, AT, { search: { preset: 'power' } });
    const job = R.planToJob(plan, { K: 3, placeholders });
    const input = job.runs[0].input;
    assert.equal(input.current.weapon, FIRE_SNS, 'いまの装備が探索の入力に入っていない');
    const want = makeEvaluator(input)(input.current).value;
    const runner = R.createPlanRunner(job, data, {
      createSearch: scriptedSearch({ results: [{ rank: 1, value: 1000, build: simpleBuild(FIRE_SNS, 1), weapon: FIRE_SNS }] }, []),
    });
    while (!runner.step(5));
    const r = runner.result().results[0];
    assert.ok(Math.abs(r.baseline.value - want) / want < 1e-12, `${placeholders}: ${r.baseline.value} と ${want}`);
    assert.ok(Math.abs(r.vsBaselinePct - (1000 / want - 1) * 100) < 1e-9);
  }
  // 探索が baseline を返せばそちら
  const job = R.planToJob(planOf(NU_UDRA, AT, { search: { preset: 'power' } }), { K: 3 });
  const make = () => ({ results: [{ rank: 1, value: 1000, build: simpleBuild(FIRE_SNS, 1), weapon: FIRE_SNS }] });
  const withBase = (input, d) => {
    const s = scriptedSearch(make, [])(input, d);
    const res = s.result;
    return { ...s, result: () => ({ ...res(), baseline: { value: 500 } }) };
  };
  const runner = R.createPlanRunner(job, data, { createSearch: withBase });
  while (!runner.step(5));
  assert.equal(runner.result().results[0].baseline.value, 500);
  assert.ok(Math.abs(runner.result().results[0].vsBaselinePct - 100) < 1e-9);
});

test('createPlanRunner: 端末の所持アーティア (入力の extraWeapons) の組も、いまの装備の値と守りのチェックを計算できる', () => {
  // Worker の索引は data/*.json だけで作る (端末の武器は入らない)。入力の extraWeapons を足した索引で計算すること
  const artian = { id: 'w-local', name: '端末のアーティア', baseWeaponId: FIRE_SNS, attack: 170, affinity: 0, element: { type: 'fire', value: 400 } };
  const plan = planOf(NU_UDRA, AT, { search: { preset: 'power' } });
  const job = R.planToJob(plan, { K: 3, current: simpleBuild('w-local', 1), extraWeapons: [artian] });
  assert.equal(job.runs[0].input.current.weapon, 'w-local');
  const runner = R.createPlanRunner(job, data, {
    createSearch: scriptedSearch({ results: [{ rank: 1, value: 1000, build: simpleBuild('w-local', 1), weapon: 'w-local' }] }, []),
  });
  while (!runner.step(5));
  const r = runner.result().results[0];
  const input = job.runs[0].input;
  const idx2 = { ...index, myWeapons: new Map([...index.myWeapons, ['w-local', artian]]) };
  const want = R.evaluateBuild(input.current, input.targets, {
    index: idx2, effects, motions, combo: input.combo, uptimes: input.uptimes, monsterStatus: input.monsterStatus, sharpness: input.sharpness,
  }).value;
  assert.ok(R.evaluateBuild(input.current, input.targets, { index, effects, motions, combo: input.combo, uptimes: input.uptimes }) == null,
    'data の索引だけでは端末の武器を引けない (この確かめの前提)');
  assert.ok(r.baseline && Math.abs(r.baseline.value - want) / want < 1e-12, `いまの装備の値: ${r.baseline && r.baseline.value} と ${want}`);
  assert.ok(r.defense, '守りのチェックがある');
});

test('planToJob: 属性やられの防ぎ方が行ごとにそろわないときは、必須にせず 1 回で探して警告を出す', () => {
  const plan = planOf(JIN_DAHAAD, AT, { search: { preset: 'safe', toggles: { 'blight-uncertain': true } } });
  const ice = reqByKey(plan, 'blight-uncertain');
  assert.equal(ice.on, true);
  // 作り物: 確定の属性やられ (雷) を足し、片方は耐性スキルだけ・もう片方は属性やられ耐性だけで防げることにする
  const thunder = { ...ice, key: 'blight', elements: ['thunder'], bySkill: null, options: [ice.byResist] };
  const broken = { ...plan, requirements: [...plan.requirements.filter((r) => r.kind !== 'blight'), thunder, { ...ice, byResist: null }] };
  const job = R.planToJob(broken);
  assert.deepEqual(job.runs.map((r) => r.key), ['main']);
  assert.ok(!job.runs[0].input.required.some((r) => r.skillId === BLIGHT_RES));
  assert.ok(job.warnings.some((w) => w.code === 'blight-not-required'));
  // 守りのチェックには残る
  assert.ok(job.requirements.some((r) => r.kind === 'blight'));
});
