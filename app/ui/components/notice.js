// 警告・お知らせの表示 (未確定・未対応・エラー)、読み込み中、準備中。
import { html } from './html.js';

/** 印の種類と表示名 */
export const NOTICE_LABEL = {
  unconfirmed: '未確定', // 根拠が弱い数値 (skill_effects の confidence: low など)
  unsupported: '未対応', // 計算に入れていないもの
  error: 'エラー',       // 入らない装飾品・壊れたデータなど
  warn: '注意',
  info: 'お知らせ',
  ok: 'OK',
};

/**
 * 小さな印 (文中や行の右端に置く)。
 * <Badge kind="unconfirmed" /> → 「未確定」。children で文言を変えられる。
 */
export function Badge({ kind = 'unconfirmed', children, title }) {
  return html`<span class=${`badge badge-${kind}`} title=${title}>${children ?? NOTICE_LABEL[kind] ?? kind}</span>`;
}

/**
 * 枠つきの説明。
 * <Notice kind="unsupported" title="計算に入れていないスキル">…</Notice>
 * kind: 'info' | 'warn' | 'error' | 'unconfirmed' | 'unsupported' | 'ok'
 * badge で印の文言を変えられる (仮置きの発動率は kind="warn" badge="仮" で全タブそろえる)。
 */
export function Notice({ kind = 'info', title, children, actions, badge }) {
  const role = kind === 'error' ? 'alert' : 'status';
  return html`
    <div class=${`notice notice-${kind}`} role=${role}>
      <div class="notice-head">
        <${Badge} kind=${kind}>${badge}</${Badge}>
        ${title && html`<strong class="notice-title">${title}</strong>`}
      </div>
      ${children && html`<div class="notice-body">${children}</div>`}
      ${actions && html`<div class="notice-actions">${actions}</div>`}
    </div>`;
}

/** 読み込み中 */
export function Loading({ text = '読み込み中…' }) {
  return html`
    <div class="loading" role="status" aria-live="polite">
      <span class="spinner" aria-hidden="true"></span>
      <span>${text}</span>
    </div>`;
}

/**
 * 失敗の表示 (onRetry を渡すと「もう一度」ボタン。retryLabel で文言を変えられる)。
 * detail を渡すと、技術的な中身 (ファイル名・HTTP の番号など) を「くわしく」の中に小さく出す。
 */
export function ErrorBox({ title = '読み込めませんでした', error, onRetry, retryLabel = 'もう一度', children, detail }) {
  const msg = error ? (error.message || String(error)) : null;
  return html`
    <div class="notice notice-error" role="alert">
      <div class="notice-head">
        <${Badge} kind="error" />
        <strong class="notice-title">${title}</strong>
      </div>
      <div class="notice-body">
        ${msg && html`<p>${msg}</p>`}
        ${children}
        ${detail && html`
          <details class="more">
            <summary>くわしく</summary>
            <p class="hint">${detail}</p>
          </details>`}
      </div>
      ${onRetry && html`
        <div class="notice-actions">
          <button type="button" class="btn btn-secondary" onClick=${onRetry}>${retryLabel}</button>
        </div>`}
    </div>`;
}

/** 準備中 (中身がまだ無いタブ) */
export function Placeholder({ title = '準備中', children }) {
  return html`
    <div class="placeholder">
      <p class="placeholder-title">${title}</p>
      ${children && html`<div class="placeholder-body">${children}</div>`}
    </div>`;
}

/** 空の一覧など */
export function Empty({ children = 'まだありません' }) {
  return html`<p class="empty">${children}</p>`;
}
