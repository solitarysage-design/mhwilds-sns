// htm を Preact の h に結びつけた html タグ。画面のファイルはここから import する。
//   import { html } from '../components/html.js';
//   return html`<div class="card">${name}</div>`;
import { h, Fragment } from 'preact';
import htm from 'htm';

export const html = htm.bind(h);
export { h, Fragment };
