# mhwilds-sns 設計と取り決め

モンハンワイルズ (PS5) の片手剣ビルドを iPhone のブラウザで組むための静的 Web アプリ。
GitHub の公開リポから Pages (ブランチ配信・`.nojekyll`) で配る。ビルド工程は持たない。

## 全体の形

```
index.html              エントリ (import map で app/vendor を引く)
manifest.webmanifest    ホーム画面に追加用
sw.js                   Service Worker (オフライン・更新検知)
app/
  vendor/               preact / preact-hooks / htm を同梱 (CDN に依存しない)
  model/                計算の純粋関数 (DOM に触らない。node --test でテストする。Worker からも読むので import は相対パスだけ)
    damage.js           ダメージ期待値
    build.js            装備一式 → スキル合計 (シリーズ/グループ発動を含む)
    charms.js           護石の検証・泣シミュ形式の書き出し/読み込み
    weapon.js           武器の解決・斬れ味の自動 (段階 2 の前提で equip_logic.js から移した)
    hunt.js             相手の体力・討伐までの回数・個体の肉質・クエストの選び方 (段階 3)
    recommend.js        相手に合わせたおすすめ・多頭の重み・守りのチェック (段階 3)
    search.js, search/  装備探索 (段階 2。evaluator / problem / solver / realize)
  search_worker.js      装備探索の Web Worker (段階 2)
  ui/                   画面 (Preact + htm)
  store.js              IndexedDB (キーは必ず "mhwilds-sns:" 接頭辞。同じ github.io オリジンに他のサイトがある)
  data.js               data/*.json の読み込み
data/                   正規化済みデータ (tools/ が生成。手で直さない。charms.json と my_weapons.json は例外)
tools/                  Python のデータ生成スクリプト。生データのキャッシュは tools/.cache/ (git 管理外)
tests/                  node --test (*.test.mjs) と Playwright のスモークテスト
docs/                   設計・出典・未確定事項
```

- 計算はすべてブラウザ内。サーバーも API キーも持たない。
- ゲームのアイコン画像は載せない (カプコンの二次創作ガイドラインで素材のそのまま使用は対象外・禁止事項)。数値と名前だけ。
- iPhone Safari (ホーム画面 Web アプリ) が主な実行環境。幅 375px で崩れないこと。

## データの出典 (docs/SOURCES.md に詳細)

| データ | 出典 | 備考 |
|---|---|---|
| 防具・スキル・装飾品・片手剣・固定護石・モンスター基本肉質 | wilds.mhdb.io `/ja/` | 2026-04-15 取込。スキルは `gameId` で他ソースと結合 |
| スキルの内部数値・モーション値・斬れ味/会心補正・鑑定護石の抽選表 | GitHub `dzxrly/MHWS-in-json` (MIT) | ゲーム版 1.42.0.2。スナップショットを固定して使う |
| 咆哮/風圧/振動/属性やられ・クエスト構成 | monsterhunterwiki.org Bucket API (CC BY-SA 4.0) | 派生データは同ライセンス表記 |

Kiranico と Game8 は規約が不明・禁止のためデータの取り込み元にしない (照合用に人が見るのは可)。

## データの形 (契約)

ID は MHDB の数値 ID を使う。スキルは `skillId` (MHDB の skill id) で参照する。名前は日本語。
全ファイルの先頭に `{"meta": {"source": [...], "generatedAt": "...", "gameVersion": "..."}, ...}` を持つ。

### data/skills.json
```json
{"meta": {...}, "skills": [
  {"id": 1, "gameId": 705317568, "name": "攻撃", "kind": "weapon|armor|set|group",
   "maxLevel": 5, "decoSize": 1, "levels": [{"level": 1, "name": "", "description": "..."}]}
]}
```
- `kind`: weapon=武器スキル (武器・武器用装飾品・護石)、armor=防具スキル、set=シリーズスキル、group=グループスキル。
- `decoSize`: そのスキルの単体装飾品のスロット Lv (無ければ null)。鑑定護石の上限 Lv の検証に使う。

