// 護石タブ。
// 1. 持っている護石の一覧。data/charms.json の分 (Claude が写真から取り込んだ分) と、この端末で足した分を分けて出す。
//    各護石に レア度・スキルと Lv・スロット (防具用/武器用) と、検証の結果 (validateCharm をやさしい言葉に直したもの)。
// 2. 手で足す / 直す / 消す。レア度 → スロット → スキルの順に、talisman_rules.json の抽選表で出るものだけを選ばせる
//    (選べるものしか出さないので、ゲームで出ない護石はそもそも入力できない)。data/charms.json の分は画面では消せない。
// 3. 書き出し: 泣シミュ (wiki-db) 形式の 12 項目 / Claude に渡す用 (data/charms.json に足せる JSON)。読み込み: 泣シミュ形式の貼り付け。
// 4. 「写真で足すには」の案内を常に出す。
// 5. 選んだ護石を装備の護石にする (state.js の setCharm)。
// 6. (2026-10-24) シート「所持護石一覧」から取り込んだ護石 (tools/import_charms.mjs。約 250 個) は、シートの No. と
//    「スロット未確認」の印を出す。一覧は No. かスキルの名前で探せて、「スロット未確認」「注意・エラー」だけにも絞れる。
//
// この端末で足した護石は IndexedDB の "mhwilds-sns:charms-local" に、charms.json の要素と同じ形の配列で保存する。
// id は "u0001" から (data/charms.json の "c0001" と重ならない)。設定タブの「全データの書き出し」にも自動で入る。
// 装備タブなどで計算に使うときは、下の「ほかのタブから使う」節の useCharmsIndex(data) を computeBuild に渡す。
import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  html, Card, Button, Hint, KeyValue, Badge, Notice, Loading, Empty, Segmented, TextInput, BottomSheet, PickerField,
  toast, formatSlots, normalizeSearch,
} from '../components/index.js';
import { useAppState, setCharm, setTab, getState } from '../../state.js';
import { kvGet, kvSet, copyText } from '../../store.js';
import {
  validateCharm, toNakiSimRow, parseNakiSimRow, normalizeSlots, nextCharmId, charmKind, fixedCharmOf,
} from '../../model/charms.js';

/** この端末で足した護石の保存キー (値は charms.json の要素と同じ形の配列) */
export const LOCAL_CHARMS_KEY = 'mhwilds-sns:charms-local';

const isObj = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const pad2 = (n) => String(n).padStart(2, '0');

/** 端末の今日の日付 "2026-10-21" */
export function todayText(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ================================================================ この端末で足した護石 (保存)

function slotsArr(x, n) {
  const a = (Array.isArray(x) ? x : []).slice(0, n).map((v) => {
    const k = Number(v);
    return Number.isInteger(k) && k >= 0 && k <= 3 ? k : 0;
  });
  while (a.length < n) a.push(0);
  return a;
}

function strOf(v, n) {
  return typeof v === 'string' ? v.slice(0, n) : '';
}

/** 保存データの 1 件を charms.json の要素の形にそろえる (壊れていれば null) */
function sanitizeLocalCharm(raw) {
  if (!isObj(raw) || typeof raw.id !== 'string' || !raw.id.trim()) return null;
  const skills = (Array.isArray(raw.skills) ? raw.skills : []).filter(isObj).slice(0, 3).map((s) => {
    const lv = Number(s.level);
    return {
      skillId: Number.isInteger(s.skillId) ? s.skillId : null,
      name: strOf(s.name, 40),
      level: Number.isInteger(lv) ? lv : 0,
    };
  });
  const rarity = Number(raw.rarity);
  return {
    id: raw.id.trim().slice(0, 20),
    name: strOf(raw.name, 40) || null,
    rarity: raw.rarity != null && Number.isInteger(rarity) ? rarity : null,
    skills,
    armorSlots: slotsArr(raw.armorSlots, 3),
    weaponSlots: slotsArr(raw.weaponSlots, 1),
    source: strOf(raw.source, 80),
    addedAt: strOf(raw.addedAt, 30),
    note: strOf(raw.note, 200),
  };
}

/** 保存データ (配列か {charms: [...]}) を護石の配列にする。id の重複は先の方を残す。 */
export function sanitizeLocalCharms(raw) {
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.charms) ? raw.charms : [];
  const seen = new Set();
  const out = [];
  for (const r of list) {
    const c = sanitizeLocalCharm(r);
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

/** この端末で足す護石の次の id ("u0001" 形式の連番) */
export function nextLocalId(list) {
  let max = 0;
  for (const c of list || []) {
    const m = /^u(\d+)$/.exec(String(c.id));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `u${String(max + 1).padStart(4, '0')}`;
}

// 1 か所で持つ (護石タブと装備タブが同じものを見る)
const localStore = {
  status: 'idle',     // 'idle' | 'loading' | 'ready'
  charms: [],         // 変えるたびに新しい配列にする (memo の依存に使えるように)
  saved: null,        // 最後の保存: true = 端末に保存できた / false = メモリだけ / null = まだ書いていない
  pending: 0,         // 書き込み中の数
  promise: null,      // 読み込み中の Promise
  listeners: new Set(),
};

function notifyLocal() {
  for (const fn of [...localStore.listeners]) {
    try {
      fn();
    } catch (e) {
      console.warn(e);
    }
  }
}

/** 端末で足した護石を読む (初回だけ IndexedDB から。force で読み直す)。失敗しても空の配列で進む。 */
export function loadLocalCharms({ force = false } = {}) {
  if (localStore.promise) return localStore.promise;
  if (localStore.status === 'ready' && !force) return Promise.resolve(localStore.charms);
  if (localStore.status !== 'ready') localStore.status = 'loading';
  localStore.promise = (async () => {
    let raw;
    try {
      raw = await kvGet(LOCAL_CHARMS_KEY);
    } catch (e) {
      console.warn('この端末で足した護石を読めませんでした', e);
    }
    const next = sanitizeLocalCharms(raw);
    // 中身が同じなら配列を入れ替えない (無駄な描き直しをしない)
    if (JSON.stringify(next) !== JSON.stringify(localStore.charms)) localStore.charms = next;
    localStore.status = 'ready';
    return localStore.charms;
  })().finally(() => {
    localStore.promise = null;
    notifyLocal();
  });
  return localStore.promise;
}

/**
 * 保存領域から読み直す (全データの読み込み・初期化のあとに合わせるため。タブを開くたびに呼ぶ)。
 * 書き込み中は読み直さない (書いた方が新しい)。
 */
export function refreshLocalCharms() {
  if (localStore.pending > 0) return Promise.resolve(localStore.charms);
  return loadLocalCharms({ force: true });
}

async function mutateLocal(fn) {
  await loadLocalCharms();
  const next = fn(localStore.charms);
  if (next === localStore.charms) return localStore.saved;
  localStore.charms = next;
  localStore.pending += 1;
  notifyLocal();
  try {
    localStore.saved = await kvSet(LOCAL_CHARMS_KEY, next);
  } catch (e) {
    localStore.saved = false;
    console.warn('この端末で足した護石を保存できませんでした', e);
  } finally {
    localStore.pending -= 1;
    notifyLocal();
  }
  return localStore.saved;
}

/** 護石を足す (id はここで振る)。→ {ids, saved} */
export async function addLocalCharms(charms) {
  const ids = [];
  const saved = await mutateLocal((list) => {
    const out = [...list];
    for (const c of charms) {
      const id = nextLocalId(out);
      const s = sanitizeLocalCharm({ ...c, id });
      if (!s) continue;
      ids.push(id);
      out.push(s);
    }
    return ids.length ? out : list;
  });
  return { ids, saved };
}

/** 1 つを直す (id・入れた日・出どころはそのまま) */
export function updateLocalCharm(id, patch) {
  return mutateLocal((list) => (list.some((c) => c.id === id)
    ? list.map((c) => (c.id === id ? sanitizeLocalCharm({ ...c, ...patch, id }) || c : c))
    : list));
}

/** まとめて消す */
export function deleteLocalCharms(ids) {
  const set = new Set(ids);
  return mutateLocal((list) => (list.some((c) => set.has(c.id)) ? list.filter((c) => !set.has(c.id)) : list));
}

/** 今の一覧 (読み終わっていなければ空。hook を使えない所用) */
export function getLocalCharms() {
  return localStore.charms;
}

/** 端末で足した護石の変化を受け取る。戻り値は購読をやめる関数。 */
export function subscribeLocalCharms(fn) {
  localStore.listeners.add(fn);
  return () => localStore.listeners.delete(fn);
}

/**
 * 端末で足した護石を読む hook。初めて使われたときに読み始める。
 * → {status: 'loading'|'ready', charms: [...], saved: true|false|null}
 */
export function useLocalCharms() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    localStore.listeners.add(fn);
    if (localStore.status === 'idle') loadLocalCharms();
    fn(); // 描いてから購読までの間に変わった分
    return () => localStore.listeners.delete(fn);
  }, []);
  return {
    status: localStore.status === 'ready' ? 'ready' : 'loading',
    charms: localStore.charms,
    saved: localStore.saved,
  };
}

