// 装備探索のテストとベンチの条件 (B1〜B5。docs/SEARCH_DESIGN.md 1.1 節・5.1 節)。
// data は引数で受ける (tools/bench_search_webkit.py のページからも読むので、node 専用のモジュールは loadRepoData の中だけで読む)。
//
// B1 = 手入力の巨戟アーティア (破滅のキリエヴェルド 属性激化・火 440・攻撃 175・黒蝕竜の力 + ヌシの魂。
//      tests/review_numbers.test.mjs と同じ武器)・アルシュベルドの頭・コンボ = combos_sns の先頭・発動率は既定 (uptimes = {})・
//      限界突破は全部位・護石 = charms.json + charms_fixed.json・珠は全部持っている。
// B2 = B1 + 必須 耐震3・風圧耐性3・回避性能2
// B3 = 武器を片手剣 95 本から探す (ほかは B1 と同じ)
// B4 = 泣シミュ型 (攻撃3・見切り3・超会心3・弱点特効5・挑戦者5・渾身3 を満たす構成)。B4x = 満たせない必須 (攻撃5・見切り5・弱点特効5・超会心5)
// B5 = B1 の相手を 頭 6 割・左翼 4 割
// B1z・B3z・B5z = 仮置きの発動率を 0% にしたもの (探すタブの既定の条件)

/** 読むデータのファイル (data.js の core と同じ名前 + 相手のデータ) */
export const CASE_DATA_FILES = {
  skills: 'skills.json', armor: 'armor.json', weapons: 'weapons_sns.json', decorations: 'decorations.json',
  bonuses: 'bonuses.json', charmsFixed: 'charms_fixed.json', charms: 'charms.json', myWeapons: 'my_weapons.json',
  skillEffects: 'skill_effects.json', motions: 'motions_sns.json', combos: 'combos_sns.json', monsters: 'monsters.json',
};

/** 基準値 (tests/fixtures/search_ref.json) のハッシュに入れるファイル (docs/SEARCH_DESIGN.md 5.2 節) */
export const REF_HASH_FILES = ['armor.json', 'skills.json', 'decorations.json', 'skill_effects.json', 'bonuses.json',
  'charms_fixed.json', 'charms.json', 'weapons_sns.json', 'motions_sns.json', 'combos_sns.json', 'monsters.json'];

/** node でリポの data/*.json を読む ({key: 中身})。ブラウザでは使わない */
export async function loadRepoData() {
  const fs = await import('node:fs');
  const read = (f) => JSON.parse(fs.readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'));
  return Object.fromEntries(Object.entries(CASE_DATA_FILES).map(([k, f]) => [k, read(f)]));
}

/** node でデータのハッシュ (sha256 の先頭 16 桁) を作る */
export async function dataHashes() {
  const fs = await import('node:fs');
  const crypto = await import('node:crypto');
  return Object.fromEntries(REF_HASH_FILES.map((f) => {
    const buf = fs.readFileSync(new URL(`../data/${f}`, import.meta.url));
    return [f, crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)];
  }));
}

const listOf = (x, key) => (x && Array.isArray(x[key]) ? x[key] : Array.isArray(x) ? x : []);

/**
 * B1〜B5 の createSearch の入力を作る。
 * @param raw loadRepoData() の結果 (data.js の core と同じ名前 + monsters)
 * @returns {{cases: {B1, B2, B3, B4, B4x, B5}, artian, skillId(name), targetOf(monsterName, partKey)}}
 */
export function makeCases(raw) {
  const skills = listOf(raw.skills, 'skills');
  const bonuses = raw.bonuses || {};
  const skillId = (name) => {
    const s = skills.find((x) => x.name === name);
    if (!s) throw new Error(`skills.json に ${name} が無い`);
    return s.id;
  };
  const setId = (name) => listOf(bonuses, 'setBonuses').find((b) => b.name === name).id;
  const groupId = (name) => listOf(bonuses, 'groupBonuses').find((b) => b.name === name).id;
  const artian = {
    id: 'w-test', name: '破滅のキリエヴェルド (属性激化・火)', baseWeaponId: 1182, attack: 175, affinity: 0,
    element: { type: 'fire', value: 440 }, setBonusId: setId('黒蝕竜の力'), groupBonusId: groupId('ヌシの魂'),
  };
  const monsters = listOf(raw.monsters, 'monsters');
  const targetOf = (monsterName, partKey, isWound = false) => {
    const m = monsters.find((x) => x.name === monsterName);
    const p = m.parts.find((x) => x.key === partKey);
    return { hitzone: p.hitzone, wound: p.wound || null, isWound };
  };
  const combo = listOf(raw.combos, 'combos')[0];
  const head = [{ weight: 1, label: 'アルシュベルド 頭', target: targetOf('アルシュベルド', 'head') }];
  const mix = [
    { weight: 0.6, label: '頭', target: targetOf('アルシュベルド', 'head') },
    { weight: 0.4, label: '左翼', target: targetOf('アルシュベルド', 'left-wing') },
  ];
  const base = {
    weapons: ['w-test'], extraWeapons: [artian], targets: head, combo, uptimes: {},
    // アルシュベルドは状態異常を使わない (monster_threats の statusEffects が空)
    monsterStatus: [], buffs: {}, sharpness: null, required: [],
    charms: { owned: true, extra: [], fixed: true }, limitBreak: true, decorations: { owned: null }, armorExclude: [],
    objective: 'damage', K: 10, mode: 'fast',
  };
  const req = (pairs) => pairs.map(([name, level]) => ({ skillId: skillId(name), level }));
  // 仮置きの発動率の条件を全部 0% にしたもの (探すタブの既定。本人の決定: 仮置きは探索では 0% として扱う)
  const zeroPlaceholders = Object.fromEntries(listOf(raw.skillEffects.rules, 'conditionGroups').filter((g) => g.placeholder)
    .map((g) => [g.id, g.type === 'categorical' ? {} : 0]));
  const cases = {
    B1: { ...base },
    B2: { ...base, required: req([['耐震', 3], ['風圧耐性', 3], ['回避性能', 2]]) },
    B3: { ...base, weapons: listOf(raw.weapons, 'weapons').map((w) => w.id), extraWeapons: [] },
    B4: { ...base, objective: 'none',
      required: req([['攻撃', 3], ['見切り', 3], ['超会心', 3], ['弱点特効', 5], ['挑戦者', 5], ['渾身', 3]]) },
    B4x: { ...base, objective: 'none', required: req([['攻撃', 5], ['見切り', 5], ['弱点特効', 5], ['超会心', 5]]) },
    B5: { ...base, targets: mix },
  };
  // B1z / B3z / B5z = 仮置きの発動率を 0% にしたもの (画面の既定に近い条件。基準値は持たず、時間とメモリだけ測る)
  cases.B1z = { ...cases.B1, uptimes: zeroPlaceholders };
  cases.B3z = { ...cases.B3, uptimes: zeroPlaceholders };
  cases.B5z = { ...cases.B5, uptimes: zeroPlaceholders };
  return { cases, artian, skillId, targetOf, zeroPlaceholders };
}

/** createSearch に渡す data (data.js の core と同じ形: 生データ + skillEffects / motions。索引は createSearch が作る) */
export function searchDataOf(raw) {
  const { monsters, combos, ...core } = raw;
  return core;
}
