// 火力タブの計算 (純粋関数)。damage.js の comboExpected を「狙う部位の割合で加重平均」で包み、
// スキルの寄与 (外すと何 % 下がるか) とスキル火力表 (Lv ごとの上がり方) を作る。
// DOM にも state.js にも触らない (node でも動く)。相手の決め方は target_mix.js。
// 武器の解決・斬れ味の自動の色は装備タブと同じもの (equip_logic.js の resolveWeaponRef / autoSharpness) を使う。
//
// targets の形: [{weight, label?, partKey?, target: {hitzone, wound, isWound}}]
//   weight は割合 (足して 1 でなくてよい。ここで足して 1 にそろえる。全部 0 なら等分)。
//   部位が 1 つなら [{weight: 1, target}] を渡せば damage.js をそのまま呼ぶのと同じ結果になる。
//
// input は damage.js の comboExpected と同じ形に、次の 2 つを足せる (どちらも省略可):
//   perSkills(skills) → {sharpness, …}  スキルの組で変わる値。斬れ味が「自動」のとき、匠の Lv で色が変わるので
//                       スキルを外す・Lv を変えるたびに色を決め直す (equip_logic.js の sharpnessResolver)
//   handicraft        {skillId, name, maxLevel}  匠 (skill_effects.json に無い。斬れ味の色だけを変えるスキル)。
//                       渡すと「スキルごとの効き目」「スキル火力表」に匠の行を出し、「火力に関係しない」から外す

import {
  comboExpected, normalizeSkills, conditionGroupDefs, conditionSourceMissing,
  resolveSkills, resolveConditions, factorPatterns,
} from '../../model/damage.js';
import { formatNumber, ELEMENT_LABEL } from '../components/labels.js';

/** スキルの組に合わせた input (perSkills があれば斬れ味などを決め直す) */
export function inputFor(input, skills) {
  const list = normalizeSkills(skills);
  const extra = typeof input.perSkills === 'function' ? input.perSkills(list) : null;
  return extra ? { ...input, ...extra, skills: list } : { ...input, skills: list };
}

const isHandicraft = (input, skillId) => !!(input.handicraft && Number(input.handicraft.skillId) === Number(skillId));

// ---------------------------------------------------------------- 狙う部位の割合

/** targets の重みを足して 1 にそろえる (target の無いもの・重みが負のものは捨てる。全部 0 なら等分)。 */
export function normalizeMix(targets) {
  const list = (Array.isArray(targets) ? targets : []).filter((t) => t && t.target && t.target.hitzone);
  const w = list.map((t) => {
    const n = Number(t.weight);
    return Number.isFinite(n) && n > 0 ? n : 0;
  });
  const sum = w.reduce((a, b) => a + b, 0);
  return list.map((t, i) => ({ ...t, weight: sum > 0 ? w[i] / sum : 1 / list.length }))
    .filter((t) => t.weight > 0);
}

const pct = (a, b) => (b > 0 ? (a / b - 1) * 100 : 0);

function mergeWarnings(into, list) {
  for (const w of list) {
    if (!into.some((x) => x.code === w.code && x.message === w.message)) into.push(w);
  }
  return into;
}

/** 部位ごとの警告のうち、部位の名前を付けないと分からないもの (割合で混ぜたとき) */
const PER_PART_WARNINGS = new Set(['no-wound']);

/**
 * 狙う部位の割合で加重平均したコンボ 1 回の期待値。
 * 返り値は comboExpected と同じ形 (total / physical / element / extra / steps / conditions / warnings /
 * unsupported / unknown / lowConfidence / patterns / extraChecks) に、perTarget (部位ごとの {label, weight, total}) と mixed を足したもの。
 * 条件グループ・未対応スキルなどはスキルだけで決まるので、部位によらず同じ (最初の部位のものを使う)。
 * extraChecks (灼熱化の判定の要約) は、判定の回数を部位の割合で平均し、発動の回数と間隔を出し直す
 * (部位で変わるのは傷口でだけ出るヒットの有無だけ)。
 */
