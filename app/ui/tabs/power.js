// 火力タブ: いまの装備・相手・コンボでの期待値 (物理/属性の内訳・スキルなし比)、条件ごとの発動率、
// スキルごとの効き目 (外すと何 % 下がるか)、スキル火力表 (Lv ごとの上がり方)。
// 計算は damage.js (power_calc.js で「狙う部位の割合」の加重平均に包む)。相手の決め方は target_mix.js。
// 1 秒あたりの火力 (DPS) は出さない (技の時間が非公開)。コンボ 1 回あたりの期待値だけ。
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  html, Card, Button, Hint, Badge, Notice, Loading, ErrorBox, Slider, Segmented, Select,
  SHARPNESS_LABEL, ELEMENT_LABEL, formatNumber, formatPct, formatPctChange,
} from '../components/index.js';
import {
  useAppState, setCombo, setSharpness, setUptime, resetUptime, setTabState, resolveCombo, SHARPNESS_ORDER,
} from '../../state.js';
import { useTargetData } from '../../data.js';
import { computeBuild } from '../../model/build.js';
import {
  mixContribution, skillTableCandidates, tableContext, skillTableRow, sortTableRows, conditionSummary, rebalanceCategorical,
} from './power_calc.js';
import { resolveTargetMix, monsterStatusOf, ELEMENT_KEYS } from './target_mix.js';
import { useEquipIndex } from './equip_index.js';
import * as L from './equip_logic.js';
import { goToTab } from '../shell.js';

const EMPTY = Object.freeze({});
const KIND_SHORT = { set: 'シリーズ', group: 'グループ' };

// ---------------------------------------------------------------- 見た目 (このタブだけの class。色は styles.css の変数)

const STYLE_ID = 'mhwilds-sns-power-style';
const CSS = `
.pw-hero { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
.pw-stat { background: var(--surface-2); border-radius: var(--radius-small); padding: 10px 12px; min-width: 0; }
.pw-stat-label { display: block; font-size: 13px; color: var(--text-sub); }
.pw-stat-num { display: block; font-size: 28px; font-weight: 700; line-height: 1.25; font-variant-numeric: tabular-nums; }
.pw-stat-unit { font-size: 13px; color: var(--text-sub); }
.pw-explain { font-size: 13px; color: var(--text-sub); margin-top: 8px; }
.pw-split { display: flex; height: 10px; border-radius: 5px; overflow: hidden; background: var(--surface-3); margin-top: 12px; }
.pw-split > span { display: block; height: 100%; }
.pw-c-phys { background: var(--accent); }
.pw-c-elem { background: var(--sharp-orange); }
.pw-c-extra { background: var(--ok); }
.pw-legend { display: flex; flex-wrap: wrap; gap: 2px 14px; font-size: 14px; margin-top: 6px; font-variant-numeric: tabular-nums; }
.pw-dot { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
.pw-target { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pw-target-text { min-width: 0; }
.pw-target-label { display: block; font-size: 13px; color: var(--text-sub); }
.pw-steps { list-style: none; margin: 8px 0 0; padding: 0; }
.pw-steps li { display: flex; justify-content: space-between; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 14px; }
.pw-steps li:last-child { border-bottom: 0; }
.pw-steps .pw-num { flex: none; font-variant-numeric: tabular-nums; }
.pw-cond { padding: 12px 0; border-bottom: 1px solid var(--border); }
.pw-cond:first-child { padding-top: 0; }
.pw-cond:last-child { border-bottom: 0; padding-bottom: 0; }
.pw-cond-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 4px; }
.pw-cond-title { font-weight: 700; font-size: 15px; min-width: 0; }
.pw-cond-sub { font-size: 13px; color: var(--text-sub); margin-bottom: 4px; }
.pw-cond .field { margin-top: 4px; }
.pw-off { font-size: 13px; color: var(--text-sub); text-align: right; font-variant-numeric: tabular-nums; }
.pw-contrib { list-style: none; margin: 0; padding: 0; }
.pw-contrib li { padding: 8px 0; border-bottom: 1px solid var(--border); }
.pw-contrib li:last-child { border-bottom: 0; }
.pw-contrib-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.pw-contrib-name { min-width: 0; }
.pw-contrib-val { flex: none; font-weight: 700; font-variant-numeric: tabular-nums; }
.pw-contrib-val.is-zero { font-weight: 400; color: var(--text-sub); }
.pw-bar { height: 6px; border-radius: 3px; background: var(--surface-3); margin-top: 4px; overflow: hidden; }
.pw-bar > span { display: block; height: 100%; background: var(--accent); }
.pw-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin-top: 10px; border-top: 1px solid var(--border); }
.pw-table { border-collapse: separate; border-spacing: 0; font-size: 14px; min-width: 100%; }
.pw-table th, .pw-table td { padding: 6px 6px; border-bottom: 1px solid var(--border); text-align: right; vertical-align: top;
  white-space: nowrap; font-variant-numeric: tabular-nums; }
.pw-table th { font-size: 13px; font-weight: 700; color: var(--text-sub); background: var(--surface); }
.pw-table .pw-name { position: sticky; left: 0; z-index: 1; background: var(--surface); text-align: left; white-space: normal;
  min-width: 140px; max-width: 160px; box-shadow: 1px 0 0 var(--border); }
.pw-table th.pw-name[scope=row] { font-size: 14px; color: var(--text); font-weight: 400; }
.pw-table td.is-current { background: var(--accent-soft); }
.pw-table td.is-empty { color: var(--text-sub); }
.pw-cell-main { display: block; font-weight: 600; }
.pw-cell-next { display: block; font-size: 13px; color: var(--text-sub); }
.pw-name-main { display: block; font-weight: 600; }
.pw-name-sub { display: block; font-size: 13px; color: var(--text-sub); line-height: 1.35; }
.pw-name .badge { margin-top: 2px; }
.pw-list { margin: 4px 0 0; padding-left: 1.2em; }
.pw-list li + li { margin-top: 4px; }
.pw-stale { font-size: 13px; color: var(--text-sub); margin-top: 6px; }
`;

