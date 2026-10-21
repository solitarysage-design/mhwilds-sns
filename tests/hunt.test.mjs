// 相手の体力・討伐までの回数・個体の肉質・クエストの選び方 (app/model/hunt.js) のテスト。docs/RECOMMEND_DESIGN.md 6.1 節。
// 実行: node --test tests/*.test.mjs  (Node 24 では tests/ とディレクトリで渡すと落ちる)
// 数字は 2026-10-21 のデータ (quests.json の mission.targets[].healthCalc・monsters.json の individuals) の値。
// どれもこのリポのデータ (MHWS-in-json / Monster Hunter Wiki) から作った値で、Game8・Kiranico の値は入れていない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as H from '../app/model/hunt.js';

// HUNT_TEST_DATA で別の場所 (変異を入れたコピー等) を検査できる
const DATA = process.env.HUNT_TEST_DATA ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const load = (name) => JSON.parse(readFileSync(join(DATA, name), 'utf8'));
const monstersDoc = load('monsters.json');
const questsDoc = load('quests.json');

// data.js の target データと同じ形 (lists と index) と、ファイル丸ごとの形の両方で確かめる
const raw = { monsters: monstersDoc, quests: questsDoc };
const td = {
  ...raw,
  lists: { monsters: monstersDoc.monsters, quests: questsDoc.quests },
  index: {
    monsters: new Map(monstersDoc.monsters.map((m) => [m.id, m])),
    quests: new Map(questsDoc.quests.map((q) => [q.id, q])),
  },
};
const mon = (id) => H.monsterById(td, id);
const quest = (id) => H.questById(td, id);

const REY_DAU = 3;
const UTH_DUNA = 25;
const JIN_DAHAAD = 26;
const NU_UDRA = 27;
const ARKVELD = 20;
const AT = 'arch-tempered';

// 歴戦王を選んだときに自動で選ぶクエスト (★10 の単体クエスト。docs/RECOMMEND_DESIGN.md 2.2 節)
const DEFAULT_AT_QUEST = {
  [REY_DAU]: { id: 'Ruler of the Desert Kingdom', name: '楼蘭の睥睨者' },
  [UTH_DUNA]: { id: 'Summons from the Land Beyond', name: 'トゥオネラの番人より告ぐ' },
  [NU_UDRA]: { id: 'Scion of the Dark Cradle', name: '黒き揺り篭の吾子' },
  [JIN_DAHAAD]: { id: 'Frozen Knells of the East', name: '東方の鐘冴ゆ道は凍えけり' },
  [ARKVELD]: { id: 'Freedom from Solitude', name: '孤独から出でし君という自由' },
};

// 歴戦王のクエスト 11 件 (単体) のソロの体力 (docs/RECOMMEND_DESIGN.md 6.1 節)
const AT_QUEST_HEALTH = {
  'A Silent Flash': 35550,
  'These Roots Run Deep': 49500,
  'Be Cursed, Ye Shadowy Flame': 47250,
  'Heart of Judecca': 65120,
  'Event: Dreams May Soar': 16275, // 多頭のうちヌ・エグドラの歴戦王の行
  'Ruler of the Desert Kingdom': 54675,
  'Summons from the Land Beyond': 77517,
  'Scion of the Dark Cradle': 66977,
  'Frozen Knells of the East': 73593,
  'Freedom from Solitude': 79923,
  'Event: Unchained Arkveld': 28944,
};
// 『英雄の証』の 4 体 (レ・ダウ / ウズ・トゥナ / ヌ・エグドラ / アルシュベルド。どれも歴戦王)
const PROOF_OF_A_HERO = [[REY_DAU, 32850], [UTH_DUNA, 46574], [NU_UDRA, 40242], [ARKVELD, 71701]];

// ---------------------------------------------------------------- 個体

