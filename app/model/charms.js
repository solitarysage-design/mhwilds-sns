// 護石の検証・泣シミュ (mhwilds.wiki-db.com/sim) 形式の書き出し/読み込み (純粋関数)。
// ブラウザでも node でも動く ES module。DOM にも node 専用モジュールにも触らない。
//
// 鑑定護石 (未解/史伝/秘歴/栄世の護石) は data/talisman_rules.json の抽選表で検証する。
// 固定護石 (〇〇の護石Ⅰ〜Ⅲ など、生産する護石) は data/charms_fixed.json と照らすだけ。
// 泣シミュの護石 1 行は 12 項目: スキル1,Lv1,スキル2,Lv2,スキル3,Lv3,防具スロLv×3,武器スロLv×3
// (空きスキルは名前が空で Lv 0。泣シミュ自身の書き出しと同じ)

export const NAKISIM_FIELD_COUNT = 12;

const KIND_LABEL = { weapon: '武器スキル', armor: '防具スキル', set: 'シリーズスキル', group: 'グループスキル' };

function listOf(x, key) {
  if (x == null) return [];
  if (Array.isArray(x)) return x;
  return Array.isArray(x[key]) ? x[key] : [];
}

function skillMap(skills) {
  if (skills instanceof Map) return skills;
  const m = new Map();
  for (const s of listOf(skills, 'skills')) m.set(s.id, s);
  return m;
}

/** 全角/半角の揺れを吸収した比較用の名前 */
function normName(s) {
  return String(s ?? '').normalize('NFKC').replace(/\s+/g, '');
}

/** スキル名 (日本語) → skills.json の要素。完全一致を優先し、無ければ全角/半角の揺れを吸収して探す。 */
export function findSkillByName(name, skills) {
  const list = [...skillMap(skills).values()];
  const exact = list.find((s) => s.name === name);
  if (exact) return exact;
  const n = normName(name);
  if (!n) return null;
  return list.find((s) => normName(s.name) === n) || null;
}

/** スロットを大きい順に並べ、長さ n にそろえる (足りなければ 0 を足す。多い分の 0 は削る)。 */
export function normalizeSlots(slots, n) {
  const vals = (Array.isArray(slots) ? slots : []).map((v) => Number(v));
  const nz = vals.filter((v) => v !== 0).sort((a, b) => b - a);
  const out = [...nz];
  while (out.length < n) out.push(0);
  return out;
}

function sameArr(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** 固定護石なら charms_fixed.json の要素を返す (charm.fixedId か名前で判定)。鑑定護石なら null。 */
export function fixedCharmOf(charm, charmsFixed) {
  const list = listOf(charmsFixed, 'charms');
  if (!charm || !list.length) return null;
  if (charm.fixedId != null) return list.find((c) => c.id === charm.fixedId) || null;
  if (charm.name) return list.find((c) => c.name === charm.name) || null;
  return null;
}

/** 'random' (鑑定護石) か 'fixed' (固定護石) か */
export function charmKind(charm, charmsFixed) {
  return fixedCharmOf(charm, charmsFixed) || (charm && charm.fixedId != null) ? 'fixed' : 'random';
}

// ---------------------------------------------------------------- 抽選表との照合

function groupTable(rules) {
  const m = new Map();
  for (const [g, list] of Object.entries(rules.groups || {})) {
    m.set(Number(g), new Map(list.map((e) => [e.skillId, e.level])));
  }
  return m;
}

function permutations(arr, k) {
  if (k === 0) return [[]];
  const out = [];
  arr.forEach((v, i) => {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest, k - 1)) out.push([v, ...p]);
  });
  return out;
}

/**
 * 1 行 (pattern) に charm のスキルが当てはまるか。
 * スキル数は行の枠数 (0 でない群の数) と同じでなければならない (枠ごとに必ず 1 つ抽選されるため)。
 * 返り値: null (当てはまらない) か { exact, assignment } 。
 * exact = Lv も表の Lv と同じ。そうでなければ Lv が表の Lv 以下 (表の Lv を上限として扱う)。
 */
