// 装備タブの計算・整形 (画面の部品を持たない純粋関数)。
// preact に依存しないので node --test (tests/ui_equip.test.mjs) で確かめられる。
// 火力タブなど他のタブからも使える関数:
//   buildEquipIndex (画面で足した武器・護石を含めた索引) / localWeaponsFromState / resolveWeaponRef /
//   autoSharpness (斬れ味の自動の色) / damageWeapon / pickDamageTarget / summarizePower
import { indexEquipData, decorationFitError, targetKind, ARMOR_PARTS, DECO_TARGETS } from '../../model/build.js';
import { SHARPNESS_ORDER } from '../../model/damage.js';
import { mixExpected, mixTotal } from './power_calc.js';
import { ELEMENT_LABEL, DECO_TARGET_LABEL, PART_LABEL, formatSlots } from '../components/labels.js';

/** 護石タブが端末で足した護石を置くキー (docs/UI_API.md の store.js 節の例と同じ)。配列か {charms: 配列} */
export const LOCAL_CHARMS_KEY = 'mhwilds-sns:charms-local';
/** 画面で足した所持武器の id の頭 (my_weapons.json の "w0001" とぶつからない) */
export const LOCAL_WEAPON_PREFIX = 'wl';
/** 片手剣の攻撃力の表示倍率 (weapons_sns.json の attack は係数なし) */
export const ATTACK_RATE = 1.4;
/** アーティア武器で選べる属性 (状態異常を含む) */
export const ARTIAN_ELEMENT_TYPES = ['fire', 'water', 'thunder', 'ice', 'dragon', 'poison', 'paralysis', 'sleep', 'blast'];
/** 相手が決まっていないときの肉質 (state.js の手入力の初期値と同じ: 切断・打撃 45、属性 20) */
export const DEFAULT_HITZONE = Object.freeze({ slash: 45, blunt: 45, fire: 20, water: 20, thunder: 20, ice: 20, dragon: 20 });
export const DEFAULT_TARGET = Object.freeze({ hitzone: DEFAULT_HITZONE, wound: null, isWound: false });
/** 既定の肉質の言い方 (装備タブ・火力タブで同じ言い方にする) */
export const DEFAULT_HITZONE_TEXT = '切断 45・打撃 45・属性 20';
/** 斬れ味ゲージの長さの単位 (匠 1 Lv で伸びる長さ) */
const HANDICRAFT_STEP = 10;
const MAX_NAME = 60;

const isObj = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const finite = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
/** 数の id (bonuses.json の id など) か null */
const idOrNull = (x) => (x == null || x === '' ? null : finite(Number(x)));

// ---------------------------------------------------------------- 名前と文字

/** スキル名 (無ければ「不明なスキル」) */
export function skillName(idx, skillId) {
  const s = idx.skills.get(skillId);
  return s ? s.name : `不明なスキル (${skillId})`;
}

/** [{skillId, level}] → 「攻撃 Lv1・見切り Lv2」 */
export function skillsText(list, idx, sep = '・') {
  return (list || []).filter((s) => s && s.level > 0).map((s) => `${skillName(idx, s.skillId)} Lv${s.level}`).join(sep);
}

/** 属性の文字 (「火 300」/「無属性」) */
export function elementText(el) {
  if (!el || !el.type) return '無属性';
  return `${ELEMENT_LABEL[el.type] || el.type} ${el.value ?? 0}`;
}

/** 画面に出す武器の名前 (巨戟アーティアは displayName で激化の種類を区別する) */
export function weaponName(w) {
  return (w && (w.displayName || w.name)) || '名前のない武器';
}

/** 攻撃力の表示値 (ゲーム画面の数字) */
export function attackDisplay(w) {
  if (!w) return null;
  if (w.attackDisplay != null && w.baseWeaponId == null) return w.attackDisplay;
  const a = finite(Number(w.attack));
  return a == null ? null : Math.round(a * ATTACK_RATE);
}

/** 表示値の攻撃力 → 係数なしの値 (小数 2 桁) */
export function attackFromDisplay(display) {
  const n = finite(Number(display));
  return n == null ? null : Math.round((n / ATTACK_RATE) * 100) / 100;
}

/** 部位 (from の 'head' や 'weapon') を日本語に */
export function fromLabel(from) {
  if (from === 'weapon') return '武器';
  return PART_LABEL[from] || from;
}

/** setBonusIds と setBonusId を合わせ、重複と null を除く (build.js と同じ数え方) */
export function setIdsOf(x) {
  if (!x) return [];
  const ids = [...(Array.isArray(x.setBonusIds) ? x.setBonusIds : []), x.setBonusId];
  return [...new Set(ids.filter((id) => id != null))];
}

// ---------------------------------------------------------------- 武器

/** 所持武器 (my_weapons) の元の武器 (weapons_sns)。無ければ null */
export function baseWeaponOf(w, idx) {
  if (!w || w.baseWeaponId == null) return null;
  return idx.weapons.get(w.baseWeaponId) || null;
}

