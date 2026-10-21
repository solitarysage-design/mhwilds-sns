// 探すタブ (段階 2・3): 持っている護石で火力の高い装備を探す・相手に合わせたおすすめ。
// 設計は docs/RECOMMEND_DESIGN.md 4.3〜4.6 節 (画面) と docs/SEARCH_DESIGN.md (探索)。担当: ui-search (3e)。使い方は docs/UI_API.md の「探すタブ」節。
// 分けたファイル:
//   search_form.js    純粋関数 (state → Job、必須の行、結果の見せ方)
//   search_client.js  Worker の出し入れ (hook useSearchRun。タブを移っても探索は続く)
//   search_results.js 結果の一覧と詳しくのシート
// 見た目は app/ui/styles_search.css (class は sr-*)。
// 「この相手で装備を探す」から来たときは state.search.autoStart に印がある (state.js の requestSearch / takeSearchRequest)。
// 印を受け取ったら、その時の state から Job を作って探し始める (保存から戻した状態には印が無いので、開き直しでは始めない)。
import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  html, Card, Button, Badge, Notice, Loading, ErrorBox, Toggle, Segmented, BottomSheet, Picker, Row, toast, PART_LABEL,
} from '../components/index.js';
import {
  useAppState, getState, setSearch, setSearchToggle, addRequired, setRequiredLevel, removeRequired,
  setArchTemperedHunted, setArmorExcluded, setBuild, takeSearchRequest, resolveCombo,
} from '../../state.js';
import { useTargetData } from '../../data.js';
import { loadSearchTiming } from '../../store.js';
import { computeBuild } from '../../model/build.js';
import { questById } from '../../model/hunt.js';
import * as R from '../../model/recommend.js';
import { useEquipIndex } from './equip_index.js';
import * as F from './search_form.js';
import { useSearchRun } from './search_client.js';
import { ResultsCard, ResultSheet } from './search_results.js';
import { goToTab } from '../shell.js';

/** テストだけの予算の差し替え (window.__mhwSearchBudget = {work: 3000})。画面には出さない */
function budgetTest() {
  try {
    const b = globalThis.__mhwSearchBudget;
    return b && typeof b === 'object' ? b : null;
  } catch {
    return null;
  }
}

/** 印 (仮 / 未確認 / 未確定) の出し方 (docs/MODEL_API.md の hunt.js の MARK_LABEL) */
function MarkBadge({ mark }) {
  if (mark === 'uncertain') return html`<${Badge} kind="unconfirmed" />`;
  if (mark === 'unverified') return html`<${Badge} kind="warn">未確認</${Badge}>`;
  if (mark === 'provisional') return html`<${Badge} kind="warn">仮</${Badge}>`;
  return null;
}

// ---------------------------------------------------------------- 相手

function TargetCard({ form, search, target, targetData }) {
  const tg = form.targets || {};
  const quest = target.questId != null && targetData ? questById(targetData, target.questId) : null;
  return html`
    <${Card} title="相手">
      <div data-sr="target">
        ${tg.source === 'monster' ? html`
          <p class="sr-target-name" data-sr-target-label>
            ${tg.name}${quest ? `・${quest.name}${quest.stars ? ` ★${quest.stars}` : ''}` : ''}
          </p>
          <p class="sr-target-line">狙う部位: ${tg.partsText} ${(tg.marks || []).map((m) => html`<${MarkBadge} key=${m} mark=${m} />`)}
            ${target.isWound ? '・傷口を狙う' : ''}</p>
          ${form.plan && form.plan.mode === 'multi' && search.useTarget && html`
            <p class="sr-target-line" data-sr-multi=${form.plan.subjects.length}>このクエストの相手 ${form.plan.subjects.length} 体
              (${form.plan.subjects.map((x) => x.name).join('・')}) を、全部倒すまでの回数が少ない順に探します。</p>`}`
          : tg.source === 'manual' ? html`
            <p class="sr-target-name" data-sr-target-label>${tg.label} (手入力の肉質)</p>`
            : html`
            <p class="sr-target-name" data-sr-target-label>相手を選んでいません</p>
            <p class="hint">相手を選ぶと、狙う部位と相手に合わせたおすすめも使えます。いまは既定の肉質 (切断 45・打撃 45・属性 20) で探します。</p>`}
        <div class="btn-row">
          <${Button} small onClick=${() => goToTab('target', { top: true })}>相手タブで変える</${Button}>
        </div>
        ${tg.source === 'monster' && html`
          <${Segmented} label="狙う部位" value=${search.partsPolicy} options=${F.PARTS_POLICY_OPTIONS}
            onChange=${(v) => setSearch({ partsPolicy: v })} />
          ${search.partsPolicy === 'main3' && html`<p class="hint"><${Badge} kind="warn">仮</${Badge}> 主な部位 = 切断の肉質が 45 以上の部位の上位 3 か所を同じ割合で。</p>`}`}
        <${Toggle} label="相手に合わせたおすすめを使う" checked=${search.useTarget}
          hint="守りのスキル・武器の属性を相手に合わせて決めます。オフにすると、条件を全部自分で決めます。"
          onChange=${(on) => setSearch({ useTarget: on })} />
      </div>
    </${Card}>`;
}

