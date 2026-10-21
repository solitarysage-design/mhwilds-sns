// 相手タブの段階 3 で target_mix.js に足したもの (個体の傷口・クエストの文脈・多頭の相手ごとの部位・部位の選び方の覚え・
// 歴戦王の脅威) のテスト。node --test tests/*.test.mjs で回す。画面 (target_hunt.js) は tests/smoke_ui.py の
// target_arch_tempered / target_multi_quest で確かめる。数字は 2026-10-21 のデータ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as T from '../app/ui/tabs/target_mix.js';

const readJson = (rel) => JSON.parse(fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'));
const MONSTERS = readJson('data/monsters.json');
const QUESTS = readJson('data/quests.json');
const THREATS = readJson('data/monster_threats.json');
const td = { monsters: MONSTERS, quests: QUESTS, threats: THREATS };
const monsterByName = (name) => MONSTERS.monsters.find((m) => m.name === name);
const UTH = monsterByName('ウズ・トゥナ');
const ARK = monsterByName('アルシュベルド');
const REY = monsterByName('レ・ダウ');
const at = (m, extra = {}) => ({ mode: 'monster', monsterId: m.id, partKey: 'head', isWound: true, individual: 'arch-tempered', ...extra });

test('個体の傷口: ウズ・トゥナの歴戦王は置き換え後 (未確認)、通常の個体は parts のまま', () => {
  const r = T.resolveTargetMix(at(UTH), {}, td);
  const head = UTH.parts.find((p) => p.key === 'head');
  assert.equal(r.label, 'ウズ・トゥナ（歴戦王） 頭');
  assert.equal(r.individual, 'arch-tempered');
  assert.equal(r.woundMark, 'unverified');
  assert.equal(r.targets[0].target.wound.thunder, 20);
  assert.equal(head.wound.thunder, 25);
  assert.equal(r.targets[0].target.isWound, true);
  assert.deepEqual(r.targets[0].target.hitzone, head.hitzone, '通常の肉質は個体で変わらない');
  const n = T.resolveTargetMix(at(UTH, { individual: null }), {}, td);
  assert.equal(n.label, 'ウズ・トゥナ 頭');
  assert.equal(n.woundMark, null);
  assert.deepEqual(n.targets[0].target.wound, head.wound);
  // 知らない個体の値は通常として扱う
  assert.equal(T.resolveTargetMix(at(UTH, { individual: 'nope' }), {}, td).label, 'ウズ・トゥナ 頭');
});

test('個体の傷口: アルシュベルドの歴戦王は既定で通常の傷口 (未確定)、useUncertainWound で置き換え後', () => {
  const head = ARK.parts.find((p) => p.key === 'head');
  const ov = ARK.individuals.find((i) => i.kind === 'arch-tempered').hitzone.woundOverrides.head;
  const base = T.resolveTargetMix(at(ARK), {}, td);
  assert.equal(base.woundMark, 'uncertain');
  assert.deepEqual(base.targets[0].target.wound, head.wound);
  const use = T.resolveTargetMix(at(ARK, { useUncertainWound: true }), {}, td);
  assert.equal(use.woundMark, 'uncertain');
  assert.deepEqual(use.targets[0].target.wound, ov);
});

test('個体の傷口: 部位を割合で混ぜても置き換え、印は一番重いもの', () => {
  const tab = { mix: { on: true, monsterId: ARK.id, weights: { head: 0.5, tail: 0.5 } } };
  const r = T.resolveTargetMix(at(ARK, { useUncertainWound: true }), tab, td);
  assert.equal(r.mixed, true);
  assert.match(r.label, /^アルシュベルド（歴戦王） /);
  assert.equal(r.woundMark, 'uncertain');
  const ov = ARK.individuals.find((i) => i.kind === 'arch-tempered').hitzone.woundOverrides;
  for (const x of r.targets) assert.deepEqual(x.target.wound, ov[x.partKey]);
});

test('クエストの文脈: 英雄の証 (4 頭) の行・人数の体力・今の相手', () => {
  const t = { mode: 'monster', monsterId: ARK.id, individual: 'arch-tempered', questId: 'Proof of a Hero', questTargetIndex: 3, players: 4 };
  const ctx = T.questContext(td, t);
  assert.equal(ctx.multi, true);
  assert.equal(ctx.fixed, false);
  assert.equal(ctx.players, 4);
  assert.deepEqual(ctx.subjects.map((s) => s.health.solo.mid), [32850, 46574, 40242, 71701]);
  assert.deepEqual(ctx.subjects.map((s) => s.health.total.mid), [98550, 139722, 120726, 215103]);
  assert.equal(ctx.current.index, 3);
  assert.equal(ctx.current.name, 'アルシュベルド（歴戦王）');
  // questTargetIndex が別の相手を指していても、今のモンスターの行を探す
  assert.equal(T.questContext(td, { ...t, questTargetIndex: 0 }).current.index, 3);
  // クエストを選んでいない・手入力・見つからない → null
  assert.equal(T.questContext(td, { ...t, questId: null }), null);
  assert.equal(T.questContext(td, { ...t, mode: 'manual' }), null);
  assert.equal(T.questContext(td, { ...t, questId: 'no such quest' }), null);
});

test('クエストの文脈: 装備固定・人数の上限・乱入の相手', () => {
  const fixed = T.questContext(td, { mode: 'monster', monsterId: ARK.id, individual: 'arch-tempered',
    questId: 'Event: Unchained Arkveld', questTargetIndex: 0, players: 4 });
  assert.equal(fixed.fixed, true);
  assert.equal(fixed.maxPlayers, 2);
  assert.equal(fixed.players, 2, '人数はクエストの上限で頭打ち');
  assert.equal(fixed.current.health.solo.mid, 28944);
  // 乱入の候補のモンスターで選んだクエスト → 今の相手は無く、intruder
  const q = QUESTS.quests.find((x) => x.id === 'Freedom from Solitude');
  const intr = q.intruders[0];
  const c = T.questContext(td, { mode: 'monster', monsterId: intr.monsterId, individual: null, questId: q.id, questTargetIndex: 0, players: 1 });
  assert.equal(c.current, null);
  assert.equal(c.intruder, true);
  assert.equal(c.subjects.length, 1);
});

test('多頭の相手ごとの部位: 今のモンスターは選んだ部位、ほかは覚えた部位か弱点 1 か所。傷口を狙うかは共通', () => {
  const t = { mode: 'monster', monsterId: ARK.id, partKey: 'tail', isWound: true, individual: 'arch-tempered',
    questId: 'Proof of a Hero', questTargetIndex: 3, players: 1 };
  const ctx = T.questContext(td, t);
  const ark = T.subjectTargets(td, ctx.subjects[3], t, {});
  assert.equal(ark.targets[0].partKey, 'tail');
  const rey = T.subjectTargets(td, ctx.subjects[0], t, {});
  assert.equal(rey.targets[0].partKey, T.defaultPartKey(REY));
  assert.equal(rey.targets[0].target.isWound, true);
  assert.match(rey.label, /^レ・ダウ（歴戦王） /);
  // 覚えた部位 (割合も) を使う
  const other = REY.parts.find((p) => !p.unknownPart && p.key !== T.defaultPartKey(REY)).key;
  const memoTab = { memo: { [REY.id]: { partKey: other, mix: null } } };
  assert.equal(T.subjectTargets(td, ctx.subjects[0], t, memoTab).targets[0].partKey, other);
  const mixTab = { memo: { [REY.id]: { partKey: other, mix: { on: true, weights: { [other]: 0.6, head: 0.4 } } } } };
  const mixed = T.subjectTargets(td, ctx.subjects[0], t, mixTab);
  assert.equal(mixed.mixed, true);
  assert.deepEqual(mixed.targets.map((x) => x.partKey).sort(), [other, 'head'].sort());
});

test('部位の選び方の覚え: 残して読める・壊れた値は捨てる・数に上限', () => {
  const ui = { mix: { on: true, monsterId: ARK.id, weights: { head: 0.7, tail: 0.3 } } };
  const p = T.partsMemoPatch(ui, { mode: 'monster', monsterId: ARK.id, partKey: 'head' });
  assert.deepEqual(p.memo[String(ARK.id)], { partKey: 'head', mix: { on: true, weights: { head: 0.7, tail: 0.3 } } });
  const back = T.readPartsMemo(p, ARK.id, ARK);
  assert.equal(back.partKey, 'head');
  assert.deepEqual(back.mix.weights, { head: 0.7, tail: 0.3 });
  // 別のモンスターの割合は覚えない。手入力・未選択は null
  const p2 = T.partsMemoPatch({ mix: { on: true, monsterId: 999, weights: { head: 1 } } }, { mode: 'monster', monsterId: ARK.id, partKey: 'tail' });
  assert.deepEqual(p2.memo[String(ARK.id)], { partKey: 'tail', mix: null });
  assert.equal(T.partsMemoPatch(ui, { mode: 'manual', monsterId: ARK.id }), null);
  assert.equal(T.partsMemoPatch(ui, { mode: 'monster', monsterId: null }), null);
  // 無くなった部位・壊れた値
  assert.equal(T.readPartsMemo({ memo: { [ARK.id]: { partKey: 'no-part' } } }, ARK.id, ARK).partKey, null);
  assert.equal(T.readPartsMemo({ memo: { [ARK.id]: 'broken' } }, ARK.id, ARK), null);
  assert.equal(T.readPartsMemo({ memo: null }, ARK.id, ARK), null);
  // 多すぎたら古いものから捨てる (今のモンスターは残る)
  const many = {};
  for (let i = 0; i < 80; i++) many[`m${i}`] = { partKey: null, mix: null };
  const p3 = T.partsMemoPatch({ memo: many }, { mode: 'monster', monsterId: ARK.id, partKey: 'head' });
  assert.equal(Object.keys(p3.memo).length, 64);
  assert.ok(p3.memo[String(ARK.id)]);
  assert.ok(!p3.memo.m0);
});

test('歴戦王の脅威: ジン・ダハドは つむじ風 (拘束耐性 Lv3・未確認) と ノヴァ (防げない)。通常の個体は variant なし', () => {
  const jin = monsterByName('ジン・ダハド');
  const info = T.threatInfo(THREATS, jin.id, { 147: 1 }, { kind: 'arch-tempered' });
  const v = info.variant;
  assert.equal(v.kind, 'arch-tempered');
  assert.equal(v.sameAsBase.all, true);
  assert.equal(v.sameAsBase.confidence, 'medium');
  const wind = v.hazards.find((h) => h.key === 'frostblight-whirlwind');
  assert.equal(wind.need.name, '拘束耐性');
  assert.equal(wind.need.negateLevel, 3);
  assert.equal(wind.need.have, 1);
  assert.equal(wind.need.mitigated, true);
  assert.equal(wind.need.negated, false);
  assert.equal(wind.unverified, true);
  const nova = v.hazards.find((h) => h.key === 'nova');
  assert.equal(nova.need, null);
  assert.equal(nova.oneShot, true);
  assert.ok(nova.noSkill);
  assert.ok(v.moveChanges.length > 0 && v.moveChanges.every((m) => m.text || m.textEn));
  assert.equal(T.threatInfo(THREATS, jin.id, {}).variant, null);
  assert.equal(T.threatInfo(THREATS, jin.id, {}, { kind: 'tempered' }).variant, null);
  // ヌ・エグドラの歴戦王: 環境適応 Lv2 (確度 high = 未確認ではない)
  const nu = T.threatInfo(THREATS, monsterByName('ヌ・エグドラ').id, {}, { kind: 'arch-tempered' }).variant;
  assert.deepEqual(nu.hazards.map((h) => [h.need.name, h.need.negateLevel, h.unverified]), [['環境適応', 2, false]]);
});
