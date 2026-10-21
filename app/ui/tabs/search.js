// 探すタブ (段階 2・3): 持っている護石で火力の高い装備を探す・相手に合わせたおすすめ。
// 設計は docs/RECOMMEND_DESIGN.md 4.3 節 (画面) と docs/SEARCH_DESIGN.md (探索)。担当: ui-search (3e)。
// いまは置き場だけ (「準備中」のカード)。分けたファイル:
//   search_form.js    純粋関数 (state → Plan の選び → Job、必須の行の編集、結果の見せ方)
//   search_client.js  Worker の出し入れ (hook useSearchRun)
//   search_results.js 結果の一覧と詳しくのシート
// 見た目は app/ui/styles_search.css (class は sr-*)。
// 「この相手で装備を探す」から来たときは state.search.autoStart に印がある (state.js の requestSearch / takeSearchRequest)。
import { html, Card, Placeholder } from '../components/index.js';

export default function SearchTab() {
  return html`
    <div class="stack" data-search-tab="placeholder">
      <${Card} title="装備を探す">
        <${Placeholder} title="準備中">
          <p>持っている護石を使って、火力の高い装備の組み合わせを探す画面をこれから作ります。</p>
          <p>相手タブで選んだモンスターに合わせて、守りのスキルも考えて探せるようにする予定です。</p>
        </${Placeholder}>
      </${Card}>
    </div>`;
}
