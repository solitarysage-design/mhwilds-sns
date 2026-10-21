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
出典と未確定事項は `docs/sources/damage.md`。**秒あたり DPS は出さない** (技の時間が非公開)。

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

### 条件つきスキルの発動率 (条件ごと)

発動率は**スキルごとではなく条件ごと**に持つ。条件の一覧は `skill_effects.json` の `rules.conditionGroups`
(並びは画面に出す順)。同じ意味の条件で動くスキルは 1 つのグループにまとまっていて、1 つの発動率が全部に効く
(例: `enraged` = モンスターが怒っている → 挑戦者・巨戟龍の黙示録)。スキルの `skills[].uptime` は使わない。

| グループの種類 | `uptimes` に入れる値 | 例 |
|---|---|---|
| `binary` (発動している / していない) | 0〜1 の数 (true/false も可) | `{ enraged: 0.7, hpFull: 0.3 }` |
| `categorical` (段階がある) | `{段 id: 割合}`。渡さない段は 0、残りが「未発動」の段 (`offState`)。合計が 1 を超えたら縮める (警告)。数だけを保存する入れ物向けに平らなキー `"<グループ id>.<段 id>"` でもよい (入れ子の形があればそちら優先) | `{ chain: { hit1to4: 0.2, hit5plus: 0.7 } }` か `{ 'chain.hit1to4': 0.2, 'chain.hit5plus': 0.7 }` |

- 既定値は各グループの `defaultUptime`。`placeholder: true` のものは根拠の無い**仮置き** (`uptimeBasis` にそう書いてある)。
- `exclusiveWith` の組は同時に起きない条件 (体力満タン `hpFull` と 赤ゲージあり `redHp`・体力 35% 以下 `hpLow`)。
  全パターンの加重平均で「両方発動」に重みを付けず、それぞれの発動率は入れた値のまま保つ。
  合計が 100% を超えて保てないときは、**本人が入れた条件 → 根拠のある既定値 → 仮置き** の順に保ち、後の方 (仮置きなど) を
  減らして警告 `exclusive-conflict` (`groupId` = 減らした条件)。同じ扱いどうしは並びの後の条件を減らす。
- `sources` のある条件 (2026-10 時点では狂竜症 `frenzy`: `{skillIds: [黒蝕竜の力], monsterStatus: ['frenzy'], label, inactiveText}`) は、
  そのスキルを装備しておらず、`input.monsterStatus` にその状態異常も無いときは「発動していない」100% にする
  (入れた発動率は使わない)。`monsterStatus` を渡さない (分からない) ときは決めつけない。
  そのときの `conditions[]` の要素は `inactive: true`・`inactiveReason` (画面に出せる日本語)・`placeholder: false`。
  判定は `conditionSourceMissing(def, skillIdSet, monsterStatus)`。
- 関係の無い条件どうしは独立と仮定する。組み合わせ (パターン) が `MAX_PATTERNS` (16384) を超えたら例外。
- スキルの効果: `levels[]` の値は `activeStates` の段で出る主効果。`levels[].byState` に段ごとの効果があればその段ではそちら
  (連撃の 1〜4 ヒット段、黒蝕竜の力の感染中)。それ以外の段では効果なし。
- `conditionGroup` の無い条件つきスキル (古いデータ・テスト用) は、そのスキルだけのグループ `skill:<skillId>` になる
  (既定はスキルの `defaultUptime`)。知らない `conditionGroup` 名なら警告 `unknown-condition-group`。

