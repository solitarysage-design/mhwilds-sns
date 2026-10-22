// state.js の段階 2・3 の項目 (target の個体・クエスト・人数、state.search) と変更関数・sanitizeState のテスト。
// 実行: node --test tests/*.test.mjs  (Node 24 では tests/ とディレクトリで渡すと落ちる)
// state.js は 'preact/hooks' を名前で import する (ブラウザでは index.html の import map)。node では
// module.registerHooks で app/vendor の同じファイルに向ける (このテストのプロセスの中だけ)。
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

const S = await import('../app/state.js');
const readJson = (rel) => JSON.parse(readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'));
const monstersDoc = readJson('data/monsters.json');
const questsDoc = readJson('data/quests.json');
const td = { monsters: monstersDoc, quests: questsDoc };

// 2026-10-21 より前の保存データ (段階 2・3 の項目が無い)
const OLD_SAVED = {
  schema: 1,
  tab: 'target',
  build: { weapon: 1182, armor: { head: 670 }, limitBreak: { head: true }, charm: 'c0001', decorations: { weapon: [101] } },
  target: { mode: 'monster', monsterId: 20, partKey: 'head', isWound: true, questId: null,
    manual: { name: '手入力', hitzone: { slash: 45, blunt: 45, fire: 20, water: 20, thunder: 20, ice: 20, dragon: 20 }, wound: null } },
  combo: null, uptimes: { enraged: 0.7 }, sharpness: null, mySets: [], tabs: { target: { sort: 'body' } },
};

function reset() {
  // 保存はしない (initState を呼んでいないので IndexedDB には触らない)
  S.setBuild(S.emptyBuild());
  S.setTarget(S.emptyTarget());
  S.setSearch(S.defaultSearch());
  S.takeSearchRequest();
}

test('タブは 6 つ: 装備・火力・相手・探す・護石・設定', () => {
  assert.deepEqual(S.TABS, ['equip', 'power', 'target', 'search', 'charms', 'settings']);
  assert.equal(S.STATE_SCHEMA, 1, '足すだけなので版は上げない');
  assert.equal(S.sanitizeState({ tab: 'search' }).tab, 'search');
  assert.equal(S.sanitizeState({ tab: 'nope' }).tab, 'equip');
});

test('古い保存データ (段階 2・3 の項目が無い) を読んでも壊れず、今までの値は残る', () => {
  const s = S.sanitizeState(OLD_SAVED);
  assert.equal(s.tab, 'target');
  assert.equal(s.build.weapon, 1182);
  assert.equal(s.build.limitBreak.head, true);
  assert.equal(s.target.monsterId, 20);
  assert.equal(s.target.partKey, 'head');
  assert.equal(s.target.isWound, true);
  assert.deepEqual(s.uptimes, { enraged: 0.7 });
  assert.deepEqual(s.tabs, { target: { sort: 'body' } });
  // 新しい項目は初期値
  assert.equal(s.target.individual, null);
  assert.equal(s.target.questTargetIndex, 0);
  assert.equal(s.target.players, 1);
  assert.equal(s.target.useUncertainWound, false);
  assert.deepEqual(s.search, S.defaultSearch());
  // 本人の決定どおりの既定
  assert.equal(s.search.preset, 'balance');
  assert.deepEqual(s.search.archTemperedHunted, {}, '歴戦王 5 体とも倒した扱い');
  assert.equal(s.search.placeholders, 'zero', '仮置きの発動率は 0% で探す');
  assert.equal(s.search.twoWeapons, 'auto');
  assert.equal(s.search.useTarget, true);
  // JSON にして戻しても同じ (IndexedDB に入れられる形)
  assert.deepEqual(S.sanitizeState(JSON.parse(JSON.stringify(s))), s);
});

test('発動率: 新しい state は空 (全部の条件が既定の値)。読めない値は「入れていない」にし、0% にしない', () => {
  // 既定の値 (本人の前提の怒り・連撃・スタミナ満タン 100% など) を state に書き込まない = data が変われば新しい既定になる
  assert.deepEqual(S.defaultState().uptimes, {});
  assert.deepEqual(S.sanitizeState({}).uptimes, {});
  // null・空の文字・配列は捨てる (Number(null) = 0 で「0% を入れた」にすると、既定 100% の条件が 0% で計算される)
  const s = S.sanitizeState({ uptimes: {
    staminaFull: null, enraged: '', hpLow: [], hpFull: '  ', redHp: '0.3', latentPower: true, wet: 0,
    chain: { hit1to4: null, hit5plus: '0.6' }, frenzy: { infected: '', overcome: 2 },
  } });
  assert.deepEqual(s.uptimes, { redHp: 0.3, latentPower: 1, wet: 0, chain: { hit5plus: 0.6 }, frenzy: { overcome: 1 } });
});

test('sanitizeState: 壊れた値の段階 2・3 の項目は初期値か範囲の中にそろえる', () => {
  const s = S.sanitizeState({
    target: { individual: 'king', questTargetIndex: 99, players: 9, useUncertainWound: 'yes', questId: 'Freedom from Solitude' },
    search: {
      useTarget: false, preset: 'max', toggles: { a: true, b: 'on', '': true, [`${'x'.repeat(101)}`]: false },
      levels: { a: 2, b: 0, c: 11, d: '3', e: 2.5 },
      required: [{ skillId: 1, level: 3 }, { skillId: 1, level: 5 }, { skillId: -1, level: 1 }, { skillId: 'x', level: 1 },
        { skillId: 2, level: 0 }, null, { skillId: '7', level: '2' }],
      weaponMode: 'any', twoWeapons: 'yes', partsPolicy: 'all', charms: { owned: false, fixed: 0 },
      limitBreak: true, archTemperedHunted: { 3: false, 20: true, x: false, 25: 'no' },
      armorExclude: [705, '706', 705, 'x', -1, 1.5], placeholders: 'half', budgetSec: 999, K: 0,
      autoStart: { id: 'r1', from: 'target', at: '2026-10-21T00:00:00Z' },
    },
  });
  assert.equal(s.target.individual, null);
  assert.equal(s.target.questTargetIndex, 15);
  assert.equal(s.target.players, 4);
  assert.equal(s.target.useUncertainWound, false);
  assert.equal(s.target.questId, 'Freedom from Solitude');
  const q = s.search;
  assert.equal(q.useTarget, false);
  assert.equal(q.preset, 'balance');
  assert.deepEqual(q.toggles, { a: true });
  assert.deepEqual(q.levels, { a: 2, d: 3 });
  assert.deepEqual(q.required, [{ skillId: 1, level: 3 }, { skillId: 7, level: 2 }]);
  assert.equal(q.weaponMode, 'auto');
  assert.equal(q.twoWeapons, 'auto');
  assert.equal(q.partsPolicy, 'asSelected');
  assert.deepEqual(q.charms, { owned: false, local: true, fixed: true });
  assert.equal(q.limitBreak, 'build');
  assert.deepEqual(q.archTemperedHunted, { 3: false });
  assert.deepEqual(q.armorExclude, [705, 706]);
  assert.equal(q.placeholders, 'zero');
  assert.equal(q.budgetSec, 60);
  assert.equal(q.K, 1);
  assert.equal(q.autoStart, null, '自動で探し始める印は保存から戻さない');
  // 個体の値はどれも通る
  for (const k of S.INDIVIDUAL_KINDS) assert.equal(S.sanitizeState({ target: { individual: k } }).target.individual, k);
  // 状態ごと壊れていても初期値
  assert.deepEqual(S.sanitizeState('x').search, S.defaultSearch());
  assert.deepEqual(S.sanitizeState({ search: [] }).search, S.defaultSearch());
});

test('selectMonster は個体を通常に・クエストを外す。selectIndividual はクエストを選び直す', () => {
  reset();
  S.selectMonster(20, 'head');
  S.selectIndividual('arch-tempered', { targetData: td });
  let t = S.getState().target;
  assert.equal(t.individual, 'arch-tempered');
  assert.equal(t.questId, 'Freedom from Solitude', '歴戦王アルシュベルドは『孤独から出でし君という自由』');
  assert.equal(t.questTargetIndex, 0);
  assert.equal(t.partKey, 'head', '部位はそのまま');
  // クエストを渡せばそれ
  S.selectIndividual('arch-tempered', { targetData: td, questId: 'Proof of a Hero' });
  t = S.getState().target;
  assert.equal(t.questId, 'Proof of a Hero');
  assert.equal(t.questTargetIndex, 3, '英雄の証のアルシュベルドは 4 番目の行');
  // データを渡さなければクエストから外す
  S.selectIndividual(null);
  t = S.getState().target;
  assert.equal(t.individual, null);
  assert.equal(t.questId, null);
  // 知らない個体は通常
  S.selectIndividual('king', { targetData: td });
  assert.equal(S.getState().target.individual, null);
  // モンスターを選び直すと個体・クエストは外れる
  S.selectIndividual('arch-tempered', { targetData: td });
  S.selectMonster(25, 'head');
  t = S.getState().target;
  assert.equal(t.individual, null);
  assert.equal(t.questId, null);
  assert.equal(t.questTargetIndex, 0);
});

test('selectQuest: クエストの名前から選ぶ (モンスター・個体もいっしょに)・多頭の相手の行を替える (クエストは残す)', () => {
  reset();
  S.selectMonster(3, 'head');
  S.selectQuest('Proof of a Hero', { targetIndex: 0, monsterId: 3, individual: 'arch-tempered' });
  let t = S.getState().target;
  assert.equal(t.questId, 'Proof of a Hero');
  assert.equal(t.monsterId, 3);
  assert.equal(t.partKey, 'head', '同じモンスターなら部位は残す');
  assert.equal(t.individual, 'arch-tempered');
  S.setWound(true);
  S.selectQuest('Proof of a Hero', { targetIndex: 3, monsterId: 20, individual: 'arch-tempered' });
  t = S.getState().target;
  assert.equal(t.questId, 'Proof of a Hero');
  assert.equal(t.questTargetIndex, 3);
  assert.equal(t.monsterId, 20);
  assert.equal(t.partKey, null, 'モンスターが替わったら部位は未選択');
  assert.equal(t.isWound, false);
  S.selectQuest('Proof of a Hero', { targetIndex: 1, monsterId: 25, individual: 'arch-tempered', partKey: 'head' });
  assert.equal(S.getState().target.partKey, 'head');
  // 同じ中身なら状態のオブジェクトは変わらない (描き直さない)
  const before = S.getState();
  S.selectQuest('Proof of a Hero', { targetIndex: 1, monsterId: 25, individual: 'arch-tempered', partKey: 'head' });
  assert.equal(S.getState(), before);
  // 外す
  S.selectQuest(null);
  assert.equal(S.getState().target.questId, null);
  assert.equal(S.getState().target.monsterId, 25, 'モンスターはそのまま');
});

test('setPlayers・setUseUncertainWound', () => {
  reset();
  S.setPlayers(4);
  assert.equal(S.getState().target.players, 4);
  S.setPlayers(7);
  assert.equal(S.getState().target.players, 4);
  S.setPlayers(0);
  assert.equal(S.getState().target.players, 1);
  S.setUseUncertainWound(true);
  assert.equal(S.getState().target.useUncertainWound, true);
});

test('resolveTarget: 個体があれば hitzoneFor で傷口を置き換え、ラベルは「ウズ・トゥナ（歴戦王） 頭」', () => {
  const base = { ...S.emptyTarget(), monsterId: 25, partKey: 'head' };
  const normal = S.resolveTarget(base, monstersDoc);
  assert.equal(normal.label, 'ウズ・トゥナ 頭');
  assert.equal(normal.wound.shot, 88);
  assert.equal(normal.woundMark, null);
  const at = S.resolveTarget({ ...base, individual: 'arch-tempered' }, monstersDoc);
  assert.equal(at.label, 'ウズ・トゥナ（歴戦王） 頭');
  assert.equal(at.wound.shot, 70);
  assert.equal(at.wound.thunder, 20);
  assert.equal(at.hitzone, normal.hitzone, '通常の肉質は同じ');
  assert.equal(at.woundSource, 'override');
  assert.equal(at.woundMark, 'unverified');
  const ark = { ...S.emptyTarget(), monsterId: 20, partKey: 'left-wing-blade', individual: 'arch-tempered' };
  assert.equal(S.resolveTarget(ark, monstersDoc).wound.dragon, 38, '既定は通常の傷口');
  assert.equal(S.resolveTarget(ark, monstersDoc).woundMark, 'uncertain');
  assert.equal(S.resolveTarget({ ...ark, useUncertainWound: true }, monstersDoc).wound.dragon, 30);
  // 段階 2・3 の項目の無い古い target でも今までどおり
  const old = S.resolveTarget({ mode: 'monster', monsterId: 20, partKey: 'head', isWound: false }, monstersDoc);
  assert.equal(old.label, 'アルシュベルド 頭');
  assert.equal(old.wound, monstersDoc.monsters.find((m) => m.id === 20).parts.find((p) => p.key === 'head').wound);
});

test('setSearch と必須スキル・トグル・Lv・歴戦王・使わない防具の変更関数', () => {
  reset();
  S.setSearch({ preset: 'safe', budgetSec: 10 });
  assert.equal(S.getState().search.preset, 'safe');
  assert.equal(S.getState().search.budgetSec, 10);
  S.setSearch({ preset: 'nope' });
  assert.equal(S.getState().search.preset, 'balance', '知らない値は既定にそろえる');
  // charms は中身をマージする
  S.setSearch({ charms: { fixed: false } });
  S.setSearch({ charms: { owned: false } });
  assert.deepEqual(S.getState().search.charms, { owned: false, local: true, fixed: false });
  // 変わらなければ同じオブジェクト
  const before = S.getState();
  S.setSearch({ preset: 'balance' });
  assert.equal(S.getState(), before);

  S.setSearchToggle('roar:80', true);
  S.setSearchToggle('blight', false);
  assert.deepEqual(S.getState().search.toggles, { 'roar:80': true, blight: false });
  S.setSearchToggle('roar:80', null);
  assert.deepEqual(S.getState().search.toggles, { blight: false });
  S.setSearchLevel('roar:80', 1);
  assert.deepEqual(S.getState().search.levels, { 'roar:80': 1 });
  S.setSearchLevel('roar:80', 0);
  assert.deepEqual(S.getState().search.levels, { 'roar:80': 1 }, '0 は受け付けない');
  S.setSearchLevel('roar:80', null);
  assert.deepEqual(S.getState().search.levels, {});

  S.addRequired(63, 3);
  S.addRequired(80, 2);
  S.addRequired(63, 2);
  assert.deepEqual(S.getState().search.required, [{ skillId: 63, level: 2 }, { skillId: 80, level: 2 }]);
  S.setRequiredLevel(80, 3);
  S.setRequiredLevel(999, 3);
  assert.deepEqual(S.getState().search.required, [{ skillId: 63, level: 2 }, { skillId: 80, level: 3 }]);
  S.addRequired('x', 1);
  S.addRequired(5, 0);
  assert.equal(S.getState().search.required.length, 2);
  S.removeRequired(63);
  assert.deepEqual(S.getState().search.required, [{ skillId: 80, level: 3 }]);

  S.setArchTemperedHunted(20, false);
  S.setArchTemperedHunted(3, false);
  assert.deepEqual(S.getState().search.archTemperedHunted, { 3: false, 20: false });
  S.setArchTemperedHunted(20, true);
  assert.deepEqual(S.getState().search.archTemperedHunted, { 3: false });
  S.setArmorExcluded(705, true);
  S.setArmorExcluded(706, true);
  S.setArmorExcluded(705, false);
  assert.deepEqual(S.getState().search.armorExclude, [706]);
  // 保存して戻しても同じ
  assert.deepEqual(S.sanitizeState(JSON.parse(JSON.stringify(S.getState()))).search, S.getState().search);
});

test('store.js: 探すタブの最後の結果 (書き出しに入る) と時間の記録 (この端末だけ・20 回まで)', async () => {
  // node には IndexedDB が無いので store.js はメモリに置く (読み書きの形はブラウザと同じ)
  const D = await import('../app/store.js');
  assert.equal(D.SEARCH_LAST_KEY, 'mhwilds-sns:search-last');
  assert.equal(D.SEARCH_TIMING_KEY, 'mhwilds-sns:search-timing');
  assert.equal(await D.loadSearchLast(), null);
  assert.equal(await D.saveSearchLast({ inputKey: 'k1', result: null }), false, '結果が無ければ保存しない');
  await D.saveSearchLast({ inputKey: 'k1', summary: { top: 920.6 }, result: { status: 'done', results: [] }, appVersion: 'v1' });
  const last = await D.loadSearchLast();
  assert.equal(last.inputKey, 'k1');
  assert.equal(last.appVersion, 'v1');
  assert.deepEqual(last.summary, { top: 920.6 });
  assert.equal(last.result.status, 'done');
  assert.match(last.savedAt, /^\d{4}-\d{2}-\d{2}T/);
  for (let i = 0; i < 25; i++) await D.appendSearchTiming({ label: `回 ${i}`, doneMs: i });
  const timing = await D.loadSearchTiming();
  assert.equal(timing.length, D.SEARCH_TIMING_MAX);
  assert.equal(timing[0].label, '回 5', '古いものから消す');
  assert.equal(timing.at(-1).label, '回 24');
  assert.ok(timing.every((t) => typeof t.at === 'string'));
  assert.equal((await D.appendSearchTiming({ at: 'x', label: 'at を渡す' })).at(-1).at, 'x');
  // 書き出し: 最後の結果は入る・時間の記録は入らない (この端末だけ)
  const backup = D.parseBackupText(await D.exportAllText({ appVersion: 'test' }));
  assert.ok(backup.ok);
  assert.ok(D.SEARCH_LAST_KEY in backup.backup.entries);
  assert.ok(!(D.SEARCH_TIMING_KEY in backup.backup.entries));
  // 壊れた保存データ
  await D.kvSet(D.SEARCH_LAST_KEY, { result: 'x' });
  assert.equal(await D.loadSearchLast(), null);
  await D.kvSet(D.SEARCH_TIMING_KEY, 'x');
  assert.deepEqual(await D.loadSearchTiming(), []);
  await D.clearSearchLast();
  await D.clearSearchTiming();
  assert.equal(await D.loadSearchLast(), null);
});

test('自動で探し始める受け渡し: requestSearch → 探すタブが takeSearchRequest で 1 回だけ受け取る', () => {
  reset();
  S.setSearch({ useTarget: false });
  const id = S.requestSearch({ from: 'target' });
  const req = S.getState().search.autoStart;
  assert.equal(req.id, id);
  assert.equal(req.from, 'target');
  assert.match(req.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(S.getState().search.useTarget, true, '相手に合わせたおすすめを使う');
  // setSearch では消えない
  S.setSearch({ preset: 'power' });
  assert.equal(S.getState().search.autoStart.id, id);
  // 違う id では受け取らない
  assert.equal(S.takeSearchRequest('other'), null);
  assert.equal(S.getState().search.autoStart.id, id);
  // 受け取ると消える (2 回目は無い)
  assert.equal(S.takeSearchRequest(id).id, id);
  assert.equal(S.getState().search.autoStart, null);
  assert.equal(S.takeSearchRequest(id), null);
  // 保存から戻すと印は消える (開き直しで勝手に探し始めない)
  S.requestSearch();
  const saved = JSON.parse(JSON.stringify(S.getState()));
  assert.ok(saved.search.autoStart);
  assert.equal(S.sanitizeState(saved).search.autoStart, null);
});
