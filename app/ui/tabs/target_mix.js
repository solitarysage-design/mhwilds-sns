// 相手 (モンスターの部位・手入力の肉質) を、火力の計算に渡す形にする。咆哮・風圧などの見せ方もここで作る。
// 純粋関数 (DOM にも state.js にも触らない。node でも動く)。
//
// 複数の部位を割合で混ぜる指定は state の tabs.target に置く (state.target には部位が 1 つしか無いため):
//   tabs.target = {
//     mix: { on: true, monsterId: 3, weights: { head: 0.6, tail: 0.4 } },  // 割合は 0〜1 (足して 1 でなくてよい)
//     showUnknown: false,   // 部位不明も一覧に出す
//     sort: 'body' | 'slash',
//     elem: null | 'fire' …  // 一覧の属性の列 (null = 武器の属性かおすすめ属性)
//   }
// 割合で混ぜている間も state.target.partKey には一番割合の大きい部位を入れておく
// (resolveTarget だけを使う画面でも、それらしい 1 部位で計算できるように)。
//
// 個体 (state.target.individual。歴戦王など) があれば、傷口の肉質は hunt.js の hitzoneFor で置き換える
// (歴戦王ウズ・トゥナは置き換え後、歴戦王アルシュベルドは state.target.useUncertainWound のときだけ)。
// 段階 3 の相手タブ (target_hunt.js) のために、クエストの文脈 (questContext)・多頭の相手ごとの部位 (subjectTargets)・
// モンスターごとの部位の選び方の覚え (tabs.target.memo) もここに置く。
//   tabs.target.memo = { [monsterId]: { partKey, mix: {on, weights} | null } }  (相手を替える前の部位の選び方)

import {
  hitzoneFor, individualOf, questById, questSubjects, subjectIndexOf, clampPlayers, INDIVIDUAL_KINDS, MAX_PLAYERS,
} from '../../model/hunt.js';

/** 弱点とみなす物理 (切断) 肉質のしきい値 (弱点特効と同じ 45) */
export const WEAK_POINT_MIN = 45;
/** ダメージになる属性 (肉質のキー) */
export const ELEMENT_KEYS = ['fire', 'water', 'thunder', 'ice', 'dragon'];
/** 手入力の肉質の項目 (state.js の HITZONE_KEYS と同じ並び) */
export const HITZONE_INPUT_KEYS = ['slash', 'blunt', 'fire', 'water', 'thunder', 'ice', 'dragon'];

const isObj = (x) => x != null && typeof x === 'object' && !Array.isArray(x);

// ---------------------------------------------------------------- モンスターと部位

/** data.js の target データ (または monsters.json 丸ごと / 配列) からモンスターの配列 */
export function monsterList(targetData) {
  if (!targetData) return [];
  if (Array.isArray(targetData)) return targetData;
  if (targetData.lists && Array.isArray(targetData.lists.monsters)) return targetData.lists.monsters;
  if (Array.isArray(targetData.monsters)) return targetData.monsters;
  if (targetData.monsters && Array.isArray(targetData.monsters.monsters)) return targetData.monsters.monsters;
  return [];
}

export function findMonster(targetData, monsterId) {
  if (monsterId == null) return null;
  if (targetData && targetData.index && targetData.index.monsters) {
    return targetData.index.monsters.get(monsterId) || null;
  }
  return monsterList(targetData).find((m) => m.id === monsterId) || null;
}

export function findPart(monster, partKey) {
  if (!monster || !partKey) return null;
  return (monster.parts || []).find((p) => p.key === partKey) || null;
}

/** 物理 (切断) 肉質が 45 以上 = 弱点 (剣のヒットに弱点特効が効く) */
export function isWeakPart(part) {
  return !!part && !!part.hitzone && (Number(part.hitzone.slash) || 0) >= WEAK_POINT_MIN;
}

/**
 * 弱点特効がどのヒットに効くか。弱点特効はヒットごとに、そのヒットの肉質で決まる
 * (剣 = 切断、盾 = 打撃、傷口を狙う段は傷口の肉質)。
 * @returns {{sword: boolean, shield: boolean, woundSword: boolean|null, woundShield: boolean|null}}
 *   wound* は傷口が無い部位では null
 */