// ---------------------------------------------------------------- 武器

function WeaponCard({ form, search }) {
  const plan = form.plan;
  const two = plan && plan.element && plan.element.twoWeapons;
  const multi = !!(plan && plan.mode === 'multi');
  return html`
    <${Card} title="武器">
      <div data-sr="weapon">
        <${Segmented} label="探す武器" value=${search.weaponMode} options=${F.WEAPON_MODE_OPTIONS}
          onChange=${(v) => setSearch({ weaponMode: v })} />
        ${form.weaponText && html`<p class="hint" data-sr-weapon-text>${form.weaponText}</p>`}
        ${form.weaponMode === 'all' && html`<p class="hint">片手剣すべてから探すと、いまの武器だけより時間がかかります (iPhone で 10 秒をこえることがあります)。</p>`}
        ${multi && two && html`
          <${Segmented} label="属性の違う相手がいるとき" value=${search.twoWeapons} options=${F.TWO_WEAPON_OPTIONS}
            onChange=${(v) => setSearch({ twoWeapons: v })} />
          <p class="hint" data-sr-two-weapons=${two.suggested ? 'on' : 'off'}>${two.reason || ''}。
            2 本の案は、防具と護石は同じで、武器だけを相手ごとに持ち替えます。</p>`}
        <p class="hint">状態異常の武器 (毒・麻痺・睡眠・爆破) は、蓄積を計算に入れていないので物理だけで比べます。</p>
      </div>
    </${Card}>`;
}

// ---------------------------------------------------------------- 守りのスキル

function DefenseCard({ form, search }) {
  const plan = form.plan;
  const reqs = plan && Array.isArray(plan.requirements) ? plan.requirements : [];
  const notes = plan && Array.isArray(plan.notes) ? plan.notes : [];
  return html`
    <${Card} title="守りのスキル" actions=${html`<${Badge} kind="warn">仮</${Badge}>`}>
      <div data-sr="defense">
        <${Segmented} label="どこまで守りを付けるか" value=${search.preset} options=${F.PRESET_OPTIONS}
          onChange=${(v) => setSearch({ preset: v })} />
        <p class="hint">火力優先 = 守りは付けない。バランス = 歴戦王の防げる攻撃と、確かな属性やられだけ。安全 = 咆哮・風圧・振動・状態異常も。
          (どれも決めごとで、根拠のある値ではありません)</p>
        ${!search.useTarget ? html`<p class="hint">「相手に合わせたおすすめを使う」がオフなので、守りのスキルは自分で「必須スキル」に足してください。</p>`
          : !plan ? html`
            <p class="hint" data-sr-defense-none>モンスターを選ぶと、その相手に合わせた守りのスキルが出ます。いまは火力だけで探します。</p>`
          : reqs.length === 0 ? html`
            <p class="hint" data-sr-defense-none>この相手には、防ぐスキルの候補はありません。</p>`
            : html`
            <ul class="sr-req-list">
              ${reqs.map((q) => html`
                <li key=${q.key} data-sr-req=${q.key} data-sr-req-on=${q.on ? '1' : '0'}>
                  <${Toggle} label=${html`${q.label} ${q.provisional && html`<${Badge} kind="warn">仮</${Badge}>`} ${q.unconfirmed && html`<${Badge} kind="warn">未確認</${Badge}>`}`}
                    checked=${!!q.on} hint=${(q.why || []).map((x) => x.text).filter(Boolean).join('、') || (q.tier === 'ref' ? '参考' : '')}
                    onChange=${(on) => setSearchToggle(q.key, on)} />
                </li>`)}
            </ul>`}
        ${notes.length > 0 && html`
          <p class="card-subhead">防げない攻撃</p>
          <ul class="sr-list">${notes.map((n, i) => html`<li key=${i}>${n.text}</li>`)}</ul>`}
        <p class="hint">体力・回復系のスキルは自動では足しません (受けるダメージを計算できないため)。要るなら必須スキルに足してください。</p>
      </div>
    </${Card}>`;
}

