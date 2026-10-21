// 画面の一部でエラーが起きても、アプリ全体が真っ白にならないようにする囲い。
// <ErrorBoundary title="装備タブでエラーが起きました">…</ErrorBoundary>
import { Component } from 'preact';
import { html } from './html.js';
import { ErrorBox } from './notice.js';

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    // 開発中に気づけるようにコンソールにも出す (スモークテストはこれで失敗になる)
    console.error('画面の描画でエラー', error);
  }

  render() {
    const { error } = this.state;
    if (error) {
      return html`
        <${ErrorBox} title=${this.props.title || 'この画面でエラーが起きました'} error=${error}
          onRetry=${() => this.setState({ error: null })}>
          <p class="hint">直らないときは、設定タブの「書き出す」で控えを取ってから再読み込みしてください。</p>
        </${ErrorBox}>`;
    }
    return this.props.children;
  }
}
