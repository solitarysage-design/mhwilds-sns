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
}, data);
```

返り値:

| 項目 | 中身 |
|---|---|
| `ok` | `errors` が空なら true |
| `errors` | `[{code, message, target?, index?, decorationId?}]`。入れられない装飾品はスキルに数えない |
| `warnings` | `[{code, message}]` (`unknown-skill` / `unknown-set-bonus` / `unknown-group-bonus`) |
| `skills` | `[{skillId, name, kind, level, rawLevel, maxLevel, overLimit, sources}]`。`level` は上限 Lv で切った値、`rawLevel` は切る前の合計。シリーズ/グループの発動分も入る。Lv の高い順 |
| `skillLevels` | `{skillId: level}` (切った後)。damage.js に渡す用 |
| `setBonuses` | `[{bonusId, name, skillId, pieces, from, level, active, ranks, next}]`。`next` は次の段階 `{pieces, level}` か null |
| `groupBonuses` | `[{bonusId, name, skillId, pieces, from, required, active, level}]` |
| `slots` | `{weapon: [{index, size, decorationId, decorationName?, decorationSize?}], head: [...], ..., charmArmor, charmWeapon}` |
| `slotSummary` | `{weapon: {total, used, free, freeBySize: {1,2,3}}, armor: {...}}`。武器用 = 武器 + 護石の武器用、防具用 = 防具5部位 + 護石の防具用 |

決まりごと:

- 武器用の装飾品は武器スロットと護石の武器用スロットだけ、防具用は防具スロットと護石の防具用スロットだけに入る。低 Lv の珠は高 Lv のスロットに入る。
- エラーのコード: `deco-too-large` (珠の Lv > スロット Lv) / `deco-kind-mismatch` (武器用↔防具用) / `slot-missing` (そのスロットが無い・Lv0) / `no-equipment` (装備が無い所に珠) / `armor-part-mismatch` (頭に胴防具など) / `unknown-weapon` / `unknown-armor` / `unknown-charm` / `unknown-decoration` / `unknown-target`。
- シリーズスキルは部位数で段階を決める (`ranks` の `pieces` 以上で `level`)。グループスキルは `pieces` (3) 以上で発動。
- 防具の `setBonusIds` (配列) があればそれを全部数える (ゴグα/β は 巨戟龍の黙示録 + 部位ごとのシリーズスキルの 2 つ)。無ければ `setBonusId`。
- 武器の `setBonusId` / `groupBonusId` (巨戟アーティアで付けたもの。my_weapons.json) は **1 部位** として数える。
- my_weapons の要素で `slots` / `skills` が無いものは `baseWeaponId` の武器 (weapons_sns) から補う。
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
| `skills` | `[{skillId, level, uptime?}]` か `{skillId: level}` | `build.js` の `computeBuild(...).skills` / `.skillLevels` をそのまま渡せる |
| `effects` | `data/skill_effects.json` 丸ごと | |
| `motions` | `data/motions_sns.json` 丸ごと | |
| `combo` | `data/combos_sns.json` の `combos[]` の 1 件、または技 id の配列 (`['slash_1', 'slash_2']`) | |
| `target` | `{hitzone: {slash, blunt, fire, water, thunder, ice, dragon}, wound?: {…}, isWound?: bool}` | `monsters.json` の `parts[].hitzone` / `parts[].wound` (0〜100) |
| `buffs` | `{attackAdd, attackMul, affinityAdd, elementAdd, elementMul}` (省略可) | アイテムなど人が足す分 |

- `uptime` (0〜1) は条件つきスキルの発動率。省略時は `skill_effects.json` の `defaultUptime` (根拠が無いものは 0.5 の仮置き)。
- 条件つきスキルは発動/非発動の全パターンを**独立と仮定**して加重平均する (変動するものが 14 個まで)。
- コンボの段に `onWound: true` があるか `target.isWound` なら、その段は `target.wound` の肉質と弱点特効の傷口分で計算する。

### 主な関数

```js
import { comboExpected, skillContribution } from './model/damage.js';

const input = { weapon, sharpness: 'white', skills: build.skills, effects, motions,
                combo: combos.combos[0], target: { hitzone: part.hitzone, wound: part.wound } };

const r = comboExpected(input);
// r.total / r.physical / r.element / r.extra … コンボ 1 回の期待ダメージ (extra は灼熱化などの追加分)
// r.steps[] … 技ごとの内訳 {move, name, total, physical, element, extra}
// r.unsupported[] … 計算に入れていないスキル {skillId, name, level, reason} (画面で「未対応」)
// r.lowConfidence[] … 確度 low のスキル (画面で「未確定」)

const c = skillContribution(input);
// c.vsNoSkillsPct … スキルなし比の上昇 (%)
// c.removeEach[] … {skillId, name, level, total, dropPct}  そのスキルだけ外したときの低下 (%)、大きい順
// c.perLevel[]   … {skillId, name, level, maxLevel, levels: [{level, total, gainPctVsNone, gainPctVsPrev}]}
```

| 関数 | 用途 |
|---|---|
| `comboExpected(input)` | 代表コンボ 1 回の期待値 |
| `skillContribution(input)` | スキルなし比・1 つ外したときの低下・Lv ごとの上昇 |
| `hitDamage(hit, stats, {hitzone, isWound, sharpness, rules})` | 1 ヒット (×count) の期待値 `{physical, element, extra, total, affinity, critExp}` |
| `resolveSkills(skills, effects)` | スキルを `active` / `unsupported` / `unknown` / `lowConfidence` に分ける |
| `aggregateModifiers(effectList, elementType, buffs)` → `computeStats(weapon, mods, rules)` | 1 パターン分の攻撃力・会心率・属性値 |
| `enumeratePatterns(active)` | 条件つきスキルの発動パターンと重み |
| `critExpectation(aff, critMul)` / `critElementExpectation(aff, critElementMul)` / `clampAffinity(aff)` | 会心まわり |
| `sharpnessMultipliers(color)` / `effectiveElement(base, mul, add)` / `elementCap(base)` / `effectiveAttack(base, mul, add)` | 補正・上限 |
| `mergeRules(effects)` / `DEFAULT_RULES` / `SHARPNESS_ORDER` / `ELEMENTAL_TYPES` | 定数 (rules は `skill_effects.json` の値が優先) |

### 式

- 攻撃力 = 武器攻撃力 × 乗算の積 + 加算の和 (乗算が先)
- 会心率 = 武器 + スキル + 弱点特効 (物理肉質 45 以上) + 傷口分 → -100〜100 で切る
- 物理 = 攻撃力 × MV/100 × 物理肉質/100 × 斬れ味物理 × 会心期待値 × 心眼 (肉質 44 以下) × 飛燕 (`hien` のヒット) × 鈍器使い
- 属性 = 属性値/10 × 技の属性補正 × 属性肉質/100 × 斬れ味属性 × 会心撃【属性】期待値 (無ければ 1、マイナス会心は掛けない)
- 属性値 = min(元 × 乗算 + 加算, max(元 + 400, 元 × 2.3))。`elementType` 付きの効果は武器の属性が一致するときだけ
- 追加ダメージ (灼熱化) = 確率 × (固定 + 属性/10 × その属性の肉質/100)。`additionalDamage` のヒットだけ。クールタイムは入れない
- 盾のヒットは属性 0 (`elementRate: 0`)。斬れ味補正は `sharpnessMul` が true のヒットだけ
