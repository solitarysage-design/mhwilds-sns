// 画面下に少しだけ出る短いお知らせ (「保存しました」など)。
//   import { toast } from '../components/toast.js';
//   toast('マイセットに保存しました');
//   toast('武器の装飾品を 2 個外しました', { action: { label: '元に戻す', onClick: undo }, ms: 6000 });
// <ToastHost /> は shell.js が 1 つだけ置いている。
import { useEffect, useState } from 'preact/hooks';
import { html } from './html.js';

const listeners = new Set();
let seq = 0;

/**
 * お知らせを出す。kind: 'info' | 'error'。ms ミリ秒で消える。
 * action = {label, onClick} を渡すとボタンを付ける (押すと onClick を呼んで消える。「元に戻す」など)。
 */
export function toast(text, { kind = 'info', ms, action = null } = {}) {
  const t = { id: ++seq, text: String(text), kind, ms: ms ?? (action ? 6000 : 2500), action };
  for (const fn of listeners) fn(t);
}

export function ToastHost() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const fn = (t) => {
      setItems((list) => [...list.slice(-2), t]);
      setTimeout(() => setItems((list) => list.filter((x) => x.id !== t.id)), t.ms);
    };
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  if (!items.length) return null;
  const close = (id) => setItems((list) => list.filter((x) => x.id !== id));
  return html`
    <div class="toast-host" role="status" aria-live="polite">
      ${items.map((t) => html`
        <div key=${t.id} class=${`toast toast-${t.kind}${t.action ? ' has-action' : ''}`}>
          <span class="toast-text">${t.text}</span>
          ${t.action && html`
            <button type="button" class="toast-action"
              onClick=${() => { close(t.id); try { t.action.onClick(); } catch (e) { console.warn(e); } }}>
              ${t.action.label}
            </button>`}
        </div>`)}
    </div>`;
}
