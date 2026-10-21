// 相手タブの段階 3 のカード: 個体・クエスト・人数・体力と強さ・この相手のおすすめ・このクエストの相手 (多頭)・歴戦王で変わること。
// 担当: ui-target (3d)。画面は docs/RECOMMEND_DESIGN.md 4.2 節。計算は app/model/hunt.js (体力・回数・個体の肉質) と
// app/model/recommend.js (buildPlan)。状態は state.js の selectIndividual / selectQuest / setPlayers / setUseUncertainWound、
// 「この相手で装備を探す」は requestSearch() のあと shell.js の goToTab('search', {top: true}) (探し始めるのは探すタブ)。
// 見た目は app/ui/styles_target.css (class は th-*)。
//
// 討伐までの回数 = 体力 ÷ いまの装備の 1 コンボの期待値 (火力タブと同じ計算: power_calc.js の mixTotal。部位の割合で平均)。
// 拘束・部位破壊・ダウン・状態異常などは入れない目安。印の使い分けは docs/RECOMMEND_DESIGN.md 2.8 節
// (おすすめの判断 = 仮、確かめていないデータ = 未確認、根拠の弱い数値 = 未確定)。
// buildPlan が Plan を作れない (null・例外) ときは「この相手のおすすめ」は出さず、「装備を探す」のカードだけを出す。
import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  html, Card, Button, Hint, Badge, Notice, Segmented, Select, PickerField, Picker, ELEMENT_LABEL, formatNumber,
} from '../components/index.js';
import {
  useAppState, selectMonster, selectIndividual, selectQuest, setPlayers, setTabState, requestSearch, resolveCombo,
} from '../../state.js';
import * as recommend from '../../model/recommend.js';
import {
  individualsOf, individualOf, questsFor, questsOf, questSubjects, combosToDefeat, attackView, woundVitalOf, monsterById,
  MARK_LABEL,
} from '../../model/hunt.js';
import { mixTotal } from './power_calc.js';
import * as L from './equip_logic.js';
import {
  questContext, subjectTargets, readPartsMemo, partsMemoPatch, defaultPartKey, findMonster, partLabel, monsterStatusOf,
  individualKindOf,
} from './target_mix.js';
import { goToTab } from '../shell.js';

const elemName = (t) => ELEMENT_LABEL[t] || t;
/** クエストの種類 (quests.json の type) */
export const QUEST_TYPE_LABEL = { hunt: '狩猟', slay: '討伐', capture: '捕獲', arena: 'アリーナ', special: '特殊', delivery: '納品' };
/** 配信の状態 (availability.status)。standard (いつでも受けられる) は書かない */
export const QUEST_STATUS_LABEL = { permanent: '常設', active: '配信中', inactive: '終了' };
/** 肉質の変わり方を出す項目 (片手剣に関係するものだけ。弾・気絶は出さない) */
const WOUND_KEYS = ['slash', 'blunt', 'fire', 'water', 'thunder', 'ice', 'dragon'];

// ---------------------------------------------------------------- 印

/** hunt.js の印 (mark) → 共通の Badge。uncertain = 未確定 / unverified = 未確認 / provisional = 仮 */
export function MarkBadge({ mark }) {
  if (mark === 'uncertain') return html`<${Badge} kind="unconfirmed" />`;
  if (mark === 'unverified') return html`<${Badge} kind="warn">${MARK_LABEL.unverified}</${Badge}>`;
  if (mark === 'provisional') return html`<${Badge} kind="warn">${MARK_LABEL.provisional}</${Badge}>`;
  return null;
}

// ---------------------------------------------------------------- 「この相手のおすすめ」の作り方 (テストで差し替えられる)

let planBuilderOverride = null;
const planListeners = new Set();

/**
 * 「この相手のおすすめ」を作る関数を差し替える (テスト用。null で元の recommend.buildPlan に戻す)。
 * tests/smoke_ui.py が docs/RECOMMEND_DESIGN.md 5.3 節の形の作り物の Plan で見た目を確かめるのに使う。
 */
export function setPlanBuilderForTest(fn) {
  planBuilderOverride = typeof fn === 'function' ? fn : null;
  for (const f of [...planListeners]) f();
}

function usePlanBuilder() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const f = () => setTick((x) => x + 1);
    planListeners.add(f);
    return () => planListeners.delete(f);
  }, []);
  return planBuilderOverride || (typeof recommend.buildPlan === 'function' ? recommend.buildPlan : null);
}

// ---------------------------------------------------------------- モンスターを替える (部位の選び方を覚えておく)

/**
 * 相手のモンスターを替える前に、今のモンスターの部位の選び方を tabs.target.memo に残し、
 * 替えた先のモンスターに覚えがあればその部位 (と割合) を戻す。覚えが無ければ弱点 1 か所 (defaultPartKey)。
 * @returns {string|null} 替えた先で選ぶ部位
 */
function rememberAndRestoreParts(td, ui, target, monsterId) {
  const monster = findMonster(td, monsterId);
  const patch = partsMemoPatch(ui, target) || {};
  const memo = readPartsMemo({ ...(ui || {}), ...patch }, monsterId, monster);
  if (memo && memo.mix) patch.mix = { on: true, monsterId, weights: memo.mix.weights };
  if (Object.keys(patch).length) setTabState('target', patch);
  return (memo && memo.partKey) || defaultPartKey(monster);
}

/**
 * モンスター欄で選んだとき (target.js)。部位の選び方を覚え・戻し、通常の個体の既定のクエストを選んでおく
 * (docs/RECOMMEND_DESIGN.md 2.2 節の規則。体力と討伐までの回数がすぐ出るように)。
 */
