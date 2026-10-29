# 計算モデルの使い方 (app/model/)

各担当が自分の節を追記する。

## build.js

装備一式から、スキル合計・シリーズ/グループスキルの発動・スロットの使用状況を返す純粋関数 (担当: equip)。
DOM にも node 専用モジュールにも触らない。データの形は `docs/ARCHITECTURE.md` の契約どおり。

```js
import { computeBuild, indexEquipData, decorationFitError, targetKind,
         ARMOR_PARTS, DECO_TARGETS } from './app/model/build.js';

// data/*.json は fetch / fs で読んだ中身をそのまま渡す (ファイル丸ごとでも配列でもよい)
const data = indexEquipData({
  skills, decorations, bonuses,            // 必須: skills.json / decorations.json / bonuses.json
  armor, weapons, myWeapons,               // id で指定するなら: armor.json / weapons_sns.json / my_weapons.json
  charms, charmsFixed,                     // id で指定するなら: charms.json / charms_fixed.json
});                                        // 何度も計算するなら索引を作って使い回す (computeBuild に生データを渡してもよい)

const r = computeBuild({
  weapon: 1182,                            // 数値 = weapons_sns の id / 文字列 = my_weapons の id / 要素そのもの / null
  armor: { head: 670, chest: 671, arms: null, waist: 673, legs: 674 },  // armor.json の id か要素
  charm: 'c0001',                          // 文字列 = charms.json の id / 数値 = charms_fixed の id / 要素 / null
  decorations: {                           // 配列の i 番目 = その装備の i 番目のスロット。空きは null
    weapon: [101, null, 100],
    head: [102],
    charmArmor: [102],                     // 護石の防具用スロット
    charmWeapon: [],                       // 護石の武器用スロット
  },
  limitBreak: true,                        // 防具の限界突破。true/false (全部位) か { head: true, legs: false, ... }。省略 = しない
}, data);
```

返り値:

| 項目 | 中身 |
|---|---|
| `ok` | `errors` が空なら true |
| `errors` | `[{code, message, target?, index?, decorationId?}]`。入れられない装飾品はスキルに数えない |
| `warnings` | `[{code, message, target?}]` (`unknown-skill` / `unknown-set-bonus` / `unknown-group-bonus` / `limit-break-unknown` / `unknown-base-weapon`)。計算は続ける |
| `skills` | `[{skillId, name, kind, level, rawLevel, maxLevel, overLimit, sources}]`。`level` は上限 Lv で切った値、`rawLevel` は切る前の合計。シリーズ/グループの発動分も入る。Lv の高い順 |
| `skillLevels` | `{skillId: level}` (切った後)。damage.js に渡す用 |
| `setBonuses` | `[{bonusId, name, skillId, pieces, from, level, active, ranks, next}]`。`next` は次の段階 `{pieces, level}` か null |
| `groupBonuses` | `[{bonusId, name, skillId, pieces, from, required, active, level}]` |
| `slots` | `{weapon: [{index, size, decorationId, decorationName?, decorationSize?}], head: [...], ..., charmArmor, charmWeapon}` |
| `slotSummary` | `{weapon: {total, used, free, freeBySize: {1,2,3}}, armor: {...}}`。武器用 = 武器 + 護石の武器用、防具用 = 防具5部位 + 護石の防具用 |
| `limitBreak` | `{head: bool, chest, arms, waist, legs}`。限界突破後のスロット (`slotsLimitBreak`) を実際に使った部位が true |

決まりごと:

- 武器用の装飾品は武器スロットと護石の武器用スロットだけ、防具用は防具スロットと護石の防具用スロットだけに入る。低 Lv の珠は高 Lv のスロットに入る。
- エラーのコード: `deco-too-large` (珠の Lv > スロット Lv) / `deco-kind-mismatch` (武器用↔防具用) / `slot-missing` (そのスロットが無い・Lv0) / `no-equipment` (装備が無い所に珠) / `armor-part-mismatch` (頭に胴防具など) / `unknown-weapon` / `unknown-armor` / `unknown-charm` / `unknown-decoration` / `unknown-target`。
- シリーズスキルは部位数で段階を決める (`ranks` の `pieces` 以上で `level`)。グループスキルは `pieces` (3) 以上で発動。
- 防具・武器のシリーズスキルは `setBonusIds` (配列) と `setBonusId` を**合わせて**、重複と null を除いて数える
  (ゴグα/β は 巨戟龍の黙示録 + 部位ごとのシリーズスキルの 2 つ。`setBonusIds` が空配列で `setBonusId` だけある部位も数える)。
- 武器の `setBonusId` / `groupBonusId` (巨戟アーティアで付けたもの。my_weapons.json) は **1 部位** として数える。
- my_weapons の要素で `slots` / `skills` が無いものは `baseWeaponId` の武器 (weapons_sns) から補う。
  id (文字列) で渡しても、要素 (object) をそのまま渡しても同じ。元の武器が見つからなければ警告 `unknown-base-weapon` (スロット無し・スキル無し)。
- 限界突破 (`limitBreak`): 真の部位で armor.json の `slotsLimitBreak` (限界突破後のスロット、長さ 3) が配列ならそれを使う。
  `slotsLimitBreak` が null (対象外・不明) か項目が無い (古いデータ) なら通常の `slots` のままにして、警告 `limit-break-unknown`。
  装備していない部位は警告しない。
- 固定護石 (`armorSlots` も `weaponSlots` も無い要素) はスロット無しとして扱う。
- `decorationFitError(deco, kind, slotSize)` は UI で「このスロットに入る珠」を絞るのに使える (入るなら null)。`targetKind(target)` は入れ先 → `'weapon'|'armor'`。

## charms.js

護石の検証と泣シミュ形式の書き出し/読み込み (担当: equip)。

```js
import { validateCharm, possibleRarities, toNakiSimRow, toNakiSimText, parseNakiSimRow,
         parseNakiSimText, findSkillByName, fixedCharmOf, charmKind, nextCharmId } from './app/model/charms.js';

const r = validateCharm(charm, talismanRules, skills, { charmsFixed });
// → { ok, kind: 'random'|'fixed', errors: [{code, message, skillIndex?}], warnings: [...], matches: [...] }
```

- 鑑定護石 (未解/史伝/秘歴/栄世の護石 = レア5〜8) は `data/talisman_rules.json` の抽選表の 1 行 (`patterns`) に当てはまるかを見る。スキルの並び順は問わない。スキルの数は行の枠数と同じでなければならない。Lv は表の Lv を上限として扱い、表より低いと警告 `not-exact`。
- エラーのコード: `rarity-unknown` / `name-rarity-mismatch` / `slot-invalid` / `slots-not-possible` / `skill-unknown` / `level-invalid` / `skill-kind-invalid` (シリーズ/グループスキル) / `level-over-max` (スキルの最大 Lv 超え) / `skill-not-in-pool` / `level-over-pool-max` (そのレア度で出る Lv 超え) / `too-many-skills` / `too-few-skills` / `skill-kind-position` (武器スキル/防具スキルの数が枠と合わない) / `slots-skill-combination` (別のスロット構成でしか出ない組み合わせ) / `combination-not-in-table`。
- 警告のコード: `not-exact` / `duplicate-skill` / `name-unknown` / `skill-name-mismatch`。
- 固定護石 (`charm.fixedId` があるか、名前が charms_fixed.json にあるもの) は `kind: 'fixed'` で、スキル・レア度が charms_fixed と同じか、スロットが無いかだけを見る (`fixed-*` のコード)。
- 泣シミュ (mhwilds.wiki-db.com/sim) の 1 行は 12 項目 `スキル1,Lv1,スキル2,Lv2,スキル3,Lv3,防具スロLv×3,武器スロLv×3`。空きスキルは名前が空で Lv 0 (泣シミュ自身の書き出しと同じ)。
  - `toNakiSimRow(charm, skills)` → `'ガード性能,3,属性吸収,1,,0,2,0,0,0,0,0'`。`toNakiSimText(charms, skills, {charmsFixed})` は複数行 (固定護石は除く)。
  - `parseNakiSimRow(row, skills, {rarity, name, source, addedAt, rules})` → `{charm, errors, warnings, possibleRarities?}`。泣シミュの行にはレア度が無いので、`rules` を渡すと当てはまるレア度の候補を返す。スキル名は全角/半角の揺れを吸収する (`KO術` → `ＫＯ術`)。
- `nextCharmId(charms)` は charms.json の次の id (`c0002` など)。

## damage.js

`app/model/damage.js` — 片手剣のダメージ期待値 (純粋関数、ブラウザでも node でも動く)。
出典と未確定事項は `docs/sources/damage.md`。**秒あたり DPS は出さない** (技のつなぎの秒数は公開データに無く見積もり。
灼熱化の判定の間隔を数えるのにだけ使う。2026-10-24)。

### 入力

| 引数 | 形 | 元データ |
|---|---|---|
| `weapon` | `{attack, affinity, element: {type, value} \| null}`。`attack` は係数なし、`element.value` は表示値 | `weapons_sns.json` / `my_weapons.json` の 1 件をそのまま渡せる |
| `sharpness` | `'red'`〜`'purple'` (今の斬れ味の色) | |
| `skills` | `[{skillId, level}]` か `{skillId: level}` | `build.js` の `computeBuild(...).skills` / `.skillLevels` をそのまま渡せる |
| `uptimes` | `{条件グループ id: 発動率}` (省略したものは既定値)。下の「条件つきスキルの発動率」 | 人が画面で入れる |
| `effects` | `data/skill_effects.json` 丸ごと | |
| `motions` | `data/motions_sns.json` 丸ごと | |
| `combo` | `data/combos_sns.json` の `combos[]` の 1 件、または技 id の配列 (`['slash_1', 'slash_2']`) | |
| `target` | `{hitzone: {slash, blunt, fire, water, thunder, ice, dragon}, wound: {…} \| null, isWound?: bool}` | `monsters.json` の `parts[].hitzone` / `parts[].wound` (0〜100。傷口の無い部位は null) |
| `buffs` | `{attackAdd, attackMul, affinityAdd, elementAdd, elementMul}` (省略可) | アイテムなど人が足す分 |
| `monsterStatus` | 相手が使う状態異常のキーの配列 (`['frenzy', 'poison']`)。省略 = 分からない | 画面は `target_mix.js` の `monsterStatusOf` (手入力・既定の肉質なら `[]`) |
| `sharpnessUse` | `{gauge (匠込みの目盛り [赤…白(紫)]), intervalSec}` (省略可。2026-10-29) | 研ぐまでの色の割合で斬れ味補正を混ぜる (この部位 1 つで数える)。`weapon.js` の `sharpnessUseOf` / `sharpnessResolver(…, {intervalSec})` |
| `sharpnessShares` | 色の割合 (`SHARPNESS_ORDER` の並び。省略可) | 部位をまとめて `sharpnessPlan` で出したもの。`sharpnessUse` より先に使う (部位の割合で平均するときはこちら) |

