// 画面の状態 (state.js の getState() を JSON にしたもの) から、計算モデル (app/model/) だけを使って
// 発動スキルとコンボ 1 回の期待値を計算する。tests/smoke_ui.py の「通しの操作」が、
// 画面に出た値とこの結果を比べるために呼ぶ (画面側の部品・equip_logic.js などは使わない = 別の道で計算する)。
//
// 使い方: node tests/calc_from_state.mjs <入力の JSON ファイル>
//   入力: {"state": {...getState()...}, "localCharms": [...この端末で足した護石...]}
//   出力 (標準出力に JSON): {skills: [{skillId, name, level, rawLevel, maxLevel}], total, physical, element, extra,
//                           noSkills, vsNoSkillsPct, sharpness, combo, target, lowConfidence, unsupported, warnings}
// 斬れ味が「自動」のときは、スキルの組ごとに斬れ味の色を決め直す (匠を外すと色が下がる。スキルなしは匠なしの色)。
// テストの本体ではない (node --test tests/*.test.mjs には拾われない名前にしてある)。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeBuild, indexEquipData } from '../app/model/build.js';
import { comboExpected, SHARPNESS_ORDER } from '../app/model/damage.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (name) => JSON.parse(readFileSync(join(ROOT, 'data', name), 'utf8'));

// 相手が決まっていないときの肉質 (画面の決まり: 切断・打撃 45、属性 20)
const DEFAULT_HITZONE = { slash: 45, blunt: 45, fire: 20, water: 20, thunder: 20, ice: 20, dragon: 20 };
// 匠 1 Lv で伸びる斬れ味ゲージの長さ
const HANDICRAFT_STEP = 10;