function ensureStyle() {
  try {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
  } catch { /* DOM の無い所では何もしない */ }
}
ensureStyle();

// ---------------------------------------------------------------- 小道具

/** % の差を画面用に (±0.05% 未満は「0%」。装備タブと同じ書き方) */
const pctText = formatPctChange;

function elementName(type) {
  return ELEMENT_LABEL[type] || type || '';
}

/** 1 秒あたりの火力ではない旨 (火力タブの決まり文句。スモークテストも見る) */
const NOT_DPS = '1 秒あたりの火力 (DPS) ではなく、コンボ 1 回あたりの期待値です。';

/** 計算が投げた例外を画面の文に */
function errorText(e) {
  const msg = e && e.message ? e.message : String(e);
  if (/組み合わせが多すぎる/.test(msg)) return '条件つきのスキルが多すぎて計算できません。発動率を 0% か 100% にすると減らせます。';
  return msg;
}

// ---------------------------------------------------------------- 期待値

function HeroCard({ r, combo, mixed }) {
  const total = r.total;
  const phys = total > 0 ? (r.physical / total) * 100 : 0;
  const elem = total > 0 ? (r.element / total) * 100 : 0;
  const extra = total > 0 ? (r.extra / total) * 100 : 0;
  return html`
    <${Card} title="コンボ1回の期待値" sub=${combo ? combo.name : ''}>
      <div class="pw-hero">
        <div class="pw-stat">
          <span class="pw-stat-label">期待ダメージ${mixed ? ' (部位の割合で平均)' : ''}</span>
          <span class="pw-stat-num" data-power-total=${String(total)}>${formatNumber(total, 0)}</span>
        </div>
        <div class="pw-stat">
          <span class="pw-stat-label">スキルなし比</span>
          <span class="pw-stat-num" data-power-vs=${String(r.vsNoSkillsPct)}>${pctText(r.vsNoSkillsPct)}</span>
          <span class="pw-stat-unit">スキルなし ${formatNumber(r.noSkills, 0)}</span>
        </div>
      </div>
      <p class="pw-explain">${NOT_DPS}</p>
      <div class="pw-split" aria-hidden="true">
        <span class="pw-c-phys" style=${`width: ${phys}%`}></span>
        <span class="pw-c-elem" style=${`width: ${elem}%`}></span>
        <span class="pw-c-extra" style=${`width: ${extra}%`}></span>
      </div>
      <div class="pw-legend">
        <span><span class="pw-dot pw-c-phys"></span>物理 ${formatNumber(r.physical, 0)} (${formatNumber(phys, 0)}%)</span>
        <span><span class="pw-dot pw-c-elem"></span>属性 ${formatNumber(r.element, 0)} (${formatNumber(elem, 0)}%)</span>
        ${r.extra > 0 && html`<span><span class="pw-dot pw-c-extra"></span>追加 ${formatNumber(r.extra, 0)}</span>`}
      </div>
      ${r.extra > 0 && html`<${Hint}>追加 = 灼熱化などスキルの追加ダメージ (発動の確率込み)。</${Hint}>`}
      ${mixed && r.perTarget && html`
        <ul class="pw-steps">
          ${r.perTarget.map((p) => html`
            <li><span>${p.label} (${formatNumber(p.weight * 100, 0)}%)</span>
              <span class="pw-num">${formatNumber(p.total, 0)}</span></li>`)}
        </ul>`}
    </${Card}>`;
}