### data/armor.json
```json
{"meta": {...}, "armor": [
  {"id": 10, "name": "アルシュヘルムβ", "part": "head|chest|arms|waist|legs", "rank": "low|high",
   "rarity": 8, "slots": [3, 1, 0], "skills": [{"skillId": 1, "level": 1}],
   "setBonusId": 3, "groupBonusId": 7, "defense": {"base": 0, "max": 0},
   "resist": {"fire": 0, "water": 0, "thunder": 0, "ice": 0, "dragon": 0}}
]}
```
- `slots` は常に長さ 3 (空きは 0)。
- (追記 2026-10-21) 上の例に無い項目:
  - `setBonusIds`: その部位が数に入る全シリーズスキルの id の配列 (ふつうは 0〜1 個)。ゴグα/β は 2 個で、先頭がシリーズの
    全部位に共通のもの (= `setBonusId`)。build.js はこれがあれば全部数える (無ければ `setBonusId`)。
  - `armorSetId` / `armorSetName`: 防具シリーズ (MHDB の armor set の id と名前。例 `"護火竜β"`)。
  - `limitBreakable`: 限界突破 (TU4) できるか。上位 = レア5〜8 で true、下位は false。
  - `slotsLimitBreak`: 限界突破**後**のスロット (長さ 3。`slots` は限界突破前)。下位は null。
    上位でも出典が食い違って決められない防具は null で、理由を `slotsLimitBreakNote` (文字列。この場合だけある) に持つ。
    規則 (レア5 = 全枠 +1、レア6 = 先頭 2 枠 +1、上限 Lv3、レア7・8 は変わらない)・照合の結果・例は `meta.limitBreak`
    (`ruleAdd[レア度]` = 各枠に足す Lv、`cap` = 上限)。出典と判断は `docs/sources/equip.md`。

### data/bonuses.json (シリーズスキル・グループスキル)
```json
{"meta": {...},
 "setBonuses":   [{"id": 3, "name": "鎖刃竜の飢餓", "skillId": 120, "ranks": [{"pieces": 2, "level": 1}, {"pieces": 4, "level": 2}]}],
 "groupBonuses": [{"id": 7, "name": "ヌシの魂", "skillId": 140, "pieces": 3}]}
```

### data/decorations.json
```json
{"meta": {...}, "decorations": [
  {"id": 5, "name": "攻撃珠Ⅰ", "kind": "weapon|armor", "slot": 1, "rarity": 5, "skills": [{"skillId": 1, "level": 1}]}
]}
```

### data/weapons_sns.json (片手剣のみ)
```json
{"meta": {...}, "weapons": [
  {"id": 1059, "name": "ヴェルドロート", "rarity": 8, "attack": 190, "affinity": 5,
   "element": {"type": "fire|water|thunder|ice|dragon|poison|paralysis|sleep|blast", "value": 300} ,
   "sharpness": {"base": [r, o, y, g, b, w], "handicraftMax": [r, o, y, g, b, w]},
   "slots": [3, 3, 3], "skills": [{"skillId": 1, "level": 1}],
   "artian": false, "gogmaArtian": false, "note": ""}
]}
```
- `attack` は**係数なしの値** (片手剣で 1.4 を掛けた表示値ではない)。
- `element` は無ければ null。属性値は表示値 (ダメージ計算では /10)。
- 巨戟アーティア (破滅のキリエヴェルド×3 = 攻撃/会心/属性の激化3種) は除外しない。属性値・ランダムスキルは手入力の対象 (`data/my_weapons.json`)。
- (追記 2026-10-21) 巨戟アーティア 3 本 (id 1180〜1182) は名前が同じなので、見分けるための項目を持つ (ほかの武器には無い):
  `variant` = `"攻撃激化" | "会心激化" | "属性激化"`、`displayName` = 画面に出す名前 (例 `"破滅のキリエヴェルド (攻撃激化)"`)。

### data/charms_fixed.json (固定護石)
```json
{"meta": {...}, "charms": [{"id": 1, "name": "痛撃の護石Ⅲ", "rarity": 6, "skills": [{"skillId": 9, "level": 3}]}]}
```

### data/talisman_rules.json (鑑定護石の検証用)
レア度ごとの「あり得るスロット構成」と「スキル枠ごとに出るスキル群と上限 Lv」。
```json
{"meta": {...},
 "rarities": {"7": {"slotPatterns": [{"armor": [1,0,0], "weapon": [0]}],
                    "skillSlots": [{"groups": [1, 2], "kinds": ["weapon"]}]}},
 "groups": {"1": [{"skillId": 1, "level": 3}]}}
```
- (追記 2026-10-21) 各レア度は `patterns` も持ち、**検証はこちらで行う** (スロット構成とスキル群は独立でないため。
  `slotPatterns` / `skillSlots` は枠ごとにまとめた要約で、枠どうしの組み合わせを表さない):
  `"patterns": [{"slotPt": 4, "armor": [2,0,0], "weapon": [0], "skillGroups": [3, 10, 0], "weight": 1}]`
  = 抽選表の 1 行。`skillGroups[i]` はスキル枠 i の群番号 (`groups` のキー。0 = その枠なし)、`weight` は同じ行が載っている回数。

### data/charms.json (所持護石・人が増やす)
```json
{"schema": 1, "charms": [
  {"id": "c0001", "name": "秘歴の護石", "rarity": 7,
   "skills": [{"skillId": 0, "name": "ガード性能", "level": 3}],
   "armorSlots": [2, 0, 0], "weaponSlots": [0],
   "source": "写真 2026-10-21", "addedAt": "2026-10-21", "note": ""}
]}
```
- `name` は人が読むため。計算は `skillId` で行う。
- 泣シミュ (wiki-db) 形式の 12 項目は **スキル1,Lv1,スキル2,Lv2,スキル3,Lv3,防具スロLv×3,武器スロLv×3** の順。

