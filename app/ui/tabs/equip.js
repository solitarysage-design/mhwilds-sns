// 装備タブ: 武器・防具 5 部位・護石・装飾品を選び、発動スキル・シリーズ/グループ・空きスロット・
// 火力の要約を見る。マイセットとして名前を付けて保存・呼び出し・削除できる。
// 計算と文字の整形は equip_logic.js (preact に依存しない。node --test で確かめる)。
// 長い一覧は下から出るシート (PickerField) の中だけで出す (iPhone 幅 375px で使うため)。
import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';
import {
  html, Card, Button, Row, Hint, KeyValue, Badge, Notice, Loading, Empty,
  NumberInput, Toggle, Segmented, Select, BottomSheet, PickerField, toast,
  PART_LABEL, ELEMENT_LABEL, SHARPNESS_LABEL, DECO_TARGET_LABEL, formatNumber, formatPctChange, formatDateTime, formatSlots,
} from '../components/index.js';
import {
  useAppState, getState, setWeapon, setArmor, setLimitBreak, setCharm, setDecoration, setDecorations, clearDecorations,
  clearBuild, setSharpness, setTabState, saveMySet, loadMySet, renameMySet, deleteMySet,
  resolveTarget, resolveCombo, ARMOR_PARTS, SHARPNESS_ORDER,
} from '../../state.js';
import { useTargetData } from '../../data.js';
import { computeBuild } from '../../model/build.js';
import * as L from './equip_logic.js';
import { useEquipIndex } from './equip_index.js';
import { resolveTargetMix, monsterStatusOf } from './target_mix.js';
import { goToTab } from '../shell.js';

const cx = (...a) => a.filter(Boolean).join(' ');

// ---------------------------------------------------------------- 見た目 (このタブだけで使う class。色は styles.css の変数)

const EQUIP_CSS = `
.eq-root .card-body .picker-field .row { padding-left: 0; padding-right: 0; }
.eq-root .picker-field + .picker-field { border-top: 1px solid var(--border); }
.eq-slot { border-bottom: 1px solid var(--border); }
.eq-slot:last-child { border-bottom: 0; }
.eq-part { border-bottom: 1px solid var(--border); }
.eq-part:last-child { border-bottom: 0; }
.eq-part .toggle { padding-top: 0; }
.eq-filter { display: flex; gap: 8px; align-items: flex-start; }
.eq-filter > .field { flex: 1 1 0; min-width: 0; margin-top: 0; }
.eq-filter .segment { padding: 0 6px; }
.eq-gauge { display: flex; height: 12px; border-radius: 3px; overflow: hidden; background: var(--surface-3);
  border: 1px solid var(--border); margin: 2px 0 4px; }
.eq-gauge-seg { background: var(--sharp, var(--surface-3)); }
.eq-gauge-seg.sharp-white { box-shadow: inset 0 0 0 1.5px var(--sharp-white-edge); }
.eq-gauge-gain { opacity: 0.5; }
.eq-gauge-gain.sharp-white { opacity: 0.7; }
/* 画面の上に貼りつく要約 (期待値・スキルの数)。押すと発動スキル・火力の要約へ移る */
.eq-sumbar { position: sticky; top: calc(env(safe-area-inset-top) + var(--header-h) + 1px); z-index: 5;
  display: flex; gap: 6px; padding: 4px; margin: -4px -4px 0; border-radius: var(--radius);
  background: var(--bg); }
.eq-sumbar button { min-height: var(--tap); border: 1px solid var(--border); border-radius: var(--radius-small);
  background: var(--surface); box-shadow: var(--shadow); text-align: left; padding: 4px 10px; }
.eq-sumbar-main { flex: 1 1 auto; min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 8px; }
.eq-sumbar-main strong { font-size: 20px; font-variant-numeric: tabular-nums; }
.eq-sumbar-label { font-size: 13px; color: var(--text-sub); }
.eq-sumbar-pct { font-size: 14px; font-weight: 700; color: var(--ok); font-variant-numeric: tabular-nums; }
.eq-sumbar-skills { flex: none; font-size: 14px; white-space: nowrap; }
.eq-sumbar-warn { color: var(--warn); font-weight: 700; font-size: 14px; }
.eq-root .card { scroll-margin-top: calc(env(safe-area-inset-top) + var(--header-h) + 64px); }
/* 装飾品: 装備ごとに畳む */
.eq-deco { border-bottom: 1px solid var(--border); }
.eq-deco:last-of-type { border-bottom: 0; }
.eq-deco-head { display: flex; align-items: center; gap: 8px; width: 100%; min-height: var(--tap); padding: 8px 0;
  border: 0; background: transparent; text-align: left; }
.eq-deco-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.eq-deco-title { font-weight: 600; }
.eq-deco-sub { font-size: 13px; color: var(--text-sub); }
.eq-deco-body { padding-left: 12px; border-left: 3px solid var(--accent-soft); margin-bottom: 8px; }
.eq-form { border-top: 1px solid var(--border); margin-top: 8px; padding-top: 12px; }
.eq-form > .notice:first-child { margin-top: 0; }
.eq-form .btn-block { margin-top: 12px; }
.eq-skill-list { list-style: none; margin: 0; padding: 0; }
.eq-skill-btn { display: flex; align-items: center; gap: 8px; width: 100%; min-height: var(--tap); padding: 8px 0;
  border: 0; border-bottom: 1px solid var(--border); background: transparent; text-align: left; }
.eq-skill-list li:last-child .eq-skill-btn { border-bottom: 0; }
.eq-skill-list li:last-child .eq-skill-btn[aria-expanded="true"] { border-bottom: 1px solid var(--border); }
.eq-skill-name { flex: 1 1 auto; min-width: 0; }
.eq-skill-kind { display: block; font-size: 12px; color: var(--text-sub); }
.eq-lv { flex: none; font-variant-numeric: tabular-nums; font-weight: 700; white-space: nowrap; }
.eq-lv-max { color: var(--text-sub); font-weight: 400; }
.eq-pips { display: inline-flex; gap: 2px; flex: none; }
.eq-pip { width: 7px; height: 12px; border-radius: 2px; background: var(--surface-3); }
.eq-pip.is-on { background: var(--accent); }
.eq-pip.is-over { background: var(--warn); }
.eq-skill-detail { padding: 2px 0 10px; font-size: 14px; color: var(--text-sub); }
.eq-skill-list li:not(:last-child) .eq-skill-detail { border-bottom: 1px solid var(--border); }
.eq-bonus { padding: 8px 0; border-bottom: 1px solid var(--border); }
.eq-bonus:last-child { border-bottom: 0; }
.eq-bonus-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.eq-bonus-name { font-weight: 600; min-width: 0; }
.eq-bonus-sub { font-size: 13px; color: var(--text-sub); }
.eq-power-main { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.eq-power-num { font-size: 32px; font-weight: 800; line-height: 1.15; font-variant-numeric: tabular-nums; }
.eq-power-unit { color: var(--text-sub); font-size: 14px; }
.eq-power-pct { font-size: 15px; margin-bottom: 8px; }
.eq-power-pct strong { font-size: 18px; color: var(--ok); }
.eq-list { margin: 4px 0 0; padding-left: 1.2em; }
.eq-list li + li { margin-top: 4px; }
.eq-confirm { margin-top: 12px; }
.eq-confirm .btn-row { margin-top: 8px; }
.eq-subhead-first { margin-top: 0; }
`;