function main() {
  const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const st = input.state;
  const localCharms = Array.isArray(input.localCharms) ? input.localCharms : [];

  const skills = load('skills.json');
  const weapons = load('weapons_sns.json');
  const myWeaponsFile = load('my_weapons.json');
  const charmsFile = load('charms.json');
  const effects = load('skill_effects.json');
  const localWeapons = (st.tabs && st.tabs.equip && Array.isArray(st.tabs.equip.myWeapons)) ? st.tabs.equip.myWeapons : [];
  const idx = indexEquipData({
    skills, decorations: load('decorations.json'), bonuses: load('bonuses.json'), armor: load('armor.json'),
    weapons, myWeapons: [...myWeaponsFile.weapons, ...localWeapons],
    charms: [...charmsFile.charms, ...localCharms], charmsFixed: load('charms_fixed.json'),
  });
  const build = computeBuild(st.build, idx);

  // 武器 (所持武器は元の武器で足りない所を補う)
  const ref = st.build.weapon;
  const w = typeof ref === 'number' ? idx.weapons.get(ref) : idx.myWeapons.get(ref);
  if (!w) throw new Error(`武器が見つかりません: ${ref}`);
  const base = w.baseWeaponId != null ? idx.weapons.get(w.baseWeaponId) : null;
  const weapon = {
    attack: Number(w.attack ?? (base && base.attack)) || 0,
    affinity: Number(w.affinity ?? (base && base.affinity)) || 0,
    element: w.element && w.element.type ? { type: w.element.type, value: Number(w.element.value) || 0 } : null,
  };

  // 斬れ味: 固定ならその色、自動なら匠の Lv を入れたゲージの一番上の色 (スキルの組ごとに決め直す)
  const hc = [...idx.skills.values()].find((s) => s.name === '匠');
  const srcSharp = w.sharpness ?? (base && base.sharpness);
  const sharpForHandicraft = (lv) => {
    const gauge = [...(Array.isArray(srcSharp) ? srcSharp : srcSharp.base)];
    const maxG = base && base.sharpness && Array.isArray(base.sharpness.handicraftMax) ? base.sharpness.handicraftMax
      : srcSharp && Array.isArray(srcSharp.handicraftMax) ? srcSharp.handicraftMax : gauge;
    let budget = lv * HANDICRAFT_STEP;
    for (let i = 0; i < gauge.length && budget > 0; i++) {
      const add = Math.min(Math.max(0, (maxG[i] || 0) - gauge[i]), budget);
      gauge[i] += add;
      budget -= add;
    }
    let top = -1;
    gauge.forEach((n, i) => { if (n > 0) top = i; });
    return top >= 0 ? SHARPNESS_ORDER[top] : 'white';
  };
  const sharpOf = (list) => {
    if (st.sharpness) return st.sharpness;
    const h = hc ? list.find((s) => s.skillId === hc.id) : null;
    return sharpForHandicraft(h ? Number(h.level) || 0 : 0);
  };

  // コンボ (null = 先頭の代表コンボ)
  const combos = load('combos_sns.json').combos;
  const combo = st.combo == null ? combos[0]
    : Array.isArray(st.combo) ? st.combo : combos.find((c) => c.id === st.combo) || combos[0];

  // 相手 (モンスターの部位 / 手入力 / 決まっていなければ既定の肉質)。相手が使う状態異常 (狂竜症のもとの確かめ)
  const t = st.target;
  let target = { hitzone: DEFAULT_HITZONE, wound: null, isWound: !!t.isWound };
  let targetLabel = '既定の肉質';
  let monsterStatus = [];
  if (t.mode === 'manual') {
    target = { hitzone: t.manual.hitzone, wound: t.manual.wound || null, isWound: !!t.isWound };
    targetLabel = t.manual.name || '手入力';
  } else if (t.monsterId != null && t.partKey) {
    const m = load('monsters.json').monsters.find((x) => x.id === t.monsterId);
    const p = m && m.parts.find((x) => x.key === t.partKey);
    if (p) {
      // 個体 (歴戦王など) の傷口の置き換えは monsters.json の individuals[].hitzone から直接読む (hunt.js は使わない):
      // sameAsBase が false なら置き換え、null なら useUncertainWound のときだけ。傷口の無い部位は置き換えない
      const ind = t.individual ? (m.individuals || []).find((i) => i.kind === t.individual) : null;
      const hz = ind && ind.hitzone;
      const ov = hz && hz.woundOverrides && hz.woundOverrides[p.key];
      const useOv = !!(p.wound && ov && (hz.sameAsBase === false || (hz.sameAsBase == null && t.useUncertainWound === true)));
      target = { hitzone: p.hitzone, wound: useOv ? ov : (p.wound || null), isWound: !!t.isWound };
      targetLabel = `${(ind && ind.name) || m.name} ${p.name}`;
    }
    if (m) {
      const row = load('monster_threats.json').monsters.find((x) => x.monsterId === m.id);
      monsterStatus = [...new Set([...((row && row.statusEffects) || []).map((s) => s.key),
        ...((m.variants || []).includes('frenzied') ? ['frenzy'] : [])])];
    }
  }

  const calcInput = {
    weapon, uptimes: st.uptimes || {}, effects, motions: load('motions_sns.json'), combo, target, monsterStatus,
  };
  const calc = (list) => comboExpected({ ...calcInput, skills: list, sharpness: sharpOf(list) });
  const list = build.skills.filter((s) => s.level > 0).map((s) => ({ skillId: s.skillId, level: s.level }));
  const r = calc(list);
  const none = calc([]);
  // 1 つ外したときの低下 (skill_effects.json にあるスキルと、斬れ味の色で効く匠)
  const removeEach = list
    .filter((s) => effects.effects[String(s.skillId)] || (hc && s.skillId === hc.id))
    .filter((s) => !r.unsupported.some((u) => u.skillId === s.skillId))
    .map((s) => {
      const without = calc(list.filter((o) => o.skillId !== s.skillId)).total;
      const name = (effects.effects[String(s.skillId)] || {}).name || (hc && hc.name);
      return { skillId: s.skillId, name, dropPct: r.total > 0 ? (1 - without / r.total) * 100 : 0 };
    })
    .sort((a, b) => b.dropPct - a.dropPct);
  const out = {
    skills: build.skills.map((s) => ({ skillId: s.skillId, name: s.name, level: s.level, rawLevel: s.rawLevel, maxLevel: s.maxLevel })),
    errors: build.errors.map((e) => e.code),
    total: r.total, physical: r.physical, element: r.element, extra: r.extra,
    noSkills: none.total, vsNoSkillsPct: none.total > 0 ? (r.total / none.total - 1) * 100 : 0,
    topContribution: removeEach.length ? removeEach[0].name : null,
    sharpness: sharpOf(list), combo: Array.isArray(combo) ? combo : combo.name, target: targetLabel, weapon,
    lowConfidence: r.lowConfidence.map((s) => s.name), unsupported: r.unsupported.map((s) => s.name),
    warnings: r.warnings.map((x) => x.code),
  };
  process.stdout.write(JSON.stringify(out));
}

main();