### data/my_weapons.json (所持アーティア武器・人が増やす)
```json
{"schema": 1, "weapons": [
  {"id": "w0001", "name": "破滅のキリエヴェルド (火・属性激化)", "baseWeaponId": 1182,
   "attack": 190, "affinity": 0, "element": {"type": "fire", "value": 440},
   "sharpness": [r, o, y, g, b, w], "slots": [3, 3, 3],
   "setBonusId": null, "groupBonusId": null, "note": ""}
]}
```
- 巨戟アーティアのシリーズ/グループスキルは**1部位**として数える。

### data/skill_effects.json (火力計算用の数値)
```json
{"meta": {...}, "effects": {
  "<skillId>": {"name": "攻撃", "conditional": false, "defaultUptime": 1.0,
                "levels": [{"level": 1, "attackAdd": 3, "attackMul": 1.0, "affinityAdd": 0,
                            "critMul": null, "elementAdd": 0, "elementMul": 1.0,
                            "weakPointAffinity": 0, "woundAffinity": 0, "critElementMul": null}],
                "source": "MHWS-in-json HunterSkill_xxx", "confidence": "high|medium|low", "note": ""}
}}
```
- 値の根拠と確度を必ず持つ。確度が low のものは画面にも「未確定」と出す。

- (追記 2026-10-21) `rules.conditionGroups[]` は条件ごとの発動率の定義 (`docs/MODEL_API.md`)。条件のもとがある条件
  (狂竜症) は `sources: {skillIds, monsterStatus, label, inactiveText}` を持ち、もとのスキルも相手の状態異常も無いときは 0% で計算する。

### data/motions_sns.json と data/combos_sns.json
技ごとのモーション値と属性補正、代表コンボ (技とヒット数の並び)。日本語の技名。
- (追記 2026-10-21) コンボは `description` (画面に出す短い説明。やさしい日本語) と `note` (データの根拠。画面では「くわしく」の
  中にだけ出す) を分けて持つ。どちらも `tools/effects_motions.py` の `COMBOS` で書く。

### data/monsters.json
```json
{"meta": {...}, "monsters": [
  {"id": 20, "name": "アルシュベルド", "baseHealth": 0, "variants": ["tempered", "arch-tempered"],
   "parts": [{"key": "head", "name": "頭", "hitzone": {"slash": 45, "blunt": 48, "shot": 45, "fire": 5, "water": 5, "thunder": 5, "ice": 5, "dragon": 5, "stun": 100},
              "wound": {"slash": 0, ...} , "states": {"<状態名>": {...}}, "breakable": true, "severable": false}],
   "statusWeakness": {"poison": 1, "paralysis": 2, "sleep": 2, "blast": 1, "stun": 2, "exhaust": 1},
   "immune": ["poison"]}
]}
```
- 肉質は 0〜100 の整数 (MHDB の 0〜1 小数は 100 倍する)。
- 名前の無い部位 ('hide' 等) は捨てずに `name` を「部位不明 (内部名)」として持ち、既定では推奨の対象外にする。
  画面では内部名を出さず「部位不明 1」のように番号にする (`app/ui/tabs/target_mix.js` の `partLabel`)。
- (追記 2026-10-21) 上の例に無い主な項目 (詳細は `docs/sources/monsters.md`):
  - モンスター: `gameId`, `emId` (`"EM0160_00_0"`), `species`, `variantNames` (`{tempered: "歴戦の個体", ...}`),
    `legendaryParams` (歴戦/歴戦王の倍率。群 `normal`/`hard`/`king`/`kingHard`。意味は下の「歴戦の個体・歴戦王」),
    `individuals` (個体の一覧。同じく下), `woundConversions` (傷口の肉質の置き換え。同じく下),
    `itemEffects` (`{flash: {effective: true|false|null, conditions: []}, noise: {...}}`)。
    `variants` には `"frenzied"` (狂竜化) と `"alpha"` (ボス個体) も入る。`statusWeakness` / `immune` は契約どおり (★ 0〜3、無効は 0)。
  - 部位: `slug` (MHDB の部位名)、`unknownPart` (名前が無い部位なら true)、`internalType` (`"HEAD"` など)、`ordinal` (並び順)、
    `health` (部位の体力)、`breakReward` (MHDB の部位破壊報酬が付いているか。特定できなければ null)、
    `bestElement` (`{types: ["fire"], value: 25}` = 通常肉質で一番高い属性。同値は全部、最大が 0 なら types は [])、
    `note` (あるときだけ)。`wound` は傷口の無い部位では null。`states` のキーは `break` / `custom1`〜`custom5` / `weakPoint` など
    (意味と確度は `meta.stateKeys`)。
  - `elementRecommendation`: `{best: ["dragon"], order: [{type, avg}], basis, basisParts: [部位 key], tieBreak, allPartsAvg,
    stateMaxAvg, bestStateMax}`。`best` は主要部位 (斬撃肉質 45 以上。2 部位未満なら斬撃上位 3 部位) の属性肉質の平均が最大の属性。
    同点は 主要部位の傷口の平均 → 全部位の平均 で崩し、経過を `tieBreak` (`{tied, by, woundAvg, woundParts}`。同点が無ければ null)
    に持つ。崩せなければ `best` に複数残る。