/** アーティア武器か (所持武器なら元の武器で判断) */
export function isArtian(w, idx) {
  if (!w) return false;
  const base = baseWeaponOf(w, idx);
  return !!(w.artian || w.gogmaArtian || (base && (base.artian || base.gogmaArtian)));
}

/** 巨戟アーティア (シリーズ/グループスキルを付けられる) か */
export function isGogmaArtian(w, idx) {
  if (!w) return false;
  const base = baseWeaponOf(w, idx);
  return !!(w.gogmaArtian || (base && base.gogmaArtian));
}

/** 属性をその場で入れる必要があるか (属性が null のアーティア) */
export function needsElementInput(w, idx) {
  return isArtian(w, idx) && !(w.element && w.element.type);
}

/**
 * 武器の参照 (数値 = weapons_sns の id / 文字列 = 所持武器の id) → 画面と計算に使う武器。
 * 所持武器は元の武器の攻撃力・スロット・斬れ味などで足りない所を補う。見つからなければ null。
 */
export function resolveWeaponRef(ref, idx) {
  if (ref == null) return null;
  const w = typeof ref === 'number' ? idx.weapons.get(ref) : idx.myWeapons.get(ref);
  if (!w) return null;
  const base = baseWeaponOf(w, idx);
  if (!base) return w;
  return {
    ...w,
    attack: w.attack ?? base.attack,
    affinity: w.affinity ?? base.affinity,
    rarity: w.rarity ?? base.rarity,
    slots: w.slots ?? base.slots,
    skills: w.skills ?? base.skills,
    sharpness: w.sharpness ?? base.sharpness,
    artian: !!(w.artian || base.artian),
    gogmaArtian: !!(w.gogmaArtian || base.gogmaArtian),
  };
}

/** damage.js に渡す武器 ({attack, affinity, element}) */
export function damageWeapon(w) {
  if (!w) return { attack: 0, affinity: 0, element: null };
  const el = w.element && w.element.type ? { type: w.element.type, value: Number(w.element.value) || 0 } : null;
  return { attack: Number(w.attack) || 0, affinity: Number(w.affinity) || 0, element: el };
}

function bonusNames(x, idx) {
  const out = [];
  for (const id of setIdsOf(x)) {
    const b = idx.setBonuses.get(id);
    if (b) out.push(`シリーズ: ${b.name}`);
  }
  if (x.groupBonusId != null) {
    const g = idx.groupBonuses.get(x.groupBonusId);
    if (g) out.push(`グループ: ${g.name}`);
  }
  return out;
}

/** 武器の 2 行目 (攻撃・会心・属性・スロット・スキル) */
export function weaponSub(w, idx) {
  const r = resolveWeaponRef(typeof w === 'object' ? w.id : w, idx) || w;
  const parts = [
    `攻撃 ${attackDisplay(r) ?? '—'}`,
    `会心 ${Number(r.affinity) || 0}%`,
    r.element && r.element.type ? elementText(r.element) : (needsElementInput(r, idx) ? '属性は手入力' : '無属性'),
    `スロット ${formatSlots(r.slots)}`,
  ];
  const sk = skillsText(r.skills, idx);
  if (sk) parts.push(sk);
  parts.push(...bonusNames(r, idx));
  return parts.join('・');
}

/**
 * 武器を選ぶ一覧 (Picker の items)。持っている武器を先に、片手剣はレア度の高い順。
 * @param idx buildEquipIndex の結果
 * @param weapons weapons_sns.json の配列
 * @param myWeapons 所持武器 (my_weapons.json + 画面で足した分) の配列
 */
export function weaponItems(idx, weapons, myWeapons) {
  const mine = (myWeapons || []).map((w) => ({
    value: w.id,
    label: weaponName(w),
    sub: weaponSub(w, idx),
    group: '持っている武器 (アーティア)',
    keywords: `持っている 所持 アーティア ${weaponName(baseWeaponOf(w, idx))}`,
  }));
  const sns = [...(weapons || [])]
    .sort((a, b) => (b.rarity ?? 0) - (a.rarity ?? 0) || a.id - b.id)
    .map((w) => ({
      value: w.id,
      label: weaponName(w),
      sub: weaponSub(w, idx),
      group: `レア ${w.rarity}`,
      keywords: [`レア${w.rarity}`, w.series || '', w.variant || '', w.artian ? 'アーティア' : ''].join(' '),
    }));
  return [...mine, ...sns];
}

// ---------------------------------------------------------------- 画面で足した所持武器 (state.tabs.equip.myWeapons)

function sanitizeElement(e) {
  if (!isObj(e) || !ARTIAN_ELEMENT_TYPES.includes(e.type)) return null;
  const v = finite(Number(e.value));
  return { type: e.type, value: v == null ? 0 : Math.max(0, Math.min(2000, Math.round(v))) };
}