// ================================================================ ほかのタブから使う (装備タブなど)

/** data/charms.json の分 + この端末で足した分 (charms.json の要素と同じ形の配列) */
export function mergeCharms(data, local = localStore.charms) {
  return [...((data && data.lists && data.lists.charms) || []), ...(local || [])];
}

/**
 * computeBuild に渡す索引 (data.index の護石に、この端末で足した護石を足したもの)。
 * 同じ id があれば data/charms.json の方を使う。足した護石が無ければ data.index をそのまま返す。
 */
export function charmsIndex(data, local = localStore.charms) {
  const base = data && data.index;
  if (!base || !local || !local.length) return base;
  const charms = new Map(local.map((c) => [c.id, c]));
  for (const [k, v] of base.charms) charms.set(k, v);
  return { ...base, charms };
}

/** charmsIndex の hook 版 (端末で足した護石が変わると作り直す)。computeBuild(build, useCharmsIndex(data)) */
export function useCharmsIndex(data) {
  const { charms } = useLocalCharms();
  return useMemo(() => charmsIndex(data, charms), [data, charms]);
}

/** 装備タブの PickerField 用の items (data/charms.json の分 → この端末の分の順。value は護石の id) */
export function charmPickerItems(data, local = localStore.charms) {
  const ctx = ctxOf(data);
  const item = (c, group) => {
    const kind = charmKind(c, ctx.charmsFixed);
    return {
      value: c.id,
      label: `${charmTitle(c, kind, ctx)}`,
      sub: `${skillsText(c, ctx)} ・ ${slotsLine(c, kind)}`,
      group,
      keywords: c.id,
    };
  };
  return [
    ...((data && data.lists && data.lists.charms) || []).map((c) => item(c, 'Claude が取り込んだ護石')),
    ...(local || []).map((c) => item(c, 'この端末で足した護石')),
  ];
}

// ================================================================ 表示用の言葉

export function ctxOf(data) {
  return {
    rules: (data && data.talismanRules) || { rarities: {}, groups: {} },
    skills: (data && data.index && data.index.skills) || new Map(),
    charmsFixed: (data && data.charmsFixed) || null,
  };
}

function rarityDef(rules, rarity) {
  return rules && rules.rarities && rarity != null ? rules.rarities[String(rarity)] || null : null;
}

function skillName(skillId, ctx, fallback) {
  const s = skillId != null ? ctx.skills.get(skillId) : null;
  return (s && s.name) || fallback || `スキル ${skillId ?? '?'}`;
}

/** スロットの並び。全部 0 なら「なし」 */
export function slotMarks(slots) {
  const a = (Array.isArray(slots) ? slots : []).map((v) => Number(v) || 0);
  return a.some((v) => v > 0) ? formatSlots(a) : 'なし';
}

function slotsLine(c, kind) {
  if (kind === 'fixed') return 'スロットなし (生産する護石)';
  return `防具用 ${slotMarks(c.armorSlots)} ・ 武器用 ${slotMarks(c.weaponSlots)}`;
}

function skillsText(c, ctx) {
  const list = (c.skills || []).map((s) => `${skillName(s.skillId, ctx, s.name)} Lv${s.level}`);
  return list.length ? list.join('、') : 'スキルなし';
}

/** シートから取り込んだ護石の番号「シート No.88」(シートの護石でなければ空) */
export function sheetLabel(c) {
  return c && c.sheetNo != null ? `シート No.${c.sheetNo}` : '';
}

/** スロットを確かめていない護石か (シートの読み取りのスロットを、一番低い形にしたもの) */
export function slotsUnconfirmed(c) {
  return !!(c && c.slotsProvisional === true);
}

function charmTitle(c, kind, ctx) {
  let rarity = c.rarity;
  if (kind === 'fixed' && rarity == null) {
    const f = fixedCharmOf(c, ctx.charmsFixed);
    rarity = f ? f.rarity : null;
  }
  const name = c.name || rarityDef(ctx.rules, rarity)?.name || '名前なし';
  return `${rarity != null ? `レア${rarity} ` : ''}${name}`;
}

function skillNameAt(charm, i, ctx) {
  const s = (charm.skills || [])[i];
  return s ? skillName(s.skillId, ctx, s.name) : 'スキル';
}

/** validateCharm の 1 件 (errors / warnings の要素) をやさしい言葉に */
function issueText(issue, charm, ctx) {
  const r = charm.rarity;
  const rr = rarityDef(ctx.rules, r);
  const i = issue.skillIndex;
  const s = i != null ? (charm.skills || [])[i] : null;
  const nm = i != null ? skillNameAt(charm, i, ctx) : '';
  const lv = s ? s.level : null;
  const rarities = Object.keys(ctx.rules.rarities || {}).join('・');
  const fixed = fixedCharmOf(charm, ctx.charmsFixed);
  switch (issue.code) {
    case 'charm-invalid':
      return '護石のデータが壊れています。';
    case 'rarity-unknown':
      return `レア度が分かりません (鑑定する護石はレア${rarities})。`;
    case 'name-rarity-mismatch': {
      const hit = Object.entries(ctx.rules.rarities || {}).find(([, v]) => v.name === charm.name);
      return `名前とレア度が合っていません (「${charm.name}」はレア${hit ? hit[0] : '?'} の護石です)。`;
    }
    case 'skill-unknown':
      return `「${(s && s.name) || '名前なし'}」というスキルが見つかりません。`;
    case 'skill-name-mismatch':
      return `スキルの名前「${s && s.name}」と中身 (${nm}) が食い違っています。`;
    case 'level-invalid':
      return `${nm} の Lv が正しくありません。`;
    case 'skill-kind-invalid':
      return `${nm} はシリーズスキル・グループスキルなので、護石には付きません。`;
    case 'level-over-max': {
      const def = s ? ctx.skills.get(s.skillId) : null;
      return `${nm} は Lv${def ? def.maxLevel : '?'} までのスキルです (Lv${lv} になっています)。`;
    }
    case 'skill-not-in-pool':
      return `${nm} はレア${r} の護石には付きません。`;
    case 'level-over-pool-max': {
      const max = s && rr && rr.skillMaxLevel ? rr.skillMaxLevel[String(s.skillId)] : null;
      return `${nm} はレア${r} の護石では Lv${max ?? '?'} までです (Lv${lv} になっています)。`;
    }
    case 'too-many-skills':
      return `レア${r} の護石のスキルは ${rr ? rr.maxSkills : '?'} つまでです。`;
    case 'too-few-skills':
      return `レア${r} の護石にはスキルが ${rr ? rr.minSkills : '?'} つ以上付きます。`;
    case 'slot-invalid':
      return 'スロットの Lv は 0〜3 です。';
    case 'slots-not-possible':
      return `レア${r} の護石に、このスロット (防具用 ${slotMarks(charm.armorSlots)}・武器用 ${slotMarks(charm.weaponSlots)}) は付きません。`;
    case 'skill-kind-position':
      return `武器スキルと防具スキルの数が、レア${r} のこのスロットの護石では出ない組み合わせです。`;
    case 'slots-skill-combination':
      return 'このスキルの組み合わせは、別のスロットの護石でしか出ません。';
    case 'combination-not-in-table':
      return 'このスキルと Lv の組み合わせは、ゲームでは出ません。';
    case 'fixed-unknown':
      return '生産する護石の番号が見つかりません。';
    case 'fixed-skills-mismatch':
      return `生産する護石「${fixed ? fixed.name : charm.name}」とスキルが違います。`;
    case 'fixed-rarity-mismatch':
      return `生産する護石「${fixed ? fixed.name : charm.name}」はレア${fixed ? fixed.rarity : '?'} です。`;
    case 'fixed-has-slots':
      return `生産する護石「${fixed ? fixed.name : charm.name}」にはスロットが付きません。`;
    case 'not-exact':
      return 'スキルの Lv が、ゲームで決まっている Lv より低くなっています (読み違いかもしれません)。';
    case 'duplicate-skill':
      return `${nm} が 2 回入っています (読み違いかもしれません)。`;
    case 'name-unknown':
      return `「${charm.name}」は知らない護石の名前です (計算には関係ありません)。`;
    default:
      return issue.message || '確かめてください。';
  }
}