export function weakInfo(part) {
  const hz = (part && part.hitzone) || {};
  const w = part && part.wound;
  const ge = (v) => (Number(v) || 0) >= WEAK_POINT_MIN;
  return {
    sword: ge(hz.slash), shield: ge(hz.blunt),
    woundSword: w ? ge(w.slash) : null, woundShield: w ? ge(w.blunt) : null,
  };
}

/** 部位不明 (名前の無い部位) か */
export function isUnknownPart(part) {
  return !!part && (part.unknownPart === true);
}

/**
 * 画面に出す部位の名前。名前の無い部位はデータの内部名 (hide-1 など) を出さず「部位不明 1」のように番号にする
 * (番号はそのモンスターの部位不明の中での並び順)。
 */
export function partLabel(part, monster) {
  if (!part) return '';
  if (!isUnknownPart(part)) return part.name;
  const unknown = ((monster && monster.parts) || []).filter(isUnknownPart)
    .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
  const i = unknown.findIndex((p) => p.key === part.key);
  return i >= 0 ? `部位不明 ${i + 1}` : '部位不明';
}

/**
 * 一覧に出す部位。部位不明は既定で隠す。sort: 'body' (データの並び) | 'slash' (切断肉質の高い順)。
 * 選んでいる部位 (keepKeys) は部位不明でも出す。
 */
export function visibleParts(monster, { showUnknown = false, sort = 'body', keepKeys = [] } = {}) {
  if (!monster) return [];
  const keep = new Set(keepKeys);
  const list = (monster.parts || []).filter((p) => showUnknown || !isUnknownPart(p) || keep.has(p.key));
  if (sort === 'slash') {
    return [...list].sort((a, b) => (b.hitzone?.slash ?? 0) - (a.hitzone?.slash ?? 0)
      || (b.wound?.slash ?? -1) - (a.wound?.slash ?? -1) || (a.ordinal ?? 0) - (b.ordinal ?? 0));
  }
  return [...list].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
}

/**
 * モンスターを選んだときに最初に選んでおく部位 (名前のある部位で切断肉質が一番高いもの。同じなら傷口が高いもの)。
 * 一時的な部位 (transient。ウズ・トゥナの水膜など、部位の体力が小さく傷口も無い層) は選ばない (それしか無ければ選ぶ)。
 * recommend.js の partsTargets の弱点 1 か所 (autoPickParts) と同じ決まり
 */
export function defaultPartKey(monster) {
  const list = visibleParts(monster, { sort: 'slash' });
  const stable = list.filter((p) => p.transient !== true);
  const pick = stable.length ? stable : list;
  return pick.length ? pick[0].key : null;
}

// ---------------------------------------------------------------- 割合で混ぜる

/**
 * tabs.target.mix を読む。別のモンスターの指定・壊れた値は無視する。
 * @returns {{on: boolean, weights: Object<string, number>}}  weights は部位 key → 0〜1
 */
export function readMix(tabTarget, monsterId, monster = null) {
  const mix = isObj(tabTarget) && isObj(tabTarget.mix) ? tabTarget.mix : null;
  if (!mix || monsterId == null || mix.monsterId !== monsterId) return { on: false, weights: {} };
  const weights = {};
  if (isObj(mix.weights)) {
    for (const [k, v] of Object.entries(mix.weights)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) continue;
      if (monster && !findPart(monster, k)) continue;
      weights[k] = Math.min(1, n);
    }
  }
  return { on: mix.on === true, weights };
}

/** 割合の指定 → [{part, raw, share}] (share = 足して 1 にした割合。並びはデータの順) */
export function mixShares(monster, weights) {
  const list = (monster && monster.parts ? monster.parts : [])
    .filter((p) => weights[p.key] > 0)
    .map((p) => ({ part: p, raw: weights[p.key] }));
  const sum = list.reduce((a, x) => a + x.raw, 0);
  return list.map((x) => ({ ...x, share: sum > 0 ? x.raw / sum : 0 }));
}

/** 一番割合の大きい部位 (同じならデータの順で先) */
export function mainPartKey(monster, weights) {
  let best = null;
  for (const x of mixShares(monster, weights)) if (!best || x.raw > best.raw) best = x;
  return best ? best.part.key : null;
}

/** 割合の最小 (1 部位あたり)。つまみをこれより下げると、その部位を外したのと見分けがつかないため */
export const MIX_MIN_SHARE = 0.05;
const r2 = (v) => Math.round(v * 100) / 100;

