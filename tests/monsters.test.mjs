// モンスター担当のデータ (data/monsters.json, data/monster_threats.json, data/quests.json) の構造検査。
// 実行: node --test tests/*.test.mjs  (Node 24 では tests/ とディレクトリで渡すと落ちる)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// MONSTERS_TEST_DATA で別の場所 (変異を入れたコピー等) を検査できる
const DATA = process.env.MONSTERS_TEST_DATA ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const load = (name) => JSON.parse(readFileSync(join(DATA, name), 'utf8'));

const monstersDoc = load('monsters.json');
const threatsDoc = load('monster_threats.json');
const questsDoc = load('quests.json');
const monsters = monstersDoc.monsters;
const byId = new Map(monsters.map((m) => [m.id, m]));

// 取り込み時点 (2026-10-21, Ver.1.042) の件数。生データを取り直したら見直す。
const EXPECT = { monsters: 34, quests: 220, multiQuests: 34, fixedTrue: 17, fixedFalse: 203 };

const HZ_KEYS = ['slash', 'blunt', 'shot', 'fire', 'water', 'thunder', 'ice', 'dragon', 'stun'];
const ELEMENTS = ['fire', 'water', 'thunder', 'ice', 'dragon'];
const VARIANTS = ['tempered', 'arch-tempered', 'frenzied', 'alpha'];

function assertHitzone(hz, where, { allowNullStun = false } = {}) {
  assert.ok(hz && typeof hz === 'object', `${where}: 肉質が無い`);
  for (const k of HZ_KEYS) {
    const v = hz[k];
    if (k === 'stun' && allowNullStun && v === null) continue;
    assert.ok(Number.isInteger(v), `${where}.${k} が整数でない: ${v}`);
    assert.ok(v >= 0 && v <= 100, `${where}.${k} が 0〜100 の外: ${v}`);
  }
}