/** 護石を検証して、結果とやさしい言葉の一覧を返す → {check, issues: [{level: 'error'|'warn', code, text}]} */
export function checkCharm(charm, ctx) {
  let check;
  try {
    check = validateCharm(charm, ctx.rules, ctx.skills, { charmsFixed: ctx.charmsFixed });
  } catch (e) {
    check = { ok: false, kind: 'random', errors: [{ code: 'charm-invalid', message: String(e) }], warnings: [], matches: [] };
  }
  const issues = [
    ...check.errors.map((e) => ({ level: 'error', code: e.code, text: issueText(e, charm, ctx) })),
    ...check.warnings.map((w) => ({ level: 'warn', code: w.code, text: issueText(w, charm, ctx) })),
  ];
  return { check, issues };
}

/** 同じ護石かを比べるための文字列 (レア度・スロット・スキルと Lv。スキルの並び順は問わない) */
export function charmSignature(c) {
  const sk = (c.skills || []).map((s) => `${s.skillId}:${s.level}`).sort().join(',');
  return [c.rarity ?? '', normalizeSlots(c.armorSlots, 3).join(','), normalizeSlots(c.weaponSlots, 1).join(','), sk].join('|');
}

// ================================================================ 一覧の絞り込み (シートの護石が 250 個あるため)

/** 一覧に一度に出す数 (シートの護石は 250 個あるので、iPhone で描く量を抑える。「さらに出す」で足す) */
export const CHARM_PAGE = 40;

/** 一覧の絞り方 */
export const CHARM_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'unconfirmed', label: 'スロット未確認' },
  { value: 'issue', label: '注意・エラー' },
];

function entryMatches(e, filter) {
  if (filter === 'unconfirmed') return slotsUnconfirmed(e.charm);
  if (filter === 'issue') return e.issues.length > 0;
  return true;
}

/**
 * 一覧の行 (makeEntries の要素) を、探す言葉と絞り方で絞る。
 * 言葉は空白で区切ると全部を含むもの。数だけ (「88」「No.88」) はシートの No. か番号 (c0001 など) と同じもの。
 * ほかはレア度・名前・スキルの名前・番号のどれかに含むもの (全角/半角・ひらがな/カタカナはそろえて比べる)。
 */
export function filterCharmEntries(entries, { query = '', filter = 'all' } = {}, ctx) {
  const tokens = String(query || '').split(/[\s　]+/).map((t) => normalizeSearch(t)).filter(Boolean);
  return entries.filter((e) => {
    if (!entryMatches(e, filter)) return false;
    if (!tokens.length) return true;
    const c = e.charm;
    if (!e.__search) {
      e.__search = normalizeSearch(`${charmTitle(c, e.kind, ctx)} ${skillsText(c, ctx)} ${c.id} ${sheetLabel(c)}`);
    }
    return tokens.every((t) => {
      const m = /^(?:no\.?)?(\d+)$/.exec(t);
      if (m) return Number(m[1]) === Number(c.sheetNo) || normalizeSearch(c.id) === t || normalizeSearch(c.id).endsWith(m[1].padStart(4, '0'));
      return e.__search.includes(t);
    });
  });
}

/** 絞り方ごとの数 {all, unconfirmed, issue} */
export function charmFilterCounts(entries) {
  const out = {};
  for (const f of CHARM_FILTERS) out[f.value] = entries.filter((e) => entryMatches(e, f.value)).length;
  return out;
}

// ================================================================ 手で足すときの選択肢 (抽選表から)

/** 鑑定する護石のレア度 [{rarity, name}] (小さい順) */
export function rarityChoices(rules) {
  return Object.keys((rules && rules.rarities) || {})
    .map(Number).filter(Number.isFinite).sort((a, b) => a - b)
    .map((r) => ({ rarity: r, name: rules.rarities[String(r)].name || '' }));
}

/** スロット構成のキー "2,1,0|0" (防具用 3 つ | 武器用 1 つ。大きい順にそろえる) */
export function slotKeyOf(armor, weapon) {
  return `${normalizeSlots(armor, 3).join(',')}|${normalizeSlots(weapon, 1).join(',')}`;
}

/** そのレア度にあり得るスロット構成 [{key, armor, weapon}] (抽選表に出てくる順) */
export function slotChoices(rules, rarity) {
  const rr = rarityDef(rules, rarity);
  if (!rr) return [];
  const seen = new Map();
  for (const p of rr.patterns || []) {
    const key = slotKeyOf(p.armor, p.weapon);
    if (!seen.has(key)) seen.set(key, { key, armor: normalizeSlots(p.armor, 3), weapon: normalizeSlots(p.weapon, 1) });
  }
  return [...seen.values()];
}

function patternsFor(rules, rarity, key) {
  const rr = rarityDef(rules, rarity);
  if (!rr) return [];
  return (rr.patterns || []).filter((p) => slotKeyOf(p.armor, p.weapon) === key);
}

const groupCache = new WeakMap();
function groupsOf(rules) {
  let m = groupCache.get(rules);
  if (!m) {
    m = new Map();
    for (const [g, list] of Object.entries(rules.groups || {})) m.set(Number(g), list);
    groupCache.set(rules, m);
  }
  return m;
}

/** スキルの並び順 (抽選表の群を番号順に見て、初めて出た順) */
const orderCache = new WeakMap();
function skillOrderOf(rules) {
  let m = orderCache.get(rules);
  if (!m) {
    m = new Map();
    const groups = [...groupsOf(rules).entries()].sort((a, b) => a[0] - b[0]);
    for (const [, list] of groups) for (const e of list) if (!m.has(e.skillId)) m.set(e.skillId, m.size);
    orderCache.set(rules, m);
  }
  return m;
}

function inGroup(groups, g, pick) {
  return (groups.get(g) || []).some((e) => e.skillId === pick.skillId && e.level === pick.level);
}

function positionsOf(p) {
  return p.skillGroups.map((g, i) => (g ? i : -1)).filter((i) => i >= 0);
}

/** picks を行 p の枠 (positions) に 1 つずつ当てはめられるか (その枠の群に、同じスキルが同じ Lv であること) */
function assignable(picks, positions, p, groups) {
  if (picks.length > positions.length) return false;
  if (!picks.length) return true;
  const [first, ...rest] = picks;
  return positions.some((pos, i) => inGroup(groups, p.skillGroups[pos], first)
    && assignable(rest, positions.filter((_, j) => j !== i), p, groups));
}

/**
 * スキル枠 index で選べるスキルと Lv。ほかの枠で選んだもの (picks の index 以外) と一緒に、
 * そのレア度・スロット構成の抽選表のどれかの行に当てはまるものだけ。スキルの並び順は問わない。
 * picks: [{skillId, level} | null, ...]
 * → [{skillId, level, kind: 'weapon'|'armor'}] (武器スキル → 防具スキル、抽選表の順)
 */
export function skillChoices(rules, rarity, key, picks, index) {
  const groups = groupsOf(rules);
  const others = picks.filter((p, i) => i !== index && p);
  const found = new Map();
  for (const p of patternsFor(rules, rarity, key)) {
    const pos = positionsOf(p);
    if (others.length + 1 > pos.length) continue;
    pos.forEach((k, i) => {
      if (!assignable(others, pos.filter((_, j) => j !== i), p, groups)) return;
      const g = p.skillGroups[k];
      const kind = (rules.groupKinds && rules.groupKinds[String(g)]) || null;
      for (const e of groups.get(g) || []) {
        if (others.some((o) => o.skillId === e.skillId)) continue; // 同じスキルは 2 つ付かない
        const id = `${e.skillId}:${e.level}`;
        if (!found.has(id)) found.set(id, { skillId: e.skillId, level: e.level, kind });
      }
    });
  }
  const order = skillOrderOf(rules);
  const kindRank = (k) => (k === 'weapon' ? 0 : k === 'armor' ? 1 : 2);
  return [...found.values()].sort((a, b) => kindRank(a.kind) - kindRank(b.kind)
    || (order.get(a.skillId) ?? 1e9) - (order.get(b.skillId) ?? 1e9) || a.level - b.level);
}

/**
 * 今選んでいるスキルの状態。
 * → {complete: このまま足せる, canAddMore: もう 1 つ付く行もある, need: 足りない最少の数, possible: どれかの行に当てはまる見込みがある}
 */