### 条件つきスキルの発動率 (条件ごと)

発動率は**スキルごとではなく条件ごと**に持つ。条件の一覧は `skill_effects.json` の `rules.conditionGroups`
(並びは画面に出す順)。同じ意味の条件で動くスキルは 1 つのグループにまとまっていて、1 つの発動率が全部に効く
(例: `enraged` = モンスターが怒っている → 挑戦者・巨戟龍の黙示録)。スキルの `skills[].uptime` は使わない。

| グループの種類 | `uptimes` に入れる値 | 例 |
|---|---|---|
| `binary` (発動している / していない) | 0〜1 の数 (true/false も可) | `{ enraged: 0.7, hpFull: 0.3 }` |
| `categorical` (段階がある) | `{段 id: 割合}`。渡さない段は 0、残りが「未発動」の段 (`offState`)。合計が 1 を超えたら縮める (警告)。数だけを保存する入れ物向けに平らなキー `"<グループ id>.<段 id>"` でもよい (入れ子の形があればそちら優先) | `{ chain: { hit1to4: 0.2, hit5plus: 0.7 } }` か `{ 'chain.hit1to4': 0.2, 'chain.hit5plus': 0.7 }` |

- 既定値は各グループの `defaultUptime`。`placeholder: true` のものは根拠の無い**仮置き** (`uptimeBasis` にそう書いてある)。
  `placeholder: false` は根拠のある既定値 (`beforeGuts`・`festival`) と**本人の前提** (`enraged` 1.0・`chain` 5 ヒット以降段 1.0・
  `staminaFull` 1.0。2026-10-22 本人の決定「基本発動する前提で」。`uptimeBasis` は「本人の前提 (2026-10-22): …」)。
  計算での扱いは根拠のある既定値と同じ (同時に起きない条件で保つ順も、探すタブの `'zero'` で 0% にしないのも)。
- `exclusiveWith` の組は同時に起きない条件 (体力満タン `hpFull` と 赤ゲージあり `redHp`・体力 35% 以下 `hpLow`)。
  全パターンの加重平均で「両方発動」に重みを付けず、それぞれの発動率は入れた値のまま保つ。
  合計が 100% を超えて保てないときは、**本人が入れた条件 → 根拠のある既定値 → 仮置き** の順に保ち、後の方 (仮置きなど) を
  減らして警告 `exclusive-conflict` (`groupId` = 減らした条件)。同じ扱いどうしは並びの後の条件を減らす。
- `sources` のある条件 (2026-10 時点では狂竜症 `frenzy`: `{skillIds: [黒蝕竜の力], monsterStatus: ['frenzy'], label, inactiveText}`) は、
  そのスキルを装備しておらず、`input.monsterStatus` にその状態異常も無いときは「発動していない」100% にする
  (入れた発動率は使わない)。`monsterStatus` を渡さない (分からない) ときは決めつけない。
  そのときの `conditions[]` の要素は `inactive: true`・`inactiveReason` (画面に出せる日本語)・`placeholder: false`。
  判定は `conditionSourceMissing(def, skillIdSet, monsterStatus)`。
- 関係の無い条件どうしは独立と仮定する。組み合わせ (パターン) が `MAX_PATTERNS` (16384) を超えたら、`comboExpected` は全部を並べずに
  **因子分解の合計**を返す (2026-10-21・`docs/SEARCH_DESIGN.md` 4 章の 2): 同時に起きない条件 (`exclusiveWith`) でつながる塊ごとに
  パターンを数え上げ (`factorPatterns`)、攻撃・属性の乗算と加算は期待値で、会心率など線形でない値は同じものをまとめて畳み込む
  (攻撃・属性の上限に当たりうるときはその値もまとめない)。独立の仮定は同じなので値は全パターンの加重平均と同じ (相対 1e-9 未満。
  足し順と、重みが 1e-12 以下のパターンの扱いだけ違う)。このときの結果は `factored: true`・`steps` は空 (技ごとの内訳は出さない)・
  警告 `many-patterns` (`count` = パターンの数)。火力タブは合計と警告を出し、「技ごとの内訳」には出していない旨を出す。
  まとめても状態が 2^18 を超えるときだけ例外 (「条件の組み合わせが多すぎる」)。`MAX_PATTERNS` 以下のときは今までと同じ道 (同じ値)。
- スキルの効果: `levels[]` の値は `activeStates` の段で出る主効果。`levels[].byState` に段ごとの効果があればその段ではそちら
  (連撃の 1〜4 ヒット段、黒蝕竜の力の感染中)。それ以外の段では効果なし。
- `conditionGroup` の無い条件つきスキル (古いデータ・テスト用) は、そのスキルだけのグループ `skill:<skillId>` になる
  (既定はスキルの `defaultUptime`)。知らない `conditionGroup` 名なら警告 `unknown-condition-group`。

| id | 中身 | 動くスキル (2026-10 時点) |
|---|---|---|
| `hpFull` / `redHp` / `hpLow` | 体力が満タン / 赤ゲージあり / 35% 以下 (満タンとは同時に起きない) | フルチャージ / 逆恨み / 火事場力 |
| `enraged` | モンスターが怒っている (既定 1.0・本人の前提) | 挑戦者・巨戟龍の黙示録 |
| `chain` (段階) | 連撃: 未発動 / 1〜4 ヒット段 / 5 ヒット以降段 (既定 5 段以降 1.0・本人の前提) | 連撃 (5 段以降が主効果)・兇爪竜の力 (1〜4 段と 5 段以降) |
| `frenzy` (段階) | 狂竜症: かかっていない / 感染中 / 克服した後 | 黒蝕竜の力 (感染中と克服後で違う)・無我の境地 (克服後) |
| `staminaFull` | スタミナ満タンをしばらく保っている (既定 1.0・本人の前提) | 渾身 |
| そのほか | 力の解放・武器出し直後・ジャストガード後 など 1 条件 1 グループ | `rules.conditionGroups[].skills` を見る |

### 傷口

- コンボの段に `onWound: true` があるか `target.isWound` なら、その段は `target.wound` の肉質と弱点特効の傷口分で計算する。
- **部位に傷口が無い (`target.wound` が null か無い) ときは傷口なしで計算する**: 傷口でだけ出るヒット
  (集中急所突きの「傷口の追加ヒット」「白傷の追加ヒット」) を数えず、弱点特効の傷口分も入れない。警告 `no-wound`
  (「この部位には傷口ができません。…」)。
- 傷口でない段でも、傷口でだけ出るヒットは数えない (警告 `wound-only-hits-skipped`)。
- 傷口でだけ出るヒットは `isWoundOnlyHit(hit)` で見分ける (`hits[].woundOnly` があればそれ、無ければラベル)。

### 主な関数

```js
import { comboExpected, skillContribution } from './model/damage.js';

const input = { weapon, sharpness: 'white', skills: build.skills, effects, motions,
                uptimes: { enraged: 0.6, chain: { hit1to4: 0.2, hit5plus: 0.7 } },
                combo: combos.combos[0], target: { hitzone: part.hitzone, wound: part.wound } };

const r = comboExpected(input);
// r.total / r.physical / r.element / r.extra … コンボ 1 回の期待ダメージ (extra は灼熱化などの追加分)
// r.steps[] … 技ごとの内訳 {move, name, isWound, total, physical, element, extra}。パターンが MAX_PATTERNS を超えたときは空 (r.factored)
// r.conditions[] … このスキル構成で効く条件グループ (画面の発動率の入力欄に使う)
//     {id, label, type, states: [{id, label}], offState, uptime, probs, defaultUptime, fromInput,
//      placeholder (使った値が仮置きなら true), uptimeBasis, exclusiveWith, skills: [{skillId, name}], note,
//      inactive (条件のもとが無いので 0%), inactiveReason}
// r.warnings[] … {code, message, ...}。message はそのまま画面に出せる日本語
// r.unsupported[] … 計算に入れていないスキル {skillId, name, level, reason} (画面で「未対応」)
// r.lowConfidence[] … 確度 low の値で計算したスキル {skillId, name, level, confidence, reason} (画面で「未確定」)
// r.sharpnessPlan … sharpnessUse から出した研ぐまでの減り方 (下の sharpnessPlan と同じ形。sharpnessShares を渡したとき・無いときは null)
// r.extraChecks[] … 判定のある追加ダメージ (灼熱化) の要約 (2026-10-24)
//     {kind, skillId, name, level, conditional, cooldownSec, perCheck, cycleSec (1 周の秒数), checksPerCycle (1 周の判定の回数),
//      procsPerCycle (= perCheck × checksPerCycle), secPerProc (発動の間隔の秒。出ないなら null), estimated (秒数の分からない段があった)}

const c = skillContribution(input);
// c.vsNoSkillsPct … スキルなし比の上昇 (%)
// c.removeEach[] … {skillId, name, level, total, dropPct}  そのスキルだけ外したときの低下 (%)、大きい順
// c.perLevel[]   … {skillId, name, level, maxLevel, levels: [{level, total, gainPctVsNone, gainPctVsPrev}]}
// c.conditions / c.warnings / c.lowConfidence … スキル全部ありのときのもの
```