#### 歴戦の個体・歴戦王 (追記 2026-10-21 段階2)

歴戦王は Ver.1.042 時点で 5 体 (レ・ダウ / ウズ・トゥナ / ヌ・エグドラ / ジン・ダハド / アルシュベルド)。出典と確度は
`docs/sources/monsters.md` の「歴戦の個体・歴戦王」。

`legendaryParams` は Param_Legendary の 4 つの群。群の意味は MHWS-in-json の作者による実行ファイルの解析に従う
(確度 medium。`meta.legendaryGroups`。以前は「内部名のまま・hard の意味は不明」だった):
`normal` = 歴戦の個体で報酬ランク 8 以下、`hard` = 歴戦の個体で報酬ランク 9 以上、`king` = 歴戦王の ★8/★9、
`kingHard` = 歴戦王の ★10。クエストでどの群を使うかの規則と例外 (ゾ・シア/ゴグマジオスの ★10 は NONE でも kingHard、
オメガ・プラネテスは hard にしない) は `meta.legendaryGroups`、項目の意味と確度は `meta.legendaryFields`。
```json
"legendaryParams": {
  "normal": {"health": 1.0, "partsVital": 1.0, "attackCalm": 1.1, "attackAngry": 1.15, "motionSpeed": 1.05,
             "motionSpeedOverride": null, "staminaSub": 0.7,
             "woundVital": {"normal": 1.3, "tear": 1.3, "temperedScar": null},
             "guardPowerAdd": null, "actionOverrides": null},
  "hard": {...}, "king": {...},
  "kingHard": {..., "motionSpeedOverride": 1.04, "actionOverrides": {"count": 34, "speedMax": 1.3, "attackMax": 1.5}}}
```
- (変更 2026-10-21) どの群も同じ項目を持ち、群に欄が無いものは **null** (以前は項目ごと省いていた)。理由: 「欄が無い」と
  「1.0」を取り違えないため (例: king / kingHard 群には MotionSpeedRate の欄が無い → `motionSpeed: null`)。
  意味の分からない AngryScarDamageRate / AddStunDamageList / ArenaLegendaryScarIndexList / _ShellCustomData は取り込まない。
- 群に欄の無い項目の null は「その群に欄が無い」という意味 (`guardPowerAdd: null` も「ガードを崩す強さを足さない」とは限らない。
  ウズ・トゥナの歴戦王は Param_Unique に `_AddGuardPower` 40 がある)。Param_Unique の歴戦王・歴戦用と思われる項目は
  取り込まず、値だけ `meta.legendaryFields.uniqueParams` に並べる。
- (変更 2026-10-21 照合の指摘) 肉質は「歴戦の個体・歴戦王でも通常と同じ (確度 high)」としていたが誤り。モンスター固有の
  パラメータ (Param_Unique) に傷口の肉質の置き換え (`_ScarMeatConvert`) があり、ウズ・トゥナの歴戦王は傷口の肉質が変わる
  (弾 88→70 / 80→65、雷 25→20)。アルシュベルドにも置き換えがあるが、いつ使われるか分からない (鎖翼刃の傷口の龍 38→30 など)。
  置き換えはモンスターの `woundConversions`、個体ごとの値は `individuals[].hitzone` に持つ (下)。`parts[].wound` は通常の個体の値のまま。

`woundConversions` = 傷口の肉質の置き換え (Param_Unique の `_ScarMeatConvert`)。無いモンスターは `[]` (いまはウズ・トゥナと
アルシュベルドだけ)。
```json
"woundConversions": [
  {"scope": "arch-tempered", "groups": ["king", "kingHard"],
   "internal": "Param_Unique の _LegendaryParam_Hard_King._ScarMeatConvert / ...",
   "condition": "歴戦王の群 (king / kingHard) 専用の構造の中にある = 歴戦王で使われる", "confidence": "medium", "note": "...",
   "parts": [{"key": "head", "before": {"slash": 88, "blunt": 90, "shot": 88, "fire": 15, "water": 0, "thunder": 25, ...},
              "after": {"slash": 88, "blunt": 90, "shot": 70, "fire": 15, "water": 0, "thunder": 20, ...},
              "changed": ["shot", "thunder"]}],
   "unmatched": [], "elementRecommendation": {...モンスターの elementRecommendation と同じ形...}, "source": "https://github.com/..."}]
```
- `scope`: `arch-tempered` = 歴戦王の群の構造の中にある (`groups` にその群)。`unknown` = 群の分からない場所にあり、いつ使われるか
  分からない (`groups: null`・確度 low。アルシュベルド)。