export function pickStatus(rules, rarity, key, picks) {
  const groups = groupsOf(rules);
  const chosen = picks.filter(Boolean);
  const dup = new Set(chosen.map((c) => c.skillId)).size !== chosen.length;
  let complete = false;
  let more = false;
  let need = Infinity;
  for (const p of patternsFor(rules, rarity, key)) {
    const pos = positionsOf(p);
    if (!assignable(chosen, pos, p, groups)) continue;
    if (pos.length === chosen.length) complete = true;
    else {
      more = true;
      need = Math.min(need, pos.length - chosen.length);
    }
  }
  return {
    complete: complete && !dup,
    canAddMore: more && !dup,
    need: Number.isFinite(need) ? need : 0,
    possible: (complete || more) && !dup,
  };
}

/** 選んだ内容から護石 (charms.json の要素の形。id などは除く) を作る */
export function charmFromPicks(rules, rarity, key, picks, ctx) {
  const rr = rarityDef(rules, rarity);
  const [a, w] = String(key || '').split('|');
  return {
    name: rr ? rr.name : null,
    rarity,
    skills: picks.filter(Boolean).map((p) => ({ skillId: p.skillId, name: skillName(p.skillId, ctx), level: p.level })),
    armorSlots: (a || '0,0,0').split(',').map(Number),
    weaponSlots: (w || '0').split(',').map(Number),
  };
}

// ================================================================ 書き出し / 読み込み

/** 泣シミュ形式 (1 行 12 項目) にする。生産する護石・書き出せないものは飛ばす。→ {text, count, skipped} */
export function nakiSimExport(charms, ctx) {
  const rows = [];
  const skipped = [];
  for (const c of charms) {
    if (charmKind(c, ctx.charmsFixed) === 'fixed') {
      skipped.push({ charm: c, reason: '生産する護石' });
      continue;
    }
    try {
      rows.push(toNakiSimRow(c, ctx.skills));
    } catch (e) {
      skipped.push({ charm: c, reason: '書き出せない' });
    }
  }
  return { text: rows.join('\n'), count: rows.length, skipped };
}

function bumpCharmId(id) {
  const n = Number(String(id).replace(/^c/, '')) + 1;
  return `c${String(n).padStart(4, '0')}`;
}

/** data/charms.json と同じ書き方の JSON (1 個ずつ。スキルは 1 行に 1 つ) */
function charmsJsonText(items) {
  const q = (v) => JSON.stringify(v);
  const body = items.map((c) => [
    '  {',
    `   "id": ${q(c.id)},`,
    `   "name": ${q(c.name)},`,
    `   "rarity": ${q(c.rarity)},`,
    '   "skills": [',
    c.skills.map((s) => `    {"skillId": ${q(s.skillId)}, "name": ${q(s.name)}, "level": ${q(s.level)}}`).join(',\n'),
    '   ],',
    `   "armorSlots": [${c.armorSlots.join(', ')}],`,
    `   "weaponSlots": [${c.weaponSlots.join(', ')}],`,
    `   "source": ${q(c.source)},`,
    `   "addedAt": ${q(c.addedAt)},`,
    `   "note": ${q(c.note)}`,
    '  }',
  ].join('\n'));
  return `[\n${body.join(',\n')}\n]`;
}

/**
 * Claude に渡す用のテキスト (説明の数行 + data/charms.json の "charms" に足せる JSON の配列)。
 * id は data/charms.json の続きの番号 (c0002 など) を振る。
 */
export function claudeExportText(localCharms, dataCharms, ctx, { today = todayText() } = {}) {
  let id = nextCharmId(dataCharms);
  const first = id;
  let bad = 0;
  const items = localCharms.map((c) => {
    if (!checkCharm(c, ctx).check.ok) bad += 1;
    const item = {
      id,
      name: c.name || rarityDef(ctx.rules, c.rarity)?.name || null,
      rarity: c.rarity,
      skills: (c.skills || []).map((s) => ({ skillId: s.skillId, name: skillName(s.skillId, ctx, s.name), level: s.level })),
      armorSlots: slotsArr(c.armorSlots, 3),
      weaponSlots: slotsArr(c.weaponSlots, 1),
      source: c.source || `手入力 ${today}`,
      addedAt: c.addedAt || today,
      note: c.note || '',
    };
    id = bumpCharmId(id);
    return item;
  });
  const last = items.length ? items[items.length - 1].id : first;
  const lines = [
    '護石の追加 (片手剣ビルドのアプリから)',
    `data/charms.json の "charms" の最後に、下の ${items.length} 個を足してください。`,
    `id は今の data/charms.json の続き (${first}${items.length > 1 ? `〜${last}` : ''}) にしてあります。`,
    bad ? `※ ${bad} 個はアプリの検証に通っていません。足す前に確かめてください。` : 'アプリの検証 (talisman_rules.json) には全部通っています。',
    '',
    charmsJsonText(items),
  ];
  return lines.join('\n');
}

function importErrorText(e, fields) {
  switch (e.code) {
    case 'field-count':
      return `項目が ${fields.length} 個あります (12 個のはずです)。`;
    case 'level-without-skill':
      return `${e.message.replace(/ の名前が空なのに Lv が .*$/, '')} の名前が空なのに Lv が入っています。`;
    case 'level-invalid':
      return `${e.message}。`;
    case 'skill-unknown': {
      const nm = e.skillIndex != null ? String(fields[e.skillIndex * 2] || '').trim() : '';
      return `「${nm}」というスキルが見つかりません。`;
    }
    case 'slot-invalid':
      return 'スロットの Lv は 0〜3 の数で入れてください。';
    default:
      return e.message;
  }
}

/**
 * 泣シミュ形式の貼り付けを読む (空行は飛ばす。カンマのほかタブ区切りも読む)。
 * → [{n: 何行目, line, charm (レア度なし) | null, errors: [文], notes: [文], rarities: [あり得るレア度]}]
 */
export function parseImportText(text, ctx, { today = todayText() } = {}) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 300);
  return lines.map((line, i) => {
    const norm = line.replace(/，/g, ',');
    const fields = (norm.includes(',') ? norm.split(',') : norm.split('\t')).map((x) => x.trim());
    let r;
    try {
      r = parseNakiSimRow(fields, ctx.skills, { rules: ctx.rules, source: `泣シミュ形式 ${today}`, addedAt: today });
    } catch (e) {
      r = { charm: null, errors: [{ code: 'error', message: '読み取れませんでした。' }], warnings: [] };
    }
    const errors = r.errors.map((e) => importErrorText(e, fields));
    const rarities = r.possibleRarities || [];
    if (!errors.length && !rarities.length) {
      errors.push('どのレア度の護石の決まりにも合いません (書き間違いかもしれません)。');
    }
    const notes = r.warnings.map((w) => w.message.replace(/と読んだ$/, 'として読みました'));
    return { n: i + 1, line, charm: errors.length ? null : r.charm, errors, notes, rarities };
  });
}

// ================================================================ 画面: 部品

function StatusBadge({ entry }) {
  if (entry.check.errors.length) return html`<${Badge} kind="error">エラー</${Badge}>`;
  if (entry.check.warnings.length) return html`<${Badge} kind="warn">注意</${Badge}>`;
  return html`<${Badge} kind="ok">OK</${Badge}>`;
}

function IssueLines({ issues }) {
  return issues.map((x) => html`
    <span class="charm-issue" style=${`display:block;color:var(${x.level === 'error' ? '--danger' : '--warn'})`}>${x.text}</span>`);
}

/** 一覧の 1 行 (タップで詳しく) */
function CharmRow({ entry, ctx, equipped, onOpen }) {
  const c = entry.charm;
  return html`
    <button type="button" class="row row-button" data-charm-id=${c.id} data-charm-origin=${entry.origin}
      onClick=${onOpen}>
      <span class="row-main">
        <span class="row-label">
          ${charmTitle(c, entry.kind, ctx)}${c.sheetNo != null ? html` <span class="charm-sheet-no">${sheetLabel(c)}</span>` : ''}
          ${slotsUnconfirmed(c) && html` <${Badge} kind="unconfirmed">スロット未確認</${Badge}>`}
          ${equipped && html` <${Badge} kind="info">装備中</${Badge}>`}
          ${entry.importedAs && html` <${Badge} kind="ok">取り込み済み</${Badge}>`}
        </span>
        <span class="row-value">${skillsText(c, ctx)}</span>
        <span class="row-sub">
          <span style="display:block">${slotsLine(c, entry.kind)}</span>
          <${IssueLines} issues=${entry.issues} />
        </span>
      </span>
      <span class="row-end"><${StatusBadge} entry=${entry} /></span>
      <span class="row-chevron" aria-hidden="true">›</span>
    </button>`;
}