function sanitizeSlots(s) {
  if (!Array.isArray(s)) return null;
  return s.slice(0, 3).map((v) => Math.max(0, Math.min(3, Math.round(Number(v) || 0))));
}

function sanitizeSharp(s) {
  if (!Array.isArray(s)) return null;
  return s.slice(0, 7).map((v) => Math.max(0, Math.round(Number(v) || 0)));
}

/** 保存してある所持武器 (画面で足した分) を正しい形にそろえる。壊れた要素は捨てる。 */
export function sanitizeLocalWeapons(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const w of raw) {
    if (!isObj(w) || typeof w.id !== 'string' || !w.id.startsWith(LOCAL_WEAPON_PREFIX) || seen.has(w.id)) continue;
    seen.add(w.id);
    const base = finite(Number(w.baseWeaponId));
    out.push({
      id: w.id,
      name: typeof w.name === 'string' && w.name.trim() ? w.name.trim().slice(0, MAX_NAME) : '名前のない武器',
      baseWeaponId: base,
      attack: finite(Number(w.attack)) ?? undefined,
      affinity: finite(Number(w.affinity)) ?? undefined,
      element: sanitizeElement(w.element),
      sharpness: sanitizeSharp(w.sharpness) ?? undefined,
      slots: sanitizeSlots(w.slots) ?? undefined,
      setBonusId: idOrNull(w.setBonusId),
      groupBonusId: idOrNull(w.groupBonusId),
      note: typeof w.note === 'string' ? w.note.slice(0, 200) : '',
      addedAt: typeof w.addedAt === 'string' ? w.addedAt : null,
    });
  }
  // undefined の項目は消す (build.js が元の武器から補う)
  return out.map((w) => Object.fromEntries(Object.entries(w).filter(([, v]) => v !== undefined)));
}

/** state から画面で足した所持武器を取り出す */
export function localWeaponsFromState(s) {
  return sanitizeLocalWeapons(s && s.tabs && s.tabs.equip ? s.tabs.equip.myWeapons : null);
}

/** 新しい所持武器の id ("wl" で始まる。ほかとぶつからない) */
export function newLocalWeaponId(existing = [], now = Date.now()) {
  const ids = new Set(existing.map((w) => w.id));
  let n = 0;
  let id;
  do {
    id = `${LOCAL_WEAPON_PREFIX}${now.toString(36)}${n ? n.toString(36) : ''}`;
    n += 1;
  } while (ids.has(id));
  return id;
}

/** アーティアの既定の名前 (「ヴェルドロート (火)」) */
export function defaultArtianName(src, element, idx) {
  const base = (idx && baseWeaponOf(src, idx)) || src;
  const el = element && element.type ? ELEMENT_LABEL[element.type] || element.type : '無属性';
  // 巨戟アーティアは激化の種類と並べる (「破滅のキリエヴェルド (属性激化・火)」)
  if (base && base.variant) return `${base.name} (${base.variant}・${el})`;
  return `${weaponName(base)} (${el})`;
}

/** 入力欄の初期値 (draft)。src は weapons_sns の要素か所持武器 */
export function artianDraftOf(src, idx) {
  const r = resolveWeaponRef(src.id, idx) || src;
  return {
    name: '',
    element: r.element && r.element.type ? { ...r.element } : null,
    attack: Number(r.attack) || 0,
    affinity: Number(r.affinity) || 0,
    setBonusId: r.setBonusId ?? null,
    groupBonusId: r.groupBonusId ?? null,
  };
}

/** 属性を入れるときの属性値の初期値 (データの目安。無ければ 0) */
export function defaultElementValue(src, idx) {
  const base = baseWeaponOf(src, idx) || src;
  return Number(base && base.mhwsAttributeValue) || 0;
}

/**
 * 入力した内容から所持武器 (my_weapons.json と同じ形) を作る。
 * @param src 元にする武器 (weapons_sns の要素か所持武器)
 * @param draft artianDraftOf の形
 */
export function makeLocalWeapon(src, draft, idx, { id, addedAt = new Date().toISOString() } = {}) {
  const base = baseWeaponOf(src, idx) || src;
  const r = resolveWeaponRef(src.id, idx) || src;
  const gogma = isGogmaArtian(r, idx);
  const element = sanitizeElement(draft.element);
  const sharp = Array.isArray(r.sharpness) ? r.sharpness : r.sharpness && Array.isArray(r.sharpness.base) ? r.sharpness.base : null;
  const w = {
    id: id || newLocalWeaponId([]),
    name: (draft.name || '').trim().slice(0, MAX_NAME) || defaultArtianName(base, element, idx),
    baseWeaponId: base.id,
    attack: finite(Number(draft.attack)) ?? (Number(r.attack) || 0),
    affinity: finite(Number(draft.affinity)) ?? (Number(r.affinity) || 0),
    element,
    slots: [...(r.slots || [0, 0, 0])],
    setBonusId: gogma ? idOrNull(draft.setBonusId) : null,
    groupBonusId: gogma ? idOrNull(draft.groupBonusId) : null,
    note: '画面で追加',
    addedAt,
  };
  if (sharp) w.sharpness = [...sharp];
  return w;
}