| 関数 | 用途 |
|---|---|
| `comboExpected(input)` | 代表コンボ 1 回の期待値 |
| `skillContribution(input)` | スキルなし比・1 つ外したときの低下・Lv ごとの上昇 |
| `hitDamage(hit, stats, {hitzone, isWound, sharpness, rules, checkWeight})` | 1 ヒット (×count) の期待値 `{physical, element, extra, total, affinity, critExp}`。`checkWeight(spec)` = このヒット (count 回分) が判定になる 1 周あたりの割合 (灼熱化用。comboExpected が渡す)。無ければ「待ちの明けた所で 1 回」として 1 |
| `comboPlan(motions, combo, target, warnings)` | コンボ → 段ごとのプラン `[{move, name, hitzone, isWound, hits, startSec, lengthSec, lengthFrom, fps}]` (傷口の決まり・段の時刻。探索の評価器も使う) |
| `checkWeights(times, cycleSec, cooldownSec)` | 判定の重みの純関数: 1 周の中の時刻 → 繰り返したときの定常状態で、各時刻が判定になる 1 周あたりの割合 (Float64Array)。前の判定から `cooldownSec` (幅 `CHECK_EPS` = 1e-6 秒) たっていれば判定 |
| `planCheckWeights(plan, spec, warnings)` | プランのヒットごとの判定の割合 `{perHit: [段][ヒット], cycleSec, checksPerCycle, estimated}`。秒数の分からない段は警告 `no-timing` |
| `extraDamageOnce(spec, mods, hitzone)` / `extraApplies(spec, hit)` | 追加ダメージ 1 回分 / 対象ヒットか |
| `resolveSkills(skills, effects)` | スキルを `active` / `unsupported` / `unknown` / `lowConfidence` に分ける |
| `resolveConditions(active, effects, uptimes, {skillIds, monsterStatus}?)` | 使う条件グループと発動率 `{active, groups, warnings}` (4 番目は条件のもとの確かめ) |
| `conditionSourceMissing(def, skillIdSet, monsterStatus)` | 条件のもと (`sources`) が装備にも相手にも無いか |
| `enumeratePatterns(groups)` | 条件の段の組み合わせと重み `{patterns: [{weight, states: {グループ id: 段 id}}], warnings}` (同時に起きない条件は本人の値を先に保つ)。`MAX_PATTERNS` を超えたら例外 |
| `factorPatterns(groups)` | 同時に起きない条件の塊ごとのパターン `{blocks: [{groups, patterns}], count, warnings}`。`count` は enumeratePatterns が並べる数 (塊の数の積。上限を超えていてもよい)、`warnings` は enumeratePatterns と同じもの・同じ並び |
| `conditionGroupDefs(effects)` | `rules.conditionGroups` を id → 定義 の Map に (exclusiveWith は両側にそろえる) |
| `aggregateModifiers(effectList, elementType, buffs)` → `computeStats(weapon, mods, rules)` | 1 パターン分の攻撃力・会心率・属性値 |
| `isWoundOnlyHit(hit)` | 傷口でだけ出るヒットか |
| `critExpectation(aff, critMul)` / `critElementExpectation(aff, critElementMul)` / `clampAffinity(aff)` | 会心まわり |
| `sharpnessMultipliers(color)` / `effectiveElement(base, mul, add)` / `effectiveAttack(base, mul, add)` | 補正・上限 |
| `mergeRules(effects)` / `DEFAULT_RULES` / `SHARPNESS_ORDER` / `ELEMENTAL_TYPES` / `MAX_PATTERNS` | 定数 (rules は `skill_effects.json` の値が優先) |
| `sharpnessShares(gauge, perSec, intervalSec)` | 研ぐまでの色の割合 `{shares (足して 1), sec (色ごとにもつ秒数), top (一番上の色の添字)}`。上の色から順に減る。秒数 0・減らない → 一番上の色、ゲージが無い → 白、使い切ったら赤のまま (2026-10-29) |
| `comboSharpnessUse(input)` | コンボ 1 周で減る目盛り `units`・その会心の見込み `critUnits` (目盛り × 会心率 の和。パターンの期待値)・1 周の秒数 `cycleSec` (1 部位) |
| `sharpnessPlan(input, targets)` | 部位をまとめた研ぐまでの減り方 `{shares, sec, top, intervalSec, perSec, rawPerSec, keep, critRate, save, critSave, unitsPerCycle, cycleSec}` (`input.sharpnessUse` が無ければ null)。`keep = (1 - 業物) × (1 - 達人芸 × critRate)`、`perSec = rawPerSec × keep` |
| `sharpnessSavesOf(active)` / `hitSharpnessCost(hit)` | 斬れ味を減らさない確率 `{save, critSave}` (条件なしのスキルだけ) / 1 回で減る目盛り (消費しない当たりは 0・無ければ 1) |

警告のコード: `bad-uptime` (発動率が読めない → 既定値) / `unknown-state` (知らない段) / `uptime-over-100` (段の合計が 100% 超え →
縮める) / `exclusive-conflict` (同時に起きない条件の合計が 100% 超え) / `unknown-condition-group` / `no-wound` /
`wound-only-hits-skipped` / `many-patterns` (パターンが `MAX_PATTERNS` を超えたので因子分解の合計で出した。技ごとの内訳なし) /
`no-timing` (灼熱化があるとき、技の長さかヒットの時刻が分からない段がある。`move` = 技 id。長さは全長か 1.0 秒、時刻は技の始まりで数えた)。

`comboExpected` の入力にはテスト用に `maxPatterns` (全パターンを並べる数の上限。0 で必ず因子分解の道) がある
(`tests/damage_factored.test.mjs` が両方の道を同じ入力で比べる)。

### 式

- 攻撃力 = 武器攻撃力 × min(乗算の積, 4.0) + min(加算の和, 400) (乗算が先)
- 会心率 = 武器 + スキル + 弱点特効 (物理肉質 45 以上) + 傷口分 (傷口のときだけ) → -100〜100 で切る
- 物理 = 攻撃力 × MV/100 × 物理肉質/100 × 斬れ味物理 × 会心期待値 × 心眼 (肉質 44 以下) × 飛燕 (`hien` のヒット) × 鈍器使い
- 属性 = 属性値/10 × 技の属性補正 × 属性肉質/100 × 斬れ味属性 × 会心撃【属性】期待値 (無ければ 1、マイナス会心は掛けない)
- 属性値 = 元 × min(乗算の積, 2.3) + min(加算の和, 400) (攻撃と同じく倍率と加算を別々に切る。確度 medium)。
  `elementType` 付きの効果は武器の属性が一致するときだけ
- 追加ダメージ (灼熱化。`extraDamage.model: 'checks'`。2026-10-24) = Σ (対象ヒットごと) `perCheck` (0.5) × w × 1 回分。
  1 回分 = 固定 + (火 × 火の倍率 + 火の加算)/10 × 火肉質/100 (`extraDamageOnce`)。火の倍率・加算 = `elementType` が火か無指定の効果の
  `elementMul` の積・`elementAdd` の和を、**武器の属性と関係なく**集めたもの (`aggregateModifiers` の `fireMul` / `fireAdd`。buffs は入れない・
  属性の上限は掛けない)。w = コンボを繰り返したときの定常状態で、そのヒットが判定になる割合 (`planCheckWeights`。判定は対象ヒット
  (`additionalDamage`) でだけ、前の判定から 2.4 秒たつまではしない)。条件つきのパターンでも w は同じなので、プランごとに 1 回だけ出す。
  `model` の無い extraDamage (テスト用の前の形) は `chance` × (固定 + 属性/10 × 肉質/100) × count のまま。
  火竜の力は確度 low (技のつなぎの秒数が見積もりで、判定の回数がそれで変わる)。計算に使うと `lowConfidence` に入る
- 盾のヒットは属性 0 (`elementRate: 0`)。斬れ味補正は `sharpnessMul` が true のヒットだけ
- (2026-10-29) 研ぐまでの減り方 (`sharpnessUse` / `sharpnessShares`) があると、斬れ味物理 × 鈍器使い = Σ 色の割合 × 色の物理補正 ×
  (その色で鈍器使いが効けば鈍器使いの倍率)、斬れ味属性 = Σ 色の割合 × 色の属性補正 (`sharpnessMul` が false のヒットは色の補正 1 で、
  鈍器使いだけ割合で掛ける)。色の割合 = `sharpnessShares(匠込みのゲージ, 1 秒に減る目盛り, 研ぐまでの秒数)`。1 秒に減る目盛り =
  (部位の割合で平均した 1 周の目盛り ÷ 1 周の秒数) × (1 - 業物) × (1 - 達人芸 × 減る当たりの会心率)

## weapon.js

武器の解決と斬れ味の自動 (純粋関数)。探索 (`app/model/search/`) と Worker からも使うので、`app/ui/tabs/equip_logic.js` から
移した (2026-10-21・`docs/SEARCH_DESIGN.md` 4 章の 1)。画面は今までどおり `equip_logic.js` から import できる (再 export。値も同じ)。
import は相対パスの `./damage.js` だけ (preact を読まない)。

```js
import { resolveWeaponRef, damageWeapon, autoSharpness, sharpnessResolver, handicraftSkillId,
         baseWeaponOf, sharpnessGauge, gaugeWithHandicraft, topSharpness, HANDICRAFT_STEP } from './app/model/weapon.js';

const w = resolveWeaponRef(build.weapon, idx);         // 数値 = weapons_sns の id / 文字列 = 所持武器の id → 武器 (所持武器は元の武器で補う) か null
const dw = damageWeapon(w);                            // damage.js に渡す {attack, affinity, element}
const s = autoSharpness(w, idx, r.skillLevels);        // {color, handicraft, gauge, baseGauge, maxGauge}。color = 匠込みの一番上の色
const perSkills = sharpnessResolver(w, idx, state.sharpness, { intervalSec: state.sharpnessInterval });
// スキルの組 → {sharpness, sharpnessUse? (秒数が正なら匠込みのゲージ)}。固定・武器なしなら null
const use = sharpnessUseOf(w, idx, r.skillLevels, state.sharpnessInterval, state.sharpness); // {gauge, intervalSec} | null
```

| 関数 | 中身 |
|---|---|
| `resolveWeaponRef(ref, idx)` | 武器の参照 → 武器。所持武器 (my_weapons・画面で足した分) は `baseWeaponId` の武器で攻撃力・スロット・スキル・斬れ味などを補う |
| `damageWeapon(w)` | `{attack, affinity, element}` (属性が無ければ null。null の武器は攻撃 0) |
| `autoSharpness(w, idx, skillLevels)` | 斬れ味の自動の色 (匠 1 Lv で 10 ずつ、`handicraftMax` まで伸ばした一番上の色) |
| `sharpnessResolver(w, idx, fixedColor, {intervalSec}?)` | スキルの組ごとに色を決め直す関数 (power_calc.js の `perSkills`・探索の評価器)。匠の Lv ごとに覚える。`intervalSec` が正なら匠込みのゲージ (`sharpnessUse`) も返す |
| `sharpnessUseOf(w, idx, skillLevels, intervalSec, fixedColor)` | damage.js の `sharpnessUse` (`{gauge, intervalSec}`)。色を固定・秒数 0・ゲージの分からない武器は null (2026-10-29) |
| `handicraftSkillId(idx)` | 匠の skillId (名前で探す。無ければ null) |
| `baseWeaponOf` / `sharpnessGauge` / `gaugeWithHandicraft` / `topSharpness` | 元の武器 / ゲージ `{base, handicraftMax}` / 匠を入れたゲージ / 一番上の色 |