/** 重みを「足して 1 の割合」にそろえる ({部位 key: 割合}。0.01 刻み、丸めの誤差は一番大きい部位で合わせる) */
export function normalizeShares(weights) {
  const keys = Object.keys(weights || {}).filter((k) => Number(weights[k]) > 0);
  const sum = keys.reduce((a, k) => a + Number(weights[k]), 0);
  if (!keys.length || !(sum > 0)) return {};
  const out = {};
  for (const k of keys) out[k] = r2(Number(weights[k]) / sum);
  const big = keys.reduce((a, k) => (out[k] > out[a] ? k : a), keys[0]);
  out[big] = r2(out[big] + (1 - keys.reduce((a, k) => a + out[k], 0)));
  return out;
}

/**
 * 1 つの部位の割合を x (0〜1) にする。ほかの部位は、今の割合の比のまま残り (1 − x) を分ける (合計はいつも 100%)。
 * 2 部位なら「頭 60% → 尻尾 40%」。x は各部位が MIX_MIN_SHARE 以上になる範囲に収める。
 */
export function setShare(weights, key, x) {
  const shares = normalizeShares(weights);
  const others = Object.keys(shares).filter((k) => k !== key);
  if (!others.length) return { [key]: 1 };
  const v = Math.min(1 - MIX_MIN_SHARE * others.length, Math.max(MIX_MIN_SHARE, Number(x) || 0));
  const rest = others.reduce((a, k) => a + shares[k], 0);
  const out = { [key]: r2(v) };
  for (const k of others) out[k] = Math.max(MIX_MIN_SHARE, rest > 0 ? (shares[k] / rest) * (1 - v) : (1 - v) / others.length);
  return normalizeShares(out);
}

/** 部位を足す (足した部位も含めて等分に近づける: 今の割合を縮めて、新しい部位に 1/(部位数) を渡す) */
export function addShare(weights, key) {
  const shares = normalizeShares(weights);
  const n = Object.keys(shares).length + 1;
  const out = {};
  for (const [k, v] of Object.entries(shares)) out[k] = v * (1 - 1 / n);
  out[key] = 1 / n;
  return normalizeShares(out);
}

/** 部位を外す (残りの部位で 100% に戻す) */
export function removeShare(weights, key) {
  const out = { ...normalizeShares(weights) };
  delete out[key];
  return normalizeShares(out);
}

/** state.target.individual を個体の値にそろえる (通常・知らない値は null) */
export function individualKindOf(target) {
  const k = target && target.individual;
  return INDIVIDUAL_KINDS.includes(k) ? k : null;
}

/** 印の重さ (未確定 > 未確認 > なし)。部位を混ぜたときは一番重い印を出す */
const MARK_ORDER = { uncertain: 2, unverified: 1 };
const heavierMark = (a, b) => ((MARK_ORDER[b] || 0) > (MARK_ORDER[a] || 0) ? b : a);

/**
 * 部位 1 つの肉質 (個体の傷口の置き換えを入れたもの)。kind が null (通常) なら parts[] のまま。
 * @returns {{target: {hitzone, wound, isWound}, hz: object|null}}  hz は hunt.js の hitzoneFor の結果 (通常なら null)
 */
function partTarget(monster, part, target) {
  const isWound = !!target.isWound;
  const kind = individualKindOf(target);
  if (kind == null) return { target: { hitzone: part.hitzone, wound: part.wound || null, isWound }, hz: null };
  const hz = hitzoneFor(monster, part, kind, { useUncertain: target.useUncertainWound === true });
  return { target: { hitzone: hz.hitzone, wound: hz.wound || null, isWound }, hz };
}

/** ラベルに使うモンスターの名前 (個体なら「ウズ・トゥナ（歴戦王）」) */
export function individualName(monster, kind) {
  if (!monster) return '';
  const ind = kind != null ? individualOf(monster, kind) : null;
  return (ind && ind.name) || monster.name;
}

/** 手入力の肉質 (state.target.manual) → damage.js の target */
export function manualTarget(manual, isWound = false) {
  const m = manual || {};
  return { hitzone: m.hitzone || {}, wound: m.wound || null, isWound: !!isWound };
}

const shareText = (s) => `${Math.round(s * 100)}%`;