/** file の一覧に、id のぶつからない local の要素を足す */
export function mergeById(fileList, localList) {
  const ids = new Set((fileList || []).map((x) => x.id));
  return [...(fileList || []), ...(localList || []).filter((x) => !ids.has(x.id))];
}

// ---------------------------------------------------------------- 画面で足した護石 (護石タブ)

/** 端末に保存してある護石 (護石タブが足した分) を正しい形にそろえる。id が文字列のものだけ使う */
export function sanitizeLocalCharms(raw) {
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.charms) ? raw.charms : [];
  const seen = new Set();
  const out = [];
  for (const c of list) {
    if (!isObj(c) || typeof c.id !== 'string' || !c.id || seen.has(c.id) || !Array.isArray(c.skills)) continue;
    seen.add(c.id);
    out.push({
      ...c,
      name: typeof c.name === 'string' && c.name ? c.name : '護石',
      skills: c.skills.filter((s) => isObj(s) && s.skillId != null && Number(s.level) > 0)
        .map((s) => ({ ...s, skillId: Number(s.skillId), level: Number(s.level) })),
      armorSlots: sanitizeSlots(c.armorSlots) || [0, 0, 0],
      weaponSlots: sanitizeSlots(c.weaponSlots) || [0],
    });
  }
  return out;
}

// ---------------------------------------------------------------- 索引

/**
 * 画面で足した所持武器・護石も含めた索引 (computeBuild にそのまま渡せる)。
 * 足した分が無ければ data.index をそのまま返す。
 * @param data data.js の core データ
 */
export function buildEquipIndex(data, { localWeapons = [], localCharms = [] } = {}) {
  if (!localWeapons.length && !localCharms.length) return data.index;
  return indexEquipData({
    skills: data.skills, decorations: data.decorations, bonuses: data.bonuses, armor: data.armor,
    weapons: data.weapons, charmsFixed: data.charmsFixed,
    myWeapons: mergeById(data.lists.myWeapons, localWeapons),
    charms: mergeById(data.lists.charms, localCharms),
  });
}

// ---------------------------------------------------------------- 防具

/** 防具の 2 行目 (スロット・スキル・シリーズ/グループ) */
export function armorSub(a, idx, { limitBreakOn = false } = {}) {
  const lb = Array.isArray(a.slotsLimitBreak) ? a.slotsLimitBreak : null;
  const differs = lb && formatSlots(lb) !== formatSlots(a.slots);
  let slotText;
  if (limitBreakOn && lb) slotText = `スロット ${formatSlots(lb)} (限界突破)`;
  else slotText = `スロット ${formatSlots(a.slots)}${differs ? ` (限界突破で ${formatSlots(lb)})` : ''}`;
  return [slotText, skillsText(a.skills, idx), ...bonusNames(a, idx)].filter(Boolean).join('・');
}

/** レア度の選び方 (上位/下位で変わる) */
export function rarityOptions(rank) {
  if (rank === 'high') return [8, 7, 6, 5];
  if (rank === 'low') return [4, 3, 2, 1];
  return [8, 7, 6, 5, 4, 3, 2, 1];
}

/**
 * 防具を選ぶ一覧 (部位ごと)。filter = {rank: 'all'|'high'|'low', rarity: 'all'|数}。
 * 名前・スキル名・シリーズ名で検索できる (sub と keywords)。レア度の高い順。
 */
export function armorItems(idx, armorList, part, filter = {}) {
  const rank = filter.rank || 'all';
  const rarity = filter.rarity ?? 'all';
  return (armorList || [])
    .filter((a) => a.part === part
      && (rank === 'all' || a.rank === rank)
      && (rarity === 'all' || a.rarity === Number(rarity)))
    .sort((a, b) => (b.rarity ?? 0) - (a.rarity ?? 0) || (a.armorSetId ?? 0) - (b.armorSetId ?? 0) || a.id - b.id)
    .map((a) => ({
      value: a.id,
      label: a.name,
      sub: armorSub(a, idx),
      group: `${a.rank === 'low' ? '下位' : '上位'} レア ${a.rarity}`,
      keywords: `${a.armorSetName || ''} レア${a.rarity} ${a.rank === 'low' ? '下位' : '上位'}`,
    }));
}

// ---------------------------------------------------------------- 護石

/** 護石の 2 行目 */
export function charmSub(c, idx) {
  const parts = [skillsText(c.skills, idx) || 'スキルなし'];
  if ('armorSlots' in c || 'weaponSlots' in c) {
    parts.push(`スロット 防具用 ${formatSlots(c.armorSlots)}・武器用 ${formatSlots(c.weaponSlots)}`);
  }
  if (c.rarity != null) parts.push(`レア ${c.rarity}`);
  return parts.join('・');
}