// ---------------------------------------------------------------- 条件 (相手・斬れ味・コンボ)

function SettingsCard({ data, comboRef, combo, sharpSel, autoColor, weaponName, resolvedLabel, isWound, fallback, fallbackTitle, r, ui }) {
  const comboOptions = data.lists.combos.map((c) => ({ value: c.id, label: c.name }));
  const sharpOptions = [
    { value: null, label: autoColor ? `自動 (${SHARPNESS_LABEL[autoColor]})` : '自動' },
    ...SHARPNESS_ORDER.map((c) => ({ value: c, label: SHARPNESS_LABEL[c] })),
  ];
  const showSteps = !!ui.showSteps;
  return html`
    <${Card} title="計算の条件">
      <div class="pw-target">
        <span class="pw-target-text">
          <span class="pw-target-label">武器</span>
          <span data-power-weapon>${weaponName}</span>
        </span>
        <${Button} small onClick=${() => goToTab('equip')}>装備を変える</${Button}>
      </div>
      <div class="pw-target" style="margin-top: 8px;">
        <span class="pw-target-text">
          <span class="pw-target-label">相手</span>
          <span data-power-target>${resolvedLabel}${isWound ? '・傷口を狙う' : ''}</span>
        </span>
        <${Button} small onClick=${() => goToTab('target', { top: true })}>相手を変える</${Button}>
      </div>
      ${fallback && html`
        <${Notice} kind="info" title=${fallbackTitle}>
          <p>既定の肉質 (${fallback}) で計算しています。相手タブでモンスターと部位を選べます。</p>
        </${Notice}>`}
      <div class="field">
        <${Select} label="斬れ味" value=${sharpSel} options=${sharpOptions} onChange=${(v) => setSharpness(v)}
          hint="自動 = 武器の斬れ味ゲージの一番上の色 (匠の Lv 込み。装備タブと同じ)" />
      </div>
      <div class="field">
        <${Select} label="コンボ" value=${typeof comboRef === 'string' ? comboRef : (Array.isArray(comboRef) ? undefined : combo && combo.id)}
          options=${comboOptions} onChange=${(v) => setCombo(v)} />
      </div>
      ${combo && combo.confidence === 'low' && html`<p class="hint"><${Badge} kind="unconfirmed" /> 技の並びやモーション値に未確定のところがあります。</p>`}
      ${combo && combo.description && html`<${Hint}>${combo.description}</${Hint}>`}
      ${combo && combo.note && html`
        <details class="more" data-power-combo-note>
          <summary>くわしく (データの説明)</summary>
          <p class="hint">${combo.note}</p>
        </details>`}
      <div class="btn-row">
        <${Button} small onClick=${() => setTabState('power', { showSteps: !showSteps })}>
          ${showSteps ? '技ごとの内訳を閉じる' : '技ごとの内訳を見る'}
        </${Button}>
      </div>
      ${showSteps && html`
        <ul class="pw-steps" data-power-steps>
          ${r.steps.map((s) => html`
            <li>
              <span>${s.name}${s.isWound ? html` <${Badge} kind="info">傷口</${Badge}>` : ''}</span>
              <span class="pw-num">${formatNumber(s.total, 0)}</span>
            </li>`)}
        </ul>`}
    </${Card}>`;
}

// ---------------------------------------------------------------- 発動率

function setBinary(g, x, conditions) {
  const v = Math.round(x * 100) / 100;
  setUptime(g.id, v);
  // 同時に起きない条件 (体力満タン ↔ 赤ゲージ など) は合計が 100% を超えないように相手を下げる
  for (const pid of g.exclusiveWith || []) {
    const p = conditions.find((c) => c.id === pid);
    if (p && p.type === 'binary' && v + p.uptime > 1 + 1e-9) setUptime(pid, Math.round((1 - v) * 100) / 100);
  }
}