export function mixExpected(input0, targets) {
  const input = inputFor(input0, input0.skills);
  const mix = normalizeMix(targets);
  if (!mix.length) throw new Error('相手 (肉質) が決まっていません');
  const mixed = mix.length > 1;
  let acc = null;
  const perTarget = [];
  for (const m of mix) {
    const r = comboExpected({ ...input, target: m.target });
    perTarget.push({ label: m.label ?? null, partKey: m.partKey ?? null, weight: m.weight, total: r.total });
    if (!acc) {
      acc = {
        total: 0, physical: 0, element: 0, extra: 0, patterns: r.patterns,
        steps: r.steps.map((s) => ({ ...s, total: 0, physical: 0, element: 0, extra: 0, isWound: false, woundShare: 0 })),
        conditions: r.conditions, warnings: [], unsupported: r.unsupported,
        // 匠は skill_effects.json に無いが、斬れ味の色で火力に効く (「火力に関係しない」には入れない)
        unknown: r.unknown.filter((s) => !isHandicraft(input, s.skillId)),
        lowConfidence: r.lowConfidence, sharpness: input.sharpness,
        extraChecks: (r.extraChecks || []).map((x) => ({ ...x, checksPerCycle: 0 })),
      };
    }
    (r.extraChecks || []).forEach((x, i) => { if (acc.extraChecks[i]) acc.extraChecks[i].checksPerCycle += m.weight * x.checksPerCycle; });
    acc.total += m.weight * r.total;
    acc.physical += m.weight * r.physical;
    acc.element += m.weight * r.element;
    acc.extra += m.weight * r.extra;
    r.steps.forEach((s, i) => {
      const a = acc.steps[i];
      a.total += m.weight * s.total;
      a.physical += m.weight * s.physical;
      a.element += m.weight * s.element;
      a.extra += m.weight * s.extra;
      if (s.isWound) {
        a.isWound = true;
        a.woundShare += m.weight;
      }
    });
    const ws = mixed && m.label
      ? r.warnings.map((w) => (PER_PART_WARNINGS.has(w.code) ? { ...w, message: `【${m.label}】${w.message}` } : w))
      : r.warnings;
    mergeWarnings(acc.warnings, ws);
  }
  for (const x of acc.extraChecks) {
    x.procsPerCycle = x.perCheck * x.checksPerCycle;
    x.secPerProc = x.procsPerCycle > 0 ? x.cycleSec / x.procsPerCycle : null;
  }
  acc.perTarget = perTarget;
  acc.mixed = mixed;
  return acc;
}

/**
 * 「追加」の説明。灼熱化があれば、この連携を続けたときの発動の間隔 (結論) → 判定の決まり (理由) → 見積もりの断り の順。
 * 判定の決まりは「対象の攻撃が当たったときだけ」「前の判定から待ちの秒数たつまでは判定しない」の 2 つを書く
 * (待ちの秒数 × 2 が間隔だと読めないように。実際の判定の間隔は技の並びで決まる)。
 * 技が 1 つだけのコンボは「この技を続けて出すと」と書く (その技だけを続けて出す前提の目安なので)。
 * r = mixExpected の結果 (extraChecks の灼熱化を使う。部位の割合で平均したもの)。文は本人の好み (短い文・結論が先・です/ます)
 */
export function extraHintText(r) {
  const x = (r.extraChecks || []).find((c) => c.kind === 'scorch' && c.secPerProc > 0);
  if (!x) return '追加 = スキルの追加ダメージです (発動の確率込み)。';
  const every = formatNumber(1 / x.perCheck, 0);
  const repeat = (r.steps || []).length === 1 ? 'この技を続けて出すと' : 'この連携を続けると';
  return `追加 = 灼熱化などスキルの追加ダメージです。灼熱化は、${repeat}約 ${formatNumber(x.secPerProc, 1)} 秒に 1 回出ます。`
    + '判定は、灼熱化の出る攻撃が当たったときだけです。'
    + `前の判定から ${formatNumber(x.cooldownSec, 1)} 秒たつまでは判定しません。平均すると、判定 ${every} 回に 1 回出ます。`
    + `技のつなぎの秒数は見積もりです。${x.estimated ? '秒数の分からない技は、仮の長さで数えています。' : ''}`;
}