function matchPattern(cs, pattern, groups) {
  const posIdx = pattern.skillGroups.map((g, i) => (g ? i : -1)).filter((i) => i >= 0);
  if (cs.length !== posIdx.length) return null;
  let best = null;
  for (const perm of permutations(posIdx, cs.length)) {
    let ok = true;
    let exact = true;
    for (let k = 0; k < cs.length; k++) {
      const g = pattern.skillGroups[perm[k]];
      const lv = groups.get(g)?.get(cs[k].skillId);
      if (lv == null || cs[k].level > lv) {
        ok = false;
        break;
      }
      if (cs[k].level !== lv) exact = false;
    }
    if (!ok) continue;
    const m = { exact, assignment: perm };
    if (exact) return m;
    best = best || m;
  }
  return best;
}

function kindsFit(cs, pattern, rules) {
  const avail = { weapon: 0, armor: 0 };
  for (const g of pattern.skillGroups) if (g) avail[rules.groupKinds[String(g)]] += 1;
  const need = { weapon: 0, armor: 0 };
  for (const s of cs) need[s.kind] = (need[s.kind] || 0) + 1;
  return need.weapon === avail.weapon && need.armor === avail.armor;
}

/**
 * 護石を検証する。
 * @param {object} charm charms.json の要素 ({ name, rarity, skills: [{skillId, level}], armorSlots, weaponSlots })
 * @param {object} rules talisman_rules.json (ファイル丸ごと)
 * @param {object|Array|Map} skills skills.json (ファイル丸ごと) / その skills 配列 / id→要素の Map
 * @param {object} [opts] { charmsFixed: charms_fixed.json } 固定護石の判定に使う
 * @returns {{ok:boolean, kind:'random'|'fixed', errors:Array, warnings:Array, matches:Array}}
 *   errors/warnings の各要素は { code, message, skillIndex? }。matches は当てはまった抽選表の行。
 */