test('歴戦王の 5 体: 個体の一覧に「歴戦王」があり、先頭は通常', () => {
  for (const id of [REY_DAU, UTH_DUNA, NU_UDRA, JIN_DAHAAD, ARKVELD]) {
    const list = H.individualsOf(mon(id));
    assert.equal(list[0].kind, null, `${id}: 先頭が通常でない`);
    assert.equal(list[0].label, '通常');
    const at = list.find((i) => i.kind === AT);
    assert.ok(at, `${mon(id).name}: 歴戦王が無い`);
    assert.equal(at.label, '歴戦王');
    assert.equal(at.name, `${mon(id).name}（歴戦王）`);
    assert.ok(at.stars.includes(10), `${at.name}: ★10 が無い`);
    assert.ok(at.questCount >= 3, `${at.name}: クエストが少ない (${at.questCount})`);
    assert.equal(H.individualOf(mon(id), AT).kind, AT);
    assert.equal(H.individualOf(mon(id)).kind, null, 'kind を省くと通常');
  }
  // 歴戦王は 5 体だけ
  const withAt = monstersDoc.monsters.filter((m) => H.individualsOf(m).some((i) => i.kind === AT)).map((m) => m.id).sort((a, b) => a - b);
  assert.deepEqual(withAt, [REY_DAU, ARKVELD, UTH_DUNA, JIN_DAHAAD, NU_UDRA].sort((a, b) => a - b));
  // 個体の無いモンスター・知らない個体
  assert.deepEqual(H.individualsOf(null), []);
  assert.equal(H.individualOf(mon(REY_DAU), 'alpha'), null);
});

test('defaultQuestId: 歴戦王は ★10 の単体クエスト (アルシュベルド → 『孤独から出でし君という自由』)', () => {
  for (const [id, want] of Object.entries(DEFAULT_AT_QUEST)) {
    const got = H.defaultQuestId(td, Number(id), AT);
    assert.equal(got, want.id, `${mon(Number(id)).name}`);
    const q = quest(got);
    assert.equal(q.name, want.name);
    assert.equal(q.stars, 10);
    assert.equal(q.multi, false);
    assert.equal(q.fixedEquipment, false);
    assert.ok(H.AVAILABLE_STATUSES.includes(q.availability.status));
    // 同じ規則を一覧から直接たどっても同じ (★ が一番高い・同じ ★ なら先頭)
    const ok = H.questsFor(td, Number(id), AT).filter((r) => r.role === 'target' && r.fixedEquipment === false
      && !r.multi && r.available && r.health);
    const top = Math.max(...ok.map((r) => r.stars));
    assert.equal(ok.find((r) => r.stars === top).id, got);
  }
  // 選べるものが無ければ null (知らないモンスター・知らない個体)
  assert.equal(H.defaultQuestId(td, 99999, AT), null);
  assert.equal(H.defaultQuestId(td, REY_DAU, 'alpha'), null);
  // 通常の個体でも選べる (クエストが体力の分かる単体のもの)
  const normal = H.defaultQuestId(td, ARKVELD, null);
  assert.ok(normal, '通常のアルシュベルドのクエストが選ばれない');
  assert.equal(quest(normal).multi, false);
});

test('questsFor: 狩猟対象 → 乱入の順。装備固定・多頭・終了中の印と、その個体の行の体力', () => {
  const rows = H.questsFor(td, ARKVELD, AT);
  assert.deepEqual(rows.map((r) => r.id), mon(ARKVELD).individuals.find((i) => i.kind === AT).questIds);
  const unchained = rows.find((r) => r.id === 'Event: Unchained Arkveld');
  assert.equal(unchained.fixedEquipment, true);
  assert.deepEqual(unchained.health, { mid: 28944, min: 28944, max: 28944 });
  const proof = rows.find((r) => r.id === 'Proof of a Hero');
  assert.equal(proof.multi, true);
  assert.equal(proof.subjectIndex, 3, '英雄の証のアルシュベルドは 4 番目の行');
  assert.equal(proof.health.mid, 71701);
  const proud = rows.find((r) => r.id === 'The Proud Child of the Wilds');
  assert.equal(proud.status, 'inactive');
  assert.equal(proud.available, false);
  assert.equal(proud.health, null, 'mission の無いクエストは体力不明');
  // 乱入の可能性のクエストは後ろ・体力なし
  const withIntruder = monstersDoc.monsters.flatMap((m) => m.individuals.map((i) => [m, i]))
    .find(([, i]) => i.intruderQuestIds.length > 0);
  assert.ok(withIntruder, '乱入のある個体がデータに無い');
  const [m, ind] = withIntruder;
  const list = H.questsFor(td, m.id, ind.kind);
  const firstIntruder = list.findIndex((r) => r.role === 'intruder');
  assert.ok(firstIntruder >= 0);
  assert.ok(list.slice(firstIntruder).every((r) => r.role === 'intruder' && r.health === null && r.subjectIndex === null));
});