/** 加重平均の合計だけ (速さ優先。スキル火力表で何度も呼ぶ) */
export function mixTotal(input0, targets) {
  const input = inputFor(input0, input0.skills);
  const mix = normalizeMix(targets);
  let total = 0;
  for (const m of mix) total += m.weight * comboExpected({ ...input, target: m.target }).total;
  return total;
}

function effectsMap(effects) {
  if (!effects) return {};
  return effects.effects || effects;
}

/**
 * スキルなし比と、スキルを 1 つずつ外したときの低下 (狙う部位の割合で加重平均)。
 * @returns mixExpected の結果に {noSkills, vsNoSkillsPct, removeEach} を足したもの。
 *   removeEach[]: {skillId, name, level, total, dropPct} を dropPct の大きい順。
 *   計算に入らないスキル (未対応・skill_effects に無い) は removeEach に入れない (匠は input.handicraft があれば入れる)。
 *   斬れ味が「自動」(input.perSkills) なら、スキルなし・外したときの斬れ味の色も決め直す (匠を外すと色が下がる)。
 */
export function mixContribution(input, targets) {
  const skills = normalizeSkills(input.skills);
  const base = mixExpected(inputFor(input, skills), targets);
  const noSkills = mixTotal(inputFor(input, []), targets);
  const skip = new Set([...base.unsupported, ...base.unknown].map((s) => Number(s.skillId)));
  const map = effectsMap(input.effects);
  const removeEach = [];
  for (const s of skills) {
    if (skip.has(s.skillId)) continue;
    const entry = map[String(s.skillId)];
    if (!entry && !isHandicraft(input, s.skillId)) continue;
    const without = mixTotal(inputFor(input, skills.filter((o) => o.skillId !== s.skillId)), targets);
    removeEach.push({
      skillId: s.skillId, name: entry ? entry.name : input.handicraft.name, level: s.level, total: without,
      dropPct: base.total > 0 ? (1 - without / base.total) * 100 : 0,
    });
  }
  removeEach.sort((a, b) => b.dropPct - a.dropPct);
  return { ...base, noSkills, vsNoSkillsPct: pct(base.total, noSkills), removeEach };
}

// ---------------------------------------------------------------- スキル火力表

/** 確度 low の値を使うスキルか (スキル全体・Lv ごと・追加ダメージのどれか) */
export function isLowConfidenceEntry(entry) {
  if (!entry) return false;
  if (entry.confidence === 'low') return true;
  return (entry.levels || []).some((l) => l.confidence === 'low' || (l.extraDamage && l.extraDamage.confidence === 'low'));
}

/** 追加ダメージの種類の名前 (画面の文に使う) */
const EXTRA_KIND_LABEL = { scorch: '灼熱化' };

/**
 * 属性スキルが掛かる追加ダメージ (extraDamage.elementSkillsApply。いまは火竜の力の灼熱化) の属性の種類 →
 * {skillId, skillName, label, elementType}。skills を渡すと、そのスキルの組 (いまの Lv の効果) にあるものだけ。省略すると全スキルから。
 */
function extraElementSources(map, skills) {
  const out = new Map();
  const add = (skillId, e, lv) => {
    const x = lv && lv.extraDamage;
    if (!x || !x.elementSkillsApply || !x.elementType || out.has(x.elementType)) return;
    out.set(x.elementType, {
      skillId, skillName: e.name, label: EXTRA_KIND_LABEL[x.kind] || '追加ダメージ', elementType: x.elementType,
    });
  };
  if (skills) {
    for (const s of normalizeSkills(skills)) {
      const e = map[String(s.skillId)];
      const levels = (e && e.supported !== false && e.levels) || [];
      if (!levels.length) continue;
      const top = levels[levels.length - 1].level;
      add(s.skillId, e, levels.find((l) => l.level === Math.min(s.level, top)));
    }
  } else {
    for (const [id, e] of Object.entries(map)) {
      if (e && e.supported !== false) for (const l of e.levels || []) add(Number(id), e, l);
    }
  }
  return out;
}