/**
 * state.target と tabs.target から、計算に渡す相手の一覧を作る。
 * @param {object} target state.target
 * @param {object} tabTarget state.tabs.target (割合で混ぜる指定。無くてよい)
 * @param {object} targetData data.js の target データ (手入力だけなら無くてよい)
 * @returns {null | {targets: Array<{weight, label, partKey, target}>, label, mixed, mode, monster?, part?,
 *                   individual?, woundMark?}}
 *   決まらないとき (モンスター・部位が未選択、データ未読み込み) は null。
 *   個体 (target.individual) があれば傷口を hunt.js の hitzoneFor で置き換え、ラベルは「ウズ・トゥナ（歴戦王） 頭」。
 *   woundMark = 狙う部位の傷口の印 ('unverified' = 未確認 / 'uncertain' = 未確定 / null。混ぜたときは一番重いもの)。
 */
export function resolveTargetMix(target, tabTarget, targetData) {
  if (!target) return null;
  if (target.mode === 'manual') {
    const label = (target.manual && target.manual.name) || '手入力';
    return {
      mode: 'manual', mixed: false, label,
      targets: [{ weight: 1, label, partKey: null, target: manualTarget(target.manual, target.isWound) }],
    };
  }
  const monster = findMonster(targetData, target.monsterId);
  if (!monster) return null;
  const kind = individualKindOf(target);
  const name = individualName(monster, kind);
  const mix = readMix(tabTarget, monster.id, monster);
  if (mix.on) {
    const shares = mixShares(monster, mix.weights);
    if (shares.length) {
      let woundMark = null;
      const targets = shares.map((x) => {
        const pt = partTarget(monster, x.part, target);
        if (pt.hz) woundMark = heavierMark(woundMark, pt.hz.mark);
        return { weight: x.share, label: partLabel(x.part, monster), partKey: x.part.key, target: pt.target };
      });
      const label = shares.length === 1
        ? `${name} ${partLabel(shares[0].part, monster)}`
        : `${name} ${shares.map((x) => `${partLabel(x.part, monster)} ${shareText(x.share)}`).join('・')}`;
      return { mode: 'monster', mixed: shares.length > 1, label, monster, targets, individual: kind, woundMark };
    }
  }
  const part = findPart(monster, target.partKey);
  if (!part) return null;
  const label = `${name} ${partLabel(part, monster)}`;
  const pt = partTarget(monster, part, target);
  return {
    mode: 'monster', mixed: false, label, monster, part, individual: kind, woundMark: pt.hz ? pt.hz.mark : null,
    targets: [{ weight: 1, label: partLabel(part, monster), partKey: part.key, target: pt.target }],
  };
}

// ---------------------------------------------------------------- 部位の選び方の覚え (tabs.target.memo)

/** 覚えておくモンスターの数の上限 (保存データを大きくしない) */
const MEMO_MAX = 64;

/**
 * tabs.target.memo からそのモンスターの部位の選び方を読む (壊れた値・無くなった部位は捨てる)。
 * @returns {{partKey: string|null, mix: {on: boolean, weights: object}|null} | null}
 */
export function readPartsMemo(tabTarget, monsterId, monster = null) {
  const memo = isObj(tabTarget) && isObj(tabTarget.memo) ? tabTarget.memo : null;
  const m = memo && monsterId != null ? memo[String(monsterId)] : null;
  if (!isObj(m)) return null;
  const partKey = typeof m.partKey === 'string' && (!monster || findPart(monster, m.partKey)) ? m.partKey : null;
  const mix = isObj(m.mix) ? readMix({ mix: { ...m.mix, monsterId } }, monsterId, monster) : null;
  return { partKey, mix: mix && mix.on && Object.keys(mix.weights).length ? mix : null };
}

/**
 * 今のモンスターの部位の選び方 (state.target.partKey と tabs.target.mix) を memo に入れた tabs.target の差分 ({memo})。
 * 相手を替える前に setTabState('target', partsMemoPatch(...)) で残す。手入力・モンスター未選択なら null。
 */