export function validateCharm(charm, rules, skills, opts = {}) {
  const errors = [];
  const warnings = [];
  const sk = skillMap(skills);
  const err = (code, message, extra = {}) => errors.push({ code, message, ...extra });
  const warn = (code, message, extra = {}) => warnings.push({ code, message, ...extra });

  if (!charm || typeof charm !== 'object') {
    err('charm-invalid', '護石のデータが無い');
    return { ok: false, kind: 'random', errors, warnings, matches: [] };
  }

  // ---- スキルの解決 (skillId が無ければ名前で探す)
  const cs = [];
  (charm.skills || []).forEach((s, i) => {
    let def = s.skillId != null ? sk.get(s.skillId) : null;
    if (!def && s.skillId == null && s.name) def = findSkillByName(s.name, sk);
    if (!def) {
      err('skill-unknown', `スキル ${s.name ?? ''} (id ${s.skillId ?? 'なし'}) が skills.json に無い`, { skillIndex: i });
      return;
    }
    if (s.name && normName(s.name) !== normName(def.name)) {
      warn('skill-name-mismatch', `スキル名「${s.name}」と skillId ${def.id} (${def.name}) が食い違う`, { skillIndex: i });
    }
    const level = Number(s.level);
    if (!Number.isInteger(level) || level < 1) {
      err('level-invalid', `${def.name} の Lv が正しくない (${s.level})`, { skillIndex: i });
      return;
    }
    cs.push({ index: i, skillId: def.id, name: def.name, kind: def.kind, level, maxLevel: def.maxLevel });
  });

  // ---- 固定護石
  const fixed = fixedCharmOf(charm, opts.charmsFixed);
  if (fixed || charm.fixedId != null) {
    if (!fixed) {
      err('fixed-unknown', `固定護石 id ${charm.fixedId} が charms_fixed.json に無い`);
      return { ok: false, kind: 'fixed', errors, warnings, matches: [] };
    }
    const want = [...fixed.skills].map((s) => `${s.skillId}:${s.level}`).sort();
    const got = cs.map((s) => `${s.skillId}:${s.level}`).sort();
    if (!sameArr(want, got)) err('fixed-skills-mismatch', `${fixed.name} のスキルと違う`);
    if (charm.rarity != null && Number(charm.rarity) !== fixed.rarity) {
      err('fixed-rarity-mismatch', `${fixed.name} はレア${fixed.rarity} (入力はレア${charm.rarity})`);
    }
    const anySlot = [...(charm.armorSlots || []), ...(charm.weaponSlots || [])].some((v) => Number(v) > 0);
    if (anySlot) err('fixed-has-slots', `${fixed.name} (固定護石) にスロットは付かない`);
    return { ok: errors.length === 0, kind: 'fixed', errors, warnings, matches: [] };
  }

  // ---- 鑑定護石: レア度
  const rarityKey = String(charm.rarity);
  const rr = rules?.rarities?.[rarityKey];
  const allNames = Object.entries(rules?.rarities || {}).map(([k, v]) => [Number(k), v.name]);
  if (!rr) {
    const avail = allNames.map(([k, n]) => `レア${k} ${n}`).join(' / ');
    err('rarity-unknown', `レア${charm.rarity ?? '?'} の鑑定護石は抽選表に無い (あるのは ${avail})`);
  }
  if (charm.name) {
    const hit = allNames.find(([, n]) => n === charm.name);
    if (hit && rr && hit[0] !== Number(charm.rarity)) {
      err('name-rarity-mismatch', `${charm.name} はレア${hit[0]} の名前 (入力はレア${charm.rarity})`);
    } else if (!hit) {
      warn('name-unknown', `名前「${charm.name}」は鑑定護石の名前 (${allNames.map((x) => x[1]).join('/')}) でも固定護石でもない`);
    }
  }

  // ---- スロット
  const rawArmor = Array.isArray(charm.armorSlots) ? charm.armorSlots : [];
  const rawWeapon = Array.isArray(charm.weaponSlots) ? charm.weaponSlots : [];
  const badSlot = [...rawArmor, ...rawWeapon].some((v) => !Number.isInteger(Number(v)) || Number(v) < 0 || Number(v) > 3);
  const armorSlots = normalizeSlots(rawArmor, 3);
  const weaponSlots = normalizeSlots(rawWeapon, 1);
  let slotsOk = !badSlot && armorSlots.length === 3 && weaponSlots.length === 1;
  if (badSlot) err('slot-invalid', `スロット Lv は 0〜3 の整数 (防具用 ${JSON.stringify(rawArmor)} / 武器用 ${JSON.stringify(rawWeapon)})`);
  else if (armorSlots.length > 3 || weaponSlots.length > 1) {
    err('slot-invalid', `スロットが多すぎる (防具用は最大 3 つ・武器用は最大 1 つ)`);
  }
  let slotPatterns = [];
  if (rr && slotsOk) {
    slotPatterns = rr.patterns.filter((p) => sameArr(p.armor, armorSlots) && sameArr(p.weapon, weaponSlots));
    if (!slotPatterns.length) {
      slotsOk = false;
      const possible = rr.slotPatterns.map((p) => `防具[${p.armor}] 武器[${p.weapon}]`).join(' / ');
      err('slots-not-possible',
        `レア${rarityKey} (${rr.name}) に 防具用[${armorSlots}] 武器用[${weaponSlots}] のスロットは付かない (付くのは ${possible})`);
    }
  }

  // ---- スキルごとの検査
  if (rr) {
    if ((charm.skills || []).length > rr.maxSkills) {
      err('too-many-skills', `レア${rarityKey} のスキルは最大 ${rr.maxSkills} 個 (入力は ${(charm.skills || []).length} 個)`);
    }
    if ((charm.skills || []).length < rr.minSkills) {
      err('too-few-skills', `レア${rarityKey} のスキルは最低 ${rr.minSkills} 個 (入力は ${(charm.skills || []).length} 個)`);
    }
  }
  const seen = new Set();
  for (const s of cs) {
    if (seen.has(s.skillId)) warn('duplicate-skill', `${s.name} が 2 回ある (読み違いの可能性)`, { skillIndex: s.index });
    seen.add(s.skillId);
    if (s.kind !== 'weapon' && s.kind !== 'armor') {
      err('skill-kind-invalid', `${s.name} は${KIND_LABEL[s.kind] || s.kind}。護石には付かない`, { skillIndex: s.index });
      continue;
    }
    if (s.level > s.maxLevel) {
      err('level-over-max', `${s.name} の最大 Lv は ${s.maxLevel} (入力は Lv${s.level})`, { skillIndex: s.index });
      continue;
    }
    if (!rr) continue;
    const poolMax = rr.skillMaxLevel?.[String(s.skillId)];
    if (poolMax == null) {
      err('skill-not-in-pool', `${s.name} はレア${rarityKey} (${rr.name}) の抽選表に無い`, { skillIndex: s.index });
    } else if (s.level > poolMax) {
      err('level-over-pool-max', `${s.name} はレア${rarityKey} では Lv${poolMax} まで (入力は Lv${s.level})`, { skillIndex: s.index });
    }
  }

  // ---- 組み合わせ (抽選表の行に当てはまるか。スキルの並び順は問わない)
  const matches = [];
  if (rr && errors.length === 0) {
    const groups = groupTable(rules);
    for (const p of slotPatterns) {
      const m = matchPattern(cs, p, groups);
      if (m) matches.push({ slotPt: p.slotPt, skillGroups: p.skillGroups, weight: p.weight, exact: m.exact, assignment: m.assignment });
    }
    if (!matches.length) {
      const kindOk = slotPatterns.some((p) => kindsFit(cs, p, rules));
      const otherSlots = rr.patterns.some((p) => !slotPatterns.includes(p) && matchPattern(cs, p, groups));
      const kinds = `武器スキル ${cs.filter((s) => s.kind === 'weapon').length} 個・防具スキル ${cs.filter((s) => s.kind === 'armor').length} 個`;
      if (otherSlots) {
        err('slots-skill-combination', `このスキルの組み合わせは、レア${rarityKey} では別のスロット構成でしか出ない`);
      } else if (!kindOk) {
        err('skill-kind-position', `${kinds} の組み合わせは、レア${rarityKey} のこのスロット構成では出ない (武器/防具スキルの枠の数が合わない)`);
      } else {
        err('combination-not-in-table', `レア${rarityKey} の抽選表に、このスキルと Lv の組み合わせは無い`);
      }
    } else if (!matches.some((m) => m.exact)) {
      warn('not-exact', '抽選表の Lv より低い (表ではその枠の Lv は固定。読み違いの可能性)');
    }
  }

  return { ok: errors.length === 0, kind: 'random', errors, warnings, matches };
}