/**
 * スキル火力表に載せるスキルを skill_effects.json から選ぶ。
 * 武器の属性と合わない「〇属性攻撃強化」は表から外す。ただし、いまのスキルにその属性の追加ダメージ (灼熱化 = 火竜の力。
 * 火属性攻撃強化は武器の属性と関係なく火の分に効く) があれば表に残し、行の extraOnly にそれを書く。
 * @param {object} effects skill_effects.json 丸ごと
 * @param {object|null} weapon 武器 (属性が合わない「〇属性攻撃強化」を分けるため)
 * @param {object} [opts] {handicraft: {skillId, name, maxLevel}} 匠の行を足す (斬れ味の色で効く)。
 *   {skills} いまのスキル ([{skillId, level}] か {id: Lv})。灼熱化のように属性スキルが掛かる追加ダメージがあるかを見る
 * @returns {{rows: Array, unsupported: Array, otherElement: Array}}
 *   rows[]: {skillId, name, kind, maxLevel, conditional, conditionGroup, requiresSkillId, lowConfidence, lowReason, confidence,
 *            entry (skill_effects の要素。匠は null), sharpnessSkill (匠なら true),
 *            extraOnly (武器の属性と合わないが追加ダメージにだけ効く属性スキルなら {skillId, skillName, label, elementType}。ほかは null)}
 *   unsupported[]: supported:false のスキル {skillId, name, kind, reason} (計算に入れていない)
 *   otherElement[]: 武器の属性と違う属性の強化スキル {skillId, name, elementTypes,
 *            extraIfAdded (そのスキルをつけると追加ダメージに効くようになるなら {skillId, skillName, label, elementType}。ほかは null)}
 */
export function skillTableCandidates(effects, weapon, opts = {}) {
  const map = effectsMap(effects);
  const elem = weapon && weapon.element ? weapon.element.type : null;
  const rows = [];
  const unsupported = [];
  const otherElement = [];
  const extraNow = extraElementSources(map, opts.skills || []);
  let extraAll = null;
  const hc = opts.handicraft;
  if (hc && hc.skillId != null && !map[String(hc.skillId)]) {
    rows.push({
      skillId: Number(hc.skillId), name: hc.name || '匠', kind: 'armor', maxLevel: Number(hc.maxLevel) || 5,
      conditional: false, conditionGroup: null, requiresSkillId: null, confidence: 'high',
      lowConfidence: false, lowReason: '', entry: null, sharpnessSkill: true,
    });
  }
  for (const [id, e] of Object.entries(map)) {
    const levels = (e && e.levels) || [];
    if (!levels.length) continue;
    const skillId = Number(id);
    if (e.supported === false) {
      unsupported.push({ skillId, name: e.name, kind: e.kind, reason: e.note || '' });
      continue;
    }
    const types = [...new Set(levels.map((l) => l.elementType).filter(Boolean))];
    let extraOnly = null;
    if (types.length && !types.includes(elem)) {
      extraOnly = types.map((t) => extraNow.get(t)).find(Boolean) || null;
      if (!extraOnly) {
        if (!extraAll) extraAll = extraElementSources(map, null);
        const extraIfAdded = types.map((t) => extraAll.get(t)).find(Boolean) || null;
        otherElement.push({ skillId, name: e.name, elementTypes: types, extraIfAdded });
        continue;
      }
    }
    const low = isLowConfidenceEntry(e);
    rows.push({
      skillId, name: e.name, kind: e.kind, maxLevel: levels[levels.length - 1].level,
      conditional: !!e.conditional, conditionGroup: e.conditional ? (e.conditionGroup ?? null) : null,
      requiresSkillId: e.requiresSkillId ?? null, confidence: e.confidence,
      lowConfidence: low, lowReason: low ? (e.note || '') : '', entry: e, sharpnessSkill: false, extraOnly,
    });
  }
  return { rows, unsupported, otherElement };
}