/**
 * 護石を選ぶ一覧。持っている護石 (data/charms.json = Claude が取り込んだ分 → この端末で足した分) を先に、
 * 生産する護石 (charms_fixed.json) を後に。見出しは護石タブと同じ言い方。
 */
export function charmItems(idx, fileCharms, localCharms, fixed) {
  const own = (c, group) => ({
    value: c.id, label: c.name || '護石', sub: charmSub(c, idx), group, keywords: '持っている 所持',
  });
  const fileIds = new Set((fileCharms || []).map((c) => c.id));
  const mine = [
    ...(fileCharms || []).map((c) => own(c, 'Claude が取り込んだ護石')),
    ...(localCharms || []).filter((c) => !fileIds.has(c.id)).map((c) => own(c, 'この端末で足した護石')),
  ];
  const fx = (fixed || []).map((c) => ({
    value: c.id, label: c.name, sub: charmSub(c, idx), group: '生産する護石 (スロットなし)',
    keywords: `生産 固定 作る レア${c.rarity ?? ''}`,
  }));
  return [...mine, ...fx];
}

// ---------------------------------------------------------------- 装飾品

/**
 * スロットに入る装飾品だけの一覧。kind = 'weapon'|'armor' (武器用/防具用)、size = スロット Lv。
 * スロット Lv の大きい珠を先に、同じ Lv の中は名前順。
 */
export function decoItems(idx, decorations, kind, size) {
  return (decorations || [])
    .filter((d) => decorationFitError(d, kind, size) == null)
    .sort((a, b) => b.slot - a.slot || String(a.name).localeCompare(String(b.name), 'ja'))
    .map((d) => ({
      value: d.id,
      label: d.name,
      sub: skillsText(d.skills, idx),
      group: `スロット Lv${d.slot} の装飾品`,
      keywords: `Lv${d.slot}`,
    }));
}

/**
 * 装飾品の入れ先ごとのスロットの並び (画面の行)。
 * スロットが無い所 (Lv0) は出さない。ただし珠が入っている (入れたのに入らない) 所は出して直せるようにする。
 * @param result computeBuild の結果
 * @param build state.build
 * @param names {weapon, head, ..., charm} 装備の名前 (見出し用)
 * @returns [{target, title, kind, rows: [{index, size, decorationId, error}]}]
 */
export function slotGroups(result, build, names = {}) {
  const errAt = new Map();
  for (const e of result.errors || []) {
    if (e.target != null && e.index != null) errAt.set(`${e.target}:${e.index}`, e);
  }
  const out = [];
  for (const t of DECO_TARGETS) {
    const slots = (result.slots && result.slots[t]) || [];
    const assigned = (build.decorations && build.decorations[t]) || [];
    const n = Math.max(slots.length, assigned.length);
    const rows = [];
    for (let i = 0; i < n; i++) {
      const size = slots[i] ? slots[i].size : 0;
      const id = assigned[i] ?? null;
      if (!size && id == null) continue;
      rows.push({ index: i, size, decorationId: id, error: errAt.get(`${t}:${i}`) || null });
    }
    if (!rows.length) continue;
    const owner = t === 'charmArmor' || t === 'charmWeapon' ? names.charm : names[t];
    const label = DECO_TARGET_LABEL[t] || t;
    out.push({ target: t, kind: targetKind(t), title: owner ? `${label}: ${owner}` : label, rows });
  }
  return out;
}

// ---------------------------------------------------------------- 結果の文字

/** 画面に出すエラーの文 (id などの内部の言葉を出さない) */
export function friendlyIssue(e) {
  switch (e.code) {
    case 'unknown-weapon':
      return '選んでいた武器が見つかりません (消した武器かもしれません)。武器を選び直してください。';
    case 'unknown-armor':
      return `${PART_LABEL[e.target] || ''}の防具が見つかりません (データが新しくなったのかもしれません)。選び直してください。`;
    case 'unknown-charm':
      return '選んでいた護石が見つかりません (消した護石かもしれません)。護石を選び直してください。';
    case 'unknown-decoration':
      return `${DECO_TARGET_LABEL[e.target] || ''} の ${Number(e.index) + 1} 番目の装飾品が見つかりません。選び直してください。`;
    case 'unknown-base-weapon':
      return 'アーティア武器の元の武器が見つからないので、スロットとスキルを空として計算しました。';
    default:
      return e.message || String(e.code || '');
  }
}

/** スキルの出どころ (sources) → 「頭 1・装飾品 (武器) 2・シリーズ 4 部位」 */
export function sourcesText(sources) {
  const parts = [];
  for (const s of sources || []) {
    if (s.via === 'decoration') parts.push(`装飾品 (${DECO_TARGET_LABEL[s.target] || s.target}) ${s.level}`);
    else if (s.via === 'set') parts.push(`シリーズ ${s.pieces} 部位`);
    else if (s.via === 'group') parts.push(`グループ ${s.pieces} 部位`);
    else if (s.target === 'charm') parts.push(`護石 ${s.level}`);
    else parts.push(`${fromLabel(s.target)} ${s.level}`);
  }
  return parts.join('・');
}