- `parts[].before` は `parts[].wound` と同じ値 (生成時に確かめる)。`after` が置き換え後。`changed` は値の変わる項目。
  `unmatched` はどの部位の傷口にも当たらない置き換え (アルシュベルドに 1 組。値だけ残す)。
- `elementRecommendation` は置き換え後の傷口で推奨属性を計算し直したもの (同じ規則)。

`individuals` = 個体の一覧。先頭が通常 (`kind: null`)、続いて `variants` の順。`kind` は quests.json の `targets[].variant` と同じ値。
```json
"individuals": [
  {"kind": null, "label": "通常", "name": "アルシュベルド", "legendaryId": "NONE",
   "groupByRank": [{"min": 1, "max": 10, "group": null, "reason": "none"}],
   "rates": [{"group": null, "rewardRanks": [7], "health": 1.0, "attackCalm": null, "attackAngry": null, "partsVital": null,
              "healthConfidence": "medium", "attackConfidence": "low"}],
   "questIds": ["Awakening From a Dream", ...], "intruderQuestIds": [], "stars": [7],
   "hitzone": {"sameAsBase": true, "confidence": "high", "woundOverrides": null, "elementRecommendation": null},
   "threatVariant": null},
  {"kind": "arch-tempered", "label": "歴戦王", "name": "アルシュベルド（歴戦王）", "legendaryId": "KING",
   "groupByRank": [{"min": 1, "max": 9, "group": "king", "reason": "rank"}, {"min": 10, "max": 10, "group": "kingHard", ...}],
   "rates": [{"group": "kingHard", "rewardRanks": [10], "health": 1.265, "attackCalm": 1.2, "attackAngry": 1.2,
              "partsVital": 1.25, "healthConfidence": "medium", "attackConfidence": "low"}],
   "questIds": ["Event: Unchained Arkveld", "Freedom from Solitude", "Proof of a Hero", "The Proud Child of the Wilds"],
   "intruderQuestIds": [], "stars": [10],
   "hitzone": {"sameAsBase": null, "confidence": "low",
               "woundOverrides": {"head": {...}, "left-wing-blade": {"slash": 70, ..., "dragon": 30, "stun": 0}, ...},
               "elementRecommendation": {...}, "note": "傷口の肉質の置き換えがあるが、いつ使われるか分からない ..."},
   "threatVariant": "arch-tempered",
   "added": {"version": "1.041", "date": "2026-02-18", "dateConfidence": "high", "note": "...", "sources": ["https://..."]},
   "star10": {"version": "1.041", "date": "2026-02-18", ...},
   "rewards": {"certificate": {"itemId": 787, "name": "鎖刃竜の狩猟証γ"},
               "armorSets": [{"armorSetId": 193, "name": "シュバルカγ", "armorIds": [705, 706, 707, 708, 709]}],
               "groupSkills": [{"skillId": 131, "name": "ヌシの魂"}], "charmFixedIds": [186, 187], "source": "..."}}]
```
- `label` / `name` は MHDB の個体名から (基本種と同じ名前のときは「（歴戦の個体）」を添える)。`legendaryId` は MissionData の
  `_LegendaryID` (狂竜化・ボス個体は NONE)。
- `groupByRank` = 報酬ランク → `legendaryParams` の群 (`group: null` は群なし = 体力の倍率 1.0)。`rates` はその個体が出る
  クエストで実際に使われる群と倍率 (群なしの攻撃・部位の倍率は不明なので null)。確度は体力 medium・攻撃 low。
- `questIds` = 狩猟対象として出るクエスト (★順)、`intruderQuestIds` = 乱入の可能性があるクエスト。どちらも quests.json の id
  (wiki 由来の対応なので `meta.license` に CC BY-SA の注記)。クエストごとの体力は quests.json の `mission.targets[].healthCalc`。