export function pickMonster(td, ui, target, monsterId) {
  if (monsterId == null) {
    selectMonster(null);
    return;
  }
  const partKey = rememberAndRestoreParts(td, ui, target, monsterId);
  selectMonster(monsterId, partKey);
  selectIndividual(null, { targetData: td });
}

/** クエストの相手を替える (多頭の行をタップ・クエストの名前から選ぶ)。クエストは残す */
function switchSubject(td, ui, target, { questId, monsterId, kind, targetIndex }) {
  if (monsterId === target.monsterId && target.mode === 'monster') {
    selectQuest(questId, { targetIndex, individual: kind });
    return;
  }
  const partKey = rememberAndRestoreParts(td, ui, target, monsterId);
  selectQuest(questId, { targetIndex, monsterId, individual: kind, partKey });
}

// ---------------------------------------------------------------- クエストの見せ方

const largeCount = (q) => {
  const n = Number(q.largeTargetCount);
  if (Number.isFinite(n) && n > 0) return n;
  return (q.targets || []).filter((t) => t && t.large).reduce((a, t) => a + (Number(t.count) || 1), 0);
};

/** クエストの印 (終了中・配信中・装備固定・多頭) */
function questBadgeList(q) {
  const out = [];
  const status = q.availability && q.availability.status;
  if (status === 'inactive') out.push({ kind: 'warn', text: 'いまは受けられません' });
  else if (status === 'active') out.push({ kind: 'info', text: '配信中' });
  if (q.fixedEquipment === true) out.push({ kind: 'info', text: '装備固定' });
  const n = largeCount(q);
  if (q.multi && n > 1) out.push({ kind: 'info', text: `${n} 頭` });
  return out;
}

function QuestBadges({ q }) {
  const list = questBadgeList(q);
  if (!list.length) return null;
  return html`<span class="th-qbadges">${list.map((b) => html`<${Badge} key=${b.text} kind=${b.kind}>${b.text}</${Badge}>`)}</span>`;
}

/**
 * クエストの 2 行目「★10・狩猟・常設・体力 79,923」。
 * health: {mid} = 体力 / null = 体力不明 / undefined = 書かない。extra は種類の後ろに足す文 (狩猟対象の名前など)
 */
function questSub(q, health, extra) {
  const parts = [];
  if (q.stars != null) parts.push(`★${q.stars}`);
  if (QUEST_TYPE_LABEL[q.type]) parts.push(QUEST_TYPE_LABEL[q.type]);
  const st = QUEST_STATUS_LABEL[q.availability && q.availability.status];
  if (st) parts.push(st);
  if (extra) parts.push(extra);
  if (health !== undefined) parts.push(health ? `体力 ${formatNumber(health.mid)}` : '体力不明');
  return parts.join('・');
}

/** クエストの大型の狩猟対象の名前 (個体の名前。2 頭以上は ×2) */
function largeNames(q, td) {
  return (q.targets || []).filter((t) => t && t.large).map((t) => {
    const m = monsterById(td, t.monsterId);
    const ind = m && t.variant ? individualOf(m, t.variant) : null;
    const name = (ind && ind.name) || (m && m.name) || t.name || '';
    return Number(t.count) > 1 ? `${name} ×${t.count}` : name;
  });
}

/** 全クエストの一覧 (★ の高い順・★ ごとの見出し) */
function allQuestItems(td) {
  return questsOf(td).map((q, i) => ({ q, i }))
    .sort((a, b) => (b.q.stars ?? -1) - (a.q.stars ?? -1) || a.i - b.i)
    .map(({ q }) => {
      const names = largeNames(q, td);
      const subs = questSubjects(q, td);
      const health = subs.length === 1 ? (subs[0].health.known ? subs[0].health.solo : null) : undefined;
      return {
        value: q.id, label: q.name, group: q.stars != null ? `★${q.stars}` : '★なし',
        sub: questSub(q, health, names.join('・')), keywords: [q.nameEn || '', ...names].join(' '),
        badge: html`<${QuestBadges} q=${q} />`,
      };
    });
}

/** 「クエストの名前から選ぶ」で選んだとき: モンスター = 大型の 1 体目・個体 = その行の個体 */
function pickQuestByName(td, ui, target, questId) {
  const q = questsOf(td).find((x) => x.id === questId);
  if (!q) return;
  const s = questSubjects(q, td)[0];
  if (!s) {
    selectQuest(questId, { targetIndex: 0 });
    return;
  }
  switchSubject(td, ui, target, { questId, monsterId: s.monsterId, kind: s.kind, targetIndex: s.index });
}

/** モンスターのカードに置く「クエストの名前から選ぶ」(全 220 件) */
export function QuestNameEntry({ td, target, ui }) {
  const [open, setOpen] = useState(false);
  // 開くまで作らない (220 件の 2 行目を作るのに少し時間がかかるため)
  const items = useMemo(() => (open ? allQuestItems(td) : []), [td, open]);
  const count = useMemo(() => questsOf(td).length, [td]);
  return html`
    <button type="button" class="row row-button th-entry" data-th-quest-by-name onClick=${() => setOpen(true)}>
      <span class="row-main">
        <span class="row-value">クエストの名前から選ぶ</span>
        <span class="row-sub">全 ${count} 件。多頭のクエストもここから</span>
      </span>
      <span class="row-chevron" aria-hidden="true">›</span>
    </button>
    <${Picker} open=${open} title="クエストを選ぶ" items=${items} value=${target.questId}
      onSelect=${(id) => id != null && pickQuestByName(td, ui, target, id)} onClose=${() => setOpen(false)}
      searchPlaceholder="クエストの名前で探す" />`;
}

// ---------------------------------------------------------------- 個体・クエスト・人数