test('狂竜化・ボス個体: MissionData が区別しないので、同じモンスターの通常の行の体力を使う', () => {
  const rows = H.questsFor(td, 6, 'frenzied'); // ネルスキュラの狂竜化
  const t = rows.filter((r) => r.role === 'target');
  assert.ok(t.length > 0);
  for (const r of t) {
    assert.notEqual(r.subjectIndex, null, `${r.id}: 行が見つからない`);
    assert.equal(r.quest.mission.targets[r.subjectIndex].monsterId, 6);
  }
  // クエストの相手の一覧では個体を quest.targets から取る (狂竜化と出す)
  const subs = H.questSubjects(quest('Frenzy Obscured'), td);
  assert.deepEqual(subs.map((s) => s.kind), ['frenzied', 'frenzied', 'frenzied', 'frenzied', 'frenzied']);
  assert.ok(subs.every((s) => s.name.startsWith('狂竜化')), subs.map((s) => s.name).join('・'));
});

// ---------------------------------------------------------------- 体力

test('targetHealth = quests.json の healthCalc (歴戦王のクエスト 11 件と『英雄の証』4 体)', () => {
  for (const [qid, want] of Object.entries(AT_QUEST_HEALTH)) {
    const q = quest(qid);
    const idx = H.subjectIndexOf(q, q.mission.targets.find((t) => t.variant === AT).monsterId, AT);
    const row = q.mission.targets[idx];
    const h = H.targetHealth(row);
    assert.equal(h.known, true, qid);
    assert.equal(h.solo.mid, want, `${qid} のソロの体力`);
    assert.deepEqual(h.solo, { mid: row.healthCalc.mid, min: row.healthCalc.min, max: row.healthCalc.max });
    assert.deepEqual(h.total, h.solo, '1 人なら total = solo');
    assert.equal(h.multiplier, 1);
    assert.deepEqual(h.confidence, { solo: 'medium', multi: null });
  }
  const subs = H.questSubjects(quest('Proof of a Hero'), td);
  assert.deepEqual(subs.map((s) => [s.monsterId, s.health.solo.mid]), PROOF_OF_A_HERO);
  assert.ok(subs.every((s) => s.kind === AT && s.paramGroup === 'kingHard'));
  assert.deepEqual(subs.map((s) => s.name), ['レ・ダウ（歴戦王）', 'ウズ・トゥナ（歴戦王）', 'ヌ・エグドラ（歴戦王）', 'アルシュベルド（歴戦王）']);
  assert.equal(new Set(subs.map((s) => s.key)).size, 4, 'key は一意');
});

test('targetHealth: 人数の倍率 (確度 low)・範囲・1 人あたり。4 人の『孤独から』= 79,923 × 3.0 = 239,769', () => {
  const row = quest('Freedom from Solitude').mission.targets[0];
  const h4 = H.targetHealth(row, { players: 4 });
  assert.deepEqual(h4.solo, { mid: 79923, min: 76726, max: 83120 });
  assert.equal(h4.multiplier, 3);
  assert.deepEqual(h4.total, { mid: 239769, min: 230178, max: 249360 });
  assert.deepEqual(h4.perPlayer, { mid: 59942 });
  assert.deepEqual(h4.confidence, { solo: 'medium', multi: 'low' });
  const h2 = H.targetHealth(row, { players: 2 });
  assert.equal(h2.multiplier, 1.88);
  assert.equal(h2.total.mid, Math.round(79923 * 1.88));
  // 人数は 1〜4 に丸める
  assert.equal(H.targetHealth(row, { players: 9 }).players, 4);
  assert.equal(H.targetHealth(row, { players: 0 }).players, 1);
  assert.equal(H.targetHealth(row, { players: 'x' }).players, 1);
  // その人数の倍率が無い (2 人までのクエストに 3 人) → 倍率と合計は分からない
  const arena = quest('Arena: Chatacabra').mission.targets[0];
  const h3 = H.targetHealth(arena, { players: 3 });
  assert.equal(h3.known, true);
  assert.equal(h3.multiplier, null);
  assert.equal(h3.total, null);
  assert.equal(h3.reason, 'no-multi');
  assert.equal(H.targetHealth(arena, { players: 2 }).multiplier, 1.6);
});