export function partsMemoPatch(tabTarget, target) {
  if (!target || target.mode === 'manual' || target.monsterId == null) return null;
  const prev = isObj(tabTarget) && isObj(tabTarget.memo) ? tabTarget.memo : {};
  const mix = readMix(tabTarget, target.monsterId);
  const entry = {
    partKey: typeof target.partKey === 'string' ? target.partKey : null,
    mix: mix.on && Object.keys(mix.weights).length ? { on: true, weights: mix.weights } : null,
  };
  const key = String(target.monsterId);
  // 多すぎたら (壊れた保存データなど) 今のモンスター以外を先頭から捨てる
  // (モンスターの id は数なので、キーの並びは入れた順ではなく数の順。いまは 34 体なので上限には届かない)
  const others = Object.keys(prev).filter((k) => k !== key);
  const memo = {};
  for (const k of others.slice(Math.max(0, others.length - (MEMO_MAX - 1)))) memo[k] = prev[k];
  memo[key] = entry;
  return { memo };
}

// ---------------------------------------------------------------- クエスト (段階 3。相手タブの target_hunt.js が使う)

/**
 * 相手タブのクエストの文脈。クエストを選んでいない・見つからない・手入力なら null。
 * @returns {null | {quest, subjects, current, intruder: boolean, fixed: boolean, multi: boolean, maxPlayers, players}}
 *   subjects = hunt.js の questSubjects (人数の体力つき)。current = その中の今のモンスターの行
 *   (state.target.questTargetIndex の行がこのモンスターならそれ、違えば subjectIndexOf で探す。無ければ null = 乱入など)。
 *   intruder = 今のモンスターがこのクエストの乱入の候補。players = 人数 (クエストの上限 mission.maxPlayers で頭打ち)。
 */
export function questContext(targetData, target) {
  if (!target || target.mode === 'manual' || target.questId == null) return null;
  const quest = questById(targetData, target.questId);
  if (!quest) return null;
  const mp = quest.mission ? Number(quest.mission.maxPlayers) : NaN;
  const maxPlayers = Number.isFinite(mp) && mp >= 1 ? Math.min(MAX_PLAYERS, Math.round(mp)) : MAX_PLAYERS;
  const players = Math.min(clampPlayers(target.players), maxPlayers);
  const subjects = questSubjects(quest, targetData, { players });
  const kind = individualKindOf(target);
  let current = subjects.find((s) => s.index === target.questTargetIndex && s.monsterId === target.monsterId) || null;
  if (!current && target.monsterId != null) {
    const i = subjectIndexOf(quest, target.monsterId, kind);
    current = (i != null && subjects.find((s) => s.index === i))
      || subjects.find((s) => s.monsterId === target.monsterId && s.kind === kind)
      || subjects.find((s) => s.monsterId === target.monsterId) || null;
  }
  const intruder = !current && (quest.intruders || []).some((x) => x && x.monsterId === target.monsterId);
  return {
    quest, subjects, current, intruder, fixed: quest.fixedEquipment === true, multi: subjects.length > 1,
    maxPlayers, players,
  };
}

/**
 * クエストの相手 1 体を狙うときの計算の相手 (resolveTargetMix と同じ形)。
 * 今のモンスターなら相手タブで選んだ部位・割合、別のモンスターなら memo に覚えた選び方、無ければ弱点 1 か所 (defaultPartKey)。
 * 傷口を狙うか・確度の低い傷口の置き換えを使うかは、全部の相手に同じ指定を使う。
 * @param subject hunt.js の questSubjects の 1 件
 */
export function subjectTargets(targetData, subject, target, tabTarget) {
  if (!subject || !target) return null;
  const monster = findMonster(targetData, subject.monsterId);
  if (!monster) return null;
  const same = subject.monsterId === target.monsterId && target.mode !== 'manual';
  const memo = same ? null : readPartsMemo(tabTarget, monster.id, monster);
  const t = {
    mode: 'monster', monsterId: monster.id, isWound: !!target.isWound, individual: subject.kind ?? null,
    useUncertainWound: target.useUncertainWound === true,
    partKey: same ? target.partKey : ((memo && memo.partKey) || defaultPartKey(monster)),
  };
  let tab = null;
  if (same) tab = tabTarget;
  else if (memo && memo.mix) tab = { mix: { on: true, monsterId: monster.id, weights: memo.mix.weights } };
  return resolveTargetMix(t, tab, targetData);
}

/**
 * 相手が使う状態異常のキー (damage.js の input.monsterStatus。狂竜症などの条件のもとの確かめに使う)。
 * monster_threats.json の statusEffects と、狂竜化した個体がいるモンスター (variants に frenzied) なら 'frenzy'。
 * 手入力・相手が決まっていないときは [] (分かっている範囲で「使わない」として扱う)。
 * @param {object} target state.target
 * @param {object} targetData data.js の target データ (無ければ [] にはせず null = 分からない)
 */