/** シリーズスキル・グループスキルの表示 */
export function bonusLines(result, idx) {
  const sets = (result.setBonuses || []).map((b) => {
    const rank = (b.ranks || []).filter((r) => b.pieces >= r.pieces).pop();
    const ranksText = (b.ranks || []).map((r) => `${r.pieces} 部位で${r.name ? ` ${r.name}` : ` Lv${r.level}`}`).join('・');
    let status;
    if (b.active) {
      status = `${b.pieces} 部位で発動${rank && rank.name ? ` (${rank.name})` : ` (Lv${b.level})`}`;
      if (b.next) status += `。あと ${b.next.pieces - b.pieces} 部位で次の段階`;
    } else {
      const need = b.next ? b.next.pieces - b.pieces : null;
      status = `${b.pieces} 部位 (あと ${need ?? '?'} 部位で発動)`;
    }
    return {
      key: `s${b.bonusId}`, kind: 'set', name: b.name, active: b.active, status, ranksText,
      from: (b.from || []).map(fromLabel).join('・'),
    };
  });
  const groups = (result.groupBonuses || []).map((b) => {
    const g = idx.groupBonuses.get(b.bonusId);
    const effect = g && g.effectName ? g.effectName : null;
    const status = b.active
      ? `${b.pieces} 部位で発動${effect ? ` (${effect})` : ''}`
      : `${b.pieces} / ${b.required} 部位 (あと ${b.required - b.pieces} 部位で発動)`;
    return {
      key: `g${b.bonusId}`, kind: 'group', name: b.name, active: b.active, status,
      ranksText: `${b.required} 部位で${effect ? ` ${effect}` : '発動'}`,
      from: (b.from || []).map(fromLabel).join('・'),
    };
  });
  return [...sets, ...groups];
}

/** 空きスロットの文 (slotSummary の 1 つ) → 「2 / 5 使用・空き ③×1・①×2」 */
export function slotSummaryText(sum) {
  if (!sum || !sum.total) return 'スロットなし';
  const free = [3, 2, 1].filter((s) => sum.freeBySize[s] > 0).map((s) => `${formatSlots([s])}×${sum.freeBySize[s]}`);
  return `${sum.used} / ${sum.total} 使用・${free.length ? `空き ${free.join('・')}` : '空きなし'}`;
}

/**
 * 装備を替えたとき、前の装備に入れていた装飾品のうち新しい装備のスロットに入るものを残す。
 * 同じ番号のスロットに入るならそのまま。入らない珠は、大きい珠から順に、空いている中で入る一番小さいスロットへ。
 * それで外れる珠が出るときは、並べ直して (大きい珠から一番小さく入るスロットへ) 多く残せる方にする。入らない珠は外す。
 * @param {Array} decoIds 前の装備の装飾品 (スロットの順。null = 空き)
 * @param {number[]} sizes 新しい装備のスロット Lv (スロットの順。0 = 無い)
 * @param {'weapon'|'armor'} kind 入れ先の種類
 * @returns {{list: Array, kept: number[], removed: number[]}} list は新しい装備のスロットの順 (null = 空き)
 */
export function refitDecorations(decoIds, sizes, kind, idx) {
  const sz = sizes || [];
  const fitsAt = (d, i) => !!d && !!sz[i] && decorationFitError(d, kind, sz[i]) == null;
  const decos = (decoIds || []).map((id, i) => ({ id, i, d: id == null ? null : idx.decorations.get(id) }))
    .filter((x) => x.id != null);
  const place = (keepPositions) => {
    const list = sz.map(() => null);
    const kept = [];
    const removed = [];
    const rest = [];
    for (const x of decos) {
      if (keepPositions && x.i < list.length && list[x.i] == null && fitsAt(x.d, x.i)) {
        list[x.i] = x.id;
        kept.push(x.id);
      } else {
        rest.push(x);
      }
    }
    rest.sort((a, b) => ((b.d && b.d.slot) || 0) - ((a.d && a.d.slot) || 0));
    for (const x of rest) {
      let best = -1;
      sz.forEach((size, i) => {
        if (list[i] != null || !fitsAt(x.d, i)) return;
        if (best < 0 || size < sz[best]) best = i;
      });
      if (best >= 0) {
        list[best] = x.id;
        kept.push(x.id);
      } else {
        removed.push(x.id);
      }
    }
    while (list.length && list[list.length - 1] == null) list.pop();
    return { list, kept, removed };
  };
  const inPlace = place(true);
  if (!inPlace.removed.length) return inPlace;
  const packed = place(false);
  return packed.kept.length > inPlace.kept.length ? packed : inPlace;
}

// ---------------------------------------------------------------- 斬れ味

function pad6(a) {
  const out = (Array.isArray(a) ? a : []).slice(0, 7).map((v) => Math.max(0, Number(v) || 0));
  while (out.length < 6) out.push(0);
  return out;
}