/** charm (レア度を除く) があり得るレア度の一覧 (泣シミュから読み込んだ行はレア度が無いので推定に使う) */
export function possibleRarities(charm, rules, skills) {
  const out = [];
  for (const k of Object.keys(rules?.rarities || {})) {
    const r = validateCharm({ ...charm, name: undefined, fixedId: undefined, rarity: Number(k) }, rules, skills);
    if (r.ok) out.push(Number(k));
  }
  return out;
}

// ---------------------------------------------------------------- 泣シミュ形式

/** 泣シミュの 12 項目 (文字列の配列) にする。スキル名は skills.json の日本語名。 */
export function toNakiSimFields(charm, skills) {
  const sk = skillMap(skills);
  const f = [];
  for (let i = 0; i < 3; i++) {
    const s = (charm.skills || [])[i];
    if (!s) {
      f.push('', '0');
      continue;
    }
    const name = sk.get(s.skillId)?.name ?? s.name;
    if (!name) throw new Error(`スキル id ${s.skillId} の名前が分からない`);
    f.push(name, String(s.level));
  }
  if ((charm.skills || []).length > 3) throw new Error('泣シミュ形式のスキルは 3 つまで');
  const a = normalizeSlots(charm.armorSlots, 3);
  const w = normalizeSlots(charm.weaponSlots, 3);
  if (a.length > 3 || w.length > 3) throw new Error('スロットが多すぎる');
  for (const v of [...a, ...w]) f.push(String(v));
  return f;
}

