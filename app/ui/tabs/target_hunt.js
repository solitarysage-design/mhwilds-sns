// 相手タブの段階 3 のカード: 個体・クエスト・人数・体力と強さ・この相手のおすすめ・このクエストの相手 (多頭)・歴戦王で変わること。
// 担当: ui-target (3d)。画面は docs/RECOMMEND_DESIGN.md 4.2 節。計算は app/model/hunt.js (体力・回数・個体の肉質) と
// app/model/recommend.js (buildPlan)。状態は state.js の selectIndividual / selectQuest / setPlayers / setUseUncertainWound、
// 「この相手で装備を探す」は requestSearch() のあと shell.js の goToTab('search', {top: true})。
// 見た目は app/ui/styles_target.css (class は th-*)。いまは置き場だけ。
export {};