// ---------------------------------------------------------------- 小さな部品 (共通部品に無いもの)

/**
 * 名前の入力欄。共通部品の TextInput は離れたときに値を返すので、
 * 「入れてすぐボタンを押す」所 (iPhone はボタンを押しても入力欄から離れないことがある) ではこちらを使う。
 * onInput は打つたび、onCommit は離れたとき・Enter のとき。
 */
function NameInput({ label, value, onInput, onCommit, placeholder, eq, maxLength = 60 }) {
  const id = useId();
  const [text, setText] = useState(value ?? '');
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value ?? '');
  }, [value]);
  const commit = () => {
    focused.current = false;
    if (onCommit && text !== value) onCommit(text);
  };
  return html`
    <div class="field">
      ${label && html`<div class="field-head"><label class="field-label" for=${id}>${label}</label></div>`}
      <input id=${id} class="input" type="text" value=${text} placeholder=${placeholder} maxLength=${maxLength}
        enterkeyhint="done" autocomplete="off" data-eq=${eq}
        onFocus=${() => { focused.current = true; }}
        onInput=${(e) => { const t = e.currentTarget.value; setText(t); if (onInput) onInput(t); }}
        onBlur=${commit} onKeyDown=${(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
    </div>`;
}

/** 2 回押して確かめるボタン (消す・外すなど、やり直せない操作) */
function ConfirmButton({ label, confirmLabel, message, onConfirm, variant = 'danger', small = true, block = false, eq }) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return html`<${Button} variant=${variant} small=${small} block=${block} data-eq=${eq}
      onClick=${() => setAsking(true)}>${label}</${Button}>`;
  }
  return html`
    <div class="eq-confirm" role="group">
      ${message && html`<p class="hint">${message}</p>`}
      <div class="btn-row">
        <${Button} variant="danger" small=${small} data-eq=${eq && `${eq}-yes`}
          onClick=${() => { setAsking(false); onConfirm(); }}>${confirmLabel || label}</${Button}>
        <${Button} variant="secondary" small=${small} onClick=${() => setAsking(false)}>やめる</${Button}>
      </div>
    </div>`;
}

// ---------------------------------------------------------------- 武器

function SharpnessField({ weapon, idx, result }) {
  const sharpness = useAppState((s) => s.sharpness);
  const auto = L.autoSharpness(weapon, idx, result.skillLevels);
  const options = [
    { value: null, label: auto.color ? `自動 (${SHARPNESS_LABEL[auto.color]})` : '自動' },
    ...SHARPNESS_ORDER.map((c) => ({
      value: c, label: html`<span class=${`sharp-chip sharp-${c}`} aria-hidden="true"></span> ${SHARPNESS_LABEL[c]}`,
    })),
  ];
  const max = auto.maxGauge ? auto.maxGauge.reduce((a, b) => a + b, 0) : 0;
  return html`
    <div class="field" data-eq="sharpness">
      <div class="field-head">
        <span class="field-label">斬れ味</span>
        <span class="field-end">${sharpness ? `${SHARPNESS_LABEL[sharpness]}で計算` : auto.color ? `${SHARPNESS_LABEL[auto.color]}で計算 (自動)` : '白で計算'}</span>
      </div>
      ${auto.gauge && max > 0 && html`
        <div class="eq-gauge" role="img" aria-label=${`斬れ味ゲージ。一番上の色は${SHARPNESS_LABEL[auto.color] || '不明'}`}>
          ${auto.gauge.map((n, i) => {
            const base = Math.min(n, auto.baseGauge[i] || 0);
            const gain = n - base;
            const c = SHARPNESS_ORDER[i];
            return html`
              ${base > 0 && html`<span class=${`eq-gauge-seg sharp-${c}`} style=${`width:${(base / max) * 100}%`}></span>`}
              ${gain > 0 && html`<span class=${`eq-gauge-seg eq-gauge-gain sharp-${c}`} style=${`width:${(gain / max) * 100}%`}></span>`}`;
          })}
        </div>`}
      <${Segmented} options=${options} value=${sharpness} onChange=${(v) => setSharpness(v)} />
      <p class="hint">
        「自動」は、いまの装備で出る一番上の色${auto.handicraft ? ` (匠 Lv${auto.handicraft} を含む)` : ''}で火力を計算します。
        ${auto.handicraft ? ' ゲージの薄い所が匠で伸びた分です。' : ''}
      </p>
    </div>`;
}

function setBonusItems(data) {
  return (data.bonuses.setBonuses || []).map((b) => ({
    value: b.id, label: b.name,
    sub: (b.ranks || []).map((r) => `${r.pieces} 部位で${r.name ? ` ${r.name}` : ` Lv${r.level}`}`).join('・'),
  }));
}

function groupBonusItems(data) {
  return (data.bonuses.groupBonuses || []).map((b) => ({
    value: b.id, label: b.name, sub: `${b.pieces ?? 3} 部位で${b.effectName ? ` ${b.effectName}` : '発動'}`,
  }));
}

/**
 * アーティアの入力欄 (属性・攻撃力・会心率・巨戟アーティアのシリーズ/グループ)。
 * elementChosen=false の間は属性を「選んでください」にしておく (初めから「無属性」が選ばれていると、そのまま足してしまうため)。
 * 属性激化の巨戟アーティアは属性が必ずあるので「無属性」を出さない。
 */