function ConditionRow({ g, conditions }) {
  const skillNames = g.skills.map((s) => s.name).join('・');
  const partners = (g.exclusiveWith || []).map((id) => conditions.find((c) => c.id === id)).filter(Boolean);
  const nonOff = g.states.filter((s) => s.id !== g.offState);
  const offLabel = (g.states.find((s) => s.id === g.offState) || {}).label || '未発動';
  const conflict = (g.warnings || []).length > 0;
  return html`
    <div class="pw-cond" data-condition=${g.id}>
      <div class="pw-cond-head">
        <span class="pw-cond-title">
          ${g.label} ${g.placeholder && html`<${Badge} kind="warn">仮</${Badge}>`}
          ${g.inactive && html`<${Badge} kind="info">起きない</${Badge}>`}
        </span>
        ${g.fromInput && html`<${Button} small variant="ghost" onClick=${() => resetUptime(g.id)}>既定に戻す</${Button}>`}
      </div>
      <p class="pw-cond-sub">効くスキル: ${skillNames}</p>
      ${g.inactive ? html`<${Hint}>${g.inactiveReason}</${Hint}>` : g.type === 'binary' ? html`
        <${Slider} label="発動している割合" value=${g.uptime} min=${0} max=${1} step=${0.05} percent
          onChange=${(x) => setBinary(g, x, conditions)} />`
        : html`
        ${nonOff.map((s) => html`
          <${Slider} key=${s.id} label=${s.label} value=${g.probs[s.id] || 0} min=${0} max=${1} step=${0.05} percent
            onChange=${(x) => setUptime(g.id, rebalanceCategorical(g, s.id, x))} />`)}
        <p class="pw-off">${offLabel}: ${formatNumber((g.probs[g.offState] || 0) * 100, 0)}%</p>`}
      ${partners.length > 0 && html`<${Hint}>「${partners.map((p) => p.label).join('」「')}」とは同時に起きないので、合計は 100% までです。</${Hint}>`}
      ${conflict && html`<p class="hint text-danger">${g.warnings[0].message}</p>`}
      ${!g.inactive && !g.placeholder && !g.fromInput && g.uptimeBasis && html`<${Hint}>${g.uptimeBasis}</${Hint}>`}
      ${!g.inactive && g.note && html`<${Hint}>${g.note}</${Hint}>`}
    </div>`;
}

function UptimeCard({ conditions, warnings }) {
  const anyInput = conditions.some((g) => g.fromInput);
  const anyPlaceholder = conditions.some((g) => g.placeholder);
  // 同時に起きない条件の合計が 100% を超えて減らした条件には、その場で注意を出す
  const rows = conditions.map((g) => ({ ...g, warnings: warnings.filter((w) => w.code === 'exclusive-conflict' && w.groupId === g.id) }));
  return html`
    <${Card} title="発動率" sub="条件つきのスキルが、狩りの間どのくらい発動しているか"
      actions=${anyInput ? html`<${Button} small variant="ghost" onClick=${() => resetUptime()}>全部戻す</${Button}>` : null}>
      ${conditions.length === 0
        ? html`<p class="hint">いまの装備に、条件つきで火力が上がるスキルはありません。</p>`
        : html`
          ${anyPlaceholder && html`
            <p class="hint" style="margin: 0 0 10px;"><${Badge} kind="warn">仮</${Badge}> は根拠の無い仮置きの値 (多くは 50%) です。自分の狩りに合わせて動かしてください。動かすと「仮」が消えます。</p>`}
          ${rows.map((g) => html`<${ConditionRow} key=${g.id} g=${g} conditions=${conditions} />`)}`}
    </${Card}>`;
}

// ---------------------------------------------------------------- スキルごとの効き目

function ContributionCard({ r, lowIds }) {
  const list = r.removeEach;
  const max = Math.max(0.0001, ...list.map((x) => x.dropPct));
  return html`
    <${Card} title="スキルごとの効き目" sub="そのスキルだけを外したときに、期待値が何 % 下がるか (大きい順)">
      ${list.length === 0
        ? html`<p class="hint">火力に関係するスキルがまだありません。</p>`
        : html`
          <ul class="pw-contrib" data-power-contrib>
            ${list.map((x) => html`
              <li key=${x.skillId}>
                <div class="pw-contrib-head">
                  <span class="pw-contrib-name">${x.name} Lv${x.level} ${lowIds.has(x.skillId) && html`<${Badge} kind="unconfirmed" />`}</span>
                  <span class=${`pw-contrib-val${Math.abs(x.dropPct) < 0.05 ? ' is-zero' : ''}`}>
                    ${Math.abs(x.dropPct) < 0.05 ? '変わらない' : `外すと ${formatPct(-x.dropPct, 1)}`}
                  </span>
                </div>
                <div class="pw-bar" aria-hidden="true"><span style=${`width: ${Math.max(0, x.dropPct) / max * 100}%`}></span></div>
              </li>`)}
          </ul>
          <${Hint}>「変わらない」は、いまの相手・コンボ・発動率では効いていないスキルです (属性が無い武器の属性スキル、柔らかい部位の心眼など)。</${Hint}>`}
    </${Card}>`;
}