test('meta がある (source / generatedAt / gameVersion)', () => {
  for (const doc of [monstersDoc, threatsDoc, questsDoc]) {
    assert.ok(Array.isArray(doc.meta.source) && doc.meta.source.length > 0);
    assert.match(doc.meta.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(typeof doc.meta.gameVersion, 'string');
  }
});

test('大型モンスターは 34 体・id は一意', () => {
  assert.equal(monsters.length, EXPECT.monsters);
  assert.equal(byId.size, monsters.length);
  for (const m of monsters) {
    assert.ok(m.name, `id ${m.id} に名前が無い`);
    assert.ok(Number.isInteger(m.baseHealth) && m.baseHealth > 0, `${m.name} baseHealth`);
    for (const v of m.variants) assert.ok(VARIANTS.includes(v), `${m.name} variant ${v}`);
  }
});

test('全部位に 0〜100 の整数の肉質がある (通常・傷口・状態別)', () => {
  for (const m of monsters) {
    assert.ok(m.parts.length > 0, `${m.name} に部位が無い`);
    const keys = new Set();
    for (const p of m.parts) {
      const where = `${m.name}/${p.key}`;
      assert.ok(!keys.has(p.key), `${where}: key が重複`);
      keys.add(p.key);
      assertHitzone(p.hitzone, where);
      if (p.wound !== null) assertHitzone(p.wound, `${where}.wound`, { allowNullStun: true });
      for (const [s, hz] of Object.entries(p.states)) {
        assertHitzone(hz, `${where}.states.${s}`, { allowNullStun: true });
      }
      assert.equal(typeof p.breakable, 'boolean');
      assert.equal(typeof p.severable, 'boolean');
      // 部位ごとの最大の属性は通常肉質の最大値と一致する
      const max = Math.max(...ELEMENTS.map((e) => p.hitzone[e]));
      assert.equal(p.bestElement.value, max, `${where} bestElement`);
      for (const e of p.bestElement.types) assert.equal(p.hitzone[e], max);
    }
  }
});

test('肉質の値の抜き取り確認 (アルシュベルドの頭 = 斬45/打48)', () => {
  const ark = monsters.find((m) => m.name === 'アルシュベルド');
  const head = ark.parts.find((p) => p.key === 'head');
  assert.equal(head.hitzone.slash, 45);
  assert.equal(head.hitzone.blunt, 48);
  assert.equal(head.hitzone.stun, 100);
});

test('名前を解決できない部位は捨てずに「部位不明（内部名）」で持ち、推奨の対象外', () => {
  let unknown = 0;
  for (const m of monsters) {
    const basis = new Set(m.elementRecommendation.basisParts);
    for (const p of m.parts) {
      if (p.unknownPart) {
        unknown += 1;
        assert.equal(p.name, `部位不明（${p.key}）`);
        assert.ok(!basis.has(p.key), `${m.name}/${p.key} が推奨の計算に入っている`);
      } else {
        assert.ok(!p.name.startsWith('部位不明'), `${m.name}/${p.key}`);
      }
    }
  }
  assert.ok(unknown > 0, '部位不明 (hide) が 1 件も無い (取りこぼしの疑い)');
});

test('推奨属性は主要部位の平均から計算されている', () => {
  for (const m of monsters) {
    const r = m.elementRecommendation;
    assert.ok(r.basisParts.length >= 2, `${m.name} 主要部位が少ない`);
    for (const e of r.best) assert.ok(ELEMENTS.includes(e));
    const basis = m.parts.filter((p) => r.basisParts.includes(p.key));
    for (const { type, avg } of r.order) {
      const expect = basis.reduce((s, p) => s + p.hitzone[type], 0) / basis.length;
      assert.ok(Math.abs(expect - avg) < 0.051, `${m.name} ${type} ${avg} != ${expect}`);
    }
  }
  // MHDB の属性弱点フラグが 1 件も無いゴグマジオスでも推奨が出る
  const gog = monsters.find((m) => m.name === 'ゴグマジオス');
  assert.ok(gog.elementRecommendation.best.length > 0);
});

test('状態異常の★と無効', () => {
  for (const m of monsters) {
    for (const [k, v] of Object.entries(m.statusWeakness)) {
      assert.ok(v === null || (Number.isInteger(v) && v >= 0 && v <= 3), `${m.name} ${k}=${v}`);
    }
    for (const k of m.immune) {
      assert.ok(k in m.statusWeakness, `${m.name} immune に状態異常以外 (${k}) が入っている`);
      assert.equal(m.statusWeakness[k], 0, `${m.name} ${k} は無効なのに★がある`);
    }
    for (const k of ['flash', 'noise']) {
      assert.ok([true, false, null].includes(m.itemEffects[k].effective), `${m.name} itemEffects.${k}`);
    }
  }
});

test('脅威データは 34 体ぶん・ライセンス表記・既知の欠損は null', () => {
  assert.equal(threatsDoc.meta.license.name, 'CC BY-SA 4.0');
  assert.ok(threatsDoc.meta.source.some((u) => u.includes('monsterhunterwiki.org')));
  const t = threatsDoc.monsters;
  assert.equal(t.length, EXPECT.monsters);
  for (const x of t) {
    assert.ok(byId.has(x.monsterId), `monsterId ${x.monsterId}`);
    assert.ok([null, 'none', 'weak', 'strong'].includes(x.roar));
    assert.ok([null, 'none', 'minor', 'major', 'dragon'].includes(x.windPressure));
    assert.ok([null, 'none', 'minor', 'major'].includes(x.tremor));
    for (const b of x.blights) assert.ok(ELEMENTS.includes(b.element));
  }
  const que = t.find((x) => x.name === 'ケマトリス');
  assert.equal(que.roar, null);
  assert.equal(que.windPressure, null);
  const zoh = t.find((x) => x.name === 'ゾ・シア');
  assert.equal(zoh.windPressure, 'dragon');
  const r = threatsDoc.rules.elementalBlight;
  assert.equal(r.resistanceThreshold, 20);
  assert.equal(r.skill.negateLevel, 3);
});

test('クエスト: 件数・多頭 (multi) の数・狩猟対象の参照', () => {
  const q = questsDoc.quests;
  assert.equal(questsDoc.meta.license.name, 'CC BY-SA 4.0');
  assert.equal(q.length, EXPECT.quests);
  assert.equal(new Set(q.map((x) => x.id)).size, q.length, 'id が重複');
  const multi = q.filter((x) => x.multi);
  assert.equal(multi.length, EXPECT.multiQuests);
  for (const x of q) {
    const large = x.targets.filter((t) => t.large).reduce((s, t) => s + t.count, 0);
    assert.equal(x.largeTargetCount, large, x.id);
    assert.equal(x.multi, large >= 2, `${x.id} multi`);
    assert.ok(Number.isInteger(x.stars) && x.stars >= 1 && x.stars <= 10, `${x.id} ★${x.stars}`);
    for (const t of x.targets) {
      if (t.monsterId !== null) assert.ok(byId.has(t.monsterId), `${x.id} 対象 ${t.monsterId}`);
      if (t.variant !== null) assert.ok(VARIANTS.includes(t.variant), `${x.id} variant ${t.variant}`);
    }
    for (const t of x.intruders) {
      if (t.monsterId !== null) assert.ok(byId.has(t.monsterId), `${x.id} 乱入 ${t.monsterId}`);
    }
    assert.ok([true, false, null].includes(x.fixedEquipment));
    assert.ok(x.name, `${x.id} 名前が無い`);
  }
  assert.equal(q.filter((x) => x.fixedEquipment === true).length, EXPECT.fixedTrue);
  // 歴戦王 (arch-tempered) のクエストが名前/アイコンから判別できている
  assert.ok(q.some((x) => x.variant === 'arch-tempered'));
});

// ---- 2026-10-21 検証 (monsters-verify) で足した抜き取り確認 ----
// 値は Kiranico (Ver.1.040) と Game8 で照合して一致したもの (取り込み元ではなく照合のみ)。
// 変異注入で見逃していた壊れ方 (傷口=通常、states の欠落、破壊/切断・状態異常の★・咆哮/振動/属性やられの全滅、
// 乱入の id 落ち) をここで検出する。
const mon = (name) => monsters.find((m) => m.name === name);
const part = (name, key) => mon(name).parts.find((p) => p.key === key);
const threat = (name) => threatsDoc.monsters.find((x) => x.name === name);

test('傷口・状態別肉質の抜き取り確認 (Kiranico と照合済み)', () => {
  const rath = part('リオレウス', 'head');
  assert.deepEqual([rath.hitzone.slash, rath.wound.slash, rath.wound.blunt, rath.wound.dragon], [65, 70, 75, 30]);
  const rey = part('レ・ダウ', 'head');
  assert.deepEqual([rey.wound.slash, rey.wound.blunt, rey.wound.shot, rey.wound.ice], [70, 75, 60, 25]);
  // 傷口が通常と同じ部位はごく一部 (アルシュベルドの頭など)。傷口に通常肉質を入れる取り違えを検出する
  const wounded = monsters.flatMap((m) => m.parts).filter((p) => p.wound !== null);
  const differ = wounded.filter((p) => ['slash', 'blunt', 'shot'].some((k) => p.wound[k] !== p.hitzone[k]));
  assert.ok(differ.length >= wounded.length * 0.9, `傷口が通常と違う部位 ${differ.length}/${wounded.length}`);
  const gog = part('ゴグマジオス', 'head').states.custom3;
  assert.deepEqual([gog.slash, gog.blunt, gog.shot, gog.dragon], [75, 75, 50, 65]);
  assert.equal(part('ゴア・マガラ', 'right-wing-legs').states.custom1.slash, 60);
  assert.equal(part('ジン・ダハド', 'tail').states.weakPoint.slash, 95);
});

test('破壊・切断・状態異常の★の抜き取り確認 (Game8 と照合済み)', () => {
  assert.equal(part('リオレウス', 'tail').severable, true);
  assert.equal(part('リオレウス', 'left-wing').breakable, true);
  assert.equal(part('リオレウス', 'head').breakable, false);
  assert.equal(part('ゴア・マガラ', 'antennae').breakable, true);
  // 切断できる部位を持つモンスターは 21 体 (MHDB の切断報酬と一致)
  assert.equal(monsters.filter((m) => m.parts.some((p) => p.severable)).length, 21);
  const gog = mon('ゴグマジオス');
  assert.deepEqual(gog.statusWeakness, { poison: 0, paralysis: 0, sleep: 0, blast: 2, stun: 1, exhaust: 0 });
  assert.equal(gog.itemEffects.flash.effective, false);
  assert.equal(gog.itemEffects.noise.effective, false);
  // 状態異常の★は 34 体とも MHDB に値がある (null で静かに埋まっていない)
  for (const m of monsters) {
    for (const [k, v] of Object.entries(m.statusWeakness)) assert.notEqual(v, null, `${m.name} ${k}`);
  }
});

test('咆哮・風圧・振動・属性やられの抜き取り確認 (wiki と Game8 が一致するもの)', () => {
  assert.equal(threat('ジン・ダハド').roar, 'strong');
  assert.equal(threat('ゴグマジオス').roar, 'strong');
  assert.equal(threat('ゴグマジオス').tremor, 'minor');
  assert.equal(threat('グラビモス').tremor, 'minor');
  assert.equal(threat('リオレウス').roar, 'weak');
  assert.equal(threat('リオレウス').windPressure, 'minor');
  assert.deepEqual(threat('リオレウス').blights.map((b) => b.element), ['fire']);
  assert.deepEqual(threat('ゾ・シア').blights.map((b) => b.element).sort(), ['fire', 'thunder']);
  // null は wiki に値が無いケマトリスだけ (ほかが null に落ちていない)
  for (const k of ['roar', 'windPressure', 'tremor']) {
    assert.deepEqual(threatsDoc.monsters.filter((x) => x[k] === null).map((x) => x.name), ['ケマトリス'], k);
  }
});

test('クエスト: 乱入の個体名つきの名前を解決・歴戦の判定は MissionData と一致・装備固定の抜き取り', () => {
  const q = questsDoc.quests;
  const byEn = (n) => q.find((x) => x.nameEn === n);
  const PREFIX = /^(Tempered|Frenzied|Arch[- ]Tempered|Alpha) /i;
  for (const x of q) {
    for (const t of x.intruders) {
      if (PREFIX.test(t.nameEn)) assert.notEqual(t.monsterId, null, `${x.id} 乱入 ${t.nameEn}`);
      assert.ok(t.variant === null || VARIANTS.includes(t.variant), `${x.id} 乱入 variant ${t.variant}`);
    }
  }
  assert.deepEqual(byEn('Frenzy Obscured').intruders.map((t) => [t.name, t.variant]),
    [['ゲリョス', 'tempered'], ['ヒラバミ', 'tempered']]);
  // MHDB ではオメガ・プラネテスの歴戦の英語名が基本種と同じなので、通常個体を歴戦と誤判定しやすい
  assert.equal(byEn('Invader from the Stars').targets[0].variant, null);
  assert.equal(byEn('Planetes Protocol (Savage)').targets[0].variant, 'tempered');
  // 歴戦/歴戦王 (alpha/frenzied は比べない) は MissionData の _LegendaryID と一致する
  const LEG = new Set(['tempered', 'arch-tempered']);
  for (const x of q) {
    if (!x.mission) continue;
    const w = x.targets.filter((t) => t.large)
      .flatMap((t) => Array(t.count).fill(`${t.monsterId}:${LEG.has(t.variant) ? t.variant : ''}`)).sort();
    const m = x.mission.targets.filter((t) => t.monsterId !== null)
      .map((t) => `${t.monsterId}:${t.variant ?? ''}`).sort();
    assert.deepEqual(w, m, x.id);
  }
  assert.equal(byEn('Event: Unchained Arkveld').fixedEquipment, true);
  assert.equal(byEn('Event: Unchained Arkveld').targets[0].variant, 'arch-tempered');
  assert.equal(byEn('Event: Unpierceable and Unstoppable').fixedEquipment, true);
});

// ---- 2026-10-21 data-fix で足した検査 ----
// (防具の限界突破スロットは armor.json だが、この段の担当ファイルがここなので一緒に置く)

test('推奨属性の同点は 主要部位の傷口の平均 → 全部位の平均 で崩す (アルシュベルド系は龍)', () => {
  for (const name of ['アルシュベルド', '護竜アルシュベルド']) {
    const r = mon(name).elementRecommendation;
    assert.deepEqual(r.best, ['dragon'], name);
    assert.equal(r.tieBreak.by, 'woundAvg', name);
    assert.deepEqual(r.tieBreak.tied, ELEMENTS, `${name} 5 属性が同点のはず`);
  }
  assert.deepEqual(mon('イャンクック').elementRecommendation.best, ['ice']);
  assert.equal(mon('イャンクック').elementRecommendation.tieBreak.by, 'allPartsAvg');
  for (const m of monsters) {
    const r = m.elementRecommendation;
    const basis = m.parts.filter((p) => r.basisParts.includes(p.key));
    const avg = (ps, k, e) => ps.reduce((s, p) => s + p[k][e], 0) / ps.length;
    const top = Math.max(...ELEMENTS.map((e) => avg(basis, 'hitzone', e)));
    const tied = ELEMENTS.filter((e) => avg(basis, 'hitzone', e) === top);
    if (tied.length <= 1) {
      assert.equal(r.tieBreak, null, `${m.name} 同点が無いのに tieBreak がある`);
      assert.deepEqual(r.best, top > 0 ? tied : [], m.name);
      continue;
    }
    // 同点を自分で崩して best と一致するか確かめる
    let cand = tied;
    const wounded = basis.filter((p) => p.wound !== null);
    const named = m.parts.filter((p) => !p.unknownPart);
    for (const [ps, k] of [[wounded, 'wound'], [named, 'hitzone']]) {
      if (ps.length === 0 || cand.length === 1) continue;
      const mx = Math.max(...cand.map((e) => avg(ps, k, e)));
      cand = cand.filter((e) => avg(ps, k, e) === mx);
    }
    assert.deepEqual(r.best, cand, m.name);
    assert.deepEqual(r.tieBreak.tied, tied, m.name);
    assert.equal(r.order[0].type, r.best[0], `${m.name} order の先頭が best と違う`);
  }
});

test('属性やられの抜けは blightsUncertain に分けて持つ (blights には足さない)', () => {
  for (const x of [...threatsDoc.monsters, ...threatsDoc.otherMonsters]) {
    const b = new Set(x.blights.map((y) => y.element));
    const expect = x.attackElements.filter((e) => !b.has(e));
    assert.deepEqual(x.blightsUncertain.map((y) => y.element), expect, x.name ?? x.nameEn);
    for (const y of x.blightsUncertain) assert.ok(y.name && y.reason, `${x.name} 理由が無い`);
  }
  assert.deepEqual(threat('アジャラカン').blightsUncertain.map((b) => b.element), ['fire']);
  assert.deepEqual(threat('ジン・ダハド').blightsUncertain.map((b) => b.element), ['ice']);
  assert.deepEqual(threat('アジャラカン').blights, []);
  assert.deepEqual(threat('リオレウス').blightsUncertain, []);
});

test('フリーチャレンジ 5 件は持ち込み装備 (fixedEquipment=false・確度 medium)', () => {
  const q = questsDoc.quests;
  const FREE = ['Burn in Blackest Hell', 'The Cold Path to Oblivion', 'The Daunting Downpour',
    'The Proud Child of the Wilds', 'The Shining Storm Rages'];
  for (const n of FREE) {
    const x = q.find((y) => y.nameEn === n);
    assert.equal(x.fixedEquipment, false, n);
    assert.equal(x.fixedEquipmentConfidence, 'medium', n);
    assert.match(x.fixedEquipmentReason, /Free Challenge/, n);
  }
  assert.equal(q.filter((x) => x.fixedEquipment === null).length, 0, '装備固定が未判定のクエストが残っている');
  assert.equal(q.filter((x) => x.fixedEquipment === false).length, EXPECT.fixedFalse);
  assert.ok(questsDoc.meta.source.some((u) => u.includes('Arena+Counter') || u.includes('Arena%20Counter')),
    'Arena Counter のページが出典に無い');
});

test('防具の限界突破スロット: 規則 (レア5 全枠+1・レア6 先頭 2 枠+1・上限 3・レア7/8 そのまま) と抜き取り', () => {
  const armorDoc = load('armor.json');
  const lb = armorDoc.meta.limitBreak;
  assert.deepEqual(lb.rarities, [5, 6, 7, 8]);
  assert.equal(lb.checks.wiki.mismatches.length, 0, 'wiki と規則が食い違う防具がある');
  assert.ok(lb.checks.wiki.compared >= 500, `wiki と比べた数が少ない: ${lb.checks.wiki.compared}`);
  const disputed = new Set(lb.disputed.map((d) => d.id));
  for (const a of armorDoc.armor) {
    if (a.rarity <= 4) {
      assert.equal(a.limitBreakable, false, a.name);
      assert.equal(a.slotsLimitBreak, null, a.name);
      continue;
    }
    assert.equal(a.limitBreakable, true, a.name);
    if (disputed.has(a.id)) {
      assert.equal(a.slotsLimitBreak, null, `${a.name} は出典が食い違うので null のはず`);
      assert.ok(a.slotsLimitBreakNote, a.name);
      continue;
    }
    const add = lb.ruleAdd[String(a.rarity)];
    assert.deepEqual(a.slotsLimitBreak, a.slots.map((s, i) => Math.min(lb.cap, s + add[i])), a.name);
  }
  const byName = (n) => armorDoc.armor.find((a) => a.name === n);
  // Game8 の片手剣の最強装備にある「(限界突破強化)」の 3 部位
  assert.deepEqual(byName('護火竜アームβ').slotsLimitBreak, [3, 2, 1]);
  assert.deepEqual(byName('護火竜グリーヴβ').slotsLimitBreak, [3, 1, 0]);
  assert.deepEqual(byName('護兇爪竜メイルβ').slotsLimitBreak, [3, 3, 0]);
  // 上限に当たる例 (余りは次の枠に回らない)・レア5・レア8
  assert.deepEqual(byName('ミツネヘルムα').slotsLimitBreak, [3, 1, 0]);
  assert.deepEqual(byName('コンガヘルムα').slotsLimitBreak, [2, 1, 1]);
  assert.deepEqual(byName('ゴグヘルムα').slotsLimitBreak, byName('ゴグヘルムα').slots);
  assert.deepEqual([...disputed].sort(), [589, 591]);
});

// ---- 2026-10-21 歴戦王 (段階2) で足した検査 ----
// 体力の値は調査 (MHWS-in-json の式で natives から再計算し、MissionData の SoloHealth と一致) と同じもの。
// 歴戦王アルシュベルドのソロ約 79,000 は第三者の実測 (switchbladegaming。照合のみ) とも合う。
const AT_NAMES = ['レ・ダウ', 'ウズ・トゥナ', 'ヌ・エグドラ', 'ジン・ダハド', 'アルシュベルド'];
const CONF = ['high', 'medium', 'low'];
const GROUPS = ['normal', 'hard', 'king', 'kingHard'];
const LEG_OF_KIND = { tempered: 'NORMAL', 'arch-tempered': 'KING', frenzied: 'NONE', alpha: 'NONE' };
const questById = new Map(questsDoc.quests.map((q) => [q.id, q]));
const ind = (name, kind) => mon(name).individuals.find((i) => i.kind === kind);

// meta.legendaryGroups の規則を JS で書き直したもの (生成側と独立に群を決め直す)
const KING_WHEN_NONE = new Set(['EM0078_00_0', 'EM0164_50_0']);
const NO_AUTO_HARD = new Set(['EM0166_00_0']);
function expectGroup(emId, leg, rank) {
  if (leg === 'NONE') return rank === 10 && KING_WHEN_NONE.has(emId) ? 'kingHard' : null;
  const auto = !NO_AUTO_HARD.has(emId);
  if (leg === 'NORMAL') return rank >= 9 && auto ? 'hard' : 'normal';
  if (leg === 'KING') return rank >= 10 && auto ? 'kingHard' : 'king';
  throw new Error(`LegendaryID ${leg}`);
}
const f32 = Math.fround;
const soloHp = (base, qh, rand, leg) => Math.ceil(f32(f32(base) * f32(qh) * f32(rand) * f32(leg)));
const missionTargets = () => questsDoc.quests.filter((q) => q.mission)
  .flatMap((q) => q.mission.targets.map((t) => ({ q, t })));

test('歴戦王は 5 体: 個体の一覧 (individuals) に通常/歴戦の個体/歴戦王などが表示名と LegendaryID つきで並ぶ', () => {
  const at = monsters.filter((m) => m.individuals.some((i) => i.kind === 'arch-tempered')).map((m) => m.name);
  assert.deepEqual([...at].sort(), [...AT_NAMES].sort());
  assert.deepEqual(monsters.filter((m) => m.variants.includes('arch-tempered')).map((m) => m.name).sort(),
    [...AT_NAMES].sort());
  for (const m of monsters) {
    const ks = m.individuals.map((i) => i.kind);
    assert.deepEqual(ks, [null, ...m.variants], `${m.name} の個体の並び`);
    const base = m.individuals[0];
    assert.deepEqual([base.label, base.name, base.legendaryId], ['通常', m.name, 'NONE'], m.name);
    for (const i of m.individuals.slice(1)) {
      assert.equal(i.legendaryId, LEG_OF_KIND[i.kind], `${m.name} ${i.kind}`);
      assert.ok(i.name && i.label && i.name !== m.name, `${m.name} ${i.kind} 表示名`);
      if (m.variantNames[i.kind] !== m.name) assert.equal(i.name, m.variantNames[i.kind], `${m.name} ${i.kind}`);
    }
  }
  for (const n of AT_NAMES) {
    assert.deepEqual([ind(n, 'arch-tempered').label, ind(n, 'arch-tempered').name], ['歴戦王', `${n}（歴戦王）`]);
    assert.equal(ind(n, 'tempered').label, '歴戦の個体');
  }
  // MHDB の歴戦の個体名が基本種と同じオメガ・プラネテスは、表示名に種類を添える
  assert.equal(ind('オメガ・プラネテス', 'tempered').name, 'オメガ・プラネテス（歴戦の個体）');
});

test('歴戦の倍率 (legendaryParams): 4 群がそろい、値は範囲内、欄が無いものだけ null', () => {
  for (const m of monsters) {
    assert.deepEqual(Object.keys(m.legendaryParams), GROUPS, m.name);
    for (const g of GROUPS) {
      const p = m.legendaryParams[g];
      const where = `${m.name} ${g}`;
      assert.ok(p.health >= 0.5 && p.health <= 1.5, `${where} health ${p.health}`);
      assert.ok(p.partsVital >= 0.8 && p.partsVital <= 1.5, `${where} partsVital ${p.partsVital}`);
      for (const k of ['attackCalm', 'attackAngry']) assert.ok(p[k] >= 0.9 && p[k] <= 2.0, `${where} ${k} ${p[k]}`);
      // 動きの速さの欄は normal / hard 群にしか無い (king 群に欄が無いことは調査で確認済み)
      if (g === 'normal' || g === 'hard') assert.ok(p.motionSpeed >= 1 && p.motionSpeed <= 1.2, `${where} motionSpeed`);
      else assert.equal(p.motionSpeed, null, `${where} motionSpeed は欄が無いので null`);
      for (const k of ['normal', 'tear']) assert.ok(p.woundVital[k] >= 1 && p.woundVital[k] <= 4, `${where} wound ${k}`);
    }
  }
  const P = (n, g) => mon(n).legendaryParams[g];
  assert.deepEqual([P('アルシュベルド', 'kingHard').health, P('アルシュベルド', 'kingHard').partsVital,
    P('アルシュベルド', 'kingHard').attackCalm], [1.265, 1.25, 1.2]);
  assert.equal(P('ウズ・トゥナ', 'kingHard').health, 1.16);
  assert.equal(P('ジン・ダハド', 'kingHard').health, 0.9);
  assert.equal(P('ヌ・エグドラ', 'king').partsVital, 1.2);
  assert.equal(P('ヌ・エグドラ', 'kingHard').motionSpeedOverride, 1.04);
  assert.equal(P('ヌ・エグドラ', 'king').motionSpeedOverride, null);
  assert.equal(P('レ・ダウ', 'king').woundVital.normal, 1.8);
  assert.equal(P('ゾ・シア', 'kingHard').health, 0.79);
  // 意味と確度の印
  const meta = monstersDoc.meta;
  assert.ok(CONF.includes(meta.legendaryGroups.confidence));
  assert.deepEqual(meta.legendaryGroups.exceptions.map((e) => e.emId).sort(),
    [...KING_WHEN_NONE, ...NO_AUTO_HARD].sort());
  for (const [k, f] of Object.entries(meta.legendaryFields)) {
    if (typeof f === 'string') continue; // notImported / nullMeaning は説明の文
    assert.ok(CONF.includes(f.confidence), `legendaryFields.${k} の確度`);
  }
});

test('クエストの群は 報酬ランク × LegendaryID の規則どおり (実行ファイルの例外を含む)', () => {
  let king = 0;
  for (const { q, t } of missionTargets()) {
    if (t.monsterId === null) continue;
    assert.ok(Number.isInteger(t.rewardRank) && t.rewardRank >= 1 && t.rewardRank <= 10, `${q.id} 報酬ランク`);
    const want = expectGroup(byId.get(t.monsterId).emId, t.legendaryId, t.rewardRank);
    assert.equal(t.paramGroup, want, `${q.id} ${t.nameJa}`);
    if (t.legendaryId === 'KING') {
      king += 1;
      assert.equal(t.paramGroupReason, 'rank');
      assert.equal(t.variant, 'arch-tempered');
    }
  }
  assert.equal(king, 15, '歴戦王の狩猟対象の行 (★8: 2 / ★9: 3 / ★10: 10)');
  const zoh = questById.get('Hope of the Ancients').mission.targets[0];
  assert.deepEqual([zoh.legendaryId, zoh.paramGroup, zoh.paramGroupReason],
    ['NONE', 'kingHard', 'exe-exception:king-when-none']);
});

test('ソロの体力: 再計算が MissionData と全行一致・JS で計算し直しても同じ・歴戦王のクエストは調査の値', () => {
  const grades = questsDoc.meta.healthGrades;
  let n = 0;
  for (const { q, t } of missionTargets()) {
    if (t.monsterId === null) continue;
    const h = t.healthCalc;
    const where = `${q.id} ${t.nameJa}`;
    assert.ok(h, `${where} healthCalc が無い`);
    n += 1;
    assert.equal(h.matchesMissionData, true, where);
    assert.ok(CONF.includes(h.confidence), where);
    const s = t.soloHealth;
    assert.deepEqual(s, [...s].sort((a, b) => a - b), `${where} soloHealth が昇順でない`);
    assert.deepEqual([h.min, h.max], [s[0], s[s.length - 1]], where);
    assert.ok(s.includes(h.mid), `${where} mid ${h.mid}`);
    const g = grades[h.adjustRange];
    assert.equal(g.probs.length, s.length, `${where} 等級の数`);
    assert.equal(g.probs.reduce((a, b) => a + b, 0), 100);
    const m = byId.get(t.monsterId);
    const leg = t.paramGroup ? m.legendaryParams[t.paramGroup].health : 1.0;
    assert.deepEqual(g.rates.map((r) => soloHp(m.baseHealth, t.health, r, leg)), s, `${where} JS で再計算`);
    assert.equal(soloHp(m.baseHealth, t.health, 1.0, leg), h.mid, `${where} mid を JS で再計算`);
  }
  assert.ok(n >= 200, `体力のある狩猟対象が少ない: ${n}`);
  const HP = {
    'A Silent Flash|レ・ダウ': [35550, 35550, 35550],
    'These Roots Run Deep|ウズ・トゥナ': [49500, 47520, 51480],
    'Be Cursed, Ye Shadowy Flame|ヌ・エグドラ': [47250, 45360, 49140],
    'Heart of Judecca|ジン・ダハド': [65120, 62516, 67725],
    'Event: Dreams May Soar|ヌ・エグドラ': [16275, 16275, 16275],
    'Ruler of the Desert Kingdom|レ・ダウ': [54675, 54675, 54675],
    'Summons from the Land Beyond|ウズ・トゥナ': [77517, 77517, 77517],
    'Scion of the Dark Cradle|ヌ・エグドラ': [66977, 66977, 66977],
    'Frozen Knells of the East|ジン・ダハド': [73593, 73593, 73593],
    'Freedom from Solitude|アルシュベルド': [79923, 76726, 83120],
    'Event: Unchained Arkveld|アルシュベルド': [28944, 28944, 28944],
    'Proof of a Hero|レ・ダウ': [32850, 32850, 32850],
    'Proof of a Hero|ウズ・トゥナ': [46574, 46574, 46574],
    'Proof of a Hero|ヌ・エグドラ': [40242, 40242, 40242],
    'Proof of a Hero|アルシュベルド': [71701, 71701, 71701],
  };
  for (const [k, v] of Object.entries(HP)) {
    const [qid, name] = k.split('|');
    const t = questById.get(qid).mission.targets.find((x) => x.nameJa === name && x.legendaryId === 'KING');
    assert.deepEqual([t.healthCalc.mid, t.healthCalc.min, t.healthCalc.max], v, k);
    assert.equal(t.healthCalc.confidence, 'medium', k);
  }
  // フリーチャレンジ (MissionData に無い) は体力不明のまま (仮の値で埋めない)
  assert.equal(questById.get('The Proud Child of the Wilds').mission, null);
});

test('個体ごとのクエスト: questIds と quests.json の狩猟対象が両方向で一致・歴戦王のクエストは 17 件', () => {
  for (const m of monsters) {
    for (const i of m.individuals) {
      const where = `${m.name} ${i.kind}`;
      const want = questsDoc.quests.filter((q) => q.targets.some((t) => t.large && t.monsterId === m.id
        && t.variant === i.kind)).map((q) => q.id);
      assert.deepEqual([...i.questIds].sort(), want.sort(), `${where} questIds`);
      const wantI = questsDoc.quests.filter((q) => q.intruders.some((t) => t.monsterId === m.id
        && t.variant === i.kind)).map((q) => q.id);
      assert.deepEqual([...i.intruderQuestIds].sort(), wantI.sort(), `${where} intruderQuestIds`);
      assert.deepEqual(i.stars, [...new Set(i.questIds.map((id) => questById.get(id).stars))].sort((a, b) => a - b));
      for (const r of i.rates) {
        assert.ok(CONF.includes(r.healthConfidence) && CONF.includes(r.attackConfidence), `${where} 確度`);
        assert.equal(r.health, r.group ? m.legendaryParams[r.group].health : 1.0, `${where} ${r.group}`);
        // (2026-10-21 照合の指摘) 攻撃・部位の耐久の倍率も legendaryParams の群の値と同じ (群なしは null)
        const lp = r.group ? m.legendaryParams[r.group] : null;
        assert.deepEqual([r.attackCalm, r.attackAngry, r.partsVital],
          lp ? [lp.attackCalm, lp.attackAngry, lp.partsVital] : [null, null, null], `${where} ${r.group} 攻撃・部位`);
        assert.ok(i.groupByRank.some((g) => g.group === r.group
          && r.rewardRanks.every((x) => x >= g.min && x <= g.max)), `${where} groupByRank`);
      }
      // 肉質の印: null で確度も null = 未調査 (狂竜化・ボス個体)。null で確度 low = 置き換えがあるのに条件が分からない
      const hz = i.hitzone;
      assert.deepEqual(Object.keys(hz).filter((k) => k !== 'note'),
        ['sameAsBase', 'confidence', 'woundOverrides', 'elementRecommendation'], `${where} hitzone の形`);
      if (hz.sameAsBase === null && hz.confidence === null) {
        assert.ok(['frenzied', 'alpha'].includes(i.kind), `${where} 未調査は狂竜化・ボス個体だけ`);
        assert.equal(hz.woundOverrides, null, where);
      } else {
        assert.ok(CONF.includes(hz.confidence), `${where} 肉質の確度`);
      }
      assert.equal(hz.woundOverrides === null, hz.elementRecommendation === null, `${where} 置き換えと推奨の有無`);
      if (hz.sameAsBase === true) assert.equal(hz.woundOverrides, null, `${where} 同じなのに置き換えがある`);
      if (hz.sameAsBase === false) assert.ok(hz.woundOverrides, `${where} 違うのに置き換えが無い`);
      if (hz.sameAsBase === null && hz.confidence !== null) {
        assert.equal(hz.confidence, 'low', where);
        assert.ok(hz.woundOverrides && hz.note, `${where} 条件不明の置き換えは参考値と注記を持つ`);
      }
    }
  }
  const AT_QUESTS = {
    'レ・ダウ': ['A Silent Flash', 'The Shining Storm Rages', 'Proof of a Hero', 'Ruler of the Desert Kingdom'],
    'ウズ・トゥナ': ['The Daunting Downpour', 'These Roots Run Deep', 'Proof of a Hero', 'Summons from the Land Beyond'],
    'ヌ・エグドラ': ['Be Cursed, Ye Shadowy Flame', 'Burn in Blackest Hell', 'Event: Dreams May Soar', 'Proof of a Hero',
      'Scion of the Dark Cradle'],
    'ジン・ダハド': ['Heart of Judecca', 'The Cold Path to Oblivion', 'Frozen Knells of the East'],
    'アルシュベルド': ['Event: Unchained Arkveld', 'Freedom from Solitude', 'Proof of a Hero', 'The Proud Child of the Wilds'],
  };
  for (const [n, qs] of Object.entries(AT_QUESTS)) assert.deepEqual(ind(n, 'arch-tempered').questIds, qs, n);
  assert.equal(new Set(Object.values(AT_QUESTS).flat()).size, 17);
  assert.deepEqual(ind('アルシュベルド', 'arch-tempered').rates.map((r) => r.group), ['kingHard']);
  assert.deepEqual(ind('レ・ダウ', 'arch-tempered').rates.map((r) => [r.group, r.rewardRanks]),
    [['king', [8]], ['kingHard', [10]]]);
  // 肉質の個別の値は「傷口の肉質の置き換え」のテスト
  assert.ok(monstersDoc.meta.individualsHitzone.reason.includes('Param_Legendary'));
  assert.ok(monstersDoc.meta.individualsHitzone.reason.includes('Param_Unique'));
});

// ---- 2026-10-21 照合の指摘で足した検査 (歴戦王の肉質・報酬の対応・倍率) ----
// 以前は「歴戦王の肉質は通常と同じ (確度 high)」としていたが、Param_Unique に傷口の肉質の置き換え (_ScarMeatConvert) があった。
// 値は照合役が生データ (MHWS-in-json @4a99b26 の Em0157_00 / Em0160_00 の Param_Unique と Param_Parts) から読んだものと同じ。
const pick = (hz, ks) => Object.fromEntries(ks.map((k) => [k, hz[k]]));
// 推奨属性を自分で計算し直す (主要部位の平均 → 同点は 傷口の平均 → 全部位の平均。生成側 recommend_element と同じ規則)
function expectBest(parts, basisKeys) {
  const avg = (ps, k, e) => ps.reduce((s, p) => s + p[k][e], 0) / ps.length;
  const basis = parts.filter((p) => basisKeys.includes(p.key));
  const top = Math.max(...ELEMENTS.map((e) => avg(basis, 'hitzone', e)));
  let cand = ELEMENTS.filter((e) => avg(basis, 'hitzone', e) === top);
  if (top <= 0) return [];
  const wounded = basis.filter((p) => p.wound !== null);
  const named = parts.filter((p) => !p.unknownPart);
  for (const [ps, k] of [[wounded, 'wound'], [named, 'hitzone']]) {
    if (ps.length === 0 || cand.length === 1) continue;
    const mx = Math.max(...cand.map((e) => avg(ps, k, e)));
    cand = cand.filter((e) => avg(ps, k, e) === mx);
  }
  return cand;
}

test('傷口の肉質の置き換え (woundConversions): ウズ・トゥナは歴戦王の群・アルシュベルドは条件不明', () => {
  for (const m of monsters) {
    assert.ok(Array.isArray(m.woundConversions), `${m.name} woundConversions`);
    for (const c of m.woundConversions) {
      const where = `${m.name} ${c.scope}`;
      assert.ok(['arch-tempered', 'unknown'].includes(c.scope), where);
      assert.equal(c.groups === null, c.scope === 'unknown', `${where} groups`);
      assert.ok(CONF.includes(c.confidence) && c.condition && c.internal.includes('_ScarMeatConvert'), where);
      assert.match(c.source, /^https:\/\/github\.com\/dzxrly\/MHWS-in-json\/blob\/[0-9a-f]{40}\/.*_Param_Unique\.user\.3\.json$/);
      const keys = c.parts.map((p) => p.key);
      assert.equal(new Set(keys).size, keys.length, `${where} 部位の重複`);
      for (const p of c.parts) {
        const part = m.parts.find((x) => x.key === p.key);
        assert.ok(part && part.wound, `${where} ${p.key} は傷口のある部位`);
        assert.deepEqual(p.before, part.wound, `${where} ${p.key} 置き換え前 = parts[].wound`);
        assertHitzone(p.after, `${where} ${p.key}.after`);
        assert.deepEqual(p.changed, HZ_KEYS.filter((k) => p.before[k] !== p.after[k]), `${where} ${p.key} changed`);
        assert.ok(p.changed.length > 0, `${where} ${p.key} 何も変わらない置き換え`);
      }
      // 置き換え後の傷口で推奨属性を計算し直したものと一致
      const conv = m.parts.map((p) => ({ ...p, wound: c.parts.find((x) => x.key === p.key)?.after ?? p.wound }));
      assert.deepEqual(c.elementRecommendation.best, expectBest(conv, c.elementRecommendation.basisParts), `${where} 推奨`);
    }
  }
  // 置き換えがあるのは 2 体だけ (34 体の Param_Unique を走査した結果。ゲームの更新で増えたら見直す)
  assert.deepEqual(monsters.filter((m) => m.woundConversions.length).map((m) => m.name).sort(),
    ['アルシュベルド', 'ウズ・トゥナ'].sort());
  const [uth] = mon('ウズ・トゥナ').woundConversions;
  assert.deepEqual([uth.scope, uth.groups, uth.confidence], ['arch-tempered', ['king', 'kingHard'], 'medium']);
  assert.deepEqual(uth.parts.map((p) => p.key),
    ['head', 'torso', 'right-front-leg', 'left-front-leg', 'right-hind-leg', 'left-hind-leg', 'tail']);
  const K = ['slash', 'blunt', 'shot', 'thunder'];
  assert.deepEqual([pick(uth.parts[0].before, K), pick(uth.parts[0].after, K)],
    [{ slash: 88, blunt: 90, shot: 88, thunder: 25 }, { slash: 88, blunt: 90, shot: 70, thunder: 20 }]);
  for (const p of uth.parts.slice(1)) {
    assert.deepEqual([pick(p.before, K), pick(p.after, K)],
      [{ slash: 80, blunt: 80, shot: 80, thunder: 25 }, { slash: 80, blunt: 80, shot: 65, thunder: 20 }], p.key);
  }
  assert.deepEqual(uth.unmatched, []);
  assert.deepEqual(uth.elementRecommendation.best, ['thunder']);
  const [ark] = mon('アルシュベルド').woundConversions;
  assert.deepEqual([ark.scope, ark.groups, ark.confidence], ['unknown', null, 'low']);
  assert.equal(ark.parts.length, 9);
  for (const k of ['left-wing-blade', 'right-wing-blade']) {
    const p = ark.parts.find((x) => x.key === k);
    assert.deepEqual([p.before.dragon, p.after.dragon, p.changed], [38, 30, ['dragon']], k);
    assert.deepEqual(ELEMENTS.map((e) => p.after[e]), [30, 30, 30, 30, 30], k);
  }
  const torso = ark.parts.find((x) => x.key === 'torso');
  assert.deepEqual([pick(torso.before, ELEMENTS), pick(torso.after, ELEMENTS)],
    [{ fire: 5, water: 5, thunder: 10, ice: 5, dragon: 15 }, { fire: 10, water: 10, thunder: 10, ice: 10, dragon: 10 }]);
  assert.equal(ark.unmatched.length, 1);
  // 置き換え後は傷口では崩れず、全部位の平均で龍のまま
  assert.deepEqual([ark.elementRecommendation.best, ark.elementRecommendation.tieBreak.by], [['dragon'], 'allPartsAvg']);
  // 護竜アルシュベルドは同じ Param_Parts を使うが、置き換えは空
  assert.deepEqual(mon('護竜アルシュベルド').woundConversions, []);
});

test('個体の肉質 (hitzone): 歴戦王ウズ・トゥナは傷口が変わる・歴戦王アルシュベルドは未確定・ほかは同じ', () => {
  const HZ = {
    'ウズ・トゥナ': { tempered: [true, 'high'], 'arch-tempered': [false, 'medium'] },
    'アルシュベルド': { tempered: [true, 'medium'], 'arch-tempered': [null, 'low'] },
    'レ・ダウ': { tempered: [true, 'high'], 'arch-tempered': [true, 'medium'] },
    'ヌ・エグドラ': { tempered: [true, 'high'], 'arch-tempered': [true, 'medium'] },
    'ジン・ダハド': { tempered: [true, 'high'], 'arch-tempered': [true, 'medium'] },
  };
  for (const m of monsters) {
    for (const i of m.individuals) {
      const where = `${m.name} ${i.kind}`;
      const want = i.kind === null ? [true, 'high']
        : ['frenzied', 'alpha'].includes(i.kind) ? [null, null]
          : HZ[m.name]?.[i.kind] ?? [true, 'high'];
      assert.deepEqual([i.hitzone.sameAsBase, i.hitzone.confidence], want, where);
      if (!i.hitzone.woundOverrides) continue;
      // woundOverrides は woundConversions の置き換え後の値と同じ
      const c = m.woundConversions.find((x) => (x.groups ?? []).some((g) => ['king', 'kingHard'].includes(g))
        || x.scope === 'unknown');
      assert.deepEqual(i.hitzone.woundOverrides, Object.fromEntries(c.parts.map((p) => [p.key, p.after])), where);
      assert.deepEqual(i.hitzone.elementRecommendation, c.elementRecommendation, where);
      // 歴戦王の出るクエストの群は置き換えの群に入っている
      if (c.groups) for (const r of i.rates) assert.ok(c.groups.includes(r.group), `${where} ${r.group}`);
    }
  }
  const uth = ind('ウズ・トゥナ', 'arch-tempered').hitzone;
  assert.deepEqual([uth.woundOverrides.head.shot, uth.woundOverrides.head.thunder, uth.woundOverrides.tail.shot], [70, 20, 65]);
  assert.equal(ind('ウズ・トゥナ', 'tempered').hitzone.woundOverrides, null);
  assert.equal(ind('アルシュベルド', 'arch-tempered').hitzone.woundOverrides['left-wing-blade'].dragon, 30);
  assert.ok(ind('アルシュベルド', 'arch-tempered').hitzone.note);
  assert.ok(ind('アルシュベルド', 'tempered').hitzone.note);
});

test('歴戦王の報酬の対応: 狩猟証γ と固定護石はモンスターごとに固定 (入れ替わりを検出する)', () => {
  const REW = {
    'レ・ダウ': [664, '煌雷竜の狩猟証γ', [61, 66]],
    'ウズ・トゥナ': [702, '波衣竜の狩猟証γ', [168, 170]],
    'ヌ・エグドラ': [722, '獄焔蛸の狩猟証γ', [178, 179]],
    'ジン・ダハド': [773, '凍峰竜の狩猟証γ', [182, 185]],
    'アルシュベルド': [787, '鎖刃竜の狩猟証γ', [186, 187]],
  };
  for (const [n, [itemId, name, charms]] of Object.entries(REW)) {
    const rw = ind(n, 'arch-tempered').rewards;
    assert.deepEqual([rw.certificate.itemId, rw.certificate.name, rw.charmFixedIds], [itemId, name, charms], n);
  }
});

test('攻撃の倍率は全行 クエストの attack × 群の倍率 (JS で計算し直す)', () => {
  let n = 0;
  for (const { q, t } of missionTargets()) {
    if (!t.attackRate) continue;
    const lp = byId.get(t.monsterId).legendaryParams[t.paramGroup];
    const r4 = (x) => Math.round(x * 1e4) / 1e4;
    assert.deepEqual([t.attackRate.calm, t.attackRate.angry], [r4(t.attack * lp.attackCalm), r4(t.attack * lp.attackAngry)],
      `${q.id} ${t.nameJa} ${t.paramGroup}`);
    n += 1;
  }
  assert.ok(n >= 90, `攻撃の倍率のある行が少ない: ${n}`);
});

test('マルチの倍率: 表 (tableId) ごとに値を固定・全部同じ値の表はオメガ・プラネテスとゴグマジオスの 4 人クエストだけ', () => {
  // MissionData.xlsx (@4a99b26) の _MultiTableId ごとの _Count = 2〜4 の _Health / _PartsVital
  const TABLES = {
    '148912cc-e71c-4088-a195-7db49568ebcd': [[1.6, 2, 2.4], [1.9, 2.4, 3]],
    '75f3e189-f33e-4d16-bc32-ccaf89819571': [[1.6, 2, 2.4], [1.5, 2.4, 3]],
    '15789b29-d7df-4354-8e1e-64999b31ab49': [[1.6, 2, 2.4], [2, 2.7, 3.5]],
    '9707f21b-55da-4695-85a9-7f050b8c2660': [[1.7, 2.16, 2.6], [1.94, 2.55, 3.2]],
    '7bb1dd59-b215-4582-83b1-26c380007058': [[1.72, 2.22, 2.7], [2, 2.7, 3.5]],
    '3911dbb2-1db0-4f33-9b84-9800098e9f54': [[1.86, 2.36, 2.85], [2, 2.7, 3.5]],
    'c8c02f62-d546-495a-9539-ff78095d824f': [[1.86, 2.36, 2.85], [2, 2.7, 3.5]],
    'a5295449-1a03-4530-a664-87de66f511c7': [[1.88, 2.43, 3], [2, 2.7, 3.5]],
    'ca85dc0e-14a2-42a3-95be-a4914fb90f5e': [[1.88, 2.43, 3], [2, 2.7, 3.5]],
    'dbf9de7e-cb9b-4ede-b4f7-4ae23ad4644c': [[1.88, 2.43, 3], [2, 2.7, 3.5]],
    '473e14cf-ca0c-4bed-9148-5acd7b13a288': [[1.55, 1.55, 1.55], [1.87, 1.87, 1.87]],
    'd260b065-ab87-49c0-a2bb-ba01e6836ec1': [[1.8, 1.8, 1.8], [2.17, 2.17, 2.17]],
    '46061a24-013b-41cc-a99b-e9a3efa82442': [[1, 1, 1], [1, 1, 1]],
  };
  const flatOwners = new Set();
  for (const { q, t } of missionTargets()) {
    if (!t.multi) continue;
    const where = `${q.id} ${t.nameJa}`;
    const tb = TABLES[t.multi.tableId];
    assert.ok(tb, `${where} 知らない表 ${t.multi.tableId}`);
    const counts = [2, 3, 4].filter((c) => c <= (q.mission.maxPlayers ?? 4));
    assert.deepEqual(Object.keys(t.multi.health), counts.map(String), `${where} 人数`);
    for (const c of counts) {
      assert.equal(t.multi.health[c], tb[0][c - 2], `${where} 体力 ${c} 人`);
      assert.equal(t.multi.partsVital[c], tb[1][c - 2], `${where} 部位 ${c} 人`);
    }
    if (new Set(tb[0]).size === 1) flatOwners.add(`${t.nameJa}/${q.mission.maxPlayers}`);
  }
  assert.deepEqual([...flatOwners].sort(), ['オメガ・プラネテス/4', 'ゴグマジオス/4']);
  // 2 人までのクエストは人数で増える表 (以前の「全部同じ値の表」は誤り)
  for (const { q, t } of missionTargets()) {
    if (t.multi && q.mission.maxPlayers === 2) {
      const h = TABLES[t.multi.tableId][0];
      assert.ok(h[0] < h[1] && h[1] < h[2], `${q.id} 2 人までのクエストの表`);
    }
  }
  assert.ok(!questsDoc.meta.multiNote.includes('2 人までのクエストは全部同じ値'));
});

test('meta: Param_Legendary の null の意味・Param_Unique の歴戦王の項目 (取り込まない) の一覧', () => {
  const lf = monstersDoc.meta.legendaryFields;
  assert.ok(lf.nullMeaning.includes('欄が無い'));
  assert.ok(lf.guardPowerAdd.meaning.includes('_AddGuardPower'));
  const u = lf.uniqueParams.byMonster;
  assert.equal(u['ウズ・トゥナ']['_LegendaryParam_King._VeilVitalRate'], 2.4);
  assert.equal(u['ウズ・トゥナ']['_LegendaryParam_King._AddGuardPower'], 40);
  assert.equal(u['ヌ・エグドラ']._LostFrontHalfVitalRate_King, 0.5);
  assert.equal(u['レ・ダウ'].BreakEnchantRate_LegendaryKing, 0.25);
  assert.equal(u['アルシュベルド'].BladeVitalRate_King, 1.2);
  for (const [n, vals] of Object.entries(u)) {
    for (const [k, v] of Object.entries(vals)) {
      assert.ok(/King|Legendary/.test(k), `${n} ${k}`);
      assert.equal(typeof v, 'number', `${n} ${k}`);
    }
  }
  // 群に関係しないと見て取り込まない肉質の項目 (ゴグマジオス) の注記
  assert.ok(monstersDoc.meta.uniqueIgnored.includes('ゴグマジオス'));
});

test('歴戦王の追加日と報酬: γ 防具 5 部位 (ヌシの魂) と狩猟証γ の固定護石', () => {
  const armorDoc = load('armor.json');
  const armorById = new Map(armorDoc.armor.map((a) => [a.id, a]));
  const fixedIds = new Set(load('charms_fixed.json').charms.map((c) => c.id));
  const SETS = { 'レ・ダウ': 91, 'ウズ・トゥナ': 164, 'ヌ・エグドラ': 174, 'ジン・ダハド': 185, 'アルシュベルド': 193 };
  const VER = { 'レ・ダウ': '1.010', 'ウズ・トゥナ': '1.020', 'ヌ・エグドラ': '1.030', 'ジン・ダハド': '1.040',
    'アルシュベルド': '1.041' };
  const allArmor = [];
  const allCharms = [];
  for (const n of AT_NAMES) {
    const i = ind(n, 'arch-tempered');
    const rw = i.rewards;
    assert.match(rw.certificate.name, /狩猟証γ$/, n);
    assert.deepEqual(rw.armorSets.map((s) => s.armorSetId), [SETS[n]], n);
    for (const id of rw.armorSets[0].armorIds) {
      const a = armorById.get(id);
      assert.ok(a, `${n} 防具 ${id} が armor.json に無い`);
      assert.equal(a.armorSetId, SETS[n], `${n} ${a.name}`);
      assert.equal(a.groupBonusId, 30, `${n} ${a.name} ヌシの魂`);
      allArmor.push(id);
    }
    assert.equal(rw.armorSets[0].armorIds.length, 5, n);
    assert.deepEqual(rw.groupSkills, [{ skillId: 131, name: 'ヌシの魂' }]);
    for (const c of rw.charmFixedIds) assert.ok(fixedIds.has(c), `${n} 固定護石 ${c}`);
    allCharms.push(...rw.charmFixedIds);
    assert.equal(i.added.version, VER[n], n);
    assert.match(i.added.date, /^20\d\d-\d\d-\d\d$/, n);
    assert.ok(CONF.includes(i.added.dateConfidence), n);
    assert.ok(i.added.sources.length > 0 && i.added.sources.every((u) => u.startsWith('https://')), n);
    for (const u of i.added.sources) assert.ok(!/game8|kiranico/i.test(u), `${n} 照合のみの出典を取り込んでいる`);
    assert.equal(i.star10.version, '1.041', n);
  }
  // ヌシの魂の防具は γ の 25 部位だけ
  assert.deepEqual(allArmor.sort((a, b) => a - b),
    armorDoc.armor.filter((a) => a.groupBonusId === 30).map((a) => a.id).sort((a, b) => a - b));
  assert.deepEqual(allCharms.sort((a, b) => a - b), [61, 66, 168, 170, 178, 179, 182, 185, 186, 187]);
});

test('歴戦王の脅威: 5 体に variants があり、防げるスキルは rules と同じ形・確度と出典つき', () => {
  const skills = new Map(load('skills.json').skills.map((s) => [s.id, s]));
  for (const x of threatsDoc.monsters) {
    assert.ok(x.variants && typeof x.variants === 'object', `${x.name} variants`);
    assert.equal('arch-tempered' in x.variants, AT_NAMES.includes(x.name), x.name);
  }
  for (const n of AT_NAMES) {
    const v = threat(n).variants['arch-tempered'];
    assert.equal(v.name, `${n}（歴戦王）`);
    assert.ok(v.moveChanges.length >= 4, `${n} 行動の変化`);
    for (const c of v.moveChanges) assert.ok(typeof c.text === 'string' && c.text && c.textEn, `${n} 訳の抜け`);
    assert.ok(CONF.includes(v.sameAsBase.confidence) && v.sameAsBase.reason, n);
    for (const h of v.hazards) {
      assert.ok(CONF.includes(h.confidence) && h.source.startsWith('https://monsterhunterwiki.org/'), `${n} ${h.key}`);
      assert.equal(typeof h.oneShot, 'boolean');
      if (h.skill) {
        assert.equal(skills.get(h.skill.skillId).name, h.skill.skill, `${n} ${h.key} スキル名`);
        assert.ok(Number.isInteger(h.skill.negateLevel), `${n} ${h.key}`);
      } else {
        assert.ok(h.noSkill, `${n} ${h.key} 防げないときの文`);
      }
    }
    assert.equal(ind(n, 'arch-tempered').threatVariant, 'arch-tempered');
  }
  const nu = threat('ヌ・エグドラ').variants['arch-tempered'].hazards.find((h) => h.key === 'ignited-aura');
  assert.deepEqual([nu.skill.skillId, nu.skill.skill, nu.skill.negateLevel], [88, '環境適応', 2]);
  const jin = threat('ジン・ダハド').variants['arch-tempered'].hazards;
  const frost = threatsDoc.rules.status.frostblight;
  const fw = jin.find((h) => h.key === 'frostblight-whirlwind');
  assert.deepEqual([fw.skill.skillId, fw.skill.negateLevel], [frost.skillId, frost.negateLevel]);
  const nova = jin.find((h) => h.key === 'nova');
  assert.deepEqual([nova.oneShot, nova.skill], [true, null]);
  assert.deepEqual(threat('レ・ダウ').variants['arch-tempered'].hazards, []);
  assert.deepEqual(threat('リオレウス').variants, {});
});

test('マルチ・攻撃の倍率は確度 low の目安・ダメージ補正は全行 1', () => {
  for (const { q, t } of missionTargets()) {
    if (t.monsterId === null) continue;
    const where = `${q.id} ${t.nameJa}`;
    assert.equal(t.attackRate === null, t.paramGroup === null, `${where} attackRate`);
    if (t.attackRate) assert.equal(t.attackRate.confidence, 'low', where);
    const mu = t.multi;
    if (!mu) continue;
    assert.equal(mu.confidence, 'low', where);
    const ks = Object.keys(mu.health);
    assert.deepEqual(ks, Object.keys(mu.partsVital), where);
    assert.ok(ks.every((k) => Number(k) >= 2 && Number(k) <= (q.mission.maxPlayers ?? 4)), `${where} 人数`);
    const hs = ks.map((k) => mu.health[k]);
    assert.ok(hs.every((h, i) => h >= 1 && (i === 0 || h >= hs[i - 1])), `${where} 人数で減っている`);
  }
  const fs = questById.get('Freedom from Solitude').mission.targets[0];
  assert.deepEqual(fs.multi.health, { 2: 1.88, 3: 2.43, 4: 3 });
  assert.deepEqual([fs.attackRate.calm, fs.attackRate.angry], [8.4, 8.4]);
  const dm = questById.get('Event: Dreams May Soar').mission;
  assert.equal(dm.maxPlayers, 2);
  assert.deepEqual(Object.keys(dm.targets[2].multi.health), ['2']);
  const chk = questsDoc.meta.damageRateCheck;
  assert.ok(chk.rows >= 200, `ダメージ補正を見た行が少ない: ${chk.rows}`);
  assert.deepEqual(chk.notOne, []);
});

test('配信状況 (availability) と種別: 歴戦王のクエストの抜き取り', () => {
  const STATUS = ['permanent', 'inactive', 'active', 'standard', 'unknown'];
  assert.match(questsDoc.meta.availabilityAsOf, /^\d{4}-\d{2}-\d{2}$/);
  for (const q of questsDoc.quests) {
    const a = q.availability;
    assert.ok(STATUS.includes(a.status), `${q.id} ${a.status}`);
    for (const p of a.periods) if (p.from && p.to) assert.ok(p.from <= p.to, `${q.id} 期間`);
    if (a.status === 'standard') assert.deepEqual(a.periods, [], q.id);
  }
  const av = (id) => questById.get(id).availability;
  assert.equal(av('Freedom from Solitude').status, 'permanent');
  assert.equal(av('Proof of a Hero').status, 'standard');
  assert.deepEqual([av('Event: Unchained Arkveld').status, av('Event: Unchained Arkveld').permanentFrom],
    ['permanent', '2026-08-04']);
  assert.equal(av('The Proud Child of the Wilds').status, 'inactive');
  assert.deepEqual(av('The Proud Child of the Wilds').periods.map((p) => [p.from, p.to]), [['2026-03-18', '2026-04-01']]);
  assert.deepEqual(av('The Cold Path to Oblivion').periods.map((p) => [p.from, p.to]),
    [['2026-01-06', '2026-01-20'], ['2026-09-23', '2026-10-07']]);
  for (const id of ['These Roots Run Deep', 'Summons from the Land Beyond']) {
    const q = questById.get(id);
    assert.deepEqual([q.category, q.categoryBucket], ['event', 'optional'], id);
  }
});
