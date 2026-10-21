# 画面の作り方 (app/ui・state.js・data.js・store.js)

画面の骨組み (担当: ui-shell) の使い方。各タブの担当はこれを読んで `app/ui/tabs/<タブ>.js` を書く。
計算の関数は `docs/MODEL_API.md`、データの形は `docs/ARCHITECTURE.md` が正。

## 全体

```
index.html            import map ("preact" / "preact/hooks" / "htm" → app/vendor/)。起動できないときの案内も持つ
manifest.webmanifest  ホーム画面に追加用 (アイコンは app/icons/)
sw.js                 Service Worker。オフライン・更新の帯 (下の「sw.js」節)
app/main.js           入口: データ読み込み開始 → 状態の復元 → 画面を描く → Service Worker 登録
app/state.js          アプリ全体の状態 (1 か所)。変更は関数で。IndexedDB に自動保存
app/data.js           data/*.json を読んで配る (相手タブのデータは遅延読み込み)
app/store.js          IndexedDB の薄いラッパ・全データの書き出し/読み込み
app/ui/shell.js       骨組み (見出し・タブバー・更新の帯・お知らせ・ホーム画面に追加の案内)。タブは開いたときに読み込む。
                      goToTab(tab, {top}) / reloadPage() (保存してから再読み込み) / isStandalone() / setTabDot(tab, on) を出す
app/ui/styles.css     見た目 (色は :root の変数。ダーク表示も変数の差し替えだけ)
app/ui/styles_search.css  探すタブの見た目 (段階 2・3。class は sr-*。担当: ui-search)
app/ui/styles_target.css  相手タブの段階 3 のカードの見た目 (class は th-*。担当: ui-target)
app/ui/components/    共通部品 (index.js からまとめて import できる)
app/ui/tabs/          equip.js (装備) / power.js (火力) / target.js (相手) / search.js (探す) / charms.js (護石) / settings.js (設定)
                      ほかに target_hunt.js (相手タブの段階 3 のカード)・search_form.js / search_client.js / search_results.js (探すタブ)
app/search_worker.js  装備探索の Web Worker (段階 2。担当: solver)
app/vendor/           preact 10.24.3・htm 3.1.1 (README.md に取得元と版)
app/icons/            単色の文字アイコン (make_icons.py で作り直せる)
tests/smoke_ui.py     iPhone 幅の画面のスモークテスト (Playwright)
```

決まりごと:

- **URL はすべて相対パス**。GitHub Pages では `https://solitarysage-design.github.io/mhwilds-sns/` の下に置かれるので、
  先頭が `/` の絶対パスは壊れる (スモークテストが `/mhwilds-sns/` の外へのリクエストを失敗にする)。
  JS の import は `'../components/index.js'` のようにファイルからの相対、データの URL は data.js が作る。
- ブラウザ保存のキーは必ず `mhwilds-sns:` で始める (同じ github.io に別のサイトがある)。保存は store.js 経由で。
- 外部ライブラリは `app/vendor/` にあるものだけ。CDN は読まない。ゲームのアイコン画像は使わない。
- 画面の文言はやさしい日本語 (使う人はプレイヤー本人。プログラマーではない)。内部のコードや英語の id をそのまま出さない。
- 幅 375px で横スクロールが出ないこと。タップできるものは 44px 以上 (共通部品はそうなっている)。
- 入力欄の文字は 16px 以上 (未満だと iPhone が入力時に画面を拡大する)。共通部品の `.input` はそうなっている。

## タブの書き方

タブは `export default` の Preact 部品 1 つ。shell.js が初めて開いたときに読み込み、エラーの囲い (ErrorBoundary) の中に置く。

```js
// app/ui/tabs/equip.js
import { useMemo } from 'preact/hooks';
import { html, Card, PickerField, Toggle, Badge, Notice, PART_LABEL, formatSlots } from '../components/index.js';
import { useAppState, setWeapon, setArmor, setLimitBreak, ARMOR_PARTS } from '../../state.js';
import { computeBuild } from '../../model/build.js';

export default function EquipTab({ data, active }) {
  // data = data.js の core データ (読み込み済み)。active = このタブが今見えているか
  const build = useAppState((s) => s.build);
  const result = useMemo(() => computeBuild(build, data.index), [build, data]);

  const weaponItems = useMemo(() => data.lists.weapons.map((w) => ({
    value: w.id, label: w.displayName || w.name, sub: `攻撃 ${w.attackDisplay}・スロット ${formatSlots(w.slots)}`,
    group: `レア ${w.rarity}`,
  })), [data]);

  return html`
    <div class="stack">
      <${Card} title="武器" flush>
        <${PickerField} label="武器" title="武器を選ぶ" items=${weaponItems} value=${build.weapon}
          onChange=${(v) => setWeapon(v)} allowNone />
      </${Card}>
      <${Card} title="防具">
        ${ARMOR_PARTS.map((p) => html`
          <${Toggle} key=${p} label=${`${PART_LABEL[p]}を限界突破`} checked=${build.limitBreak[p]}
            onChange=${(on) => setLimitBreak(p, on)} />`)}
      </${Card}>
      ${result.errors.length > 0 && html`
        <${Notice} kind="error" title="入らない装飾品があります">
          ${result.errors.map((e) => html`<p>${e.message}</p>`)}
        </${Notice}>`}
    </div>`;
}
```