test('targetHealth: mission が無い・healthCalc が無いときは known: false (仮の値で埋めない)', () => {
  const noMission = questsDoc.quests.filter((q) => !q.mission);
  assert.ok(noMission.length > 0);
  for (const q of noMission) {
    const subs = H.questSubjects(q, td);
    for (const s of subs) {
      assert.equal(s.missionTarget, null);
      assert.equal(s.health.known, false, q.id);
      assert.equal(s.health.solo, null);
      assert.equal(s.health.total, null);
    }
  }
  assert.equal(H.targetHealth(null).known, false);
  assert.equal(H.targetHealth({ healthCalc: null }).known, false);
  assert.equal(H.targetHealth({ healthCalc: { mid: 0 } }).known, false);
});

test('targetHealth: 全部の行で healthCalc の範囲 = MissionData の soloHealth の両端', () => {
  let n = 0;
  for (const q of questsDoc.quests) {
    if (!q.mission) continue;
    for (const row of q.mission.targets) {
      if (!row.healthCalc) continue;
      const h = H.targetHealth(row);
      assert.equal(h.known, true);
      assert.equal(h.solo.min, Math.min(...row.soloHealth), `${q.id} の最小`);
      assert.equal(h.solo.max, Math.max(...row.soloHealth), `${q.id} の最大`);
      assert.ok(h.solo.min <= h.solo.mid && h.solo.mid <= h.solo.max, `${q.id}: 中央が範囲の外`);
      n += 1;
    }
  }
  assert.equal(n, 241, '大型の行の数 (2026-10-21)');
});

test('questSubjects: 同じモンスターが何頭もいる多頭は行ごとに分ける (『ハンター達の永い夢』のケマトリス 4 頭)', () => {
  const q = quest('Every Hunter\'s Dream');
  assert.equal(q.name, 'ハンター達の永い夢');
  const subs = H.questSubjects(q, td);
  const kema = subs.filter((s) => s.monsterId === 10);
  assert.deepEqual(kema.map((s) => s.health.solo.mid), [19000, 16400, 14400, 12000]);
  assert.deepEqual(subs.map((s) => s.index), [0, 1, 2, 3, 4], 'index は mission.targets の行の番号');
  // 人数を渡すと体力も人数のぶん
  const s4 = H.questSubjects(q, td, { players: 4 });
  assert.ok(s4.every((s) => s.health.players === 4 && s.health.total.mid > s.health.solo.mid));
  assert.deepEqual(H.questSubjects(null, td), []);
});

// ---------------------------------------------------------------- 肉質

test('hitzoneFor: 歴戦王ウズ・トゥナの頭の傷口は 弾 70・雷 20 (通常は 88・25)。印は未確認', () => {
  const m = mon(UTH_DUNA);
  const at = H.hitzoneFor(m, 'head', AT);
  assert.equal(at.wound.shot, 70);
  assert.equal(at.wound.thunder, 20);
  assert.equal(at.baseWound.shot, 88);
  assert.equal(at.baseWound.thunder, 25);
  assert.equal(at.woundSource, 'override');
  assert.equal(at.mark, 'unverified');
  assert.equal(H.MARK_LABEL[at.mark], '未確認');
  assert.equal(at.confidence, 'medium');
  assert.deepEqual([...at.changed].sort(), ['shot', 'thunder']);
  assert.equal(at.hitzone, m.parts.find((p) => p.key === 'head').hitzone, '通常の肉質は置き換えない');
  const normal = H.hitzoneFor(m, 'head', null);
  assert.equal(normal.wound.shot, 88);
  assert.equal(normal.wound.thunder, 25);
  assert.equal(normal.woundSource, 'base');
  assert.equal(normal.mark, null);
  const tempered = H.hitzoneFor(m, 'head', 'tempered');
  assert.equal(tempered.wound.shot, 88, '歴戦の個体は通常と同じ');
  assert.equal(tempered.mark, null);
  // 部位の要素を渡しても同じ
  assert.deepEqual(H.hitzoneFor(m, m.parts.find((p) => p.key === 'head'), AT).wound, at.wound);
});