function Pad({ children }) {
  return html`<div style="padding: 8px 16px 12px">${children}</div>`;
}

function PhotoNotice() {
  return html`
    <${Notice} kind="info" title="写真で足すには">
      <p>iPhone でゲームの護石の画面を撮って、Claude に「護石取り込んで」と送ってください。</p>
      <p>Claude が写真を読み取って足します。足した護石は、アプリが次に新しくなったときに「Claude が取り込んだ護石」に出ます。</p>
      <p>Google ドライブの所持護石の表を直したときは、Claude に「護石のシートを取り込んで」と送ってください。</p>
    </${Notice}>`;
}

function ValidationNotice({ entry }) {
  const errors = entry.issues.filter((x) => x.level === 'error');
  const warns = entry.issues.filter((x) => x.level === 'warn');
  if (!errors.length && !warns.length) {
    return html`
      <${Notice} kind="ok" title="ゲームの決まりと合っています">
        <p>${entry.kind === 'fixed' ? '生産する護石のスキルと合っています。' : 'このレア度・スロットで実際に出る組み合わせです。'}</p>
      </${Notice}>`;
  }
  return html`
    ${errors.length > 0 && html`
      <${Notice} kind="error" title="ゲームでは出ない組み合わせです">
        ${errors.map((x) => html`<p>${x.text}</p>`)}
        <p class="hint">写真の読み違いか、入れ間違いかもしれません。</p>
      </${Notice}>`}
    ${warns.length > 0 && html`
      <${Notice} kind="warn" title="確かめてください">
        ${warns.map((x) => html`<p>${x.text}</p>`)}
      </${Notice}>`}`;
}

// ---------------------------------------------------------------- 詳しく (シート)

// シートはどれも、開くたびに新しく作る (親が key を変えて描く)。前に開いたときの値が一瞬見えないように。
function DetailSheet({ entry, ctx, equippedId, onClose, onEdit }) {
  const [confirmDel, setConfirmDel] = useState(false);
  const [busy, setBusy] = useState(false);
  const c = entry.charm;
  const isLocal = entry.origin === 'local';
  const isEquipped = equippedId === c.id;
  let nakiRow = null;
  if (entry.kind !== 'fixed') {
    try {
      nakiRow = toNakiSimRow(c, ctx.skills);
    } catch {
      nakiRow = null;
    }
  }

  const equip = () => {
    setCharm(c.id);
    toast('装備の護石にしました');
  };
  const unequip = () => {
    setCharm(null);
    toast('装備から護石を外しました');
  };
  const openEquip = () => {
    onClose();
    setTab('equip');
  };
  const copyRow = async () => {
    const ok = nakiRow && (await copyText(nakiRow));
    toast(ok ? '泣シミュ形式でコピーしました' : 'コピーできませんでした', { kind: ok ? 'info' : 'error' });
  };
  const askText = `護石 ${c.id} (${charmTitle(c, entry.kind, ctx)}・${skillsText(c, ctx)}) を data/charms.json から消してください。`;
  const copyAsk = async () => {
    const ok = await copyText(askText);
    toast(ok ? 'Claude に頼む文をコピーしました' : 'コピーできませんでした', { kind: ok ? 'info' : 'error' });
  };
  const remove = async () => {
    setBusy(true);
    // 装備の付け替えは消す前に済ませる (保存を待つ間に装備が古い護石を指したままにならないように)
    if (getState().build.charm === c.id) {
      // Claude が取り込んだ同じ護石があればそちらに付け替える (スロットも同じなので装飾品はそのまま)
      if (entry.importedAs) setCharm(entry.importedAs, { keepDecorations: true });
      else setCharm(null);
    }
    try {
      await deleteLocalCharms([c.id]);
      toast('消しました');
      onClose();
    } catch (e) {
      setBusy(false);
      toast(`消せませんでした (${e.message || e})`, { kind: 'error' });
    }
  };

  const rows = [
    ['どこの護石', isLocal ? 'この端末で足した分' : 'Claude が取り込んだ分'],
    c.sheetNo != null && ['シートの番号', `No.${c.sheetNo}`],
    ['種類', entry.kind === 'fixed' ? '生産する護石' : '鑑定する護石'],
    ['スキル', html`${(c.skills || []).length ? (c.skills || []).map((s) => html`
      <span style="display:block">${skillName(s.skillId, ctx, s.name)} Lv${s.level}</span>`) : 'なし'}`],
    entry.kind !== 'fixed' && ['防具用スロット', slotMarks(c.armorSlots)],
    entry.kind !== 'fixed' && ['武器用スロット', slotMarks(c.weaponSlots)],
    c.addedAt && ['入れた日', c.addedAt],
    c.source && ['入れ方', c.source],
    c.note && ['メモ', c.note],
    ['番号', c.id],
  ];

  // 装備にするボタンはシートの下に固定して出す (中身が長くても見えるように)
  const footer = isEquipped ? html`
    <div class="btn-row" style="margin-top:0">
      <${Button} onClick=${unequip} data-charm-action="unequip">装備から外す</${Button}>
      <${Button} variant="primary" onClick=${openEquip}>装備タブで見る</${Button}>
    </div>` : html`
    <${Button} variant="primary" block onClick=${equip} data-charm-action="equip">装備の護石にする</${Button}>`;

  return html`
    <${BottomSheet} open=${true} title=${charmTitle(c, entry.kind, ctx)} onClose=${onClose} footer=${footer}>
      <div class="stack" data-charm-sheet="detail" data-charm-id=${c.id}>
        ${isEquipped && html`<p class="hint" style="margin-top:0"><${Badge} kind="info">装備中</${Badge}> 今の装備の護石です。</p>`}
        <${KeyValue} rows=${rows} />
        ${slotsUnconfirmed(c) && html`
          <${Notice} kind="unconfirmed" title="スロットはまだ確かめていません">
            <p>シートのスロットの Lv は、動画の読み取りで当てになりません。数だけを使い、ゲームで出る一番低い Lv にしています。</p>
            <p>シートの値は ${Array.isArray(c.sheetSlots) && c.sheetSlots.length ? c.sheetSlots.join('・') : 'なし'} です。ゲームの画面で確かめて、違っていたら Claude に伝えてください。</p>
          </${Notice}>`}
        <${ValidationNotice} entry=${entry} />
        ${entry.importedAs && html`
          <${Notice} kind="ok" title="Claude が取り込み済みです">
            <p>Claude が取り込んだ護石 (番号 ${entry.importedAs}) と同じです。この端末の分は消してかまいません。</p>
          </${Notice}>`}
        <div class="btn-col" style="margin-top:0">
          ${nakiRow && html`<${Button} block onClick=${copyRow}>泣シミュ形式でコピー</${Button}>`}
          ${isLocal && html`<${Button} block onClick=${() => onEdit(c)} data-charm-action="edit">直す</${Button}>`}
          ${isLocal && !confirmDel && html`
            <${Button} variant="danger" block onClick=${() => setConfirmDel(true)} data-charm-action="delete">消す</${Button}>`}
        </div>
        ${isLocal && confirmDel && html`
          <${Notice} kind="warn" title="この護石を消しますか"
            actions=${html`
              <${Button} variant="danger" onClick=${remove} disabled=${busy} data-charm-action="delete-confirm">消す</${Button}>
              <${Button} variant="ghost" onClick=${() => setConfirmDel(false)} disabled=${busy}>やめる</${Button}>`}>
            <p>${isEquipped ? (entry.importedAs ? '装備の護石は、Claude が取り込んだ同じ護石に付け替えます。' : '装備の護石からも外れます。') : '元に戻せません。'}</p>
          </${Notice}>`}
        ${!isLocal && html`
          <${Notice} kind="info" title="ここでは消したり直したりできません"
            actions=${html`<${Button} onClick=${copyAsk}>「消して」と頼む文をコピー</${Button}>`}>
            <p>Claude が取り込んだ護石は、この画面では消したり直したりできません。消したい・直したいときは、Claude に「護石 ${c.id} を消して」のように頼んでください。</p>
          </${Notice}>`}
        ${nakiRow && html`<p class="hint">泣シミュ形式: <code>${nakiRow}</code></p>`}
      </div>
    </${BottomSheet}>`;
}

// ---------------------------------------------------------------- 足す・直す (シート)

const EMPTY_PICKS = [null, null, null];

function pickValue(p) {
  return p ? `${p.skillId}:${p.level}` : null;
}

function parsePick(v) {
  if (v == null) return null;
  const [a, b] = String(v).split(':').map(Number);
  return Number.isInteger(a) && Number.isInteger(b) ? { skillId: a, level: b } : null;
}