// ---------------------------------------------------------------- 自分で決める必須スキル

function RequiredCard({ data, idx, search }) {
  const [open, setOpen] = useState(false);
  const rows = F.requiredRows(search.required, idx);
  const items = useMemo(() => F.requiredPickerItems(data.lists.skills, search.required, data.bonuses), [data, search.required]);
  return html`
    <${Card} title="自分で決める必須スキル">
      <div data-sr="required">
        ${rows.length === 0 && html`<p class="hint">この Lv 以上を必ず満たす組だけを探します。まだありません。</p>`}
        <ul class="sr-req-rows">
          ${rows.map((r) => html`
            <li key=${r.skillId} class="sr-req-row" data-sr-required=${r.skillId}>
              <span class="sr-req-name">${r.name}</span>
              <span class="sr-req-ctrl">
                <button type="button" class="btn btn-secondary btn-square" aria-label=${`${r.name}の Lv を下げる`}
                  disabled=${r.level <= 1} onClick=${() => setRequiredLevel(r.skillId, r.level - 1)} data-sr-action="lv-down">−</button>
                <span class="sr-req-lv" data-sr-level=${r.level}>Lv${r.level}</span>
                <button type="button" class="btn btn-secondary btn-square" aria-label=${`${r.name}の Lv を上げる`}
                  disabled=${r.level >= r.maxLevel} onClick=${() => setRequiredLevel(r.skillId, r.level + 1)} data-sr-action="lv-up">＋</button>
                <button type="button" class="btn btn-ghost btn-square" aria-label=${`${r.name}を外す`}
                  onClick=${() => removeRequired(r.skillId)} data-sr-action="remove-required">×</button>
              </span>
            </li>`)}
        </ul>
        <div class="btn-row">
          <${Button} small onClick=${() => setOpen(true)} data-sr-action="add-required">＋ スキルを足す</${Button}>
        </div>
        <p class="hint">シリーズスキル・グループスキルの Lv は段です (例 黒蝕竜の力 Lv2 = 4 部位)。巨戟アーティアのシリーズ・グループは 1 部位に数えます。</p>
        <${Picker} open=${open} title="必須にするスキルを選ぶ" items=${items} value=${null}
          searchPlaceholder="スキルの名前で探す" onClose=${() => setOpen(false)}
          onSelect=${(v) => { if (v != null) addRequired(v, (search.required.find((x) => x.skillId === v) || {}).level || 1); }} />
      </div>
    </${Card}>`;
}

// ---------------------------------------------------------------- 護石・防具・珠

