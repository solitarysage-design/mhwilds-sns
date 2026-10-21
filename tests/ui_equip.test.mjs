// 装備タブの計算・整形 (app/ui/tabs/equip_logic.js) のテスト。node --test tests/*.test.mjs で回す。
// 実データ (data/*.json) を読んで、画面に出す一覧・アーティアの入力・斬れ味・火力の要約などを確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computeBuild, indexEquipData, decorationFitError } from '../app/model/build.js';
import * as L from '../app/ui/tabs/equip_logic.js';

const readJson = (rel) => JSON.parse(fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'));

// data.js の core と同じ形を作る (lists と index)
const raw = {
  skills: readJson('data/skills.json'), armor: readJson('data/armor.json'), weapons: readJson('data/weapons_sns.json'),
  decorations: readJson('data/decorations.json'), bonuses: readJson('data/bonuses.json'),
  charmsFixed: readJson('data/charms_fixed.json'), charms: readJson('data/charms.json'),
  myWeapons: readJson('data/my_weapons.json'), skillEffects: readJson('data/skill_effects.json'),
  motions: readJson('data/motions_sns.json'), combos: readJson('data/combos_sns.json'),
};
const data = {
  ...raw,
  lists: {
    skills: raw.skills.skills, armor: raw.armor.armor, weapons: raw.weapons.weapons,
    decorations: raw.decorations.decorations, charms: raw.charms.charms, charmsFixed: raw.charmsFixed.charms,
    myWeapons: raw.myWeapons.weapons, combos: raw.combos.combos,
  },
  index: indexEquipData(raw),
};
const idx0 = data.index;
const skillIdByName = (name) => data.lists.skills.find((s) => s.name === name).id;
const setBonusByName = (name) => raw.bonuses.setBonuses.find((b) => b.name === name);
const groupBonusByName = (name) => raw.bonuses.groupBonuses.find((b) => b.name === name);

// ---------------------------------------------------------------- 武器

test('武器の一覧: 片手剣 95 本と持っている武器。巨戟アーティアは激化の種類で見分けられる', () => {
  const items = L.weaponItems(idx0, data.lists.weapons, data.lists.myWeapons);
  assert.equal(items.length, data.lists.weapons.length + data.lists.myWeapons.length);
  assert.equal(data.lists.weapons.length, 95);
  const kirie = items.filter((it) => it.label.startsWith('破滅のキリエヴェルド'));
  assert.equal(kirie.length, 3);
  assert.equal(new Set(kirie.map((it) => it.label)).size, 3, '3 本の名前が同じだと選べない');
  for (const v of ['攻撃激化', '会心激化', '属性激化']) assert.ok(kirie.some((it) => it.label.includes(v)));
  // レア度の高い順・2 行目に攻撃 (表示値)・スロット
  const rarities = items.filter((it) => typeof it.value === 'number').map((it) => idx0.weapons.get(it.value).rarity);
  assert.deepEqual(rarities, [...rarities].sort((a, b) => b - a));
  const veld = items.find((it) => it.value === 1059);
  assert.match(veld.sub, /攻撃 266/);
  assert.match(veld.sub, /属性は手入力/);
  assert.match(veld.sub, /スロット ③③③/);
});

test('属性が null のアーティアだけ、その場で属性を入れる', () => {
  assert.equal(L.needsElementInput(idx0.weapons.get(1059), idx0), true);   // ヴェルドロート
  assert.equal(L.needsElementInput(idx0.weapons.get(1182), idx0), true);   // 巨戟アーティア
  assert.equal(L.needsElementInput(idx0.weapons.get(985), idx0), false);   // ホープソードⅠ (アーティアでない)
  assert.equal(L.isGogmaArtian(idx0.weapons.get(1182), idx0), true);
  assert.equal(L.isGogmaArtian(idx0.weapons.get(1059), idx0), false);
});

test('アーティアを「持っている武器」にする: 属性・シリーズ/グループ (1 部位)・元の武器から補う', () => {
  const src = idx0.weapons.get(1182);
  const fire = setBonusByName('火竜の力');
  const fur = groupBonusByName('毛皮の昂揚');
  const draft = { ...L.artianDraftOf(src, idx0), element: { type: 'fire', value: 300 }, setBonusId: fire.id, groupBonusId: fur.id };
  const w = L.makeLocalWeapon(src, draft, idx0, { id: 'wltest', addedAt: '2026-10-21' });
  assert.equal(w.name, '破滅のキリエヴェルド (属性激化・火)');
  assert.equal(w.baseWeaponId, 1182);
  assert.deepEqual(w.element, { type: 'fire', value: 300 });
  assert.deepEqual(w.slots, [3, 3, 3]);
  assert.deepEqual(w.sharpness, src.sharpness.base);
  assert.equal(w.attack, src.attack);

  // state に入れて読み戻す → 索引に入る → computeBuild で武器のシリーズ/グループが 1 部位
  const local = L.sanitizeLocalWeapons(JSON.parse(JSON.stringify([w])));
  assert.equal(local.length, 1);
  const idx = L.buildEquipIndex(data, { localWeapons: local });
  assert.notEqual(idx, data.index);
  const r = computeBuild({ weapon: 'wltest' }, idx);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  const sb = r.setBonuses.find((b) => b.bonusId === fire.id);
  assert.equal(sb.pieces, 1);
  assert.deepEqual(sb.from, ['weapon']);
  const gb = r.groupBonuses.find((b) => b.bonusId === fur.id);
  assert.equal(gb.pieces, 1);
  assert.equal(r.slots.weapon.length, 3);
  // 画面と計算に使う武器
  const rw = L.resolveWeaponRef('wltest', idx);
  assert.deepEqual(L.damageWeapon(rw), { attack: src.attack, affinity: src.affinity, element: { type: 'fire', value: 300 } });
  assert.equal(L.weaponName(rw), '破滅のキリエヴェルド (属性激化・火)');
  // 持っている武器は一覧の先頭
  const items = L.weaponItems(idx, data.lists.weapons, L.mergeById(data.lists.myWeapons, local));
  assert.equal(items[0].value, 'wltest');
  assert.match(items[0].sub, /火 300/);
  assert.match(items[0].sub, /シリーズ: 火竜の力/);
});

test('巨戟でないアーティアにはシリーズ/グループを付けない・名前を入れたらそれを使う', () => {
  const src = idx0.weapons.get(1059);
  const w = L.makeLocalWeapon(src, { ...L.artianDraftOf(src, idx0), name: ' 水のやつ ', element: { type: 'water', value: 280 }, setBonusId: 7 },
    idx0, { id: 'wlx' });
  assert.equal(w.name, '水のやつ');
  assert.equal(w.setBonusId, null);
  assert.equal(w.groupBonusId, null);
  assert.equal(L.defaultArtianName(src, null, idx0), 'ヴェルドロート (無属性)');
});

test('保存してある所持武器の検査: 壊れた要素・id の重複・知らない属性は捨てる', () => {
  const list = L.sanitizeLocalWeapons([
    null, 'x', { id: 'w0001', name: 'ファイルの id' }, { id: 'wla', name: 'A', baseWeaponId: 1059, element: { type: 'fire', value: 99999 } },
    { id: 'wla', name: '重複' }, { id: 'wlb', name: '', baseWeaponId: '1059', element: { type: 'ゴミ', value: 1 }, setBonusId: '7' },
  ]);
  assert.deepEqual(list.map((w) => w.id), ['wla', 'wlb']);
  assert.deepEqual(list[0].element, { type: 'fire', value: 2000 });
  assert.equal(list[1].name, '名前のない武器');
  assert.equal(list[1].baseWeaponId, 1059);
  assert.equal(list[1].element, null);
  assert.equal(list[1].setBonusId, 7);
  assert.equal('slots' in list[1], false, '無い項目は元の武器から補うので消しておく');
  assert.deepEqual(L.sanitizeLocalWeapons(undefined), []);
  assert.deepEqual(L.localWeaponsFromState({ tabs: { equip: { myWeapons: [{ id: 'wlz', name: 'z' }] } } }).map((w) => w.id), ['wlz']);
  assert.deepEqual(L.localWeaponsFromState({ tabs: {} }), []);
});

test('新しい所持武器の id はぶつからない', () => {
  const a = L.newLocalWeaponId([], 1000);
  const b = L.newLocalWeaponId([{ id: a }], 1000);
  assert.ok(a.startsWith('wl') && b.startsWith('wl'));
  assert.notEqual(a, b);
  assert.ok(!/^w\d{4}$/.test(a), 'my_weapons.json の id (w0001) とは形が違う');
});

test('攻撃力の表示値と係数なしの値の行き来', () => {
  assert.equal(L.attackDisplay(idx0.weapons.get(1059)), 266);
  assert.equal(L.attackDisplay({ attack: 190 }), 266);
  assert.equal(L.attackFromDisplay(266), 190);
  assert.equal(L.attackDisplay({ attack: L.attackFromDisplay(273) }), 273);
});

// ---------------------------------------------------------------- 防具

test('防具の一覧: 部位・上位/下位・レア度で絞り、スロットとスキルを出す', () => {
  const all = L.armorItems(idx0, data.lists.armor, 'head');
  assert.equal(all.length, data.lists.armor.filter((a) => a.part === 'head').length);
  const hi = L.armorItems(idx0, data.lists.armor, 'head', { rank: 'high', rarity: 'all' });
  assert.ok(hi.length > 0 && hi.every((it) => idx0.armor.get(it.value).rank === 'high'));
  const r5 = L.armorItems(idx0, data.lists.armor, 'head', { rank: 'high', rarity: 5 });
  assert.ok(r5.length > 0 && r5.every((it) => idx0.armor.get(it.value).rarity === 5));
  assert.ok(new Set(r5.map((it) => it.group)).size === 1 && r5[0].group === '上位 レア 5');
  const lo = L.armorItems(idx0, data.lists.armor, 'legs', { rank: 'low' });
  assert.ok(lo.length > 0 && lo.every((it) => idx0.armor.get(it.value).rank === 'low'));
  const rar = all.map((it) => idx0.armor.get(it.value).rarity);
  assert.deepEqual(rar, [...rar].sort((a, b) => b - a));
  // コンガヘルムα: スロット ①−− → 限界突破で ②①①、スキル名、グループ名
  const conga = all.find((it) => it.label === 'コンガヘルムα');
  assert.match(conga.sub, /スロット ①−− \(限界突破で ②①①\)/);
  assert.match(conga.sub, /Lv1/);
  assert.match(conga.sub, /グループ: /);
  assert.match(L.armorSub(idx0.armor.get(conga.value), idx0, { limitBreakOn: true }), /スロット ②①① \(限界突破\)/);
  assert.deepEqual(L.rarityOptions('high'), [8, 7, 6, 5]);
  assert.deepEqual(L.rarityOptions('low'), [4, 3, 2, 1]);
});

// ---------------------------------------------------------------- 護石

test('護石の一覧: 取り込んだ護石 → 端末で足した護石 → 生産する護石', () => {
  const local = L.sanitizeLocalCharms([
    { id: 'u0001', name: '秘歴の護石', rarity: 7, skills: [{ skillId: skillIdByName('攻撃'), level: 2 }], armorSlots: [1, 0, 0], weaponSlots: [0] },
    { id: 'c0001', name: 'ファイルと同じ id', skills: [] },
    { id: 5, name: '数の id は固定護石とぶつかるので使わない', skills: [] },
  ]);
  assert.deepEqual(local.map((c) => c.id), ['u0001', 'c0001']);
  const items = L.charmItems(idx0, data.lists.charms, local, data.lists.charmsFixed);
  const groups = [...new Set(items.map((it) => it.group))];
  assert.deepEqual(groups, ['Claude が取り込んだ護石', 'この端末で足した護石', '生産する護石 (スロットなし)']);
  assert.equal(items.filter((it) => it.value === 'c0001').length, 1, '同じ id は data/charms.json の方だけ');
  assert.match(items.find((it) => it.value === 'u0001').sub, /攻撃 Lv2.*防具用 ①−−/);
  assert.equal(items.length, data.lists.charms.length + 1 + data.lists.charmsFixed.length);
  // {charms: [...]} の形でも読む
  assert.equal(L.sanitizeLocalCharms({ charms: [{ id: 'u9', skills: [] }] }).length, 1);
  // 端末の護石を索引に入れると computeBuild で使える
  const idx = L.buildEquipIndex(data, { localCharms: local });
  const r = computeBuild({ charm: 'u0001', decorations: { charmArmor: [null] } }, idx);
  assert.deepEqual(r.errors, []);
  assert.equal(r.skillLevels[skillIdByName('攻撃')], 2);
});

// ---------------------------------------------------------------- 装飾品

test('装飾品の候補: 入れ先の種類とスロット Lv に入るものだけ・大きい珠から', () => {
  const decos = data.lists.decorations;
  for (const [kind, size] of [['weapon', 3], ['weapon', 1], ['armor', 2], ['armor', 3]]) {
    const items = L.decoItems(idx0, decos, kind, size);
    const want = decos.filter((d) => d.kind === kind && d.slot <= size).length;
    assert.equal(items.length, want, `${kind} Lv${size}`);
    assert.ok(items.every((it) => decorationFitError(idx0.decorations.get(it.value), kind, size) == null));
    const sizes = items.map((it) => idx0.decorations.get(it.value).slot);
    assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
    assert.ok(items.every((it) => it.sub.includes('Lv')), 'スキルを 2 行目に出す');
  }
  assert.deepEqual(L.decoItems(idx0, decos, 'armor', 0), []);
});

test('スロットの行: Lv0 は出さない・入れたのに入らない所はエラー付きで出す', () => {
  const armorDeco2 = data.lists.decorations.find((d) => d.kind === 'armor' && d.slot === 2);
  const build = {
    weapon: 1059, armor: { head: idx0.armor.get(1).id }, charm: 'c0001', limitBreak: { head: false },
    decorations: { head: [null, armorDeco2.id], charmArmor: [] },
  };
  const r = computeBuild(build, idx0);
  const groups = L.slotGroups(r, build, { weapon: 'ヴェルドロート', head: 'コンガヘルムα', charm: '秘歴の護石' });
  const byT = Object.fromEntries(groups.map((g) => [g.target, g]));
  assert.deepEqual(Object.keys(byT), ['weapon', 'head', 'charmArmor']);
  assert.equal(byT.weapon.rows.length, 3);
  assert.equal(byT.weapon.kind, 'weapon');
  assert.equal(byT.weapon.title, '武器: ヴェルドロート');
  // 頭は ①−− (限界突破なし)。2 番目のスロットは無いのに珠が入っている → 行を出してエラー
  assert.deepEqual(byT.head.rows.map((x) => [x.index, x.size]), [[0, 1], [1, 0]]);
  assert.equal(byT.head.rows[1].error.code, 'slot-missing');
  assert.equal(byT.charmArmor.title, '護石 (防具用): 秘歴の護石');
  assert.equal(byT.charmArmor.kind, 'armor');
  assert.match(L.slotSummaryText(r.slotSummary.weapon), /^0 \/ 3 使用・空き ③×3$/);
  assert.equal(L.slotSummaryText({ total: 0 }), 'スロットなし');
});

// ---------------------------------------------------------------- 結果の文字

test('画面に出すエラーの文に id などの内部の言葉を出さない', () => {
  const r = computeBuild({ weapon: 'wl-none', armor: { head: 999999 }, charm: 'c9999' }, idx0);
  const msgs = r.errors.map(L.friendlyIssue);
  assert.equal(msgs.length, 3);
  for (const m of msgs) {
    assert.doesNotMatch(m, /id|json|wl-none|999999|c9999/);
  }
  assert.match(msgs[0], /武器を選び直して/);
  // ほかのエラーは build.js の日本語の文をそのまま
  assert.equal(L.friendlyIssue({ code: 'deco-too-large', message: 'そのまま' }), 'そのまま');
});

test('シリーズ/グループの発動の文・スキルの出どころ', () => {
  const kirie = setBonusByName('火竜の力');
  const parts = data.lists.armor.filter((a) => L.setIdsOf(a).includes(kirie.id));
  const head = parts.find((a) => a.part === 'head');
  const chest = parts.find((a) => a.part === 'chest');
  const r = computeBuild({ armor: { head: head.id, chest: chest.id } }, idx0);
  const lines = L.bonusLines(r, idx0);
  const fire = lines.find((x) => x.name === '火竜の力');
  assert.equal(fire.active, true);
  assert.match(fire.status, /^2 部位で発動/);
  assert.match(fire.ranksText, /2 部位で/);
  assert.equal(fire.from, '頭・胴');
  const s = r.skills.find((x) => x.skillId === kirie.skillId);
  assert.match(L.sourcesText(s.sources), /シリーズ 2 部位/);
  assert.match(L.sourcesText([{ target: 'weapon', via: 'decoration', level: 2 }, { target: 'charm', via: 'equipment', level: 1 }]),
    /装飾品 \(武器\) 2・護石 1/);
});

// ---------------------------------------------------------------- 斬れ味

test('斬れ味の自動の色: 武器の一番上の色。匠で色が増える武器は匠の Lv を見る', () => {
  const art1 = idx0.weapons.get(1057); // アーティアソードⅠ: 青まで。匠で青 +20 → 白 +30
  const hid = skillIdByName('匠');
  assert.equal(L.handicraftSkillId(idx0), hid);
  assert.equal(L.autoSharpness(art1, idx0, {}).color, 'blue');
  assert.equal(L.autoSharpness(art1, idx0, { [hid]: 2 }).color, 'blue');
  assert.equal(L.autoSharpness(art1, idx0, { [hid]: 3 }).color, 'white');
  assert.deepEqual(L.gaugeWithHandicraft(L.sharpnessGauge(art1, idx0), 3), [80, 40, 60, 80, 60, 10]);
  assert.deepEqual(L.gaugeWithHandicraft(L.sharpnessGauge(art1, idx0), 9), [80, 40, 60, 80, 60, 30], '上限で止まる');
  assert.equal(L.autoSharpness(idx0.weapons.get(1180), idx0, {}).color, 'white');
  assert.equal(L.autoSharpness(idx0.weapons.get(985), idx0, {}).color, 'green');
  // 所持武器 (斬れ味は配列) は、元の武器と同じゲージなら元の武器の匠の伸びしろを使う
  const own = { id: 'wlq', baseWeaponId: 1057, sharpness: [80, 40, 60, 80, 40, 0] };
  assert.equal(L.autoSharpness(own, idx0, { [hid]: 3 }).color, 'white');
  const changed = { id: 'wlr', baseWeaponId: 1057, sharpness: [80, 40, 60, 80, 50, 0] };
  assert.equal(L.autoSharpness(changed, idx0, { [hid]: 5 }).color, 'blue', '違うゲージなら伸びしろが分からない');
  assert.equal(L.autoSharpness(null, idx0, {}).color, null);
});

// ---------------------------------------------------------------- 火力の要約

test('火力の相手: 決まっていなければ手入力の既定の肉質 (切断・打撃 45、属性 20)', () => {
  const unset = L.pickDamageTarget({ mode: 'monster', monsterId: null }, null, 'idle');
  assert.equal(unset.source, 'default');
  assert.equal(unset.label, `既定の肉質 (${L.DEFAULT_HITZONE_TEXT})`);
  assert.equal(L.DEFAULT_HITZONE_TEXT, '切断 45・打撃 45・属性 20');
  assert.equal(unset.reason, 'unset');
  assert.equal(unset.target.hitzone.slash, 45);
  assert.equal(unset.target.hitzone.fire, 20);
  assert.equal(unset.target.wound, null);
  assert.deepEqual(L.pickDamageTarget({ mode: 'monster', monsterId: 3, partKey: 'head' }, null, 'loading'), { loading: true });
  assert.equal(L.pickDamageTarget({ mode: 'monster', monsterId: 3, partKey: null }, null, 'idle').reason, 'no-part');
  assert.equal(L.pickDamageTarget({ mode: 'monster', monsterId: 3, partKey: 'head' }, null, 'error').reason, 'load-error');
  const hz = { slash: 60, blunt: 55, fire: 10, water: 10, thunder: 30, ice: 10, dragon: 5 };
  const mon = L.pickDamageTarget({ mode: 'monster', monsterId: 3, partKey: 'head', isWound: true },
    { hitzone: hz, wound: hz, isWound: true, label: 'レ・ダウ 頭' }, 'ready');
  assert.equal(mon.source, 'monster');
  assert.equal(mon.label, 'レ・ダウ 頭・傷口');
  assert.equal(mon.target.isWound, true);
  const man = L.pickDamageTarget({ mode: 'manual' }, { hitzone: hz, wound: null, isWound: false, label: '手入力' }, 'idle');
  assert.equal(man.source, 'manual');
  assert.match(L.defaultTargetReason('unset'), /相手を選んでいない/);
});

test('火力の要約: 期待値とスキルなし比', () => {
  const weapon = L.resolveWeaponRef(1059, idx0);
  const atk = skillIdByName('攻撃');
  const r = computeBuild({ weapon: 1059 }, idx0);
  const base = { weapon, sharpness: 'white', uptimes: {}, data, combo: data.lists.combos[0], target: L.DEFAULT_TARGET };
  const none = L.summarizePower({ ...base, skills: r.skills });
  assert.ok(none.total > 0);
  assert.equal(none.vsNoSkillsPct, 0);
  assert.equal(none.comboName, data.lists.combos[0].name);
  const withAtk = L.summarizePower({ ...base, skills: [{ skillId: atk, level: 5 }] });
  assert.ok(withAtk.total > none.total);
  assert.ok(withAtk.vsNoSkillsPct > 0);
  assert.ok(Math.abs(withAtk.noSkills - none.total) < 1e-9);
  // 条件つきスキル (挑戦者) は既定の割合が仮置きなので placeholders に出る
  const ch = L.summarizePower({ ...base, skills: [{ skillId: skillIdByName('挑戦者'), level: 5 }] });
  assert.ok(ch.placeholders.some((c) => c.id === 'enraged'));
  assert.ok(L.summarizePower({ ...base, skills: [], uptimes: { enraged: 1 } }).total > 0);
  // コンボが無ければエラーの文 (投げない)
  assert.ok(L.summarizePower({ ...base, combo: null, skills: [] }).error);
  // 自分で組んだコンボ (技 id の配列)
  const moves = data.lists.combos[0].steps.map((s) => s.move);
  assert.equal(L.summarizePower({ ...base, combo: moves, skills: [] }).comboName, '自分で組んだコンボ');
});

test('火力の要約: 部位を割合で混ぜる (targets) と、部位ごとの期待値の加重平均になる (火力タブと同じ)', () => {
  const weapon = L.resolveWeaponRef(1059, idx0);
  const skills = [{ skillId: skillIdByName('攻撃'), level: 3 }, { skillId: skillIdByName('弱点特効'), level: 3 }];
  const base = { weapon, sharpness: 'white', uptimes: {}, data, combo: data.lists.combos[0], skills };
  const hard = { hitzone: { slash: 30, blunt: 30, fire: 10, water: 10, thunder: 10, ice: 10, dragon: 10 }, wound: null, isWound: false };
  const a = L.summarizePower({ ...base, target: L.DEFAULT_TARGET });
  const b = L.summarizePower({ ...base, target: hard });
  const mix = L.summarizePower({ ...base, target: L.DEFAULT_TARGET,
    targets: [{ weight: 3, target: L.DEFAULT_TARGET }, { weight: 1, target: hard }] });
  assert.equal(mix.mixed, true);
  assert.ok(Math.abs(mix.total - (0.75 * a.total + 0.25 * b.total)) < 1e-9);
  assert.ok(Math.abs(mix.noSkills - (0.75 * a.noSkills + 0.25 * b.noSkills)) < 1e-9);
  // targets が無い・空なら target 1 つと同じ (mixed ではない)
  const one = L.summarizePower({ ...base, target: L.DEFAULT_TARGET, targets: [] });
  assert.equal(one.mixed, false);
  assert.equal(one.total, a.total);
});

test('火力の要約: 斬れ味が自動なら、スキルなしの色は匠なしで決め直す (匠の分もスキルなし比に入る)', () => {
  // 護雷剣シーカガルデ (素の斬れ味は青。匠 Lv1 で白) に 雷光・匠珠【3】(匠 Lv1)
  const w = data.lists.weapons.find((x) => x.name === '護雷剣シーカガルデ');
  const deco = data.lists.decorations.find((d) => d.name.startsWith('雷光・匠珠'));
  const hid = skillIdByName('匠');
  const weapon = L.resolveWeaponRef(w.id, idx0);
  const r = computeBuild({ weapon: w.id, decorations: { weapon: [deco.id] } }, idx0);
  assert.equal(r.skillLevels[hid], 1);
  assert.equal(L.autoSharpness(weapon, idx0, {}).color, 'blue');
  assert.equal(L.autoSharpness(weapon, idx0, r.skillLevels).color, 'white');
  const base = { weapon, sharpness: 'white', skills: r.skills, uptimes: {}, data, combo: data.lists.combos[0], target: L.DEFAULT_TARGET };
  const fixed = L.summarizePower(base);
  const auto = L.summarizePower({ ...base, perSkills: L.sharpnessResolver(weapon, idx0, null) });
  // 期待値そのものは同じ (いまの装備は白)。スキルなしは青で計算するので、スキルなし比は大きくなる
  assert.ok(Math.abs(auto.total - fixed.total) < 1e-9);
  const blueNone = L.summarizePower({ ...base, sharpness: 'blue', skills: [] }).total;
  assert.ok(Math.abs(auto.noSkills - blueNone) < 1e-9);
  assert.ok(auto.vsNoSkillsPct > fixed.vsNoSkillsPct + 5);
  // 斬れ味を固定しているときは色を決め直さない
  assert.equal(L.sharpnessResolver(weapon, idx0, 'white'), null);
  assert.deepEqual(L.sharpnessResolver(weapon, idx0, null)([]), { sharpness: 'blue' });
  assert.deepEqual(L.sharpnessResolver(weapon, idx0, null)([{ skillId: hid, level: 1 }]), { sharpness: 'white' });
  assert.deepEqual(L.handicraftInfo(idx0), { skillId: hid, name: '匠', maxLevel: idx0.skills.get(hid).maxLevel });
});

// ---------------------------------------------------------------- 装備を替えたときの装飾品

test('装備を替えたとき、新しいスロットに入る装飾品は残し、入らないものだけ外す', () => {
  const deco = (kind, slot) => data.lists.decorations.find((d) => d.kind === kind && d.slot === slot);
  const a3 = deco('armor', 3).id;
  const a2 = deco('armor', 2).id;
  const a1 = deco('armor', 1).id;
  const w3 = deco('weapon', 3).id;
  // 同じ大きさのスロットならそのまま (並びも変えない)
  assert.deepEqual(L.refitDecorations([a3, a1, a2], [3, 3, 3], 'armor', idx0), { list: [a3, a1, a2], kept: [a3, a1, a2], removed: [] });
  // 小さくなったスロットに入らない珠だけ外す
  const r = L.refitDecorations([a3, a2, a1], [2, 1, 0], 'armor', idx0);
  assert.deepEqual(r.list, [a2, a1]);
  assert.deepEqual(r.removed, [a3]);
  // 同じ番号に入らなくても、ほかの空いているスロットに入るなら移す
  assert.deepEqual(L.refitDecorations([a1, a3], [3, 1], 'armor', idx0).list, [a3, a1]);
  // スロットが無い装備 (外した・生産する護石) なら全部外す。null の空きは数えない
  const none = L.refitDecorations([a1, null, a2], [], 'armor', idx0);
  assert.deepEqual([none.list, none.kept, [...none.removed].sort()], [[], [], [a1, a2].sort()]);
  // 種類の違う珠 (防具用を武器のスロットに) は入らない
  assert.deepEqual(L.refitDecorations([a1], [3], 'weapon', idx0).removed, [a1]);
  assert.deepEqual(L.refitDecorations([w3, null], [3, 3, 3], 'weapon', idx0).list, [w3]);
});

// ---------------------------------------------------------------- マイセット

test('マイセットの比べ方: 末尾の空き・外した部位の限界突破は同じとみなす', () => {
  const a = { weapon: 1059, armor: { head: 1 }, limitBreak: { head: true, chest: true }, charm: null, decorations: { weapon: [5, null], head: [] } };
  const b = { weapon: 1059, armor: { head: 1, chest: null }, limitBreak: { head: true }, charm: null, decorations: { weapon: [5], head: [null] } };
  assert.equal(L.canonicalBuild(a), L.canonicalBuild(b));
  assert.notEqual(L.canonicalBuild(a), L.canonicalBuild({ ...b, limitBreak: { head: false } }));
  assert.match(L.setSummary(b, idx0), /^ヴェルドロート・防具 1 部位$/);
  assert.match(L.setSummary({ weapon: 'wl-gone', armor: {} }, idx0), /^見つからない武器/);
});