`idx` は `indexEquipData(...)` の結果 (`data.index` か `useEquipIndex` の `idx`)。

## hunt.js

相手 (モンスター・個体・クエスト) の体力・討伐までの回数・個体の肉質・クエストの選び方 (段階 3。`docs/RECOMMEND_DESIGN.md` 5.2 節)。
純粋関数で、import は無い (node でも Worker でも動く)。テストは `tests/hunt.test.mjs`。

`targetData` (下の `td`) は data.js の target データ (`useTargetData().data`) をそのまま渡す。`{monsters: monsters.json 丸ごと,
quests: quests.json 丸ごと}` や `{monsters: [...], quests: [...]}` でもよい。`monster` は monsters.json の 1 件、`kind` は個体
(null = 通常 / `'tempered'` / `'arch-tempered'` / `'frenzied'` / `'alpha'`)、`quest` は quests.json の 1 件。

```js
import { individualsOf, individualOf, elementRecommendationOf, hitzoneFor, questsFor, defaultQuestId,
         questSubjects, targetHealth, combosToDefeat, attackView, woundVitalOf,
         subjectIndexOf, clampPlayers, monsterById, questById, monstersOf, questsOf,
         MARK_LABEL, INDIVIDUAL_KINDS, AVAILABLE_STATUSES, MAX_PLAYERS } from './app/model/hunt.js';

const kinds = individualsOf(monster);                   // [{kind, label: '歴戦王', name: 'アルシュベルド（歴戦王）', stars, questCount}] 先頭が通常
const qid = defaultQuestId(td, 20, 'arch-tempered');    // 'Freedom from Solitude' (『孤独から出でし君という自由』)
const subs = questSubjects(questById(td, qid), td, { players: 4 });
// subs[0] = {index: 0, key: '20:arch-tempered#0', monsterId: 20, name: 'アルシュベルド（歴戦王）', kind: 'arch-tempered',
//            missionTarget, paramGroup: 'kingHard', health: targetHealth(missionTarget, {players: 4})}
const n = combosToDefeat(subs[0].health, 920.6);        // {mid, min, max} (切り上げ) か null
const hz = hitzoneFor(monster, 'head', 'arch-tempered', { useUncertain: state.target.useUncertainWound });
```

| 関数 | 中身 |
|---|---|
| `individualsOf(monster)` | 個体の一覧 `[{kind, label, name, stars, questCount}]` (individuals の並び。individuals が無い古いデータは通常 1 つ) |
| `individualOf(monster, kind)` | individuals の 1 件 (無ければ null) |
| `elementRecommendationOf(monster, kind, {useUncertain})` | 個体のおすすめ属性。`sameAsBase: false` の個体は置き換え後の傷口で計算し直したもの、`sameAsBase: null` (歴戦王アルシュベルド) は `useUncertain` のときだけそれ。ほかはモンスターの `elementRecommendation` |
| `hitzoneFor(monster, part, kind, {useUncertain})` | 部位 (key か要素) の肉質。下の表 |
| `questsFor(td, monsterId, kind)` | その個体のクエスト `[{quest, id, name, role: 'target'\|'intruder', stars, available, status, fixedEquipment, multi, subjectIndex, health}]`。狩猟対象 (questIds の並び = ★順) → 乱入の可能性。`health` = その個体の行のソロの体力 `{mid, min, max}` か null |
| `defaultQuestId(td, monsterId, kind)` | 自動で選ぶクエスト (方針): 狩猟対象のうち 装備固定でない (`fixedEquipment === false`)・体力が分かる・多頭でない・受けられる (`permanent`/`standard`/`active`) ものの ★ が一番高いもの。同じ ★ なら一覧の先頭。無ければ null |
| `questSubjects(quest, td, {players})` | 戦う大型 `[{index, key, monsterId, name, kind, missionTarget, health, paramGroup}]`。`index` = mission.targets の行の番号 (小型の行は除くので飛ぶことがある。`state.target.questTargetIndex` はこの番号)。mission の無いクエストは quest.targets の大型を数のぶん並べ、`health.known: false` |
| `subjectIndexOf(quest, monsterId, kind)` | mission.targets のその個体の行 (無ければ null) |
| `targetHealth(missionTarget, {players})` | 体力 `{known, solo: {mid, min, max}, players, multiplier, total, perPlayer: {mid}, confidence: {solo, multi}, reason}`。下の決まり |
| `combosToDefeat(health, comboValue)` | 体力 (数 / `{mid, min, max}` / `targetHealth` の結果 = `total` を使う) ÷ 1 コンボの期待値を切り上げ `{mid, min, max}`。期待値が 0 以下・数でない・体力不明なら null |
| `attackView(quest, subjectIndex, td)` | 攻撃の強さ `{calm, angry, paramGroup, compareTo: {questId, name, stars, calm, angry} \| null, ratio: {calm, angry} \| null, confidence: 'low'}`。attackRate が無い (通常の個体) なら null |
| `woundVitalOf(monster, group)` | 傷の付きにくさ `{normal, tear, temperedScar, confidence: 'low'}` (`legendaryParams[group].woundVital`)。群が null・欄が無ければ null |
| `clampPlayers(n)` / `monsterById` / `questById` / `monstersOf` / `questsOf` | 人数を 1〜4 に / データの取り出し |
| `archTemperedRewards(td)` | 歴戦王の報酬 (`individuals[].rewards`) の一覧 `[{monsterId, monster, name, armorIds, armorSets, charmFixedIds, certificate, groupSkills: [{skillId, name}]}]`。`td` は target データ・monsters.json 丸ごと・モンスターの配列のどれでもよい (2026-10-21 3f) |
| `gammaIndex(td)` | γ の印の表 `{armor: {[armorId]: {monsterId, name}}, charmsFixed: {...}, monsters: archTemperedRewards の結果}`。探索の入力 `gamma` にそのまま渡せる。search.js の `gammaIndexOf`・recommend.js の `gammaIndex` / `gammaExclusions`・探すタブの `gammaInfo` はどれもこれを使う (表を作る所を 1 つにした。3f) |

`hitzoneFor` の返り値 `{hitzone, wound, baseWound, overrideWound, woundSource, changed, sameAsBase, confidence, mark, note, dataNote}`:

| 個体 (`individuals[].hitzone`) | `wound` (計算に使う傷口) | `woundSource` | `mark` |
|---|---|---|---|
| `sameAsBase: true` (通常・歴戦の個体・置き換えの無い歴戦王) | `parts[].wound` | `'base'` | null |
| `sameAsBase: false` (歴戦王ウズ・トゥナ) で置き換えのある部位 | `woundOverrides[key]` (頭: 弾 88→70・雷 25→20) | `'override'` | `'unverified'` (未確認) |
| `sameAsBase: null` で置き換えのある部位 (歴戦王アルシュベルド) | 既定は `parts[].wound`、`useUncertain` なら `woundOverrides[key]` | `'base'` / `'override-uncertain'` | `'uncertain'` (未確定) |
| `sameAsBase: null` で確度も null (狂竜化・ボス個体 = 未調査) | `parts[].wound` | `'base'` | `'unverified'` |
| 部位に傷口が無い (`parts[].wound` が null) | null (置き換えのデータがあっても作らない) | `'none'` | 上のどれか |

- `hitzone` (通常の肉質) は個体で変わらない。`overrideWound` は使っていなくてもデータにあれば入る (「置き換わるとしたら」を見せる)。
  `changed` は置き換えで値の変わる項目 (例 `['shot', 'thunder']`)。`note` は画面に出せる文、`dataNote` はデータの注記 (「くわしく」用)。
- 印の出し方 (`MARK_LABEL`): `uncertain` → `<Badge kind="unconfirmed" />` (未確定)、`unverified` → `<Badge kind="warn">未確認</Badge>`、
  `provisional` → `<Badge kind="warn">仮</Badge>` (`docs/RECOMMEND_DESIGN.md` 2.8 節)。
- state.js の `resolveTarget` は `state.target.individual` があればこれで傷口を置き換える (装備・火力タブも歴戦王の傷口で計算される)。

`targetHealth` の決まり:

- ソロ = `mission.targets[].healthCalc` (`mid` = 乱数の等級 1.0、`min`/`max` = 出るたびの範囲。確度 `healthCalc.confidence` = medium)。
  healthCalc が無い・mission が無い (フリーチャレンジなど) は `known: false` (`reason: 'no-health'`)。仮の値で埋めない。
- 2 人以上 = ソロ × `multi.health[人数]` を四捨五入 (`_Count` を人数と読んだもので確度 low → 画面は未確定。掛けたあとの丸め方も未確認)。
  その人数の倍率が無い (`maxPlayers` を超えたなど) ときは `multiplier`・`total` が null (`reason: 'no-multi'`)。人数は 1〜4 に丸める。
  例: 4 人の『孤独から出でし君という自由』= 79,923 × 3.0 = 239,769。
- `perPlayer` = total ÷ 人数 (全員が同じだけ当てる前提の目安)。

そのほかの決まり:

- MissionData は狂竜化・ボス個体を区別しない (`variant: null` の行)。`subjectIndexOf` / `questsFor` はその個体の行が無ければ同じモンスターの
  null の行を使い、`questSubjects` は quest.targets に同じモンスターの frenzied / alpha があればそれを個体にする。
- `attackView` の比べる相手 (方針): 同じモンスターの歴戦の個体 (`variant: 'tempered'`) が出る別のクエストのうち、装備固定でなく
  attackRate のあるもの。★ が一番高いもの → 同じ ★ なら多頭でないもの → それも同じならデータの並びで先。
  例: 歴戦王アルシュベルド ★10 (8.4) は狩猟演習 (★9・7.15) と比べて約 1.17 倍。

## recommend.js (段階 3。担当: model-recommend)

