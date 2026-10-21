// 相手 (モンスター・個体・クエスト) の体力・討伐までの回数・個体の肉質・クエストの選び方 (段階 3)。
// 純粋関数 (DOM にも state.js にも preact にも触らない。node でも Worker でも動く。import は無い)。
// データの形は docs/ARCHITECTURE.md (monsters.json の individuals / legendaryParams / woundConversions、
// quests.json の mission.targets[].healthCalc / multi / attackRate と availability)。使い方は docs/MODEL_API.md の「hunt.js」節。
// 確度の印 (仮 / 未確認 / 未確定) の使い分けは docs/RECOMMEND_DESIGN.md 2.8 節。
//
// targetData は data.js の target データ ({lists, index, monsters, quests, ...}) をそのまま渡す。
// テストなどでは {monsters: monsters.json 丸ごと, quests: quests.json 丸ごと} や {monsters: [...], quests: [...]} でもよい。

/**
 * 確度の印 (docs/RECOMMEND_DESIGN.md 2.8 節)。画面での出し方:
 *   provisional (仮)   = 根拠の無い決めごと → <Badge kind="warn">仮</Badge>
 *   unverified (未確認) = データで確かめていない事実 → <Badge kind="warn">未確認</Badge>
 *   uncertain (未確定)  = 根拠の弱い数値 → <Badge kind="unconfirmed" /> (共通部品の「未確定」)
 */
export const MARK_LABEL = Object.freeze({ provisional: '仮', unverified: '未確認', uncertain: '未確定' });
/** 個体の種類 (monsters.json の individuals[].kind と quests.json の targets[].variant。通常は null) */
export const INDIVIDUAL_KINDS = Object.freeze(['tempered', 'arch-tempered', 'frenzied', 'alpha']);
/** 受けられるクエストの availability.status (常設・通常の任務・配信中) */
export const AVAILABLE_STATUSES = Object.freeze(['permanent', 'standard', 'active']);
/** 人数の上限 */
export const MAX_PLAYERS = 4;
/**
 * MissionData (quests.json の mission.targets[].variant) が区別する個体。
 * 狂竜化・ボス個体は MissionData では variant null の行 (_LegendaryID が NONE) なので、同じモンスターの null の行を使う。
 */
const MISSION_KINDS = new Set(['tempered', 'arch-tempered']);

const isObj = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const finite = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const kindOf = (k) => (k === undefined ? null : k);

// ---------------------------------------------------------------- データの取り出し

function listFrom(targetData, listKey, fileKey) {
  if (!targetData) return [];
  if (targetData.lists && Array.isArray(targetData.lists[listKey])) return targetData.lists[listKey];
  const f = targetData[listKey];
  if (Array.isArray(f)) return f;
  if (f && Array.isArray(f[fileKey])) return f[fileKey];
  return [];
}

/** target データからモンスターの配列 */
export function monstersOf(targetData) {
  return listFrom(targetData, 'monsters', 'monsters');
}

/** target データからクエストの配列 */
export function questsOf(targetData) {
  return listFrom(targetData, 'quests', 'quests');
}

/** モンスター (monsters.json の 1 件)。無ければ null */
export function monsterById(targetData, monsterId) {
  if (monsterId == null) return null;
  const idx = targetData && targetData.index && targetData.index.monsters;
  if (idx && typeof idx.get === 'function') return idx.get(monsterId) || null;
  return monstersOf(targetData).find((m) => m.id === monsterId) || null;
}

/** クエスト (quests.json の 1 件)。無ければ null */
export function questById(targetData, questId) {
  if (questId == null) return null;
  const idx = targetData && targetData.index && targetData.index.quests;
  if (idx && typeof idx.get === 'function') return idx.get(questId) || null;
  return questsOf(targetData).find((q) => q.id === questId) || null;
}

/** 部位 (key か要素) → 要素 */
function partOf(monster, part) {
  if (isObj(part)) return part;
  if (!monster || typeof part !== 'string') return null;
  return (monster.parts || []).find((p) => p.key === part) || null;
}

