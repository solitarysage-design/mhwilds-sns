// 探すタブの結果の一覧と、1 件の詳しく (下からのシート)。担当: ui-search (3e)。
// 画面は docs/RECOMMEND_DESIGN.md 4.3 節・4.5 節。見た目は app/ui/styles_search.css (class は sr-*)。
// 計算はしない (行の中身は search_form.js の resultRows で作ったものを受け取る)。
import { useState } from 'preact/hooks';
import {
  html, Card, Button, Hint, Badge, Notice, ErrorBox, BottomSheet, formatNumber, formatDateTime,
} from '../components/index.js';
import * as F from './search_form.js';

/** 結果は最適の証明が無い (docs/SEARCH_DESIGN.md 2.11 節) */
const APPROX_TEXT = '時間内に見つけた上位です。もっと良い組み合わせが残っていることがあります (差は 1〜2% くらい)。';

/** 状態の名前 (時間の記録の表示用) */
const STATUS_TEXT = { done: '終わり', stopped: '打ち切り', cancelled: 'やめた', infeasible: '満たせない', error: 'エラー' };

/** Notice は data 属性を受け取らないので、テストの目印 (data-sr-note) は外側の div に付ける */
function Note({ id, children }) {
  return html`<div class="sr-note" data-sr-note=${id}>${children}</div>`;
}

function diffText(pct) {
  if (pct == null) return '';
  if (Math.abs(pct) < 0.05) return 'いまと同じくらい';
  return `いまより ${pct > 0 ? '+' : '−'}${formatNumber(Math.abs(pct), 1)}%`;
}

function diffClass(pct) {
  if (pct == null || Math.abs(pct) < 0.05) return 'sr-diff';
  return pct > 0 ? 'sr-diff is-up' : 'sr-diff is-down';
}

/** 多頭: いまの装備との回数の差 (少ないほど良い) */
function combosDiffText(n) {
  if (n == null) return '';
  if (n === 0) return 'いまと同じ回数';
  return `いまより ${Math.abs(n)} 回${n < 0 ? '少ない' : '多い'}`;
}

/** 行の「いまとの差」(1 体 = 火力の %、多頭 = 回数) */
function RowDiff({ row }) {
  if (row.diffPct != null) return html`<span class=${diffClass(row.diffPct)}>${diffText(row.diffPct)}</span>`;
  if (row.diffCombos != null) return html`<span class=${diffClass(-row.diffCombos)}>${combosDiffText(row.diffCombos)}</span>`;
  return null;
}

// ---------------------------------------------------------------- 計算中

/** 「探しています」: 段階の文・進み具合の帯・経過の秒・いまの最良・「やめる」 */
export function RunningPanel({ snap, budgetMs, onCancel }) {
  const v = F.progressView({ phase: snap.phase, elapsedMs: snap.elapsedMs, best: snap.best, run: snap.run }, budgetMs);
  const cancelling = snap.status === 'cancelling';
  return html`
    <div class="sr-run" data-sr="running" role="status" aria-live="polite">
      <div class="sr-run-head">
        <span class="spinner" aria-hidden="true"></span>
        <strong class="sr-run-phase" data-sr-phase=${snap.phase || ''}>
          ${cancelling ? 'やめています…' : snap.extending ? `続けて探しています (${v.text})` : v.text}
        </strong>
      </div>
      ${v.runText && html`<p class="sr-run-meta">${v.runText}</p>`}
      <div class="sr-progress" aria-hidden="true"><span style=${`width: ${Math.round(v.share * 100)}%`}></span></div>
      <p class="sr-run-meta">
        ${v.seconds != null ? `経過 ${formatNumber(v.seconds, 1)} 秒` : '始めています'}
        ${v.best != null ? `・いまの最良 ${formatNumber(v.best, 1)}` : ''}
      </p>
      ${snap.inline && html`<p class="hint">この端末では別の処理 (Worker) を使えないので、画面の処理で探しています (遅くなります)。</p>`}
      <div class="btn-row">
        <${Button} onClick=${onCancel} disabled=${cancelling} data-sr-action="cancel">やめる</${Button}>
      </div>
    </div>`;
}

// ---------------------------------------------------------------- 一覧