- props: `data` (core データ。下の「data.js」節。設定タブ以外は読み終わってから描かれる)、`active` (今見えているか)。
- タブは一度開くと閉じても消さずに隠すだけ (入力途中の状態とスクロール位置が残る)。重い計算は `active` のときだけにするとよい。
- タブを足す・名前を変えるときは shell.js の `TAB_DEFS` と state.js の `TABS` (担当: ui-shell) を直す。
- 1 タブ 1 ファイルが基本。ファイルを分けたら `sw.js` の `PRECACHE` にも足す必要がある (担当外なら報告に書く。スモークテストが抜けを失敗で知らせる)。
- エラーで描けないときは「〇〇タブでエラーが起きました」と「もう一度」が出て、他のタブは動き続ける。
- **未確定・未対応・エラー** は共通の印で出す: `<${Badge} kind="unconfirmed" />` (未確定)、`kind="unsupported"` (未対応)、`kind="error"`。
  まとまった説明は `<${Notice} kind="unconfirmed" title="…">`。damage.js の `lowConfidence` は未確定、`unsupported` は未対応。
  「未確定」は**根拠の弱い数値のスキル**だけに使う。仮置きの発動率 (`conditions[].placeholder`) はどの画面でも
  `<${Badge} kind="warn">仮</${Badge}>` / `<${Notice} kind="warn" badge="仮">` にそろえる。
  データで確かめられていないこと (属性やられの `blightsUncertain` など) は `<${Badge} kind="warn">未確認</${Badge}>`。
- 画面の文言に、ファイル名・HTTP の番号・内部の id・英語 (DPS・MV など) を出さない。出すなら「くわしく」(`<details class="more">`) の中に。
  「DPS」は「1 秒あたりの火力」、「MV」は「モーション値」と書く。名前を文の中に入れるときは「」で囲む (「の」「は」の前に空白を入れない)。
- タブの中のボタンで別のタブへ移るときは `setTab` ではなく shell.js の `goToTab(tab, {top})` を使う (今のタブのスクロール位置を
  覚え、`top: true` なら移った先を先頭から出す)。
- 見ていないタブに新しいもの (探すタブの結果など) ができたら shell.js の `setTabDot(tab)` でタブの絵に小さな点を付ける
  (そのタブを開くと消える。開いているタブには付かない。`setTabDot(tab, false)` で消す)。
- Monster Hunter Wiki 由来 (`monster_threats.json`・`quests.json`) の内容を出す画面には、出典とライセンス (CC BY-SA 4.0) を小さく添える
  (設定タブにも全体の表記がある)。
- 親の要素に `transform` を付けない (シートが position: fixed で出るため、ずれる)。

## state.js (アプリ全体の状態)

状態は 1 つのオブジェクト。**直接書き換えない**。変更関数を呼ぶと新しいオブジェクトに入れ替わり、購読している部品が描き直され、
0.3 秒後に IndexedDB (`mhwilds-sns:state`) に保存される。次に開いたとき `initState()` (main.js が呼ぶ) で戻る。
保存できない環境 (プライベートブラウズなど) でもメモリで動く。

### 形

```js
{
  schema: 1,
  tab: 'equip',                 // 'equip' | 'power' | 'target' | 'search' | 'charms' | 'settings' (次回もこのタブで開く)
  build: {                      // 装備一式。computeBuild(state.build, data.index) にそのまま渡せる
    weapon: null,               // 数値 = weapons_sns.json の id / 文字列 = my_weapons.json の id / null
    armor: { head: null, chest: null, arms: null, waist: null, legs: null },   // armor.json の id
    limitBreak: { head: false, chest: false, arms: false, waist: false, legs: false }, // 限界突破 (computeBuild の limitBreak)
    charm: null,                // 文字列 = charms.json の id / 数値 = charms_fixed.json の id / null
    decorations: {              // i 番目 = その装備の i 番目のスロット (decorations.json の id か null)。最大 3
      weapon: [], head: [], chest: [], arms: [], waist: [], legs: [], charmArmor: [], charmWeapon: [],
    },
  },
  target: {
    mode: 'monster',            // 'monster' (モンスターと部位) | 'manual' (肉質の手入力)
    monsterId: null,            // monsters.json の id
    partKey: null,              // monsters.json の parts[].key
    isWound: false,             // 傷口を狙う
    questId: null,              // quests.json の id。クエストを選んでいなければ null
    manual: { name: '手入力',
              hitzone: { slash: 45, blunt: 45, fire: 20, water: 20, thunder: 20, ice: 20, dragon: 20 },
              wound: null },    // 傷口の肉質 (同じ形) か null
    // 段階 3 (docs/RECOMMEND_DESIGN.md 5.6 節)
    individual: null,           // 個体 (monsters.json の individuals[].kind)。null = 通常 | 'tempered' | 'arch-tempered' | 'frenzied' | 'alpha'
    questTargetIndex: 0,        // 多頭のとき、下のカードに出す相手 (mission.targets の行の番号 = hunt.js の questSubjects の index)
    players: 1,                 // 人数 1〜4 (体力の表示だけ)
    useUncertainWound: false,   // 確度の低い傷口の置き換え (歴戦王アルシュベルド) を計算に使う
  },
  search: {                     // 探すタブの条件 (段階 2・3。docs/RECOMMEND_DESIGN.md 5.6 節。既定は defaultSearch())
    useTarget: true,            // 相手に合わせたおすすめを使う (false = 段階 2: 自分で決める)
    preset: 'balance',          // 守りのスキルの段 'power' (火力優先) | 'balance' | 'safe' (安全)
    toggles: {},                // {要件の key: true|false} プリセットから変えたものだけ
    levels: {},                 // {要件の key: Lv} 軽減の Lv を選んだものだけ
    required: [],               // 自分で足した必須スキル [{skillId, level}] (最大 30)
    weaponMode: 'auto',         // 'auto' | 'current' (いまの武器) | 'element' (おすすめの属性から) | 'all' (全部から)
    twoWeapons: 'auto',         // 多頭で武器を 2 本にする案 'auto' (属性の違う相手がいれば) | 'on' | 'off'
    partsPolicy: 'asSelected',  // 'asSelected' (相手タブの部位) | 'weak1' (弱点 1 か所) | 'main3' (主な部位 3 か所)
    charms: { owned: true, local: true, fixed: true },  // 持っている護石 / この端末で足した護石 / 生産する護石
    limitBreak: 'build',        // 'build' (装備タブと同じ) | 'all' | 'none'
    archTemperedHunted: {},     // {monsterId: false} 倒していない歴戦王だけ (無い = 倒した扱い)
    armorExclude: [],           // 使わない防具の id
    placeholders: 'zero',       // 仮置きの発動率の条件 'zero' (0% で探す) | 'keep' (火力タブの値のまま)
    budgetSec: 6,               // 探す時間の目安 (秒・1〜60)
    K: 10,                      // 出す件数 (1〜50)
    autoStart: null,            // 「この相手で装備を探す」から来た印 {id, from, at} (下の「自動で探し始める受け渡し」。保存からは戻さない)
  },
  combo: null,                  // combos_sns.json の id か 技 id の配列。null = 先頭の代表コンボ
  uptimes: {},                  // 条件グループの発動率。damage.js の uptimes にそのまま渡せる (例 {enraged: 0.7, chain: {hit5plus: 0.7}})
  sharpness: null,              // null = 武器から自動 / 'red'〜'purple' = 固定
  mySets: [],                   // マイセット [{id: 's…', name, savedAt (ISO), build (上の build と同じ形)}]
  tabs: {},                     // タブごとの小さな画面状態 {power: {showDetail: true}, ...} (setTabState)
}
```