const KIND_GROUP = { weapon: '武器スキル', armor: '防具スキル' };

function slotChoiceLabel(o) {
  const w = o.weapon.some((v) => v > 0);
  const a = o.armor.some((v) => v > 0);
  return `${a ? `防具 ${formatSlots(o.armor)}` : '防具 なし'}${w ? ` ・ 武器 ${formatSlots(o.weapon)}` : ''}`;
}

function initialPicks(initial) {
  const p = ((initial && initial.skills) || []).slice(0, 3)
    .map((s) => (s.skillId != null ? { skillId: s.skillId, level: Number(s.level) } : null));
  while (p.length < 3) p.push(null);
  return p;
}

/** 足す (initial = null) / 直す (initial = この端末の護石)。開くたびに新しく作るので、初期値は useState で入れる。 */
function EditorSheet({ initial, ctx, existing, onClose, onSaved }) {
  const rules = ctx.rules;
  const [rarity, setRarity] = useState(() => (initial ? initial.rarity ?? null : null));
  const [slotKey, setSlotKey] = useState(() => (initial ? slotKeyOf(initial.armorSlots, initial.weaponSlots) : null));
  const [picks, setPicks] = useState(() => (initial ? initialPicks(initial) : EMPTY_PICKS));
  const [note, setNote] = useState(() => (initial && initial.note) || '');
  const [resetNote, setResetNote] = useState(null);
  const [busy, setBusy] = useState(false);

  const rarities = useMemo(() => rarityChoices(rules), [rules]);
  const rr = rarityDef(rules, rarity);
  const slotOpts = useMemo(() => (rarity != null ? slotChoices(rules, rarity) : []), [rules, rarity]);
  const maxSkills = Math.min(3, (rr && rr.maxSkills) || 3);

  const keepOrReset = (r, k, p) => {
    if (r != null && k && p.some(Boolean) && !pickStatus(rules, r, k, p).possible) {
      setPicks(EMPTY_PICKS);
      setResetNote('レア度かスロットを変えたので、スキルを選び直してください。');
    } else {
      setResetNote(null);
    }
  };
  const chooseRarity = (r) => {
    if (r === rarity) return;
    setRarity(r);
    const opts = slotChoices(rules, r);
    const k = opts.some((o) => o.key === slotKey) ? slotKey : opts.length === 1 ? opts[0].key : null;
    setSlotKey(k);
    if (!k) {
      if (picks.some(Boolean)) setResetNote('レア度を変えたので、スロットとスキルを選び直してください。');
      setPicks(EMPTY_PICKS);
    } else keepOrReset(r, k, picks);
  };
  const chooseSlot = (k) => {
    if (k === slotKey) return;
    setSlotKey(k);
    keepOrReset(rarity, k, picks);
  };
  const setPick = (i, v) => {
    const next = [...picks];
    next[i] = parsePick(v);
    setPicks(next);
    setResetNote(null);
  };

  const ready = rarity != null && rr && slotKey;
  const status = ready ? pickStatus(rules, rarity, slotKey, picks) : null;
  const candidate = ready ? charmFromPicks(rules, rarity, slotKey, picks, ctx) : null;
  const result = candidate && status.complete ? checkCharm(candidate, ctx) : null;
  const canSave = !!(result && result.check.ok) && !busy;
  const dup = candidate && status.complete
    && existing.some((c) => (!initial || c.id !== initial.id) && charmSignature(c) === charmSignature(candidate));

  let statusText;
  if (rarity == null) {
    statusText = `まずレア度を選んでください (${rarities.map((x) => `${x.name} = レア${x.rarity}`).join('、')})。`;
  }
  else if (!slotKey) statusText = '次にスロットを選んでください (装飾品を入れる穴。①②③ は穴の大きさ)。';
  else if (status.complete && status.canAddMore) statusText = 'このまま足せます。スキルがもう 1 つ付いていれば選んでください。';
  else if (status.complete) statusText = 'このまま足せます。';
  else if (status.possible) statusText = `スキルをあと ${status.need} つ選んでください。`;
  else statusText = 'この組み合わせはゲームでは出ません。スキルを選び直してください。';

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    try {
      if (initial) {
        await updateLocalCharm(initial.id, { ...candidate, note });
        toast('直しました');
        onSaved(initial.id);
      } else {
        const today = todayText();
        const { ids } = await addLocalCharms([{ ...candidate, note, source: `手入力 ${today}`, addedAt: today }]);
        toast('足しました');
        onSaved(ids[0] || null);
      }
    } catch (e) {
      setBusy(false); // うまくいったときはシートが閉じる (このあと描かない) ので、失敗したときだけ戻す
      toast(`保存できませんでした (${e.message || e})`, { kind: 'error' });
    }
  };

  const noRules = !rarities.length;
  return html`
    <${BottomSheet} open=${true} title=${initial ? '護石を直す' : '護石を足す'} onClose=${onClose} tall
      footer=${html`
        <${Button} variant="primary" block disabled=${!canSave} onClick=${save} data-charm-action="save">
          ${initial ? 'この内容で直す' : 'この護石を足す'}
        </${Button}>`}>
      <div class="stack" data-charm-sheet="editor">
        ${noRules && html`<${Notice} kind="error" title="護石の決まりのデータがありません">
          <p>鑑定護石の決まりのデータが読めていません。設定タブの「新しい版を確かめる」か、再読み込みを試してください。</p></${Notice}>`}
        <${Hint}>ゲームで出る組み合わせだけを選べるようにしています。</${Hint}>
        <div data-charm-field="rarity">
          <${Segmented} label="1. レア度" value=${rarity} onChange=${chooseRarity}
            options=${rarities.map((x) => ({ value: x.rarity, label: `レア${x.rarity}` }))} />
          ${rr && html`<p class="hint">レア${rarity} = ${rr.name}</p>`}
        </div>
        ${rarity != null && html`
          <div data-charm-field="slots">
            <${Segmented} label="2. スロット" value=${slotKey} onChange=${chooseSlot}
              options=${slotOpts.map((o) => ({ value: o.key, label: slotChoiceLabel(o) }))} />
            <p class="hint">防具 = 防具用の装飾品の穴、武器 = 武器用の装飾品の穴。レア${rarity} で付くものだけを出しています。</p>
          </div>`}
        ${ready && html`
          <div data-charm-field="skills">
            <div class="field-head"><span class="field-label">3. スキル</span></div>
            ${Array.from({ length: maxSkills }, (_, i) => {
              const choices = skillChoices(rules, rarity, slotKey, picks, i);
              const items = choices.map((x) => {
                const g = KIND_GROUP[x.kind] || 'スキル';
                return { value: `${x.skillId}:${x.level}`, label: `${skillName(x.skillId, ctx)} Lv${x.level}`, group: g };
              });
              const cur = picks[i];
              const value = pickValue(cur);
              const inItems = cur && items.some((it) => it.value === value);
              return html`
                <div key=${i} data-charm-skill=${i}>
                  <${PickerField} label=${`スキル ${i + 1}`} title=${`スキル ${i + 1} を選ぶ`} items=${items} value=${value}
                    onChange=${(v) => setPick(i, v)} allowNone noneLabel="なし (付いていない)"
                    searchPlaceholder="スキルの名前で探す"
                    placeholder=${items.length ? '選んでください' : 'これ以上は付きません'}
                    display=${cur && !inItems ? `${skillName(cur.skillId, ctx)} Lv${cur.level} (この組み合わせでは付きません)` : undefined}
                    disabled=${!items.length && !cur} />
                </div>`;
            })}
          </div>`}
        <p class=${`hint${ready && !status.possible ? ' text-danger' : ''}`} data-charm-status="1">${statusText}</p>
        ${resetNote && html`<${Notice} kind="warn" title="選び直してください">${resetNote}</${Notice}>`}
        ${result && !result.check.ok && html`
          <${Notice} kind="error" title="ゲームでは出ない組み合わせです">
            ${result.issues.filter((x) => x.level === 'error').map((x) => html`<p>${x.text}</p>`)}
          </${Notice}>`}
        ${dup && html`
          <${Notice} kind="warn" title="同じ護石がもうあります">
            <p>同じレア度・スロット・スキルの護石が一覧にあります。2 つ持っているならこのまま足してください。</p>
          </${Notice}>`}
        <${TextInput} label="メモ (なくてもよい)" value=${note} onChange=${setNote} onInput=${setNote} maxLength=${100}
          placeholder="例: 2 個目" />
      </div>
    </${BottomSheet}>`;
}

// ---------------------------------------------------------------- 書き出し (シート)

