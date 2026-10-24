// 相手に合わせたおすすめの組み立て (段階 3): 守りのスキル・武器の属性・狙う部位・多頭の重み・作れない γ 防具の除外、
// Job (探索の入力の並び) への変換、探索を順に回す createPlanRunner、多頭の並べ直し、守りのチェック、耐性の合計。
// API は docs/RECOMMEND_DESIGN.md 5.3 節、使い方は docs/MODEL_API.md の「recommend.js」節。
// 純粋関数 (DOM にも state.js にも preact にも触らない)。Worker からも読むので import は相対パスだけ
// (damage.js / build.js / hunt.js / weapon.js だけを読む。探索の createSearch・optimizeWeaponSide は引数で受ける)。
//
// 決めごと (方針・仮。本人の決定 2026-10-21 で既定を決めた。docs/RECOMMEND_DESIGN.md 9 章):
//   - おすすめは「必須 (オン/オフ)」の条件に直してソルバに渡す。重み付きの目的にはしない (2.5 節)
//   - 守りの既定はバランス (歴戦王の防げる脅威と確定した属性やられだけオン。咆哮・風圧・振動・状態異常は参考)
//   - 属性やられの「属性やられ耐性 Lv3 または耐性の値 20 以上」は探索を 2 回に分けて合わせる (2.4 節)
//   - 多頭は T = Σ 体力_i / 期待値_i を小さくする。ソルバには w_i ∝ 体力_i / 期待値_ref_i² の重みで渡し、上位を T で並べ直す (3.1 節)
//   - 体力・回復系のスキルは自動では足さない (受けるダメージを計算できないため)
import { ARMOR_PARTS, computeBuild } from './build.js';
import { comboExpected, ELEMENTAL_TYPES } from './damage.js';
import {
  archTemperedRewards, clampPlayers, elementRecommendationOf, gammaIndex, hitzoneFor, individualOf, monsterById, monstersOf, questById,
  questSubjects, targetHealth,
} from './hunt.js';
import { autoSharpness, damageWeapon, resolveWeaponRef } from './weapon.js';

// ---------------------------------------------------------------- 定数

/**
 * 守りのスキルの段 (プリセット。方針・仮。docs/RECOMMEND_DESIGN.md 2.4 節の表)。
 * 値は脅威の種類ごとに 'on' (ソルバの必須にする) / 'ref' (参考。一覧に出して 1 タップでオンにできる)。
 *   hazard = 歴戦王の専用の脅威 (防ぐスキルあり)、blight = 属性やられ (確定)、roar / wind / tremor = 咆哮・風圧・振動、
 *   status = 状態異常 (防ぐスキルあり)、uncertain = 属性やられ (未確認)・確度 low の脅威 (どの段でも参考)
 */
export const PRESETS = Object.freeze({
  power: Object.freeze({ hazard: 'ref', blight: 'ref', roar: 'ref', wind: 'ref', tremor: 'ref', status: 'ref', uncertain: 'ref' }),
  balance: Object.freeze({ hazard: 'on', blight: 'on', roar: 'ref', wind: 'ref', tremor: 'ref', status: 'ref', uncertain: 'ref' }),
  safe: Object.freeze({ hazard: 'on', blight: 'on', roar: 'on', wind: 'on', tremor: 'on', status: 'on', uncertain: 'ref' }),
});
export const PRESET_LABEL = Object.freeze({ power: '火力優先', balance: 'バランス', safe: '安全' });
export const DEFAULT_PRESET = 'balance';
/** 属性の名前 (画面用) */
export const ELEMENT_LABEL = Object.freeze({ fire: '火', water: '水', thunder: '雷', ice: '氷', dragon: '龍' });
/** 脅威の種類の並び (要件の行の並び順) */
const CATEGORY_ORDER = ['hazard', 'blight', 'uncertain', 'roar', 'wind', 'tremor', 'status'];
/**
 * 本人が「守りのスキルを足す」で選べるスキル (体力・回復・回避・ガード。自動では足さない。2.4 節)。
 * 名前で skills.json を引く (defenseSkillChoices)。
 */
export const DEFENSE_SKILL_NAMES = Object.freeze([
  '回復速度', '体力回復量ＵＰ', '精霊の加護', '防御', 'ひるみ軽減', '回避性能', '回避距離ＵＰ', 'ガード性能', 'ガード強化',
]);
/** 武器 2 本の案で、2 本目を合わせる防具の組の数 (3.3 節) */
export const TWO_WEAPON_TOP = 5;
/**
 * 火力の差を測る回・武器 2 本の合わせがある Job で、探索の回に使う予算の割合 (planToJob)。
 * 残りは予算で切れない段 (合わせ・火力の差の途中の結果まで) の分 (2026-10-21 のベンチ S1〜S3 で決めた。docs/SEARCH_DESIGN.md 5 章)
 */
export const RUN_SHARE = 0.6;

// target_mix.js・equip_logic.js と同じ値 (model から ui を読まないので写している。同じことを tests/recommend.test.mjs で確かめる)
/** 相手が決まっていないときの肉質 (装備タブ・火力タブと同じ既定の肉質: 切断・打撃 45、属性 20) */
export const DEFAULT_HITZONE = Object.freeze({ slash: 45, blunt: 45, fire: 20, water: 20, thunder: 20, ice: 20, dragon: 20 });
export const DEFAULT_HITZONE_TEXT = '切断 45・打撃 45・属性 20';
/** 弱点とみなす切断肉質 (弱点特効と同じ 45) */
const WEAK_POINT_MIN = 45;
/** おすすめ属性の 1 位と 2 位の差がこれ以下なら「近い」 */
const CLOSE_GAP = 2;
/** 1 位の属性肉質の平均がこれ未満なら「どれも効きにくい」 */
const WEAK_AVG = 10;

const THREAT_TEXT = {
  roar: { weak: '咆哮【小】', strong: '咆哮【大】' },
  wind: { minor: '風圧【小】', major: '風圧【大】', dragon: '龍風圧' },
  tremor: { minor: '振動【小】', major: '振動【大】' },
};
/** monster_threats.json の rules のキーと行の項目 */
const THREAT_FIELDS = [
  { type: 'roar', field: 'roar', rule: 'roar' },
  { type: 'wind', field: 'windPressure', rule: 'windPressure' },
  { type: 'tremor', field: 'tremor', rule: 'tremor' },
];
const CONF_RANK = { high: 3, medium: 2, low: 1 };

const isObj = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const finite = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const uniq = (list) => [...new Set(list)];
const fmt = (n) => Math.round(n).toLocaleString('en-US');

// ---------------------------------------------------------------- 小さな部品

function threatsDoc(targetData) {
  if (!targetData) return null;
  if (isObj(targetData.threats) && Array.isArray(targetData.threats.monsters)) return targetData.threats;
  const list = targetData.lists && Array.isArray(targetData.lists.threats) ? targetData.lists.threats : null;
  return list ? { monsters: list, rules: {} } : null;
}

function threatRowOf(threats, monsterId) {
  const list = threats && Array.isArray(threats.monsters) ? threats.monsters : [];
  return list.find((x) => x && x.monsterId === monsterId) || null;
}

function effectsRules(effects) {
  return (effects && isObj(effects.rules)) ? effects.rules : {};
}

/** rules.resistSkills → {element: {skillId, levels: {Lv: 値}}} */
function resistByElement(effects) {
  const rs = effectsRules(effects).resistSkills;
  const out = {};
  if (!isObj(rs)) return out;
  for (const [id, def] of Object.entries(rs)) {
    if (!def || !def.element || !isObj(def.levels)) continue;
    out[def.element] = { skillId: Number(id), name: def.name || '', levels: def.levels };
  }
  return out;
}

/** 耐性スキルで threshold 以上になる一番低い Lv (無ければ一番高い Lv) */
function resistLevelFor(def, threshold) {
  const lvs = Object.keys(def.levels).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  for (const lv of lvs) if (Number(def.levels[String(lv)]) >= threshold) return lv;
  return lvs.length ? lvs[lvs.length - 1] : 3;
}

/** 部位の名前 (target_mix.js の partLabel と同じ。名前の無い部位は「部位不明 1」のように番号) */
function partLabel(part, monster) {
  if (!part) return '';
  if (part.unknownPart !== true) return part.name;
  const unknown = ((monster && monster.parts) || []).filter((p) => p.unknownPart === true)
    .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
  const i = unknown.findIndex((p) => p.key === part.key);
  return i >= 0 ? `部位不明 ${i + 1}` : '部位不明';
}

/** 名前のある部位を切断肉質の高い順 (同じなら傷口・データの並び)。target_mix.js の visibleParts(sort: 'slash') と同じ */
function namedPartsBySlash(monster) {
  return ((monster && monster.parts) || []).filter((p) => p.unknownPart !== true)
    .sort((a, b) => (b.hitzone?.slash ?? 0) - (a.hitzone?.slash ?? 0)
      || (b.wound?.slash ?? -1) - (a.wound?.slash ?? -1) || (a.ordinal ?? 0) - (b.ordinal ?? 0));
}

/**
 * 部位を自動で選ぶときの候補 (弱点 1 か所・主な部位 3 か所)。一時的な部位 (transient。ウズ・トゥナの水膜など、部位の体力が
 * 小さく傷口も無い層) は除く (それしか無ければ全部)。target_mix.js の defaultPartKey と同じ決まり
 */
function autoPickParts(monster) {
  const named = namedPartsBySlash(monster);
  const stable = named.filter((p) => p.transient !== true);
  return stable.length ? stable : named;
}

/** 武器の参照 (数値 / 文字列 / 要素) → 武器 (所持武器は元の武器で補う)。見つからなければ null */
function weaponOf(ref, index) {
  if (ref == null || !index) return null;
  if (typeof ref !== 'object') return resolveWeaponRef(ref, index);
  const base = ref.baseWeaponId != null && index.weapons ? index.weapons.get(ref.baseWeaponId) : null;
  if (!base) return ref;
  return {
    ...ref,
    attack: ref.attack ?? base.attack, affinity: ref.affinity ?? base.affinity, slots: ref.slots ?? base.slots,
    skills: ref.skills ?? base.skills, sharpness: ref.sharpness ?? base.sharpness,
  };
}

/** ダメージになる属性 (無ければ null) */
function elementOfWeapon(w) {
  const t = w && w.element && w.element.type;
  return ELEMENTAL_TYPES.includes(t) ? t : null;
}

/** state.combo → damage.js の combo (state.js の resolveCombo と同じ決まり) */
function resolveComboRef(combo, combos) {
  const list = combos && Array.isArray(combos.combos) ? combos.combos : Array.isArray(combos) ? combos : [];
  if (Array.isArray(combo) && combo.length) return combo;
  if (isObj(combo) && Array.isArray(combo.steps)) return combo;
  return (typeof combo === 'string' && list.find((x) => x.id === combo)) || list[0] || null;
}

/** 装備一式の組の印 (同じ組かを比べる。珠は見ない) */
function buildKey(b) {
  if (!b) return '';
  const w = isObj(b.weapon) ? `o:${b.weapon.id ?? JSON.stringify(b.weapon)}` : String(b.weapon);
  const a = ARMOR_PARTS.map((p) => (b.armor ? String(b.armor[p] ?? '-') : '-')).join(',');
  return `${w}|${a}|${String(b.charm ?? '-')}`;
}

/** 安定した JSON (キーを並べ替える)。ハッシュ用 */
function stableJson(x) {
  if (Array.isArray(x)) return `[${x.map(stableJson).join(',')}]`;
  if (isObj(x)) return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${stableJson(x[k])}`).join(',')}}`;
  return JSON.stringify(x === undefined ? null : x);
}

/** 短いハッシュ (FNV-1a 32bit を 2 つ。16 桁の 16 進) */
export function stableHash(value) {
  const s = typeof value === 'string' ? value : stableJson(value);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    h2 ^= h2 >>> 13;
  }
  return h1.toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------- 発動率 (仮置きの条件)

/**
 * 探索に使う発動率。mode 'zero' (既定) なら、本人が入れていない仮置きの条件 (rules.conditionGroups の placeholder) を 0% にする。
 * 'keep' なら火力タブの値 (入れていなければ既定値) のまま。本人が入れた値 (uptimes にあるもの) はどちらでもそのまま使う。
 * @returns {{mode, uptimes, placeholders: [{id, label, type, defaultUptime, zeroed}]}}
 *   placeholders = 本人が入れていない仮置きの条件 (探す前に一覧で見せる)
 */
export function searchUptimes(effects, uptimes, mode = 'zero') {
  const src = isObj(uptimes) ? uptimes : {};
  const groups = Array.isArray(effectsRules(effects).conditionGroups) ? effectsRules(effects).conditionGroups : [];
  const out = { ...src };
  const placeholders = [];
  for (const g of groups) {
    if (!g || !g.placeholder || !g.id) continue;
    const flat = Object.keys(src).some((k) => k.startsWith(`${g.id}.`));
    if (src[g.id] != null || flat) continue; // 本人が入れた
    const zeroed = mode !== 'keep';
    placeholders.push({ id: g.id, label: g.label || g.id, type: g.type || 'binary', defaultUptime: g.defaultUptime ?? null, zeroed });
    if (zeroed) out[g.id] = g.type === 'categorical' ? {} : 0;
  }
  return { mode: mode === 'keep' ? 'keep' : 'zero', uptimes: out, placeholders };
}

// ---------------------------------------------------------------- 期待値 (いまの装備・基準の装備)

/**
 * 装備一式の、相手の部位ごとのコンボ 1 回の期待値 (computeBuild + comboExpected。探索の評価と同じ式)。
 * @param build state.build と同じ形
 * @param targets [{weight, target, group?}] (ソルバの targets と同じ)
 * @param ctx {index, effects, motions, combo, uptimes, monsterStatus, sharpness (null = 自動), buffs, noSkills,
 *   errors (配列を渡すと、計算できなかった理由を入れる)}
 * @returns {{value, perTarget: number[], perGroup: {[group]: value}, skillLevels} | null}  武器が無い・計算できなければ null
 */
export function evaluateBuild(build, targets, ctx) {
  if (!build || !ctx || !ctx.index) return null;
  const w = weaponOf(build.weapon, ctx.index);
  if (!w) return null;
  const list = (Array.isArray(targets) ? targets : []).filter((t) => t && t.target && t.target.hitzone);
  if (!list.length) return null;
  const cb = ctx.noSkills ? null : computeBuild(build, ctx.index);
  const skillLevels = cb ? cb.skillLevels : {};
  const sharpness = ctx.sharpness || autoSharpness(w, ctx.index, skillLevels).color || 'white';
  const input = {
    weapon: damageWeapon(w), sharpness, skills: skillLevels, uptimes: ctx.uptimes || {}, effects: ctx.effects,
    motions: ctx.motions, combo: ctx.combo, monsterStatus: ctx.monsterStatus, buffs: ctx.buffs || {},
  };
  const perTarget = [];
  for (const t of list) {
    try {
      perTarget.push(comboExpected({ ...input, target: t.target }).total);
    } catch (e) {
      // MAX_PATTERNS を超えたなど。呼ぶ側が気づけるように ctx.errors に理由を残す
      if (Array.isArray(ctx.errors)) ctx.errors.push((e && e.message) || String(e));
      return null;
    }
  }
  const sumW = list.reduce((a, t) => a + Math.max(0, Number(t.weight) || 0), 0);
  const wOf = (t) => (sumW > 0 ? Math.max(0, Number(t.weight) || 0) / sumW : 1 / list.length);
  let value = 0;
  const groupW = {};
  const groupV = {};
  list.forEach((t, i) => {
    value += wOf(t) * perTarget[i];
    const g = t.group ?? '_';
    groupW[g] = (groupW[g] || 0) + wOf(t);
    groupV[g] = (groupV[g] || 0) + wOf(t) * perTarget[i];
  });
  const perGroup = {};
  for (const g of Object.keys(groupW)) perGroup[g] = groupW[g] > 0 ? groupV[g] / groupW[g] : 0;
  return { value, perTarget, perGroup, skillLevels };
}