export function monsterStatusOf(target, targetData) {
  if (!target || target.mode === 'manual' || target.monsterId == null) return [];
  const monster = findMonster(targetData, target.monsterId);
  if (!monster) return targetData ? [] : null;
  const row = threatRowOf(targetData.threats || (targetData.lists && targetData.lists.threats), monster.id);
  const out = new Set(((row && row.statusEffects) || []).map((s) => s.key));
  if ((monster.variants || []).includes('frenzied')) out.add('frenzy');
  return [...out];
}

/**
 * おすすめの属性の見せ方。主な部位の属性肉質の平均の 1 位と 2 位が近い (差が CLOSE_GAP 以下・同点を崩した) ときは
 * 1 つの属性を大きく出さない。どの属性も低い (1 位が WEAK_AVG 未満) ときは「ほとんど効かない」。
 * @param rec monsters.json の elementRecommendation
 * @param weaponElem いまの武器の属性 (ダメージになる属性だけ。無ければ null)
 * @returns {{kind: 'none'|'weak'|'close'|'clear', best: string[], top: number|null, gap: number|null,
 *            weapon: 'same'|'close'|'other'|null}}
 *   weapon = いまの武器の属性が 1 位と同じ / 1 位と差が小さい / 差がある (武器に属性が無ければ null)
 */