/**
 * 「未確定」「未対応」のスキルの一覧。名前だけを先に出し、理由 (データの説明。専門的な書き方を含む) は「くわしく」で開く。
 */
function ReasonNotice({ kind, title, intro, items, attr }) {
  const [open, setOpen] = useState(false);
  const hasReason = items.some((s) => s.reason);
  return html`
    <${Notice} kind=${kind} title=${title}
      actions=${hasReason ? html`<${Button} small variant="ghost" onClick=${() => setOpen(!open)}>${open ? '説明を閉じる' : 'くわしく (データの説明)'}</${Button}>` : null}>
      ${intro && html`<p>${intro}</p>`}
      <ul class="pw-list" ...${attr || {}}>
        ${items.map((s) => html`
          <li key=${s.skillId}><strong>${s.name}${s.level ? ` Lv${s.level}` : ''}</strong>
            ${open && s.reason && html`<br /><span class="hint">${s.reason}</span>`}</li>`)}
      </ul>
    </${Notice}>`;
}

function SkillNotices({ r, idx }) {
  const nameOf = (id) => (idx.skills.get(Number(id)) || {}).name || `スキル ${id}`;
  return html`
    ${r.lowConfidence.length > 0 && html`
      <${ReasonNotice} kind="unconfirmed" title="未確定の値で計算したスキル" items=${r.lowConfidence}
        intro="数値の根拠が弱く、本当の値と違うかもしれません。期待値には入れています。" />`}
    ${r.unsupported.length > 0 && html`
      <${ReasonNotice} kind="unsupported" title="未対応 (計算に入れていません)" items=${r.unsupported}
        intro="効き方が分からないので、期待値に入れていないスキルです。" />`}
    ${r.unknown.length > 0 && html`
      <${Hint}>火力に関係しないスキル (${r.unknown.length} 個) は省いています: ${r.unknown.map((s) => nameOf(s.skillId)).join('・')}</${Hint}>`}`;
}

// ---------------------------------------------------------------- スキル火力表

/** 表を少しずつ計算する (iPhone で画面が固まらないように、12ms ごとに区切る)。入力が変わったら少し待ってから計算し直す。 */
function useSkillTable(enabled, input, targets, effects, weapon, handicraft) {
  const [st, setSt] = useState({ status: 'idle', rows: null, error: null });
  const done = useRef(null); // 計算し終えた入力 (同じ入力ならタブを開き直しても計算し直さない)
  useEffect(() => {
    if (!enabled || !input || !targets) return undefined;
    const d = done.current;
    if (d && d.input === input && d.targets === targets && d.effects === effects && d.weapon === weapon) return undefined;
    let cancelled = false;
    let timer = null;
    setSt((s) => ({ ...s, status: 'computing', error: null }));
    timer = setTimeout(() => {
      let cands;
      let ctx;
      try {
        cands = skillTableCandidates(effects, weapon, { handicraft });
        ctx = tableContext(input, targets);
      } catch (e) {
        if (!cancelled) setSt({ status: 'error', rows: null, error: e });
        return;
      }
      const rows = [];
      let i = 0;
      const step = () => {
        if (cancelled) return;
        const t0 = Date.now();
        try {
          while (i < cands.rows.length && Date.now() - t0 < 12) {
            rows.push(skillTableRow(input, targets, cands.rows[i], ctx));
            i += 1;
          }
        } catch (e) {
          setSt({ status: 'error', rows: null, error: e });
          return;
        }
        if (i < cands.rows.length) {
          timer = setTimeout(step, 0);
        } else {
          done.current = { input, targets, effects, weapon };
          setSt({ status: 'ready', rows, unsupported: cands.unsupported, otherElement: cands.otherElement, error: null });
        }
      };
      step();
    }, 250);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, input, targets, effects, weapon]);
  return st;
}

/** 表の名前の欄に出す条件の割合 (スキルが効く段だけ。段階のある条件は段ごとに「克服した後 60%」) */
function condText(cond) {
  const pct = (p) => `${formatNumber(p * 100, 0)}%`;
  if (cond.type === 'binary' || !cond.parts.length) return `${cond.label} ${pct(cond.on)}`;
  return `${cond.label}: ${cond.parts.map((x) => `${x.label} ${pct(x.p)}`).join('・')}`;
}