function IndividualField({ monster, kind, td }) {
  const list = individualsOf(monster);
  if (list.length <= 1) return null;
  const options = list.map((i) => ({ value: i.kind, label: i.label }));
  const onChange = (k) => selectIndividual(k, { targetData: td });
  // 3 つまでは並べて、4 つ以上 (ネルスキュラなど) は選ぶ欄にする
  return html`
    <div class="th-field" data-th-individual>
      ${list.length <= 3
        ? html`<${Segmented} label="個体" value=${kind} options=${options} onChange=${onChange} />`
        : html`<${Select} label="個体" value=${kind} options=${options} onChange=${onChange} />`}
    </div>`;
}

function QuestCard({ td, monster, target, ctx }) {
  const kind = individualKindOf(target);
  const rows = useMemo(() => questsFor(td, monster.id, kind), [td, monster, kind]);
  const items = useMemo(() => rows.map((r) => ({
    value: r.id, label: r.name, group: r.role === 'target' ? '狩猟対象' : '乱入の可能性',
    sub: questSub(r.quest, r.role === 'target' ? (r.health || null) : undefined),
    keywords: r.quest.nameEn || '', badge: html`<${QuestBadges} q=${r.quest} />`,
  })), [rows]);
  const onQuest = (id) => {
    if (id == null) {
      selectQuest(null);
      return;
    }
    const r = rows.find((x) => x.id === id);
    selectQuest(id, { targetIndex: r && r.subjectIndex != null ? r.subjectIndex : 0 });
  };
  const q = ctx && ctx.quest;
  const intruders = q ? (q.intruders || []).map((x) => x && x.name).filter(Boolean) : [];
  return html`
    <${Card} title="個体とクエスト" sub="クエストを選ぶと、体力と討伐までの回数の目安が出ます">
      <${IndividualField} monster=${monster} kind=${kind} td=${td} />
      <${PickerField} label="クエスト" title="クエストを選ぶ" items=${items} value=${target.questId}
        display=${q ? q.name : null} end=${q ? html`<${QuestBadges} q=${q} />` : null}
        sub=${q ? questSub(q, ctx.current ? (ctx.current.health.known ? ctx.current.health.solo : null) : undefined) : undefined}
        onChange=${onQuest} allowNone noneLabel="選ばない" placeholder=${rows.length ? '選んでいません' : 'このモンスターのクエストがありません'}
        searchPlaceholder="クエストの名前で探す" />
      ${q && q.availability && q.availability.status === 'inactive' && html`<${Hint}>このクエストはいま配信されていません (体力などは出します)。</${Hint}>`}
      ${ctx && ctx.fixed && html`
        <${Notice} kind="info" title="装備が決められたクエストです">
          <p>体力などは出しますが、装備は探しません。</p>
        </${Notice}>`}
      ${intruders.length > 0 && html`<${Hint}>乱入することがある大型: ${intruders.join('・')} (体力と回数には入れていません)</${Hint}>`}
      ${q && q.mission && html`
        <div class="th-field" data-th-players>
          <${Segmented} label="人数" value=${ctx.players} onChange=${(n) => setPlayers(n)}
            options=${Array.from({ length: ctx.maxPlayers }, (_, i) => ({ value: i + 1, label: `${i + 1} 人` }))} />
        </div>`}
    </${Card}>`;
}

// ---------------------------------------------------------------- 火力 (いまの装備の 1 コンボの期待値)

/** 討伐までの回数に使う、火力タブと同じ入力 (damage.js の comboExpected の形。monsterStatus は相手ごとに足す) */
function useHuntPower({ data, idx, buildResult, weaponFull }) {
  const comboRef = useAppState((s) => s.combo);
  const uptimes = useAppState((s) => s.uptimes);
  const sharpSel = useAppState((s) => s.sharpness);
  return useMemo(() => {
    const combo = resolveCombo(comboRef, data.combos);
    const comboName = combo ? (Array.isArray(combo) ? '自分で組んだコンボ' : combo.name) : '';
    if (!weaponFull || !buildResult) return { input: null, reason: 'no-weapon', comboName };
    if (!combo) return { input: null, reason: 'no-combo', comboName };
    const autoColor = L.autoSharpness(weaponFull, idx, buildResult.skillLevels).color;
    return {
      comboName, reason: null,
      input: {
        weapon: L.damageWeapon(weaponFull), sharpness: sharpSel || autoColor || 'white', skills: buildResult.skills,
        uptimes, effects: data.skillEffects, motions: data.motions, combo,
        perSkills: L.sharpnessResolver(weaponFull, idx, sharpSel),
      },
    };
  }, [comboRef, uptimes, sharpSel, data, idx, buildResult, weaponFull]);
}

const shareText = (w) => `${Math.round(w * 100)}%`;

/** クエストの相手ごとの 1 コンボの期待値 {[subject.key]: {value, partsText, reason}} */
function subjectValues({ ctx, td, target, ui, power }) {
  const out = {};
  for (const s of ctx.subjects) {
    const tm = subjectTargets(td, s, target, ui);
    if (!tm) {
      out[s.key] = { value: null, reason: 'no-part' };
      continue;
    }
    const partsText = tm.mixed ? tm.targets.map((x) => `${x.label} ${shareText(x.weight)}`).join('・') : tm.targets[0].label;
    if (!power.input) {
      out[s.key] = { value: null, reason: power.reason, partsText };
      continue;
    }
    try {
      const monsterStatus = monsterStatusOf({ mode: 'monster', monsterId: s.monsterId }, td) || [];
      const value = mixTotal({ ...power.input, monsterStatus }, tm.targets);
      out[s.key] = value > 0 ? { value, partsText, reason: null } : { value: null, partsText, reason: 'zero' };
    } catch (e) {
      console.warn('討伐までの回数の計算に失敗', e);
      out[s.key] = { value: null, partsText, reason: 'error' };
    }
  }
  return out;
}