### 読む

```js
import { useAppState, getState, subscribe } from '../../state.js';

const weapon = useAppState((s) => s.build.weapon);   // 部品の中 (hook)。戻り値が変わったときだけ描き直す
const build = useAppState((s) => s.build);           // 一部をそのまま返すのはよい (変更されたら別のオブジェクトになる)
// × useAppState((s) => ({ a: s.combo, b: s.sharpness }))  毎回新しいオブジェクト → 毎回描き直しになる。分けて 2 回呼ぶ
const now = getState();                              // 部品の外 (イベントの中など)
const off = subscribe((s) => { … });                 // 変わるたびに呼ばれる。off() でやめる
```

### 変える

| 関数 | 中身 |
|---|---|
| `setTab(tab)` | 開くタブ |
| `setWeapon(ref, {keepDecorations, decorations})` | 武器 (null で外す)。既定で武器の装飾品を外す。`decorations: [...]` でその並びにする |
| `setArmor(part, ref, {keepDecorations, resetLimitBreak, decorations})` | 防具。既定でその部位の装飾品を外す。限界突破の有無は残す |
| `setLimitBreak(part, on)` | 限界突破。`part = null` で全部位 |
| `setCharm(ref, {keepDecorations, decorations: {charmArmor, charmWeapon}})` | 護石。既定で護石の装飾品を外す |
| `setDecoration(target, index, decoId)` | 装飾品を 1 つ (null で外す)。入るかの検査はしない (computeBuild の errors / `decorationFitError` で) |
| `setDecorations(target, list)` / `clearDecorations(target?)` | まとめて入れる / 外す (target を省くと全部) |
| `setBuild(build)` / `clearBuild()` | 装備一式を入れ替える (探索の結果など) / 全部外す |
| `setTarget(patch)` | 相手を浅いマージで変える |
| `setTargetMode('monster' \| 'manual')` | 選び方の切り替え |
| `selectMonster(monsterId, partKey?)` / `selectPart(partKey)` / `setWound(on)` | モンスター・部位・傷口。`selectMonster` は個体を通常に戻し、クエストから外す (`questId: null`・`questTargetIndex: 0`) |
| `selectIndividual(kind, {targetData, questId})` | 個体 (null = 通常)。クエストも選び直す: `questId` を渡せばそれ (null で外す)、`targetData` (`useTargetData().data`) を渡せば hunt.js の `defaultQuestId` の規則で、どちらも無ければ外す。`questTargetIndex` はそのクエストのこの個体の行 |
| `selectQuest(questId, {targetIndex, monsterId, individual, partKey})` | クエスト (null で外す) と下のカードに出す相手の行。`monsterId` などを渡すといっしょに替える (「クエストの名前から選ぶ」・多頭の相手の行をタップ。クエストは残る)。モンスターが替わると部位 (渡さなければ未選択) と傷口の指定を外す |
| `setPlayers(n)` / `setUseUncertainWound(on)` | 人数 (1〜4) / 確度の低い傷口の置き換えを使うか |
| `setSearch(patch)` | 探すタブの条件 (浅いマージ。`charms` だけ中身もマージ。値は `sanitizeSearch` でそろえる。`autoStart` は変えない) |
| `setSearchToggle(key, on)` / `setSearchLevel(key, level)` | 守りの要件 1 つのオン/オフ・軽減の Lv (null でプリセット・既定に戻す) |
| `addRequired(skillId, level)` / `setRequiredLevel(skillId, level)` / `removeRequired(skillId)` | 自分で足す必須スキル (同じスキルは 1 行。`addRequired` はあれば Lv を変える) |
| `setArchTemperedHunted(monsterId, hunted)` / `setArmorExcluded(armorId, excluded)` | 倒した歴戦王 / 使わない防具 |
| `requestSearch({from})` → id / `takeSearchRequest(id)` → 印 か null | 自動で探し始める受け渡し (下) |
| `setManualHitzone(patch, {wound})` | 手入力の肉質 (0〜100 に丸める)。`{wound: true}` で傷口の肉質、`setManualHitzone(null, {wound: true})` で傷口の手入力をやめる |
| `setCombo(comboIdOrMoves)` | コンボ (null で既定) |
| `setUptime(groupId, value)` | 条件グループの発動率。binary は 0〜1 の数、categorical は `{段 id: 0〜1}` |
| `setUptimeState(groupId, stateId, ratio)` | categorical の 1 つの段だけ変える |
| `resetUptime(groupId?)` | 既定 (skill_effects.json の defaultUptime) に戻す。省くと全部 |
| `setSharpness(color \| null)` | 斬れ味の色の固定 / 自動 |
| `saveMySet(name, {overwriteId})` → id | 今の装備をマイセットに (overwriteId で上書き) |
| `loadMySet(id)` / `renameMySet(id, name)` / `deleteMySet(id)` | マイセットを使う / 名前を変える / 消す |
| `setTabState(tab, patch)` | タブごとの小さな画面状態 (浅いマージ。JSON にできる値だけ) |

