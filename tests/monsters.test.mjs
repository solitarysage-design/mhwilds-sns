// モンスター担当のデータ (data/monsters.json, data/monster_threats.json, data/quests.json) の構造検査。
// 実行: node --test tests/
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
const EXPECT = { monsters: 34, quests: 220, multiQuests: 34, fixedTrue: 17 };

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