// ---------------------------------------------------------------- 体力と強さ

function Stat({ label, children, attr }) {
  return html`
    <div class="th-stat" ...${attr || {}}>
      <dt>${label}</dt>
      <dd>${children}</dd>
    </div>`;
}

const ratioText = (r) => `約 ${formatNumber(r, 2)} 倍`;

/** 数の並び (平常・怒りなど)。1 つずつ折り返さない塊にして、狭いときは塊ごとに次の行へ */
const numChunks = (list) => list.map((t, i) => html`${i > 0 ? '・' : ''}<span class="th-num th-num-small" key=${t}>${t}</span>`);

function AttackValue({ view }) {
  if (view.compareTo && view.ratio && view.ratio.calm != null) {
    const c = view.compareTo;
    const same = view.ratio.angry == null || Math.abs(view.ratio.angry - view.ratio.calm) < 0.005;
    return html`
      <span class="th-sub">「${c.name}」(★${c.stars ?? '?'}・歴戦の個体) の</span>
      ${numChunks(same ? [ratioText(view.ratio.calm)]
        : [`平常 ${ratioText(view.ratio.calm)}`, `怒り ${ratioText(view.ratio.angry)}`])} <${Badge} kind="unconfirmed" />`;
  }
  return html`
    ${numChunks([`平常 ${formatNumber(view.calm, 2)}`, `怒り ${formatNumber(view.angry, 2)}`])}
    <${Badge} kind="unconfirmed" />
    <span class="th-sub">比べられる別のクエストがありません</span>`;
}

/** 討伐までの回数が出ない理由 */
function noComboText(reason) {
  switch (reason) {
    case 'no-weapon': return '武器を選ぶと出ます';
    case 'no-combo': return 'コンボのデータがありません';
    case 'no-part': return '狙う部位を選ぶと出ます';
    case 'zero': return '期待値が 0 なので数えられません';
    default: return '期待値を計算できませんでした';
  }
}

function HealthCard({ ctx, td, power, values, onEquip }) {
  const s = ctx.current;
  const q = ctx.quest;
  if (!s) {
    return html`
      <${Card} title="体力と強さ" sub=${`${q.name} ★${q.stars ?? '?'}`}>
        <div data-th-card="health">
          <${Notice} kind="info" title=${ctx.intruder ? 'このクエストでは乱入するかもしれない相手です' : 'このクエストの狩猟対象ではありません'}>
            <p>体力のデータはありません。${ctx.subjects.length ? '下の「このクエストの相手」から狩猟対象を選べます。' : ''}</p>
          </${Notice}>
        </div>
      </${Card}>`;
  }
  const h = s.health;
  const monster = monsterById(td, s.monsterId);
  const atk = attackView(q, s.index, td);
  const wv = woundVitalOf(monster, s.paramGroup);
  const v = values && values[s.key];
  const solo = h.known ? combosToDefeat(h.solo, v && v.value) : null;
  const per = h.known && h.total && ctx.players > 1 && v && v.value ? combosToDefeat(h.total.mid / ctx.players, v.value) : null;
  const multiRates = s.missionTarget && s.missionTarget.multi && s.missionTarget.multi.health;
  return html`
    <${Card} title="体力と強さ" sub=${`${q.name} ★${q.stars ?? '?'}${ctx.multi ? `・${s.name}` : ''}`}>
      <dl class="th-stats" data-th-card="health" data-th-subject=${s.key}>
        <${Stat} label="体力 (1 人)">
          ${h.known ? html`
            <span class="th-num" data-th-health=${String(h.solo.mid)}>${formatNumber(h.solo.mid)}</span>
            ${h.solo.min !== h.solo.max && html`
              <span class="th-sub" data-th-health-range>${formatNumber(h.solo.min)}〜${formatNumber(h.solo.max)} (出るたびに少し違う)</span>`}`
          : html`<span class="th-sub th-sub-first" data-th-health="">このクエストの体力のデータがありません</span>`}
        </${Stat}>
        ${h.known && ctx.players > 1 && html`
          <${Stat} label=${`${ctx.players} 人のとき`}>
            ${h.total ? html`
              <span class="th-num" data-th-total=${String(h.total.mid)}>約 ${formatNumber(h.total.mid)}</span> <${Badge} kind="unconfirmed" />
              <span class="th-sub">1 人の ${formatNumber(h.multiplier, 2)} 倍</span>`
            : html`<span class="th-sub th-sub-first" data-th-total="">この人数の倍率が分かりません</span>`}
          </${Stat}>`}
        ${atk && html`<${Stat} label="攻撃の強さ" attr=${{ 'data-th-attack': '1' }}><${AttackValue} view=${atk} /></${Stat}>`}
        ${wv && wv.normal != null && html`
          <${Stat} label="傷の付きにくさ">
            <span class="th-num th-num-small">ふつうの ${formatNumber(wv.normal, 1)} 倍</span> <${Badge} kind="unconfirmed" />
          </${Stat}>`}
        ${h.known && html`
          <${Stat} label="討伐まで">
            ${ctx.fixed ? html`<span class="th-sub th-sub-first">装備が決められたクエストなので出しません</span>`
              : solo ? html`
                <span class="th-num" data-th-combos=${String(solo.mid)} data-th-combo-value=${String(v.value)}>約 ${formatNumber(solo.mid)} 回</span>
                ${solo.min !== solo.max && html`<span class="th-sub">${formatNumber(solo.min)}〜${formatNumber(solo.max)} 回</span>`}
                <span class="th-sub">いまの装備・「${power.comboName}」・${v.partsText}で (1 コンボ ${formatNumber(v.value, 1)})</span>
                ${per && html`<span class="th-sub">${ctx.players} 人のとき 1 人あたり 約 ${formatNumber(per.mid)} 回 <${Badge} kind="unconfirmed" /></span>`}`
              : html`
                <span class="th-sub th-sub-first" data-th-combos="">${noComboText(v ? v.reason : power.reason)}</span>
                ${(v ? v.reason : power.reason) === 'no-weapon' && html`
                  <span class="th-stat-action"><${Button} small onClick=${onEquip}>装備タブで武器を選ぶ</${Button}></span>`}`}
          </${Stat}>`}
      </dl>
      ${h.known && !ctx.fixed && html`
        <${Hint}>1 コンボの期待値 (火力タブの値) で体力を割っただけの目安です。拘束・部位破壊・ダウン・状態異常などは入っていません。</${Hint}>`}
      ${s.kind === 'arch-tempered' && html`<${Hint}>歴戦王は傷が付きにくいので、傷口を狙う技の回数は減ります (回数には入れていません)。</${Hint}>`}
      <details class="more">
        <summary>くわしく</summary>
        <ul class="th-list">
          <li>体力はゲームのデータ (MHWS-in-json の MissionData) から計算した値です (ソロ = 基礎体力 × クエストの倍率 × 個体の倍率 × 出るたびの乱数)。第三者の実測 1 件と一致しています。</li>
          ${multiRates && html`<li>2 人以上は、ソロの体力に人数の倍率 (${Object.entries(multiRates).map(([n, r]) => `${n} 人 ${formatNumber(r, 2)}`).join('・')}) を掛けています。倍率の読み方は確かめていません (未確定)。1 人あたりは、全員が同じだけ当てる前提の目安です。</li>`}
          ${atk && html`<li>攻撃の強さは、クエストの攻撃の倍率に個体の倍率を掛けた値です。掛け方は推定です (未確定)。受けるダメージは計算できないので、体力・回復のスキルは自動では足しません。</li>`}
          ${wv && html`<li>傷の付きにくさは、データの値 (woundVital) を名前から「傷の付きにくさ」と読んだものです (未確定)。</li>`}
          <li>討伐までの回数に入っていないもの: 傷口の付け方・部位破壊・ダウン・状態異常・属性やられ・肉質の変化・回避や移動の時間・捕獲 (捕獲できる体力のデータがありません)。狩猟クエストは、捕獲ならもっと少なく済みます。</li>
          <li>出典: MHWS-in-json (ゲームのデータ)・Monster Hunter Wiki (CC BY-SA 4.0)。</li>
        </ul>
      </details>
    </${Card}>`;
}