条件グループの id は `data.skillEffects.rules.conditionGroups[].id` (例 `enraged` = 怒り、`chain` = 連撃の段)。
画面に出す条件の一覧は `comboExpected(...).conditions` を使うと、そのスキル構成で効くものだけが分かる (`docs/MODEL_API.md`)。

### 計算に渡す近道

```js
import { resolveTarget, resolveCombo, uptimeOf } from '../../state.js';
import { useTargetData } from '../../data.js';

const t = useTargetData();                                  // 相手のデータ (遅延読み込み)
const target = resolveTarget(state.target, t.data);         // → {hitzone, wound, isWound, label, monster?, part?} か null (未選択・未読み込み)
// 個体 (state.target.individual) があれば hunt.js の hitzoneFor で傷口を置き換え、ラベルは「ウズ・トゥナ（歴戦王） 頭」。
// 返り値に individual・woundSource・woundMark ('unverified' = 未確認 / 'uncertain' = 未確定 / null) も入る (docs/MODEL_API.md の hunt.js)
const combo = resolveCombo(state.combo, data.combos);       // → combos[] の 1 件か 技 id の配列
const r = comboExpected({ weapon, sharpness, skills: build.skills, uptimes: state.uptimes,
                          effects: data.skillEffects, motions: data.motions, combo, target });
```

### そのほか

- 装備タブは装備を替えるとき、`equip_logic.js` の `refitDecorations` で**新しい装備のスロットに入る珠を残し**、入らない珠だけ外して
  toast で知らせる (「元に戻す」付き)。限界突破を外してスロットが小さくなったときも同じ。
- `initState()` / `reloadState()` / `resetState()` / `flushState()`: 起動時の復元 (main.js) / 読み込み後の読み直し / 初期化 / 今すぐ保存。
  `resetState()` は開いているタブ (`tab`) だけ残す (設定タブで初期化したあと設定タブのまま)。
  再読み込みの前 (更新の帯・「再読み込み」ボタン) は `flushState()` を待ってから (shell.js の `reloadPage()`)。
- `getSaveStatus()` / `subscribeSaveStatus(fn)`: 保存の状態 `{status: 'idle'|'saved'|'memory', at}` と、変わったときの通知
  (shell.js が、初めて `memory` になったときに「この端末に保存できていません」の toast を出す)。
- 保存領域を開くのが時間切れ (4 秒) になったあとで開けたら、まだ何も変えていなければ保存してある状態を読み直す。
- `sanitizeState(raw)` / `sanitizeBuild(raw)` / `sanitizeSearch(raw)`: 保存データや読み込んだデータを今の形にそろえる (足りない項目は初期値)。
  段階 2・3 の項目 (`target.individual` など・`search`) は足しただけなので `STATE_SCHEMA` は 1 のまま。古い保存データ (項目が無い) は初期値になる。
- 初期値: `emptyBuild()` / `emptyTarget()` / `defaultSearch()` / `defaultState()`。
- 定数: `TABS`, `ARMOR_PARTS`, `DECO_TARGETS`, `SHARPNESS_ORDER`, `HITZONE_KEYS`, `STATE_KEY`, `INDIVIDUAL_KINDS` (個体の値)、
  `SEARCH_CHOICES` (探すタブの選び方の候補 `{preset, weaponMode, twoWeapons, partsPolicy, limitBreak, placeholders}`)。

### 自動で探し始める受け渡し (相手タブ →「この相手で装備を探す」→ 探すタブ)

```js
// 相手タブ (target_hunt.js) のボタン
import { requestSearch } from '../../state.js';
import { goToTab } from '../shell.js';
requestSearch({ from: 'target' });     // state.search.autoStart = {id, from: 'target', at} を置き、useTarget を true に
goToTab('search', { top: true });      // 探すタブへ

// 探すタブ (search.js): 開いたとき・印が置かれたときに 1 回だけ受け取って探し始める
const req = useAppState((s) => s.search.autoStart);
useEffect(() => {
  if (!req || !ready) return;          // ready = core と相手のデータが読めている
  if (takeSearchRequest(req.id)) start();  // 受け取ると印は消える (2 回目は null)。探索の条件はその時の state から作る
}, [req, ready]);
```

- 印は保存されるが、`sanitizeState` が戻さない (開き直しや全データの読み込みで勝手に探し始めない)。
- 探すタブがまだ一度も開かれていなくても、開いたときに印を見て始める (タブは開いたときに読み込まれるため)。
- 状態の形を変える (項目を足す) ときは `defaultState()` と `sanitizeState()` の両方に足す。消す・意味を変えるときは `STATE_SCHEMA` を上げて
  古い保存データを読み替える処理を `sanitizeState` に書く (古いデータで画面が壊れないように)。担当外なら報告に書く。

## data.js (データ)

```js
import { useData, useTargetData, getCoreData, loadTargetData, DATA_FILES } from '../../data.js';

const core = useData();          // {status: 'loading'|'ready'|'error', data, error, retry}
const t = useTargetData();       // 相手タブのデータ。初めて呼ばれたときに読み始める ({load: false} なら読み始めない)
if (t.status === 'loading') return html`<${Loading} />`;
if (t.status === 'error') return html`<${ErrorBox} error=${t.error} onRetry=${t.retry} />`;
```