test('hitzoneFor: ウズ・トゥナの歴戦王の置き換えは woundConversions の after と同じ (置き換えの無い部位はそのまま)', () => {
  const m = mon(UTH_DUNA);
  const conv = m.woundConversions.find((c) => c.scope === AT);
  assert.ok(conv && conv.parts.length === 7, '置き換えは 7 部位');
  const keys = new Set(conv.parts.map((p) => p.key));
  for (const cp of conv.parts) {
    const r = H.hitzoneFor(m, cp.key, AT);
    assert.deepEqual(r.wound, cp.after, `${cp.key} の置き換え後`);
    assert.deepEqual(r.baseWound, cp.before, `${cp.key} の置き換え前`);
    assert.deepEqual([...r.changed].sort(), [...cp.changed].sort());
  }
  for (const p of m.parts) {
    if (keys.has(p.key)) continue;
    const r = H.hitzoneFor(m, p.key, AT);
    assert.equal(r.wound, p.wound || null, `${p.key}: 置き換えの無い部位が変わった`);
    assert.equal(r.mark, null);
  }
});

test('hitzoneFor: 歴戦王アルシュベルドは既定で通常の傷口 (印は未確定)、useUncertain で置き換え後。傷口の無い部位は null のまま', () => {
  const m = mon(ARKVELD);
  const def = H.hitzoneFor(m, 'left-wing-blade', AT);
  assert.equal(def.wound.dragon, 38);
  assert.equal(def.woundSource, 'base');
  assert.equal(def.mark, 'uncertain');
  assert.equal(H.MARK_LABEL[def.mark], '未確定');
  assert.equal(def.sameAsBase, null);
  assert.equal(def.confidence, 'low');
  assert.equal(def.overrideWound.dragon, 30, '使っていない置き換えも見せられる');
  const use = H.hitzoneFor(m, 'left-wing-blade', AT, { useUncertain: true });
  assert.equal(use.wound.dragon, 30);
  assert.equal(use.woundSource, 'override-uncertain');
  assert.equal(use.mark, 'uncertain');
  // 頭の傷口の属性 5 → 10 (useUncertain のときだけ)
  assert.equal(H.hitzoneFor(m, 'head', AT).wound.fire, 5);
  assert.equal(H.hitzoneFor(m, 'head', AT, { useUncertain: true }).wound.fire, 10);
  // 傷口の無い部位
  const noWound = m.parts.find((p) => !p.wound);
  assert.ok(noWound, 'アルシュベルドに傷口の無い部位がある前提');
  for (const opts of [{}, { useUncertain: true }]) {
    const r = H.hitzoneFor(m, noWound.key, AT, opts);
    assert.equal(r.wound, null);
    assert.equal(r.woundSource, 'none');
  }
  // 通常の個体は置き換えない
  assert.equal(H.hitzoneFor(m, 'left-wing-blade', null, { useUncertain: true }).wound.dragon, 38);
  // 知らない部位
  assert.equal(H.hitzoneFor(m, 'no-such-part', AT), null);
});

test('hitzoneFor: 置き換えの無い歴戦王は通常と同じ・狂竜化 (未調査) は通常の肉質で印は未確認', () => {
  for (const id of [REY_DAU, NU_UDRA, JIN_DAHAAD]) {
    const m = mon(id);
    for (const p of m.parts) {
      const r = H.hitzoneFor(m, p.key, AT);
      assert.equal(r.wound, p.wound || null, `${m.name} ${p.key}`);
      assert.equal(r.mark, null);
    }
  }
  const nerscylla = mon(6);
  const r = H.hitzoneFor(nerscylla, nerscylla.parts[0].key, 'frenzied');
  assert.equal(r.hitzone, nerscylla.parts[0].hitzone);
  assert.equal(r.mark, 'unverified');
  assert.ok(r.note);
});