function ResultRow({ row, onOpen }) {
  return html`
    <li>
      <button type="button" class="sr-result" onClick=${() => onOpen(row)}
        data-sr-rank=${row.rank} data-sr-value=${row.value != null ? String(row.value) : ''}>
        <span class="sr-result-head">
          <span class="sr-rank">${row.rank}</span>
          <span class="sr-value">${F.rowValueText(row)}</span>
          <${RowDiff} row=${row} />
        </span>
        <span class="sr-change">${row.changeText}</span>
        ${row.skillsText && html`<span class="sr-skills">${row.skillsText}</span>`}
        ${row.second && html`<span class="sr-skills" data-sr-row-second>2 本目: ${row.second.weaponName}</span>`}
        ${row.defense && F.defenseText(row.defense) && html`
          <span class=${row.defense.ok ? 'sr-defense' : 'sr-defense is-short'} data-sr-row-defense=${row.defense.ok ? 'ok' : 'short'}>守り ${F.defenseText(row.defense)}</span>`}
        ${(row.gamma.length > 0 || row.errors.length > 0) && html`
          <span class="sr-marks">
            ${row.gamma.length > 0 && html`<${Badge} kind="info">γ: 歴戦王の素材</${Badge}>`}
            ${row.errors.length > 0 && html`<${Badge} kind="error">装備に入らない珠</${Badge}>`}
          </span>`}
      </button>
    </li>`;
}

/** 結果の上に出す知らせ (1 位が変わった・やめた・条件が変わった など) */
function ResultNotes({ snap, stale, zeroed }) {
  const r = snap.result;
  return html`
    ${stale && html`
      <${Note} id="stale">
        <${Notice} kind="warn" title="条件が変わりました。もう一度探してください">
          <p>下の結果は前の条件で探したものです。</p>
        </${Notice}>
      </${Note}>`}
    ${snap.restored && html`
      <p class="hint" data-sr-note="restored">前回の結果 (${formatDateTime(snap.restored.savedAt)} に探したもの)</p>`}
    ${snap.partial && html`<p class="sr-partial-note" data-sr-note="partial">途中の結果です。もっと良い組を探しています…</p>`}
    ${!snap.busy && snap.improved && html`
      <${Note} id="improved"><${Notice} kind="ok" title="もっと良い組が見つかりました" /></${Note}>`}
    ${snap.status === 'cancelled' && html`
      <${Note} id="cancelled">
        <${Notice} kind="info" title="途中でやめました">
          ${r && r.results.length ? html`<p>それまでに見つかった組を出しています。</p>` : html`<p>まだ組が見つかっていませんでした。</p>`}
        </${Notice}>
      </${Note}>`}
    ${snap.status === 'stopped' && html`<p class="hint" data-sr-note="stopped">時間で打ち切りました (見つかった組を出しています)。</p>`}
    ${snap.inline && !snap.busy && html`<p class="hint" data-sr-note="inline">この端末では別の処理 (Worker) を使えないので、画面の処理で探しました。</p>`}
    ${zeroed > 0 && r && r.results.length > 0 && html`
      <p class="hint" data-sr-note="zeroed">火力タブの値と違うのは、仮の発動率の条件 (${zeroed} 個) を 0% にして探したためです。</p>`}
    ${r && F.costOfDefenseText(r.costOfDefense) && html`<p class="hint" data-sr-note="cost">${F.costOfDefenseText(r.costOfDefense)}</p>`}
    ${r && r.twoWeaponsGain && r.twoWeaponsGain.text && html`<p class="hint" data-sr-note="two-gain">${r.twoWeaponsGain.text} (2 本の案と比べて)</p>`}
    ${r && r.warnings.length > 0 && html`
      <${Note} id="warnings">
        <${Notice} kind="warn" title="探したときの注意">
          <ul class="sr-list">${r.warnings.map((w, i) => html`<li key=${i}>${w.message}</li>`)}</ul>
        </${Notice}>
      </${Note}>`}`;
}