タブの `data` prop は `useData().data` と同じもの (読み込み済み)。

### core (起動時に読む)

| プロパティ | 中身 |
|---|---|
| `skills` `armor` `weapons` `decorations` `bonuses` `charmsFixed` `talismanRules` `charms` `myWeapons` `skillEffects` `motions` `combos` | 各ファイルの**中身丸ごと** (`{meta, …}`)。計算の関数はファイル丸ごとを受けるのでそのまま渡す。`weapons` = weapons_sns.json、`skillEffects` = skill_effects.json、`motions` = motions_sns.json、`combos` = combos_sns.json |
| `lists` | 配列の近道: `lists.skills` `lists.armor` `lists.weapons` `lists.decorations` `lists.charms` `lists.charmsFixed` `lists.myWeapons` `lists.combos` `lists.moves` |
| `index` | `indexEquipData(...)` の結果 (id → 要素 の Map)。`index.skills.get(id)`、`index.armor.get(id)`、`index.weapons.get(id)`、`index.myWeapons.get('w0001')` など。`computeBuild(build, data.index)` にそのまま渡す |
| `meta` | `{skills: {...}, armor: {...}, …}` 各ファイルの meta (charms.json / my_weapons.json は `{schema}`) |

`index` は data/ のファイルだけで作っている。端末で足した護石なども計算に使うなら、`indexEquipData({...生データ, charms: 合わせた配列})` を作り直す。

### target (相手タブを開いたときに読む)

| プロパティ | 中身 |
|---|---|
| `monsters` `quests` `threats` | monsters.json / quests.json / monster_threats.json の中身丸ごと |
| `lists` | `lists.monsters` `lists.quests` `lists.threats` (monster_threats の `monsters`) |
| `index` | `index.monsters.get(id)`、`index.quests.get(id)` |
| `meta` | 各ファイルの meta |

shell.js は相手タブを開いた時点で `loadTargetData()` を呼ぶ。ほかのタブで先に要るなら `useTargetData()` を呼べば読み始める。

- `getCoreData()` / `getTargetData()`: 読み終わっていればデータ、まだなら null (hook を使えない所用)。
- `DATA_FILES`: 読むファイルの一覧 `[{key, file, group: 'core'|'target', label}]` (設定タブの表示に使う。画面には label を出す)。
- 読めなかったときの `error` は `DataLoadError` (`message` = 画面用の日本語・`kind` = `'network'|'timeout'|'http'|'broken'`・
  `isNetwork`・`detail` = ファイル名と HTTP の番号)。shell.js は通信の失敗なら「電波の良い所でもう一度」、
  ファイルが無い・壊れている (更新の失敗の疑い) なら「再読み込み」を出し、`detail` は「くわしく」の中に出す。

## store.js (端末に保存)

```js
import { kvGet, kvSet, kvDelete, kvKeys } from '../../store.js';
await kvSet('mhwilds-sns:charms-local', list);   // キーは必ず "mhwilds-sns:" で始める (違うと例外)
const list = (await kvGet('mhwilds-sns:charms-local')) ?? [];
```

- DB 名 `mhwilds-sns:db`、ストア `kv`。値は構造化複製できるもの (JSON にできる値なら安全)。失敗しても投げない (メモリに置く)。
- 接続が切れていた (iPhone で長く裏に回すと Safari が切ることがある) ときは、開き直して 1 回だけやり直す。`db.onclose` でも開き直す。
- 書き出さない「この端末だけの記録」: `mhwilds-sns:persist-asked`・`mhwilds-sns:hint-home-screen`・`mhwilds-sns:search-timing`
  (読み込み・初期化でも扱いは同じ)。
- 探すタブの記録 (段階 2・3。`docs/RECOMMEND_DESIGN.md` 5.7 節):
  - `loadSearchLast()` → `{savedAt, appVersion, inputKey, summary, result}` か null / `saveSearchLast({inputKey, summary, result, appVersion})` /
    `clearSearchLast()`。キーは `SEARCH_LAST_KEY` (`mhwilds-sns:search-last`。書き出しに入る)。結果の build は使う前に `sanitizeBuild` を通す。
  - `loadSearchTiming()` → 配列 (古い → 新しい・最大 `SEARCH_TIMING_MAX` = 20 回) / `appendSearchTiming(entry)` (`at` が無ければ足す。
    古いものから消す) / `clearSearchTiming()`。キーは `SEARCH_TIMING_KEY` (`mhwilds-sns:search-timing`。この端末だけ)。
- `copyText(text)` の text は文字列か Promise (作るのに時間がかかる文字は Promise のまま渡す。iPhone の Safari はタップの処理の中で
  すぐ書き込まないと断るため、`ClipboardItem` に Promise を渡す形で書く)。
- 装備・相手・発動率などは state.js が保存するので、タブが直接保存するのは state に載らない大きめのもの (端末で足した護石など) だけ。
- 「全データの書き出し」は保存してある `mhwilds-sns:` の全キーを 1 つのテキストにする (設定タブ)。タブが足したキーも自動で入る。
  形: `{"kind": "mhwilds-sns-backup", "format": 1, "exportedAt": "...", "appVersion": "...", "entries": {"mhwilds-sns:state": {...}}}`
- 関数: `kvGet` `kvSet` `kvDelete` `kvKeys` `kvGetAll` `kvClear` / `requestPersist({force})` (初回だけ navigator.storage.persist) /
  `storageInfo()` / `exportAllText()` `parseBackupText(text)` `importBackup(backup, {replace})` / `saveTextFile(text, name)` (iPhone は共有シート) /
  `copyText(text)` / `readFileText(file)` / `backupFileName()`。

## 共通部品 (app/ui/components/)

まとめて `import { … } from '../components/index.js'`。`html` は htm を Preact に結びつけたもの。