function TableNameCell({ row, effects, uptimes, nameOf, ctx }) {
  const cond = row.conditional
    ? conditionSummary(effects, uptimes, row.conditionGroup,
      { entry: row.entry, skillIds: [...ctx.skillIds, row.skillId], monsterStatus: ctx.monsterStatus })
    : null;
  return html`
    <th class="pw-name" scope="row">
      <span class="pw-name-main">${row.name}</span>
      ${KIND_SHORT[row.kind] && html`<span class="pw-name-sub">${KIND_SHORT[row.kind]}スキル</span>`}
      ${row.sharpnessSkill && html`<span class="pw-name-sub">${ctx.sharpFixed ? '斬れ味を固定しているので変わりません' : '斬れ味の色が上がると効きます'}</span>`}
      ${cond && html`<span class="pw-name-sub">${condText(cond)}${cond.placeholder ? ' (仮)' : ''}</span>`}
      ${cond && cond.inactive && html`<span class="pw-name-sub">${cond.needs}が要ります</span>`}
      ${row.requiresMissing && html`<span class="pw-name-sub">${nameOf(row.requiresSkillId)} が無いと効きません</span>`}
      ${row.conflict && html`<span class="pw-name-sub text-danger">同時に起きない条件の合計が 100% を超えるので、減らして計算しています</span>`}
      ${row.lowConfidence && html`<${Badge} kind="unconfirmed" />`}
    </th>`;
}

function SkillTableCard({ table, ui, effects, uptimes, data, open, ctx }) {
  const sortBy = ui.tableSort || 'next';
  const nameOf = (id) => (data.index.skills.get(Number(id)) || {}).name || `スキル ${id}`;
  const rows = table.rows ? sortTableRows(table.rows, sortBy) : null;
  const maxLv = rows ? Math.max(1, ...rows.map((r) => r.maxLevel)) : 5;
  const lvCols = Array.from({ length: maxLv }, (_, i) => i + 1);
  return html`
    <${Card} title="スキル火力表" sub="いまの装備・相手で、スキル 1 つの Lv だけを変えたとき"
      actions=${html`<${Button} small variant="ghost" onClick=${() => setTabState('power', { tableOpen: !open })}>${open ? '閉じる' : '開く'}</${Button}>`}>
      ${!open
        ? html`<p class="hint">開くと、片手剣の火力に効くスキルを Lv ごとに比べられます。</p>`
        : html`
          <${Hint}>上の数字 = そのスキルが無いとき (Lv0) と比べて何 % 上がるか。下の「次」= 1 つ上の Lv にするとさらに何 % 上がるか。色の付いた所がいまの Lv です。</${Hint}>
          <div class="field">
            <${Segmented} label="並べ方" value=${sortBy} onChange=${(v) => setTabState('power', { tableSort: v })}
              options=${[{ value: 'next', label: '次の Lv で伸びる順' }, { value: 'max', label: '最大 Lv の効果順' }, { value: 'name', label: '名前順' }]} />
          </div>
          ${table.status === 'error' && html`<${ErrorBox} title="表を計算できませんでした" error=${{ message: errorText(table.error) }} />`}
          ${!rows && table.status !== 'error' && html`<${Loading} text="表を計算中…" />`}
          ${rows && table.status === 'computing' && html`<p class="pw-stale" role="status">計算し直しています…</p>`}
          ${rows && html`
            <div class="pw-table-wrap" data-power-table>
              <table class="pw-table">
                <thead>
                  <tr>
                    <th class="pw-name" scope="col">スキル</th>
                    <th scope="col">いま</th>
                    ${lvCols.map((lv) => html`<th scope="col" key=${lv}>Lv${lv}</th>`)}
                  </tr>
                </thead>
                <tbody>
                  ${rows.map((row) => html`
                    <tr key=${row.skillId} data-skill-row=${row.skillId}>
                      <${TableNameCell} row=${row} effects=${effects} uptimes=${uptimes} nameOf=${nameOf} ctx=${ctx} />
                      <td>
                        <span class="pw-cell-main">${row.rawLevel > 0 ? `Lv${row.currentLevel}` : 'なし'}</span>
                        <span class="pw-cell-next">${row.nextFromCurrentPct == null ? '最大' : `次 ${pctText(row.nextFromCurrentPct)}`}</span>
                      </td>
                      ${lvCols.map((lv) => {
                        const l = row.levels[lv];
                        if (!l) return html`<td key=${lv} class="is-empty"></td>`;
                        return html`
                          <td key=${lv} class=${row.currentLevel === lv && row.rawLevel > 0 ? 'is-current' : ''}>
                            <span class="pw-cell-main">${pctText(l.vsZeroPct)}</span>
                            <span class="pw-cell-next">${l.nextPct == null ? '' : `次 ${pctText(l.nextPct)}`}</span>
                          </td>`;
                      })}
                    </tr>`)}
                </tbody>
              </table>
            </div>
            <${Hint}>表は横にスクロールできます。条件つきのスキルは「発動率」の値 (まだ入れていない条件は既定の値) で計算しています。</${Hint}>
            ${table.unsupported && table.unsupported.length > 0 && html`
              <${ReasonNotice} kind="unsupported" title="未対応 (計算に入れていません)" items=${table.unsupported}
                intro="効き方が分からないので表に入れていないスキルです。" attr=${{ 'data-power-unsupported': '1' }} />`}
            ${table.otherElement && table.otherElement.length > 0 && html`
              <${Hint}>武器の属性と合わない (または武器に属性が無い) ので表から外したスキル: ${table.otherElement.map((s) => s.name).join('・')}</${Hint}>`}`}`}
    </${Card}>`;
}

