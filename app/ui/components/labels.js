// 画面に出す日本語の名前と、数値の書き方 (全タブで同じ言い方にするため)。

/** 防具の部位 (armor.json の part) */
export const PART_LABEL = { head: '頭', chest: '胴', arms: '腕', waist: '腰', legs: '脚' };

/** 装飾品の入れ先 (build.js の DECO_TARGETS) */
export const DECO_TARGET_LABEL = {
  weapon: '武器', head: '頭', chest: '胴', arms: '腕', waist: '腰', legs: '脚',
  charmArmor: '護石 (防具用)', charmWeapon: '護石 (武器用)',
};

/** 属性・状態異常 (weapons_sns.json の element.type、肉質のキー) */
export const ELEMENT_LABEL = {
  fire: '火', water: '水', thunder: '雷', ice: '氷', dragon: '龍',
  poison: '毒', paralysis: '麻痺', sleep: '睡眠', blast: '爆破',
  slash: '切断', blunt: '打撃', shot: '弾', stun: '気絶',
};

/** 斬れ味の色 (damage.js の SHARPNESS_ORDER) */
export const SHARPNESS_LABEL = {
  red: '赤', orange: '橙', yellow: '黄', green: '緑', blue: '青', white: '白', purple: '紫',
};

/** スキルの種類 (skills.json の kind) */
export const SKILL_KIND_LABEL = { weapon: '武器スキル', armor: '防具スキル', set: 'シリーズスキル', group: 'グループスキル' };

/** 装飾品の種類 (decorations.json の kind) */
export const DECO_KIND_LABEL = { weapon: '武器用', armor: '防具用' };

/** 下のタブ */
export const TAB_LABEL = { equip: '装備', power: '火力', target: '相手', search: '探す', charms: '護石', settings: '設定' };

// ---------------------------------------------------------------- 数値の書き方

/** 数を 3 桁区切りで (digits は小数の桁)。null/NaN は「—」。 */
export function formatNumber(n, digits = 0) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('ja-JP', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 0〜1 の割合を「50%」に。 */
export function formatRatio(x, digits = 0) {
  if (x == null || !Number.isFinite(Number(x))) return '—';
  return `${formatNumber(Number(x) * 100, digits)}%`;
}

/** すでに % の数 (12.3) を「+12.3%」に (sign=true で + を付ける)。 */
export function formatPct(p, digits = 1, { sign = true } = {}) {
  if (p == null || !Number.isFinite(Number(p))) return '—';
  const v = Number(p);
  const s = formatNumber(Math.abs(v), digits);
  if (v > 0 && sign) return `+${s}%`;
  if (v < 0) return `−${s}%`;
  return `${s}%`;
}

/**
 * 期待値の上がり下がりの % (12.3) を画面用に「+12.3%」。±0.05% 未満は「0%」(「+0.0%」と出さない)。
 * 装備タブ・火力タブで同じ書き方にするため、スキルなし比などはこれで出す。
 */
export function formatPctChange(p) {
  if (p == null || !Number.isFinite(Number(p))) return '—';
  if (Math.abs(Number(p)) < 0.05) return '0%';
  return formatPct(p, 1);
}

/** ISO 日時を端末の時刻で「2026/10/21 12:08」に。 */
export function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** バイト数を「1.2 MB」に。 */
export function formatBytes(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** スロット Lv の並び [3, 1, 0] を「③①−」のように。 */
export function formatSlots(slots) {
  const mark = ['−', '①', '②', '③', '④'];
  if (!Array.isArray(slots) || !slots.length) return '−';
  return slots.map((s) => mark[s] || String(s)).join('');
}
