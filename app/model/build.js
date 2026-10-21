// 装備一式 → スキル合計・シリーズ/グループ発動・スロットの使用状況 (純粋関数)。
// ブラウザでも node でも動く ES module。DOM にも node 専用モジュールにも触らない。
// データの形は docs/ARCHITECTURE.md の「データの形 (契約)」、使い方は docs/MODEL_API.md の「build.js」節。

/** 防具の部位 (data/armor.json の part) */
export const ARMOR_PARTS = ['head', 'chest', 'arms', 'waist', 'legs'];

/** 装飾品を入れる先。charmArmor/charmWeapon は護石の防具用/武器用スロット */
export const DECO_TARGETS = ['weapon', ...ARMOR_PARTS, 'charmArmor', 'charmWeapon'];

/** 入れ先 → 入れられる装飾品の種類 (decorations.json の kind) */
export function targetKind(target) {
  return target === 'weapon' || target === 'charmWeapon' ? 'weapon' : 'armor';
}

const KIND_LABEL = { weapon: '武器用', armor: '防具用' };
const TARGET_LABEL = {
  weapon: '武器', head: '頭', chest: '胴', arms: '腕', waist: '腰', legs: '脚',
  charmArmor: '護石 (防具用スロット)', charmWeapon: '護石 (武器用スロット)', charm: '護石',
};

// data/*.json はファイル丸ごと ({meta, skills: [...]}) でも配列でも受け取る
function listOf(x, key) {
  if (x == null) return [];
  if (Array.isArray(x)) return x;
  return Array.isArray(x[key]) ? x[key] : [];
}

function byId(list) {
  const m = new Map();
  for (const e of list) m.set(e.id, e);
  return m;
}

/**
 * データの索引を作る。computeBuild に何度も渡すなら先に作って使い回すと速い。
 * @param {object} data { skills, decorations, bonuses, armor?, weapons?, myWeapons?, charms?, charmsFixed? }
 *   それぞれ data/*.json の中身 (ファイル丸ごと) か配列。bonuses は bonuses.json 丸ごと。
 */
export function indexEquipData(data = {}) {
  if (data && data.__equipIndex) return data;
  const bonuses = data.bonuses || {};
  return {
    __equipIndex: true,
    skills: byId(listOf(data.skills, 'skills')),
    decorations: byId(listOf(data.decorations, 'decorations')),
    setBonuses: byId(listOf(bonuses.setBonuses, 'setBonuses')),
    groupBonuses: byId(listOf(bonuses.groupBonuses, 'groupBonuses')),
    armor: byId(listOf(data.armor, 'armor')),
    weapons: byId(listOf(data.weapons, 'weapons')),
    myWeapons: byId(listOf(data.myWeapons, 'weapons')),
    charms: byId(listOf(data.charms, 'charms')),
    charmsFixed: byId(listOf(data.charmsFixed, 'charms')),
  };
}

/** スロット配列を長さ n にそろえる (足りない分は 0)。null は全部 0。 */
function padSlots(slots, n) {
  const out = Array.isArray(slots) ? slots.map((v) => Number(v) || 0) : [];
  while (out.length < n) out.push(0);
  return out;
}

/**
 * 装飾品 deco を、種類 kind (weapon|armor) で Lv slotSize のスロットに入れられるか。
 * 入れられるなら null、入れられないなら理由のコードを返す。低 Lv の珠は高 Lv スロットに入る。
 */
export function decorationFitError(deco, kind, slotSize) {
  if (!slotSize) return 'slot-missing';
  if (deco.kind !== kind) return 'deco-kind-mismatch';
  if (deco.slot > slotSize) return 'deco-too-large';
  return null;
}

function resolveWeapon(ref, idx, errors) {
  if (ref == null) return null;
  if (typeof ref === 'object') return ref;
  if (typeof ref === 'number') {
    const w = idx.weapons.get(ref);
    if (!w) errors.push({ code: 'unknown-weapon', message: `武器 id ${ref} が weapons_sns.json に無い`, target: 'weapon' });
    return w || null;
  }
  const w = idx.myWeapons.get(ref);
  if (!w) {
    errors.push({ code: 'unknown-weapon', message: `武器 id ${ref} が my_weapons.json に無い`, target: 'weapon' });
    return null;
  }
  // 所持アーティア武器: 足りない項目は元の武器 (baseWeaponId) から補う
  const base = w.baseWeaponId != null ? idx.weapons.get(w.baseWeaponId) : null;
  return {
    ...w,
    slots: w.slots ?? base?.slots ?? [0, 0, 0],
    skills: w.skills ?? base?.skills ?? [],
  };
}

function resolveArmor(part, ref, idx, errors) {
  if (ref == null) return null;
  const a = typeof ref === 'object' ? ref : idx.armor.get(ref);
  if (!a) {
    errors.push({ code: 'unknown-armor', message: `防具 id ${ref} が armor.json に無い`, target: part });
    return null;
  }
  if (a.part && a.part !== part) {
    errors.push({
      code: 'armor-part-mismatch',
      message: `${a.name} は ${TARGET_LABEL[a.part] || a.part} の防具 (${TARGET_LABEL[part]} に指定された)`,
      target: part, armorId: a.id,
    });
    return null;
  }
  return a;
}