/** 泣シミュの 1 行 (カンマ区切り 12 項目) */
export function toNakiSimRow(charm, skills) {
  return toNakiSimFields(charm, skills).join(',');
}

/** 複数の護石を泣シミュの一括取り込み用テキストにする (固定護石は除く) */
export function toNakiSimText(charms, skills, opts = {}) {
  return listOf(charms, 'charms')
    .filter((c) => charmKind(c, opts.charmsFixed) === 'random')
    .map((c) => toNakiSimRow(c, skills))
    .join('\n');
}

/**
 * 泣シミュの 1 行 (文字列か 12 項目の配列) を読む。
 * @param {string|string[]} row
 * @param {object} skills skills.json
 * @param {object} [opts] { rarity, name, source, addedAt, rules } rules を渡すと possibleRarities も返す
 * @returns {{charm: object|null, errors: Array, warnings: Array, possibleRarities?: number[]}}
 */
export function parseNakiSimRow(row, skills, opts = {}) {
  const errors = [];
  const warnings = [];
  const fields = (Array.isArray(row) ? row : String(row).replace(/\r?\n$/, '').split(',')).map((x) => String(x).trim());
  if (fields.length !== NAKISIM_FIELD_COUNT) {
    errors.push({ code: 'field-count', message: `泣シミュ形式は 12 項目 (入力は ${fields.length} 項目)` });
    return { charm: null, errors, warnings };
  }
  const sk = skillMap(skills);
  const out = [];
  for (let i = 0; i < 3; i++) {
    const name = fields[i * 2];
    const lvText = fields[i * 2 + 1];
    const lv = lvText === '' ? 0 : Number(lvText);
    if (!name) {
      if (lv) errors.push({ code: 'level-without-skill', message: `スキル${i + 1} の名前が空なのに Lv が ${lvText}` });
      continue;
    }
    if (!Number.isInteger(lv) || lv < 1) {
      errors.push({ code: 'level-invalid', message: `${name} の Lv が正しくない (${lvText})`, skillIndex: i });
      continue;
    }
    const def = findSkillByName(name, sk);
    if (!def) {
      errors.push({ code: 'skill-unknown', message: `スキル「${name}」が skills.json に無い`, skillIndex: i });
      continue;
    }
    if (def.name !== name) warnings.push({ code: 'skill-name-normalized', message: `「${name}」を「${def.name}」と読んだ` });
    out.push({ skillId: def.id, name: def.name, level: lv });
  }
  const nums = fields.slice(6).map((x) => (x === '' ? 0 : Number(x)));
  if (nums.some((v) => !Number.isInteger(v) || v < 0 || v > 3)) {
    errors.push({ code: 'slot-invalid', message: `スロット Lv は 0〜3 の整数 (${fields.slice(6).join(',')})` });
    return { charm: null, errors, warnings };
  }
  const armorSlots = normalizeSlots(nums.slice(0, 3), 3);
  const weaponSlots = normalizeSlots(nums.slice(3, 6), 1);
  if (weaponSlots.length > 1) {
    errors.push({ code: 'slot-invalid', message: `武器用スロットが 2 つ以上 (${nums.slice(3, 6).join(',')})` });
  }
  const charm = {
    name: opts.name ?? null, rarity: opts.rarity ?? null,
    skills: out, armorSlots, weaponSlots: weaponSlots.slice(0, 1),
    source: opts.source ?? '泣シミュ形式', addedAt: opts.addedAt ?? null, note: '',
  };
  const res = { charm: errors.length ? null : charm, errors, warnings };
  if (opts.rules && !errors.length) res.possibleRarities = possibleRarities(charm, opts.rules, sk);
  return res;
}

/** 複数行のテキストを読む (空行は飛ばす) */
export function parseNakiSimText(text, skills, opts = {}) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l)
    .map((l) => parseNakiSimRow(l, skills, opts));
}

/** charms.json の次の id ("c0001" 形式の連番) */
export function nextCharmId(charms) {
  let max = 0;
  for (const c of listOf(charms, 'charms')) {
    const m = /^c(\d+)$/.exec(String(c.id));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `c${String(max + 1).padStart(4, '0')}`;
}