function ArtianFields({ value, onChange, src, idx, data, gogma, elementChosen = true, onElementChosen }) {
  const el = value.element;
  const base = L.baseWeaponOf(src, idx) || src;
  const requireElement = !!(base && base.variant === '属性激化');
  const elOptions = [
    ...L.ARTIAN_ELEMENT_TYPES.map((t) => ({ value: t, label: ELEMENT_LABEL[t] })),
    ...(requireElement ? [] : [{ value: null, label: '無属性 (属性なし)' }]),
  ];
  const setItems = useMemo(() => setBonusItems(data), [data]);
  const groupItems = useMemo(() => groupBonusItems(data), [data]);
  return html`
    <${Select} label="属性" options=${elOptions} value=${elementChosen ? (el ? el.type : null) : undefined}
      hint=${requireElement ? '属性激化の武器なので、ゲームで付けた属性を選んでください。' : null}
      onChange=${(t) => {
        onChange({ ...value, element: t ? { type: t, value: el ? el.value : L.defaultElementValue(src, idx) } : null });
        if (onElementChosen) onElementChosen();
      }} />
    ${el && elementChosen && html`
      <${NumberInput} label="属性値 (ゲーム画面の数字)" value=${el.value} min=${0} max=${2000} step=${10}
        onChange=${(n) => onChange({ ...value, element: { ...el, value: n } })} />`}
    <${NumberInput} label="攻撃力 (ゲーム画面の数字)" value=${L.attackDisplay({ attack: value.attack })} min=${0} max=${2000} step=${1}
      hint=${gogma ? 'ゲーム画面の攻撃力に直してください。初めの値はデータの目安で、強化や激化の種類で変わることがあります。'
        : 'ゲーム画面の数字と違うときは直してください (初めの値はデータの目安です)。'}
      onChange=${(n) => onChange({ ...value, attack: L.attackFromDisplay(n) })} />
    <${NumberInput} label="会心率" value=${value.affinity} min=${-100} max=${100} step=${1} unit="%"
      onChange=${(n) => onChange({ ...value, affinity: n })} />
    ${gogma && html`
      <${PickerField} label="シリーズスキル (1 部位分)" title="シリーズスキルを選ぶ" items=${setItems}
        value=${value.setBonusId} onChange=${(v) => onChange({ ...value, setBonusId: v })}
        allowNone noneLabel="付けない" placeholder="付けない" searchPlaceholder="名前で探す" />
      <${PickerField} label="グループスキル (1 部位分)" title="グループスキルを選ぶ" items=${groupItems}
        value=${value.groupBonusId} onChange=${(v) => onChange({ ...value, groupBonusId: v })}
        allowNone noneLabel="付けない" placeholder="付けない" searchPlaceholder="名前で探す" />
      <p class="hint">巨戟アーティアに付けたシリーズスキル・グループスキルは、防具 1 部位分として数えます。</p>`}`;
}

/** 属性が決まっていないアーティアを選んだとき: 入れて「持っている武器」に足す */
function ArtianCreate({ weapon, idx, data }) {
  const [draft, setDraft] = useState(() => L.artianDraftOf(weapon, idx));
  const [chosen, setChosen] = useState(false);
  const nameRef = useRef('');
  const gogma = L.isGogmaArtian(weapon, idx);
  const add = () => {
    if (!chosen) return;
    const list = L.localWeaponsFromState(getState());
    const id = L.newLocalWeaponId(list);
    const w = L.makeLocalWeapon(weapon, { ...draft, name: nameRef.current }, idx, { id });
    setTabState('equip', { myWeapons: [...list, w] });
    setWeapon(id, { keepDecorations: true });
    toast(`「${w.name}」を持っている武器に足しました`);
  };
  return html`
    <div class="eq-form" data-eq="artian-form">
      <${Notice} kind="info" title="このアーティアの属性を入れてください">
        <p>ゲームで作った武器の属性と値を入れると、火力の計算に使えます。入れた内容は「持っている武器」として保存し、次からは一覧の先頭から選べます。</p>
      </${Notice}>
      <${ArtianFields} value=${draft} onChange=${setDraft} src=${weapon} idx=${idx} data=${data} gogma=${gogma}
        elementChosen=${chosen} onElementChosen=${() => setChosen(true)} />
      <${NameInput} label="名前 (空なら自動で付けます)" value="" eq="artian-name"
        placeholder=${chosen ? L.defaultArtianName(weapon, draft.element, idx) : '属性を選ぶと自動で付けます'}
        onInput=${(t) => { nameRef.current = t; }} />
      <${Button} variant="primary" block data-eq="artian-add" onClick=${add} disabled=${!chosen}>持っている武器に足して使う</${Button}>
      ${!chosen && html`<${Hint}>先に属性を選んでください。</${Hint}>`}
    </div>`;
}

/** 画面で足した所持武器: 入れた内容を直す・消す */
function ArtianEdit({ weapon, resolved, idx, data }) {
  const [open, setOpen] = useState(false);
  const gogma = L.isGogmaArtian(resolved, idx);
  const update = (patch) => {
    const list = L.localWeaponsFromState(getState());
    setTabState('equip', { myWeapons: list.map((x) => (x.id === weapon.id ? { ...x, ...patch } : x)) });
  };
  const remove = () => {
    const list = L.localWeaponsFromState(getState());
    setTabState('equip', { myWeapons: list.filter((x) => x.id !== weapon.id) });
    if (getState().build.weapon === weapon.id) setWeapon(null);
    toast(`「${weapon.name}」を消しました`);
  };
  const value = {
    element: weapon.element || null, attack: Number(resolved.attack) || 0, affinity: Number(resolved.affinity) || 0,
    setBonusId: weapon.setBonusId ?? null, groupBonusId: weapon.groupBonusId ?? null,
  };
  if (!open) {
    return html`
      <div class="btn-row">
        <${Button} small data-eq="artian-edit" onClick=${() => setOpen(true)}>入れた内容を直す</${Button}>
      </div>`;
  }
  return html`
    <div class="eq-form" data-eq="artian-edit-form">
      <${ArtianFields} value=${value} src=${resolved} idx=${idx} data=${data} gogma=${gogma}
        onChange=${(v) => update({
          element: v.element, attack: v.attack, affinity: v.affinity,
          setBonusId: gogma ? v.setBonusId : null, groupBonusId: gogma ? v.groupBonusId : null,
        })} />
      <${NameInput} label="名前" value=${weapon.name} onCommit=${(t) => { if (t.trim()) update({ name: t.trim() }); }} />
      <div class="btn-row">
        <${Button} small onClick=${() => setOpen(false)}>閉じる</${Button}>
      </div>
      <${ConfirmButton} label="この武器を消す" confirmLabel="消す" eq="artian-delete"
        message="消すと、マイセットでこの武器を使っている所は「見つからない武器」になります。" onConfirm=${remove} />
    </div>`;
}

// ---------------------------------------------------------------- 装備を替えたときの装飾品 (入るものは残す)

/** build の一部を替えたときの、入れ先 targets のスロット Lv (computeBuild と同じ決め方) */
function slotSizesAfter(build, patch, targets, idx) {
  const decos = { ...build.decorations };
  for (const t of targets) decos[t] = [];
  const r = computeBuild({ ...build, ...patch, decorations: decos }, idx);
  return Object.fromEntries(targets.map((t) => [t, (r.slots[t] || []).map((s) => s.size)]));
}

/** 外した装飾品を知らせる (「元に戻す」で替える前に戻せる) */
function toastRemoved(where, removed, idx, undo) {
  if (!removed.length) return;
  const names = removed.map((id) => (idx.decorations.get(id) || {}).name || '装飾品');
  toast(`${where}の装飾品 ${removed.length} 個 (${names.join('・')}) は新しいスロットに入らないので外しました`, {
    action: { label: '元に戻す', onClick: undo },
  });
}