const sameArr = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * 武器の斬れ味ゲージ {base, handicraftMax}。各色の長さの配列 [赤, 橙, 黄, 緑, 青, 白] (データの順)。
 * 所持武器 (配列だけ持つ) は、元の武器と同じゲージなら元の武器の匠の伸びしろも使う。
 */
export function sharpnessGauge(w, idx) {
  if (!w) return null;
  const base = baseWeaponOf(w, idx);
  const s = w.sharpness ?? (base ? base.sharpness : null);
  if (Array.isArray(s)) {
    const bs = base && base.sharpness;
    const hm = bs && sameArr(bs.base, s) ? bs.handicraftMax : null;
    return { base: pad6(s), handicraftMax: hm ? pad6(hm) : null };
  }
  if (isObj(s) && Array.isArray(s.base)) {
    return { base: pad6(s.base), handicraftMax: Array.isArray(s.handicraftMax) ? pad6(s.handicraftMax) : null };
  }
  return null;
}

/** 匠 Lv を入れたゲージ (1 Lv で 10 ずつ、handicraftMax まで。伸びる色の低い順に) */
export function gaugeWithHandicraft(gauge, level = 0) {
  if (!gauge) return null;
  const out = [...gauge.base];
  if (!gauge.handicraftMax || !(level > 0)) return out;
  let budget = level * HANDICRAFT_STEP;
  for (let i = 0; i < out.length && budget > 0; i++) {
    const room = Math.max(0, (gauge.handicraftMax[i] || 0) - gauge.base[i]);
    const add = Math.min(room, budget);
    out[i] += add;
    budget -= add;
  }
  return out;
}

/** ゲージの一番上の色 ('white' など)。ゲージが無ければ null */
export function topSharpness(gauge) {
  if (!Array.isArray(gauge)) return null;
  for (let i = gauge.length - 1; i >= 0; i--) if (gauge[i] > 0) return SHARPNESS_ORDER[i] || null;
  return null;
}

/** 匠のスキル id (名前で探す。無ければ null) */
export function handicraftSkillId(idx) {
  for (const s of idx.skills.values()) if (s.name === '匠') return s.id;
  return null;
}

/** 匠の {skillId, name, maxLevel} (火力タブの効き目・スキル火力表に匠の行を出すのに使う)。無ければ null */
export function handicraftInfo(idx) {
  const id = handicraftSkillId(idx);
  if (id == null) return null;
  const s = idx.skills.get(id);
  return { skillId: id, name: s.name, maxLevel: s.maxLevel || (Array.isArray(s.levels) ? s.levels.length : 5) || 5 };
}

/**
 * 斬れ味の色をスキルの組から決める関数 (power_calc.js の input.perSkills)。
 * 斬れ味を固定しているとき (fixedColor がある)・武器が無いときは null (色は変わらない)。
 * 自動のときは匠の Lv で色が変わるので、スキルを外したとき・スキルなしのときの色を決め直すのに使う。
 */
export function sharpnessResolver(weapon, idx, fixedColor) {
  if (fixedColor || !weapon) return null;
  const hid = handicraftSkillId(idx);
  const cache = new Map();
  return (skills) => {
    let lv = 0;
    for (const s of skills || []) if (hid != null && Number(s.skillId) === hid) lv = Number(s.level) || 0;
    if (!cache.has(lv)) cache.set(lv, autoSharpness(weapon, idx, hid != null ? { [hid]: lv } : {}).color || 'white');
    return { sharpness: cache.get(lv) };
  };
}

/**
 * 斬れ味の自動の色: いまの装備で出る一番上の色 (匠の Lv を含む)。
 * @param skillLevels computeBuild(...).skillLevels
 * @returns {{color: string|null, handicraft: number, gauge: number[]|null, maxGauge: number[]|null}}
 */
export function autoSharpness(w, idx, skillLevels = {}) {
  const g = sharpnessGauge(w, idx);
  const hid = handicraftSkillId(idx);
  const handicraft = hid != null ? Number(skillLevels[hid]) || 0 : 0;
  const gauge = gaugeWithHandicraft(g, handicraft);
  return {
    color: topSharpness(gauge), handicraft, gauge,
    baseGauge: g ? g.base : null, maxGauge: g ? (g.handicraftMax || g.base) : null,
  };
}

// ---------------------------------------------------------------- 火力の要約

/**
 * 火力の計算に使う相手を決める。
 * @param stTarget state.target
 * @param resolved state.js の resolveTarget(...) の結果 (null = 決まらない)
 * @param status 相手のデータの読み込み状態 (useTargetData().status)
 * @returns {{loading?: true, target?, label?, source?: 'monster'|'manual'|'default', reason?}}
 *   source 'default' = 手入力の既定の肉質 (切断・打撃 45、属性 20) で計算する。reason はその理由
 */