| id | 中身 | 動くスキル (2026-10 時点) |
|---|---|---|
| `hpFull` / `redHp` / `hpLow` | 体力が満タン / 赤ゲージあり / 35% 以下 (満タンとは同時に起きない) | フルチャージ / 逆恨み / 火事場力 |
| `enraged` | モンスターが怒っている | 挑戦者・巨戟龍の黙示録 |
| `chain` (段階) | 連撃: 未発動 / 1〜4 ヒット段 / 5 ヒット以降段 | 連撃 (5 段以降が主効果)・兇爪竜の力 (1〜4 段と 5 段以降) |
| `frenzy` (段階) | 狂竜症: かかっていない / 感染中 / 克服した後 | 黒蝕竜の力 (感染中と克服後で違う)・無我の境地 (克服後) |
| そのほか | 力の解放・スタミナ満タン・武器出し直後・ジャストガード後 など 1 条件 1 グループ | `rules.conditionGroups[].skills` を見る |

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
// r.steps[] … 技ごとの内訳 {move, name, isWound, total, physical, element, extra}
// r.conditions[] … このスキル構成で効く条件グループ (画面の発動率の入力欄に使う)
//     {id, label, type, states: [{id, label}], offState, uptime, probs, defaultUptime, fromInput,
//      placeholder (使った値が仮置きなら true), uptimeBasis, exclusiveWith, skills: [{skillId, name}], note,
//      inactive (条件のもとが無いので 0%), inactiveReason}
// r.warnings[] … {code, message, ...}。message はそのまま画面に出せる日本語
// r.unsupported[] … 計算に入れていないスキル {skillId, name, level, reason} (画面で「未対応」)
// r.lowConfidence[] … 確度 low の値で計算したスキル {skillId, name, level, confidence, reason} (画面で「未確定」)

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
| `hitDamage(hit, stats, {hitzone, isWound, sharpness, rules})` | 1 ヒット (×count) の期待値 `{physical, element, extra, total, affinity, critExp}` |
| `resolveSkills(skills, effects)` | スキルを `active` / `unsupported` / `unknown` / `lowConfidence` に分ける |
| `resolveConditions(active, effects, uptimes, {skillIds, monsterStatus}?)` | 使う条件グループと発動率 `{active, groups, warnings}` (4 番目は条件のもとの確かめ) |
| `conditionSourceMissing(def, skillIdSet, monsterStatus)` | 条件のもと (`sources`) が装備にも相手にも無いか |
| `enumeratePatterns(groups)` | 条件の段の組み合わせと重み `{patterns: [{weight, states: {グループ id: 段 id}}], warnings}` (同時に起きない条件は本人の値を先に保つ) |
| `conditionGroupDefs(effects)` | `rules.conditionGroups` を id → 定義 の Map に (exclusiveWith は両側にそろえる) |
| `aggregateModifiers(effectList, elementType, buffs)` → `computeStats(weapon, mods, rules)` | 1 パターン分の攻撃力・会心率・属性値 |
| `isWoundOnlyHit(hit)` | 傷口でだけ出るヒットか |
| `critExpectation(aff, critMul)` / `critElementExpectation(aff, critElementMul)` / `clampAffinity(aff)` | 会心まわり |
| `sharpnessMultipliers(color)` / `effectiveElement(base, mul, add)` / `effectiveAttack(base, mul, add)` | 補正・上限 |
| `mergeRules(effects)` / `DEFAULT_RULES` / `SHARPNESS_ORDER` / `ELEMENTAL_TYPES` / `MAX_PATTERNS` | 定数 (rules は `skill_effects.json` の値が優先) |

警告のコード: `bad-uptime` (発動率が読めない → 既定値) / `unknown-state` (知らない段) / `uptime-over-100` (段の合計が 100% 超え →
縮める) / `exclusive-conflict` (同時に起きない条件の合計が 100% 超え) / `unknown-condition-group` / `no-wound` /
`wound-only-hits-skipped`。

### 式

- 攻撃力 = 武器攻撃力 × min(乗算の積, 4.0) + min(加算の和, 400) (乗算が先)
- 会心率 = 武器 + スキル + 弱点特効 (物理肉質 45 以上) + 傷口分 (傷口のときだけ) → -100〜100 で切る
- 物理 = 攻撃力 × MV/100 × 物理肉質/100 × 斬れ味物理 × 会心期待値 × 心眼 (肉質 44 以下) × 飛燕 (`hien` のヒット) × 鈍器使い
- 属性 = 属性値/10 × 技の属性補正 × 属性肉質/100 × 斬れ味属性 × 会心撃【属性】期待値 (無ければ 1、マイナス会心は掛けない)
- 属性値 = 元 × min(乗算の積, 2.3) + min(加算の和, 400) (攻撃と同じく倍率と加算を別々に切る。確度 medium)。
  `elementType` 付きの効果は武器の属性が一致するときだけ
- 追加ダメージ (灼熱化) = 確率 × (固定 + 属性/10 × その属性の肉質/100)。`additionalDamage` のヒットだけ。クールタイムは入れない
  (火竜の力の値は読み方が 2 通りあり確度 low。計算に使うと `lowConfidence` に入る)
- 盾のヒットは属性 0 (`elementRate: 0`)。斬れ味補正は `sharpnessMul` が true のヒットだけ