/** 武器を替える。前の武器の装飾品のうち、新しい武器のスロットに入るものは残す */
function chooseWeapon(v, idx) {
  const before = getState().build;
  if (before.weapon === v) return;
  const prev = before.decorations.weapon || [];
  const sizes = slotSizesAfter(before, { weapon: v }, ['weapon'], idx).weapon;
  const fit = L.refitDecorations(prev, sizes, 'weapon', idx);
  setWeapon(v, { decorations: fit.list });
  toastRemoved('武器', fit.removed, idx, () => setWeapon(before.weapon, { decorations: prev }));
}

/** 防具を替える (限界突破の指定は、限界突破後のスロットが分かる防具なら残す)。入る装飾品は残す */
function chooseArmor(part, v, idx) {
  const before = getState().build;
  if (before.armor[part] === v) return;
  const a = v != null ? idx.armor.get(v) : null;
  const resetLimitBreak = !(a && Array.isArray(a.slotsLimitBreak));
  const prev = before.decorations[part] || [];
  const limitBreak = resetLimitBreak ? { ...before.limitBreak, [part]: false } : before.limitBreak;
  const sizes = slotSizesAfter(before, { armor: { ...before.armor, [part]: v }, limitBreak }, [part], idx)[part];
  const fit = L.refitDecorations(prev, sizes, 'armor', idx);
  setArmor(part, v, { resetLimitBreak, decorations: fit.list });
  toastRemoved(PART_LABEL[part], fit.removed, idx, () => {
    setArmor(part, before.armor[part], { decorations: prev });
    setLimitBreak(part, before.limitBreak[part]);
  });
}

/** 限界突破を切り替える。外してスロットが小さくなったら、入らない装飾品だけ外す */
function toggleLimitBreak(part, on, idx) {
  const before = getState().build;
  if (!!before.limitBreak[part] === !!on) return;
  const prev = before.decorations[part] || [];
  const sizes = slotSizesAfter(before, { limitBreak: { ...before.limitBreak, [part]: on } }, [part], idx)[part];
  const fit = L.refitDecorations(prev, sizes, 'armor', idx);
  setLimitBreak(part, on);
  if (!fit.removed.length) return;
  setDecorations(part, fit.list);
  toastRemoved(PART_LABEL[part], fit.removed, idx, () => {
    setLimitBreak(part, before.limitBreak[part]);
    setDecorations(part, prev);
  });
}

/** 護石を替える。護石の防具用・武器用スロットに入る装飾品は残す */
function chooseCharm(v, idx) {
  const before = getState().build;
  if (before.charm === v) return;
  const prevA = before.decorations.charmArmor || [];
  const prevW = before.decorations.charmWeapon || [];
  const sizes = slotSizesAfter(before, { charm: v }, ['charmArmor', 'charmWeapon'], idx);
  const fitA = L.refitDecorations(prevA, sizes.charmArmor, 'armor', idx);
  const fitW = L.refitDecorations(prevW, sizes.charmWeapon, 'weapon', idx);
  setCharm(v, { decorations: { charmArmor: fitA.list, charmWeapon: fitW.list } });
  toastRemoved('護石', [...fitA.removed, ...fitW.removed], idx,
    () => setCharm(before.charm, { decorations: { charmArmor: prevA, charmWeapon: prevW } }));
}

function WeaponCard({ data, idx, build, weapon, localWeapons, result }) {
  const myList = useMemo(() => L.mergeById(data.lists.myWeapons, localWeapons), [data, localWeapons]);
  const items = useMemo(() => L.weaponItems(idx, data.lists.weapons, myList), [idx, data, myList]);
  const missing = build.weapon != null && !weapon;
  const local = weapon && typeof build.weapon === 'string' ? localWeapons.find((w) => w.id === build.weapon) : null;
  const needsElement = weapon && !local && L.needsElementInput(weapon, idx);
  return html`
    <${Card} title="武器" id="eq-weapon">
      <div data-eq="weapon">
        <${PickerField} label="片手剣" title="武器を選ぶ" items=${items} value=${build.weapon}
          onChange=${(v) => chooseWeapon(v, idx)} allowNone noneLabel="なし (外す)" searchPlaceholder="名前・属性・スキルで探す"
          display=${missing ? '見つからない武器' : undefined} sub=${missing ? '消した武器かもしれません。選び直してください' : undefined}
          end=${missing ? html`<${Badge} kind="error" />` : null} />
      </div>
      ${weapon && html`<${SharpnessField} weapon=${weapon} idx=${idx} result=${result} />`}
      ${needsElement && html`<${ArtianCreate} key=${String(build.weapon)} weapon=${weapon} idx=${idx} data=${data} />`}
      ${local && html`<${ArtianEdit} key=${local.id} weapon=${local} resolved=${weapon} idx=${idx} data=${data} />`}
    </${Card}>`;
}

// ---------------------------------------------------------------- 防具

function ArmorFilter({ rank, rarity }) {
  const rarities = L.rarityOptions(rank);
  return html`
    <div class="eq-filter" data-eq="armor-filter">
      <${Segmented} value=${rank} onChange=${(v) => setTabState('equip', { armorRank: v, armorRarity: 'all' })}
        options=${[{ value: 'all', label: 'すべて' }, { value: 'high', label: '上位' }, { value: 'low', label: '下位' }]} />
      <${Select} value=${rarities.includes(rarity) ? rarity : 'all'} onChange=${(v) => setTabState('equip', { armorRarity: v })}
        options=${[{ value: 'all', label: 'レア度: すべて' }, ...rarities.map((r) => ({ value: r, label: `レア ${r}` }))]} />
    </div>`;
}

function ArmorPart({ part, data, idx, build, result, filter }) {
  const items = useMemo(() => L.armorItems(idx, data.lists.armor, part, filter), [idx, data, part, filter.rank, filter.rarity]);
  const ref = build.armor[part];
  const armor = ref != null ? idx.armor.get(ref) : null;
  const missing = ref != null && !armor;
  const lb = armor && Array.isArray(armor.slotsLimitBreak) ? armor.slotsLimitBreak : null;
  // 限界突破できない (後のスロットが分からない) 防具に替えたら限界突破の指定を外す。入る装飾品は残す
  const choose = (v) => chooseArmor(part, v, idx);
  const same = lb && formatSlots(lb) === formatSlots(armor.slots);
  return html`
    <div class="eq-part" data-eq-part=${part}>
      <${PickerField} label=${PART_LABEL[part]} title=${`${PART_LABEL[part]}の防具を選ぶ`} items=${items} value=${ref}
        onChange=${choose} allowNone noneLabel="なし (外す)" searchPlaceholder="名前・スキル名で探す"
        emptyText="見つかりません (下の上位/下位・レア度も確かめてください)"
        display=${armor ? armor.name : missing ? '見つからない防具' : undefined}
        sub=${armor ? L.armorSub(armor, idx, { limitBreakOn: result.limitBreak[part] }) : missing ? '選び直してください' : undefined}
        end=${missing ? html`<${Badge} kind="error" />` : null}
        footer=${html`<${ArmorFilter} rank=${filter.rank} rarity=${filter.rarity} />`} />
      ${lb && html`
        <${Toggle} label="限界突破" checked=${build.limitBreak[part]} onChange=${(on) => toggleLimitBreak(part, on, idx)}
          hint=${same ? 'スロットは変わりません' : `スロット ${formatSlots(armor.slots)} → ${formatSlots(lb)}`} />`}
    </div>`;
}