相手に合わせたおすすめ (守りのスキル・武器の属性・狙う部位・多頭の重み・作れない γ 防具の除外)、Plan → Job、探索を順に回す
`createPlanRunner`、多頭の並べ直し、守りのチェック、耐性の合計。設計は `docs/RECOMMEND_DESIGN.md` (2〜3 章・5.3 節)。
純粋関数で、import は相対パスの `./build.js` / `./damage.js` / `./hunt.js` / `./weapon.js` だけ (Worker からも読める)。
探索の本体 (`createSearch`・`optimizeWeaponSide`) は import せず、`createPlanRunner` の引数で受ける。テストは `tests/recommend.test.mjs`。

```js
import { buildPlan, planToJob, createPlanRunner, rerankMulti, defenseCheck, resistTotals, jobKey,
         collectThreats, requirementsFrom, elementPlan, elementView, partsTargets, multiWeights, subjectHealths,
         gammaExclusions, gammaIndex, searchUptimes, evaluateBuild, defenseSkillChoices, stableHash,
         baselineView, vsBaselinePct, planBaseline,
         PRESETS, PRESET_LABEL, DEFAULT_PRESET, ELEMENT_LABEL, DEFENSE_SKILL_NAMES, TWO_WEAPON_TOP, RUN_SHARE,
         DEFAULT_HITZONE, DEFAULT_HITZONE_TEXT } from './app/model/recommend.js';

// 画面のスレッド (相手タブの「この相手のおすすめ」と探すタブ)。探索はしない (歴戦王・多頭で 1ms 前後)
const plan = buildPlan({
  target: state.target, tabTarget: state.tabs.target, search: state.search,
  targetData,                                   // data.js の target データ (monsters / quests / threats)
  core: { index, skillEffects, motions, combos },  // data.js の core データ (index は端末の護石・武器を足した索引でもよい)
  current: { build: state.build, combo: state.combo, uptimes: state.uptimes, sharpness: state.sharpness, extraWeapons },
});
const job = planToJob(plan, { K: 10, budgetMs: state.search.budgetSec * 1000, userRequired: state.search.required,
                              extraCharms, extraWeapons, current: state.build });
const inputKey = jobKey(job, { dataVersion });   // 結果の保存 (search-last) の inputKey

// Worker の中で (createSearch と同じ形)
const runner = createPlanRunner(job, data, { createSearch, optimizeWeaponSide });
while (!runner.step(80)) { const p = runner.progress(); /* p.run = {index, count, label, key}・p.best・p.bestKind */ }
const r = runner.result();   // r.results[] に score / perSubject / weapons / builds / defense / baseline / gamma

// 画面のスレッドで、いまの装備の基準を Worker と同じ式で出し直す (結果の組を装備に入れたあとの「いまより」)
const base = planBaseline(job, state.build, { index, skillEffects, motions });   // baselineView の形 | null
```

### Plan (`buildPlan` の返り値)

| 項目 | 中身 |
|---|---|
| `status` / `blocked` | `'ok'` / `'no-target'` (相手が決まっていない) / `'no-data'` (モンスターは選んだが相手のデータを読み込み中。`subjects: []` で待つ)。`blocked` = 探さない理由 `{code: 'fixed-equipment', message}` (装備固定のクエスト。体力などは出す) か null。モンスターを選んでいなければ `no-target` のまま、装備タブ・火力タブと同じ既定の肉質 (`DEFAULT_HITZONE` = 切断・打撃 45、属性 20) の相手 1 体 (`key: 'default'`・`isDefault: true`) を入れて探せるようにする (段階 2 で相手なしに探す) |
| `mode` / `useTarget` | `'single'` / `'multi'`。`useTarget: false` (段階 2) は相手 1 体・守りの要件なし・武器は `weaponMode` (`auto` = いまの武器) |
| `subjects[]` | 戦う相手 `{key, index, monsterId, kind, name, health (hunt.targetHealth), healthForT: {mid,min,max}, healthAssumed, healthBasis, targets: partsTargets の結果, element: {rec, view}, threats, monsterStatus, current: {value, combos} \| null}`。クエストを選んでいれば mission.targets の行ごと (多頭は全部)、無ければモンスター 1 体 (体力不明) |
| `element` | `elementPlan` の結果 (下) |
| `requirements[]` | 守りの要件の行 (`requirementsFrom`。下) |
| `notes[]` | 防げない攻撃・防ぐスキルの無い状態異常 `{subjectKey, subjectName, text, oneShot, source, type}` (ジン・ダハドの歴戦王のノヴァなど) |
| `exclusions` | `gammaExclusions` の結果 + `gamma` (`gammaIndex`。結果の「歴戦王〇〇の素材が要ります」用) |
| `weights[]` | 多頭の重み (`multiWeights`)。1 体なら `[{key, weight: 1}]` |
| `quest` | `{id, name, stars, multi, fixedEquipment, intruders: [名前]}` か null (乱入は相手に入れず名前だけ) |
| `inputs` | Job に入れる値: `combo` (解決済み)・`uptimes` (仮置きを 0% にしたもの)・`uptimeMode`・`placeholders` (仮置きの条件の一覧)・`sourceUptimes`・`monsterStatus` (多頭は全員の和)・`sharpness`・`limitBreak` (`search.limitBreak` を解決)・`charms`・`armorExclude`・`currentBuild` (いまの装備。武器が無ければ null) |
| `current` | いまの装備 `{value (1 体), T (多頭), perSubject: [{key, value, combos}], check: defenseCheck(...)}` か null |
| `marks` / `warnings` / `license` | `{preset: 'provisional', parts: 'provisional' (main3) \| null}` / `[{code, message}]` / CC BY-SA の出典 (画面に出す) |

警告のコード: `placeholder-uptimes` (仮置きの発動率を 0% で探す) / `gamma-excluded` / `health-assumed` (体力の分からない相手を平均で置いた) /
`health-unknown` (全員分からない・等分) / `reference-weapon` (武器が無いので候補の先頭の武器で重みを決めた) / `no-weapon` /
`no-element-weapon` / `no-resist-skills` / `no-threat-data` / `no-part` / `quest-missing` / `quest-mismatch` / `current-eval-failed` /
`no-target` / `no-target-data` / `default-target` (既定の肉質で探す)。

### 守りの要件 (`collectThreats` → `requirementsFrom`)

- `collectThreats(threats, subjects)`: monster_threats.json の 咆哮・風圧・振動・属性やられ (確定 / 未確認)・状態異常と、個体の
  `variants[threatVariant].hazards` を 1 件ずつ `{key, subjectKey, subjectName, type, value, element, skill: {skillId, name, negateLevel, mitigateLevel, levelText} | null, oneShot, confidence, uncertain, unconfirmed, text, note, source}` にする。
  歴戦王 (threatVariant のある個体) の咆哮などは `sameAsBase` が true なら通常の値を使い `unconfirmed: true`・`confidence: 'medium'`。
- `requirementsFrom(items, {preset, toggles, levels, effects, threshold})`: 同じスキルは 1 行 (Lv は大きい方・理由は全部)、
  属性やられは確定の属性で 1 行 (`key: 'blight'`)・未確認の属性で 1 行 (`'blight-uncertain'`)。行の key は `skill:<skillId>` / `blight` / `blight-uncertain`
  (`state.search.toggles` / `levels` のキー)。行 = `{key, kind: 'skill'|'blight', label, reason, skillId, skillName, elements, threshold,
  blightSkillId, bySkill, byResist, orText, options, level, levelChoices, negateLevel, mitigateLevel, mitigated, tier: 'on'|'ref', defaultOn, on,
  userSet, category, why: [{subjectKey, subjectName, text, type, note}], provisional, unconfirmed}`。
  - `tier` は `PRESETS[preset][category]` (category = `hazard` / `blight` / `uncertain` (未確認の属性やられ・確度 low) / `roar` / `wind` / `tremor` / `status`)。
    `on` は `toggles[key]` があればそれ。`level` は `levels[key]` が `levelChoices` (軽減の Lv〜無効の Lv) にあればそれ、無ければ無効の Lv。
  - 属性やられの「または」: `bySkill` = `[{属性やられ耐性, Lv}]`、`byResist` = 属性ごとの耐性スキルで `threshold` (20) 以上になる Lv
    (`rules.resistSkills`。いまは全部 Lv3 = +20)。`options` = `[bySkill, byResist]`。
  - `provisional` (仮) = 根拠の確度が high でない (データに確度の書いていない wiki の値は high と同じに扱う)。
    `unconfirmed` (未確認) = 行の脅威が全部「通常と同じと見ている」「未確認の属性やられ」「確度 medium/low の歴戦王の脅威」。
- 体力・回復系 (`DEFENSE_SKILL_NAMES`) は自動では足さない。`defenseSkillChoices(index)` が「守りのスキルを足す」の候補 `[{skillId, name, kind, maxLevel}]`。

| プリセット (`PRESETS`) | hazard | blight | roar / wind / tremor | status | uncertain |
|---|---|---|---|---|---|
| `power` (火力優先) | ref | ref | ref | ref | ref |
| `balance` (バランス・既定) | on | on | ref | ref | ref |
| `safe` (安全) | on | on | on | on | ref |

### 武器・部位・重み

- `elementPlan(subjects, current, index, {mode, twoWeapons, time})` → `{mode: 'current'|'element'|'all', requestedMode, weapons: [ref...] | 'sns-all', types, perSubject: [{key, rec, view}], currentRef, currentElement, text, warnings, twoWeapons: {option, suggested, reason, groups: [{element, subjectKeys, timeShare, weapons}]}}`。
  `auto`: 1 体でいまの武器が `same`/`close` → いまの武器、おすすめがはっきり (`clear`) か近い (`close`) → 1 位と差が 2 以内の属性の片手剣 +
  所持武器 + いまの武器、どれも効きにくい → いまの武器 (無ければ全部)。多頭は `clear` の相手の 1 位の属性を合わせる。
  武器 2 本の案は `clear` の 1 位の属性が 2 種類以上 (3 種類以上なら `time` の和の大きい 2 つ)。`elementView` は target_mix.js の `recommendationView` と同じ。