// ---------------------------------------------------------------- 本体

/** 相手が決まらない理由 → 案内の見出し */
function fallbackTitleOf(target) {
  if (target.mode !== 'monster' || target.monsterId == null) return '相手を選んでいません';
  if (!target.partKey) return '狙う部位を選んでいません';
  return '選んでいた部位が見つかりません';
}

export default function PowerTab({ data, active }) {
  const build = useAppState((s) => s.build);
  const target = useAppState((s) => s.target);
  const comboRef = useAppState((s) => s.combo);
  const uptimes = useAppState((s) => s.uptimes);
  const sharpSel = useAppState((s) => s.sharpness);
  const targetUi = useAppState((s) => s.tabs.target);
  const ui = useAppState((s) => s.tabs.power) || EMPTY;

  // モンスターを選んであるときだけ相手のデータを読む (選んでいなければ相手タブを開くまで読まない)
  const needMonsters = target.mode === 'monster' && target.monsterId != null;
  const t = useTargetData({ load: needMonsters });
  const waitingTarget = needMonsters && t.status !== 'ready' && t.status !== 'error';

  // 装備タブで足した武器・護石も含めた索引 (装備タブと同じ作り方)
  const { idx } = useEquipIndex(data, { active });
  const buildResult = useMemo(() => computeBuild(build, idx), [build, idx]);
  const weaponFull = useMemo(() => L.resolveWeaponRef(build.weapon, idx), [build.weapon, idx]);
  const weapon = useMemo(() => (weaponFull ? L.damageWeapon(weaponFull) : null), [weaponFull]);
  const autoColor = weaponFull ? L.autoSharpness(weaponFull, idx, buildResult.skillLevels).color : null;
  const sharpness = sharpSel || autoColor || 'white';
  const combo = useMemo(() => resolveCombo(comboRef, data.combos), [comboRef, data]);

  const resolved = useMemo(
    () => (waitingTarget ? null : resolveTargetMix(target, targetUi, t.status === 'ready' ? t.data : null)),
    [target, targetUi, t.data, t.status, waitingTarget],
  );
  // 相手が決まらないときは装備タブと同じ既定の肉質 (切断・打撃 45、属性 20) で計算する
  const fallbackTargets = useMemo(
    () => [{ weight: 1, label: '既定の肉質', target: { ...L.DEFAULT_TARGET, isWound: target.isWound } }],
    [target.isWound],
  );
  const targets = resolved ? resolved.targets : fallbackTargets;
  const fallbackText = !resolved && !waitingTarget ? L.DEFAULT_HITZONE_TEXT : null;
  const resolvedLabel = resolved ? resolved.label : '既定の肉質';
  const fallbackTitle = fallbackTitleOf(target);
  // 相手が使う状態異常 (狂竜症などの条件のもとの確かめ)。手入力・既定の肉質なら [] (使わないものとして扱う)
  const monsterStatus = useMemo(() => monsterStatusOf(target, t.status === 'ready' ? t.data : null),
    [target, t.data, t.status]);
  const handicraft = useMemo(() => L.handicraftInfo(idx), [idx]);
  // 斬れ味が「自動」なら、スキルを外したとき・スキルなしのときの色を匠の Lv で決め直す
  const perSkills = useMemo(() => L.sharpnessResolver(weaponFull, idx, sharpSel), [weaponFull, idx, sharpSel]);

  const input = useMemo(() => (weapon && combo ? {
    weapon, sharpness, skills: buildResult.skills, uptimes,
    effects: data.skillEffects, motions: data.motions, combo, perSkills, handicraft, monsterStatus,
  } : null), [weapon, sharpness, buildResult, uptimes, data, combo, perSkills, handicraft, monsterStatus]);

  const calc = useMemo(() => {
    if (!input || waitingTarget) return null;
    try {
      return { ok: true, r: mixContribution(input, targets) };
    } catch (e) {
      console.warn('火力の計算に失敗', e);
      return { ok: false, error: e };
    }
  }, [input, targets, waitingTarget]);

  const tableOpen = ui.tableOpen !== false;
  const table = useSkillTable(active && tableOpen && !!calc && calc.ok, input, targets, data.skillEffects, weapon, handicraft);
  const tableCtx = useMemo(() => ({
    skillIds: (buildResult.skills || []).map((s) => s.skillId), monsterStatus, sharpFixed: !!sharpSel,
  }), [buildResult, monsterStatus, sharpSel]);
  const needsElement = !!weaponFull && L.needsElementInput(weaponFull, idx);

  if (!weapon) {
    return html`
      <div class="stack" data-power-root>
        <${Notice} kind="info" title="武器を選んでいません"
          actions=${html`<${Button} variant="primary" onClick=${() => goToTab('equip', { top: true })}>装備タブで武器を選ぶ</${Button}>`}>
          <p>武器を選ぶと、いまの装備・相手・コンボでの期待ダメージと、スキルごとの効き目が出ます。</p>
        </${Notice}>
        <p class="pw-explain">${NOT_DPS}</p>
      </div>`;
  }
  if (!combo) {
    return html`<${ErrorBox} title="代表コンボのデータがありません"
      error=${{ message: 'アプリの更新がうまくいっていないかもしれません。再読み込みしてください。' }} />`;
  }
  if (needMonsters && t.status === 'error') {
    return html`<${ErrorBox} title="相手のデータを読み込めませんでした" error=${t.error} onRetry=${t.retry} />`;
  }
  if (waitingTarget) return html`<${Loading} text="相手のデータを読み込み中…" />`;
  if (!calc.ok) {
    return html`
      <div class="stack" data-power-root>
        <${ErrorBox} title="期待値を計算できませんでした" error=${{ message: errorText(calc.error) }}>
          <div class="btn-row">
            <${Button} onClick=${() => resetUptime()}>発動率を全部既定に戻す</${Button}>
          </div>
        </${ErrorBox}>
      </div>`;
  }
  const r = calc.r;
  const lowIds = new Set(r.lowConfidence.map((s) => Number(s.skillId)));
  const elemType = weapon.element ? weapon.element.type : null;

  return html`
    <div class="stack" data-power-root>
      ${needsElement && html`
        <${Notice} kind="warn" title="この武器の属性をまだ入れていません"
          actions=${html`<${Button} small onClick=${() => goToTab('equip', { top: true })}>装備タブで属性を入れる</${Button}>`}>
          <p>属性 0 として計算しています。装備タブの「武器」で属性を入れると、正しい期待値になります。</p>
        </${Notice}>`}
      <${HeroCard} r=${r} combo=${combo} mixed=${r.mixed} />
      ${buildResult.errors.length > 0 && html`
        <${Notice} kind="error" title="装備に入らない装飾品などがあります"
          actions=${html`<${Button} small onClick=${() => goToTab('equip')}>装備タブで直す</${Button}>`}>
          <p>入らないものはスキルに数えずに計算しています。</p>
        </${Notice}>`}
      ${r.warnings.length > 0 && html`
        <${Notice} kind="warn" title="計算の注意">
          <ul class="pw-list" data-power-warnings>${r.warnings.map((w, i) => html`<li key=${i}>${w.message}</li>`)}</ul>
        </${Notice}>`}
      ${elemType && !ELEMENT_KEYS.includes(elemType) && html`
        <${Hint}>この武器の${elementName(elemType)}は状態異常の属性なので、属性ダメージは 0 として計算しています。</${Hint}>`}
      <${SettingsCard} data=${data} comboRef=${comboRef} combo=${combo} sharpSel=${sharpSel} autoColor=${autoColor}
        weaponName=${L.weaponName(weaponFull)} resolvedLabel=${resolvedLabel} isWound=${target.isWound} fallback=${fallbackText}
        fallbackTitle=${fallbackTitle} r=${r} ui=${ui} />
      <${UptimeCard} conditions=${r.conditions} warnings=${r.warnings} />
      <${ContributionCard} r=${r} lowIds=${lowIds} />
      <${SkillNotices} r=${r} idx=${idx} />
      <${SkillTableCard} table=${table} ui=${ui} effects=${data.skillEffects} uptimes=${uptimes} data=${data} open=${tableOpen}
        ctx=${tableCtx} />
    </div>`;
}