/** 表の行の名前の欄の注記: 武器の属性と合わないが、追加ダメージ (灼熱化) の属性の分にだけ効く属性スキル。それ以外は null */
export function extraOnlyText(row) {
  const x = row && row.extraOnly;
  if (!x) return null;
  return `効くのは${x.label} (${x.skillName}) の${ELEMENT_LABEL[x.elementType] || x.elementType}の分だけです`;
}

/**
 * 表から外したスキルの一覧の後ろに足す文: 外したもののうち、別のスキル (火竜の力) をつけると追加ダメージに効くようになるもの。
 * 無ければ空文字。otherElement = skillTableCandidates(...).otherElement
 */
export function otherElementExtraText(otherElement) {
  const bySource = new Map();
  for (const s of otherElement || []) {
    if (!s.extraIfAdded) continue;
    const k = s.extraIfAdded.skillId;
    if (!bySource.has(k)) bySource.set(k, { src: s.extraIfAdded, names: [] });
    bySource.get(k).names.push(s.name);
  }
  return [...bySource.values()].map(({ src, names }) => `${names.join('・')}は、${src.skillName}をつけると表に出ます。`
    + `${src.label}の${ELEMENT_LABEL[src.elementType] || src.elementType}の分に効くためです。`).join('');
}

/**
 * スキル火力表の計算の下ごしらえ (行ごとに使い回す値)。
 * @returns {{skills: Array, baseTotal: number}}  baseTotal = いまの装備のままの期待値
 */
export function tableContext(input, targets) {
  const skills = normalizeSkills(input.skills);
  return { skills, baseTotal: mixTotal(inputFor(input, skills), targets) };
}

/**
 * 同時に起きない条件 (体力満タン ↔ 赤ゲージ など) の合計が 100% を超えて、どれかを減らして計算することになるか。
 * なるならその警告の文 (damage.js の exclusive-conflict)、ならなければ null。期待値は計算しない (軽い)。
 */
export function exclusiveConflict(input, skills) {
  const list = normalizeSkills(skills);
  const res = resolveSkills(list, input.effects);
  const src = (input.effects && input.effects.rules && input.effects.rules.conditionGroups) || [];
  const cond = resolveConditions(res.active, src, input.uptimes,
    { skillIds: list.map((s) => s.skillId), monsterStatus: input.monsterStatus });
  if (!cond.groups.some((g) => g.exclusiveWith.length)) return null;
  // 同時に起きない条件の塊ごとに数え上げる (全体を並べると条件が多いとき MAX_PATTERNS を超えるため。警告は同じ)
  const w = factorPatterns(cond.groups).warnings.find((x) => x.code === 'exclusive-conflict');
  return w ? w.message : null;
}

/**
 * スキル火力表の 1 行。いまの装備から「そのスキルだけ」Lv0〜最大 Lv に変えたときの期待値を出す。
 * @param {object} input comboExpected と同じ (target は targets で渡す)
 * @param {Array} targets 狙う部位
 * @param {object} cand skillTableCandidates(...).rows の 1 件
 * @param {object} ctx tableContext(...) の結果
 * @returns 行 {…cand, currentLevel, rawLevel, zeroTotal, levels: [{level, total, vsZeroPct, nextPct}],
 *   nextFromCurrentPct, maxPct, requiresMissing, conflict}
 *   vsZeroPct = Lv0 (そのスキルが無いとき) 比の上昇 (%)。nextPct = 次の Lv に上げたときの上昇 (%)。最大 Lv では null
 *   conflict = このスキルを付けると、同時に起きない条件の合計が 100% を超える (exclusiveConflict の文) か null
 */