- `partsTargets(monster, kind, policy, memo, isWound, {useUncertain})` → `[{weight, label, partKey, target: {hitzone, wound, isWound}, woundSource, woundMark}]`。
  `memo = {[monsterId]: {partKey, mix: {on, weights}}}` (`tabs.target.memo` と、いまの相手の `partKey` / `tabs.target.mix`)。傷口は `hunt.hitzoneFor`。
  弱点 1 か所 (`weak1` と memo の無い相手) と主な部位 3 か所 (`main3`) は、一時的な部位 (monsters.json の `transient: true`。
  ウズ・トゥナの水膜) を選ばない (2026-10-22。前は切断 90 の水膜が弱点 1 か所になり、『英雄の証』の T を約 11% 少なく見積もっていた)。
- `subjectHealths(subjects)` → 相手ごとの T 用の体力 (分からない相手は分かっている相手の平均・全員分からなければ 1)。人数の倍率は全員分かるときだけ掛ける。
- `multiWeights(subjects, dRef)` → `[{key, name, weight (足して 1), time = H/D_ref, timeShare, health, healthAssumed, healthBasis, dRef, dRefAssumed, reason}]`。
  `weight ∝ H_i / D_ref_i²`。D_ref はいまの装備の期待値 (武器が無ければ候補の先頭の武器のスキルなし)。
- `searchUptimes(effects, uptimes, 'zero'|'keep')` → `{mode, uptimes, placeholders: [{id, label, type, defaultUptime, zeroed}]}`
  (本人が入れていない仮置きの条件を 0% に。binary は 0、categorical は `{}`。`placeholder: false` の条件 = 根拠のある既定値と
  本人の前提 (怒り・連撃・スタミナ満タン 100%。2026-10-22) は触らないので、既定の値で探す)。
- `evaluateBuild(build, targets, ctx)` → `{value, perTarget, perGroup, skillLevels}` か null (computeBuild + comboExpected。探索と同じ式)。

### Job (`planToJob`) と探索の回し方 (`createPlanRunner`)

- Job = `{kind: 'plan', runs: [{key, label, input}], costRun, runsBudget, merge: {mode: 'single'|'multi'|'twoWeapons', subjects, weights, alternatives, groups}, K, subjects: [{key, name, health, healthAssumed, healthBasis}], requirements, gamma, baseline, players, blocked, warnings, tryKey}`。
  - `runs[].input` は `createSearch` の入力 (`docs/SEARCH_DESIGN.md` 3.2 節)。`targets[]` は相手 × 部位の行で `group` = 相手の key、
    `weight` = 相手の重み × 部位の割合 (足して 1)。`required` = 自分で足した必須 + オンの要件 (同じスキルは Lv の大きい方)。
    `charms.fixedExclude` (狩猟証γ の護石)・`armorExclude` (使わない防具 + γ 防具)・`current` (いまの装備。既定 `plan.inputs.currentBuild`。「いまより +x%」用)・
    `gamma` (γ の印の表 = `gammaIndex`。探索が同じ値の γ でない防具・護石を代表にする)・
    `budget` (既定 `{activeMs: budgetMs × 割合 / 回数}`。割合は `costRun` か武器 2 本の合わせがあれば `RUN_SHARE` = 0.6 (残りは予算で切れない
    合わせと火力の差の分)、無ければ 1。`opts.budget` を渡すとそのまま各回に)。
  - `runsBudget` = 探索の回の合計の持ち時間 `{activeMs: budgetMs × 割合}` (2026-10-22)。`createPlanRunner` が回を始めるときに
    「残り ÷ 残りの回の数」を渡す (先に最後まで終わった回が使わなかった分が後の回に回る。`runs[].input.budget` はその最初の値)。
    `opts.budget` を渡したとき (テスト・ベンチの仕事量の予算など) は `null` で、各回は入力の `budget` のまま。
  - 属性やられがオン → `runs` は `blight-skill` (属性やられ耐性 Lv3) と `blight-resist` (各属性の耐性スキル Lv3) の 2 つ。オフなら `main` の 1 つ。
    (2026-10-24) `blight-resist` の入力には `armorResistMin` (属性ごとに「20 − 耐性スキル Lv3 の分」= いまは 0) を付ける。守りのチェック
    (耐性の合計 ≥ 20) を探索の条件にして、回の上位が守りで落ちる組で埋まらないようにする (所持護石が 246 個になって S3z・S4z の 1 位が
    前より悪くなったため。`docs/SEARCH_DESIGN.md` 2.12 節・12 章)。要件の行 (`requirementsFrom`) は `byResistArmorMin` を持つ。
  - `costRun` = 守りの要件を外した探索 (`stopAfter: 'partial'`・自分で足した必須は残す)。守りの要件がオンのときだけ。
  - `tryKey` を渡すと「試す」用 (その行をオンにして全部 `stopAfter: 'partial'`・`costRun` なし・武器 2 本なし)。
  - 属性やられの行はあるが、防ぎ方 (`bySkill` / `byResist`) が行ごとにそろわない (データの欠け) ときは、必須にせず `main` の 1 回にして警告 `blight-not-required`。
  - `blocked` (相手のデータの読み込み中・装備固定) のときは `runs: []`。
- `createPlanRunner(job, data, {createSearch, optimizeWeaponSide, now})`: `step(ms)` / `progress()` / `result()` / `cancel()` / `extend({ms} | {activeMs})`。
  (2026-10-24) 相手が 1 体・武器 1 本 (`merge.mode: 'single'`) のときは、2 回目からの回に `floor` = 前の回で守りを満たした組の K 番目の値を
  渡す (それより下の組は合わせた上位 K に入らない)。`result().stats.runs[].floor` に渡した値 (渡さなかった回は null)。
  `data` は Worker の data (生データ + `index`)。索引には入力の `extraWeapons`・`charms.extra` (端末の所持アーティア・護石) を足して使う
  (守りのチェック・いまの装備の値・相手ごとの値の計算し直し)。
  探索の回の予算は、`job.runsBudget` があれば回を始めるときに渡す: 「残りの持ち時間 ÷ 残りの回の数」(`activeMs`)。回が終わったら
  使った分 (探索の `stats.activeMs − prepareMs` = 予算と比べた計算の時間。下ごしらえは予算で数えないので持ち時間からも引かない。
  返さない探索は runner で測った回の時間) を、渡した予算を上限に持ち時間から引く。最後まで終わった回の残りは後の回に回り、予算で切れた回は渡した予算だけを
  使ったことにする (仕上げ 2 でこえた分で後の回を減らさない)。後の回の予算は前の回と同じか多く、回が予算と比べて使った時間の合計は
  持ち時間をこえない。火力の差を測る回 (`costRun`。途中の結果まで) は入力の予算のまま。
  `extend` は `activeMs` (計算した時間) なら同じく回を始めるときに「残り ÷ 残りの回の数」(1 回 200ms 以上) を、`ms` (始めてからの時間。
  テスト・ベンチ) なら回の数で分けた値を渡す (延長は回ごとに順に始める。2026-10-22 までは全部の回を `extend` を受けたときに始めていた)。
  `runs` を順に回し (`progress().run = {index, count, label, key, budgetMs?, elapsedMs?}`。`count` は火力の差を測る回 (`costRun`) も数える (その回は `index` が最後)。
  `budgetMs` / `elapsedMs` は持ち時間から予算を受け取った回だけ: その回 (延長はその延長) の予算と、始めてからの計算の時間 (探索の
  `progress().stats` の `activeMs − prepareMs` で数える。予算と同じ時計で、下ごしらえは入れない。数えない探索は runner で測った時間)。画面の帯はこれで伸ばす。
  `phase` は探索の段か `'merge'` / `'twoWeapons'` / `'cost'` / `'done'`。`best` (いまの最良) は 1 体の探索の回ならその回の上位、
  それ以外 (多頭の探索の回 = 重み付きの期待値で T ではない・火力の差の回 = 守りなし・合わせ) は合わせた結果の上位で、
  `bestKind` は `'damage'` か `'combos'` (多頭の T))、
  合わせる → 武器 2 本 (上位 `TWO_WEAPON_TOP` = 5 件の防具の組に、その回の候補の武器から 2 本目と 1 本目を `optimizeWeaponSide` で選び直す。
  計算し直しは省き (`check: false`)、同じ回の入力の物を使い回して下ごしらえを 1 回にする) → `costRun`。
  `partialReady` は 1 回目の探索の途中の結果 (仕上げ 1) が出たとき。`extend` は終わった回 (満たせなかった回と、B&B を最後まで回り終えた回
  (`search.extendable` が false) を除く) を延長してもう一度合わせる。予算は延長する回 (と下の足す回) に上のとおり配る
  (最後まで回り終えた回には配らない。足す回は、仕事量の予算の Job では元の回の予算のまま回り、持ち時間はほかの回だけで分ける。
  `extendable` なのに `extend` が false を返した回は並びから外し、受け取った予算は後の回に回す)。
  武器 2 本の案では `extend` が「2 本目の武器で倒す相手だけ」を見た回 (`two-focus:<相手の key>`。重み = いまの最良の組での H_i / D_i²・部位の割合はそのまま) を 1 つ足し、
  その回の上位も 2 本の合わせにかける (`docs/RECOMMEND_DESIGN.md` 3.3 節の 4。前の組も残るので、良くなったときだけ上位が入れ替わる)。
  回が全部終わったあと (合わせ・`costRun`・延長の途中も) の `result()` は合わせた結果 (延長中は前の結果のまま)。合わせの途中でやめたら、それまでに合わせた分で出す。
  - `result()` = `{status: 'partial'|'done'|'stopped'|'cancelled'|'infeasible'|'error'|'blocked', results, infeasible, warnings, stats: {elapsedMs, mergeMs, twoWeaponsMs, extended, runs: [{key, label, status, ms, stats, budget}]}, quality: 'heuristic', merge, costOfDefense, singleWeapon, twoWeaponsGain, extendable}`。
    `extendable` = 「続けて探す」で続ける所があるか (延長できる回か、2 本目の相手に合わせた回を足せる。`extend` が true を返すか。2026-10-22)。
    `stats.runs[].budget` = 持ち時間から受け取った予算 (いちばん新しい回・延長の分。入力の予算のまま回した回は `null`)。
  - `results[]` = 探索の結果に `score: {kind: 'damage'|'combos', value, better}`・`perSubject: [{key, name, value, combos, weapon: 1|2}]`・`combosTotal`・
    `perGroup` (無ければ計算し直す)・`weapons`・`builds` (武器 2 本なら 2 つ。防具・護石は共通)・`defense` (`defenseCheck`。2 本目は `defense2`)・
    `gamma: [{part, monsterId, name}]`・`baseline` (`baselineView` の形 `{kind, value, T, combos, perGroup}`)・`vsBaselinePct`・`run` を足したもの。守りを満たす組を先に、その中で score の順
    (属性やられの耐性が 20 に届かない組は下)。同じ組 (武器・防具・護石。武器 2 本は 2 本とも) は 1 件にまとめる (珠だけ違う組は良い方)。
  - `baseline` (いまの装備) は、探索が返した `baseline` → 無ければ `runs[0].input.current` を探索と同じ式 (`evaluateBuild`・同じ発動率) で計算 →
    それも無ければ Plan の `current` の順に使う。`baseline.value` は `score.value` と同じ単位: 1 体 = 期待値、多頭 = いまの装備の T、
    体力が全員分からない多頭 = 期待値の調和平均 (= 相手の数 / T。2026-10-22 に直した。前は T を入れていて、画面の差が桁違いになった)。
    `combos` = 相手ごとに切り上げた回数の合計 (体力の分からない相手がいれば null。人数の倍率を掛けた体力で数える。結果の `combosTotal` と同じ)。
  - `vsBaselinePct` = `vsBaselinePct(score, baseline)`: 期待値は「結果 / 基準 − 1」(+ なら火力が高い)、回数は「基準の T / 結果の T − 1」
    (+ なら回数が少ない)。画面は `resultRows` で、いまの装備が探し始めた時のままのときだけ行の `baseline` を使う (`docs/UI_API.md`)。
  - 探索の警告 `weapons-sieved` (武器を絞った本数) は回ごとに数が違うので 1 行にまとめる (`keptMin`〜`keptMax`。「1〜3 本に絞って (回ごとに違います)」)。
  - `costOfDefense = {kind, main, free, pct (≤ 0 = 火力 −x%), rawPct, approx: true}`。`twoWeaponsGain = {combos, text: '武器 1 本で通すと 約 +n 回'}`。
    `pct` は期待値なら「守りあり / 守りなし − 1」、回数なら「守りなしの T / 守りありの T − 1」(どちらも守りのぶん悪くなると負)。
