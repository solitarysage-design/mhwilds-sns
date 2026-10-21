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
  model/                計算の純粋関数 (DOM に触らない。node --test でテストする)
    damage.js           ダメージ期待値
    build.js            装備一式 → スキル合計 (シリーズ/グループ発動を含む)
    charms.js           護石の検証・泣シミュ形式の書き出し/読み込み
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
    `legendaryParams` (歴戦/歴戦王の倍率。内部名の群 `normal`/`king`/`hard`/`kingHard` のまま),
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

1. データ + 計算モデル + 装備からスキル表示 + 火力比較 + 護石一覧 (←いまここ)
2. 所持護石を使った装備探索
3. モンスター別・多頭クエストの推奨