function HuntedSheet({ open, onClose, form, search, loading }) {
  const list = form.gamma ? form.gamma.monsters : [];
  const hunted = search.archTemperedHunted || {};
  return html`
    <${BottomSheet} open=${open} title="倒した歴戦王" onClose=${onClose}>
      <div data-sr-sheet="hunted">
        <p class="hint">倒していない歴戦王の素材が要る γ 防具と、狩猟証γ で作る護石は使わずに探します。</p>
        ${loading ? html`<${Loading} text="モンスターのデータを読み込み中…" />` : list.map((e) => html`
          <${Toggle} key=${e.monsterId} label=${e.name} checked=${hunted[String(e.monsterId)] !== false}
            hint=${`${e.setNames.join('・')}・狩猟証γ の護石 ${e.charmFixedIds.length} 個`}
            onChange=${(on) => setArchTemperedHunted(e.monsterId, on)} />`)}
        <p class="hint">外すと、γ 防具にだけ付くグループスキル「ヌシの魂」も使えなくなります。</p>
      </div>
    </${BottomSheet}>`;
}

const ARMOR_ORDER = ['head', 'chest', 'arms', 'waist', 'legs'];

function ExcludeSheet({ open, onClose, data, idx, search }) {
  const [pick, setPick] = useState(false);
  const excluded = search.armorExclude || [];
  const items = useMemo(() => data.lists.armor.slice()
    .sort((a, b) => ARMOR_ORDER.indexOf(a.part) - ARMOR_ORDER.indexOf(b.part) || (b.rarity ?? 0) - (a.rarity ?? 0) || a.id - b.id)
    .map((a) => ({
      value: a.id, label: a.name, sub: `${PART_LABEL[a.part] || a.part}・レア ${a.rarity ?? '—'}`,
      group: PART_LABEL[a.part] || a.part, keywords: a.armorSetName || '', disabled: excluded.includes(a.id),
    })), [data, excluded]);
  return html`
    <${BottomSheet} open=${open} title="使わない防具" onClose=${onClose}>
      <div data-sr-sheet="exclude">
        ${excluded.length === 0 && html`<p class="hint">まだありません。作れない防具・使いたくない防具を足すと、探すときに使いません。</p>`}
        <ul class="sr-req-rows">
          ${excluded.map((id) => html`
            <li key=${id} class="sr-req-row">
              <span class="sr-req-name">${F.armorNameOf(idx, id)}</span>
              <button type="button" class="btn btn-ghost btn-square" aria-label="外す"
                onClick=${() => setArmorExcluded(id, false)}>×</button>
            </li>`)}
        </ul>
        <div class="btn-row"><${Button} small onClick=${() => setPick(true)}>＋ 防具を足す</${Button}></div>
        <${Picker} open=${pick} title="使わない防具を選ぶ" items=${items} value=${null} onClose=${() => setPick(false)}
          onSelect=${(v) => { if (v != null) setArmorExcluded(v, true); }} />
      </div>
    </${BottomSheet}>`;
}

function EquipOptionsCard({ data, idx, form, search, localCharms, targetLoading }) {
  const [sheet, setSheet] = useState(null);
  const ex = form.exclusions || { monsters: [] };
  const nAT = form.gamma ? form.gamma.monsters.length : 0;
  const huntedText = targetLoading ? '読み込み中…'
    : !nAT ? '—'
      : ex.monsters.length === 0 ? `${nAT} 体とも (γ 防具・護石を使う)`
        : `${nAT - ex.monsters.length} 体 (${ex.monsters.map((e) => e.monsterName).join('・')} は倒していない)`;
  const nEx = (search.armorExclude || []).length;
  return html`
    <${Card} title="護石・防具・珠">
      <div data-sr="equip-options">
        <${Toggle} label="持っている護石" checked=${search.charms.owned} hint=${`取り込んだ護石 ${data.lists.charms.length} 個`}
          onChange=${(on) => setSearch({ charms: { owned: on } })} />
        <${Toggle} label="この端末で足した護石" checked=${search.charms.local} hint=${`${localCharms.length} 個`}
          onChange=${(on) => setSearch({ charms: { local: on } })} />
        <${Toggle} label="生産できる護石" checked=${search.charms.fixed} hint=${`${data.lists.charmsFixed.length} 種類 (スロットなし)`}
          onChange=${(on) => setSearch({ charms: { fixed: on } })} />
        <${Segmented} label="防具の限界突破" value=${search.limitBreak} options=${F.LIMIT_BREAK_OPTIONS}
          onChange=${(v) => setSearch({ limitBreak: v })} />
        <div class="sr-rows">
          <${Row} label="倒した歴戦王" value=${huntedText} onClick=${() => setSheet('hunted')} />
          <${Row} label="使わない防具" value=${nEx ? `${nEx} 個` : 'なし'} onClick=${() => setSheet('exclude')} />
        </div>
        <p class="hint">装飾品は全部持っている前提で探します。</p>
      </div>
      <${HuntedSheet} open=${sheet === 'hunted'} onClose=${() => setSheet(null)} form=${form} search=${search} loading=${targetLoading} />
      <${ExcludeSheet} open=${sheet === 'exclude'} onClose=${() => setSheet(null)} data=${data} idx=${idx} search=${search} />
    </${Card}>`;
}