- `baselineView(subjects, {value, perGroup})` → 結果の `baseline` の形 (上)。計算できない相手がいれば null。
  `vsBaselinePct(score, baseline)` → 差 (%) か null (単位が違う)。`planBaseline(job, build, {index, effects | skillEffects, motions})` →
  `build` の基準を Job の 1 回目の入力 (相手・発動率・コンボ) で `evaluateBuild` して `baselineView` にしたもの (画面のスレッドで、
  結果の組を装備に入れたあとの「いまより」を出し直すのに使う。索引には入力の端末の武器・護石を足す)。
- `rerankMulti(results, subjects, {twoWeapons})`: T = Σ 体力_i / 期待値_i (武器 2 本は相手ごとに良い方) の小さい順。1 体なら期待値の高い順 (`score.kind: 'damage'`)。
  全員の体力が分からなければ期待値の調和平均を `damage` として出す (並びは T と同じ)。
- `defenseCheck(build, requirements, index, effects)` → `{ok, rows: [{key, label, kind, status: 'ok'|'mitigated'|'missing', meets, have, need, negateLevel, mitigateLevel, on, via, elements: [{element, total, ok, short}], text}], resist}`。
  属性やられは「属性やられ耐性が無効の Lv」か「全部の属性の耐性の合計 ≥ 20」で ok。`ok` はオンの行が全部 `meets`。
- `resistTotals(build, index, effects)` → `{fire, water, thunder, ice, dragon}` = 防具 5 部位の `resist` の和 + 耐性スキル (`rules.resistSkills`)。
  限界突破で耐性は変わらないものとして計算する (分からない)。
- `gammaExclusions(targetData, archTemperedHunted)` → `{armor, charmsFixed, labels: [{monsterId, name, hunted, armorSets, armorIds, charmFixedIds, certificate, groupSkills}], notes}`。
  `gammaIndex(targetData)` → `{armor: {id: {monsterId, name}}, charmsFixed: {...}, monsters}` (hunt.js の `gammaIndex` をそのまま出している。下の hunt.js の追記)。
- `jobKey(job, {dataVersion})` = Job の入力 (予算を除く) の 16 桁のハッシュ。

## search.js と search/ (段階 2。担当: solver)

装備探索 (2026-10-21 実装)。所持護石などで、期待値 (`comboExpected` を部位の割合で加重平均) が高い装備一式を探す。
設計と測った値は `docs/SEARCH_DESIGN.md` (3 章が API・10 章が実装の記録)。DOM も Worker も知らない純粋な JS で、import は相対パスだけ
(Worker から読むため)。Worker は `app/search_worker.js`。

| ファイル | 中身 |
|---|---|
| `search.js` | 入口: `createSearch(input, data)`・`optimizeWeaponSide(input, fixed, data, {score, N})` (武器の側だけを選び直す)・`gammaIndexOf(targetData)` (歴戦王の素材の印)・`PHASES`・`DEFAULT_BUDGET_MS` (6000)・`MISMATCH_REL` (1e-9)・`PREMISE_WARNINGS` |
| `search/evaluator.js` | `makeEvaluator(o)` 速い評価器 (Lv の並び → 期待値)。damage.js の式を写している (直したら両方。`tests/search_eval.test.mjs`) |
| `search/problem.js` | `prepare(data, o)` 下ごしらえ・`gainTable`・`concaveSlopes` (増え方の表) |
| `search/solver.js` | `BnbSolver` ビーム・B&B・葉の珠詰め・仕上げ・武器も探すときの 2 段のふるい・シリーズ/グループの必須の部位の割り当て・`MEMO_LIMITS` (覚えの上限) |
| `search/realize.js` | `realizeEntry` (結果 → 装備一式。γ を避けて類の代表を選べる)・`checkBuild` (computeBuild + comboExpected で計算し直す)・`summarize`・`placeDecos` |

```js
import { createSearch, PHASES } from './app/model/search.js';

const search = createSearch({
  weapons: ['w0001'],              // 武器の参照の配列 (数値 = weapons_sns / 文字列 = my_weapons か extraWeapons)。'sns-all' = 片手剣全部 + 所持アーティア
  extraWeapons: [],                // 端末の所持アーティア (my_weapons の形)
  targets: [{ weight: 1, group: 'a', target: { hitzone, wound, isWound } }],  // 割合は足して 1 にそろえる。group は任意 (perGroup)
  combo, uptimes, monsterStatus, buffs,   // 火力タブと同じもの
  sharpness: null,                 // null = 自動 (匠の Lv で決め直す) / 'white' など = 固定
  required: [{ skillId, level }],  // 必須 (武器/防具/シリーズ/グループ)。知らない id は外して警告
  charms: { owned: true, extra: [], fixed: true, fixedExclude: [] },  // 所持 / 端末で足した護石 / 生産護石 / 使わない生産護石の id
  limitBreak: true,                // true/false か { head: true, ... }
  decorations: { owned: null },    // null = 全部いくつでも / { [decoId]: 個数 } (0 = 持っていない。いまは持っているか だけを見る)
  armorExclude: [],                // 使わない防具の id
  objective: 'damage',             // 'damage' | 'none' (泣シミュ型: 必須を満たす構成を K 件。value は null)
  K: 10,
  budget: { ms: 6000 },            // 打ち切り: ms = 始めてからの時間 / activeMs = 計算した時間の合計 / work = B&B で上界を求めた回数 (結果が決まる)
  mode: 'fast',                    // 'fast' | 'exact' (保証のある上界。小さい問題のテスト用)
  stopAfter: undefined,            // 'partial' = 仕上げ 1 (途中の結果) で止める
  current: state.build,            // 渡すと result().baseline = {value} (同じ式で計算した今の装備の値)
  gamma: gammaIndexOf(targetData), // 渡すと results[].gamma に「歴戦王の素材が要る」の印 (下)。同じ類に γ でないものがあればそちらを出す
  armorResistMin: { fire: 0 },     // (2026-10-24) 防具 5 部位の属性の耐性の合計の下限。相手タブの耐性の回だけ (SEARCH_DESIGN.md 2.12 節)
  floor: 1520.2,                   // (2026-10-24) これ以下の値の構成は要らない。相手タブで前の回の上位 K 番目の値 (RECOMMEND_DESIGN.md 5.3 節)
}, data);                          // data = data.js の core のデータ (index・skillEffects・motions を読む) か {index, effects, motions}

while (!search.step(80)) {         // 80ms ぶん進める。終わったら (中止・失敗を含む) true
  const p = search.progress();     // {phase, elapsedMs, partialReady, best: [{value, exact}], stats: {nodes, leaves, boundCalls, prepareMs, activeMs}}
                                   // (stats の prepareMs・activeMs は result().stats と同じ意味。下ごしらえの前は stats: {})
}
const r = search.result();         // 途中で呼んでもよい
search.cancel();                   // 次の step で止まる
search.extend({ ms: 6000 });       // 続けて探す (B&B の続き + 仕上げ 2)。続ける所が無ければ false。予算は今から数える
search.extendable;                 // 続ける所があるか (extend が true を返すか。状態は変えない。result().extendable と同じ)
```

`result()` の形 (`docs/SEARCH_DESIGN.md` 3.4 節):