export function pickDamageTarget(stTarget, resolved, status) {
  const t = stTarget || {};
  if (resolved) {
    return {
      target: { hitzone: resolved.hitzone, wound: resolved.wound || null, isWound: !!resolved.isWound },
      label: `${resolved.label}${resolved.isWound ? '・傷口' : ''}`,
      source: t.mode === 'manual' ? 'manual' : 'monster',
    };
  }
  let reason = 'unset';
  if (t.mode === 'monster' && t.monsterId != null) {
    if (!t.partKey) reason = 'no-part';
    else if (status === 'loading' || status === 'idle') return { loading: true };
    else if (status === 'error') reason = 'load-error';
    else reason = 'not-found';
  }
  return { target: DEFAULT_TARGET, label: `既定の肉質 (${DEFAULT_HITZONE_TEXT})`, source: 'default', reason };
}

/** pickDamageTarget の reason を文に */
export function defaultTargetReason(reason) {
  switch (reason) {
    case 'no-part': return 'モンスターの部位を選んでいないので';
    case 'load-error': return 'モンスターのデータを読み込めなかったので';
    case 'not-found': return '選んでいたモンスターの部位が見つからないので';
    default: return '相手を選んでいないので';
  }
}

/**
 * 火力の要約: いまの装備・相手・コンボの期待値と、スキルなし比。
 * @param p {weapon (resolveWeaponRef の結果), sharpness, skills (computeBuild の skills), uptimes, data, combo (resolveCombo の結果),
 *           target, targets?, perSkills?, monsterStatus?}
 *   targets を渡すと、狙う部位の割合 ([{weight, target}]。target_mix.js の resolveTargetMix の targets) で加重平均する
 *   (火力タブと同じ power_calc.js の mixExpected。部位が 1 つなら damage.js の comboExpected と同じ値)。
 *   perSkills は sharpnessResolver の結果 (斬れ味が自動のとき。スキルなしの色を匠なしで決め直す)。
 *   monsterStatus は相手が使う状態異常 (target_mix.js の monsterStatusOf。狂竜症などの条件のもとの確かめ)。
 * @returns {{total, physical, element, extra, noSkills, vsNoSkillsPct, comboName, conditions, placeholders,
 *            warnings, lowConfidence, unsupported, mixed, perTarget} | {error}}
 */
export function summarizePower(p) {
  if (!p.combo) return { error: 'コンボのデータがありません' };
  try {
    const input = {
      weapon: damageWeapon(p.weapon), sharpness: p.sharpness || 'white', skills: p.skills || [],
      uptimes: p.uptimes || {}, effects: p.data.skillEffects, motions: p.data.motions, combo: p.combo,
      perSkills: p.perSkills || null, monsterStatus: p.monsterStatus,
    };
    const targets = Array.isArray(p.targets) && p.targets.length ? p.targets
      : [{ weight: 1, target: p.target || DEFAULT_TARGET }];
    const r = mixExpected(input, targets);
    const none = { total: mixTotal({ ...input, skills: [] }, targets) };
    const seen = new Set();
    const warnings = (r.warnings || []).filter((w) => {
      if (seen.has(w.message)) return false;
      seen.add(w.message);
      return true;
    });
    return {
      total: r.total, physical: r.physical, element: r.element, extra: r.extra,
      noSkills: none.total,
      vsNoSkillsPct: none.total > 0 ? (r.total / none.total - 1) * 100 : null,
      comboName: Array.isArray(p.combo) ? '自分で組んだコンボ' : p.combo.name,
      conditions: r.conditions || [],
      placeholders: (r.conditions || []).filter((c) => c.placeholder && !c.inactive),
      warnings,
      lowConfidence: r.lowConfidence || [],
      unsupported: r.unsupported || [],
      mixed: !!r.mixed,
      perTarget: r.perTarget || [],
    };
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------- マイセット

/** 装備一式を比べるための文字列 (末尾の空きの珠・並びの違いを吸収) */
export function canonicalBuild(b) {
  if (!b) return '';
  const decos = {};
  for (const t of DECO_TARGETS) {
    const list = [...((b.decorations && b.decorations[t]) || [])];
    while (list.length && list[list.length - 1] == null) list.pop();
    decos[t] = list.map((x) => x ?? null);
  }
  return JSON.stringify({
    weapon: b.weapon ?? null,
    armor: ARMOR_PARTS.map((p) => (b.armor && b.armor[p]) ?? null),
    limitBreak: ARMOR_PARTS.map((p) => !!(b.limitBreak && b.limitBreak[p]) && (b.armor && b.armor[p]) != null),
    charm: b.charm ?? null,
    decos,
  });
}

/** マイセットの一覧に出す短い説明 (武器と防具の数) */
export function setSummary(build, idx) {
  const w = resolveWeaponRef(build.weapon, idx);
  const n = ARMOR_PARTS.filter((p) => build.armor && build.armor[p] != null).length;
  return `${w ? weaponName(w) : build.weapon != null ? '見つからない武器' : '武器なし'}・防具 ${n} 部位`;
}