// ---------------------------------------------------------------- 個体

/**
 * 個体の一覧 (monsters.json の individuals の並び。先頭が通常)。
 * @returns {{kind: string|null, label: string, name: string, stars: number[], questCount: number}[]}
 */
export function individualsOf(monster) {
  if (!monster) return [];
  const list = Array.isArray(monster.individuals) && monster.individuals.length
    ? monster.individuals
    : [{ kind: null, label: '通常', name: monster.name, questIds: [], stars: [] }];
  return list.map((i) => {
    const kind = kindOf(i.kind);
    const fallback = kind == null ? '通常' : (monster.variantNames && monster.variantNames[kind]) || kind;
    return {
      kind,
      label: i.label || fallback,
      name: i.name || monster.name,
      stars: Array.isArray(i.stars) ? [...i.stars] : [],
      questCount: Array.isArray(i.questIds) ? i.questIds.length : 0,
    };
  });
}

/** individuals の 1 件 (kind = null は通常)。無ければ null */
export function individualOf(monster, kind = null) {
  if (!monster || !Array.isArray(monster.individuals)) return null;
  const k = kindOf(kind);
  return monster.individuals.find((i) => kindOf(i.kind) === k) || null;
}

/**
 * 個体のおすすめ属性 (monsters.json の elementRecommendation と同じ形)。
 * 傷口の置き換えがある個体 (sameAsBase: false = 歴戦王ウズ・トゥナ) は置き換え後の傷口で計算し直したもの。
 * 置き換えがいつ使われるか分からない個体 (sameAsBase: null = 歴戦王アルシュベルド) は、hitzoneFor と同じく
 * useUncertain のときだけ置き換え後のものを使う (既定はモンスターのもの)。
 */
export function elementRecommendationOf(monster, kind = null, { useUncertain = false } = {}) {
  if (!monster) return null;
  const ind = individualOf(monster, kind);
  const hz = ind && isObj(ind.hitzone) ? ind.hitzone : null;
  if (hz && hz.elementRecommendation && (hz.sameAsBase === false || (hz.sameAsBase == null && useUncertain))) {
    return hz.elementRecommendation;
  }
  return monster.elementRecommendation || null;
}

/**
 * 個体の肉質 (部位 1 つ)。通常の肉質 (hitzone) は個体で変わらない。傷口は個体の woundOverrides で置き換える:
 *   - sameAsBase: false (歴戦王ウズ・トゥナ) → 置き換え後の傷口を使う。印は未確認 (確度 medium)
 *   - sameAsBase: null で置き換えがある (歴戦王アルシュベルド) → 既定は通常の傷口のまま。useUncertain のときだけ置き換え後。
 *     どちらでも印は未確定 (置き換わるかどうかが分からないため)
 *   - sameAsBase: null で確度も null (狂竜化・ボス個体 = 未調査) → 通常の肉質で、印は未確認
 * 傷口の無い部位 (parts[].wound が null) は wound: null のまま (woundSource 'none')。
 * @param part 部位の key か parts[] の要素
 * @returns {{hitzone, wound, baseWound, overrideWound, woundSource: 'base'|'override'|'override-uncertain'|'none',
 *            changed: string[], sameAsBase: boolean|null, confidence: string|null,
 *            mark: null|'unverified'|'uncertain', note: string|null, dataNote: string|null} | null}
 *   wound = 計算に使う傷口。overrideWound = データにある置き換え後の傷口 (使っていなくても入れる)。
 *   changed = 置き換えで値の変わる項目 (例 ['shot', 'thunder'])。note は画面に出せる文、dataNote はデータの注記 (「くわしく」用)。
 */