// ---------------------------------------------------------------- 仮置きの発動率

function PlaceholderCard({ form, search }) {
  const list = form.placeholders || [];
  const still = list.filter((p) => !p.fromInput);
  const mine = list.filter((p) => p.fromInput);
  return html`
    <${Card} title="条件つきスキルの発動率" actions=${html`<${Badge} kind="warn">仮</${Badge}>`}>
      <div data-sr="placeholders" data-sr-placeholder-count=${still.length}>
        ${still.length > 0
          ? html`<p>発動率が仮 (根拠の無い値) の条件が <strong>${still.length} 個</strong> あります。</p>`
          : html`<p>発動率が仮の条件はありません (全部、火力タブで値を入れてあります)。</p>`}
        <${Segmented} value=${search.placeholders} options=${F.PLACEHOLDER_OPTIONS}
          onChange=${(v) => setSearch({ placeholders: v })} />
        <p class="hint">${search.placeholders === 'zero'
          ? '仮の条件は 0% (起きない) として探します。条件つきのスキルばかり積んだ、現実的でない組が出にくくなります。結果の値は火力タブの値と違うことがあります。'
          : '仮の条件も火力タブの値 (多くは 50%) のまま探します。条件つきのスキルを積んだ組が上に来やすくなります。'}</p>
        ${mine.length > 0 && html`<p class="hint">火力タブで値を入れた条件 (${mine.map((p) => `${p.label} ${p.valueText}`).join('・')}) は、どちらでもその値で探します。</p>`}
        ${still.length > 0 && html`
          <details class="more">
            <summary>仮の条件の一覧 (${still.length} 個)</summary>
            <ul class="sr-list sr-small" data-sr-placeholder-list>
              ${still.map((p) => html`<li key=${p.id}>${p.label}: ${p.defaultText}${p.skills.length ? ` (${p.skills.join('・')})` : ''}</li>`)}
            </ul>
          </details>`}
      </div>
    </${Card}>`;
}

// ---------------------------------------------------------------- 探す時間と件数

function BudgetCard({ search }) {
  return html`
    <${Card} title="探す時間と件数">
      <div data-sr="budget">
        <${Segmented} label="探す時間の目安" value=${search.budgetSec}
          options=${F.BUDGET_CHOICES.map((n) => ({ value: n, label: `${n} 秒` }))} onChange=${(v) => setSearch({ budgetSec: v })} />
        <${Segmented} label="出す件数" value=${search.K}
          options=${F.K_CHOICES.map((n) => ({ value: n, label: `${n} 件` }))} onChange=${(v) => setSearch({ K: v })} />
        <p class="hint">途中で見つかった組を先に出し、良い組が見つかれば差し替えます。</p>
      </div>
    </${Card}>`;
}

// ---------------------------------------------------------------- 本体