/** 満たせないとき: 足りないスキルと「〇〇を外して探す」 */
function InfeasibleNotice({ result, requiredIds, onRemoveRequired }) {
  const missing = (result && result.infeasible && Array.isArray(result.infeasible.missing)) ? result.infeasible.missing : [];
  return html`
    <${Note} id="infeasible">
    <${Notice} kind="error" title="必須のスキルを全部満たす組み合わせはありません">
      ${missing.length > 0 && html`
        <ul class="sr-list">
          ${missing.map((m, i) => html`<li key=${i}>${m.name || 'スキル'}${m.level ? ` Lv${m.level}` : ''}${m.reason ? ` (${m.reason})` : ''}</li>`)}
        </ul>`}
      <div class="btn-col">
        ${missing.filter((m) => requiredIds.has(m.skillId)).map((m) => html`
          <${Button} key=${m.skillId} small onClick=${() => onRemoveRequired(m.skillId)} data-sr-action="remove-missing">
            「${m.name || 'スキル'}」を外して探す
          </${Button}>`)}
      </div>
    </${Notice}>
    </${Note}>`;
}

/** 段階ごとの時間とこの端末の記録 (くわしく) */
function TimingDetails({ snap, timings }) {
  const phases = snap.phases || [];
  const stats = snap.result && snap.result.stats ? snap.result.stats : {};
  return html`
    <details class="more" data-sr-detail="timing">
      <summary>くわしく (近似のこと・かかった時間)</summary>
      <p class="hint">${APPROX_TEXT}</p>
      ${phases.length > 0 && html`
        <p class="hint">段階 (計算した時間): ${phases.map((p) => `${p.name} ${formatNumber(p.atMs / 1000, 2)} 秒`).join('・')}</p>`}
      ${snap.partialMs != null && html`<p class="hint">途中の結果まで ${formatNumber(snap.partialMs / 1000, 2)} 秒・終わりまで ${snap.doneMs != null ? `${formatNumber(snap.doneMs / 1000, 2)} 秒` : '—'}</p>`}
      ${stats.relevantSkills != null && html`<p class="hint">関係するスキル ${stats.relevantSkills} 個</p>`}
      ${timings && timings.length > 0 && html`
        <p class="hint">この端末で探した時間 (最近 ${timings.length} 回。この端末だけの記録で、書き出しには入りません):</p>
        <ul class="sr-list sr-small">
          ${timings.slice(-5).reverse().map((t, i) => html`
            <li key=${i}>${formatDateTime(t.at)}・${STATUS_TEXT[t.status] || t.status}${t.inline ? '・画面の処理' : ''}・途中 ${t.partialMs != null ? `${formatNumber(t.partialMs / 1000, 1)} 秒` : '—'}・終わり ${t.doneMs != null ? `${formatNumber(t.doneMs / 1000, 1)} 秒` : '—'}</li>`)}
        </ul>`}
    </details>`;
}

/**
 * 結果のカード (計算中・途中の結果・終わり・やめた・満たせない・エラー)。
 * props: snap (search_client の状態), rows (resultRows), stale, zeroed, budgetMs, timings, requiredIds (Set),
 *        onCancel, onExtend, onRetry, onOpen(row), onRemoveRequired(skillId), applied ({rank, which} | null), onUndo, onShowPower
 */