test('elementRecommendationOf: 置き換えのある個体は置き換え後のおすすめ。アルシュベルドは useUncertain のときだけ', () => {
  const uz = mon(UTH_DUNA);
  const uzAt = H.elementRecommendationOf(uz, AT);
  assert.equal(uzAt, uz.individuals.find((i) => i.kind === AT).hitzone.elementRecommendation);
  assert.deepEqual(uzAt.best, ['thunder']);
  assert.equal(H.elementRecommendationOf(uz, null), uz.elementRecommendation);
  const ark = mon(ARKVELD);
  assert.equal(H.elementRecommendationOf(ark, AT), ark.elementRecommendation);
  assert.equal(H.elementRecommendationOf(ark, AT, { useUncertain: true }), ark.individuals.find((i) => i.kind === AT).hitzone.elementRecommendation);
  assert.equal(H.elementRecommendationOf(mon(NU_UDRA), AT), mon(NU_UDRA).elementRecommendation);
  assert.equal(H.elementRecommendationOf(null, AT), null);
});

test('woundVitalOf: 群の傷の付きにくさ (確度 low)。群なしは null', () => {
  const v = H.woundVitalOf(mon(ARKVELD), 'kingHard');
  assert.equal(v.normal, 1.6);
  assert.equal(v.confidence, 'low');
  assert.deepEqual(v, { ...mon(ARKVELD).legendaryParams.kingHard.woundVital, confidence: 'low' });
  assert.equal(H.woundVitalOf(mon(ARKVELD), null), null);
  assert.equal(H.woundVitalOf(mon(ARKVELD), 'nope'), null);
});

// ---------------------------------------------------------------- 回数・攻撃の強さ

test('combosToDefeat: 体力 ÷ 1 コンボの期待値を切り上げ。0・負・null・体力不明は null', () => {
  assert.deepEqual(H.combosToDefeat(1000, 10), { mid: 100, min: 100, max: 100 });
  assert.deepEqual(H.combosToDefeat(1001, 10), { mid: 101, min: 101, max: 101 });
  const row = quest('Freedom from Solitude').mission.targets[0];
  // 体力の範囲 (出るたびに少し違う) から回数の範囲
  assert.deepEqual(H.combosToDefeat(H.targetHealth(row), 920.6), {
    mid: Math.ceil(79923 / 920.6), min: Math.ceil(76726 / 920.6), max: Math.ceil(83120 / 920.6),
  });
  assert.equal(H.combosToDefeat(H.targetHealth(row), 920.6).mid, 87);
  // 人数ぶん (total を使う)
  assert.equal(H.combosToDefeat(H.targetHealth(row, { players: 4 }), 920.6).mid, Math.ceil(239769 / 920.6));
  assert.deepEqual(H.combosToDefeat({ mid: 500 }, 100), { mid: 5, min: 5, max: 5 });
  for (const bad of [0, -5, null, undefined, NaN, Infinity, 'abc']) assert.equal(H.combosToDefeat(1000, bad), null, String(bad));
  assert.equal(H.combosToDefeat(null, 10), null);
  assert.equal(H.combosToDefeat(0, 10), null);
  assert.equal(H.combosToDefeat(H.targetHealth(null), 10), null);
  const arena = quest('Arena: Chatacabra').mission.targets[0];
  assert.equal(H.combosToDefeat(H.targetHealth(arena, { players: 3 }), 10), null, 'その人数の倍率が無ければ null');
});