// ---------------------------------------------------------------- このクエストの相手 (多頭)

function MultiCard({ ctx, values, target, ui, td }) {
  const rows = ctx.subjects.map((s) => {
    const v = values && values[s.key];
    const combos = s.health.known && v && v.value ? combosToDefeat(s.health, v.value) : null;
    return { s, v, combos };
  });
  const allHealth = rows.every((r) => r.s.health.total);
  const totalHealth = allHealth ? rows.reduce((a, r) => a + r.s.health.total.mid, 0) : null;
  const allCombos = !ctx.fixed && rows.length > 0 && rows.every((r) => r.combos);
  const totalCombos = allCombos ? rows.reduce((a, r) => a + r.combos.mid, 0) : null;
  const multiPlayers = ctx.players > 1;
  return html`
    <${Card} title="このクエストの相手" sub=${`${ctx.subjects.length} 頭・タップすると、その相手を下のカードに出します`}>
      <div class="th-subjects" data-th-card="multi">
        ${rows.map(({ s, v, combos }) => {
          const selected = !!ctx.current && ctx.current.key === s.key;
          return html`
            <button type="button" key=${s.key} class=${`th-subject${selected ? ' is-selected' : ''}`} aria-pressed=${selected ? 'true' : 'false'}
              data-th-subject=${s.key} onClick=${() => switchSubject(td, ui, target, { questId: ctx.quest.id, monsterId: s.monsterId, kind: s.kind, targetIndex: s.index })}>
              <span class="th-subject-name">${s.name}</span>
              <span class="th-subject-nums">
                <span>体力 ${s.health.total ? formatNumber(s.health.total.mid) : '不明'}</span>
                <span>${ctx.fixed ? '' : combos ? `約 ${formatNumber(combos.mid)} 回` : (v && v.reason === 'no-weapon' ? '' : '回数は不明')}</span>
              </span>
            </button>`;
        })}
      </div>
      <div class="th-total" data-th-multi-total=${totalCombos != null ? String(totalCombos) : ''}>
        ${totalCombos != null ? html`
          <span class="th-total-label">全部倒すまで</span>
          <span class="th-num">約 ${formatNumber(totalCombos)} 回</span>
          ${multiPlayers && html`<${Badge} kind="unconfirmed" />`}`
          : html`<span class="th-total-label">${ctx.fixed ? '装備が決められたクエストなので、回数は出しません' : '武器と部位が決まると、全部倒すまでの回数が出ます'}</span>`}
      </div>
      ${totalHealth != null && html`<p class="hint">体力の合計 ${formatNumber(totalHealth)}${multiPlayers ? ` (${ctx.players} 人のとき)` : ''}</p>`}
      <${Hint}>回数は、それぞれの相手を選んだときの部位 (選んだことが無ければ弱点 1 か所) で数えています。${multiPlayers ? '人数ぶんの体力の合計を、1 人の装備で割った回数です。' : ''}</${Hint}>
    </${Card}>`;
}

// ---------------------------------------------------------------- この相手のおすすめ (buildPlan の要約) / 装備を探す