- `hitzone` (変更 2026-10-21 照合の指摘): 肉質が `parts` と同じか と、違うときの傷口の肉質。
  - `sameAsBase`: true / false (違う) / null (分からない)。`confidence` が null なら未調査 (狂竜化・ボス個体)、low なら
    置き換えがあるのに条件が分からない (歴戦王アルシュベルド)。
  - `woundOverrides`: 部位 key → 置き換え後の傷口の肉質 (`parts[].wound` と同じ形)。書いていない部位は `parts[].wound` のまま。
    置き換えが無ければ null。`sameAsBase: null` のときは「置き換わるとしたら」の参考値。
  - `elementRecommendation`: 置き換え後の傷口で計算し直した推奨属性 (置き換えが無ければ null = モンスターのものを使う)。
  - `note`: あるときだけ。
  - いまの値: ウズ・トゥナの歴戦王が false (確度 medium)、アルシュベルドの歴戦王が null (low)、アルシュベルドの歴戦の個体が
    true (medium。条件の分からない置き換えがあるので)、ほかの歴戦王が true (medium)、ほかの歴戦の個体と通常が true (high)。
  - 画面で歴戦王の傷口を計算するときは `woundOverrides` があればその値を使う (null のときは未確定と出す)。
- `threatVariant`: monster_threats.json の `variants` のキー (無ければ null)。
- 歴戦王だけ `added` (追加の版 = MissionData の `_Version`、日付と出典 = tools の表)・`star10`・`rewards` (MHDB の素材から
  狩猟証γ で作れる γ 防具と固定護石。`armorIds` は armor.json、`charmFixedIds` は charms_fixed.json の id)。

### data/monster_threats.json (CC BY-SA 4.0)
咆哮・風圧・振動・属性やられ・状態異常の種類。防御スキルを勧めるかの判定に使う。欠損は null。

(追記 2026-10-21) 形:
```json
{"meta": {..., "license": {"name": "CC BY-SA 4.0", "url": "...", "attribution": "..."}},
 "rules": {"elementalBlight": {"resistanceThreshold": 20, "skill": {"skillId": 49, "negateLevel": 3, "mitigateLevel": 1, ...}},
           "roar": {"weak": {"skill": "耳栓", "skillId": 80, "negateLevel": 2, "mitigateLevel": 1, "levelText": {"1": "..."}}, "strong": {...}},
           "windPressure": {"minor": {...}, "major": {...}, "dragon": {...}}, "tremor": {"minor": {...}, "major": {...}},
           "status": {"poison": {...}, "paralysis": {...}}, "noSkill": {"frenzy": "..."}},
 "monsters": [
  {"monsterId": 3, "name": "レ・ダウ", "nameEn": "Rey Dau", "wikiPage": "...", "wikiUrl": "...",
   "roar": "none|weak|strong|null", "windPressure": "none|minor|major|dragon|null", "tremor": "none|minor|major|null",
   "attackElements": ["thunder"],
   "blights": [{"element": "thunder", "name": "雷属性やられ"}],
   "blightsUncertain": [{"element": "fire", "name": "火属性やられ", "reason": "..."}],
   "statusEffects": [{"key": "paralysis", "name": "麻痺", "wiki": "Paralysis", "nameConfidence": "high|medium|low|null"}],
   "issues": ["..."]}],
 "otherMonsters": [{"nameEn": "Baunos", ...monsters と同じ項目 (monsterId と name が無い)}]}
```
- `monsters` は monsters.json の大型 34 体と同じ数 (`monsterId` で結合)。`otherMonsters` は 34 体以外の Wilds の行 (小型など)。
- `blights` は wiki が属性やられを起こすとしている属性。`blightsUncertain` は攻撃属性 (`attackElements`) にあるのに `blights` に
  無い属性で、属性やられになるか**未確認** (自動で `blights` に足していない。画面では「未確認」と出す)。
- 防御スキルの判定は `rules` を使う (属性耐性 `resistanceThreshold` 以上ならその属性やられは無効、など)。
- 画面でこのファイルの内容を出すときは出典 (Monster Hunter Wiki) とライセンス (CC BY-SA 4.0) を表示する。
- (追記 2026-10-21 段階2) `monsters[]` の各行に `variants` (個体ごとの差分) がある。いまは歴戦王の 5 体だけ中身があり、ほかは `{}`。
  ```json
  "variants": {"arch-tempered": {
    "name": "ヌ・エグドラ（歴戦王）",
    "sameAsBase": {"roar": true, "windPressure": true, "tremor": true, "blights": true, "statusEffects": true,
                   "confidence": "medium", "reason": "..."},
    "moveChanges": [{"text": "点火中は炎をまとい、…", "textEn": "While ignited, emits a burning aura ..."}],
    "hazards": [{"key": "ignited-aura", "text": "点火中にまとう炎 (近くにいると継続ダメージ)",
                 "skill": {"skill": "環境適応", "skillEn": "Adaptability", "skillId": 88, "negateLevel": 2, "levelText": {...}},
                 "oneShot": false, "source": "https://monsterhunterwiki.org/wiki/Nu_Udra_(MHWilds)", "confidence": "high",
                 "note": "..."}],
    "source": "https://monsterhunterwiki.org/wiki/Nu_Udra_(MHWilds)"}}
  ```
  - `moveChanges` は wiki の個別ページの「Arch-Tempered」節の箇条書き。`text` は日本語 (tools の表 `MOVE_JA`。wiki の文が
    変わって訳が合わなくなったら null)、`textEn` は wiki の英文。
  - `hazards` は防具スキルとの関係が書かれた脅威だけ。`skill` は `rules` と同じ形 (防げるスキルが無ければ null で `noSkill` に文)。
    `oneShot: true` = 当たると力尽きる。いまはヌ・エグドラの炎 (環境適応 Lv2)・ジン・ダハドのつむじ風 (凍結 = 拘束耐性 Lv3)・
    ジン・ダハドのノヴァ (防げない) の 3 件。
  - `sameAsBase` = 咆哮・風圧・振動・属性やられ・状態異常は通常と同じと見ている (変わるという記載が無い。確度 medium)。