export function hitzoneFor(monster, part, kind = null, { useUncertain = false } = {}) {
  const p = partOf(monster, part);
  if (!p) return null;
  const k = kindOf(kind);
  const baseWound = p.wound || null;
  const ind = individualOf(monster, k);
  const hz = ind && isObj(ind.hitzone) ? ind.hitzone : null;
  const out = {
    hitzone: p.hitzone, wound: baseWound, baseWound, overrideWound: null,
    woundSource: baseWound ? 'base' : 'none', changed: [],
    sameAsBase: hz ? (hz.sameAsBase === undefined ? null : hz.sameAsBase) : (k == null ? true : null),
    confidence: hz ? (hz.confidence ?? null) : null,
    mark: null, note: null, dataNote: hz && typeof hz.note === 'string' ? hz.note : null,
  };
  if (!hz) {
    if (k != null) {
      out.mark = 'unverified';
      out.note = 'この個体の肉質のデータがありません。通常の肉質で計算しています';
    }
    return out;
  }
  const ov = baseWound && isObj(hz.woundOverrides) && isObj(hz.woundOverrides[p.key]) ? hz.woundOverrides[p.key] : null;
  if (ov) {
    out.overrideWound = ov;
    const keys = new Set([...Object.keys(baseWound), ...Object.keys(ov)]);
    out.changed = [...keys].filter((key) => ov[key] !== baseWound[key]);
  }
  if (hz.sameAsBase === false) {
    if (ov) {
      out.wound = ov;
      out.woundSource = 'override';
      out.mark = 'unverified';
      out.note = 'この個体は傷口の肉質が通常と違います (データから読んだ値で、ゲームの中では確かめていません)';
    }
  } else if (hz.sameAsBase == null) {
    if (ov) {
      out.mark = 'uncertain';
      if (useUncertain) {
        out.wound = ov;
        out.woundSource = 'override-uncertain';
        out.note = '置き換わるとしたときの傷口の肉質で計算しています (いつ置き換わるかは分かりません)';
      } else {
        out.note = '傷口の肉質が置き換わることがあります (いつ置き換わるかは分かりません)。通常の傷口で計算しています';
      }
    } else if (hz.confidence == null) {
      out.mark = 'unverified';
      out.note = 'この個体の肉質は調べていません。通常の肉質で計算しています';
    }
  }
  return out;
}

/**
 * 傷の付きにくさ (legendaryParams[group].woundVital。意味は名前からの推定で確度 low)。group が null・欄が無ければ null。
 * @returns {{normal: number|null, tear: number|null, temperedScar: number|null, confidence: 'low'} | null}
 */
export function woundVitalOf(monster, group) {
  if (!monster || group == null || !isObj(monster.legendaryParams)) return null;
  const p = monster.legendaryParams[group];
  const wv = isObj(p) && isObj(p.woundVital) ? p.woundVital : null;
  if (!wv) return null;
  return { normal: finite(wv.normal), tear: finite(wv.tear), temperedScar: finite(wv.temperedScar), confidence: 'low' };
}

// ---------------------------------------------------------------- クエスト

/**
 * クエストの mission.targets のうち、その個体の行の番号 (無ければ null)。
 * 狂竜化・ボス個体は MissionData で区別されない (variant null) ので、同じモンスターの variant null の行を使う。
 */
export function subjectIndexOf(quest, monsterId, kind = null) {
  const rows = quest && quest.mission && Array.isArray(quest.mission.targets) ? quest.mission.targets : null;
  if (!rows || monsterId == null) return null;
  const k = kindOf(kind);
  let i = rows.findIndex((t) => t && t.monsterId === monsterId && kindOf(t.variant) === k);
  if (i < 0 && !MISSION_KINDS.has(k)) i = rows.findIndex((t) => t && t.monsterId === monsterId && kindOf(t.variant) == null);
  return i < 0 ? null : i;
}

/** mission.targets の行の healthCalc → {mid, min, max} (分からなければ null) */
function soloHealthOf(row) {
  const hc = row && isObj(row.healthCalc) ? row.healthCalc : null;
  const mid = hc ? finite(hc.mid) : null;
  if (mid == null || mid <= 0) return null;
  return { mid, min: finite(hc.min) ?? mid, max: finite(hc.max) ?? mid };
}

