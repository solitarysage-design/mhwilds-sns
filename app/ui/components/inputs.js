// 入力の部品: 数値入力・スライダー・トグル・切り替えボタン・選択・文字入力。
// どれも高さ 44px 以上。文字は 16px 以上 (iPhone で入力欄を触ったときに拡大されないように)。
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { html } from './html.js';

const cx = (...a) => a.filter(Boolean).join(' ');

function decimalsOf(step) {
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

function toText(v) {
  return v == null || !Number.isFinite(Number(v)) ? '' : String(v);
}

/** 全角数字・全角マイナス・カンマを吸収して数にする。空欄は null、読めなければ NaN。 */
export function parseNumber(s) {
  const t = String(s ?? '').normalize('NFKC').replace(/[−ー―‐]/g, '-').replace(/,/g, '').trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

function FieldHead({ id, label, end }) {
  if (label == null && end == null) return null;
  return html`
    <div class="field-head">
      ${label != null && html`<label class="field-label" for=${id}>${label}</label>`}
      ${end != null && html`<span class="field-end">${end}</span>`}
    </div>`;
}

/**
 * 数値入力。value は数 (空なら null)。打っている途中でも範囲内の数なら onChange、離れたときに範囲へ丸める。
 * <NumberInput label="攻撃力" value=${v} onChange=${setV} min=${0} max=${500} step=${1} unit="" />
 * stepper=true で −/＋ ボタン (step ずつ)。min が負なら ± ボタンも出す (iPhone の数字キーにマイナスが無いため)。
 * allowEmpty=true なら空欄 (null) を許す。
 */
export function NumberInput({
  label, value, onChange, min = -Infinity, max = Infinity, step = 1, unit, hint, placeholder,
  stepper = true, allowEmpty = false, disabled = false,
}) {
  const id = useId();
  const [text, setText] = useState(toText(value));
  const focused = useRef(false);
  const decimals = decimalsOf(step);
  useEffect(() => {
    if (!focused.current) setText(toText(value));
  }, [value]);

  const fix = (n) => Number(Math.min(max, Math.max(min, n)).toFixed(decimals));
  const emit = (n) => {
    if (n !== value) onChange && onChange(n);
  };
  const onInput = (e) => {
    const t = e.currentTarget.value;
    setText(t);
    const n = parseNumber(t);
    if (n != null && !Number.isNaN(n) && n >= min && n <= max) emit(n);
  };
  const onBlur = () => {
    focused.current = false;
    const n = parseNumber(text);
    if (n == null) {
      if (allowEmpty) {
        setText('');
        emit(null);
      } else {
        setText(toText(value));
      }
      return;
    }
    if (Number.isNaN(n)) {
      setText(toText(value));
      return;
    }
    const c = fix(n);
    setText(toText(c));
    emit(c);
  };
  const stepBy = (d) => {
    const base = value == null ? (Number.isFinite(min) ? min : 0) : Number(value);
    const c = fix(base + d * step);
    setText(toText(c));
    emit(c);
  };
  const flip = () => {
    const c = fix(-(Number(value) || 0));
    setText(toText(c));
    emit(c);
  };
  return html`
    <div class="field">
      <${FieldHead} id=${id} label=${label} />
      <div class="number-row">
        ${stepper && html`<button type="button" class="btn btn-secondary btn-square" aria-label="減らす"
          disabled=${disabled || (value != null && value <= min)} onClick=${() => stepBy(-1)}>−</button>`}
        ${min < 0 && html`<button type="button" class="btn btn-secondary btn-square" aria-label="プラスとマイナスを入れ替える"
          disabled=${disabled} onClick=${flip}>±</button>`}
        <div class="number-box">
          <input id=${id} class="input input-number" type="text"
            inputmode=${decimals > 0 ? 'decimal' : 'numeric'} enterkeyhint="done" autocomplete="off"
            value=${text} placeholder=${placeholder} disabled=${disabled}
            onFocus=${() => { focused.current = true; }} onInput=${onInput} onBlur=${onBlur}
            onKeyDown=${(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
          ${unit && html`<span class="number-unit">${unit}</span>`}
        </div>
        ${stepper && html`<button type="button" class="btn btn-secondary btn-square" aria-label="増やす"
          disabled=${disabled || (value != null && value >= max)} onClick=${() => stepBy(1)}>＋</button>`}
      </div>
      ${hint && html`<p class="hint">${hint}</p>`}
    </div>`;
}

/**
 * スライダー。percent=true なら 0〜1 の値を「50%」で表示する。
 * <Slider label="怒り状態の割合" value=${0.5} onChange=${set} min=${0} max=${1} step=${0.05} percent />
 * format で表示を変えられる (value → 文字列)。
 * 動かしている間はつまみと数字だけをその場で変え、onChange は指を離したとき (change) か、
 * 止めて commitDelay ミリ秒たったときに呼ぶ (火力タブは 1 回の計算と描き直しが重いので、動かすたびには呼ばない)。
 */
export function Slider({
  label, value, onChange, min = 0, max = 1, step = 0.05, percent = false, format, hint, disabled = false,
  commitDelay = 150,
}) {
  const id = useId();
  const outer = Number.isFinite(Number(value)) ? Number(value) : min;
  const [live, setLive] = useState(null);   // 動かしている間の値 (null = 外から渡された value を出す)
  const timer = useRef(null);
  const outerRef = useRef(outer);           // いまの外の値 (遅らせて呼ぶ commit から見る)
  outerRef.current = outer;
  useEffect(() => () => clearTimeout(timer.current), []);
  // 外から値が変わったら (動かしていない間は) そちらに合わせる
  useEffect(() => {
    if (timer.current == null) setLive(null);
  }, [outer]);
  const commit = (x) => {
    clearTimeout(timer.current);
    timer.current = null;
    if (onChange && x !== outerRef.current) onChange(x);
    setLive(null);
  };
  const v = live ?? outer;
  const shown = format ? format(v) : percent ? `${Math.round(v * 100)}%` : String(v);
  const fill = max > min ? ((v - min) / (max - min)) * 100 : 0;
  return html`
    <div class="field">
      <${FieldHead} id=${id} label=${label} end=${html`<output for=${id} class="slider-value">${shown}</output>`} />
      <input id=${id} class="slider" type="range" min=${min} max=${max} step=${step} value=${v}
        disabled=${disabled} style=${`--fill: ${fill}%`}
        onInput=${(e) => {
          const x = Number(e.currentTarget.value);
          setLive(x);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => commit(x), commitDelay);
        }}
        onChange=${(e) => commit(Number(e.currentTarget.value))} />
      ${hint && html`<p class="hint">${hint}</p>`}
    </div>`;
}

/**
 * オン/オフ。行全体がタップできる。
 * <Toggle label="限界突破" checked=${on} onChange=${setOn} hint="…" />
 */
export function Toggle({ label, checked, onChange, hint, disabled = false }) {
  return html`
    <label class=${cx('toggle', disabled && 'is-disabled')}>
      <span class="toggle-text">
        <span class="toggle-label">${label}</span>
        ${hint && html`<span class="hint">${hint}</span>`}
      </span>
      <input class="toggle-input" type="checkbox" role="switch" checked=${!!checked} disabled=${disabled}
        onChange=${(e) => onChange && onChange(e.currentTarget.checked)} />
      <span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span>
    </label>`;
}

/**
 * いくつかから 1 つを選ぶボタンの並び (狭いと折り返す)。
 * <Segmented label="斬れ味" options=${[{value: null, label: '自動'}, {value: 'white', label: '白'}]} value=${v} onChange=${set} />
 */
export function Segmented({ label, options, value, onChange, disabled = false }) {
  const id = useId();
  return html`
    <div class="field">
      ${label != null && html`<div class="field-head"><span class="field-label" id=${id}>${label}</span></div>`}
      <div class="segmented" role="radiogroup" aria-labelledby=${label != null ? id : undefined}>
        ${options.map((o) => html`
          <button type="button" role="radio" aria-checked=${Object.is(o.value, value) ? 'true' : 'false'}
            class=${cx('segment', Object.is(o.value, value) && 'is-selected')} disabled=${disabled || o.disabled}
            onClick=${() => onChange && onChange(o.value)}>${o.label}</button>`)}
      </div>
    </div>`;
}

/**
 * iPhone の標準の選択 (回転する選択肢)。項目が少ないとき用。多いときは picker.js の PickerField。
 * options: [{value, label}] (value は数でも文字でもよい)
 */
export function Select({ label, options, value, onChange, hint, disabled = false }) {
  const id = useId();
  const idx = options.findIndex((o) => Object.is(o.value, value));
  return html`
    <div class="field">
      <${FieldHead} id=${id} label=${label} />
      <select id=${id} class="input select" disabled=${disabled} value=${String(idx)}
        onChange=${(e) => { const o = options[Number(e.currentTarget.value)]; if (o && onChange) onChange(o.value); }}>
        ${idx < 0 && html`<option value="-1" disabled>選んでください</option>`}
        ${options.map((o, i) => html`<option value=${String(i)} disabled=${o.disabled}>${o.label}</option>`)}
      </select>
      ${hint && html`<p class="hint">${hint}</p>`}
    </div>`;
}

/**
 * 文字の入力 (名前など)。離れたとき・Enter で onChange。
 * onInput を渡すと打つたびにも呼ぶ (iPhone の Safari はボタンを押しても入力欄から離れないことがあるので、
 * 「入れてすぐボタンを押す」所では onInput で値を受け取る)。
 */
export function TextInput({ label, value, onChange, onInput, placeholder, hint, maxLength = 60, disabled = false }) {
  const id = useId();
  const [text, setText] = useState(value ?? '');
  useEffect(() => setText(value ?? ''), [value]);
  const commit = () => {
    if (text !== value && onChange) onChange(text);
  };
  return html`
    <div class="field">
      <${FieldHead} id=${id} label=${label} />
      <input id=${id} class="input" type="text" value=${text} placeholder=${placeholder} maxLength=${maxLength}
        disabled=${disabled} enterkeyhint="done" autocomplete="off"
        onInput=${(e) => { const t = e.currentTarget.value; setText(t); if (onInput) onInput(t); }} onBlur=${commit}
        onKeyDown=${(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
      ${hint && html`<p class="hint">${hint}</p>`}
    </div>`;
}