/** おすすめ属性の見せ方 (target_mix.js の recommendationView の結果) → 文 */
function elementViewText(view, weaponElem) {
  if (!view || !Array.isArray(view.best)) return null;
  const best = view.best.map(elemName).join('・');
  let text;
  if (view.kind === 'none') text = 'おすすめなし';
  else if (view.kind === 'weak') text = 'どれも効きにくい';
  else if (view.kind === 'close') text = `どれもほぼ同じ (少しだけ ${best})`;
  else text = best;
  if (view.weapon === 'same') text += ' (いまの武器と同じ)';
  else if (view.weapon === 'close' && weaponElem) text += ` (いまの武器の${elemName(weaponElem)}でも大差なし)`;
  else if (view.weapon === 'other' && weaponElem) text += ` (いまの武器は${elemName(weaponElem)}。${best}の方が通る)`;
  return text;
}

/** 要件の「いま」(いまの装備のスキル Lv)。options はどれか 1 つを満たせばよい (「または」) */
function requirementNow(r, skillLevels) {
  const lv = (id) => Number((skillLevels || {})[id] ?? (skillLevels || {})[String(id)]) || 0;
  const options = (Array.isArray(r.options) ? r.options : []).filter((o) => Array.isArray(o) && o.length);
  if (!options.length) return null;
  const ok = options.some((o) => o.every((x) => lv(x.skillId) >= (Number(x.level) || 0)));
  if (options.length === 1 && options[0].length === 1) {
    const have = lv(options[0][0].skillId);
    const mitigated = !ok && r.mitigateLevel != null && have >= r.mitigateLevel;
    return { ok, mitigated, text: `いま ${have > 0 ? `Lv${have}` : 'なし'}` };
  }
  return { ok, mitigated: false, text: ok ? 'いま 満たしています' : 'いま 足りません' };
}

function RequirementRow({ r, skillLevels }) {
  const now = requirementNow(r, skillLevels);
  const why = (Array.isArray(r.why) ? r.why : []).map((w) => (w && w.text) || '').filter(Boolean);
  return html`
    <li class="th-req" data-th-req=${r.key}>
      <span class="th-req-main">
        <span class="th-req-label">${r.label}</span>
        ${r.provisional && html` <${MarkBadge} mark="provisional" />`}
        ${r.unconfirmed && html` <${MarkBadge} mark="unverified" />`}
        ${why.length > 0 && html`<span class="th-req-why">${why.join('・')}</span>`}
      </span>
      ${now && html`
        <span class="th-req-now">${now.text}${now.ok ? ' ✓' : ''}${now.mitigated ? html` <${Badge} kind="warn">軽くなります</${Badge}>` : ''}</span>`}
    </li>`;
}

function PlanCard({ plan, skillLevels, weaponElem, search, children }) {
  const reqs = Array.isArray(plan.requirements) ? plan.requirements.filter((r) => r && r.key != null) : [];
  const isOn = (r) => (typeof r.on === 'boolean' ? r.on : r.tier === 'on');
  const on = reqs.filter(isOn);
  const ref = reqs.filter((r) => !isOn(r));
  const notes = Array.isArray(plan.notes) ? plan.notes.filter((n) => n && n.text) : [];
  const warnings = Array.isArray(plan.warnings) ? plan.warnings.filter((w) => w && w.message) : [];
  const subjects = Array.isArray(plan.subjects) ? plan.subjects : [];
  const names = new Map(subjects.map((s) => [s.key, s.name]));
  const per = plan.element && Array.isArray(plan.element.perSubject) ? plan.element.perSubject : [];
  const elems = per.map((p) => ({ key: p.key, name: names.get(p.key) || '', text: elementViewText(p.view, weaponElem) }))
    .filter((x) => x.text);
  const two = plan.element && plan.element.twoWeapons && plan.element.twoWeapons.suggested;
  const subjectName = (key) => (subjects.length > 1 && names.get(key) ? `${names.get(key)}: ` : '');
  return html`
    <${Card} title=${subjects.length > 1 ? 'このクエストのおすすめ' : 'この相手のおすすめ'}
      sub="探すタブで、これを条件にして装備を探します" actions=${html`<${MarkBadge} mark="provisional" />`}>
      <div data-th-card="plan">
        ${elems.length > 0 && html`
          <p class="card-subhead th-subhead-first">属性</p>
          <ul class="th-list th-list-plain" data-th-plan-element>
            ${elems.map((e) => html`<li key=${e.key}>${elems.length > 1 ? `${e.name}: ` : ''}${e.text}</li>`)}
          </ul>
          ${two && html`<${Hint}>属性の違う相手がいるので、武器を 2 本持ち替える案も出します。</${Hint}>`}`}
        ${on.length > 0 && html`
          <p class="card-subhead">守り (必須にして探します)</p>
          <ul class="th-reqs" data-th-plan-on>${on.map((r) => html`<${RequirementRow} key=${r.key} r=${r} skillLevels=${skillLevels} />`)}</ul>`}
        ${ref.length > 0 && html`
          <p class="card-subhead">参考 (探すタブでオンにできます)</p>
          <ul class="th-reqs" data-th-plan-ref>${ref.map((r) => html`<${RequirementRow} key=${r.key} r=${r} skillLevels=${skillLevels} />`)}</ul>`}
        ${on.length === 0 && ref.length === 0 && html`<p class="hint">防ぐスキルの候補はありません。</p>`}
        ${notes.length > 0 && html`
          <p class="card-subhead">注意 (防げない攻撃など)</p>
          <ul class="th-list" data-th-plan-notes>${notes.map((n, i) => html`<li key=${i}>${subjectName(n.subjectKey)}${n.text}</li>`)}</ul>`}
        ${warnings.length > 0 && html`<ul class="th-list th-list-sub">${warnings.map((w, i) => html`<li key=${i}>${w.message}</li>`)}</ul>`}
        <p class="hint">守りの段: ${{ power: '火力優先', balance: 'バランス', safe: '安全' }[search.preset] || 'バランス'} (探すタブで変えられます)。「いま」は装備タブの装備のスキル Lv です。何を必須にするかは決めごとなので「仮」です。</p>
      </div>
      ${children}
    </${Card}>`;
}