function ExportSheet({ exp, onClose }) {
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const text = exp.text;
  const copy = async () => {
    const ok = await copyText(text);
    toast(ok ? 'コピーしました' : 'コピーできませんでした。下の文字を長押しして選んでください', { kind: ok ? 'info' : 'error', ms: 3500 });
  };
  const share = async () => {
    try {
      await navigator.share({ text });
    } catch (e) {
      if (e && e.name === 'AbortError') return; // 共有シートを閉じた
      const ok = await copyText(text);
      toast(ok ? '共有できなかったので、コピーしました' : '共有できませんでした', { kind: ok ? 'info' : 'error' });
    }
  };
  return html`
    <${BottomSheet} open=${true} title=${exp.title} onClose=${onClose}
      footer=${html`
        <div class="btn-row" style="margin-top:0">
          <${Button} variant="primary" onClick=${copy} data-charm-action="copy">コピーする</${Button}>
          ${canShare && html`<${Button} onClick=${share} data-charm-action="share">共有する</${Button}>`}
        </div>`}>
      <div class="stack" data-charm-sheet="export" data-charm-export=${exp.kind}>
        ${exp.intro}
        <textarea class="input textarea" readonly rows="9" value=${text} aria-label=${exp.title}
          data-charm-export-text="1"></textarea>
      </div>
    </${BottomSheet}>`;
}

// ---------------------------------------------------------------- 泣シミュ形式の読み込み (シート)

function ImportSheet({ ctx, existing, onClose }) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState(null);
  const [choice, setChoice] = useState({});
  const [busy, setBusy] = useState(false);

  const sigs = useMemo(() => new Set(existing.map(charmSignature)), [existing]);
  const decided = (rows || []).map((r) => {
    const rarity = r.rarities.length === 1 ? r.rarities[0] : choice[r.n] ?? null;
    const final = r.charm && rarity != null
      ? { ...r.charm, rarity, name: rarityDef(ctx.rules, rarity)?.name || null } : null;
    return { ...r, rarity, final, dup: final ? sigs.has(charmSignature(final)) : false };
  });
  const addable = decided.filter((r) => r.final && !r.dup);
  const waiting = decided.filter((r) => r.charm && r.rarity == null).length;
  // レア度が 1 つに決まらない行 (泣シミュの形式にレア度が無いため。多くの行がそう) をまとめて選ぶ
  const ambiguous = decided.filter((r) => r.charm && r.rarities.length > 1);
  const bulkOptions = [...new Set(ambiguous.flatMap((r) => r.rarities))].sort((a, b) => a - b);
  const chooseAll = (rarity) => {
    const next = { ...choice };
    for (const r of ambiguous) if (r.rarities.includes(rarity)) next[r.n] = rarity;
    setChoice(next);
  };

  const read = () => {
    setRows(parseImportText(text, ctx));
    setChoice({});
  };
  const add = async () => {
    if (!addable.length) return;
    setBusy(true);
    try {
      const { ids } = await addLocalCharms(addable.map((r) => r.final));
      toast(`${ids.length} 個足しました`);
      onClose();
    } catch (e) {
      setBusy(false);
      toast(`足せませんでした (${e.message || e})`, { kind: 'error' });
    }
  };

  const footer = rows == null
    ? html`<${Button} variant="primary" block disabled=${!text.trim()} onClick=${read} data-charm-action="import-read">読み取る</${Button}>`
    : html`
      <div class="btn-row" style="margin-top:0">
        <${Button} onClick=${() => setRows(null)} disabled=${busy}>貼り直す</${Button}>
        <${Button} variant="primary" onClick=${add} disabled=${busy || !addable.length} data-charm-action="import-add">
          ${addable.length ? `${addable.length} 個を足す` : '足せる護石がありません'}
        </${Button}>
      </div>`;

  return html`
    <${BottomSheet} open=${true} title="泣シミュ形式を読み込む" onClose=${onClose} tall footer=${footer}>
      <div class="stack" data-charm-sheet="import">
        ${rows == null ? html`
          <${Hint}>
            泣シミュの護石の書き出し (1 行に 1 個・12 項目: スキル1, Lv1, スキル2, Lv2, スキル3, Lv3, 防具スロ×3, 武器スロ×3) を
            貼り付けてください。
          </${Hint}>
          <textarea class="input textarea" rows="8" value=${text} aria-label="泣シミュ形式の貼り付け"
            placeholder="例: 攻撃,2,弱点特効,1,,0,1,0,0,1,0,0"
            onInput=${(e) => setText(e.currentTarget.value)}></textarea>` : html`
          <p class="hint" style="margin-top:0">${decided.length} 行を読みました。${waiting ? ` レア度を選ぶ行が ${waiting} 行あります。` : ''}</p>
          ${ambiguous.length > 1 && html`
            <div data-import-bulk="1">
              <${Segmented} label="レア度をまとめて選ぶ (その行であり得るものだけに入ります)" value=${null}
                onChange=${chooseAll} options=${bulkOptions.map((x) => ({ value: x, label: `レア${x}` }))} />
            </div>`}
          ${decided.map((r) => html`
            <div key=${r.n} data-import-row=${r.n} style="padding:10px 0;border-bottom:1px solid var(--border)">
              <div class="hint" style="margin-top:0">${r.n} 行目
                ${r.errors.length ? html` <${Badge} kind="error">読み込めません</${Badge}>`
                  : r.dup ? html` <${Badge} kind="warn">同じ護石がもうあります</${Badge}>`
                    : r.final ? html` <${Badge} kind="ok">足せます</${Badge}>` : html` <${Badge} kind="warn">レア度を選んでください</${Badge}>`}
              </div>
              ${r.errors.length ? html`
                ${r.errors.map((t) => html`<p class="text-danger">${t}</p>`)}
                <p class="hint"><code>${r.line}</code></p>` : html`
                <p>${skillsText(r.charm, ctx)}</p>
                <p class="hint" style="margin-top:2px">${slotsLine(r.charm, 'random')}</p>
                ${r.rarities.length === 1
                  ? html`<p class="hint" style="margin-top:2px">レア${r.rarities[0]} ${rarityDef(ctx.rules, r.rarities[0])?.name || ''}</p>`
                  : html`<${Segmented} label="レア度 (泣シミュの形式には無いので選んでください)" value=${r.rarity}
                      onChange=${(v) => setChoice({ ...choice, [r.n]: v })}
                      options=${r.rarities.map((x) => ({ value: x, label: `レア${x}` }))} />`}
                ${r.dup && html`<p class="hint">同じ護石が一覧にあるので、足しません。</p>`}
                ${r.notes.map((t) => html`<p class="hint">${t}</p>`)}`}
            </div>`)}`}
      </div>
    </${BottomSheet}>`;
}

// ================================================================ 画面: 本体

/** 一覧の行: {charm, origin: 'data'|'local', kind, importedAs, check, issues} (テストからも使う) */
export function makeEntries(dataCharms, localCharms, ctx) {
  const out = [];
  const dataSigs = new Map();
  for (const c of dataCharms) {
    const kind = charmKind(c, ctx.charmsFixed);
    out.push({ charm: c, origin: 'data', kind, importedAs: null, ...checkCharm(c, ctx) });
    if (!dataSigs.has(charmSignature(c))) dataSigs.set(charmSignature(c), c.id);
  }
  for (const c of localCharms) {
    const kind = charmKind(c, ctx.charmsFixed);
    out.push({ charm: c, origin: 'local', kind, importedAs: dataSigs.get(charmSignature(c)) || null, ...checkCharm(c, ctx) });
  }
  return out;
}

/** シートを開くたびに増やす番号 (key にしてシートを新しく作る) */
let sheetSeq = 0;