| 項目 | 中身 |
|---|---|
| `status` | `'partial'` (途中。partialReady より前は results が空のこともある・stopAfter で止めた) / `'done'` (B&B を最後まで回した) / `'stopped'` (予算で打ち切り。ふつうはこれ) / `'cancelled'` / `'infeasible'` (必須を満たす構成が無いと分かった) / `'error'` (計算中の例外。warnings に code `error`) |
| `results[]` | `{rank, value, exact, weapon, build, alternatives, skills, freeSlots, check, perGroup?, gamma?}`。`build` は state.build と同じ形 (computeBuild にそのまま渡せる。限界突破は実際に使った部位だけ true)。`alternatives` = 同じ類のほかの防具・護石 (`{head: [id...], ..., charm: [ref...]}`。入れ替えても値も珠の位置も同じ)。`check = {value, relDiff, factored, errors, warnings}` は computeBuild + comboExpected の値 (`factored` = パターンが多いので因子分解の合計で出した)。`gamma` (input.gamma を渡したとき) = `[{part, armorId \| charmId, monsterId, name}]` 歴戦王の素材が要る防具・護石 |
| `infeasible` | `{missing: [{skillId, name, level, reason}]}` か null。必須を 1 つずつ外して判定し直した「同時には届かない」最小の組 |
| `warnings[]` | `{code, message}`。下の表 |
| `baseline` | `{value}` か null (`current` を渡したとき) |
| `quality` | `'exact'` (mode exact で最後まで) / `'heuristic'` |
| `extendable` | 「続けて探す」で続ける所があるか (B&B を最後まで回り終えて、2 段のふるいで外した武器も残っていなければ false。mode exact は false)。画面はこれが false なら「続けて探す」を出さない (2026-10-22) |
| `stats` | `{prepareMs, elapsedMs, activeMs, phases: [{name, endMs, best}], classes: {head: 42, ...}, charms, relevantSkills, weapons: {before, after}, nodes, leaves, boundCalls, memoClears, firstSolutionMs, sieve}`。`sieve` = 武器も探すときの 2 段のふるい `{combos, measured, weapons: [dfs を回した武器の参照]}` か null。`phases` には dfs の頭のふるいが `sieve` として入る (progress().phase は dfs のまま) |

警告のコード: `placeholder-uptimes` (仮置きの発動率で探した。`groups` に条件の id) / `exclusive-over-100` / `blunt-handicraft` /
`non-monotone` (`skillIds`。Lv を上げると火力が下がるスキルがある) / `budget-stopped` / `evaluator-mismatch` (`count`。comboExpected の
値で並べ直した) / `weapons-sieved` (`kept`・`rest`・`total` (探した武器の数)・`before` (同じ性能かそれ以下の武器を除く前の数。画面の
「n 本から探します」と同じ)。武器も探すとき、見込みの高い武器に絞って dfs を回した。続けて探すと残りも回す) /
`unknown-skill` / `unknown-weapon` / `required-over-max` / `unknown-sharpness` / `realize-failed` / `check-failed` (comboExpected が例外に
なった候補を外した) / `error`。`message` はそのまま画面に出せる日本語。
- `exclusive-over-100`・`blunt-handicraft`・`non-monotone` は上界の前提が崩れる入力 (`PREMISE_WARNINGS`。`docs/SEARCH_DESIGN.md` 4 章の 6)。
  fast はそのまま動く (近似) が、mode `exact` で最後まで回っても `quality` は `'heuristic'` になる。
- (2026-10-21 2b) `over-max-patterns` (comboExpected が MAX_PATTERNS で計算できない候補を外して繰り上げた) は無くした。comboExpected が
  因子分解の合計を返すようになったため (damage.js の節)。

- 入力の誤りで続けられないもの (武器が無い・相手が無い・コンボが無い・データが無い) は `createSearch` が例外を投げる。ほかは warnings。
- 計算し直し (`check`) は result() のたびに上位 K 件ぶん comboExpected を呼ぶ (同じ構成は覚える)。仮置きの発動率のままだと 1 件 20〜30ms (Node)。
- テスト用の入力: `beam: [幅, ...]` (ビームの幅) / `dominance: false` (優越の除去をしない。総当たりと同じ数え方になる) /
  `sieve: false` (武器も探すときの 2 段のふるいをしない) か `{top, weapons}` (測り直す防具・護石の組の数 既定 50・dfs を回す武器の数 既定 3) /
  `tight: false` (締めた上界を使わない。前の上界と比べる用。`docs/SEARCH_DESIGN.md` 2.4 節) か `solver.js` の `TIGHT` の一部を差し替えるもの /
  `spread: false` (護石の類をばらして探す工夫をしない。前と比べる用。`docs/SEARCH_DESIGN.md` 2.13 節。2026-10-24)。
- (2026-10-24) `armorResistMin` を渡すと、防具 5 部位の耐性の合計が下限に届かない構成を出さない (届かないなら `infeasible` で、`missing` は
  `{skillId: null, name: '防具の火耐性の合計', element, min, reason}`)。`alternatives` の防具も、入れ替えて下限を割るものは出さない。
  `floor` は fast の damage だけ。最後まで回って 1 件も無くても `infeasible` にしない (floor より上が無いだけのため)。
- 必須のシリーズ/グループスキルは、残りの部位を「どのボーナスに数えるか」割り当てて判定する (部位の取り合い・ゴグα/β の 2 つのシリーズも
  見る。満たせない組は最初の上界で分かる。`docs/SEARCH_DESIGN.md` 2.8 節・11 章)。

歴戦王の素材 (γ 防具・狩猟証γ の護石。`docs/SEARCH_DESIGN.md` 4 章の 4):

```js
import { gammaIndexOf } from './app/model/search.js';
const gamma = gammaIndexOf(targetData);  // data.js の target データ / monsters.json 丸ごと / monsters の配列
// gamma = {armor: {[armorId]: {monsterId, name}}, charmsFixed: {[charmId]: {monsterId, name}},
//          monsters: [{monsterId, monster, name: 'アルシュベルド（歴戦王）', armorIds, armorSets, charmFixedIds, certificate, groupSkills}]}
// (表を作るのは hunt.js の gammaIndex。gammaIndexOf はそれをそのまま返す。3f でまとめた)
// 倒していない歴戦王の分を外す: input.armorExclude に monsters[i].armorIds、input.charms.fixedExclude に monsters[i].charmFixedIds
```

- `armor` / `charmsFixed` の形は recommend.js の `gammaIndex` と同じ (印の `name` は個体の名前)。いまのデータでは γ 防具 25 個・護石 10 個で、
  ヌシの魂 (グループ) の防具は全部 γ (全部外すとヌシの魂は武器の 1 部位だけ。必須にしていれば `infeasible` の理由に「使わない防具」と出る)。

武器の側だけを選び直す (`docs/RECOMMEND_DESIGN.md` 3.3 節・5.4 節。武器 2 本の案で、1 回目の防具の組に 2 本目を合わせる):

```js
import { optimizeWeaponSide } from './app/model/search.js';

const list = optimizeWeaponSide(input, fixed, data, { score: (perGroup, value) => -(H.a / perGroup.a + H.b / perGroup.b), N: 5 });
// input = createSearch の入力 (weapons = 候補の武器、targets[].group、required など。防具・護石の項目は使わない)
// fixed = {armor: {head, ...}, charm, limitBreak, decorations: {head, ..., charmArmor, charmWeapon}} (decorations.weapon は無視)
// → [{weapon, decorations: {weapon: [珠の id | null]}, build, perGroup, value, score,
//     check: {value, perGroup, relDiff, factored, error, errors} | null}]   score の大きい順。武器 1 本につき一番良い珠の組 1 件
//   {check: false} で計算し直しを省く (check: null)
```

- 武器の珠は武器スロットの分だけ選ぶ。護石の武器用スロットの珠は `fixed` のまま (2 本で共有する扱い・未確認)。必須を満たさない組は出さない。
- 候補の武器は支配除去 (`problem.js`) をしてから測る (`input.dominance: false` で外せる)。刈り込みは「武器の珠で届く Lv の箱の上」の
  score なので、**score は各 group の値について単調** (値が上がって下がらない) であること。既定の score は全体の加重平均 `value`。
- 同じ `input` の物で何度も呼ぶと下ごしらえ (評価器・武器の珠の組) を使い回す (WeakMap)。片手剣 95 本が候補で、最初の 1 回は
  0.2〜1 秒、2 回目から防具の組 1 つあたり 約 10ms (仮置きの発動率 0%) / 約 50ms (仮置き 50% のまま) (Node。目標の 0.1 秒以内。
  `node --expose-gc tools/bench_search.mjs --weapon-side` で測る。値は `docs/SEARCH_DESIGN.md` 11 章)。
  返す前の計算し直し (`check`) は 1 件 50〜100ms (仮置き 50% のまま) かかるので、途中で何度も呼ぶときは `{check: false}` で省き、
  最後に出す物だけ確かめる (省くと `check: null`)。`build` は computeBuild にそのまま渡せる。
- 総当たり (候補の武器 × 武器の珠の全組) との一致は `tests/search_weapon_side.test.mjs`。

Worker のメッセージ (`app/search_worker.js`。`docs/SEARCH_DESIGN.md` 3.5 節・`docs/RECOMMEND_DESIGN.md` 5.5 節):

| 向き | type | 中身 |
|---|---|---|
| 画面 → Worker | `start` | `{id, job}` (`job = {kind: 'search', input}` か planToJob の Job `{kind: 'plan', runs, costRun, merge, K, subjects, requirements, gamma, baseline, ...}`)。`{id, input}` だけでもよい (= search) |
| 画面 → Worker | `cancel` / `extend` | `{id}` / `{id, budget}` |
| Worker → 画面 | `ready` | 作られたらすぐ data/*.json を読み、索引を作り終えたら 1 回 (以後の探索で使い回す) |
| Worker → 画面 | `progress` | `{id, phase, elapsedMs, best: [値...], bestKind?, run?}` (段階か plan の回 `run.index` が変わったときと 0.5 秒ごと。`bestKind` は plan のとき `'damage'` / `'combos'`) |
| Worker → 画面 | `partial` / `done` | `{id, result}`。同じ区切りで終わったら partial は送らず done だけ。cancel の後も done (status `cancelled`)。続ける所の無い extend には今の結果で done をもう一度 |
| Worker → 画面 | `error` | `{id, message}` (データを読めない・入力の誤り・知らない探し方) |

- `job.kind: 'plan'` は本物の `recommend.createPlanRunner(job, data, {createSearch, optimizeWeaponSide})` で回す (2026-10-21 3f でつないだ。
  `tests/search_worker.test.mjs` が S1z の Job を Worker で回して確かめる)。

- 80ms ごとに `setTimeout(0)` で手を離して cancel を受ける。新しい `start` が来たら前の探索は捨てる (前の id のメッセージはもう来ない)。
- `job.kind === 'plan'` は `recommend.createPlanRunner(job, data, {createSearch, optimizeWeaponSide})` を呼ぶ (recommend.js に無ければ
  「準備中」の error)。`data` は Worker が読んだ core のデータ (生データ + `index`)。runner の `progress().run` はそのまま progress に載せ、
  `partialReady` で partial を 1 回送る。5.3 節の形の作り物で確かめたテストは `tests/search_worker_plan.test.mjs` (recommend.js を
  `module.registerHooks` で差し替える)。