function SearchButton({ ctx }) {
  if (ctx && ctx.fixed) {
    return html`
      <div data-th-search-blocked>
        <${Notice} kind="info" title="装備が決められたクエストなので、装備は探しません" />
      </div>`;
  }
  const label = ctx && ctx.multi ? 'このクエストで装備を探す' : 'この相手で装備を探す';
  const start = () => {
    requestSearch({ from: 'target' });
    goToTab('search', { top: true });
  };
  return html`<div class="btn-col"><${Button} variant="primary" block data-th-search onClick=${start}>${label}</${Button}></div>`;
}

// ---------------------------------------------------------------- 歴戦王で変わること

/** 個体の傷口の置き換えで変わる値 [{part, label, changes: [{key, from, to}]}] (片手剣に関係する項目だけ) */
function woundChanges(monster, kind) {
  const ind = individualOf(monster, kind);
  const ov = ind && ind.hitzone && ind.hitzone.woundOverrides;
  if (!ov) return [];
  const out = [];
  for (const p of monster.parts || []) {
    const o = ov[p.key];
    if (!o || !p.wound) continue;
    const changes = WOUND_KEYS.filter((k) => o[k] != null && o[k] !== p.wound[k]).map((k) => ({ key: k, from: p.wound[k], to: o[k] }));
    if (changes.length) out.push({ part: p, label: partLabel(p, monster), changes });
  }
  return out;
}

function HazardLine({ h }) {
  return html`
    <li>
      <span class="th-hz-text">${h.text} ${h.unverified && html`<${MarkBadge} mark="unverified" />`}</span>
      ${h.need ? html`
        <span class="th-sub th-sub-first">
          ${h.need.name} Lv${h.need.negateLevel} で無効${h.need.mitigateLevel ? ` (Lv${h.need.mitigateLevel} で軽く)` : ''}・いま ${h.need.have > 0 ? `Lv${h.need.have}` : 'なし'}
          ${h.need.negated ? html` <${Badge} kind="ok">防げています</${Badge}>` : h.need.mitigated ? html` <${Badge} kind="warn">軽くなります</${Badge}>` : ''}
        </span>`
        : html`<span class="th-sub th-sub-first">${h.noSkill}</span>`}
    </li>`;
}

function ArchTemperedCard({ monster, kind, info, data, target }) {
  const ind = individualOf(monster, kind);
  const v = info && info.variant;
  if (!ind && !v) return null;
  const hz = ind && ind.hitzone ? ind.hitzone : null;
  const changes = woundChanges(monster, kind);
  const rewards = ind && ind.rewards;
  const charmName = (id) => {
    const c = data.index && data.index.charmsFixed ? data.index.charmsFixed.get(id) : null;
    return c ? c.name : null;
  };
  const blocks = v ? v.hazards.filter((h) => h.need) : [];
  const unblockable = v ? v.hazards.filter((h) => !h.need) : [];
  const moves = v ? v.moveChanges : [];
  const untranslated = moves.filter((m) => !m.text && m.textEn);
  const madeOf = rewards ? [
    ...(rewards.armorSets || []).map((a) => `${a.name} (防具 ${(a.armorIds || []).length} 部位)`),
    ...(rewards.charmFixedIds || []).map(charmName).filter(Boolean),
  ] : [];
  const groupSkills = rewards ? (rewards.groupSkills || []).map((g) => `「${g.name}」`) : [];
  return html`
    <${Card} title="歴戦王で変わること" sub=${(ind && ind.name) || (v && v.name) || ''}>
      <div data-th-card="arch">
        ${moves.some((m) => m.text) && html`
          <p class="card-subhead th-subhead-first">動き</p>
          <ul class="th-list">${moves.filter((m) => m.text).map((m, i) => html`<li key=${i}>${m.text}</li>`)}</ul>`}
        ${blocks.length > 0 && html`
          <p class="card-subhead">防げる攻撃</p>
          <ul class="th-list th-list-plain">${blocks.map((h) => html`<${HazardLine} key=${h.key} h=${h} />`)}</ul>`}
        ${unblockable.length > 0 && html`
          <p class="card-subhead">防げない攻撃</p>
          <ul class="th-list th-list-plain">${unblockable.map((h) => html`<${HazardLine} key=${h.key} h=${h} />`)}</ul>`}
        ${v && v.sameAsBase && v.sameAsBase.all && html`
          <p class="hint">咆哮・風圧・振動・属性やられ・状態異常は、通常と同じと見ています ${v.sameAsBase.confidence !== 'high' && html`<${MarkBadge} mark="unverified" />`}</p>`}
        <p class="card-subhead">肉質</p>
        ${!hz || hz.sameAsBase === true ? html`<p class="hint th-hint-first">通常の個体と同じです。</p>`
          : hz.sameAsBase === false ? html`
            <p class="hint th-hint-first" data-th-arch-hitzone="changed">傷口の肉質が通常と違います <${MarkBadge} mark="unverified" /></p>
            ${changes.length > 0 && html`
              <ul class="th-list th-list-sub">${changes.map((c) => html`
                <li key=${c.part.key}>${c.label}の傷口: ${c.changes.map((x) => `${elemName(x.key)} ${x.from}→${x.to}`).join('・')}</li>`)}</ul>`}
            <p class="hint">狙う部位の「傷口」と、火力・装備タブの計算は、置き換え後の値を使います。</p>`
          : html`
            <p class="hint th-hint-first" data-th-arch-hitzone="uncertain">傷口の肉質が置き換わることがありますが、いつ置き換わるかは分かりません <${MarkBadge} mark="uncertain" /></p>
            <p class="hint">ふだんは通常の傷口で計算します。${target.useUncertainWound ? 'いまは「置き換わった傷口で計算する」がオンです。' : '狙う部位のカードの「置き換わった傷口で計算する (参考)」で切り替えられます。'}</p>`}
        ${madeOf.length > 0 && html`
          <p class="card-subhead">報酬</p>
          <p class="hint th-hint-first" data-th-arch-rewards>${rewards.certificate && rewards.certificate.name ? `「${rewards.certificate.name}」で` : 'この歴戦王の素材で'}、${madeOf.join('・')} が作れます。${groupSkills.length ? `γ 防具にはグループスキル${groupSkills.join('・')}が付きます。` : ''}</p>`}
        ${(untranslated.length > 0 || (v && v.sameAsBase && v.sameAsBase.reason) || (hz && hz.note)) && html`
          <details class="more">
            <summary>くわしく</summary>
            <ul class="th-list th-list-sub">
              ${untranslated.map((m, i) => html`<li key=${`en${i}`} lang="en">${m.textEn}</li>`)}
              ${v && v.sameAsBase && v.sameAsBase.reason && html`<li>通常と同じと見ている理由: ${v.sameAsBase.reason}</li>`}
              ${hz && hz.note && html`<li>${hz.note}</li>`}
              ${blocks.filter((h) => h.note).map((h) => html`<li key=${`n-${h.key}`}>${h.text}: ${h.note}</li>`)}
            </ul>
          </details>`}
        <p class="hint">
          出典: ${v && v.source ? html`<a href=${v.source} target="_blank" rel="noopener noreferrer">Monster Hunter Wiki</a>` : 'Monster Hunter Wiki'} (CC BY-SA 4.0)${rewards ? '・報酬は MHDB' : ''}。
        </p>
      </div>
    </${Card}>`;
}