export default function CharmsTab({ data, active }) {
  const ctx = useMemo(() => ctxOf(data), [data]);
  const local = useLocalCharms();
  const equippedId = useAppState((s) => s.build.charm);
  const [detailId, setDetailId] = useState(null);
  const [editor, setEditor] = useState(null);     // null | {seq, charm: null (足す) | 護石 (直す)}
  const [exp, setExp] = useState(null);           // null | {kind, title, intro, text}
  const [importSeq, setImportSeq] = useState(0);  // 0 = 閉じている。開くたびに増やす (シートを新しく作る)
  const [query, setQuery] = useState('');          // 一覧を探す言葉 (Claude が取り込んだ護石)
  const [listFilter, setListFilter] = useState('all');
  const [limit, setLimit] = useState(CHARM_PAGE);   // 一覧に出す数 (探す言葉・絞り方を変えたら戻す)
  const openEditor = (charm) => setEditor({ seq: ++sheetSeq, charm });

  // タブを開くたびに保存領域と合わせる (設定タブで全データを読み込んだ・初期化したとき用)
  useEffect(() => {
    if (active) refreshLocalCharms();
  }, [active]);

  const dataCharms = (data.lists && data.lists.charms) || [];
  const entries = useMemo(() => makeEntries(dataCharms, local.charms, ctx), [dataCharms, local.charms, ctx]);
  const dataEntries = entries.filter((e) => e.origin === 'data');
  // 一覧が長いとき (シートの護石) は、探す欄と絞り方を出す
  const showTools = dataEntries.length > 8;
  const shownData = useMemo(() => (showTools ? filterCharmEntries(dataEntries, { query, filter: listFilter }, ctx) : dataEntries),
    [entries, showTools, query, listFilter, ctx]);
  const counts = useMemo(() => charmFilterCounts(dataEntries), [entries]);
  const shownRows = shownData.slice(0, limit);
  const rest = shownData.length - shownRows.length;
  const changeQuery = (q) => { setQuery(q); setLimit(CHARM_PAGE); };
  const changeFilter = (f) => { setListFilter(f); setLimit(CHARM_PAGE); };
  const localEntries = entries.filter((e) => e.origin === 'local');
  const imported = localEntries.filter((e) => e.importedAs);
  const detail = detailId ? entries.find((e) => e.charm.id === detailId) || null : null;
  const allCharms = useMemo(() => [...dataCharms, ...local.charms], [dataCharms, local.charms]);

  const cleanup = async () => {
    // 装備がこの端末の分を指していたら、先に Claude が取り込んだ同じ護石へ付け替える (スロットも同じなので装飾品はそのまま)
    const cur = getState().build.charm;
    const hit = imported.find((e) => e.charm.id === cur);
    if (hit) setCharm(hit.importedAs, { keepDecorations: true });
    await deleteLocalCharms(imported.map((e) => e.charm.id));
    toast(`${imported.length} 個を片付けました`);
  };

  const openNaki = () => {
    const r = nakiSimExport(allCharms, ctx);
    setExp({
      kind: 'naki',
      title: '泣シミュ形式',
      text: r.text,
      intro: html`
        <${Hint}>
          泣シミュ (mhwilds.wiki-db.com/sim) の護石の入力に貼り付けられます。1 行が 1 個の護石です
          (スキル1, Lv1, スキル2, Lv2, スキル3, Lv3, 防具スロ×3, 武器スロ×3 の 12 項目)。
        </${Hint}>
        <p class="hint">${r.count} 個${r.skipped.length ? ` (生産する護石など ${r.skipped.length} 個は入れていません)` : ''}</p>`,
    });
  };
  const openClaude = () => {
    setExp({
      kind: 'claude',
      title: 'Claude に渡す',
      text: claudeExportText(local.charms, dataCharms, ctx),
      intro: html`
        <${Hint}>
          この文を Claude に送ってください (「共有する」で Claude のアプリを選ぶか、コピーして貼り付け)。
          Claude が足すと、アプリが次に新しくなったときに「Claude が取り込んだ護石」に出ます。
          そのあと、この端末の分は「片付ける」で消せます。
        </${Hint}>`,
    });
  };

  return html`
    <div class="stack" data-charms-root="1">
      <${PhotoNotice} />

      <${Card} title="Claude が取り込んだ護石" sub=${`${dataEntries.length} 個`} flush>
        ${showTools && html`
          <div class="charm-tools" data-charm-tools="1">
            <input class="input" type="search" value=${query} placeholder="シートの No. かスキルの名前で探す" aria-label="護石を探す"
              enterkeyhint="search" autocomplete="off" data-charm-search="1"
              onInput=${(e) => changeQuery(e.currentTarget.value)} />
            <${Segmented} value=${listFilter} onChange=${changeFilter}
              options=${CHARM_FILTERS.map((f) => ({ value: f.value, label: `${f.label} ${counts[f.value]}` }))} />
            ${(query || listFilter !== 'all') && html`
              <p class="hint" data-charm-matched=${shownData.length}>${dataEntries.length} 個のうち、合う護石は ${shownData.length} 個です。</p>`}
          </div>`}
        <div class="charm-list">
          ${shownRows.length ? shownRows.map((e) => html`
            <${CharmRow} key=${e.charm.id} entry=${e} ctx=${ctx} equipped=${equippedId === e.charm.id}
              onOpen=${() => setDetailId(e.charm.id)} />`) : dataEntries.length ? html`
            <${Empty}>合う護石がありません。探す言葉か絞り方を変えてください。</${Empty}>` : html`
            <${Empty}>まだありません。上の案内のとおり写真を Claude に送ると、ここに出ます。</${Empty}>`}
        </div>
        ${rest > 0 && html`
          <${Pad}>
            <p class="hint" style="margin-top:0" data-charm-rest=${rest}>あと ${rest} 個あります。</p>
            <div class="btn-row">
              <${Button} onClick=${() => setLimit(limit + CHARM_PAGE)} data-charm-action="more">さらに ${Math.min(CHARM_PAGE, rest)} 個を出す</${Button}>
              <${Button} variant="ghost" onClick=${() => setLimit(Infinity)} data-charm-action="all">全部出す</${Button}>
            </div>
          </${Pad}>`}
      </${Card}>

      <${Card} title="この端末で足した護石" sub=${local.status === 'ready' ? `${localEntries.length} 個・この端末にだけ保存` : null} flush
        actions=${html`<${Button} variant="primary" small onClick=${() => openEditor(null)}
          data-charm-action="add">＋ 足す</${Button}>`}>
        ${local.status !== 'ready' ? html`<${Loading} />` : localEntries.length ? localEntries.map((e) => html`
          <${CharmRow} key=${e.charm.id} entry=${e} ctx=${ctx} equipped=${equippedId === e.charm.id}
            onOpen=${() => setDetailId(e.charm.id)} />`) : html`
          <${Empty}>まだありません。「＋ 足す」で手で入れるか、下の「泣シミュ形式を貼り付けて読み込む」を使ってください。</${Empty}>`}
        ${imported.length > 0 && html`
          <${Pad}>
            <${Notice} kind="ok" title=${`Claude が取り込み済みの護石が ${imported.length} 個あります`}
              actions=${html`<${Button} onClick=${cleanup} data-charm-action="cleanup">片付ける</${Button}>`}>
              <p>「Claude が取り込んだ護石」に同じものがあるので、この端末の分は消してかまいません。</p>
            </${Notice}>
          </${Pad}>`}
        ${local.saved === false && html`
          <${Pad}>
            <${Notice} kind="warn" title="この端末に保存できませんでした">
              <p>画面を閉じると消えます。プライベートブラウズを使っていないか確かめてください。消える前に「Claude に渡す」で書き出せます。</p>
            </${Notice}>
          </${Pad}>`}
      </${Card}>

      <${Card} title="書き出し・読み込み">
        <${Hint}>
          この端末で足した護石は、この iPhone にだけ保存されています。「Claude に渡す」で送ると、どの端末でも使えるようになります。
        </${Hint}>
        <div class="btn-col">
          <${Button} block onClick=${openNaki} disabled=${!allCharms.length} data-charm-action="export-naki">
            泣シミュ形式で書き出す
          </${Button}>
          <${Button} block onClick=${openClaude} disabled=${!local.charms.length} data-charm-action="export-claude">
            Claude に渡す (この端末の ${local.charms.length} 個)
          </${Button}>
          <${Button} block onClick=${() => setImportSeq(++sheetSeq)} data-charm-action="import-naki">
            泣シミュ形式を貼り付けて読み込む
          </${Button}>
        </div>
      </${Card}>

      ${detail && html`
        <${DetailSheet} key=${`detail-${detail.charm.id}`} entry=${detail} ctx=${ctx} equippedId=${equippedId}
          onClose=${() => setDetailId(null)}
          onEdit=${(c) => { setDetailId(null); openEditor(c); }} />`}
      ${editor && html`
        <${EditorSheet} key=${`editor-${editor.seq}`} initial=${editor.charm} ctx=${ctx} existing=${allCharms}
          onClose=${() => setEditor(null)}
          onSaved=${(id) => { setEditor(null); if (id) setDetailId(id); }} />`}
      ${exp && html`<${ExportSheet} key=${`export-${exp.kind}`} exp=${exp} onClose=${() => setExp(null)} />`}
      ${importSeq > 0 && html`
        <${ImportSheet} key=${`import-${importSeq}`} ctx=${ctx} existing=${allCharms} onClose=${() => setImportSeq(0)} />`}
    </div>`;
}