function ArmorCard({ data, idx, build, result }) {
  const eqTab = useAppState((s) => s.tabs.equip);
  const rank = eqTab && ['all', 'high', 'low'].includes(eqTab.armorRank) ? eqTab.armorRank : 'all';
  const rarity = eqTab && (eqTab.armorRarity === 'all' || Number.isInteger(eqTab.armorRarity)) ? eqTab.armorRarity : 'all';
  const filter = useMemo(() => ({ rank, rarity }), [rank, rarity]);
  return html`
    <${Card} title="防具" sub="一覧の下で上位/下位とレア度を絞れます">
      ${ARMOR_PARTS.map((p) => html`
        <${ArmorPart} key=${p} part=${p} data=${data} idx=${idx} build=${build} result=${result} filter=${filter} />`)}
    </${Card}>`;
}

// ---------------------------------------------------------------- 護石

function CharmCard({ data, idx, build, localCharms }) {
  const items = useMemo(() => L.charmItems(idx, data.lists.charms, localCharms, data.lists.charmsFixed),
    [idx, data, localCharms]);
  const owned = data.lists.charms.length + localCharms.length;
  const charm = build.charm == null ? null
    : typeof build.charm === 'number' ? idx.charmsFixed.get(build.charm) : idx.charms.get(build.charm);
  const missing = build.charm != null && !charm;
  return html`
    <${Card} title="護石">
      <div data-eq="charm">
        <${PickerField} label="護石" title="護石を選ぶ" items=${items} value=${build.charm}
          onChange=${(v) => chooseCharm(v, idx)} allowNone noneLabel="なし (外す)" searchPlaceholder="名前・スキル名で探す"
          display=${missing ? '見つからない護石' : undefined} sub=${missing ? '消した護石かもしれません。選び直してください' : undefined}
          end=${missing ? html`<${Badge} kind="error" />` : null} />
      </div>
      ${owned === 0 && html`<${Hint}>持っている護石は「護石」タブで足せます。</${Hint}>`}
    </${Card}>`;
}

// ---------------------------------------------------------------- 装飾品

function DecoSlot({ group, row, idx, getItems }) {
  const items = getItems(group.kind, row.size);
  const deco = row.decorationId != null ? idx.decorations.get(row.decorationId) : null;
  const label = row.size ? `スロット ${row.index + 1} ${formatSlots([row.size])}` : `スロット ${row.index + 1} (ありません)`;
  return html`
    <div class="eq-slot" data-eq-slot=${`${group.target}:${row.index}`}>
      <${PickerField} label=${label} title=${`${DECO_TARGET_LABEL[group.target] || group.title} のスロット ${row.index + 1} (Lv${row.size}) に入れる装飾品`}
        items=${items} value=${row.decorationId} onChange=${(v) => setDecoration(group.target, row.index, v)}
        allowNone noneLabel="空ける (外す)" placeholder="空き" searchPlaceholder="名前・スキル名で探す"
        emptyText="このスロットに入る装飾品はありません"
        display=${deco ? deco.name : row.decorationId != null ? '見つからない装飾品' : undefined}
        sub=${row.error ? L.friendlyIssue(row.error) : deco ? L.skillsText(deco.skills, idx) : undefined}
        end=${row.error ? html`<${Badge} kind="error" />` : null} />
    </div>`;
}

/** 畳んだときの 1 行: 「③①− ・1/2 使用・攻撃珠Ⅰ【１】・空き①」 */
function decoGroupSummary(g, idx) {
  const sizes = g.rows.map((r) => r.size);
  const total = g.rows.filter((r) => r.size > 0).length;
  const used = g.rows.filter((r) => r.decorationId != null).length;
  const names = g.rows.map((r) => {
    if (r.decorationId != null) return (idx.decorations.get(r.decorationId) || {}).name || '見つからない装飾品';
    return r.size ? `空き${formatSlots([r.size])}` : null;
  }).filter(Boolean);
  return `${formatSlots(sizes)}・${used}/${total} 使用${names.length ? `・${names.join('・')}` : ''}`;
}

function DecoGroup({ g, idx, getItems, open, onToggle }) {
  const hasError = g.rows.some((r) => r.error);
  const expanded = open || hasError;
  return html`
    <div class="eq-deco" data-eq-deco=${g.target}>
      <button type="button" class="eq-deco-head" aria-expanded=${expanded ? 'true' : 'false'} data-eq-deco-toggle=${g.target}
        onClick=${hasError ? undefined : onToggle}>
        <span class="eq-deco-text">
          <span class="eq-deco-title">${g.title}</span>
          <span class="eq-deco-sub">${decoGroupSummary(g, idx)}</span>
        </span>
        ${hasError && html`<${Badge} kind="error" />`}
        <span class="row-chevron" aria-hidden="true">${expanded ? '▾' : '›'}</span>
      </button>
      ${expanded && html`
        <div class="eq-deco-body">
          ${g.rows.map((r) => html`<${DecoSlot} key=${r.index} group=${g} row=${r} idx=${idx} getItems=${getItems} />`)}
        </div>`}
    </div>`;
}

function DecoCard({ data, idx, build, result, names }) {
  const groups = L.slotGroups(result, build, names);
  // 開いている装備 (既定は全部畳む。入らない珠がある装備はいつも開く)
  const [openSet, setOpenSet] = useState(() => new Set());
  const toggle = (t) => setOpenSet((s) => {
    const n = new Set(s);
    if (n.has(t)) n.delete(t); else n.add(t);
    return n;
  });
  // スロットの種類と Lv ごとの候補 (同じ一覧を使い回す)
  const cache = useMemo(() => new Map(), [idx, data]);
  const getItems = (kind, size) => {
    const key = `${kind}:${size}`;
    if (!cache.has(key)) cache.set(key, L.decoItems(idx, data.lists.decorations, kind, size));
    return cache.get(key);
  };
  const hasAny = ARMOR_PARTS.some((p) => (build.decorations[p] || []).some((x) => x != null))
    || ['weapon', 'charmArmor', 'charmWeapon'].some((t) => (build.decorations[t] || []).some((x) => x != null));
  const s = result.slotSummary;
  return html`
    <${Card} title="装飾品" sub="装備を押すと開きます。スロットごとに入る装飾品だけを出します" id="eq-decorations">
      ${groups.length === 0 ? html`<${Empty}>スロットのある装備を選ぶと、ここで装飾品を入れられます</${Empty}>` : html`
        <div data-eq="deco-groups">
          ${groups.map((g) => html`<${DecoGroup} key=${g.target} g=${g} idx=${idx} getItems=${getItems}
            open=${openSet.has(g.target)} onToggle=${() => toggle(g.target)} />`)}
        </div>`}
      ${s && (s.weapon.total || s.armor.total) ? html`
        <div data-eq="free-slots">
          <h3 class="card-subhead">空きスロット</h3>
          <${KeyValue} rows=${[['武器用', L.slotSummaryText(s.weapon)], ['防具用', L.slotSummaryText(s.armor)]]} />
          <${Hint}>武器用 = 武器と護石の武器用スロット、防具用 = 防具 5 部位と護石の防具用スロット。</${Hint}>
        </div>` : null}
      ${hasAny && html`
        <div class="btn-row">
          <${ConfirmButton} label="装飾品を全部外す" confirmLabel="全部外す" variant="secondary"
            onConfirm=${() => { clearDecorations(); toast('装飾品を全部外しました'); }} />
        </div>`}
    </${Card}>`;
}