### data/quests.json
クエスト名・★・種類・狩猟対象・装備固定かどうか。

(追記 2026-10-21) 形:
```json
{"meta": {..., "license": {"name": "CC BY-SA 4.0", ...}},
 "quests": [
  {"id": "A Flash of Brilliance", "name": "閃電猛りて、その粋やよし！", "nameLang": "ja|en", "nameEn": "A Flash of Brilliance",
   "stars": 8, "rank": "low|high", "type": "hunt|slay|capture|arena|special|delivery", "category": "optional|event|assignment|challenge|arena",
   "targets": [{"monsterId": 31, "name": "ラギアクルス", "nameEn": "Lagiacrus",
                "variant": "tempered|arch-tempered|frenzied|alpha|null", "count": 1, "large": true}],
   "largeTargetCount": 2, "multi": true, "variant": "tempered|arch-tempered|frenzied|alpha|mixed|null",
   "intruders": [{"monsterId": 12, "name": "...", "nameEn": "...", "variant": null}],
   "fixedEquipment": true, "fixedEquipmentReason": "...", "fixedEquipmentConfidence": "high|medium|low",
   "locale": "Wounded Hollow", "timeLimit": 50, "requirements": "HR 41+", "wikiUrl": "...",
   "mission": {"missionId": "MISSION_650008", "match": "exact|fuzzy:...", "questLv": 8, "questType": "HUNTING",
               "version": "...", "stage": "ST401",
               "targets": [{"monsterId": 31, "nameJa": "ラギアクルス", "variant": "tempered|arch-tempered|null",
                            "legendaryId": "NONE|NORMAL|KING", "targetType": "...", "health": 5.2, "attack": 4.9,
                            "partsVital": 6.25, "soloHealth": [27956, 28538, 29120, 29703, 30285]}]}}]}
```
- `id` は wiki の英語のクエスト名 (一意)。`name` は日本語名 (MissionData と結合できない 14 件は英語名のままで `nameLang: "en"`)。
- `targets` の `monsterId` は monsters.json の id。小型の討伐は `large: false`・`monsterId: null`。
  `multi` = 大型の狩猟対象が 2 体以上 (`largeTargetCount >= 2`)。
- `intruders` は同じフィールドに出る大型 (乱入の可能性。必ず乱入するわけではない)。
- `fixedEquipment`: true = 決められた装備で挑む (アリーナ/チャレンジ)、false = 持ち込み装備、null = 判断できない。
  確度と根拠を `fixedEquipmentConfidence` / `fixedEquipmentReason` に持つ。