export function skillTableRow(input, targets, cand, ctx) {
  const skills = ctx.skills;
  const cur = skills.find((s) => s.skillId === cand.skillId);
  const others = cur ? skills.filter((s) => s.skillId !== cand.skillId) : skills;
  const zero = cur ? mixTotal(inputFor(input, others), targets) : ctx.baseTotal;
  const totals = [zero];
  for (let lv = 1; lv <= cand.maxLevel; lv++) {
    if (cur && cur.level === lv) totals.push(ctx.baseTotal);
    else totals.push(mixTotal(inputFor(input, [...others, { skillId: cand.skillId, level: lv }]), targets));
  }
  const levels = totals.map((t, lv) => ({
    level: lv, total: t, vsZeroPct: pct(t, zero),
    nextPct: lv < cand.maxLevel ? pct(totals[lv + 1], t) : null,
  }));
  const currentLevel = cur ? Math.min(cur.level, cand.maxLevel) : 0;
  return {
    ...cand, currentLevel, rawLevel: cur ? cur.level : 0, zeroTotal: zero, levels,
    nextFromCurrentPct: levels[currentLevel].nextPct,
    maxPct: levels[cand.maxLevel].vsZeroPct,
    requiresMissing: cand.requiresSkillId != null && !skills.some((s) => s.skillId === Number(cand.requiresSkillId)),
    conflict: cand.conditional ? exclusiveConflict(input, [...others, { skillId: cand.skillId, level: cand.maxLevel }]) : null,
  };
}

/** スキル火力表を一度に作る (テスト・小さい画面以外用。画面は skillTableRow を少しずつ呼ぶ)。 */
export function skillTable(input, targets, weapon) {
  const cands = skillTableCandidates(input.effects, weapon, { handicraft: input.handicraft, skills: input.skills });
  const ctx = tableContext(input, targets);
  return { ...cands, rows: cands.rows.map((c) => skillTableRow(input, targets, c, ctx)), baseTotal: ctx.baseTotal };
}

/** 並べ替え。by: 'next' (いまの Lv から 1 つ上げたときの伸び) | 'max' (最大 Lv の効果) | 'name' */
export function sortTableRows(rows, by = 'next') {
  const list = [...rows];
  const nextKey = (r) => (r.nextFromCurrentPct == null ? -Infinity : r.nextFromCurrentPct);
  if (by === 'max') list.sort((a, b) => b.maxPct - a.maxPct || nextKey(b) - nextKey(a));
  else if (by === 'name') list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ja'));
  else list.sort((a, b) => nextKey(b) - nextKey(a) || b.maxPct - a.maxPct);
  return list;
}

// ---------------------------------------------------------------- 発動率の入力

/** 効果 (levels[] の 1 件か byState の 1 件) が何か効くか (加算 0・乗算 1・null だけなら効かない) */
function hasEffect(fx) {
  if (!fx || typeof fx !== 'object') return false;
  for (const [k, v] of Object.entries(fx)) {
    if (k === 'level' || k === 'byState' || k === 'confidence' || k === 'note' || k === 'elementType') continue;
    if (k === 'extraDamage') { if (v) return true; continue; }
    if (typeof v !== 'number') continue;
    if (/Mul$/.test(k) ? v !== 1 : v !== 0) return true;
  }
  return false;
}

/**
 * そのスキルが効く段 (主効果の activeStates と、効果のある byState の段)。主効果の段を先に。
 * @param entry skill_effects.json の効果の 1 件
 * @param def conditionGroupDefs の値
 */
export function effectiveStates(entry, def) {
  if (!def) return [];
  if (def.type === 'binary') return ['on'];
  const nonOff = def.states.map((s) => s.id).filter((s) => s !== def.offState);
  const main = entry && Array.isArray(entry.activeStates) && entry.activeStates.length ? entry.activeStates : nonOff;
  const out = [...main];
  for (const lv of (entry && entry.levels) || []) {
    for (const [s, fx] of Object.entries(lv.byState || {})) if (!out.includes(s) && hasEffect(fx)) out.push(s);
  }
  return out.filter((s) => nonOff.includes(s));
}