// ---------------------------------------------------------------- 脅威 → 要件

/**
 * 相手ごとの脅威を集めて、1 件ずつ「防ぐスキルと Lv」を付ける (docs/RECOMMEND_DESIGN.md 2.4 節の表)。
 * monster_threats.json の値と rules だけを使う。歴戦王など threatVariant のある個体は variants の差分を見る
 * (sameAsBase が true の項目は通常の値を使い、未確認の印を付ける)。
 * @param threats monster_threats.json 丸ごと (data.js の target.threats)
 * @param subjects [{key, monsterId, kind, name, threatVariant?}]
 * @returns {Array<{key, subjectKey, subjectName, type, value, element?, skill, oneShot, confidence, uncertain, unconfirmed,
 *                  text, note, source}>}
 *   type: 'roar' | 'wind' | 'tremor' | 'blight' | 'status' | 'hazard'。skill = {skillId, name, negateLevel, mitigateLevel, levelText}
 *   (防ぐスキルが無ければ null で、note に理由。oneShot = 当たると力尽きる)。uncertain = 属性やられが未確認。
 *   unconfirmed = 歴戦王で「通常と同じ」と見ている値など、データで確かめていないもの。
 */
export function collectThreats(threats, subjects) {
  const rules = (threats && threats.rules) || {};
  const eb = rules.elementalBlight || {};
  const out = [];
  for (const s of Array.isArray(subjects) ? subjects : []) {
    if (!s || s.monsterId == null) continue;
    const row = threatRowOf(threats, s.monsterId);
    if (!row) continue;
    const vkey = s.threatVariant !== undefined ? s.threatVariant : (s.kind === 'arch-tempered' ? 'arch-tempered' : null);
    const variant = vkey && isObj(row.variants) && isObj(row.variants[vkey]) ? row.variants[vkey] : null;
    const same = variant && isObj(variant.sameAsBase) ? variant.sameAsBase : null;
    // 個体の差分: sameAsBase が true = 通常の値を使う (未確認)、false = 通常の値は使えない、無い = 分からない (通常の値で未確認)
    const baseUse = (field) => {
      if (!vkey || !variant) return { use: true, unconfirmed: false, confidence: null, note: null };
      if (same && same[field] === false) return { use: false };
      return {
        use: true, unconfirmed: true, confidence: (same && same.confidence) || 'medium',
        note: same && same[field] === true ? '通常の個体と同じと見ています' : 'この個体の値が分からないので、通常の個体の値を使っています',
      };
    };
    const push = (item) => out.push({
      subjectKey: s.key, subjectName: s.name || row.name || '', oneShot: false, uncertain: false,
      unconfirmed: false, confidence: null, note: null, source: row.wikiUrl || null, element: null, ...item,
    });
    const skillOf = (r) => (r && r.skillId != null ? {
      skillId: r.skillId, name: r.skill || '', negateLevel: r.negateLevel ?? null,
      mitigateLevel: r.mitigateLevel ?? null, levelText: r.levelText || null,
    } : null);

    for (const f of THREAT_FIELDS) {
      const v = row[f.field];
      if (v == null || v === 'none') continue;
      const b = baseUse(f.field);
      if (!b.use) continue;
      const r = rules[f.rule] && rules[f.rule][v];
      push({
        key: `${s.key}:${f.type}:${v}`, type: f.type, value: v, skill: skillOf(r),
        text: THREAT_TEXT[f.type][v] || v, unconfirmed: b.unconfirmed, confidence: b.confidence, note: b.note,
      });
    }
    const bb = baseUse('blights');
    if (bb.use) {
      const blightSkill = skillOf(eb.skill);
      for (const x of row.blights || []) {
        push({
          key: `${s.key}:blight:${x.element}`, type: 'blight', value: x.element, element: x.element, skill: blightSkill,
          text: x.name || `${ELEMENT_LABEL[x.element] || x.element}属性やられ`, unconfirmed: bb.unconfirmed,
          confidence: bb.unconfirmed ? bb.confidence : (eb.confidence || null), note: bb.note, source: eb.source || row.wikiUrl || null,
        });
      }
      for (const x of row.blightsUncertain || []) {
        push({
          key: `${s.key}:blight:${x.element}`, type: 'blight', value: x.element, element: x.element, skill: blightSkill,
          text: x.name || `${ELEMENT_LABEL[x.element] || x.element}属性やられ`, uncertain: true, unconfirmed: true,
          confidence: bb.confidence, note: x.reason || '属性やられになるかは未確認です', source: row.wikiUrl || null,
        });
      }
    }
    const bs = baseUse('statusEffects');
    if (bs.use) {
      for (const x of row.statusEffects || []) {
        const r = rules.status && rules.status[x.key];
        const noSkill = rules.noSkill && rules.noSkill[x.key];
        push({
          key: `${s.key}:status:${x.key}`, type: 'status', value: x.key, skill: skillOf(r), text: x.name || x.key,
          unconfirmed: bs.unconfirmed, confidence: bs.confidence,
          note: r ? bs.note : (noSkill || '防ぐスキルの情報がありません'),
        });
      }
    }
    for (const h of (variant && variant.hazards) || []) {
      push({
        key: `${s.key}:hazard:${h.key}`, type: 'hazard', value: h.key, skill: skillOf(h.skill), oneShot: h.oneShot === true,
        text: h.text || h.key, confidence: h.confidence || null, unconfirmed: h.confidence === 'medium' || h.confidence === 'low',
        note: h.skill ? (h.note || null) : (h.noSkill || '防げる防具スキルの記載はありません'), source: h.source || variant.source || null,
      });
    }
  }
  return out;
}

/** 防具スキルで防げる脅威か (防ぐスキルと無効にする Lv が分かる) */
function isDefendable(item) {
  return !!(item.skill && item.skill.skillId != null && item.skill.negateLevel != null);
}

/** 脅威 1 件の種類 (プリセットの表の行) */
function categoryOf(item) {
  if (item.uncertain || item.confidence === 'low') return 'uncertain';
  if (item.type === 'blight') return 'blight';
  return item.type;
}

/** 行の根拠の確度 (行に入った脅威のうち一番高いもの。データに確度の書いていない wiki の値は high と同じに扱う) */
function rowConfidence(items) {
  let best = 0;
  for (const i of items) best = Math.max(best, i.confidence == null ? 3 : (CONF_RANK[i.confidence] || 0));
  return best;
}

/** 「咆哮【小】 (レ・ダウ・ウズ・トゥナ)」のように、同じ脅威の相手をまとめた文 */
function reasonText(items, multi) {
  const byText = new Map();
  for (const i of items) {
    if (!byText.has(i.text)) byText.set(i.text, []);
    const names = byText.get(i.text);
    if (!names.includes(i.subjectName)) names.push(i.subjectName);
  }
  return [...byText.entries()].map(([t, names]) => (multi ? `${t} (${names.join('・')})` : t)).join('・');
}

/**
 * 脅威 → 守りの要件の行 (段・まとめ・「または」・仮/未確認の印)。同じスキルの要るものは 1 行にまとめ (Lv は大きい方。理由は全部残す)、
 * 属性やられは確定の属性で 1 行・未確認の属性で 1 行 (どちらも「属性やられ耐性 Lv3 または 耐性の値 20 以上」)。
 * @param items collectThreats の結果
 * @param opts {preset, toggles: {key: bool}, levels: {key: Lv}, effects (rules.resistSkills), threshold, blightSkill}
 * @returns {Array<{key, kind: 'skill'|'blight', label, reason, skillId?, skillName?, elements?, threshold?, blightSkillId?,
 *   bySkill?, byResist?, orText?, options: [[{skillId, level}]...], level, levelChoices, negateLevel, mitigateLevel, mitigated,
 *   tier: 'on'|'ref', defaultOn, on, userSet, category, why: [{subjectKey, subjectName, text, type, note}], provisional, unconfirmed}>}
 *   options は「または」(どれか 1 つの組を満たせばよい。属性やられは bySkill と byResist)。tier = プリセットでの扱い、
 *   on = 本人のオン/オフ (toggles) を入れたもの。level = 本人が選んだ Lv (levels。levelChoices の中) か無効にする Lv。
 */