test('attackView: 歴戦王アルシュベルド ★10 は 8.4、比べる相手は狩猟演習 (★9 歴戦の個体 7.15) で約 1.17 倍', () => {
  const q = quest('Freedom from Solitude');
  const v = H.attackView(q, 0, td);
  assert.equal(v.calm, 8.4);
  assert.equal(v.angry, 8.4);
  assert.equal(v.paramGroup, 'kingHard');
  assert.equal(v.confidence, 'low');
  assert.equal(v.compareTo.questId, 'Hunting Exercise: Tempered Arkveld');
  assert.equal(v.compareTo.stars, 9);
  assert.equal(v.compareTo.calm, 7.15);
  assert.ok(Math.abs(v.ratio.calm - 8.4 / 7.15) < 1e-12);
  assert.equal(v.ratio.calm.toFixed(2), '1.17');
  // ファイル丸ごとの形でも同じ
  assert.deepEqual(H.attackView(q, 0, raw), v);
  // 通常の個体 (群なし) は attackRate が無いので null
  const normalQ = quest(H.defaultQuestId(td, ARKVELD, null));
  assert.equal(H.attackView(normalQ, H.subjectIndexOf(normalQ, ARKVELD, null), td), null);
  assert.equal(H.attackView(q, 5, td), null, '無い行');
  // 比べる相手は装備固定でないクエストの歴戦の個体だけ
  for (const qq of questsDoc.quests) {
    if (!qq.mission) continue;
    qq.mission.targets.forEach((t, i) => {
      const r = H.attackView(qq, i, td);
      if (!r || !r.compareTo) return;
      const cq = quest(r.compareTo.questId);
      assert.notEqual(cq.id, qq.id);
      assert.notEqual(cq.fixedEquipment, true);
      assert.ok(cq.mission.targets.some((x) => x.monsterId === t.monsterId && x.variant === 'tempered'));
    });
  }
});

test('attackView: 比べる相手はどの行でも「別のクエスト・装備固定でない・歴戦の個体・★ が一番高い (同じ ★ なら単体)」', () => {
  let checked = 0;
  let withMulti = 0;
  for (const qq of questsDoc.quests) {
    if (!qq.mission) continue;
    qq.mission.targets.forEach((t, i) => {
      const r = H.attackView(qq, i, td);
      if (!t.attackRate || typeof t.attackRate.calm !== 'number') {
        assert.equal(r, null, `${qq.id} #${i}: attackRate が無いのに値がある`);
        return;
      }
      // 規則どおりの候補をここで別に数える
      const cands = [];
      for (const c of questsDoc.quests) {
        if (c.id === qq.id || c.fixedEquipment === true || !c.mission) continue;
        for (const x of c.mission.targets) {
          if (x.monsterId === t.monsterId && x.variant === 'tempered' && x.attackRate && typeof x.attackRate.calm === 'number') {
            cands.push(c);
          }
        }
      }
      if (!cands.length) {
        assert.equal(r.compareTo, null, `${qq.id} #${i}: 比べる相手が無いはず`);
        return;
      }
      const top = Math.max(...cands.map((c) => c.stars));
      const got = quest(r.compareTo.questId);
      assert.equal(got.stars, top, `${qq.id} #${i}: ★ が一番高いクエストと比べていない`);
      if (cands.some((c) => c.stars === top && !c.multi)) {
        assert.equal(got.multi, false, `${qq.id} #${i}: 同じ ★ なら単体のクエストと比べる`);
        withMulti += cands.some((c) => c.stars === top && c.multi) ? 1 : 0;
      }
      checked += 1;
    });
  }
  assert.ok(checked > 50, `確かめた行が少ない (${checked})`);
  assert.ok(withMulti > 0, '同じ ★ に単体と多頭がある行がデータに無い (同じ ★ の決め方を確かめられていない)');
});

// ---------------------------------------------------------------- 作ったデータで規則の端を確かめる (実際のゲームの値ではない)

/** 作り物の target データ。モンスター 1 体 (通常だけ) とクエスト */
function fakeData(quests, { parts, hitzone } = {}) {
  const ids = quests.filter((x) => !x.intruder).map((x) => x.id);
  const monster = {
    id: 1, name: 'テストの竜', variantNames: {},
    parts: parts || [{ key: 'head', name: '頭', hitzone: { slash: 50 }, wound: { slash: 70 } }],
    elementRecommendation: { best: ['fire'] },
    individuals: [{ kind: null, label: '通常', name: 'テストの竜', questIds: ids,
      intruderQuestIds: quests.filter((x) => x.intruder).map((x) => x.id), stars: [], hitzone: hitzone || null }],
  };
  const qs = quests.map((x) => ({
    id: x.id, name: x.id, stars: x.stars ?? 5, multi: !!x.multi, fixedEquipment: 'fixed' in x ? x.fixed : false,
    availability: { status: x.status || 'permanent' },
    targets: x.targets || [{ monsterId: 1, variant: null, count: 1, large: true }],
    mission: x.noMission ? null : {
      targets: (x.rows || [{ monsterId: 1, variant: null }]).map((r) => ({
        healthCalc: { mid: 1000, min: 1000, max: 1000, confidence: 'medium' }, ...r,
      })),
    },
  }));
  return { monsters: [monster], quests: qs };
}

