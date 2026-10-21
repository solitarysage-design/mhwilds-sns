// カード・ボタン・一覧の行。
import { html } from './html.js';

const cx = (...a) => a.filter(Boolean).join(' ');

/**
 * 枠つきのまとまり。
 * <Card title="武器" sub="攻撃 190" actions=${html`<Button>…</Button>`}>中身</Card>
 * flush=true で中の余白を無くす (一覧の行を並べるとき)。
 */
export function Card({ title, sub, actions, children, flush = false, class: cls, id }) {
  return html`
    <section class=${cx('card', flush && 'card-flush', cls)} id=${id}>
      ${(title || actions) && html`
        <header class="card-head">
          <div class="card-head-text">
            ${title && html`<h2 class="card-title">${title}</h2>`}
            ${sub && html`<p class="card-sub">${sub}</p>`}
          </div>
          ${actions && html`<div class="card-actions">${actions}</div>`}
        </header>`}
      <div class="card-body">${children}</div>
    </section>`;
}

/**
 * ボタン (高さ 44px 以上)。
 * variant: 'primary' | 'secondary' (既定) | 'danger' | 'ghost'
 * block=true で横幅いっぱい。small=true で少し小さく (それでも 44px のタップ領域)。
 */
export function Button({
  variant = 'secondary', block = false, small = false, disabled = false, onClick, type = 'button',
  children, title, class: cls, ...rest
}) {
  return html`
    <button type=${type} class=${cx('btn', `btn-${variant}`, block && 'btn-block', small && 'btn-small', cls)}
      disabled=${disabled} onClick=${onClick} title=${title} ...${rest}>${children}</button>`;
}

/**
 * 一覧の 1 行 (タップできる行は onClick を渡す)。
 * <Row label="頭" value="アルシュヘルムβ" sub="攻撃 Lv1" onClick=${open} />
 * end には右端に置くもの (バッジなど) を渡せる。
 */
export function Row({ label, value, sub, end, onClick, chevron, class: cls }) {
  const body = html`
    <span class="row-main">
      ${label != null && html`<span class="row-label">${label}</span>`}
      ${value != null && html`<span class="row-value">${value}</span>`}
      ${sub != null && html`<span class="row-sub">${sub}</span>`}
    </span>
    ${end != null && html`<span class="row-end">${end}</span>`}
    ${(chevron ?? !!onClick) && html`<span class="row-chevron" aria-hidden="true">›</span>`}`;
  if (onClick) {
    return html`<button type="button" class=${cx('row', 'row-button', cls)} onClick=${onClick}>${body}</button>`;
  }
  return html`<div class=${cx('row', cls)}>${body}</div>`;
}

/** 説明の小さい文字 */
export function Hint({ children }) {
  return html`<p class="hint">${children}</p>`;
}

/** 見出しと値の 2 列の表 (rows: [[見出し, 値], ...]) */
export function KeyValue({ rows }) {
  return html`
    <dl class="kv">
      ${rows.filter(Boolean).map(([k, v]) => html`<div class="kv-row"><dt>${k}</dt><dd>${v}</dd></div>`)}
    </dl>`;
}