// ---------------------------------------------------------------- 結果

function IssuesBlock({ result }) {
  const errors = result.errors || [];
  const warnings = result.warnings || [];
  if (!errors.length && !warnings.length) return null;
  return html`
    <div class="stack" data-eq="issues">
      ${errors.length > 0 && html`
        <${Notice} kind="error" title="入らない装飾品などがあります (スキルに数えていません)">
          <ul class="eq-list">${errors.map((e, i) => html`<li key=${i}>${L.friendlyIssue(e)}</li>`)}</ul>
        </${Notice}>`}
      ${warnings.length > 0 && html`
        <${Notice} kind="warn" title="気をつけること">
          <ul class="eq-list">${warnings.map((e, i) => html`<li key=${i}>${L.friendlyIssue(e)}</li>`)}</ul>
        </${Notice}>`}
    </div>`;
}

function Pips({ level, max, over }) {
  if (!max || max > 10) return null;
  const pips = [];
  for (let i = 1; i <= max; i++) pips.push(html`<span key=${i} class=${cx('eq-pip', i <= level && 'is-on')}></span>`);
  for (let i = 0; i < Math.min(over, 3); i++) pips.push(html`<span key=${`o${i}`} class="eq-pip is-over"></span>`);
  return html`<span class="eq-pips" aria-hidden="true">${pips}</span>`;
}

const KIND_TAG = { set: 'シリーズスキル', group: 'グループスキル' };

function SkillRow({ s, idx }) {
  const [open, setOpen] = useState(false);
  const def = idx.skills.get(s.skillId);
  const lv = def && Array.isArray(def.levels) ? def.levels.find((l) => l.level === s.level) : null;
  const over = s.overLimit ? s.rawLevel - s.maxLevel : 0;
  return html`
    <li class="eq-skill" data-skill-id=${s.skillId} data-skill-level=${s.level}>
      <button type="button" class="eq-skill-btn" aria-expanded=${open ? 'true' : 'false'} onClick=${() => setOpen(!open)}>
        <span class="eq-skill-name">
          ${s.name}
          ${KIND_TAG[s.kind] && html`<span class="eq-skill-kind">${KIND_TAG[s.kind]}</span>`}
        </span>
        ${over > 0 && html`<${Badge} kind="warn" title="上限を超えた分は効きません">${`超過 +${over}`}</${Badge}>`}
        <${Pips} level=${s.level} max=${s.maxLevel} over=${over} />
        <span class="eq-lv">Lv${s.level}${s.maxLevel != null && html`<span class="eq-lv-max">/${s.maxLevel}</span>`}</span>
      </button>
      ${open && html`
        <div class="eq-skill-detail">
          ${lv && lv.description && html`<p>${lv.description}</p>`}
          <p>出どころ: ${L.sourcesText(s.sources)}${over > 0 ? `。合計 Lv${s.rawLevel} のうち上限 Lv${s.maxLevel} を超えた分は効きません` : ''}</p>
        </div>`}
    </li>`;
}

function SkillsCard({ result, idx }) {
  const skills = result.skills || [];
  const overCount = skills.filter((s) => s.overLimit).length;
  const sub = skills.length ? `${skills.length} 個・Lv の高い順・押すと説明${overCount ? `・上限超え ${overCount} 個` : ''}` : null;
  return html`
    <${Card} title="発動スキル" sub=${sub} id="eq-skills">
      ${skills.length === 0 ? html`<${Empty}>装備を選ぶと、ここに発動するスキルが出ます</${Empty}>` : html`
        <ul class="eq-skill-list" data-eq="skills">
          ${skills.map((s) => html`<${SkillRow} key=${s.skillId} s=${s} idx=${idx} />`)}
        </ul>`}
    </${Card}>`;
}

function BonusCard({ result, idx }) {
  const lines = L.bonusLines(result, idx);
  if (!lines.length) return null;
  return html`
    <${Card} title="シリーズスキル・グループスキル" sub="何部位で何が発動するか">
      <div data-eq="bonuses">
        ${lines.map((b) => html`
          <div key=${b.key} class="eq-bonus">
            <div class="eq-bonus-head">
              <span class="eq-bonus-name">${b.name}</span>
              ${b.active ? html`<${Badge} kind="ok">発動</${Badge}>` : html`<${Badge} kind="info">まだ</${Badge}>`}
            </div>
            <p>${b.status}</p>
            <p class="eq-bonus-sub">${b.kind === 'set' ? 'シリーズスキル' : 'グループスキル'}・${b.ranksText}・数えた部位: ${b.from}</p>
          </div>`)}
      </div>
    </${Card}>`;
}

// ---------------------------------------------------------------- 火力の要約

const quote = (list) => list.map((x) => `「${x}」`).join('');

/**
 * 火力の要約の計算 (上の帯と「火力の要約」のカードで使う)。いまの装備・相手・コンボ・発動率で、
 * 火力タブと同じ計算 (power_calc.js) をする。斬れ味が自動なら、スキルなしの色は匠なしで決め直す。
 */
function usePowerSummary({ active, data, idx, weapon, result }) {
  const sharpState = useAppState((s) => s.sharpness);
  const uptimes = useAppState((s) => s.uptimes);
  const comboRef = useAppState((s) => s.combo);
  const stTarget = useAppState((s) => s.target);
  const targetUi = useAppState((s) => s.tabs.target);
  // モンスターを選んでいるときだけ相手のデータを読む (選んでいなければ相手タブまで読まない)
  const needTarget = stTarget.mode === 'monster' && stTarget.monsterId != null && !!stTarget.partKey;
  const td = useTargetData({ load: needTarget });
  const tgt = useMemo(() => L.pickDamageTarget(stTarget, resolveTarget(stTarget, td.data), td.status),
    [stTarget, td.data, td.status]);
  // 相手タブで「部位を割合で混ぜる」にしているときは、火力タブと同じく割合で平均する
  const mix = useMemo(() => (needTarget && td.status === 'ready' ? resolveTargetMix(stTarget, targetUi, td.data) : null),
    [needTarget, stTarget, targetUi, td.data, td.status]);
  const monsterStatus = useMemo(() => monsterStatusOf(stTarget, td.status === 'ready' ? td.data : null),
    [stTarget, td.data, td.status]);
  const mixTargets = mix && mix.mixed ? mix.targets : null;
  const targetLabel = mix ? `${mix.label}${stTarget.isWound ? '・傷口' : ''}` : tgt.label;
  const combo = resolveCombo(comboRef, data.combos);
  const auto = weapon ? L.autoSharpness(weapon, idx, result.skillLevels).color : null;
  const sharp = sharpState || auto || 'white';
  const needsElement = !!weapon && L.needsElementInput(weapon, idx);
  const summary = useMemo(() => {
    if (!active || !weapon || !tgt.target) return null;
    return L.summarizePower({
      weapon, sharpness: sharp, skills: result.skills, uptimes, data, combo, target: tgt.target, targets: mixTargets,
      perSkills: L.sharpnessResolver(weapon, idx, sharpState), monsterStatus,
    });
  }, [active, weapon, sharp, sharpState, idx, result, uptimes, data, combo, tgt, mixTargets, monsterStatus]);
  return { summary, tgt, targetLabel, sharp, sharpState, needsElement };
}