export function requirementsFrom(items, opts = {}) {
  const preset = PRESETS[opts.preset] ? opts.preset : DEFAULT_PRESET;
  const table = PRESETS[preset];
  const toggles = isObj(opts.toggles) ? opts.toggles : {};
  const levels = isObj(opts.levels) ? opts.levels : {};
  const resist = resistByElement(opts.effects);
  const threshold = finite(opts.threshold) ?? 20;
  const multi = uniq((items || []).map((i) => i.subjectKey)).length > 1;
  const groups = new Map();
  for (const it of items || []) {
    let key;
    if (it.type === 'blight') key = it.uncertain ? 'blight-uncertain' : 'blight';
    else if (isDefendable(it)) key = `skill:${it.skill.skillId}`;
    else continue; // 防げないもの (notes)
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const rows = [];
  for (const [key, list] of groups) {
    const cats = list.map(categoryOf);
    const tier = cats.some((c) => table[c] === 'on') ? 'on' : 'ref';
    const category = CATEGORY_ORDER.find((c) => cats.includes(c)) || cats[0];
    const why = list.map((i) => ({ subjectKey: i.subjectKey, subjectName: i.subjectName, text: i.text, type: i.type, note: i.note }));
    const conf = rowConfidence(list);
    const base = {
      key, tier, defaultOn: tier === 'on', userSet: typeof toggles[key] === 'boolean', category, why,
      reason: reasonText(list, multi), provisional: conf < 3, unconfirmed: list.every((i) => i.unconfirmed || i.uncertain),
    };
    base.on = base.userSet ? toggles[key] : base.defaultOn;
    const top = list.reduce((a, i) => ((i.skill?.negateLevel ?? 0) > (a.skill?.negateLevel ?? 0) ? i : a), list[0]);
    const negateLevel = top.skill?.negateLevel ?? null;
    const mitigateLevel = top.skill?.mitigateLevel ?? null;
    // 選べる Lv = 軽減の Lv 〜 無効の Lv (軽減の Lv が無ければ無効の Lv だけ)。既定は無効の Lv
    const low = mitigateLevel != null && negateLevel != null ? Math.min(mitigateLevel, negateLevel) : negateLevel;
    const levelChoices = negateLevel == null ? [] : Array.from({ length: negateLevel - low + 1 }, (_, i) => low + i);
    const chosen = Number(levels[key]);
    const level = negateLevel == null ? null
      : (levelChoices.includes(chosen) ? chosen : negateLevel);
    const lv = { level, negateLevel, mitigateLevel, levelChoices, mitigated: level != null && level < negateLevel };
    if (key.startsWith('blight')) {
      const elements = uniq(list.map((i) => i.element).filter(Boolean));
      const names = elements.map((e) => ELEMENT_LABEL[e] || e);
      const blightSkillId = top.skill?.skillId ?? null;
      // 「または」の 2 つ: 属性やられ耐性 (bySkill) / 各属性の耐性スキルで耐性の値を threshold 以上に (byResist)
      const bySkill = blightSkillId != null && level != null ? [{ skillId: blightSkillId, level }] : null;
      const byResist = elements.length && elements.every((e) => resist[e])
        ? elements.map((e) => ({ skillId: resist[e].skillId, level: resistLevelFor(resist[e], threshold) })) : null;
      // 耐性スキルをその Lv にしたとき、守りのチェック (耐性の合計 ≥ threshold) に防具 5 部位の耐性の合計が要る下限
      // (探索の条件 armorResistMin。2026-10-24: 所持護石が増えると、耐性の回の上位が「防具の耐性が足りない組」で埋まり、
      // 守りを満たす組が上位の外に押し出されたため。いまのデータは耐性スキルの必須の Lv = 最大の Lv なので、これで過不足が無い)
      const byResistArmorMin = byResist
        ? Object.fromEntries(elements.map((e, i) => [e, threshold - (Number(resist[e].levels[String(byResist[i].level)]) || 0)])) : null;
      const skillName = top.skill?.name || '属性やられ耐性';
      rows.push({
        ...base, ...lv, kind: 'blight', elements, threshold, blightSkillId, skillName, bySkill, byResist, byResistArmorMin,
        label: `${names.join('・')}属性やられを防ぐ`,
        orText: `${skillName} Lv${level ?? '?'}、または ${names.join('・')}の耐性を${elements.length > 1 ? 'それぞれ ' : ''}${threshold} 以上`,
        options: [bySkill, byResist].filter(Boolean),
      });
    } else {
      const s = top.skill;
      rows.push({
        ...base, ...lv, kind: 'skill', skillId: s.skillId, skillName: s.name, label: `${s.name} Lv${level}`,
        options: [[{ skillId: s.skillId, level }]],
      });
    }
  }
  rows.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
  return rows;
}

/** 防げない攻撃・防ぐスキルの無い状態異常 → 注意の文 */
function notesFrom(items) {
  return (items || []).filter((i) => i.type !== 'blight' && !isDefendable(i)).map((i) => ({
    subjectKey: i.subjectKey, subjectName: i.subjectName, text: i.note ? `${i.text}: ${i.note}` : i.text,
    oneShot: i.oneShot, source: i.source, type: i.type,
  }));
}

// ---------------------------------------------------------------- 武器の属性

/**
 * おすすめの属性の見せ方 (target_mix.js の recommendationView と同じ決まり)。
 * @returns {{kind: 'none'|'weak'|'close'|'clear', best, top, gap, weapon: 'same'|'close'|'other'|null}}
 */
export function elementView(rec, weaponElem) {
  const r = rec || {};
  const best = r.best || [];
  const order = r.order || [];
  if (!best.length || !order.length) return { kind: 'none', best, top: null, gap: null, weapon: null };
  const top = order[0].avg;
  const gap = order.length > 1 ? top - order[1].avg : null;
  let kind = 'clear';
  if (top < WEAK_AVG) kind = 'weak';
  else if (r.tieBreak || (gap != null && gap <= CLOSE_GAP)) kind = 'close';
  let weapon = null;
  if (weaponElem) {
    const mine = order.find((o) => o.type === weaponElem);
    if (best.includes(weaponElem)) weapon = 'same';
    else if (kind !== 'clear' || (mine && top - mine.avg <= CLOSE_GAP)) weapon = 'close';
    else weapon = 'other';
  }
  return { kind, best, top, gap, weapon };
}

/** おすすめの属性のうち 1 位と差が CLOSE_GAP 以内のもの (どれも効きにくいときは []) */
function nearTypes(rec, view) {
  if (!rec || (view.kind !== 'clear' && view.kind !== 'close')) return [];
  return (rec.order || []).filter((o) => ELEMENTAL_TYPES.includes(o.type) && view.top - o.avg <= CLOSE_GAP).map((o) => o.type);
}

/** その属性の片手剣 (weapons_sns の id) と所持武器 (my_weapons の id)・端末の所持武器 (要素) */
function weaponsOfTypes(types, index, extraWeapons) {
  const set = new Set(types);
  const out = [];
  if (!set.size || !index) return out;
  for (const w of index.weapons ? index.weapons.values() : []) if (set.has(elementOfWeapon(w))) out.push(w.id);
  for (const w of index.myWeapons ? index.myWeapons.values() : []) if (set.has(elementOfWeapon(weaponOf(w.id, index)))) out.push(w.id);
  // この端末の所持アーティア (my_weapons の形)。探索の weapons には id で入れる (要素は input.extraWeapons で渡す)。
  // 索引に入っている (画面の索引は端末の武器も入れる) ものは上で数えたので重ねない
  for (const w of Array.isArray(extraWeapons) ? extraWeapons : []) {
    const id = isObj(w) ? w.id : w;
    if (id == null || out.includes(id)) continue;
    if (set.has(elementOfWeapon(weaponOf(w, index)))) out.push(id);
  }
  return out;
}

/**
 * 武器の選び方 (docs/RECOMMEND_DESIGN.md 2.3 節) と、多頭で武器を 2 本にする案 (3.3 節)。
 * @param subjects [{key, rec (elementRecommendation)}]
 * @param current {build, extraWeapons}
 * @param index 装備の索引 (indexEquipData の結果)
 * @param opts {mode: 'auto'|'current'|'element'|'all', twoWeapons: 'auto'|'on'|'off', time: {subjectKey: 時間の割合}}
 * @returns {{mode, requestedMode, weapons: Array|'sns-all', types, perSubject: [{key, rec, view}], currentRef, currentElement,
 *            text, warnings, twoWeapons: {option, suggested, reason, groups: [{element, subjectKeys, weapons}]}}}
 */
export function elementPlan(subjects, current, index, opts = {}) {
  const list = Array.isArray(subjects) ? subjects : [];
  const requestedMode = ['auto', 'current', 'element', 'all'].includes(opts.mode) ? opts.mode : 'auto';
  const currentRef = current && current.build ? current.build.weapon ?? null : null;
  const extraWeapons = current && Array.isArray(current.extraWeapons) ? current.extraWeapons : [];
  const cw = weaponOf(currentRef, index);
  const currentElement = elementOfWeapon(cw);
  const hasWeapon = !!cw;
  const warnings = [];
  const perSubject = list.map((s) => ({ key: s.key, rec: s.rec || null, view: elementView(s.rec, currentElement) }));
  const multi = list.length > 1;
  let types;
  if (multi) types = uniq(perSubject.filter((p) => p.view.kind === 'clear').flatMap((p) => p.view.best));
  else types = perSubject.length ? nearTypes(perSubject[0].rec, perSubject[0].view) : [];
  types = types.filter((t) => ELEMENTAL_TYPES.includes(t));

  let mode = requestedMode;
  if (mode === 'auto') {
    if (!multi && hasWeapon && perSubject[0] && ['same', 'close'].includes(perSubject[0].view.weapon)) mode = 'current';
    else if (types.length) mode = 'element';
    else mode = hasWeapon ? 'current' : 'all';
  }
  if (mode === 'current' && !hasWeapon) {
    warnings.push({ code: 'no-weapon', message: '装備タブで武器を選んでいないので、ほかの武器から探します' });
    mode = types.length ? 'element' : 'all';
  }
  let weapons;
  if (mode === 'current') weapons = [currentRef];
  else if (mode === 'element') {
    weapons = weaponsOfTypes(types, index, extraWeapons);
    if (!weapons.length) {
      warnings.push({ code: 'no-element-weapon', message: 'おすすめの属性の片手剣が見つからないので、全部から探します' });
      mode = 'all';
      weapons = 'sns-all';
    } else if (hasWeapon && !weapons.some((w) => w === currentRef)) weapons.push(currentRef); // 比べるため
  } else weapons = 'sns-all';

  const names = (ts) => ts.map((t) => ELEMENT_LABEL[t] || t).join('・');
  const text = mode === 'current' ? 'いまの武器で探します'
    : mode === 'element' ? `おすすめの属性 (${names(types)}) の片手剣から探します`
      : '片手剣を全部から探します (時間がかかります)';

  // 武器 2 本の案: はっきりした 1 位の属性が 2 種類以上 (3 種類以上なら時間の割合が大きい 2 つ)
  const option = ['auto', 'on', 'off'].includes(opts.twoWeapons) ? opts.twoWeapons : 'auto';
  const time = isObj(opts.time) ? opts.time : {};
  const byType = new Map();
  for (const p of perSubject) {
    if (p.view.kind !== 'clear') continue;
    const t = p.view.best.find((x) => ELEMENTAL_TYPES.includes(x));
    if (!t) continue;
    if (!byType.has(t)) byType.set(t, { element: t, subjectKeys: [], time: 0 });
    const g = byType.get(t);
    g.subjectKeys.push(p.key);
    g.time += finite(time[p.key]) ?? 1;
  }
  const ranked = [...byType.values()].sort((a, b) => b.time - a.time);
  const groups = ranked.slice(0, 2).map((g) => ({
    element: g.element, subjectKeys: g.subjectKeys, timeShare: g.time, weapons: weaponsOfTypes([g.element], index, extraWeapons),
  })).filter((g) => g.weapons.length);
  let suggested = false;
  let reason;
  if (!multi) reason = '相手が 1 体なので武器は 1 本です';
  else if (option === 'off') reason = '武器は 1 本で探します';
  else if (groups.length < 2) reason = '属性の違う相手がいないので武器は 1 本です';
  else {
    suggested = true;
    reason = `${names(groups.map((g) => g.element))}の武器を持ち替える案も出します (防具・護石は共通)`;
  }
  return {
    mode, requestedMode, weapons, types, perSubject, currentRef, currentElement, text, warnings,
    twoWeapons: { option, suggested, reason, groups: suggested ? groups : [] },
  };
}

// ---------------------------------------------------------------- 部位の狙い方

/**
 * 狙う部位 (docs/RECOMMEND_DESIGN.md 2.6 節) と、個体の傷口の置き換え (hunt.hitzoneFor) を入れたソルバの targets。
 * @param monster monsters.json の 1 件
 * @param kind 個体 (null = 通常)
 * @param policy 'asSelected' (相手タブで選んだ部位・割合。memo に無ければ weak1) | 'weak1' (弱点 1 か所) | 'main3' (主な部位 3 か所・仮)。
 *   weak1 と main3 は一時的な部位 (transient。水膜など) を選ばない (autoPickParts)
 * @param memo {[monsterId]: {partKey, mix: {on, weights}}} 相手タブで選んだ部位 (tabs.target.memo といまの相手)
 * @param isWound 傷口を狙うか (全部の相手に同じに使う)
 * @param opts {useUncertain} 確度の低い傷口の置き換え (歴戦王アルシュベルド) を使うか
 * @returns {Array<{weight, label, partKey, target: {hitzone, wound, isWound}, woundSource, woundMark}>} 決まらなければ []
 */
export function partsTargets(monster, kind, policy, memo, isWound, opts = {}) {
  if (!monster) return [];
  const parts = monster.parts || [];
  const byKey = (k) => parts.find((p) => p.key === k) || null;
  let shares = null;
  const sel = isObj(memo) ? memo[monster.id] ?? memo[String(monster.id)] : null;
  if (policy === 'asSelected' && isObj(sel)) {
    const mix = isObj(sel.mix) && sel.mix.on === true && (sel.mix.monsterId == null || sel.mix.monsterId === monster.id)
      ? sel.mix : null;
    if (mix && isObj(mix.weights)) {
      const list = parts.filter((p) => Number(mix.weights[p.key]) > 0)
        .map((p) => ({ part: p, raw: Math.min(1, Number(mix.weights[p.key])) }));
      const sum = list.reduce((a, x) => a + x.raw, 0);
      if (list.length && sum > 0) shares = list.map((x) => ({ part: x.part, share: x.raw / sum }));
    }
    if (!shares && sel.partKey && byKey(sel.partKey)) shares = [{ part: byKey(sel.partKey), share: 1 }];
  }
  if (!shares && policy === 'main3') {
    const main = autoPickParts(monster).filter((p) => (Number(p.hitzone?.slash) || 0) >= WEAK_POINT_MIN).slice(0, 3);
    if (main.length) shares = main.map((p) => ({ part: p, share: 1 / main.length }));
  }
  if (!shares) {
    const first = autoPickParts(monster)[0];
    if (first) shares = [{ part: first, share: 1 }];
  }
  if (!shares) return [];
  return shares.map(({ part, share }) => {
    const hz = hitzoneFor(monster, part, kind, { useUncertain: opts.useUncertain === true });
    return {
      weight: share, label: partLabel(part, monster), partKey: part.key,
      target: { hitzone: hz.hitzone, wound: hz.wound || null, isWound: !!isWound },
      woundSource: hz.woundSource, woundMark: hz.mark,
    };
  });
}

// ---------------------------------------------------------------- 多頭の重み

/** 体力の値 (targetHealth の結果か {mid}) → {mid, min, max} か null。人数の倍率を掛けた total を優先する */
function healthOf(h, useTotal) {
  if (h == null) return null;
  if (typeof h === 'number') return h > 0 ? { mid: h, min: h, max: h } : null;
  if (!isObj(h) || h.known === false) return null;
  if ('solo' in h || 'total' in h) {
    const src = useTotal && h.total ? h.total : h.solo;
    return src && finite(src.mid) > 0 ? { mid: src.mid, min: src.min ?? src.mid, max: src.max ?? src.mid } : null;
  }
  return finite(h.mid) > 0 ? { mid: h.mid, min: h.min ?? h.mid, max: h.max ?? h.mid } : null;
}

/**
 * 相手ごとの体力 (T と重みに使う)。体力が分からない相手は、分かっている相手の平均で置く (assumed)。全員分からなければ全部 1 (等分)。
 * 人数の倍率 (total) は全員分かるときだけ使う (同じクエストの相手で表が違うことがあるため。3.2 節)。
 * @returns {Array<{key, health: {mid, min, max}, assumed: boolean, basis: 'total'|'solo'|'average'|'equal'}>}
 */
export function subjectHealths(subjects) {
  const list = Array.isArray(subjects) ? subjects : [];
  const known = list.filter((s) => healthOf(s.health, false));
  const useTotal = known.length > 0 && known.every((s) => healthOf(s.health, true) && isObj(s.health) && s.health.total);
  const vals = list.map((s) => healthOf(s.health, useTotal));
  const ok = vals.filter(Boolean);
  const avg = ok.length ? ok.reduce((a, h) => a + h.mid, 0) / ok.length : null;
  return list.map((s, i) => {
    if (vals[i]) return { key: s.key, health: vals[i], assumed: false, basis: useTotal ? 'total' : 'solo' };
    if (avg != null) return { key: s.key, health: { mid: avg, min: avg, max: avg }, assumed: true, basis: 'average' };
    return { key: s.key, health: { mid: 1, min: 1, max: 1 }, assumed: true, basis: 'equal' };
  });
}

/**
 * 多頭の重み (docs/RECOMMEND_DESIGN.md 3.1 節): w_i ∝ H_i / D_ref_i² (= 基準の装備で T を 1 次で近づけた向き)。
 * D_ref が分からない相手は、分かっている相手の平均で置く。全員分からなければ w_i ∝ H_i。
 * @param subjects [{key, name, health}] (health は targetHealth の結果か {mid})
 * @param dRef {[subjectKey]: 基準の装備の 1 コンボの期待値}
 * @returns {Array<{key, weight (足して 1), time, timeShare, health, healthAssumed, healthBasis, dRef, dRefAssumed, reason}>}
 *   time = H_i / D_ref_i (その相手にかかる回数の目安)、timeShare = 時間の割合
 */
export function multiWeights(subjects, dRef) {
  const list = Array.isArray(subjects) ? subjects : [];
  const hs = subjectHealths(list);
  const d = list.map((s) => {
    const v = dRef instanceof Map ? dRef.get(s.key) : isObj(dRef) ? dRef[s.key] : null;
    return finite(v) > 0 ? v : null;
  });
  const okD = d.filter((v) => v != null);
  const avgD = okD.length ? okD.reduce((a, b) => a + b, 0) / okD.length : null;
  const raw = list.map((s, i) => {
    const H = hs[i].health.mid;
    const D = d[i] ?? avgD;
    return { H, D, w: D != null ? H / (D * D) : H, time: D != null ? H / D : H };
  });
  const sumW = raw.reduce((a, x) => a + x.w, 0);
  const sumT = raw.reduce((a, x) => a + x.time, 0);
  return list.map((s, i) => {
    const h = hs[i];
    const parts = [];
    if (h.basis === 'average') parts.push(`体力が分からないので、分かっている相手の平均 (${fmt(h.health.mid)}) で置きました`);
    else if (h.basis === 'equal') parts.push('体力が分からないので、全員を同じに見ています');
    else parts.push(`体力 ${fmt(h.health.mid)}`);
    if (d[i] == null && avgD != null) parts.push('期待値はほかの相手の平均で置きました');
    return {
      key: s.key, name: s.name || '', weight: sumW > 0 ? raw[i].w / sumW : 1 / list.length,
      time: raw[i].time, timeShare: sumT > 0 ? raw[i].time / sumT : 1 / list.length,
      health: h.health, healthAssumed: h.assumed, healthBasis: h.basis, dRef: raw[i].D, dRefAssumed: d[i] == null,
      reason: parts.join('。'),
    };
  });
}

// ---------------------------------------------------------------- γ 防具・狩猟証γ の護石

/**
 * γ 防具・狩猟証γ の護石と、それを作るのに倒す歴戦王 (結果に「歴戦王〇〇の素材が要ります」の印を付ける)。
 * 表は hunt.js の gammaIndex (探索の gammaIndexOf・探すタブと同じもの)。
 * @returns {{armor: {[armorId]: {monsterId, name}}, charmsFixed: {[charmId]: {monsterId, name}}, monsters}}
 */
export { gammaIndex };

/**
 * 倒していない歴戦王の γ 防具と狩猟証γ の護石を外す (docs/RECOMMEND_DESIGN.md 2.7 節)。
 * @param hunted state.search.archTemperedHunted ({monsterId: false} 倒していない歴戦王だけ。無い = 倒した扱い)
 * @returns {{armor: [id...], charmsFixed: [id...], labels: [{monsterId, name, hunted, armorSets, armorIds, charmFixedIds, certificate}],
 *            notes: [{code, message}]}}
 */
export function gammaExclusions(targetData, hunted) {
  const h = isObj(hunted) ? hunted : {};
  const notHunted = (id) => h[String(id)] === false || h[id] === false;
  const labels = archTemperedRewards(targetData).map((r) => ({ ...r, hunted: !notHunted(r.monsterId) }));
  const out = labels.filter((r) => !r.hunted);
  const notes = [];
  if (out.length) {
    const names = out.map((r) => r.name).join('・');
    const skills = uniq(out.flatMap((r) => r.groupSkills.map((g) => g.name)));
    const rest = labels.filter((r) => r.hunted);
    notes.push({
      code: 'gamma-excluded',
      message: `倒していない歴戦王 (${names}) の γ 防具と護石は使いません`
        + (skills.length ? (rest.length
          ? `。${skills.join('・')} は残りの γ 防具だけで数えます`
          : `。γ 防具が無いので ${skills.join('・')} は使えません`) : ''),
    });
  }
  return {
    armor: out.flatMap((r) => r.armorIds), charmsFixed: out.flatMap((r) => r.charmFixedIds), labels, notes,
  };
}

// ---------------------------------------------------------------- 守りのチェック・耐性の合計

/** 防具の参照 → 要素 */
function armorOf(ref, index) {
  if (ref == null) return null;
  if (isObj(ref)) return ref;
  return index && index.armor ? index.armor.get(ref) || null : null;
}

/**
 * 属性の耐性の合計 = 防具 5 部位の resist の和 + 耐性スキル (skill_effects.json の rules.resistSkills)。
 * 限界突破で耐性の値は変わらないものとして計算する (分からないため。docs/RECOMMEND_DESIGN.md 5.8 節)。
 * @param build state.build と同じ形
 * @param opts {computed: computeBuild の結果 (あれば使い回す)}
 * @returns {{fire, water, thunder, ice, dragon}}
 */
export function resistTotals(build, index, effects, opts = {}) {
  const out = { fire: 0, water: 0, thunder: 0, ice: 0, dragon: 0 };
  if (!build) return out;
  for (const p of ARMOR_PARTS) {
    const a = armorOf(build.armor && build.armor[p], index);
    if (!a || !isObj(a.resist)) continue;
    for (const e of ELEMENTAL_TYPES) out[e] += Number(a.resist[e]) || 0;
  }
  const cb = opts.computed || computeBuild(build, index);
  for (const [e, def] of Object.entries(resistByElement(effects))) {
    const lv = Number(cb.skillLevels[def.skillId] ?? cb.skillLevels[String(def.skillId)]) || 0;
    if (lv > 0 && e in out) {
      const lvs = Object.keys(def.levels).map(Number).filter((x) => x <= lv);
      const top = lvs.length ? Math.max(...lvs) : null;
      if (top != null) out[e] += Number(def.levels[String(top)]) || 0;
    }
  }
  return out;
}

/**
 * 装備が守りの要件を満たすか (行ごとに ok / mitigated / missing)。属性やられは「属性やられ耐性 Lv3」か「耐性の合計が 20 以上」。
 * @param build state.build と同じ形
 * @param requirements requirementsFrom の行 (job.requirements でもよい)。on が false の行は ok の判定に入れない
 * @param opts {computed: computeBuild の結果}
 * @returns {{ok: boolean, rows: [{key, label, status: 'ok'|'mitigated'|'missing', meets, have, need, negateLevel, mitigateLevel,
 *            on, via?: 'skill'|'resist'|null, elements?: [{element, total, ok, short}], text}], resist}}
 *   meets = 選んだ Lv (軽減の Lv を選んだときはそれ) を満たすか。text は画面の短い文 (「火耐性の合計 17 (あと 3)」など)
 */
export function defenseCheck(build, requirements, index, effects, opts = {}) {
  const cb = opts.computed || computeBuild(build || {}, index);
  const lvOf = (id) => Number(cb.skillLevels[id] ?? cb.skillLevels[String(id)]) || 0;
  let totals = null;
  const rows = (Array.isArray(requirements) ? requirements : []).map((r) => {
    const on = r.on !== false;
    if (r.kind === 'blight') {
      totals = totals || resistTotals(build, index, effects, { computed: cb });
      const have = r.blightSkillId != null ? lvOf(r.blightSkillId) : 0;
      const threshold = finite(r.threshold) ?? 20;
      const elements = (r.elements || []).map((e) => {
        const total = totals[e] ?? 0;
        return { element: e, total, ok: total >= threshold, short: Math.max(0, threshold - total) };
      });
      const bySkill = r.negateLevel != null && have >= r.negateLevel;
      const byResist = elements.length > 0 && elements.every((x) => x.ok);
      const status = bySkill || byResist ? 'ok' : (r.mitigateLevel != null && have >= r.mitigateLevel ? 'mitigated' : 'missing');
      const meets = status === 'ok' || (r.level != null && have >= r.level);
      const text = bySkill ? `${r.skillName || '属性やられ耐性'} Lv${have}`
        : elements.map((x) => `${ELEMENT_LABEL[x.element] || x.element}耐性の合計 ${x.total}${x.ok ? '' : ` (あと ${x.short})`}`).join('・');
      return {
        key: r.key, label: r.label, kind: 'blight', status, meets, have, need: r.level, negateLevel: r.negateLevel,
        mitigateLevel: r.mitigateLevel, on, via: bySkill ? 'skill' : byResist ? 'resist' : null, elements, text,
      };
    }
    const have = lvOf(r.skillId);
    const status = r.negateLevel != null && have >= r.negateLevel ? 'ok'
      : (r.mitigateLevel != null && have >= r.mitigateLevel ? 'mitigated' : 'missing');
    const sk = index && index.skills ? index.skills.get(r.skillId) : null;
    const name = r.skillName || (sk ? sk.name : '');
    return {
      key: r.key, label: r.label || `${name} Lv${r.level}`, kind: 'skill', status, meets: have >= (r.level ?? r.negateLevel ?? 1),
      have, need: r.level, negateLevel: r.negateLevel, mitigateLevel: r.mitigateLevel, on, user: !!r.user,
      text: have > 0 ? `${name} Lv${have}` : 'なし',
    };
  });
  return { ok: rows.filter((x) => x.on).every((x) => x.meets), rows, resist: totals };
}

/** 本人が「守りのスキルを足す」で選べるスキル [{skillId, name, kind, maxLevel}] (skills.json にあるものだけ) */
export function defenseSkillChoices(index) {
  const out = [];
  if (!index || !index.skills) return out;
  for (const name of DEFENSE_SKILL_NAMES) {
    for (const s of index.skills.values()) {
      if (s.name === name) out.push({ skillId: s.id, name: s.name, kind: s.kind, maxLevel: s.maxLevel });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 相手 → Plan

/** 相手が使う状態異常 (target_mix.js の monsterStatusOf と同じ: statusEffects + 狂竜化した個体がいれば frenzy) */
function monsterStatusFor(monster, threats) {
  if (!monster) return [];
  const row = threatRowOf(threats, monster.id);
  const out = new Set(((row && row.statusEffects) || []).map((s) => s.key));
  if ((monster.variants || []).includes('frenzied')) out.add('frenzy');
  return [...out];
}

/** 出典・ライセンスの表記 (CC BY-SA のものは画面に出す) */
function licensesOf(targetData) {
  const out = [];
  const add = (lic, what) => {
    if (!isObj(lic) || !lic.name) return;
    if (out.some((x) => x.name === lic.name && x.attribution === lic.attribution)) {
      out.find((x) => x.name === lic.name && x.attribution === lic.attribution).what.push(what);
      return;
    }
    out.push({ name: lic.name, url: lic.url || null, attribution: lic.attribution || '', what: [what] });
  };
  const th = threatsDoc(targetData);
  add(th && th.meta && th.meta.license, '咆哮・風圧・属性やられなど');
  const q = targetData && isObj(targetData.quests) ? targetData.quests : null;
  add(q && q.meta && q.meta.license, 'クエストと体力');
  return out;
}

/**
 * 相手 (state.target) から戦う相手の一覧を作る。クエストを選んでいればその mission.targets の行ごと (多頭なら全部)。
 * @returns {{quest, subjects: [{index, key, monsterId, name, kind, missionTarget, health, paramGroup}], warnings}}
 */
function subjectsFor(target, targetData, players, useTarget) {
  const warnings = [];
  const monster = monsterById(targetData, target.monsterId);
  if (!monster) return { quest: null, subjects: [], warnings, monster: null };
  const kind = target.individual ?? null;
  const ind = kind != null ? individualOf(monster, kind) : null;
  const quest = target.questId != null ? questById(targetData, target.questId) : null;
  if (target.questId != null && !quest) {
    warnings.push({ code: 'quest-missing', message: '選んだクエストがデータに無いので、モンスターだけで探します' });
  }
  if (quest) {
    let subs = questSubjects(quest, targetData, { players });
    if (!subs.some((s) => s.monsterId === monster.id)) {
      warnings.push({ code: 'quest-mismatch', message: 'クエストにこのモンスターがいないので、モンスターだけで探します' });
      subs = [];
    }
    if (subs.length && useTarget === false) {
      const one = subs.find((s) => s.index === target.questTargetIndex && s.monsterId === monster.id)
        || subs.find((s) => s.monsterId === monster.id && (s.kind ?? null) === kind)
        || subs.find((s) => s.monsterId === monster.id);
      subs = [one];
    }
    if (subs.length) return { quest, subjects: subs, warnings, monster };
  }
  return {
    quest: null, monster, warnings,
    subjects: [{
      index: null, key: `${monster.id}:${kind ?? 'normal'}`, monsterId: monster.id, name: (ind && ind.name) || monster.name,
      kind, missionTarget: null, health: targetHealth(null, { players }), paramGroup: null,
    }],
  };
}

/**
 * 相手 → Plan (docs/RECOMMEND_DESIGN.md 5.3 節)。画面のスレッドで呼ぶ (探索はしない。いまの装備の期待値を相手ごとに数回計算する)。
 * 相手タブの「この相手のおすすめ」と探すタブの両方がこの結果を出す。
 * @param args {target: state.target, tabTarget: state.tabs.target, search: state.search, targetData (data.js の target データ),
 *   core: {index, skillEffects, motions, combos} (data.js の core データ), current: {build, combo, uptimes, sharpness, extraWeapons}}
 * @returns Plan = {status: 'ok'|'no-target'|'no-data', blocked: null|{code, message}, mode: 'single'|'multi', useTarget,
 *   subjects: [{key, index, monsterId, kind, name, health, healthForT, targets, element: {rec, view}, threats, monsterStatus,
 *               current: {value, combos}|null}],
 *   element (elementPlan), requirements (requirementsFrom), notes, exclusions (gammaExclusions + gamma), weights (multiWeights),
 *   quest: {id, name, stars, multi, fixedEquipment, intruders} | null, players, preset, partsPolicy,
 *   inputs: {combo, uptimes, uptimeMode, placeholders, monsterStatus, sharpness, limitBreak, charms, armorExclude, sourceUptimes},
 *   current: {value, T, perSubject, check} | null, marks: {preset: 'provisional', parts}, warnings: [{code, message}], license}
 */
export function buildPlan({ target, tabTarget, search, targetData, core, current } = {}) {
  const sr = isObj(search) ? search : {};
  const cur = isObj(current) ? current : {};
  const index = core && core.index;
  const effects = core && core.skillEffects;
  const threats = threatsDoc(targetData);
  const warnings = [];
  const useTarget = sr.useTarget !== false;
  const preset = PRESETS[sr.preset] ? sr.preset : DEFAULT_PRESET;
  const partsPolicy = ['asSelected', 'weak1', 'main3'].includes(sr.partsPolicy) ? sr.partsPolicy : 'asSelected';
  const players = clampPlayers(target && target.players != null ? target.players : 1);
  const up = searchUptimes(effects, cur.uptimes, sr.placeholders === 'keep' ? 'keep' : 'zero');
  const combo = resolveComboRef(cur.combo, core && core.combos);
  const build = isObj(cur.build) ? cur.build : null;
  const limitBreak = sr.limitBreak === 'all' ? Object.fromEntries(ARMOR_PARTS.map((p) => [p, true]))
    : sr.limitBreak === 'none' ? Object.fromEntries(ARMOR_PARTS.map((p) => [p, false]))
      : (build && isObj(build.limitBreak) ? { ...build.limitBreak } : Object.fromEntries(ARMOR_PARTS.map((p) => [p, false])));
  const charms = { owned: true, local: true, fixed: true, ...(isObj(sr.charms) ? sr.charms : {}) };
  const exclusions = { ...gammaExclusions(targetData, sr.archTemperedHunted), gamma: gammaIndex(targetData) };
  for (const n of exclusions.notes) warnings.push(n);
  if (up.placeholders.length && up.mode === 'zero') {
    warnings.push({
      code: 'placeholder-uptimes',
      message: `発動率が仮置き (50%) の条件 ${up.placeholders.length} 個を 0% にして探します (火力タブの値と違うのはこのため)`,
    });
  }
  const inputs = {
    combo, uptimes: up.uptimes, uptimeMode: up.mode, placeholders: up.placeholders, sourceUptimes: isObj(cur.uptimes) ? cur.uptimes : {},
    sharpness: cur.sharpness || null, limitBreak, charms, armorExclude: Array.isArray(sr.armorExclude) ? [...sr.armorExclude] : [],
    monsterStatus: [], currentBuild: build && build.weapon != null ? build : null,
  };
  const plan = {
    status: 'ok', blocked: null, mode: 'single', useTarget, subjects: [], element: null, requirements: [], notes: [],
    exclusions, weights: [], quest: null, players, preset, partsPolicy, inputs, current: null,
    marks: { preset: 'provisional', parts: partsPolicy === 'main3' ? 'provisional' : null }, warnings,
    license: licensesOf(targetData),
  };
  const t = isObj(target) ? target : {};

  // ---- 戦う相手
  if (t.mode === 'manual') {
    const m = isObj(t.manual) ? t.manual : {};
    plan.subjects = [{
      key: 'manual', index: null, monsterId: null, kind: null, name: m.name || '手入力', health: targetHealth(null),
      targets: [{ weight: 1, label: m.name || '手入力', partKey: null, target: { hitzone: m.hitzone || {}, wound: m.wound || null, isWound: !!t.isWound } }],
      element: { rec: null, view: elementView(null, null) }, threats: [], monsterStatus: [], current: null,
    }];
  } else {
    if (t.monsterId != null && (!targetData || !monstersOf(targetData).length)) {
      plan.status = 'no-data';
      warnings.push({ code: 'no-target-data', message: 'モンスターのデータを読み込んでいます' });
    }
    const got = subjectsFor(t, targetData, players, useTarget);
    for (const w of got.warnings) warnings.push(w);
    if (!got.subjects.length) {
      if (plan.status === 'ok') plan.status = 'no-target';
      warnings.push({ code: 'no-target', message: '相手を選ぶとおすすめも使えます' });
      if (t.monsterId == null) {
        // 相手を選んでいない (段階 2 で相手なしに探す): 装備タブ・火力タブと同じ既定の肉質で探す (相手のデータの読み込み中は待つ)
        const label = `既定の肉質 (${DEFAULT_HITZONE_TEXT})`;
        warnings.push({ code: 'default-target', message: `相手を選んでいないので、${label}で探します` });
        plan.subjects = [{
          key: 'default', index: null, monsterId: null, kind: null, name: '既定の肉質', health: targetHealth(null), isDefault: true,
          targets: [{ weight: 1, label, partKey: null, target: { hitzone: DEFAULT_HITZONE, wound: null, isWound: !!t.isWound } }],
          element: { rec: null, view: elementView(null, null) }, threats: [], monsterStatus: [], current: null,
        }];
      }
    }
    const q = got.quest;
    if (q) {
      plan.quest = {
        id: q.id, name: q.name, stars: q.stars ?? null, multi: !!q.multi, fixedEquipment: q.fixedEquipment ?? null,
        intruders: (q.intruders || []).map((x) => x.name).filter(Boolean),
      };
      if (q.fixedEquipment === true) {
        plan.blocked = { code: 'fixed-equipment', message: '装備が決められたクエストです (装備は探しません)' };
      }
    }
    const memo = { ...(isObj(tabTarget) && isObj(tabTarget.memo) ? tabTarget.memo : {}) };
    if (got.monster) memo[got.monster.id] = { partKey: t.partKey ?? null, mix: isObj(tabTarget) ? tabTarget.mix : null };
    const allStatus = new Set();
    if (got.subjects.length) plan.subjects = got.subjects.map((s) => {
      const monster = monsterById(targetData, s.monsterId);
      const ind = individualOf(monster, s.kind);
      const ms = monsterStatusFor(monster, threats);
      for (const k of ms) allStatus.add(k);
      return {
        key: s.key, index: s.index, monsterId: s.monsterId, kind: s.kind ?? null, name: s.name, health: s.health,
        paramGroup: s.paramGroup ?? null, threatVariant: ind ? ind.threatVariant ?? null : null,
        targets: partsTargets(monster, s.kind, partsPolicy, memo, t.isWound, { useUncertain: t.useUncertainWound === true }),
        element: { rec: elementRecommendationOf(monster, s.kind, { useUncertain: t.useUncertainWound === true }), view: null },
        monsterStatus: ms, current: null,
      };
    });
    inputs.monsterStatus = [...allStatus];
    if (plan.subjects.length && plan.subjects.some((s) => !s.targets.length)) {
      warnings.push({ code: 'no-part', message: '狙う部位が決まらない相手がいます' });
    }
  }
  plan.mode = plan.subjects.length > 1 ? 'multi' : 'single';
  if (!plan.subjects.length) return plan;

  // ---- 守りのスキル (相手に合わせたおすすめを使うときだけ)
  const items = useTarget ? collectThreats(threats || {}, plan.subjects) : [];
  for (const s of plan.subjects) s.threats = items.filter((i) => i.subjectKey === s.key);
  const rules = (threats && threats.rules) || {};
  plan.requirements = requirementsFrom(items, {
    preset, toggles: sr.toggles, levels: sr.levels, effects,
    threshold: rules.elementalBlight ? rules.elementalBlight.resistanceThreshold : 20,
  });
  plan.notes = notesFrom(items);
  if (plan.requirements.some((r) => r.kind === 'blight' && !r.byResist)) {
    warnings.push({ code: 'no-resist-skills', message: '耐性スキルのデータが無いので、属性やられ耐性だけで探します' });
  }
  if (useTarget && threats && plan.subjects.some((s) => s.monsterId != null && !threatRowOf(threats, s.monsterId))) {
    warnings.push({ code: 'no-threat-data', message: '咆哮・風圧などのデータが無い相手がいます' });
  }

  // ---- いまの装備の期待値 (多頭の重みの基準・「いま」の表示)
  const evalErrors = [];
  const evalCtx = {
    index, effects, motions: core && core.motions, combo, uptimes: up.uptimes,
    monsterStatus: plan.mode === 'multi' ? inputs.monsterStatus : (plan.subjects[0].monsterStatus || []),
    sharpness: inputs.sharpness, errors: evalErrors,
  };
  const hs = subjectHealths(plan.subjects);
  plan.subjects.forEach((s, i) => {
    s.healthForT = hs[i].health;
    s.healthAssumed = hs[i].assumed;
    s.healthBasis = hs[i].basis;
  });
  const dRef = {};
  let refNote = null;
  if (build && build.weapon != null && index) {
    for (const s of plan.subjects) {
      const r = evaluateBuild(build, s.targets, evalCtx);
      if (r) {
        dRef[s.key] = r.value;
        s.current = { value: r.value, combos: s.healthAssumed ? null : Math.ceil(s.healthForT.mid / r.value) };
      }
    }
  }

  // ---- 武器 (多頭は時間の割合で 2 本の案の属性を選ぶ)
  const elemSubjects = plan.subjects.map((s) => ({ key: s.key, rec: s.element.rec }));
  const elemOpts = { mode: useTarget ? sr.weaponMode : (sr.weaponMode === 'auto' ? 'current' : sr.weaponMode), twoWeapons: sr.twoWeapons };
  let ep = elementPlan(elemSubjects, cur, index, elemOpts);
  if (plan.mode === 'multi' && !Object.keys(dRef).length && index) {
    // 武器が無い: 候補の先頭の武器のスキルなしの期待値を基準にする (3.1 節)
    const first = Array.isArray(ep.weapons) ? ep.weapons[0] : (index.weapons ? [...index.weapons.keys()][0] : null);
    if (first != null) {
      for (const s of plan.subjects) {
        const r = evaluateBuild({ weapon: first }, s.targets, { ...evalCtx, noSkills: true });
        if (r) dRef[s.key] = r.value;
      }
      refNote = '武器を選んでいないので、候補の先頭の武器 (スキルなし) を基準に重みを決めました';
    }
  }
  if (plan.mode === 'multi') {
    plan.weights = multiWeights(plan.subjects, dRef);
    const time = Object.fromEntries(plan.weights.map((w) => [w.key, w.time]));
    ep = elementPlan(elemSubjects, cur, index, { ...elemOpts, time });
    if (refNote) warnings.push({ code: 'reference-weapon', message: refNote });
  } else {
    plan.weights = [{ key: plan.subjects[0].key, name: plan.subjects[0].name, weight: 1, reason: '' }];
  }
  if (evalErrors.length) {
    warnings.push({
      code: 'current-eval-failed',
      message: `いまの装備の期待値を計算できない相手がいます (${evalErrors[0]})。多頭の重みはほかの相手の値で置きました`,
    });
  }
  plan.element = ep;
  for (const w of ep.warnings) warnings.push(w);
  plan.subjects.forEach((s, i) => { s.element.view = ep.perSubject[i] ? ep.perSubject[i].view : elementView(s.element.rec, null); });
  const assumed = plan.subjects.filter((s) => s.healthAssumed);
  if (assumed.length && assumed.length < plan.subjects.length) {
    warnings.push({
      code: 'health-assumed',
      message: `体力が分からない相手 (${assumed.map((s) => s.name).join('・')}) は、分かっている相手の平均で置きました (仮)`,
    });
  } else if (assumed.length && plan.mode === 'multi') {
    warnings.push({ code: 'health-unknown', message: '体力が分からないので、全部の相手を同じに見ています (仮)' });
  }

  // ---- いまの装備 (「いま」の表示と、結果の「いまより +x%」)
  if (build && index) {
    const perSubject = plan.subjects.map((s) => ({ key: s.key, value: s.current ? s.current.value : null, combos: s.current ? s.current.combos : null }));
    const vals = plan.subjects.map((s) => (s.current ? s.current.value : null));
    let value = null;
    let T = null;
    if (vals.every((v) => v != null && v > 0)) {
      if (plan.mode === 'single') value = vals[0];
      else T = plan.subjects.reduce((a, s, i) => a + s.healthForT.mid / vals[i], 0);
    }
    plan.current = { value, T, perSubject, check: defenseCheck(build, plan.requirements, index, effects) };
  }
  return plan;
}

// ---------------------------------------------------------------- Plan → Job

/**
 * Plan → Job (探索の入力の並び。docs/RECOMMEND_DESIGN.md 5.3 節)。属性やられがオンなら、探索を 2 回に分ける
 * (属性やられ耐性 Lv3 を必須にした回と、各属性の耐性スキルを必須にした回。多頭で属性が複数でも 2 回)。
 * @param opts {K, budgetMs, budget (各回の予算をそのまま渡すとき。{work} など), placeholders ('zero'|'keep'。Plan と違えば作り直す),
 *   userRequired: state.search.required, extraCharms (この端末で足した護石), extraWeapons, current (いまの装備。baseline 用),
 *   searchK (探索で集める件数。既定 K), costRun (守りの火力の差を測る回を足すか。既定 true), tryKey (「試す」の行の key)}
 * @returns Job = {kind: 'plan', runs: [{key, label, input}], costRun: {key, label, input} | null,
 *   runsBudget: {activeMs} | null (探索の回の合計の持ち時間。createPlanRunner が回を始めるときに配る。opts.budget を渡したら null),
 *   merge: {mode: 'single'|'multi'|'twoWeapons', subjects, weights, alternatives, groups}, K, subjects, requirements, gamma,
 *   baseline, players, blocked, warnings, tryKey}
 */
export function planToJob(plan, opts = {}) {
  const K = Math.max(1, Math.min(50, Math.round(Number(opts.K) || 10)));
  const searchK = Math.max(K, Math.round(Number(opts.searchK) || K));
  const job = {
    kind: 'plan', runs: [], costRun: null, runsBudget: null, K, merge: null, subjects: [], requirements: [], gamma: null, baseline: null,
    players: plan ? plan.players : 1, blocked: null, warnings: [], tryKey: opts.tryKey ?? null,
  };
  if (!plan || !plan.subjects || !plan.subjects.length) {
    job.blocked = { code: 'no-target', message: '相手を選ぶとおすすめも使えます' };
    return job;
  }
  if (plan.blocked) {
    job.blocked = plan.blocked;
    return job;
  }
  const multi = plan.subjects.length > 1;
  // 発動率 (Plan と違うモードを選んだら作り直す)
  let uptimes = plan.inputs.uptimes;
  if (opts.placeholders && opts.placeholders !== plan.inputs.uptimeMode) {
    uptimes = { ...plan.inputs.sourceUptimes };
    if (opts.placeholders === 'zero') {
      for (const p of plan.inputs.placeholders) uptimes[p.id] = p.type === 'categorical' ? {} : 0;
    }
  }
  // 相手 × 部位の行 (多頭は相手の重み × 部位の割合。group = 相手の key)
  const wOf = Object.fromEntries((plan.weights || []).map((w) => [w.key, w.weight]));
  const targets = [];
  for (const s of plan.subjects) {
    const sw = multi ? (wOf[s.key] ?? 1 / plan.subjects.length) : 1;
    const sum = s.targets.reduce((a, x) => a + (Number(x.weight) || 0), 0) || 1;
    for (const x of s.targets) {
      targets.push({ weight: (sw * (Number(x.weight) || 0)) / sum, group: s.key, label: `${s.name} ${x.label}`, target: x.target });
    }
  }
  // 必須スキル (自分で足したもの + オンの守りのスキル。同じスキルは Lv の大きい方)
  const userReq = (Array.isArray(opts.userRequired) ? opts.userRequired : [])
    .filter((r) => r && Number.isInteger(Number(r.skillId)) && Number(r.level) > 0)
    .map((r) => ({ skillId: Number(r.skillId), level: Number(r.level) }));
  const merged = (list) => {
    const m = new Map();
    for (const r of list) m.set(r.skillId, Math.max(m.get(r.skillId) || 0, r.level));
    return [...m.entries()].map(([skillId, level]) => ({ skillId, level }));
  };
  const onRows = (plan.requirements || []).filter((r) => r.on || (opts.tryKey != null && r.key === opts.tryKey));
  const skillReq = onRows.filter((r) => r.kind === 'skill').map((r) => ({ skillId: r.skillId, level: r.level }));
  const blightRows = onRows.filter((r) => r.kind === 'blight' && (r.bySkill || r.byResist));
  const ex = plan.exclusions || {};
  const charms = plan.inputs.charms || {};
  const extraCharms = Array.isArray(opts.extraCharms) ? opts.extraCharms : [];
  const base = {
    weapons: plan.element.weapons, targets, combo: plan.inputs.combo, uptimes, monsterStatus: plan.inputs.monsterStatus,
    buffs: {}, sharpness: plan.inputs.sharpness, required: [],
    charms: { owned: charms.owned !== false, extra: charms.local !== false ? extraCharms : [], fixed: charms.fixed !== false, fixedExclude: [...(ex.charmsFixed || [])] },
    extraWeapons: Array.isArray(opts.extraWeapons) ? opts.extraWeapons : [],
    limitBreak: plan.inputs.limitBreak, decorations: { owned: null },
    armorExclude: uniq([...(plan.inputs.armorExclude || []), ...(ex.armor || [])]),
    objective: 'damage', K: searchK, mode: 'fast',
    // いまの装備 (「いまより +x%」を探索と同じ式で出す。docs/RECOMMEND_DESIGN.md 5.4 節)
    current: opts.current !== undefined ? opts.current || null : plan.inputs.currentBuild || null,
    // γ の印の表 (探索が同じ値の γ でない防具・護石を代表にする。docs/SEARCH_DESIGN.md 3.7 節)
    gamma: ex.gamma || null,
  };
  const runCount = blightRows.length && blightRows.every((r) => r.bySkill) && blightRows.every((r) => r.byResist) ? 2 : 1;
  const willCost = opts.costRun !== false && opts.tryKey == null && (skillReq.length > 0 || blightRows.length > 0);
  const two = !!(plan.element.twoWeapons && plan.element.twoWeapons.suggested && opts.tryKey == null);
  const budgetMs = Math.max(500, Number(opts.budgetMs) || 6000);
  // 予算は既定で計算した時間の合計で数える (activeMs。iPhone で裏に回っていた時間を数えない。5.4 節)。
  // 火力の差を測る回・武器 2 本の合わせがあるときは、探索の回に予算の RUN_SHARE だけを使う (残りはそれらの分。
  // 合わせと火力の差は予算で切れないので、全部で予算の近くに収める。iPhone で 10 秒以内にするため。docs/SEARCH_DESIGN.md 5 章)。
  // 探索の回の合計の持ち時間 (job.runsBudget) は、createPlanRunner が回を始めるときに「残り ÷ 残りの回の数」で配る (先に最後まで
  // 終わった回が使わなかった分が後の回に回る)。入力の budget はその最初の値 (持ち時間 ÷ 回の数)。opts.budget はそのまま各回に渡す
  // (持ち時間は出さない)
  const share = willCost || two ? RUN_SHARE : 1;
  const runsMs = Math.round(budgetMs * share);
  const budgetOf = () => (isObj(opts.budget) ? { ...opts.budget } : { activeMs: Math.floor(runsMs / runCount) });
  const stopAfter = opts.tryKey != null ? { stopAfter: 'partial' } : {};
  const req = merged([...userReq, ...skillReq]);
  if (blightRows.length) {
    // 属性やられ: 「または」を 2 回の探索に分ける (属性が複数でも 2 回。耐性スキルの回は全部の属性を一度に)
    const elements = uniq(blightRows.flatMap((r) => r.elements));
    const names = elements.map((e) => ELEMENT_LABEL[e] || e).join('・');
    if (blightRows.every((r) => r.bySkill)) {
      job.runs.push({
        key: 'blight-skill', label: '属性やられ耐性で防ぐ組を探しています',
        input: { ...base, required: merged([...req, ...blightRows.flatMap((r) => r.bySkill)]), budget: budgetOf(), ...stopAfter },
      });
    }
    if (blightRows.every((r) => r.byResist)) {
      // 防具の耐性の合計の下限も探索の条件にする (守りのチェックで後から落とす組で上位が埋まらないように。属性ごとに一番きつい行)
      const armorResistMin = {};
      for (const r of blightRows) {
        for (const [e, v] of Object.entries(r.byResistArmorMin || {})) armorResistMin[e] = Math.max(armorResistMin[e] ?? -Infinity, v);
      }
      job.runs.push({
        key: 'blight-resist', label: `${names}の耐性スキルで防ぐ組を探しています`,
        input: {
          ...base, required: merged([...req, ...blightRows.flatMap((r) => r.byResist)]),
          ...(Object.keys(armorResistMin).length ? { armorResistMin } : {}), budget: budgetOf(), ...stopAfter,
        },
      });
    }
  }
  if (!job.runs.length) {
    // 属性やられの行はあるが、どちらの防ぎ方も全部の行にはそろわない (データの欠け): 属性やられは必須にせず、守りのチェックで見せる
    if (blightRows.length) job.warnings.push({ code: 'blight-not-required', message: '属性やられの防ぎ方のデータが足りないので、必須にせずに探します' });
    job.runs.push({ key: 'main', label: '装備を探しています', input: { ...base, required: req, budget: budgetOf(), ...stopAfter } });
  }
  if (!isObj(opts.budget)) job.runsBudget = { activeMs: runsMs };
  if (willCost) {
    job.costRun = {
      key: 'cost', label: '守りのスキルの火力の差を測っています',
      input: { ...base, required: merged(userReq), budget: budgetOf(), stopAfter: 'partial', K: Math.min(searchK, 3) },
    };
  }
  job.merge = {
    mode: two ? 'twoWeapons' : (multi ? 'multi' : 'single'),
    subjects: plan.subjects.map((s) => s.key), weights: (plan.weights || []).map((w) => ({ key: w.key, weight: w.weight })),
    alternatives: job.runs.length > 1 ? job.runs.map((r) => r.key) : null,
    groups: two ? plan.element.twoWeapons.groups.map((g) => ({ element: g.element, subjectKeys: g.subjectKeys, weapons: g.weapons })) : null,
  };
  job.subjects = plan.subjects.map((s) => ({
    key: s.key, name: s.name, health: s.healthForT, healthAssumed: !!s.healthAssumed, healthBasis: s.healthBasis || null,
  }));
  job.requirements = onRows.map((r) => ({
    key: r.key, kind: r.kind, label: r.label, skillId: r.skillId ?? null, skillName: r.skillName || '', level: r.level,
    negateLevel: r.negateLevel, mitigateLevel: r.mitigateLevel, elements: r.elements || null, threshold: r.threshold ?? null,
    blightSkillId: r.blightSkillId ?? null, on: true,
  }));
  // 自分で足した必須スキルも守りのチェックに出す (満たしているか)
  for (const r of userReq) {
    if (job.requirements.some((x) => x.kind === 'skill' && x.skillId === r.skillId)) continue;
    job.requirements.push({
      key: `user:${r.skillId}`, kind: 'skill', label: '', skillId: r.skillId, skillName: '', level: r.level,
      negateLevel: r.level, mitigateLevel: null, elements: null, threshold: null, blightSkillId: null, on: true, user: true,
    });
  }
  job.gamma = ex.gamma || null;
  if (plan.current) {
    job.baseline = {
      value: plan.current.value, T: plan.current.T,
      perSubject: Object.fromEntries(plan.current.perSubject.filter((p) => p.value != null).map((p) => [p.key, p.value])),
    };
  }
  job.warnings = [
    ...(plan.warnings || []).filter((w) => ['health-assumed', 'health-unknown', 'placeholder-uptimes', 'gamma-excluded', 'reference-weapon'].includes(w.code)),
    ...job.warnings,
  ];
  return job;
}

/**
 * Job の入力の短いハッシュ (結果を保存するときの inputKey。予算は入れない。データの版は呼ぶ側が dataVersion で渡す)。
 */
export function jobKey(job, { dataVersion = null } = {}) {
  if (!job) return null;
  const strip = (input) => {
    const o = { ...input };
    delete o.budget;
    return o;
  };
  return stableHash({
    runs: (job.runs || []).map((r) => ({ key: r.key, input: strip(r.input) })), merge: job.merge, K: job.K,
    requirements: job.requirements, subjects: job.subjects, dataVersion,
  });
}

// ---------------------------------------------------------------- いまの装備との比べ

/**
 * いまの装備との比べの基準 (結果の baseline の形)。base = {value (1 コンボの期待値), perGroup ({相手の key: 期待値})}。
 * 相手が 1 体なら value をそのまま (kind 'damage')、多頭は T = Σ 体力_i / 期待値_i (kind 'combos'。全部倒すまでの回数)。
 * 体力が全員分からない多頭は、結果の score (rerankMulti) と同じく期待値の調和平均 (= 相手の数 / T。kind 'damage') にする
 * (value は score.value と同じ単位で比べられる)。
 * @param subjects job.subjects ([{key, health: {mid}, healthAssumed}])
 * @returns {{kind: 'damage'|'combos', value, T (回数の目安。体力が分からなければ null), combos (相手ごとに切り上げた回数の合計。
 *            体力が分からない相手がいれば null), perGroup}} | null  (計算できない相手がいれば null)
 */
export function baselineView(subjects, base) {
  const subs = Array.isArray(subjects) ? subjects : [];
  if (!isObj(base)) return null;
  const pg = isObj(base.perGroup) ? base.perGroup : null;
  if (subs.length <= 1) {
    const s = subs[0] || null;
    const v = finite(base.value) > 0 ? base.value : (s && pg ? finite(pg[s.key]) : null);
    if (!(v > 0)) return null;
    const H = s && s.health && !s.healthAssumed ? finite(s.health.mid) : null;
    return {
      kind: 'damage', value: v, T: H != null ? H / v : null, combos: H != null ? Math.ceil(H / v) : null,
      perGroup: s ? { [s.key]: v } : null,
    };
  }
  if (!pg || !subs.every((s) => finite(pg[s.key]) > 0)) return null;
  const T = subs.reduce((a, s) => a + s.health.mid / pg[s.key], 0);
  const combos = subs.every((s) => !s.healthAssumed) ? subs.reduce((a, s) => a + Math.ceil(s.health.mid / pg[s.key]), 0) : null;
  if (subs.every((s) => s.healthAssumed)) {
    return { kind: 'damage', value: subs.length / T, T: null, combos: null, perGroup: { ...pg } };
  }
  return { kind: 'combos', value: T, T, combos, perGroup: { ...pg } };
}

/**
 * 結果の score と基準 (baselineView) の差 (%)。期待値 (kind 'damage') は「結果 / 基準 − 1」(+ なら火力が高い)、
 * 回数 (kind 'combos') は「基準の回数 / 結果の回数 − 1」(+ なら回数が少ない = 速く倒せる)。単位が違えば null。
 */
export function vsBaselinePct(score, baseline) {
  if (!isObj(score) || !isObj(baseline) || !(finite(score.value) > 0) || !(finite(baseline.value) > 0)) return null;
  if ((score.kind || 'damage') !== (baseline.kind || 'damage')) return null;
  return score.kind === 'combos' ? (baseline.value / score.value - 1) * 100 : (score.value / baseline.value - 1) * 100;
}

/**
 * 装備 (build) の基準を Job の入力 (1 回目の入力の相手・発動率・コンボ。createPlanRunner の「いまの装備」と同じ式 = evaluateBuild)
 * で計算する。画面のスレッドで、結果の組を装備に入れたあとの「いまより」を、入れたあとの装備で出し直すのに使う。
 * @param data {index, effects | skillEffects, motions} (index は画面の索引でよい。入力の端末の武器・護石も足す)
 * @returns baselineView の結果 | null (武器が無い・計算できない)
 */
export function planBaseline(job, build, data) {
  const input = job && Array.isArray(job.runs) && job.runs[0] ? job.runs[0].input : null;
  if (!input || !build || build.weapon == null || !data) return null;
  const index = indexWithExtras(data.index, input);
  const ev = evaluateBuild(build, input.targets, {
    index, effects: data.effects || data.skillEffects, motions: data.motions, combo: input.combo, uptimes: input.uptimes,
    monsterStatus: input.monsterStatus, sharpness: input.sharpness, buffs: input.buffs,
  });
  return ev ? baselineView(job.subjects, { value: ev.value, perGroup: ev.perGroup }) : null;
}

// ---------------------------------------------------------------- 並べ直し (多頭は T)

/**
 * 結果を本当の T (= Σ 体力_i / 期待値_i。全部倒すまでのコンボの回数) で並べ直す (docs/RECOMMEND_DESIGN.md 3.1 節)。
 * 相手が 1 体なら期待値の高い順のまま (score.kind 'damage')。
 * @param results [{value, perGroup: {subjectKey: 期待値}, perGroup2? (武器 2 本の 2 本目)}]
 * @param subjects job.subjects ([{key, name, health: {mid}, healthAssumed}])
 * @param opts {twoWeapons: 相手ごとに良い方の武器 (perGroup / perGroup2 の大きい方) で数える}
 * @returns 新しい配列 (rank を振り直す)。各結果に score: {kind: 'damage'|'combos', value, better: 'higher'|'lower'},
 *   perSubject: [{key, name, value, combos, weapon: 1|2}], combosTotal を足す
 */
export function rerankMulti(results, subjects, { twoWeapons = false } = {}) {
  const subs = Array.isArray(subjects) ? subjects : [];
  const allAssumed = subs.length > 0 && subs.every((s) => s.healthAssumed);
  const out = (Array.isArray(results) ? results : []).map((r, i) => {
    const pg = isObj(r.perGroup) ? r.perGroup : {};
    const pg2 = twoWeapons && isObj(r.perGroup2) ? r.perGroup2 : null;
    const perSubject = subs.map((s) => {
      const d1 = finite(pg[s.key]) ?? (subs.length === 1 ? finite(r.value) : null);
      const d2 = pg2 ? finite(pg2[s.key]) : null;
      const use2 = d2 != null && (d1 == null || d2 > d1);
      const value = use2 ? d2 : d1;
      const H = s.health && finite(s.health.mid);
      return {
        key: s.key, name: s.name || '', value, weapon: use2 ? 2 : 1,
        combos: value > 0 && H != null && !s.healthAssumed ? Math.ceil(H / value) : null, exact: value > 0 && H != null ? H / value : null,
      };
    });
    let score;
    if (subs.length <= 1) {
      score = { kind: 'damage', value: finite(perSubject[0] ? perSubject[0].value : null) ?? finite(r.value), better: 'higher' };
    } else if (perSubject.some((p) => p.exact == null)) {
      score = { kind: 'combos', value: null, better: 'lower' };
    } else if (allAssumed) {
      // 体力が全部分からない: 期待値の調和平均 (T と同じ並びになる) を「期待値」として出す
      const T = perSubject.reduce((a, p) => a + p.exact, 0);
      score = { kind: 'damage', value: subs.length / T, better: 'higher' };
    } else {
      score = { kind: 'combos', value: perSubject.reduce((a, p) => a + p.exact, 0), better: 'lower' };
    }
    const combosTotal = perSubject.every((p) => p.combos != null) ? perSubject.reduce((a, p) => a + p.combos, 0) : null;
    return { ...r, score, perSubject: perSubject.map(({ exact, ...p }) => p), combosTotal, _order: i };
  });
  const key = (r) => (r.score.value == null ? Infinity : (r.score.better === 'lower' ? r.score.value : -r.score.value));
  out.sort((a, b) => key(a) - key(b) || a._order - b._order);
  return out.map(({ _order, ...r }, i) => ({ ...r, rank: i + 1 }));
}

// ---------------------------------------------------------------- 探索を順に回す (Worker の中で使う)

/**
 * 探索の警告 weapons-sieved (武器を見込みの高い何本かに絞った) を 1 行にまとめる。属性やられの 2 回や「続けて探す」の回で
 * 絞った本数が違うと、同じ種類の警告が並ぶため。kept は大きい方、keptMin〜keptMax に範囲を残す。
 * 文の形は search.js の weapons-sieved と同じ (total = 探した武器の数、before = 同じ性能かそれ以下の武器を除く前の数)。
 */
function mergeSieved(a, b) {
  const lo = Math.min(Number(a.keptMin ?? a.kept), Number(b.keptMin ?? b.kept));
  const hi = Math.max(Number(a.keptMax ?? a.kept), Number(b.keptMax ?? b.kept));
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return a; // 形の違う警告は前のまま
  if (lo === hi && a.message === b.message) return a;
  const total = Math.max(Number(a.total) || 0, Number(b.total) || 0) || null;
  const before = Math.max(Number(a.before) || 0, Number(b.before) || 0) || null;
  const totalText = total == null ? '' : before != null && before > total
    ? `${before} 本 (同じ性能かそれ以下の武器を除くと ${total} 本) のうち、` : `${total} 本のうち、`;
  return {
    ...b, kept: hi, keptMin: lo, keptMax: hi,
    message: `武器は ${totalText}見込みの高い ${lo === hi ? lo : `${lo}〜${hi}`} 本に絞ってくわしく探しました`
      + `${lo === hi ? '' : ' (回ごとに違います)'} (「続けて探す」でほかの武器もくわしく探します)`,
  };
}

/** 結果の装備に入っている γ 防具・狩猟証γ の護石 → 「歴戦王〇〇の素材が要ります」 */
function gammaMarksOf(build, gamma) {
  if (!build || !gamma) return [];
  const out = [];
  for (const p of ARMOR_PARTS) {
    const id = build.armor ? build.armor[p] : null;
    const g = id != null && gamma.armor ? gamma.armor[id] ?? gamma.armor[String(id)] : null;
    if (g) out.push({ part: p, armorId: id, monsterId: g.monsterId, name: g.name });
  }
  const c = build.charm;
  const gc = typeof c === 'number' && gamma.charmsFixed ? gamma.charmsFixed[c] ?? gamma.charmsFixed[String(c)] : null;
  if (gc) out.push({ part: 'charm', charmId: c, monsterId: gc.monsterId, name: gc.name });
  return out;
}

/** 索引に、入力の端末の所持アーティア (extraWeapons) と護石 (charms.extra) を足したもの (search.js の normalizeInput と同じ足し方) */
function indexWithExtras(index, input) {
  if (!index || !isObj(input)) return index || null;
  const listOf = (x, key) => (Array.isArray(x) ? x : isObj(x) && Array.isArray(x[key]) ? x[key] : []);
  const weapons = listOf(input.extraWeapons, 'weapons').filter((w) => isObj(w) && w.id != null);
  const charms = listOf(isObj(input.charms) ? input.charms.extra : null, 'charms').filter((c) => isObj(c) && c.id != null);
  if (!weapons.length && !charms.length) return index;
  return {
    ...index,
    myWeapons: new Map([...(index.myWeapons || new Map()), ...weapons.map((w) => [w.id, w])]),
    charms: new Map([...(index.charms || new Map()), ...charms.map((c) => [c.id, c])]),
  };
}

/**
 * 回の持ち時間 (探索の回の合計の予算。docs/SEARCH_DESIGN.md 5.3 節「回の予算の配り方」)。kind 'activeMs' (計算した時間) は、
 * 回を始めるときに「残り ÷ 残りの回の数」を渡し、回が終わったら使った分 (渡した予算が上限) を引く。最後まで終わった回が
 * 使わなかった分は後の回に回る。各回の予算は渡すときの残りをこえず、引いた分の合計 (= 回が予算と比べて使った時間の合計) は
 * 持ち時間をこえない (min が 0 のとき。渡した予算の合計は、前の回の残りが後の回にも入るので持ち時間をこえることがある)。
 * 後の回ほど予算は同じか多い。
 * kind 'ms' (始めてからの時間。テストとベンチだけ) は回の数で分けたまま (回の使った時間を数えないので回さない)。
 */
function poolOf(kind, total, count, min = 0) {
  return { kind, total, count: Math.max(1, count), min, spent: 0, started: 0 };
}

/** 持ち時間から、次に始める回の予算 ({activeMs} か {ms}) */
function sliceOf(pool) {
  const rest = pool.kind === 'activeMs' ? (pool.total - pool.spent) / Math.max(1, pool.count - pool.started) : pool.total / pool.count;
  pool.started += 1;
  return { [pool.kind]: Math.max(pool.min, Math.floor(rest)) };
}

/**
 * Job を Worker の中で回す (docs/RECOMMEND_DESIGN.md 5.3 節)。createSearch と同じ形:
 *   runner.step(ms) → 終わったら true / runner.progress() / runner.result() / runner.cancel() / runner.extend({ms})
 * 探索 (createSearch) を runs の順に回し、結果を合わせて (属性やられの 2 回分・多頭の T の並べ直し・武器 2 本の合わせ)、
 * 最後に守りのスキルの火力の差を測る回 (costRun) を回す。job.runsBudget があれば、探索の回の予算は回を始めるときに
 * その持ち時間から「残り ÷ 残りの回の数」で渡す (poolOf。無ければ入力の budget のまま)。
 * @param job planToJob の結果
 * @param data createSearch に渡すのと同じ ({index, effects, motions, ...})。守りのチェックと、perGroup が無い結果の計算し直しに使う
 * @param deps {createSearch, optimizeWeaponSide, now} (探索の本体は引数で受ける。テストでは作り物を渡せる)
 */
export function createPlanRunner(job, data, deps = {}) {
  const createSearch = deps.createSearch;
  const optimizeWeaponSide = deps.optimizeWeaponSide;
  const now = typeof deps.now === 'function' ? deps.now
    : () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const effects = data && (data.effects || data.skillEffects);
  // 端末の所持アーティア・護石 (入力の extraWeapons・charms.extra) も引ける索引 (Worker の索引は data/*.json だけで作るため。
  // 守りのチェック・いまの装備の値・相手ごとの値の計算し直しで、端末の武器・護石の組が読めないことが無いように)
  const index = indexWithExtras(data && data.index, job && job.runs && job.runs[0] ? job.runs[0].input : null);
  const K = job ? job.K : 10;
  const subjects = job ? job.subjects : [];
  const multi = subjects.length > 1;
  const st = {
    phase: 'runs', runIndex: 0, runs: (job && job.runs ? job.runs : []).map((r) => ({ ...r, search: null, result: null, status: null, ms: 0 })),
    cost: job && job.costRun ? { ...job.costRun, search: null, result: null, status: null, ms: 0 } : null,
    cancelled: false, error: null, activeMs: 0, merged: null, two: null, twoQueue: [], extendQueue: [],
    mergeMs: 0, twoMs: 0, extended: 0, warnings: [...((job && job.warnings) || [])],
    // 探索の回の持ち時間 (job.runsBudget) と、「続けて探す」の持ち時間 (extend の予算)。配り方は poolOf / beginPass / endPass
    runsPool: null, extPool: null,
  };
  if (job && isObj(job.runsBudget) && finite(job.runsBudget.activeMs) > 0) {
    st.runsPool = poolOf('activeMs', job.runsBudget.activeMs, st.runs.length);
  }
  if (!job || job.blocked || !st.runs.length) st.phase = 'done';
  else if (typeof createSearch !== 'function') {
    st.error = '装備を探す機能を読み込めませんでした';
    st.phase = 'done';
  }
  // 相手 × 部位の行 (全部の回で同じ。武器 2 本の「続けて探す」の回だけ一部の相手に絞るので、計算し直しはいつもこちらで)
  const fullTargets = st.runs.length && Array.isArray(st.runs[0].input.targets) ? st.runs[0].input.targets : [];

  const evalCtxOf = (input) => ({
    index, effects, motions: data && data.motions, combo: input.combo, uptimes: input.uptimes,
    monsterStatus: input.monsterStatus, sharpness: input.sharpness, buffs: input.buffs,
  });
  const addWarning = (list, w) => {
    // 回ごとに数の変わる警告 (武器を絞った本数) は 1 行にまとめる
    const i = w && w.code === 'weapons-sieved' ? list.findIndex((x) => x.code === 'weapons-sieved') : -1;
    if (i >= 0) list[i] = mergeSieved(list[i], w);
    else if (!list.some((x) => x.code === w.code && x.message === w.message)) list.push(w);
  };

  /** 探索の結果 1 件に、相手ごとの値・守りのチェック・γ の印などを足す */
  const decorate = (res, run) => {
    const input = run.input;
    let perGroup = isObj(res.perGroup) ? res.perGroup : null;
    if (!perGroup || subjects.some((s) => finite(perGroup[s.key]) == null)) {
      if (!multi && subjects.length === 1 && finite(res.value) != null && !run.extra) perGroup = { [subjects[0].key]: res.value };
      else {
        // 探索が相手ごとの値 (perGroup) を返さないとき: 同じ式で計算し直す。できなければ T が出ないので下に並び、警告を出す
        const errors = [];
        const ev = evaluateBuild(res.build, fullTargets, { ...evalCtxOf(input), errors });
        perGroup = ev ? ev.perGroup : null;
        if (!ev) {
          addWarning(st.warnings, { code: 'per-subject-failed', message: `相手ごとの期待値を計算できない組がありました (${errors[0] || '装備が読めません'})` });
        }
      }
    }
    const defense = index ? defenseCheck(res.build, job.requirements, index, effects) : null;
    return {
      ...res, run: run.key, perGroup, weapons: [res.weapon ?? (res.build ? res.build.weapon : null)], builds: [res.build],
      defense, gamma: gammaMarksOf(res.build, job.gamma),
    };
  };

  /** いまの装備の値 (探索が baseline を返さないとき。探索と同じ式 = evaluateBuild で 1 回だけ計算する) */
  let ownBaseline;
  const baselineOwn = () => {
    if (ownBaseline !== undefined) return ownBaseline;
    ownBaseline = null;
    const input = st.runs.length ? st.runs[0].input : null;
    if (input && input.current && index) {
      const ev = evaluateBuild(input.current, fullTargets, evalCtxOf(input));
      if (ev) ownBaseline = { value: ev.value, perGroup: ev.perGroup };
    }
    return ownBaseline;
  };

  /** いまの装備との比べ (探索が baseline を返せばそれ、無ければ同じ式で計算した値、それも無ければ Plan で計算した値) */
  const withBaseline = (r, searchBaseline) => {
    const usable = (b) => !!b && (multi
      ? isObj(b.perGroup) && subjects.every((s) => finite(b.perGroup[s.key]) > 0)
      : finite(b.value) > 0);
    const candidates = [
      searchBaseline ? { value: searchBaseline.value, perGroup: searchBaseline.perGroup || null } : null,
      baselineOwn(),
      job.baseline ? { value: job.baseline.value, perGroup: job.baseline.perSubject } : null,
    ];
    const found = candidates.find(usable) || null;
    // baseline.value は score.value と同じ単位 (1 体 = 期待値、多頭 = T、体力が全員分からない多頭 = 期待値の調和平均)
    const baseline = found ? baselineView(subjects, found) : null;
    if (!baseline) return { ...r, baseline: null, vsBaselinePct: null };
    return { ...r, baseline, vsBaselinePct: vsBaselinePct(r.score, baseline) };
  };

  /** 守りを満たす組を先に (属性やられの耐性が 20 に届かない組は下へ)、その中で score の順。武器 2 本は 2 本とも満たすか */
  const sortMerged = (list, twoWeapons = false) => {
    const ranked = rerankMulti(list, subjects, { twoWeapons });
    const okOf = (r) => (!r.defense || r.defense.ok) && (!r.defense2 || r.defense2.ok);
    return [...ranked.filter(okOf), ...ranked.filter((r) => !okOf(r))];
  };

  /** 同じ組 (武器・防具・護石。武器 2 本は 2 本とも) は 1 件に (並べた順で先のもの = 良い方)。順位を振り直す */
  const dedupe = (list) => {
    const seen = new Set();
    const out = [];
    for (const r of list) {
      const k = (r.builds || [r.build]).map(buildKey).join('/');
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
    return out.map((r, i) => ({ ...r, rank: i + 1 }));
  };

  /** 回の結果を合わせる (includeCurrent: 途中の結果が出ている今の回も入れる) */
  const assemble = ({ includeCurrent }) => {
    const t0 = now();
    const lists = [];
    let baselineFromSearch = null;
    const warnings = [];
    const infeasible = [];
    const cur = currentRun();
    for (const run of st.runs) {
      let r = run.result;
      if (!r && includeCurrent && run === cur && run.search) {
        // 途中の結果 (仕上げ 1 のあと)。読めなければ途中の結果は出さない (終わりの結果で必ず読む)
        try {
          const p = run.search.progress();
          if (p && p.partialReady) r = run.search.result();
        } catch {
          r = null;
        }
      }
      if (!r) continue;
      if (r.status === 'infeasible') infeasible.push({ run: run.key, ...(r.infeasible || {}) });
      for (const w of r.warnings || []) addWarning(warnings, w);
      if (r.baseline && !baselineFromSearch && !run.extra) baselineFromSearch = r.baseline;
      for (const res of r.results || []) lists.push(decorate(res, run));
    }
    for (const w of st.warnings) addWarning(warnings, w);
    const pool = dedupe(sortMerged(lists));
    const results = pool.slice(0, K).map((r) => withBaseline(r, baselineFromSearch));
    if (st.runs.length > 1 && infeasible.some((x) => x.run === 'blight-resist') && !infeasible.some((x) => x.run === 'blight-skill')) {
      warnings.push({ code: 'blight-resist-infeasible', message: '耐性の値で防ぐ組は無かったので、属性やられ耐性 Lv3 の方だけで探しました' });
    }
    if (subjects.some((s) => s.healthAssumed) && multi) {
      if (!warnings.some((w) => w.code === 'health-assumed' || w.code === 'health-unknown')) {
        warnings.push({ code: 'health-assumed', message: '体力が分からない相手は、分かっている相手の平均で置いて数えました (仮)' });
      }
    }
    st.mergeMs += now() - t0;
    return { results, pool, warnings, infeasible, baselineFromSearch };
  };

  const finished = () => st.phase === 'done';

  /** 武器 2 本: 上位の防具の組ごとに 2 本目 (と 1 本目) を合わせる仕事の並び */
  const startTwo = () => {
    const groups = (job.merge && job.merge.groups) || [];
    if (job.merge.mode !== 'twoWeapons' || groups.length < 2) return false;
    if (typeof optimizeWeaponSide !== 'function') {
      addWarning(st.warnings, { code: 'two-weapons-unavailable', message: '武器 2 本の案は準備中です (武器 1 本の結果を出しています)' });
      return false;
    }
    const pool = (st.merged.pool || st.merged.results).filter((r) => r.perGroup);
    // 上位 TWO_WEAPON_TOP 件 + 「続けて探す」の 2 本目に合わせた回の上位 (武器 1 本の T では下に来るので別に拾う)
    const extraKeys = new Set(st.runs.filter((r) => r.extra).map((r) => r.key));
    st.two = { results: [], single: st.merged.results };
    st.twoQueue = dedupe([
      ...pool.slice(0, TWO_WEAPON_TOP),
      ...pool.filter((r) => extraKeys.has(r.run)).slice(0, TWO_WEAPON_TOP),
    ]);
    return st.twoQueue.length > 0;
  };

  /** T (武器 2 本。相手ごとに良い方の武器で数える) */
  const twoT = (pg1, pg2) => {
    let T = 0;
    for (const s of subjects) {
      const d = Math.max(finite(pg1 && pg1[s.key]) ?? 0, finite(pg2 && pg2[s.key]) ?? 0);
      if (!(d > 0)) return Infinity;
      T += s.health.mid / d;
    }
    return T;
  };

  /**
   * 防具の組 1 つに武器 2 本を合わせる (3.3 節の 2): 防具・護石・珠を固定したまま、2 本目の武器と武器の珠を選び直し
   * (T が一番小さくなるもの)、続けて 1 本目も 1 回だけ選び直す。候補はその回の探索の武器 (おすすめの属性の武器を合わせたもの)。
   * 護石の武器用スロットの珠は 2 本で共通として扱う (未確認。docs/RECOMMEND_DESIGN.md 3.3 節)。
   */
  const twoStep = (r) => {
    const run = st.runs.find((x) => x.key === r.run) || st.runs[0];
    const b = r.build;
    const fixed = {
      armor: b.armor, charm: b.charm, limitBreak: b.limitBreak,
      decorations: Object.fromEntries(Object.entries(b.decorations || {}).filter(([k]) => k !== 'weapon')),
    };
    // 同じ入力の物を渡すと optimizeWeaponSide は下ごしらえを使い回す (WeakMap)。回ごとに 1 つだけ作る
    if (!run.sideInput) run.sideInput = { ...run.input, targets: fullTargets };
    const input = run.sideInput;
    const pick = (score) => {
      try {
        // 計算し直し (computeBuild + comboExpected) は省く (評価器の値は comboExpected と相対 1e-13 で同じ。1 件 50〜100ms 速い)
        const list = optimizeWeaponSide(input, fixed, data, { score, N: 1, check: false }) || [];
        return list[0] || null;
      } catch (e) {
        addWarning(st.warnings, { code: 'two-weapons-failed', message: `武器 2 本の案を作れなかった組があります (${(e && e.message) || e})` });
        return null;
      }
    };
    const w2 = pick((pg) => -twoT(r.perGroup, pg));
    if (!w2) return;
    let w1 = { weapon: r.weapons[0], decorations: { weapon: (b.decorations || {}).weapon || [] }, perGroup: r.perGroup };
    const re1 = pick((pg) => -twoT(pg, w2.perGroup));
    if (re1 && twoT(re1.perGroup, w2.perGroup) < twoT(w1.perGroup, w2.perGroup)) w1 = re1;
    const build1 = { ...b, weapon: w1.weapon, decorations: { ...(b.decorations || {}), weapon: (w1.decorations && w1.decorations.weapon) || [] } };
    const build2 = { ...b, weapon: w2.weapon, decorations: { ...(b.decorations || {}), weapon: (w2.decorations && w2.decorations.weapon) || [] } };
    st.two.results.push({
      ...r, weapon: w1.weapon, build: build1, builds: [build1, build2], weapons: [w1.weapon, w2.weapon],
      perGroup: w1.perGroup, perGroup2: w2.perGroup, twoWeapons: true,
      // 武器の側は計算し直していない (check: false)。1 本の組の計算し直しの値は武器が変わると合わないので外す
      check: w1.weapon === r.weapons[0] ? r.check : null,
      defense: index ? defenseCheck(build1, job.requirements, index, effects) : r.defense,
      defense2: index ? defenseCheck(build2, job.requirements, index, effects) : null,
      gamma: gammaMarksOf(build1, job.gamma),
    });
  };

  const finishTwo = () => {
    if (!st.two || !st.two.results.length) {
      // 1 件も合わせられなかった: 武器 1 本の結果のまま出す
      addWarning(st.warnings, { code: 'two-weapons-none', message: '武器 2 本の案は作れませんでした (武器 1 本の結果を出しています)' });
      st.two = null;
      return;
    }
    const ranked = dedupe(sortMerged(st.two.results, true)).slice(0, K).map((r) => withBaseline(r, st.merged.baselineFromSearch));
    const oneT = st.merged.results.length && st.merged.results[0].score.kind === 'combos' ? st.merged.results[0].score.value : null;
    const best = ranked[0] || null;
    st.merged = {
      ...st.merged, results: ranked,
      singleWeapon: { results: st.two.single, bestT: oneT },
      twoWeaponsGain: best && oneT != null && best.score.value != null
        ? { combos: oneT - best.score.value, text: `武器 1 本で通すと 約 +${Math.round(oneT - best.score.value)} 回` } : null,
    };
    st.two = null;
  };

  const finishCost = () => {
    const r = st.cost.result;
    if (!r || !r.results || !r.results.length || !st.merged.results.length) return;
    const list = r.results.map((x) => decorate(x, st.cost));
    const free = rerankMulti(list, subjects)[0];
    const main = st.merged.singleWeapon && st.merged.singleWeapon.results.length
      ? rerankMulti(st.merged.singleWeapon.results, subjects)[0] : st.merged.results[0];
    if (!free || free.score.value == null || main.score.value == null) return;
    const kind = main.score.kind;
    let pct = kind === 'combos' ? (free.score.value / main.score.value - 1) * 100 : (main.score.value / free.score.value - 1) * 100;
    const raw = pct;
    if (pct > 0) pct = 0; // 守りなしの方は途中の結果までなので、守りありより低いことがある (差なしとして扱う)
    st.merged.costOfDefense = { kind, main: main.score.value, free: free.score.value, pct, rawPct: raw, approx: true };
  };

  /** 武器 2 本の「続けて探す」(3.3 節の 4): 2 本目の武器で倒す相手だけを、いまの最良の組のまわりで T を 1 次で近づけた重みで見た回 */
  const focusRun = () => {
    if (!job.merge || job.merge.mode !== 'twoWeapons' || !st.merged) return null;
    const best = st.merged.results.find((r) => r.twoWeapons);
    if (!best) return null;
    const keys = best.perSubject.filter((p) => p.weapon === 2 && p.value > 0).map((p) => p.key);
    if (!keys.length || keys.length === subjects.length) return null;
    const key = `two-focus:${[...keys].sort().join(',')}`;
    if (st.runs.some((r) => r.key === key)) return null; // 同じ相手に絞った回は、ほかの回と同じく延長で回す
    const base = st.runs.find((r) => r.key === best.run && !r.extra) || st.runs[0];
    const H = Object.fromEntries(subjects.map((s) => [s.key, s.health.mid]));
    const D = Object.fromEntries(best.perSubject.map((p) => [p.key, p.value]));
    const raw = Object.fromEntries(keys.map((k) => [k, H[k] / (D[k] * D[k])]));
    const sumRaw = keys.reduce((a, k) => a + raw[k], 0);
    const groupW = {};
    for (const t of fullTargets) groupW[t.group] = (groupW[t.group] || 0) + (Number(t.weight) || 0);
    const targets = fullTargets.filter((t) => keys.includes(t.group)).map((t) => ({
      ...t, weight: (raw[t.group] / sumRaw) * ((Number(t.weight) || 0) / (groupW[t.group] || 1)),
    }));
    const names = subjects.filter((s) => keys.includes(s.key)).map((s) => s.name).filter(Boolean).join('・');
    return {
      key, extra: true, label: `2 本目の武器で倒す相手${names ? ` (${names}) ` : ''}に合わせて探しています`,
      input: { ...base.input, targets }, search: null, result: null, status: null, ms: 0,
    };
  };

  /** 探索の stats (result() か progress() の) → 予算と比べた計算の時間 (activeMs − prepareMs。予算で数えない下ごしらえは除く)。無ければ null */
  const activeOf = (s) => {
    const a = s ? finite(s.activeMs) : null;
    return a != null ? Math.max(0, a - (finite(s.prepareMs) ?? 0)) : null;
  };
  /** 回が予算と比べて使った時間 (探索が数えた計算の時間。探索が返さなければ runner で測った回の時間) */
  const spentOf = (run) => activeOf(run.result && run.result.stats) ?? run.ms;
  /**
   * 回 (延長も) を始める: 持ち時間から予算を受け取り、使った分を数える起点を覚える。受け取った予算を返す。
   * act0 = 探索が数えた計算の時間の起点 (まだ探索が無ければ 0。結果が数えていなければ null で、経過は runner で測った時間で出す)
   */
  const beginPass = (run, pool) => {
    const given = sliceOf(pool);
    run.pass = { pool, given, spent0: spentOf(run), act0: run.result ? activeOf(run.result.stats) : 0, ms0: run.ms };
    return given;
  };
  /**
   * 回 (延長はその延長) を始めてからの、予算と比べた計算の時間 (progress().run.elapsedMs。画面の帯の回の中の伸び)。
   * 探索の progress().stats で数える (下ごしらえを入れない。予算と同じ時計)。数えていなければ runner で測った時間
   */
  const passElapsedOf = (run, pass, sub) => {
    const a = activeOf(sub && sub.stats);
    return a != null && pass.act0 != null ? Math.max(0, a - pass.act0) : run.ms - pass.ms0;
  };
  /** 回 (延長も) が終わった: 使った分 (渡した予算が上限) を持ち時間から引く。残りは後の回に回る */
  const endPass = (run) => {
    const p = run.pass;
    if (!p || p.done) return;
    p.done = true;
    if (p.pool.kind === 'activeMs') p.pool.spent += Math.min(p.given.activeMs, Math.max(0, spentOf(run) - p.spent0));
  };

  /**
   * 後の回の floor (これ以下の値の構成は要らない): 相手が 1 体・武器 1 本 (merge.mode 'single') なら、合わせた結果の並びは期待値の順
   * なので、前の回で守りを満たした組の K 番目の値より下の組は、最後まで探しても上位 K に入らない。その値を後の回の探索に渡して
   * 刈らせる (最後まで探したときの上位は変わらない。2026-10-24: 耐性の回を守りの条件つきで探すと重くなった分を減らすため)。
   * 多頭 (回数 T で並べ直す)・武器 2 本 (後で武器を合わせ直す) は並びが探索の値と違うので渡さない
   */
  const floorFor = (run) => {
    if (!job.merge || job.merge.mode !== 'single' || multi || run.extra || !index) return null;
    const i = st.runs.indexOf(run);
    if (i <= 0) return null;
    const seen = new Set();
    const vals = [];
    for (const prev of st.runs.slice(0, i)) {
      for (const res of (prev.result && prev.result.results) || []) {
        const k = buildKey(res.build);
        if (seen.has(k) || !(finite(res.value) != null)) continue;
        seen.add(k);
        if (defenseCheck(res.build, job.requirements, index, effects).ok) vals.push(res.value);
      }
    }
    if (vals.length < K) return null;
    vals.sort((a, b) => b - a);
    return vals[K - 1];
  };

  const stepRunSearch = (run, deadline) => {
    if (!run.search) {
      try {
        // 予算を回を始めるときに受け取った回 (run.budget) は、入力の予算の代わりにそれで回す
        const floor = run === st.cost ? null : floorFor(run);
        if (floor != null) run.floor = floor;
        const input = { ...run.input, ...(run.budget ? { budget: run.budget } : {}), ...(floor != null ? { floor } : {}) };
        run.search = createSearch(input, data);
      } catch (e) {
        st.error = (e && e.message) || String(e);
        return true;
      }
    }
    const t = now();
    const done = run.search.step(Math.max(1, deadline - t));
    run.ms += now() - t;
    if (done) {
      run.result = run.search.result();
      run.status = run.result ? run.result.status : null;
    }
    return done;
  };

  /** 回の途中で出た警告を、合わせた結果の警告に移す */
  const flushWarnings = () => {
    if (!st.merged) return;
    for (const w of st.warnings) addWarning(st.merged.warnings, w);
  };

  function step(ms = 80) {
    if (finished()) return true;
    const start = now();
    const deadline = start + Math.max(1, Number(ms) || 80);
    try {
      while (!finished()) {
        if (st.cancelled) {
          if (st.phase === 'runs' || !st.merged) {
            const run = st.runs[st.runIndex];
            if (run && run.search && !run.result) {
              try { run.search.step(1); } catch { /* 止まっていれば何もしない */ }
            }
            st.merged = assemble({ includeCurrent: true });
          } else if (st.phase === 'two' && st.two && st.two.results.length) finishTwo();
          // 合わせ・火力の差・延長の途中でやめたときは、それまでに出ていた結果のまま
          flushWarnings();
          st.phase = 'done';
          break;
        }
        if (st.phase === 'extend') {
          const run = st.extendQueue[0];
          if (!run) {
            st.phase = 'merge';
            continue;
          }
          const done = stepRunSearch(run, deadline);
          if (st.error) {
            st.phase = 'done';
            break;
          }
          if (done) {
            endPass(run);
            st.extendQueue.shift();
            beginExtendHead();
          }
        } else if (st.phase === 'runs') {
          const run = st.runs[st.runIndex];
          // 回の予算は始めるときに持ち時間から受け取る (前の回が使わなかった分も入る)
          if (!run.search && st.runsPool) run.budget = beginPass(run, st.runsPool);
          const done = stepRunSearch(run, deadline);
          if (st.error) {
            st.phase = 'done';
            break;
          }
          if (done) {
            endPass(run);
            st.runIndex += 1;
            if (st.runIndex >= st.runs.length) st.phase = 'merge';
          }
        } else if (st.phase === 'merge') {
          st.merged = assemble({ includeCurrent: false });
          st.phase = startTwo() ? 'two' : (st.cost && !st.cost.result ? 'cost' : 'finish');
        } else if (st.phase === 'two') {
          const t = now();
          const r = st.twoQueue.shift();
          if (r) twoStep(r);
          st.twoMs += now() - t;
          if (!st.twoQueue.length) {
            finishTwo();
            st.phase = st.cost && !st.cost.result ? 'cost' : 'finish';
          }
        } else if (st.phase === 'cost') {
          const done = stepRunSearch(st.cost, deadline);
          if (st.error) {
            // 火力の差が測れなくても結果は出す
            addWarning(st.warnings, { code: 'cost-failed', message: '守りのスキルの火力の差は測れませんでした' });
            st.error = null;
            st.cost.result = { status: 'error', results: [] };
            st.phase = 'finish';
          } else if (done) st.phase = 'finish';
        } else if (st.phase === 'finish') {
          if (st.cost && st.cost.result) finishCost();
          flushWarnings();
          st.phase = 'done';
        }
        if (now() >= deadline) break;
      }
    } finally {
      st.activeMs += now() - start;
    }
    return finished();
  }

  function currentRun() {
    if (st.phase === 'runs') return st.runs[st.runIndex] || null;
    if (st.phase === 'extend') return st.extendQueue[0] || null;
    if (st.phase === 'cost') return st.cost;
    return null;
  }

  function progress() {
    const run = currentRun();
    let sub = null;
    if (run && run.search) {
      try { sub = run.search.progress(); } catch { sub = null; }
    }
    const firstDone = st.runs.length && st.runs[0].result;
    const partialReady = !!(firstDone || (st.runIndex === 0 && sub && sub.partialReady) || st.merged);
    const idx = run ? Math.max(0, st.runs.indexOf(run)) : st.runs.length - 1;
    // 回の数は火力の差を測る回も数える (「3 / 3 回目: 守りのスキルの火力の差を…」。count より大きい回目を出さない)
    const count = st.runs.length + (st.cost ? 1 : 0);
    // いまの最良: 探索の回の途中の上位 (1 体の期待値)。多頭はその回の重み付きの期待値で T ではないので出さず、合わせた結果 (T) を出す。
    // 火力の差の回 (守りなしの探索) の上位も出さない (守りありの結果より上下するので、合わせた結果のまま)
    const merged = st.merged ? st.merged.results.map((r) => ({ value: r.score.value, exact: true })) : [];
    const searching = st.phase === 'runs' || st.phase === 'extend';
    const best = searching && !multi && sub && Array.isArray(sub.best) ? sub.best : merged;
    const top = st.merged && st.merged.results[0] ? st.merged.results[0].score : null;
    // 持ち時間から予算を受け取った回は、その回の予算と、回 (延長はその延長) を始めてからの計算の時間 (下ごしらえは入れない) も出す
    // (画面の帯が回ごとの予算で伸びる)
    const pass = searching && run && run.pass && !run.pass.done ? run.pass : null;
    const passBudget = pass ? finite(pass.given.activeMs ?? pass.given.ms) : null;
    return {
      phase: searching ? (sub ? sub.phase : 'prepare')
        : st.phase === 'two' ? 'twoWeapons' : st.phase === 'cost' ? 'cost' : st.phase === 'done' ? 'done' : 'merge',
      elapsedMs: st.activeMs,
      best, bestKind: top ? top.kind : (multi ? 'combos' : 'damage'),
      partialReady,
      run: run === st.cost && run
        ? { index: st.runs.length, count, label: st.cost.label, key: 'cost' }
        : {
          index: idx, count, label: (st.runs[idx] || {}).label || '', key: (st.runs[idx] || {}).key || null,
          ...(passBudget != null ? { budgetMs: passBudget, elapsedMs: passElapsedOf(run, pass, sub) } : {}),
        },
      stats: sub ? sub.stats || null : null,
    };
  }

  function statsOf() {
    return {
      elapsedMs: st.activeMs, mergeMs: st.mergeMs, twoWeaponsMs: st.twoMs, extended: st.extended,
      runs: [...st.runs, ...(st.cost ? [st.cost] : [])].map((r) => ({
        key: r.key, label: r.label, status: r.status, ms: r.ms, stats: r.result ? r.result.stats || null : null,
        // 持ち時間から受け取った予算 (いちばん新しい回・延長の分。入力の予算のまま回した回は null)
        budget: r.pass ? { ...r.pass.given } : null,
        // 前の回から受け取った floor (これ以下の値は要らない。floorFor。渡さなかった回は null)
        floor: r.floor ?? null,
      })),
    };
  }

  function result() {
    if (st.error) {
      return { status: 'error', message: st.error, results: [], warnings: [...st.warnings], stats: statsOf(), quality: 'heuristic', merge: job ? job.merge : null };
    }
    if (job && job.blocked) {
      return { status: 'blocked', blocked: job.blocked, results: [], warnings: [], stats: statsOf(), quality: 'heuristic', merge: null };
    }
    // 回が全部終わったあと (合わせ・火力の差・延長の途中も) は合わせた結果。延長中は新しい結果が出るまで前の結果のまま
    const m = st.merged && st.phase !== 'runs' ? st.merged : assemble({ includeCurrent: true });
    let status;
    const statuses = st.runs.map((r) => r.status);
    if (st.cancelled) status = 'cancelled';
    else if (!finished()) status = 'partial';
    else if (!m.results.length && statuses.length && statuses.every((s) => s === 'infeasible')) status = 'infeasible';
    else if (statuses.includes('stopped')) status = 'stopped';
    else status = 'done';
    const warnings = [...m.warnings];
    for (const w of st.warnings) addWarning(warnings, w);
    return {
      status, results: m.results, infeasible: m.infeasible && m.infeasible.length ? m.infeasible : null,
      warnings, stats: statsOf(), quality: 'heuristic', merge: job ? job.merge : null,
      costOfDefense: m.costOfDefense || null, singleWeapon: m.singleWeapon || null, twoWeaponsGain: m.twoWeaponsGain || null,
      extendable: canExtend(),
    };
  }

  function cancel() {
    if (finished()) return;
    st.cancelled = true;
    const run = currentRun();
    if (run && run.search) {
      try { run.search.cancel(); } catch { /* 止められなくても次の step で終える */ }
    }
  }

  /** 「続けて探す」で延長できる探索の回 (満たせなかった回と、B&B を最後まで回り終えた回を除く) */
  const extendableRuns = () => st.runs.filter((r) => r.search && r.status !== 'infeasible' && typeof r.search.extend === 'function'
    && r.search.extendable !== false);
  /** 「続けて探す」で続ける所があるか (延長できる回か、武器 2 本の 2 本目の相手に合わせた回がある)。result().extendable */
  function canExtend() {
    if (!finished() || st.cancelled || st.error || !job || job.blocked) return false;
    return extendableRuns().length > 0 || !!focusRun();
  }

  /**
   * 延長の並びの先頭の回の延長を始める (予算は始めるときに「続けて探す」の持ち時間から受け取る)。延長できない回は飛ばす。
   * 足す回 (武器 2 本の 2 本目の相手に合わせた回) は、受け取った予算で探索を作る (仕事量の予算の Job では、元の回の予算のまま)
   */
  const beginExtendHead = () => {
    while (st.extendQueue.length) {
      const run = st.extendQueue[0];
      if (!run.search) {
        if (!run.fixedBudget) run.budget = beginPass(run, st.extPool);
        return;
      }
      const given = beginPass(run, st.extPool);
      // 前の結果は新しい結果が出るまで残す (延長中に result() を呼んでも上位が消えない)
      if (run.search.extend({ ...given }) !== false) return;
      endPass(run);
      st.extendQueue.shift();
    }
    // 延長する回が無くなったら合わせに進む (最後の回が終わった直後に step の締め切りに当たっても、progress() が
    // 「準備しています」と前の回の帯に戻らない。最初の回し方と同じ)
    st.phase = 'merge';
  };

  /**
   * 「続けて探す」: 終わった回 (満たせなかった回と、最後まで回り終えた回を除く) の探索を延長して、もう一度合わせる。
   * 武器 2 本の案では、2 本目の武器で倒す相手に合わせた回を 1 つ足す (3.3 節の 4。良くなれば上位が入れ替わる)。
   * 予算は延長する回 (と足す回) に、回を始めるときに配る (activeMs は「残り ÷ 残りの回の数」で、先に終わった回の残りが後の回に回る)。
   */
  function extend({ ms, activeMs } = {}) {
    if (!canExtend()) return false;
    const runs = extendableRuns();
    const focus = focusRun();
    // activeMs (計算した時間の合計) で受けたらそれを持ち時間にして回を始めるときに配る。ms (始めてからの時間) は回の数で分ける
    const active = activeMs != null && Number(activeMs) > 0;
    const total = Number(active ? activeMs : ms) || 6000;
    if (focus) {
      const b = focus.input.budget;
      focus.fixedBudget = isObj(b) && b.work != null;
      st.runs.push(focus);
    }
    st.extPool = poolOf(active ? 'activeMs' : 'ms', total, runs.length + (focus && !focus.fixedBudget ? 1 : 0), 200);
    st.extendQueue = focus ? [...runs, focus] : [...runs];
    st.extended += 1;
    st.phase = 'extend';
    beginExtendHead();
    return true;
  }

  return { step, progress, result, cancel, extend };
}