export function ResultsCard(props) {
  const { snap, rows, stale, zeroed, budgetMs, timings, requiredIds, onCancel, onExtend, onRetry, onOpen, onRemoveRequired, applied, onUndo, onShowPower } = props;
  const r = snap.result;
  // 多頭 (score.kind 'combos') は「全部倒すまでの回数」の少ない順 (docs/RECOMMEND_DESIGN.md 4.6 節)
  const order = rows.length && rows[0].scoreKind === 'combos' ? '回数の少ない順' : '火力の高い順';
  const sub = r && rows.length ? `${order}・${rows.length} 件` : '';
  return html`
    <${Card} title="結果" sub=${sub} class="sr-results" id="sr-results"
      actions=${r && rows.length ? html`<${Badge} kind="info">近似</${Badge}>` : null}>
      <div data-sr="results" data-sr-status=${snap.status} data-sr-partial=${snap.partial ? '1' : '0'}>
        ${snap.busy && html`<${RunningPanel} snap=${snap} budgetMs=${budgetMs} onCancel=${onCancel} />`}
        ${snap.status === 'error' && html`
          <${Note} id="error">
            <${ErrorBox} title="探せませんでした" error=${{ message: snap.error ? snap.error.message : '' }}
              detail=${snap.error && snap.error.detail} onRetry=${snap.job ? onRetry : null} />
          </${Note}>`}
        ${applied && html`
          <${Note} id="applied">
            <${Notice} kind="ok" title=${`${applied.rank} 位の装備${applied.which === 2 ? ' (2 本目の武器)' : ''}を入れました`}
              actions=${html`
                <${Button} small onClick=${onUndo} data-sr-action="undo">元に戻す</${Button}>
                <${Button} small variant="ghost" onClick=${onShowPower}>火力タブで見る</${Button}>`} />
          </${Note}>`}
        ${(r || snap.status === 'cancelled') && html`<${ResultNotes} snap=${snap} stale=${stale} zeroed=${zeroed} />`}
        ${snap.status === 'infeasible' && html`<${InfeasibleNotice} result=${r} requiredIds=${requiredIds} onRemoveRequired=${onRemoveRequired} />`}
        ${rows.length > 0 && html`
          <ol class="sr-results-list" data-sr-list>
            ${rows.map((row) => html`<${ResultRow} key=${`${row.rank}-${row.value}`} row=${row} onOpen=${onOpen} />`)}
          </ol>
          <${Hint}>行をタップすると、装備の中身とスキルを見て装備に入れられます。</${Hint}>`}
        ${!snap.busy && !r && snap.status !== 'error' && snap.status !== 'cancelled' && html`
          <p class="empty" data-sr-note="empty">まだ探していません。上の条件で「この条件で探す」を押してください。</p>`}
        ${!snap.busy && snap.canExtend && html`
          <div class="btn-row">
            <${Button} onClick=${onExtend} data-sr-action="extend">続けて探す (+${Math.round((budgetMs || 6000) / 1000)} 秒)</${Button}>
          </div>`}
        ${(r || snap.phases.length > 0) && html`<${TimingDetails} snap=${snap} timings=${timings} />`}
      </div>
    </${Card}>`;
}

// ---------------------------------------------------------------- 1 件の詳しく

function SkillDiffList({ list }) {
  const sign = { new: '＋', up: '＋', down: '−', gone: '−', same: '' };
  const changed = list.filter((s) => s.change !== 'same');
  const same = list.filter((s) => s.change === 'same');
  return html`
    <ul class="sr-skill-diff" data-sr-skill-diff>
      ${changed.map((s) => html`
        <li key=${s.skillId} class=${s.change === 'gone' || s.change === 'down' ? 'is-minus' : 'is-plus'}>
          <span class="sr-sign" aria-hidden="true">${sign[s.change]}</span>
          <span class="sr-skill-name">${s.name} ${s.change === 'gone' ? '' : `Lv${s.level}`}</span>
          <span class="sr-skill-before">${s.change === 'new' ? '(いま なし)' : s.change === 'gone' ? `(いま Lv${s.before} → なし)` : `(いま Lv${s.before})`}</span>
        </li>`)}
      ${same.length > 0 && html`<li class="sr-skill-same">変わらない: ${same.map((s) => `${s.name} ${s.level}`).join('・')}</li>`}
    </ul>`;
}

/**
 * 結果の 1 件の詳しく (下からのシート)。
 * props: open, row (resultRows の 1 件), idx, onClose, onApply(row, which)
 */