/** availability.status (無ければ 'unknown') */
function statusOf(quest) {
  return (quest && isObj(quest.availability) && typeof quest.availability.status === 'string')
    ? quest.availability.status : 'unknown';
}

/**
 * その個体が出るクエストの一覧。先に狩猟対象 (individuals[].questIds の並び = ★順)、続いて乱入の可能性 (intruderQuestIds)。
 * @returns {{quest, id, name, role: 'target'|'intruder', stars, available: boolean, status, fixedEquipment: boolean|null,
 *            multi: boolean, subjectIndex: number|null, health: {mid, min, max}|null}[]}
 *   subjectIndex = mission.targets のその個体の行 (乱入・mission が無いときは null)。health = その行のソロの体力。
 */
export function questsFor(targetData, monsterId, kind = null) {
  const monster = monsterById(targetData, monsterId);
  const ind = individualOf(monster, kind);
  if (!ind) return [];
  const out = [];
  const seen = new Set();
  const add = (ids, role) => {
    for (const id of Array.isArray(ids) ? ids : []) {
      if (seen.has(id)) continue;
      const q = questById(targetData, id);
      if (!q) continue;
      seen.add(id);
      const status = statusOf(q);
      const si = role === 'target' ? subjectIndexOf(q, monsterId, kind) : null;
      out.push({
        quest: q, id: q.id, name: q.name, role, stars: finite(q.stars),
        available: AVAILABLE_STATUSES.includes(status), status,
        fixedEquipment: typeof q.fixedEquipment === 'boolean' ? q.fixedEquipment : null,
        multi: !!q.multi, subjectIndex: si,
        health: si != null ? soloHealthOf(q.mission.targets[si]) : null,
      });
    }
  };
  add(ind.questIds, 'target');
  add(ind.intruderQuestIds, 'intruder');
  return out;
}

/**
 * 個体を選んだときに自動で選んでおくクエスト (docs/RECOMMEND_DESIGN.md 2.2 節。方針)。
 * 狩猟対象のクエストのうち 装備固定でない・体力が分かる・多頭でない・受けられる ものの中で ★ が一番高いもの
 * (同じ ★ なら一覧の先頭)。無ければ null。
 */
export function defaultQuestId(targetData, monsterId, kind = null) {
  let best = null;
  for (const r of questsFor(targetData, monsterId, kind)) {
    if (r.role !== 'target' || r.fixedEquipment !== false || r.multi || !r.available || !r.health) continue;
    if (!best || (r.stars ?? -1) > (best.stars ?? -1)) best = r;
  }
  return best ? best.id : null;
}

/** クエストの大型の狩猟対象を、数 (count) のぶん展開した並び (mission が無いとき用) */
function expandedLargeTargets(quest) {
  const out = [];
  for (const t of Array.isArray(quest.targets) ? quest.targets : []) {
    if (!t || !t.large || t.monsterId == null) continue;
    const n = Math.max(1, Math.min(10, Math.round(Number(t.count) || 1)));
    for (let i = 0; i < n; i++) out.push(t);
  }
  return out;
}

/**
 * MissionData は狂竜化・ボス個体を区別しない (variant null) ので、quest.targets に同じモンスターの
 * frenzied / alpha の行があればそれを個体とする。
 */
function subjectKind(quest, row) {
  const v = kindOf(row.variant);
  if (v != null) return v;
  const t = (quest.targets || []).find((x) => x && x.large && x.monsterId === row.monsterId
    && x.variant != null && !MISSION_KINDS.has(x.variant));
  return t ? t.variant : null;
}