```js
import { html, Card, Button, Row, Hint, KeyValue, Badge, Notice, Loading, ErrorBox, Placeholder, Empty,
         NumberInput, Slider, Toggle, Segmented, Select, TextInput, BottomSheet, Picker, PickerField,
         toast, PART_LABEL, ELEMENT_LABEL, SHARPNESS_LABEL, formatNumber, formatPct, formatRatio } from '../components/index.js';
```

### 一覧から 1 つ選ぶ (下からのシート)

```js
// いちばんよく使う形: 行をタップするとシートが開く
<${PickerField} label="頭" title="頭の防具を選ぶ" items=${items} value=${build.armor.head}
  onChange=${(v, item) => setArmor('head', v)} allowNone noneLabel="なし (外す)" placeholder="選んでいません" />

// items の形
{ value: 670,                 // onChange に渡る値 (数でも文字でもよい)
  label: 'ゴグマヘルムα',      // 表示名 (検索の対象)
  sub: 'スロット ③①− ・攻撃 Lv1',  // 2 行目 (検索の対象)
  group: 'レア 8',            // 見出し (同じ group が続く所にまとめて 1 つ。並び順は items のまま)
  keywords: 'ごぐま gogma',   // 表示しないが検索に使う
  badge: html`<${Badge} kind="unconfirmed" />`,  // 右端
  disabled: false }
```

- 検索は全角/半角・カタカナ/ひらがな・ローマ数字 (Ⅲ → 3) の違いを吸収する。空白で区切ると全部を含むもの。
- 150 件より多いと「さらに表示」で足す (`maxItems` で変えられる)。
- 検索欄はシートを**閉じたとき**に空に戻す (開いた直後に空にすると、開いてすぐ打った文字が消えるため)。
- シートは 閉じるボタン・背景のタップ・Esc・上の帯 (つかみと見出し) を下へスワイプ・ブラウザの「戻る」で閉じる
  (開くと `history.pushState` で 1 つ積み、`popstate` で閉じる。ボタンで閉じたら積んだ分を戻す)。
  キーボードが出ている間は `visualViewport` を見て、シートをキーボードの上に持ち上げる (CSS 変数 `--kb` / `--vvh`)。
- シートだけ使うなら `<${Picker} open=${open} onClose=${…} onSelect=${(v) => …} … />`、中身を自由に置くなら `<${BottomSheet} open title onClose footer>…</…>`。

### 入力

```js
<${NumberInput} label="会心率" value=${v} onChange=${set} min=${-100} max=${100} step=${1} unit="%" />
//  打っている途中でも範囲内なら onChange。離れたら範囲に丸める。全角数字・カンマも読む。
//  min が負なら ± ボタン (iPhone の数字キーにマイナスが無い)。allowEmpty で空欄 (null) を許す。stepper=${false} で −/＋ を消す
<${Slider} label="怒っている割合" value=${0.7} onChange=${(x) => setUptime('enraged', x)} min=${0} max=${1} step=${0.05} percent />
//  動かしている間はつまみと数字だけ変え、onChange は指を離したとき (change) か止めて 0.15 秒後 (commitDelay) に呼ぶ
<${Toggle} label="限界突破" checked=${on} onChange=${set} hint="スロットが増える防具があります" />
<${Segmented} label="斬れ味" value=${color} onChange=${setSharpness}
  options=${[{ value: null, label: '自動' }, ...SHARPNESS_ORDER.map((c) => ({ value: c, label: SHARPNESS_LABEL[c] }))]} />
<${Select} label="コンボ" value=${id} onChange=${setCombo} options=${combos.map((c) => ({ value: c.id, label: c.name }))} />
<${TextInput} label="セットの名前" value=${name} onChange=${setName} />
//  onChange は欄から離れたとき・Enter のとき。iPhone の Safari はボタンを押しても欄から離れないことがあるので、
//  「入れてすぐボタンを押す」所では onInput=${setName} も渡す (打つたびに呼ばれる)
```

### まとまり・表示

```js
<${Card} title="発動スキル" sub="Lv の高い順" actions=${html`<${Button} small>並び替え</${Button}>`}>…</${Card}>
<${Card} title="防具" flush>${rows}</${Card}>        // flush = 中の余白なし (Row を並べるとき)
<${Row} label="頭" value="アルシュヘルムβ" sub="攻撃 Lv1" onClick=${open} end=${html`<${Badge} kind="error" />`} />
<${KeyValue} rows=${[['攻撃力', '190'], ['会心率', '5%']]} />
<${Button} variant="primary|secondary|danger|ghost" block small onClick=${…}>…</${Button}>
<${Hint}>小さい説明の文</${Hint}>
<${Badge} kind="unconfirmed|unsupported|error|warn|info|ok" />          // 「未確定」「未対応」「エラー」など
<${Notice} kind="unsupported" title="計算に入れていないスキル" actions=${…}>…</${Notice}>
<${Loading} text="計算中…" />   <${ErrorBox} error=${e} onRetry=${retry} />   <${Empty}>まだありません</${Empty}>
toast('マイセットに保存しました');  toast('保存できませんでした', { kind: 'error' });
toast('武器の装飾品 1 個 (…) は入らないので外しました', { action: { label: '元に戻す', onClick: undo } });  // ボタン付き (6 秒)
<${Notice} kind="warn" badge="仮" title="…">   // 印の文言を変える
<${ErrorBox} error=${e} onRetry=${reloadPage} retryLabel="再読み込み" detail="armor.json: HTTP 404" />  // detail は「くわしく」の中
<details class="more"><summary>くわしく</summary>…</details>  // 技術的な中身を畳む (summary は 44px)
```

### 名前と数の書き方 (labels.js)