export default function SearchTab({ data, active }) {
  const build = useAppState((s) => s.build);
  const target = useAppState((s) => s.target);
  const search = useAppState((s) => s.search);
  const comboRef = useAppState((s) => s.combo);
  const uptimes = useAppState((s) => s.uptimes);
  const sharpness = useAppState((s) => s.sharpness);
  const tabTarget = useAppState((s) => s.tabs.target);
  const autoStart = useAppState((s) => s.search.autoStart);

  // 相手のデータ (肉質・歴戦王の γ 防具)。このタブを開いたら読み始める
  const t = useTargetData();
  const targetData = t.status === 'ready' ? t.data : null;
  const targetLoading = t.status === 'loading' || t.status === 'idle';
  const { idx, localWeapons, localCharms } = useEquipIndex(data, { active });
  const combo = useMemo(() => resolveCombo(comboRef, data.combos), [comboRef, data]);

  const jobOf = (b) => F.buildJob({
    state: { build: b, target, search, combo: comboRef, uptimes, sharpness, tabs: { target: tabTarget } },
    core: data, idx, targetData, combo, localCharms, localWeapons, recommend: R, budgetTest: budgetTest(),
  });
  const form = useMemo(() => jobOf(build),
    [build, target, search, comboRef, uptimes, sharpness, tabTarget, data, idx, targetData, combo, localCharms, localWeapons]);

  const { snap, ctrl } = useSearchRun();
  // 「条件が変わりました」の比べ方: 結果の組を装備に入れただけなら、探し始めた時の装備で条件を作り直して比べる
  // (武器の範囲・限界突破はいまの装備から決まるため。search_form.js の isResultBuild)
  const startBuild = snap.summary && snap.summary.startBuild ? snap.summary.startBuild : null;
  const keyBuild = startBuild && snap.result && F.isResultBuild(snap.result, build) ? startBuild : null;
  const currentKey = useMemo(() => {
    if (!keyBuild) return form.inputKey;
    try {
      return jobOf(keyBuild).inputKey;
    } catch {
      return form.inputKey;
    }
  }, [keyBuild, form]);
  const [openRow, setOpenRow] = useState(null);
  const [applied, setApplied] = useState(null); // {rank, which, prev}
  const [timings, setTimings] = useState([]);
  const [pendingStart, setPendingStart] = useState(false); // 条件を変えてから探し直す (「〇〇を外して探す」)

  // 相手のデータ (歴戦王の γ 防具の除外に使う) を読み終わるまでは始めない
  const ready = !form.loading && !targetLoading;
  const start = () => {
    if (!form.ok || !form.job) return false;
    setApplied(null);
    setOpenRow(null);
    ctrl.start(form.job, { inputKey: form.inputKey, summary: form.summary });
    // 結果のカード (計算中の表示) を見える所へ
    requestAnimationFrame(() => {
      const el = document.getElementById('sr-results');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    return true;
  };

  // 「この相手で装備を探す」から来たら、データが読めたところで 1 回だけ始める
  useEffect(() => {
    if (!autoStart || !ready) return;
    if (takeSearchRequest(autoStart.id)) {
      if (!start() && form.blockers.length) toast(form.blockers[0].message, { kind: 'error', ms: 6000 });
    }
  }, [autoStart, ready]);

  // 条件を変えたあと (描き直して form が新しくなってから) 探し直す
  useEffect(() => {
    if (!pendingStart || !ready) return;
    setPendingStart(false);
    start();
  }, [pendingStart, form, ready]);

  // 結果が差し替わったら (途中の結果 → 終わりなど) 開いていた詳しくのシートは閉じる (別の組を出さないように)
  useEffect(() => {
    setOpenRow(null);
  }, [snap.result]);

  // 終わるたびに、この端末で探した時間の記録を読み直す (くわしくに出す)
  useEffect(() => {
    if (snap.busy) return undefined;
    let alive = true;
    loadSearchTiming().then((list) => { if (alive) setTimings(list); }).catch(() => {});
    return () => { alive = false; };
  }, [snap.status, snap.doneMs]);

  const currentResult = useMemo(() => computeBuild(build, idx), [build, idx]);
  const stale = !!(snap.result && snap.inputKey && currentKey && snap.inputKey !== currentKey);
  // 「いまより +x%」の基準: 探した時の条件 (Job の入力) で、いまの装備を計算する。保存から戻した結果は条件が同じときだけ
  const runInput = useMemo(() => {
    const job = snap.job || (!stale && snap.result ? form.job : null);
    if (!job) return null;
    return job.kind === 'search' ? job.input : (job.runs && job.runs[0] ? job.runs[0].input : null);
  }, [snap.job, stale, snap.result, form.job]);
  const baseline = useMemo(() => (runInput ? F.baselineValue(runInput, build, idx, data) : null), [runInput, build, idx, data]);
  const rows = useMemo(() => F.resultRows(snap.result, {
    idx, currentBuild: build, currentSkills: currentResult.skills, baseline, gamma: form.gamma,
  }), [snap.result, idx, build, currentResult, baseline, form.gamma]);
  const sheetRow = openRow != null ? rows.find((r) => r.index === openRow) || null : null;
  const requiredIds = useMemo(() => new Set(search.required.map((r) => r.skillId)), [search.required]);
  const zeroed = snap.summary && snap.summary.placeholders === 'zero' ? (snap.summary.zeroed || 0) : 0;
  const budgetMs = (Number(search.budgetSec) || 6) * 1000;

  const apply = (row, which) => {
    const next = which === 2 && row.second ? row.second.build : row.raw.build;
    const prev = getState().build;
    setBuild(next);
    setApplied({ rank: row.rank, which, prev });
    setOpenRow(null);
    toast('装備に入れました', { action: { label: '元に戻す', onClick: () => { setBuild(prev); setApplied(null); } } });
  };
  const undo = () => {
    if (!applied) return;
    setBuild(applied.prev);
    setApplied(null);
    toast('元の装備に戻しました');
  };

  if (t.status === 'error' && target.mode === 'monster' && target.monsterId != null) {
    return html`<${ErrorBox} title="相手のデータを読み込めませんでした" error=${t.error} onRetry=${t.retry} />`;
  }
  if (form.loading) return html`<${Loading} text="相手のデータを読み込み中…" />`;

  return html`
    <div class="stack" data-search-root data-sr-status=${snap.status}>
      <${TargetCard} form=${form} search=${search} target=${target} targetData=${targetData} />
      <${WeaponCard} form=${form} search=${search} />
      <${DefenseCard} form=${form} search=${search} />
      <${RequiredCard} data=${data} idx=${idx} search=${search} />
      <${EquipOptionsCard} data=${data} idx=${idx} form=${form} search=${search} localCharms=${localCharms} targetLoading=${targetLoading} />
      <${PlaceholderCard} form=${form} search=${search} />
      <${BudgetCard} search=${search} />
      <div class="sr-start" data-sr="start">
        ${form.blockers.map((b) => html`<div key=${b.code} data-sr-blocker=${b.code}><${Notice} kind="warn" title=${b.message} /></div>`)}
        ${form.notes.map((n) => html`<p key=${n.code} class="hint" data-sr-form-note=${n.code}>${n.message}</p>`)}
        ${t.status === 'error' && Object.keys(search.archTemperedHunted || {}).length > 0 && html`
          <p class="hint text-danger">モンスターのデータを読めないので、倒していない歴戦王の防具を外せません。</p>`}
        <${Button} variant="primary" block disabled=${snap.busy || !form.ok || !ready} onClick=${start} data-sr-action="start">
          この条件で探す
        </${Button}>
        <p class="hint sr-start-hint" data-sr-time-hint>${snap.busy ? '探しています…' : F.startHintText(form, search)}</p>
      </div>
      <${ResultsCard} snap=${snap} rows=${rows} stale=${stale} zeroed=${zeroed} budgetMs=${budgetMs} timings=${timings}
        requiredIds=${requiredIds}
        onCancel=${() => ctrl.cancel()} onRetry=${() => { setApplied(null); ctrl.retry(); }}
        onExtend=${() => ctrl.extend(F.budgetOf(search.budgetSec, budgetTest()))}
        onOpen=${(row) => setOpenRow(row.index)}
        onRemoveRequired=${(id) => { removeRequired(id); setPendingStart(true); }}
        applied=${applied} onUndo=${undo} onShowPower=${() => goToTab('power', { top: true })} />
      <${ResultSheet} open=${sheetRow != null} row=${sheetRow} idx=${idx} onClose=${() => setOpenRow(null)} onApply=${apply} />
    </div>`;
}