/**
 * クエストで戦う大型の一覧 (mission.targets の行ごと。同じモンスターが 2 頭なら 2 件。小型の行は除く)。
 * mission が無いクエスト (フリーチャレンジなど) は quest.targets の大型を数のぶん並べ、体力は不明 (known: false)。
 * @returns {{index, key, monsterId, name, kind, missionTarget, health, paramGroup}[]}
 *   index = mission.targets の行の番号 (mission が無いときは並べた順の番号)。state.target.questTargetIndex はこの番号。
 *   health = targetHealth(missionTarget, {players})
 */
export function questSubjects(quest, targetData, { players = 1 } = {}) {
  if (!quest) return [];
  const rows = quest.mission && Array.isArray(quest.mission.targets) ? quest.mission.targets : null;
  const nameOf = (monsterId, kind, fallback) => {
    const m = monsterById(targetData, monsterId);
    const ind = individualOf(m, kind);
    return (ind && ind.name) || (m && m.name) || fallback || '名前の分からないモンスター';
  };
  const out = [];
  if (rows) {
    rows.forEach((row, index) => {
      if (!row || row.monsterId == null) return;
      const kind = subjectKind(quest, row);
      out.push({
        index, key: `${row.monsterId}:${kind ?? 'normal'}#${index}`, monsterId: row.monsterId,
        name: nameOf(row.monsterId, kind, row.nameJa), kind, missionTarget: row,
        health: targetHealth(row, { players }), paramGroup: row.paramGroup ?? null,
      });
    });
    return out;
  }
  expandedLargeTargets(quest).forEach((t, index) => {
    const kind = kindOf(t.variant);
    out.push({
      index, key: `${t.monsterId}:${kind ?? 'normal'}#${index}`, monsterId: t.monsterId,
      name: nameOf(t.monsterId, kind, t.name), kind, missionTarget: null,
      health: targetHealth(null, { players }), paramGroup: null,
    });
  });
  return out;
}

// ---------------------------------------------------------------- 体力と討伐までの回数

/** 人数を 1〜MAX_PLAYERS の整数に */
export function clampPlayers(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 1;
  return Math.min(MAX_PLAYERS, Math.max(1, v));
}

/**
 * 狩猟対象 1 体の体力。ソロは healthCalc (確度 medium)。2 人以上は multi.health[人数] を掛ける (確度 low。四捨五入)。
 * @param missionTarget quests.json の mission.targets[] の 1 行 (null なら体力不明)
 * @returns {{known: boolean, solo: {mid, min, max}|null, players: number, multiplier: number|null,
 *            total: {mid, min, max}|null, perPlayer: {mid}|null,
 *            confidence: {solo: string|null, multi: 'low'|null}, reason: null|'no-health'|'no-multi'}}
 *   known = ソロの体力が分かるか。その人数の倍率が無い (maxPlayers を超えたなど) ときは multiplier・total が null (reason 'no-multi')。
 *   perPlayer = 1 人あたり (全員が同じだけ当てる前提の目安)。
 */
export function targetHealth(missionTarget, { players = 1 } = {}) {
  const n = clampPlayers(players);
  const solo = soloHealthOf(missionTarget);
  if (!solo) {
    return {
      known: false, solo: null, players: n, multiplier: null, total: null, perPlayer: null,
      confidence: { solo: null, multi: null }, reason: 'no-health',
    };
  }
  const hc = missionTarget.healthCalc;
  let multiplier = 1;
  let multiConf = null;
  if (n > 1) {
    const mt = isObj(missionTarget.multi) ? missionTarget.multi : null;
    const table = mt && isObj(mt.health) ? mt.health : null;
    multiplier = table ? finite(Number(table[String(n)])) : null;
    multiConf = (mt && mt.confidence) || 'low';
  }
  const scale = (x) => Math.round(x * multiplier);
  const total = multiplier == null ? null : { mid: scale(solo.mid), min: scale(solo.min), max: scale(solo.max) };
  return {
    known: true, solo, players: n, multiplier, total,
    perPlayer: total ? { mid: Math.round(total.mid / n) } : null,
    confidence: { solo: hc.confidence || 'medium', multi: multiConf },
    reason: multiplier == null ? 'no-multi' : null,
  };
}