export function ResultSheet({ open, row, idx, onClose, onApply }) {
  const [showAlt, setShowAlt] = useState(false);
  if (!row) return null;
  const lines = F.buildLines(row.raw.build, idx);
  const title = `${row.rank} 位  ${F.rowValueText(row)}`;
  return html`
    <${BottomSheet} open=${open} title=${title} onClose=${() => { setShowAlt(false); onClose(); }} tall
      footer=${html`
        <div class="sr-sheet-foot">
          <${Button} variant="primary" block onClick=${() => onApply(row, 1)} data-sr-action="apply">装備に入れる</${Button}>
          ${row.second && html`<${Button} block onClick=${() => onApply(row, 2)} data-sr-action="apply2">2 本目の武器で装備に入れる</${Button}>`}
        </div>`}>
      <div class="sr-sheet" data-sr-sheet="result" data-sr-rank=${row.rank}>
        <p class="sr-sheet-lead">
          <${RowDiff} row=${row} />
          <${Badge} kind="info">近似</${Badge}>
        </p>
        <p class="hint">${row.changeText}</p>
        <ul class="sr-parts">
          ${lines.map((l) => {
            const alt = F.alternativeNames(row.alternatives, idx, l.key);
            return html`
              <li key=${l.key} class=${row.diff && ((l.key === 'weapon' && row.diff.weapon) || (l.key === 'charm' && row.diff.charm) || row.diff.parts.includes(l.key)) ? 'is-changed' : ''}>
                <span class="sr-part-label">${l.label}</span>
                <span class="sr-part-body">
                  <span class="sr-part-name">${l.name}${l.limitBreak ? ' (限界突破)' : ''}</span>
                  ${l.decorations.length > 0 && html`<span class="sr-part-sub">珠: ${l.decorations.join('・')}</span>`}
                  ${alt.length > 0 && showAlt && html`<span class="sr-part-sub">同じ値になる${l.key === 'charm' ? '護石' : '防具'}: ${alt.join('・')}</span>`}
                  ${alt.length > 0 && !showAlt && html`<span class="sr-part-sub">同じ値になる${l.key === 'charm' ? '護石' : '防具'}: ほか ${alt.length} 個</span>`}
                </span>
              </li>`;
          })}
        </ul>
        ${Object.values(row.alternatives || {}).some((x) => Array.isArray(x) && x.length) && html`
          <div class="btn-row"><${Button} small variant="ghost" onClick=${() => setShowAlt(!showAlt)}>${showAlt ? '同じ値になるものを閉じる' : '同じ値になるものを見る'}</${Button}></div>`}
        ${row.second && html`
          <div class="sr-second" data-sr-second>
            <p class="card-subhead">2 本目の武器 (防具・護石は同じ)</p>
            <p>${row.second.weaponName}${row.second.decorations.length ? `・珠: ${row.second.decorations.join('・')}` : ''}</p>
            <p class="hint">装備には武器を 1 本ずつ入れます (2 本を同時には持てません)。</p>
          </div>`}
        ${row.gamma.length > 0 && html`
          <p class="sr-gamma" data-sr-gamma><${Badge} kind="info">γ</${Badge}> ${row.gamma.map((n) => `${n}`).join('・')}の素材が要ります。</p>`}
        <p class="card-subhead">スキル (いまと比べて)</p>
        <${SkillDiffList} list=${row.skillDiff} />
        ${row.freeSlots && html`<p class="hint">空きスロット: ${F.freeSlotsText(row.freeSlots)}</p>`}
        ${row.defense && html`
          <p class="card-subhead">守り</p>
          <ul class="sr-list" data-sr-sheet-defense>
            ${row.defense.items.map((x) => html`<li key=${x.key}>${{ ok: '✓', mitigated: '△ 軽くなる', missing: '✗ 足りない' }[x.status] || ''} ${x.label}${x.text && x.text !== x.label ? ` (${x.text})` : ''}</li>`)}
          </ul>`}
        ${row.perSubject.length > 1 && html`
          <p class="card-subhead">相手ごと</p>
          <ul class="sr-list" data-sr-per-subject>
            ${row.perSubject.map((p, i) => html`<li key=${i}>${p.name || p.label || p.key}: ${p.value != null ? formatNumber(p.value, 1) : '—'}${p.combos != null ? `・約 ${formatNumber(p.combos, 0)} 回` : ''}${row.second ? (p.weapon === 2 ? '・2 本目の武器' : '・1 本目の武器') : ''}</li>`)}
          </ul>`}
        ${row.errors.length > 0 && html`
          <${Notice} kind="error" title="この装備に入らない装飾品があります">
            <p>入らないものはスキルに数えません。装備に入れたあと、装備タブで直してください。</p>
          </${Notice}>`}
        <details class="more">
          <summary>くわしく (計算し直した値)</summary>
          <p class="hint">${APPROX_TEXT}</p>
          ${row.check && html`<p class="hint">計算し直した値 ${formatNumber(row.check.value, 3)}${row.check.relDiff != null ? `・差 ${Number(row.check.relDiff).toExponential(1)}` : ''}</p>`}
          <p class="hint">珠の詰め方: ${row.exact ? '厳密に解いた' : '近似'}</p>
        </details>
      </div>
    </${BottomSheet}>`;
}