export const CLOSE_GAP = 2;
export const WEAK_AVG = 10;
export function recommendationView(rec, weaponElem) {
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

// ---------------------------------------------------------------- 咆哮・風圧・振動・属性やられ・状態異常

export const ROAR_LABEL = { none: 'なし', weak: '咆哮【小】', strong: '咆哮【大】' };
export const WIND_LABEL = { none: 'なし', minor: '風圧【小】', major: '風圧【大】', dragon: '龍風圧' };
export const TREMOR_LABEL = { none: 'なし', minor: '振動【小】', major: '振動【大】' };
/** 属性ごとの耐性スキルの名前 (属性耐性の値を上げる防具スキル) */
export const RESIST_NAME = { fire: '火耐性', water: '水耐性', thunder: '雷耐性', ice: '氷耐性', dragon: '龍耐性' };

function levelOf(skillLevels, skillId) {
  if (!skillLevels || skillId == null) return 0;
  const v = skillLevels[skillId] ?? skillLevels[String(skillId)];
  return Number(v) || 0;
}

/** rules の 1 件 ({skill, skillId, negateLevel, mitigateLevel, levelText}) + いまの装備の Lv */
function skillNeed(rule, skillLevels) {
  if (!rule) return null;
  const have = levelOf(skillLevels, rule.skillId);
  const negate = rule.negateLevel ?? null;
  const mitigate = rule.mitigateLevel ?? null;
  return {
    skillId: rule.skillId ?? null, name: rule.skill || '', negateLevel: negate, mitigateLevel: mitigate,
    negateText: negate != null && rule.levelText ? rule.levelText[String(negate)] || '' : '',
    have, negated: negate != null && have >= negate, mitigated: mitigate != null && have >= mitigate,
  };
}

function threatRowOf(threats, monsterId) {
  const list = threats && Array.isArray(threats.monsters) ? threats.monsters
    : threats && threats.lists && Array.isArray(threats.lists.threats) ? threats.lists.threats
      : Array.isArray(threats) ? threats : [];
  return list.find((x) => x.monsterId === monsterId) || null;
}

/**
 * そのモンスターの咆哮・風圧・振動・属性やられ・状態異常と、防ぐスキル (monster_threats.json の rules)。
 * @param {object} threats monster_threats.json 丸ごと (data.js の target.threats)
 * @param {number} monsterId
 * @param {object} skillLevels いまの装備のスキル {skillId: Lv} (build.js の skillLevels)。無くてよい
 * @param {object} opts.kind 個体 (state.target.individual)。歴戦王なら variant に専用の脅威などを入れる
 * @returns {null | {hazards: Array, blights: Array, status: Array, wikiUrl, issues, license, variant}}
 *   hazards[]: {key: 'roar'|'wind'|'tremor', label, value, text, none, unknown, need}
 *   blights[]: {element, name, uncertain, reason, need, resistName, resistThreshold}
 *   status[]: {key, name, nameUncertain, need, noSkill}
 *   need は skillNeed (無効にする Lv・軽減する Lv・いまの Lv) か null
 *   variant: variantThreats の結果 (その個体の差分が無ければ null)
 */
export function threatInfo(threats, monsterId, skillLevels = {}, { kind = null } = {}) {
  const row = threatRowOf(threats, monsterId);
  if (!row) return null;
  const rules = (threats && threats.rules) || {};
  const hazards = [];
  const hazard = (key, label, value, labels, group) => {
    if (value == null) {
      hazards.push({ key, label, value: null, text: 'データなし', unknown: true, none: false, need: null });
    } else if (value === 'none') {
      hazards.push({ key, label, value, text: 'なし', unknown: false, none: true, need: null });
    } else {
      hazards.push({
        key, label, value, text: labels[value] || value, unknown: false, none: false,
        need: skillNeed(group && group[value], skillLevels),
      });
    }
  };
  hazard('roar', '咆哮', row.roar, ROAR_LABEL, rules.roar);
  hazard('wind', '風圧', row.windPressure, WIND_LABEL, rules.windPressure);
  hazard('tremor', '振動', row.tremor, TREMOR_LABEL, rules.tremor);

  const eb = rules.elementalBlight || {};
  const blightNeed = skillNeed(eb.skill, skillLevels);
  const blights = [
    ...(row.blights || []).map((b) => ({ ...b, uncertain: false, reason: '' })),
    ...(row.blightsUncertain || []).map((b) => ({ ...b, uncertain: true, reason: b.reason || '' })),
  ].map((b) => ({
    element: b.element, name: b.name, uncertain: b.uncertain, reason: b.reason, need: blightNeed,
    resistName: RESIST_NAME[b.element] || '', resistThreshold: eb.resistanceThreshold ?? 20,
  }));

  const status = (row.statusEffects || []).map((s) => {
    const r = rules.status && rules.status[s.key];
    const noSkill = rules.noSkill && rules.noSkill[s.key];
    return {
      key: s.key, name: s.name, nameUncertain: s.nameConfidence === 'low',
      need: r ? skillNeed(r, skillLevels) : null,
      noSkill: r ? null : (noSkill || '防ぐスキルの情報がありません'),
    };
  });
  return {
    hazards, blights, status, wikiUrl: row.wikiUrl || null, issues: row.issues || [],
    license: (threats && threats.meta && threats.meta.license) || null,
    variant: variantThreats(row, kind, skillLevels),
  };
}

/**
 * 個体ごとの差分 (monster_threats.json の monsters[].variants[kind]。いまは歴戦王だけ)。
 * @returns {null | {kind, name, sameAsBase: {all: boolean, confidence, reason}|null,
 *                   moveChanges: [{text, textEn}], hazards: [{key, text, need, oneShot, noSkill, confidence, unverified, note}],
 *                   source}}
 *   hazards[].need = 防ぐスキル (skillNeed) か null (防げない攻撃)。unverified = 確度が high でない (画面は「未確認」)
 */
export function variantThreats(row, kind, skillLevels = {}) {
  const v = row && isObj(row.variants) && kind != null ? row.variants[kind] : null;
  if (!isObj(v)) return null;
  const sab = isObj(v.sameAsBase) ? v.sameAsBase : null;
  const sameKeys = ['roar', 'windPressure', 'tremor', 'blights', 'statusEffects'];
  return {
    kind, name: v.name || '',
    sameAsBase: sab ? {
      all: sameKeys.every((k) => sab[k] === true), confidence: sab.confidence || null, reason: sab.reason || '',
    } : null,
    moveChanges: (Array.isArray(v.moveChanges) ? v.moveChanges : [])
      .filter(isObj).map((m) => ({ text: m.text || null, textEn: m.textEn || null })),
    hazards: (Array.isArray(v.hazards) ? v.hazards : []).filter(isObj).map((h) => ({
      key: h.key, text: h.text || '', need: isObj(h.skill) ? skillNeed(h.skill, skillLevels) : null,
      oneShot: h.oneShot === true, noSkill: isObj(h.skill) ? null : (h.noSkill || '防ぐスキルの情報がありません'),
      confidence: h.confidence || null, unverified: h.confidence !== 'high', note: h.note || null,
    })),
    source: v.source || null,
  };
}