/** 体力 (数 / {mid, min, max} / targetHealth の結果) → {mid, min, max} か null */
function healthRange(health) {
  if (typeof health === 'number') return Number.isFinite(health) && health > 0 ? { mid: health, min: health, max: health } : null;
  if (!isObj(health)) return null;
  if (health.known === false) return null;
  if ('total' in health || 'solo' in health) return healthRange(health.total);
  const mid = finite(health.mid);
  if (mid == null || mid <= 0) return null;
  return { mid, min: finite(health.min) ?? mid, max: finite(health.max) ?? mid };
}

/**
 * 討伐までのコンボの回数 (体力 ÷ 1 コンボの期待値。切り上げ)。
 * @param health 数 / {mid, min, max} / targetHealth の結果 (total を使う)
 * @param comboValue 1 コンボの期待値 (部位の割合で平均したもの)
 * @returns {{mid, min, max} | null} 期待値が 0 以下・数でない・体力不明なら null
 */
export function combosToDefeat(health, comboValue) {
  const v = Number(comboValue);
  if (comboValue == null || !Number.isFinite(v) || v <= 0) return null;
  const h = healthRange(health);
  if (!h) return null;
  return { mid: Math.ceil(h.mid / v), min: Math.ceil(h.min / v), max: Math.ceil(h.max / v) };
}

// ---------------------------------------------------------------- 攻撃の強さ

/**
 * 攻撃の強さの目安 (attackRate = クエストの攻撃 × 群の平常/怒りの倍率。掛け方は推定で確度 low)。
 * 比べる相手 = 同じモンスターの歴戦の個体が出る別のクエストのうち、装備固定でなく attackRate のあるもの
 * (★ が一番高いもの。同じ ★ なら多頭でないもの、それも同じならデータの並びで先のもの)。
 * @param subjectIndex mission.targets の行の番号 (questSubjects の index)
 * @returns {{calm, angry, paramGroup, compareTo: {questId, name, stars, calm, angry}|null,
 *            ratio: {calm, angry}|null, confidence: 'low'} | null}  attackRate が無い (通常の個体など) なら null
 */
export function attackView(quest, subjectIndex, targetData) {
  const rows = quest && quest.mission && Array.isArray(quest.mission.targets) ? quest.mission.targets : null;
  const row = rows ? rows[subjectIndex] : null;
  const ar = row && isObj(row.attackRate) ? row.attackRate : null;
  const calm = ar ? finite(ar.calm) : null;
  if (calm == null) return null;
  const angry = finite(ar.angry);
  let best = null;
  for (const q of questsOf(targetData)) {
    if (!q || q === quest || q.id === quest.id || q.fixedEquipment === true || !q.mission || !Array.isArray(q.mission.targets)) continue;
    for (const t of q.mission.targets) {
      if (!t || t.monsterId !== row.monsterId || t.variant !== 'tempered' || !isObj(t.attackRate)) continue;
      if (finite(t.attackRate.calm) == null) continue;
      const cand = { q, t, stars: finite(q.stars) ?? -1, multi: !!q.multi };
      if (!best || cand.stars > best.stars || (cand.stars === best.stars && best.multi && !cand.multi)) best = cand;
    }
  }
  const compareTo = best ? {
    questId: best.q.id, name: best.q.name, stars: finite(best.q.stars),
    calm: finite(best.t.attackRate.calm), angry: finite(best.t.attackRate.angry),
  } : null;
  const ratio = compareTo ? {
    calm: compareTo.calm > 0 ? calm / compareTo.calm : null,
    angry: angry != null && compareTo.angry > 0 ? angry / compareTo.angry : null,
  } : null;
  return { calm, angry, paramGroup: row.paramGroup ?? null, compareTo, ratio, confidence: ar.confidence || 'low' };
}