test('defaultQuestId の規則の端: 終了中・装備固定・多頭・体力不明は選ばない。同じ ★ なら一覧の先頭', () => {
  const d = fakeData([
    { id: 'old', stars: 9, status: 'inactive' },
    { id: 'fixed', stars: 9, fixed: true },
    { id: 'unknown-fixed', stars: 9, fixed: null },
    { id: 'multi', stars: 9, multi: true },
    { id: 'nohp', stars: 9, noMission: true },
    { id: 'first', stars: 7 },
    { id: 'second', stars: 7 },
    { id: 'low', stars: 6, status: 'active' },
    { id: 'intr', stars: 10, intruder: true },
  ]);
  assert.equal(H.defaultQuestId(d, 1, null), 'first');
  d.quests.find((x) => x.id === 'old').availability.status = 'standard';
  assert.equal(H.defaultQuestId(d, 1, null), 'old', '受けられるなら ★ の高い方');
  d.quests.find((x) => x.id === 'old').availability.status = 'unknown';
  assert.equal(H.defaultQuestId(d, 1, null), 'first', '配信の状態が分からないものは選ばない');
});

test('questSubjects: mission の無いクエストは大型の狩猟対象を数 (count) のぶん並べる', () => {
  const d = fakeData([{ id: 'two', noMission: true, targets: [
    { monsterId: 1, variant: null, count: 2, large: true },
    { monsterId: null, variant: null, count: 8, large: false },
  ] }]);
  const subs = H.questSubjects(d.quests[0], d);
  assert.deepEqual(subs.map((s) => [s.index, s.monsterId, s.health.known]), [[0, 1, false], [1, 1, false]]);
  assert.equal(new Set(subs.map((s) => s.key)).size, 2);
});

test('hitzoneFor: 傷口の無い部位に置き換えのデータがあっても傷口は作らない', () => {
  const d = fakeData([{ id: 'q' }], {
    parts: [{ key: 'head', name: '頭', hitzone: { slash: 50 }, wound: null }],
    hitzone: { sameAsBase: false, confidence: 'medium', woundOverrides: { head: { slash: 99 } } },
  });
  const r = H.hitzoneFor(d.monsters[0], 'head', null);
  assert.equal(r.wound, null);
  assert.equal(r.woundSource, 'none');
  assert.equal(r.overrideWound, null);
});

test('attackView: 装備固定のクエストの歴戦の個体とは比べない', () => {
  const d = fakeData([
    { id: 'at', stars: 10, rows: [{ monsterId: 1, variant: 'arch-tempered', attackRate: { calm: 9, angry: 9 } }] },
    { id: 'arena', stars: 10, fixed: true, rows: [{ monsterId: 1, variant: 'tempered', attackRate: { calm: 4, angry: 4 } }] },
    { id: 'ex', stars: 8, rows: [{ monsterId: 1, variant: 'tempered', attackRate: { calm: 6, angry: 6 } }] },
  ]);
  const v = H.attackView(d.quests[0], 0, d);
  assert.equal(v.compareTo.questId, 'ex');
  assert.equal(v.ratio.calm, 1.5);
});

test('combosToDefeat: 体力不明の印 (known: false) があれば値があっても出さない', () => {
  assert.equal(H.combosToDefeat({ known: false, mid: 500 }, 10), null);
});

test('データの形を選ばない: data.js の形とファイル丸ごとの形と配列で同じ結果', () => {
  const arr = { monsters: monstersDoc.monsters, quests: questsDoc.quests };
  for (const d of [raw, arr]) {
    assert.equal(H.defaultQuestId(d, ARKVELD, AT), 'Freedom from Solitude');
    assert.deepEqual(H.questsFor(d, UTH_DUNA, AT).map((r) => r.id), H.questsFor(td, UTH_DUNA, AT).map((r) => r.id));
  }
  assert.equal(H.monstersOf(null).length, 0);
  assert.equal(H.questById(td, null), null);
  assert.equal(H.monsterById(raw, ARKVELD).name, 'アルシュベルド');
});