/**
 * 条件グループの id → 画面用の短い説明。スキル火力表で「このスキルは どの条件で・何 % で計算したか」を出すのに使う
 * (装備していないスキルの条件は comboExpected の conditions に出ないため)。
 * @param {object} [opts] {entry: そのスキルの効果 (効く段だけを数える), skillIds: 装備のスキル id の配列,
 *   monsterStatus: 相手が使う状態異常 (条件のもとの確かめ。damage.js の monsterStatus と同じ)}
 * @returns {null | {id, label, type, placeholder, on, parts: [{id, label, p}], inactive, needs}}
 *   on = そのスキルが効く段の割合の合計 (entry が無ければ未発動以外の全部)。parts = 段ごとの割合 (categorical だけ)。
 *   inactive = 条件のもとが無いので 0% で計算している。needs = そのとき要るもの (data の sources.label)
 */
export function conditionSummary(effects, uptimes, groupId, opts = {}) {
  if (!groupId) return null;
  const def = conditionGroupDefs(effects).get(groupId);
  if (!def) return null;
  const input = uptimes && typeof uptimes === 'object' ? uptimes : {};
  let has = Object.prototype.hasOwnProperty.call(input, groupId) && input[groupId] != null;
  let raw = has ? input[groupId] : undefined;
  const nonOff = def.states.map((s) => s.id).filter((s) => s !== def.offState);
  if (!has && def.type === 'categorical') {
    // 数だけの入れ物向けの平らなキー "<グループ id>.<段 id>"
    const flat = {};
    for (const s of nonOff) if (input[`${groupId}.${s}`] != null) flat[s] = input[`${groupId}.${s}`];
    if (Object.keys(flat).length) { raw = flat; has = true; }
  }
  if (!has) raw = def.defaultUptime;
  const skillIds = new Set((opts.skillIds || []).map(Number));
  const inactive = opts.skillIds ? conditionSourceMissing(def, skillIds, opts.monsterStatus) : false;
  const base = {
    id: groupId, label: def.label, type: def.type, placeholder: !inactive && !has && def.placeholder,
    inactive, needs: inactive && def.sources ? def.sources.label : '',
  };
  if (inactive) return { ...base, on: 0, parts: [] };
  const clamp = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  if (def.type === 'binary') {
    return { ...base, on: clamp(typeof raw === 'boolean' ? (raw ? 1 : 0) : raw), parts: [] };
  }
  const probs = {};
  let sum = 0;
  for (const s of nonOff) {
    probs[s] = raw && typeof raw === 'object' ? clamp(raw[s]) : 0;
    sum += probs[s];
  }
  if (sum > 1) for (const s of nonOff) probs[s] /= sum; // damage.js と同じく合計 100% に縮める
  const states = opts.entry ? effectiveStates(opts.entry, def) : nonOff;
  const label = (id) => (def.states.find((x) => x.id === id) || {}).label || id;
  const parts = states.map((s) => ({ id: s, label: label(s), p: probs[s] || 0 }));
  return { ...base, on: Math.min(1, parts.reduce((t, x) => t + x.p, 0)), parts };
}

/**
 * categorical のグループで 1 つの段を x にしたときの新しい {段 id: 割合}。
 * 合計が 100% を超える分は、後ろの段から減らして収める (未発動の段は残り)。値は 0.01 刻みに丸める。
 * @param {object} group comboExpected(...).conditions の 1 件
 */
export function rebalanceCategorical(group, stateId, x) {
  const r2 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;
  const v = r2(Number(x) || 0);
  const ids = group.states.map((s) => s.id).filter((id) => id !== group.offState);
  const others = ids.filter((id) => id !== stateId);
  const vals = others.map((id) => (group.probs && group.probs[id]) || 0);
  const room = Math.max(0, 1 - v);
  let sum = vals.reduce((a, b) => a + b, 0);
  for (let k = vals.length - 1; k >= 0 && sum > room + 1e-9; k--) {
    const cut = Math.min(vals[k], sum - room);
    vals[k] -= cut;
    sum -= cut;
  }
  const out = { [stateId]: v };
  others.forEach((id, k) => { out[id] = r2(vals[k]); });
  return out;
}