// ---------------------------------------------------------------- まとめ (target.js から使う)

/**
 * 相手タブの段階 3 のカードをまとめて出す (モンスターを選んであるときだけ。target.js がモンスターのカードの後に置く)。
 * @param data core データ / td 相手のデータ / monster 選んだモンスター / target state.target / ui state.tabs.target
 * @param idx 画面で足した武器・護石も入った索引 / buildResult computeBuild の結果 (null 可) / weaponFull resolveWeaponRef の結果
 * @param info target_mix.js の threatInfo (個体つき) / active タブが見えているか
 */
export function HuntCards({ data, td, monster, target, ui, idx, buildResult, weaponFull, weaponElem, info, active }) {
  const search = useAppState((s) => s.search);
  const build = useAppState((s) => s.build);
  const comboRef = useAppState((s) => s.combo);
  const uptimes = useAppState((s) => s.uptimes);
  const sharpness = useAppState((s) => s.sharpness);
  const kind = individualKindOf(target);
  const ctx = useMemo(() => questContext(td, target), [td, target]);
  const power = useHuntPower({ data, idx, buildResult, weaponFull });
  const values = useMemo(() => (active && ctx ? subjectValues({ ctx, td, target, ui, power }) : null),
    [active, ctx, td, target, ui, power]);
  const builder = usePlanBuilder();
  const plan = useMemo(() => {
    if (!active || !builder) return null;
    try {
      const p = builder({
        target, tabTarget: ui, search, targetData: td,
        core: { index: idx, skillEffects: data.skillEffects, motions: data.motions, combos: data.combos },
        current: { build, combo: comboRef, uptimes, sharpness },
      });
      return p && typeof p === 'object' ? p : null;
    } catch (e) {
      console.warn('おすすめを作れませんでした', e);
      return null;
    }
  }, [active, builder, target, ui, search, td, idx, data, build, comboRef, uptimes, sharpness]);
  const skillLevels = (buildResult && buildResult.skillLevels) || {};
  const onEquip = () => goToTab('equip', { top: true });

  return html`
    <${QuestCard} td=${td} monster=${monster} target=${target} ctx=${ctx} />
    ${ctx && html`<${HealthCard} ctx=${ctx} td=${td} power=${power} values=${values} onEquip=${onEquip} />`}
    ${plan ? html`
      <${PlanCard} plan=${plan} skillLevels=${skillLevels} weaponElem=${weaponElem} search=${search}>
        <${SearchButton} ctx=${ctx} />
      </${PlanCard}>` : html`
      <${Card} title="装備を探す">
        <p class="hint th-hint-first">探すタブで、${ctx && ctx.multi ? 'このクエストの相手' : 'この相手'}に合わせて (守りのスキル・武器の属性も考えて) 火力の高い装備の組み合わせを探します。</p>
        <${SearchButton} ctx=${ctx} />
      </${Card}>`}
    ${ctx && (ctx.multi || !ctx.current) && ctx.subjects.length > 0 && html`
      <${MultiCard} ctx=${ctx} values=${values} target=${target} ui=${ui} td=${td} />`}
    ${kind === 'arch-tempered' && html`<${ArchTemperedCard} monster=${monster} kind=${kind} info=${info} data=${data} target=${target} />`}`;
}

/** 部位の傷口の印の行 (狙う部位・部位の肉質のカード)。hz は hunt.js の hitzoneFor の結果 */
export function WoundMarkLine({ hz }) {
  if (!hz || !hz.mark) return null;
  return html`<p class="hint th-mark-line" data-th-wound-mark=${hz.mark}><${MarkBadge} mark=${hz.mark} /> ${hz.note || ''}</p>`;
}