/** 画面のその位置まで動かす (上の帯から発動スキル・火力の要約へ) */
function jumpTo(id) {
  const el = document.getElementById(id);
  if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 画面の上に貼りつく小さな要約: 期待値・スキルなし比・発動スキルの数。押すとその場所へ */
function SummaryBar({ weapon, ps, skillCount }) {
  if (!weapon) return null;
  const s = ps.summary;
  let main;
  if (ps.needsElement) main = html`<span class="eq-sumbar-warn">属性をまだ入れていません</span>`;
  else if (ps.tgt.loading || !s) main = html`<span class="eq-sumbar-label">計算中…</span>`;
  else if (s.error) main = html`<span class="eq-sumbar-warn">火力を計算できませんでした</span>`;
  else {
    main = html`
      <span class="eq-sumbar-label">期待値</span>
      <strong>${formatNumber(s.total)}</strong>
      <span class="eq-sumbar-pct">スキルなし比 ${formatPctChange(s.vsNoSkillsPct)}</span>`;
  }
  return html`
    <div class="eq-sumbar" data-eq="summary-bar">
      <button type="button" class="eq-sumbar-main" data-eq="jump-power"
        onClick=${() => jumpTo(ps.needsElement ? 'eq-weapon' : 'eq-power')}>${main}</button>
      <button type="button" class="eq-sumbar-skills" data-eq="jump-skills" onClick=${() => jumpTo('eq-skills')}>
        スキル ${skillCount} 個 ›
      </button>
    </div>`;
}

/** 計算の注意 (火力タブの「計算の注意」と同じ文)。多いときは 3 件まで出して、残りの数を書く */
function WarningList({ warnings }) {
  if (!warnings.length) return null;
  const shown = warnings.slice(0, 3);
  const rest = warnings.length - shown.length;
  return html`
    <ul class="eq-list hint">
      ${shown.map((w, i) => html`<li key=${i}>${w.message}</li>`)}
      ${rest > 0 && html`<li>ほか ${rest} 件は火力タブの「計算の注意」に出ています。</li>`}
    </ul>`;
}

function PowerCard({ weapon, ps }) {
  const { summary, tgt, targetLabel, sharp, sharpState, needsElement } = ps;
  const goPower = html`<${Button} variant="primary" block data-eq="to-power" onClick=${() => goToTab('power')}>火力タブで詳しく見る</${Button}>`;
  let body;
  if (!weapon) body = html`<${Empty}>武器を選ぶと、ここに火力の目安が出ます</${Empty}>`;
  else if (tgt.loading) body = html`<${Loading} text="相手のデータを読み込み中…" />`;
  else if (!summary) body = html`<${Loading} text="計算中…" />`;
  else if (summary.error) {
    body = html`<${Notice} kind="error" title="火力を計算できませんでした"><p>${summary.error}</p></${Notice}>`;
  } else {
    const placeholderLabels = summary.placeholders.map((c) => c.label);
    body = html`
      <div data-eq="power-result">
        ${needsElement && html`
          <${Notice} kind="warn" title="この武器の属性をまだ入れていません"
            actions=${html`<${Button} small onClick=${() => jumpTo('eq-weapon')}>属性を入れる</${Button}>`}>
            <p>属性 0 として計算しています。上の「武器」で属性を入れると、正しい期待値になります。</p>
          </${Notice}>`}
        <div class="eq-power-main">
          <span class="eq-power-num" data-eq-total=${String(summary.total)}>${formatNumber(summary.total)}</span>
          <span class="eq-power-unit">(コンボ 1 回の期待ダメージ${summary.mixed ? '・部位の割合で平均' : ''})</span>
        </div>
        <p class="eq-power-pct">スキルなし比 <strong data-eq-vs=${String(summary.vsNoSkillsPct)}>${formatPctChange(summary.vsNoSkillsPct)}</strong></p>
        <${KeyValue} rows=${[
          ['コンボ', summary.comboName],
          ['相手', targetLabel],
          ['斬れ味', `${SHARPNESS_LABEL[sharp]}${sharpState ? '' : ' (自動)'}`],
          ['内訳', `物理 ${formatNumber(summary.physical)}・属性 ${formatNumber(summary.element)}${summary.extra > 0 ? `・追加 ${formatNumber(summary.extra)}` : ''}`],
        ]} />
        ${tgt.source === 'default' && html`
          <${Notice} kind="info" title="相手の肉質は仮の値です"
            actions=${html`<${Button} small onClick=${() => goToTab('target', { top: true })}>相手タブで選ぶ</${Button}>`}>
            <p>${L.defaultTargetReason(tgt.reason)}、手入力の既定の肉質 (${L.DEFAULT_HITZONE_TEXT}) で計算しています。</p>
          </${Notice}>`}
        ${placeholderLabels.length > 0 && html`
          <${Notice} kind="warn" badge="仮" title="発動の割合が仮の値の条件があります">
            <p>${quote(placeholderLabels)}の割合は、根拠の無い仮の値 (多くは 50%) です。火力タブの「発動率」で、自分の狩りに合わせて変えられます。</p>
          </${Notice}>`}
        ${summary.lowConfidence.length > 0 && html`
          <${Notice} kind="unconfirmed" title="数値が確かでないスキル">
            <p>${quote(summary.lowConfidence.map((s) => s.name))}は、根拠の弱い数値で計算しています。</p>
          </${Notice}>`}
        ${summary.unsupported.length > 0 && html`
          <${Notice} kind="unsupported" title="計算に入れていないスキル">
            <p>${summary.unsupported.map((s) => s.name).join('・')}</p>
          </${Notice}>`}
        <${WarningList} warnings=${summary.warnings} />
        <div class="btn-col">${goPower}</div>
      </div>`;
  }
  return html`
    <${Card} title="火力の要約" sub="いまの装備・相手・コンボで計算 (1 秒あたりの火力ではありません)" id="eq-power">
      <div data-eq="power">${body}</div>
    </${Card}>`;
}

// ---------------------------------------------------------------- マイセット

function MySetSheet({ set, idx, isCurrent, onClose }) {
  const [rename, setRename] = useState(set.name);
  const b = set.build;
  const w = L.resolveWeaponRef(b.weapon, idx);
  const rows = [
    ['武器', w ? L.weaponName(w) : b.weapon != null ? '見つからない武器' : 'なし'],
    ...ARMOR_PARTS.map((p) => {
      const a = b.armor[p] != null ? idx.armor.get(b.armor[p]) : null;
      const name = a ? a.name : b.armor[p] != null ? '見つからない防具' : 'なし';
      return [PART_LABEL[p], `${name}${a && b.limitBreak[p] ? ' (限界突破)' : ''}`];
    }),
    ['護石', (() => {
      if (b.charm == null) return 'なし';
      const c = typeof b.charm === 'number' ? idx.charmsFixed.get(b.charm) : idx.charms.get(b.charm);
      return c ? c.name : '見つからない護石';
    })()],
    ['装飾品', `${Object.values(b.decorations).flat().filter((x) => x != null).length} 個`],
  ];
  const use = () => {
    loadMySet(set.id);
    toast(`「${set.name}」を呼び出しました`);
    onClose();
  };
  const overwrite = () => {
    saveMySet(set.name, { overwriteId: set.id });
    toast(`「${set.name}」をいまの装備で上書きしました`);
    onClose();
  };
  const doRename = () => {
    const t = rename.trim();
    if (!t) return;
    renameMySet(set.id, t);
    toast('名前を変えました');
  };
  const remove = () => {
    deleteMySet(set.id);
    toast(`「${set.name}」を消しました`);
    onClose();
  };
  return html`
    <${BottomSheet} open title=${set.name} onClose=${onClose}>
      <div data-eq="myset-sheet">
        <p class="hint">保存 ${formatDateTime(set.savedAt)}${isCurrent ? '・いまの装備と同じ' : ''}</p>
        <${KeyValue} rows=${rows} />
        <div class="btn-col">
          <${Button} variant="primary" block data-eq="myset-load" onClick=${use}>この装備を呼び出す</${Button}>
          <${ConfirmButton} label="いまの装備で上書きする" confirmLabel="上書きする" variant="secondary" block small=${false}
            message="このセットの中身が、いまの装備に置きかわります。" onConfirm=${overwrite} />
        </div>
        <${NameInput} label="名前を変える" value=${set.name} onInput=${setRename} />
        <div class="btn-row">
          <${Button} small onClick=${doRename} disabled=${!rename.trim() || rename.trim() === set.name}>名前を変える</${Button}>
        </div>
        <div class="btn-row">
          <${ConfirmButton} label="このセットを消す" confirmLabel="消す" eq="myset-delete"
            message="消したセットは戻せません。" onConfirm=${remove} />
        </div>
      </div>
    </${BottomSheet}>`;
}

function MySetsCard({ idx, build }) {
  const sets = useAppState((s) => s.mySets);
  const [nameKey, setNameKey] = useState(0);
  const nameRef = useRef('');
  const [openId, setOpenId] = useState(null);
  const current = L.canonicalBuild(build);
  const save = () => {
    const label = nameRef.current.trim() || `セット ${sets.length + 1}`;
    saveMySet(label);
    toast(`「${label}」をマイセットに保存しました`);
    nameRef.current = '';
    setNameKey((k) => k + 1);
  };
  const open = sets.find((s) => s.id === openId) || null;
  return html`
    <${Card} title="マイセット" sub="いまの装備に名前を付けて残せます" id="eq-mysets">
      <${NameInput} key=${nameKey} label="セットの名前" value="" eq="myset-name" placeholder=${`セット ${sets.length + 1}`}
        onInput=${(t) => { nameRef.current = t; }} />
      <div class="btn-col">
        <${Button} variant="primary" block data-eq="myset-save" onClick=${save}>いまの装備を保存する</${Button}>
      </div>
      ${sets.length > 0 && html`
        <h3 class="card-subhead">保存したセット (${sets.length})</h3>
        <div data-eq="myset-list">
          ${sets.map((s) => html`
            <${Row} key=${s.id} value=${s.name} sub=${`${L.setSummary(s.build, idx)}・${formatDateTime(s.savedAt)}`}
              end=${L.canonicalBuild(s.build) === current ? html`<${Badge} kind="ok">使用中</${Badge}>` : null}
              onClick=${() => setOpenId(s.id)} />`)}
        </div>`}
      <div class="btn-row">
        <${ConfirmButton} label="装備を全部外す" confirmLabel="全部外す" variant="secondary"
          message="武器・防具・護石・装飾品を全部外します (マイセットは消えません)。"
          onConfirm=${() => { clearBuild(); toast('装備を全部外しました'); }} />
      </div>
      ${open && html`<${MySetSheet} key=${open.id} set=${open} idx=${idx} isCurrent=${L.canonicalBuild(open.build) === current}
        onClose=${() => setOpenId(null)} />`}
    </${Card}>`;
}

// ---------------------------------------------------------------- 本体

export default function EquipTab({ data, active }) {
  const build = useAppState((s) => s.build);
  // 画面で足した所持武器・護石も含めた索引 (火力タブも同じ hook を使える)
  const { idx, localWeapons, localCharms } = useEquipIndex(data, { active });
  const result = useMemo(() => computeBuild(build, idx), [build, idx]);
  const weapon = useMemo(() => L.resolveWeaponRef(build.weapon, idx), [build.weapon, idx]);

  const names = {};
  if (weapon) names.weapon = L.weaponName(weapon);
  for (const p of ARMOR_PARTS) {
    const a = build.armor[p] != null ? idx.armor.get(build.armor[p]) : null;
    if (a) names[p] = a.name;
  }
  if (build.charm != null) {
    const c = typeof build.charm === 'number' ? idx.charmsFixed.get(build.charm) : idx.charms.get(build.charm);
    if (c) names.charm = c.name;
  }

  const ps = usePowerSummary({ active, data, idx, weapon, result });

  return html`
    <div class="stack eq-root" data-eq="root">
      <style>${EQUIP_CSS}</style>
      <${SummaryBar} weapon=${weapon} ps=${ps} skillCount=${(result.skills || []).length} />
      <${WeaponCard} data=${data} idx=${idx} build=${build} weapon=${weapon} localWeapons=${localWeapons} result=${result} />
      <${ArmorCard} data=${data} idx=${idx} build=${build} result=${result} />
      <${CharmCard} data=${data} idx=${idx} build=${build} localCharms=${localCharms} />
      <${DecoCard} data=${data} idx=${idx} build=${build} result=${result} names=${names} />
      <${IssuesBlock} result=${result} />
      <${SkillsCard} result=${result} idx=${idx} />
      <${PowerCard} weapon=${weapon} ps=${ps} />
      <${BonusCard} result=${result} idx=${idx} />
      <${MySetsCard} idx=${idx} build=${build} />
    </div>`;
}