`PART_LABEL` (頭・胴・腕・腰・脚)、`DECO_TARGET_LABEL`、`ELEMENT_LABEL` (火・水… と 切断・打撃)、`SHARPNESS_LABEL` (赤〜紫)、
`SKILL_KIND_LABEL`、`DECO_KIND_LABEL`、`TAB_LABEL`。
`formatNumber(n, 桁)` (3 桁区切り)、`formatRatio(0.5)` → `50%`、`formatPct(12.3)` → `+12.3%`、`formatDateTime(iso)`、`formatBytes(n)`、
`formatSlots([3,1,0])` → `③①−`。

### 使える class (styles.css)

`.stack` (縦に 12px 間隔で並べる)、`details.more` (くわしく)、`.app-hint` (帯のお知らせ)、`.card`、`.btn` / `.btn-row` / `.btn-col`、`.hint`、`.text-danger`、`.badge-*`、`.notice-*`、
`.row`、`.kv`、斬れ味の色 `<span class="sharp-chip sharp-white"></span>` (変数 `--sharp-red` 〜 `--sharp-purple`)。
色は必ず変数 (`var(--accent)` `var(--text-sub)` `var(--danger)` `var(--unconfirmed)` など) を使う (ダーク表示で自動で変わる)。
新しい class が要るときは styles.css (担当: ui-shell) に足すか、報告に書く。

## タブのあいだで使うもの (各タブの担当が足したもの)

装備・火力・相手の 3 つのタブは**同じ装備・同じ相手で計算する**ために、次のモジュールを共有している。
名前や引数を変えるときは、使っている全部のタブとスモークテストを直す。

| ファイル | 中身 (主なもの) | 使っている所 |
|---|---|---|
| `tabs/equip_logic.js` (純粋関数) | (武器の解決・斬れ味の 9 関数の本体は `app/model/weapon.js`。ここから再 export) `resolveWeaponRef(ref, idx)` (所持武器は元の武器で補う) / `damageWeapon(w)` / `autoSharpness(w, idx, skillLevels)` (斬れ味の自動 = 匠込みの一番上の色) / `sharpnessResolver(w, idx, fixedColor)` (スキルの組ごとに斬れ味の色を決め直す関数。power_calc の `perSkills`) / `handicraftInfo(idx)` / `weaponName(w)` / `DEFAULT_TARGET` と `DEFAULT_HITZONE_TEXT` (相手が決まらないときの肉質: 切断・打撃 45、属性 20) / `pickDamageTarget` / `summarizePower({…, target, targets?, perSkills?, monsterStatus?})` (targets を渡すと部位の割合で平均) / `refitDecorations(ids, sizes, kind, idx)` (装備を替えたとき入る珠を残す) ほか一覧づくり | 装備・火力・相手 |
| `tabs/equip_index.js` (hook) | `useEquipIndex(data, {active})` → `{idx, localWeapons, localCharms}`。画面で足した武器・護石も入った索引 (`computeBuild` にそのまま渡す) | 装備・火力・相手 |
| `tabs/power_calc.js` (純粋関数) | `mixExpected(input, targets)` / `mixTotal` / `mixContribution` (狙う部位の割合で加重平均した comboExpected・スキルなし比・外したときの低下) / スキル火力表 (`skillTableCandidates(effects, weapon, {handicraft})` `tableContext` `skillTableRow` (行の `conflict` = 同時に起きない条件の合計が 100% 超え) `skillTable` `sortTableRows`) / `conditionSummary(effects, uptimes, groupId, {entry, skillIds, monsterStatus})` (スキルが効く段だけ・段ごと) / `effectiveStates` / `exclusiveConflict` / `inputFor` / `rebalanceCategorical`。input に `perSkills` (斬れ味の自動) と `handicraft` (匠の行) を足せる | 火力・装備 (summarizePower 経由) |
| `tabs/target_mix.js` (純粋関数) | `resolveTargetMix(state.target, state.tabs.target, targetData)` → `{targets: [{weight, label, partKey, target}], label, mixed}` か null / `partLabel(part, monster)` (部位不明は「部位不明 1」) / `readMix` `mixShares` `mainPartKey` `setShare` `addShare` `removeShare` (割合のつまみ) / `visibleParts` `defaultPartKey` `isWeakPart` `weakInfo` (剣・盾・傷口のどれに弱点特効が効くか) `manualTarget` / `recommendationView` (おすすめ属性の見せ方。近い・低いときは 1 つを大きく出さない) / `monsterStatusOf` (相手が使う状態異常) / `threatInfo` (咆哮などと防ぐスキル) | 相手・火力・装備 |
| `tabs/charms.js` | 「この端末で足した護石」の入れ物: `LOCAL_CHARMS_KEY` (`mhwilds-sns:charms-local`) / `loadLocalCharms` `refreshLocalCharms` `getLocalCharms` `subscribeLocalCharms` `useLocalCharms` `addLocalCharms` `updateLocalCharm` `deleteLocalCharms` / `mergeCharms` `charmsIndex` `useCharmsIndex` `charmPickerItems` / 純粋関数 `rarityChoices` `slotChoices` `skillChoices` `pickStatus` `checkCharm` `nakiSimExport` `claudeExportText` `parseImportText` | 護石・装備 (equip_index.js が読む) |

`targets` の形は `[{weight, label?, partKey?, target: {hitzone, wound, isWound}}]` (weight は足して 1 でなくてよい)。
部位が 1 つなら `damage.js` の `comboExpected` を直接呼ぶのと同じ値になる。

### タブごとの画面状態 (`state.tabs`。`setTabState` で変える)

| キー | 形 | 中身 |
|---|---|---|
| `tabs.equip` | `{myWeapons: [...], armorRank: 'all'\|'high'\|'low', armorRarity: 'all'\|数}` | `myWeapons` = 画面で足したアーティア武器 (my_weapons.json と同じ形。id は `"wl…"`)。`build.weapon` がこの id を指せる |
| `tabs.target` | `{mix: {on, monsterId, weights: {部位 key: 0〜1}}, showUnknown, sort: 'body'\|'slash', elem}` | 部位を割合で混ぜる指定 (`state.target.partKey` には一番割合の大きい部位が入る。画面は weights を足して 1 の割合で書く。つまみの値 = その部位の割合)・部位不明を出すか・並べ方・属性の列 |
| `tabs.power` | `{showSteps, tableOpen, tableSort: 'next'\|'max'\|'name'}` | 技ごとの内訳・スキル火力表を開くか・並べ方 |

