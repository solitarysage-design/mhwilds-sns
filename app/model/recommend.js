// 相手に合わせたおすすめの組み立て (段階 3): 守りのスキル・武器の属性・多頭の重み・並べ直し・守りのチェック・createPlanRunner。
// API は docs/RECOMMEND_DESIGN.md 5.3 節。担当: model-recommend (3c)。
// 純粋関数 (DOM にも state.js にも preact にも触らない)。Worker からも読むので import は相対パスだけ
// (damage.js / build.js / search.js / hunt.js / weapon.js だけを読む)。
// いまは置き場だけ: buildPlan は null を返す (相手タブ・探すタブは null なら「おすすめは準備中」として扱う)。

/** おすすめの組み立て (仮。まだ何も組み立てない) */
export function buildPlan() {
  return null;
}