function resolveCharm(ref, idx, errors) {
  if (ref == null) return null;
  if (typeof ref === 'object') return ref;
  const c = typeof ref === 'number' ? idx.charmsFixed.get(ref) : idx.charms.get(ref);
  if (!c) errors.push({ code: 'unknown-charm', message: `護石 id ${ref} が見つからない`, target: 'charm' });
  return c || null;
}

/**
 * 装備一式を計算する。
 * @param {object} build
 *   - weapon: weapons_sns.json の要素 / my_weapons.json の要素 / その id (数値=weapons_sns, 文字列=my_weapons) / null
 *   - armor: { head, chest, arms, waist, legs } それぞれ armor.json の要素か id か null
 *   - charm: charms.json の要素 / charms_fixed.json の要素 / id (文字列=charms, 数値=charms_fixed) / null
 *   - decorations: { weapon: [..], head: [..], ..., charmArmor: [..], charmWeapon: [..] }
 *       配列の i 番目 = その装備の i 番目のスロットに入れる装飾品 (id か要素)。空きは null。
 * @param {object} data indexEquipData の結果、または indexEquipData に渡すのと同じもの
 * @returns {object} { ok, errors, warnings, skills, skillLevels, setBonuses, groupBonuses, slots, slotSummary }
 */
export function computeBuild(build = {}, data = {}) {
  const idx = indexEquipData(data);
  const errors = [];
  const warnings = [];

  const weapon = resolveWeapon(build.weapon, idx, errors);
  const armor = {};
  for (const p of ARMOR_PARTS) armor[p] = resolveArmor(p, build.armor?.[p], idx, errors);
  const charm = resolveCharm(build.charm, idx, errors);

  // ---- スキルを集める
  const acc = new Map(); // skillId -> { rawLevel, sources }
  const add = (skillId, level, source) => {
    if (!level) return;
    let e = acc.get(skillId);
    if (!e) acc.set(skillId, (e = { rawLevel: 0, sources: [] }));
    e.rawLevel += level;
    e.sources.push({ ...source, level });
  };
  const addSkills = (list, source) => {
    for (const s of list || []) add(s.skillId, s.level, source);
  };

  if (weapon) addSkills(weapon.skills, { target: 'weapon', via: 'equipment' });
  for (const p of ARMOR_PARTS) if (armor[p]) addSkills(armor[p].skills, { target: p, via: 'equipment' });
  if (charm) addSkills(charm.skills, { target: 'charm', via: 'equipment' });

  // ---- スロットと装飾品
  const charmIsFixed = charm && !('armorSlots' in charm) && !('weaponSlots' in charm);
  const slotSizes = {
    weapon: weapon ? padSlots(weapon.slots, 3) : [],
    charmArmor: charm && !charmIsFixed ? padSlots(charm.armorSlots, 3) : [],
    charmWeapon: charm && !charmIsFixed ? padSlots(charm.weaponSlots, 1) : [],
  };
  for (const p of ARMOR_PARTS) slotSizes[p] = armor[p] ? padSlots(armor[p].slots, 3) : [];
  const present = {
    weapon: !!weapon, charmArmor: !!charm, charmWeapon: !!charm,
    ...Object.fromEntries(ARMOR_PARTS.map((p) => [p, !!armor[p]])),
  };

  const slots = {};
  for (const t of DECO_TARGETS) {
    slots[t] = slotSizes[t].map((size, index) => ({ index, size, decorationId: null }));
  }

  const assigned = build.decorations || {};
  for (const target of Object.keys(assigned)) {
    if (!DECO_TARGETS.includes(target)) {
      errors.push({ code: 'unknown-target', message: `装飾品の入れ先 ${target} は無い`, target });
      continue;
    }
    const kind = targetKind(target);
    const list = assigned[target] || [];
    list.forEach((ref, index) => {
      if (ref == null) return;
      const deco = typeof ref === 'object' ? ref : idx.decorations.get(ref);
      const where = { target, index };
      if (!deco) {
        errors.push({ code: 'unknown-decoration', message: `装飾品 id ${ref} が decorations.json に無い`, ...where });
        return;
      }
      where.decorationId = deco.id;
      if (!present[target]) {
        errors.push({
          code: 'no-equipment',
          message: `${TARGET_LABEL[target]} に装備が無いので ${deco.name} を入れられない`, ...where,
        });
        return;
      }
      const size = slotSizes[target][index] || 0;
      const why = decorationFitError(deco, kind, size);
      if (why === 'slot-missing') {
        errors.push({
          code: why, message: `${TARGET_LABEL[target]} の ${index + 1} 番目のスロットが無い (${deco.name})`, ...where,
        });
        return;
      }
      if (why === 'deco-kind-mismatch') {
        errors.push({
          code: why,
          message: `${deco.name} は${KIND_LABEL[deco.kind]}の装飾品。${TARGET_LABEL[target]} (${KIND_LABEL[kind]}スロット) には入らない`,
          ...where,
        });
        return;
      }
      if (why === 'deco-too-large') {
        errors.push({
          code: why,
          message: `${deco.name} (Lv${deco.slot}) は ${TARGET_LABEL[target]} の ${index + 1} 番目のスロット (Lv${size}) に入らない`,
          ...where,
        });
        return;
      }
      slots[target][index].decorationId = deco.id;
      slots[target][index].decorationName = deco.name;
      slots[target][index].decorationSize = deco.slot;
      addSkills(deco.skills, { target, index, via: 'decoration', decorationId: deco.id });
    });
  }

  // ---- シリーズスキル・グループスキル (巨戟アーティアの武器は 1 部位として数える)
  const setCount = new Map();
  const groupCount = new Map();
  const count = (m, id, from) => {
    if (id == null) return;
    let e = m.get(id);
    if (!e) m.set(id, (e = { pieces: 0, from: [] }));
    e.pieces += 1;
    e.from.push(from);
  };
  const setIdsOf = (x) => {
    const ids = Array.isArray(x.setBonusIds) ? x.setBonusIds : x.setBonusId != null ? [x.setBonusId] : [];
    return [...new Set(ids)];
  };
  for (const p of ARMOR_PARTS) {
    if (!armor[p]) continue;
    for (const id of setIdsOf(armor[p])) count(setCount, id, p);
    count(groupCount, armor[p].groupBonusId, p);
  }
  if (weapon) {
    for (const id of setIdsOf(weapon)) count(setCount, id, 'weapon');
    count(groupCount, weapon.groupBonusId, 'weapon');
  }

  const setBonuses = [];
  for (const [bonusId, c] of [...setCount].sort((a, b) => a[0] - b[0])) {
    const b = idx.setBonuses.get(bonusId);
    if (!b) {
      warnings.push({ code: 'unknown-set-bonus', message: `シリーズスキル id ${bonusId} が bonuses.json に無い`, bonusId });
      continue;
    }
    const ranks = [...(b.ranks || [])].sort((x, y) => x.pieces - y.pieces);
    let level = 0;
    for (const r of ranks) if (c.pieces >= r.pieces) level = Math.max(level, r.level);
    const next = ranks.find((r) => r.pieces > c.pieces) || null;
    setBonuses.push({
      bonusId, name: b.name, skillId: b.skillId, pieces: c.pieces, from: c.from, level, active: level > 0,
      ranks, next: next ? { pieces: next.pieces, level: next.level } : null,
    });
    if (level > 0) add(b.skillId, level, { target: 'set', via: 'set', bonusId, pieces: c.pieces });
  }
  const groupBonuses = [];
  for (const [bonusId, c] of [...groupCount].sort((a, b) => a[0] - b[0])) {
    const b = idx.groupBonuses.get(bonusId);
    if (!b) {
      warnings.push({ code: 'unknown-group-bonus', message: `グループスキル id ${bonusId} が bonuses.json に無い`, bonusId });
      continue;
    }
    const required = b.pieces ?? 3;
    const active = c.pieces >= required;
    const level = active ? b.level ?? 1 : 0;
    groupBonuses.push({ bonusId, name: b.name, skillId: b.skillId, pieces: c.pieces, from: c.from, required, active, level });
    if (active) add(b.skillId, level, { target: 'group', via: 'group', bonusId, pieces: c.pieces });
  }

  // ---- スキル合計 (上限 Lv で切る)
  const skills = [];
  const skillLevels = {};
  for (const [skillId, e] of acc) {
    const s = idx.skills.get(skillId);
    if (!s) {
      warnings.push({ code: 'unknown-skill', message: `スキル id ${skillId} が skills.json に無い`, skillId });
    }
    const maxLevel = s ? s.maxLevel : null;
    const level = maxLevel != null ? Math.min(e.rawLevel, maxLevel) : e.rawLevel;
    skills.push({
      skillId, name: s ? s.name : `不明なスキル (${skillId})`, kind: s ? s.kind : null,
      level, rawLevel: e.rawLevel, maxLevel, overLimit: maxLevel != null && e.rawLevel > maxLevel,
      sources: e.sources,
    });
    skillLevels[skillId] = level;
  }
  skills.sort((a, b) => b.level - a.level || a.skillId - b.skillId);

  // ---- スロットの集計 (武器用 = 武器 + 護石の武器用、防具用 = 防具5部位 + 護石の防具用)
  const slotSummary = { weapon: emptySummary(), armor: emptySummary() };
  for (const t of DECO_TARGETS) {
    const sum = slotSummary[targetKind(t)];
    for (const s of slots[t]) {
      if (!s.size) continue;
      sum.total += 1;
      if (s.decorationId != null) sum.used += 1;
      else {
        sum.free += 1;
        sum.freeBySize[s.size] = (sum.freeBySize[s.size] || 0) + 1;
      }
    }
  }

  return {
    ok: errors.length === 0, errors, warnings,
    skills, skillLevels, setBonuses, groupBonuses, slots, slotSummary,
  };
}

function emptySummary() {
  return { total: 0, used: 0, free: 0, freeBySize: { 1: 0, 2: 0, 3: 0 } };
}