- `mission` は MissionData (MHWS-in-json) と結合できたときだけ (できなければ null)。`health` などは体力倍率。
- 画面でこのファイルの内容を出すときは出典 (Monster Hunter Wiki) とライセンス (CC BY-SA 4.0) を表示する。
- (追記 2026-10-21 段階2) 歴戦王のために足した項目:
  ```json
  {"category": "event", "categoryBucket": "optional", "categoryReason": "...",
   "availability": {"status": "permanent|inactive|active|standard|unknown",
                    "periods": [{"from": "2026-09-23", "to": "2026-10-07", "text": "September 23 - October 7, 2026"}],
                    "permanentFrom": "2026-08-04", "text": "August 4, 2026 / Permanently Active"},
   "mission": {..., "maxPlayers": 4,
     "targets": [{..., "rewardRank": 10, "paramGroup": "kingHard", "paramGroupReason": "rank",
                  "healthCalc": {"mid": 79923, "min": 76726, "max": 83120, "adjustRange": 2,
                                 "matchesMissionData": true, "confidence": "medium"},
                  "attackRate": {"calm": 8.4, "angry": 8.4, "confidence": "low"},
                  "multi": {"tableId": "a5295449-1a03-4530-a664-87de66f511c7",
                            "health": {"2": 1.88, "3": 2.43, "4": 3}, "partsVital": {"2": 2, "3": 2.7, "4": 3.5},
                            "confidence": "low"}}]}}
  ```
  - `availability` は wiki の Time Period から (時点は `meta.availabilityAsOf`)。permanent = 常設、inactive = 終了中
    (`periods` に過去の配信期間。年の書いていない期間は from/to が null)、active = 配信中、standard = 期間の無い通常の
    クエスト・任務。`permanentFrom` は「開始日 + Permanently Active」と書かれたものだけ。
  - `category` は wiki の Bucket の値だが、歴戦王のクエストのページの Importance が Event なのに Bucket が optional の 2 件
    (These Roots Run Deep / Summons from the Land Beyond) はページに合わせ、もとの値を `categoryBucket` に残す。
  - `paramGroup` = その狩猟対象が使う `monsters.json` の `legendaryParams` の群 (群なし = null)。倍率は monsters.json から引く。
    `paramGroupReason`: `rank` / `none` / `exe-exception:king-when-none` / `exe-exception:no-auto-hard` / `unknown` (小型)。
  - `healthCalc` = ソロの体力。`mid` は乱数の等級 1.0 の値、`min`/`max` は `soloHealth` の両端。式と乱数の等級の確率表は
    `meta.healthFormula` / `meta.healthGrades` (`healthGrades[adjustRange].probs` が昇順の `soloHealth` と同じ並び)。
    再計算した値が MissionData の `soloHealth` と一致したときだけ `adjustRange`/`min`/`max` が入る。
    MissionData に無いクエスト (フリーチャレンジなど 14 件) は `mission: null` のまま = 体力不明 (仮の値で埋めない)。
  - `attackRate` = クエストの `attack` × 群の平常/怒りの攻撃倍率 (掛け方は推定。群なしは null)。
  - `multi` = 人数ごとの体力・部位の耐久の倍率 (MissionData の `_Count` を人数と推定。確度 low。`maxPlayers` まで)。
    `tableId` は MissionData の `_MultiTableId` (同じ表の行は同じ値。追記 2026-10-21 照合の指摘)。
  - クエスト側のダメージ補正 (`_DamageSlashBlow` / `_DamageShot`) は大型の全行で 1 なので行には持たず、`meta.damageRateCheck` に残す。

## 計算モデルの方針 (app/model/damage.js)

- 物理 = 攻撃力 × MV/100 × 物理肉質/100 × 斬れ味物理補正 × 会心期待値
- 属性 = (属性値 × 乗算 + 加算)/10 × 属性肉質/100 × 斬れ味属性補正 × 技の属性補正 × 会心撃【属性】期待値
- 攻撃力 = 武器攻撃力 × 乗算 + 加算 (乗算が先)。会心率は -100〜100% で切る。
- 条件つきスキル (挑戦者・連撃・フルチャージ・逆恨み・力の解放 など) は発動率 (0〜1) を人が入れる。
  組み合わせは独立と仮定し、発動/非発動の全パターンで加重平均する。
- 「DPS」は秒数が公開されていないので出さない。**代表コンボ1回の期待値**と、**スキルなし比の上昇率 (%)** を出す。
- 弱点特効は肉質 45 以上 (弱点) で効く。ヒットごとに、そのヒットの物理肉質で決める (剣 = 切断・盾 = 打撃。傷口を狙う段は
  傷口の肉質)。傷口には追加分。
- 斬れ味が「自動」のときは、スキルの組ごとに斬れ味の色を決め直す (匠を外すと色が下がる。スキルなし比のスキルなしは匠なしの色)。
- 灼熱化などシリーズ由来の追加ダメージは、肉質に依存する部分と固定部分を分けて持つ。

## 段階

1. データ + 計算モデル + 装備からスキル表示 + 火力比較 + 護石一覧 (済み)
2. 所持護石を使った装備探索 (←いまここ。設計は `docs/SEARCH_DESIGN.md`)
3. モンスター別・多頭クエストの推奨 (←いまここ。設計は `docs/RECOMMEND_DESIGN.md`)

### 段階 2・3 の置き場 (2026-10-21 土台を入れた)

- 画面: 6 つ目のタブ「探す」(並び: 装備・火力・相手・探す・護石・設定)。状態は `state.search` と `state.target` の
  個体・クエスト・人数の項目 (`docs/UI_API.md`)。見た目は `app/ui/styles_search.css` / `styles_target.css`。
- 計算: `app/model/hunt.js` (済み)・`weapon.js` (済み)・`search.js` / `search/` と `app/search_worker.js` (済み 2026-10-21)・
  `recommend.js` (置き場だけ)。`docs/MODEL_API.md`。
- 端末に保存: `mhwilds-sns:search-last` (最後の結果・書き出しに入る) と `mhwilds-sns:search-timing` (時間の記録・この端末だけ)。
- データに足すもの: `skill_effects.json` の `rules.resistSkills` (`docs/RECOMMEND_DESIGN.md` 5.8 節。担当: data)。