これらは `state.js` の正式な項目ではない (`sanitizeState` は `tabs` を JSON のまま残す)。中身の検査は読む側 (`sanitizeLocalWeapons`・`readMix` など) でしている。

### このタブだけの見た目

`equip.js` は `<style>` を部品の中に、`power.js` / `target.js` は `<style id="mhwilds-sns-power-style">` などを head に足して持つ
(class は `eq-*` / `pw-*` / `tg-*`。色は :root の変数だけ)。styles.css に移すときは class 名を変えないこと (スモークテストが使う)。
段階 2・3 の画面は別のファイル: 探すタブは `app/ui/styles_search.css` (class は `sr-*`)、相手タブの新しいカード (`target_hunt.js`) は
`app/ui/styles_target.css` (class は `th-*`)。どちらも index.html が styles.css の後に読む。スモークテストの `:hover`・`vh` の検査は
`app/ui/*.css` を全部見る。

## 探すタブ (段階 2・3。担当: ui-search)

持っている護石で火力の高い装備を探し、相手に合わせたおすすめ (守りのスキル・武器の属性) も使う画面 (`docs/RECOMMEND_DESIGN.md` 4.3〜4.6 節)。
いまは「準備中」のカードだけ。

## 相手タブの段階 3 のカード (担当: ui-target)

個体・クエスト・人数・体力と強さ・この相手のおすすめ・このクエストの相手・歴戦王で変わること (`docs/RECOMMEND_DESIGN.md` 4.2 節。
`tabs/target_hunt.js`)。いまは置き場だけ。

## sw.js (オフラインと更新)

- `PRECACHE` のファイルを版つきのキャッシュ `mhwilds-sns:app-<VERSION>` に入れ、電波が無くても開けるようにする。
  `/mhwilds-sns/` の下だけを受け持ち、消すのも `mhwilds-sns:app-` で始まる古いキャッシュだけ (同じ github.io の別サイトには触らない)。
- **公開する前に `PYTHONIOENCODING=utf-8 python tools/sw_version.py` で `VERSION` を作り直す** (`<日付>-<PRECACHE の中身のハッシュ>`)。
  上げないと、ホーム画面のアプリは古いまま (キャッシュから出す)。
  上げると次に開いたとき (または前面に戻ったとき) 新しい版を裏で取り、画面の下に「新しい版があります → 再読み込み」の帯が出る。
  スモークテストは、`VERSION` のハッシュがファイルの中身と合っていないと失敗にする。
- install は PRECACHE が**全部**取れたときだけ成功させる (1 つでも取れなければ今の版のまま。次に開いたときブラウザが取り直す)。
  キャッシュに無いファイルを後から取るときも HTTP キャッシュを通さず確かめる (`cache: 'no-cache'`)。
- 画面を開く要求 (navigate) は、アプリの入口 (`/mhwilds-sns/` と `index.html`) だけキャッシュの index.html を返す。
  ライセンスの文書・CC BY-SA のデータなど、ほかのファイルを開いたときはそのファイルを返す。
- ファイルを足したら `PRECACHE` に足す (スモークテストが抜けを失敗にする)。

## スモークテスト (tests/smoke_ui.py)

```
PYTHONIOENCODING=utf-8 python tests/smoke_ui.py               # webkit の iPhone 13 (無ければ入れる。だめなら chromium で代用)
PYTHONIOENCODING=utf-8 python tests/smoke_ui.py --browser chromium --only equip,power --no-sw
```

- `/mhwilds-sns/` の下でこのリポを配信して開き、全タブを幅 390px (ライト) と 375px (ダーク) で確かめる:
  コンソールのエラー・404・`/mhwilds-sns/` の外へのリクエスト・横のはみ出し・44px 未満のタップ領域・相手のデータの遅延読み込み・
  共通部品の動作・状態の保存と復元・計算モデルへの受け渡し・電波なしで開けるか・更新の帯・データが読めないときの表示とやり直し。
- スクリーンショットは `tests/artifacts/` (git 管理外)。名前は `<端末>-<名前>.png` (`iphone13-light-…` = ライト、`w375-dark-…` = ダーク)。
  タブを開いただけの画像は `…-equip.png` など、通しの操作で装備を組んだ後の画像は `…-walk-equip.png` など。
- **通しの操作** (`walkthrough_full_build`): 画面だけを触って 武器 (破滅のキリエヴェルド 属性激化 に 火 440) → 防具 5 部位 (2 部位は限界突破) →
  痛撃の護石Ⅲ → 装飾品 → 相手 (アルシュベルドの頭) → 火力タブ → 護石タブ (c0001 が OK・泣シミュ形式) → 再読み込み → 電波なしで再読み込み。
  画面に出たスキル一覧と期待値は `tests/calc_from_state.mjs` (計算モデル `app/model/` だけで同じ状態を計算する node のスクリプト) の結果と比べる。
  データ (防具・装飾品の名前) が変わったら smoke_ui.py の `WALK_*` を直す。
- 確認を足すときは `@tab_check('equip')` を付けた関数 `(page, ctx)` を足す。問題は `ctx.fail('説明')`、画像は `ctx.shot('名前')`。
  タブに依らない流れは `@scenario_check`。タブの中の目印は `[data-tab-panel="equip"]` (タブの中身は `[data-tab-ready="1"]` の下)。
  読み込み中は `.loading` を出しておけば、テストは消えるまで待つ。
