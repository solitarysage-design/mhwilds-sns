# 装備データの出典と判断 (担当: equip)

対象: モンスターハンターワイルズ Ver.1.042 (数値の最終調整は Ver.1.040 / TU4)。2026-10-21 作成。

## 作るもの

| ファイル | 件数 | 主な出典 |
|---|---|---|
| `data/skills.json` | 179 (武器 66・防具 71・シリーズ 25・グループ 17) | MHDB `/ja/skills` + MHWS-in-json `SkillCommonData` (gameId で結合) |
| `data/armor.json` | 714 (下位 132・上位 582。頭 164・胴 140・腕 135・腰 137・脚 138) | MHDB `/ja/armor`, `/ja/armor/sets` |
| `data/bonuses.json` | シリーズ 25・グループ 17 | MHDB `/ja/armor/sets` |
| `data/decorations.json` | 361 (武器用 295・防具用 66) | MHDB `/ja/decorations` |
| `data/weapons_sns.json` | 片手剣 95 (うちアーティア系 6・巨戟アーティア 3) | MHDB `/ja/weapons?q={"kind":"sword-shield"}` |
| `data/charms_fixed.json` | 固定護石 183 (60 系統の Ⅰ〜Ⅲ など) | MHDB `/ja/charms` (random=false) |
| `data/talisman_rules.json` | 鑑定護石 レア5〜8 の 4 種・抽選表 124 行・スキル群 10 | MHWS-in-json `RandomAmuletPtTable` / `RandomAmuletLotSkillTable` / `RandomAmuletAccSlot` |
| `data/charms.json` | 1 (本人の最初の護石) | 写真 2026-10-21 (人が増やす) |
| `data/my_weapons.json` | 0 (空) | 人が増やす |

生成: `PYTHONIOENCODING=utf-8 python tools/build_equip.py` (キャッシュが無ければ `tools/equip_fetch.py` で取ってから作る。`--refresh` で取り直し)。
キャッシュ (`tools/.cache/equip/`) だけを読むので再実行で同じ結果になる (`generatedAt` は実行時刻でなく生データの取得時刻の最大値)。2 回実行して md5 が同じことを確認済み。

## 出典とライセンス

| 出典 | 取り方 | ライセンス・扱い |
|---|---|---|
| wilds.mhdb.io `/ja/` (armor, armor/sets, skills, decorations, weapons, charms) | `urllib` で取得。2026-10-21 03:08 UTC | MHDB (LartTyler/mhdb-wilds-data)。ゲームデータの数値と名前だけを使う。版の固定はできない (生 API) ので MHWS-in-json と照合した |
| GitHub `dzxrly/MHWS-in-json` commit `4a99b26` (release `database-20261020-070700-4a99b26`, ゲーム版 1.42.0.2) | natives の生 JSON を raw.githubusercontent.com から、PROCESSED_DATA / DATABASE_ja-JP の zip を release から | MIT |
| 泣シミュ (mhwilds.wiki-db.com/sim) | 護石の取り込み形式と選択肢の確認だけ (画面のスクリプトを読んだ)。データは取り込まない | — |

使った MHWS-in-json のファイル: `Common/Equip/SkillCommonData`, `RandomAmuletPtTable`, `RandomAmuletLotSkillTable`, `RandomAmuletAccSlot` (生成に使う)、`PROCESSED_DATA` の `amulet_pool.json` / `skill_pool.json` と `DATABASE_ja-JP` の `EquipCollection.xlsx` / `SkillCollection.xlsx` (照合に使う)。`ArmorData` / `AccessoryData` / `ShortSword` の生 JSON も取得してあるが今は使っていない。

## 照合の結果 (meta.checks に残してある)

- MHDB の skill.gameId は SkillCommonData の `_skillId` と **179/179 一致**。MHDB の kind (weapon/armor/set/group) は SkillCommonData の `_skillCategory` (WEAPON/EQUIP/SERIES/GROUP) と全件一致。
- 防具 714 件を MHWS-in-json (1.42.0.2) の `EquipCollection.xlsx` と名前で突き合わせ: スロット・スキル (シリーズ/グループ含む)・防御力 (初期値)・耐性 5 種が**全件一致**。
- 装飾品 361 件: 種類 (武器用/防具用)・スロット Lv・スキルと Lv が**全件一致**。
- 片手剣 95 件: 攻撃力・会心率・スロット・斬れ味・匠の伸び・属性 (種類と値)・スキルが**全件一致** (MHDB の爆破は `blastblight` と書くので `blast` に直した)。
- 鑑定護石の抽選表: 生ファイルから作った行と PROCESSED_DATA の `amulet_pool.json` が行ごとに一致。スキル群も `skill_pool.json` と一致。
- 照合していない項目: 防御力の最大値、装飾品のレア度、スキルの説明文、武器のレア度・防御ボーナス・龍封力。

→ MHDB の数値は 1.42.0.2 と食い違いが見つからなかった。

## 判断したこと

### スキル (skills.json)
- `kind` は MHDB のまま (上記のとおりゲームの分類と一致)。
- `maxLevel` は MHDB の ranks の数 (Lv が 1 から連続していることを確認)。
- `decoSize` = その スキルを **Lv1 で付ける単体装飾品** のスロット Lv の最小値。装飾品が無いスキル (武器固有スキル・一部の防具スキル。武器/防具スキル 20 件) は null。全単体装飾品の一覧も `decorations` に入れた。
- 契約外で足した項目: `description` (スキル全体の説明)、`internalId` (`HunterSkill_026` など)、`decorations`。

### 防具 (armor.json)
- `slots` は MHDB の並び (全件大きい順) に 0 を足して長さ 3。**限界突破後のスロットは持たない** (下の未確定事項)。
- `skills` には武器/防具スキルだけを入れ、シリーズ/グループスキルは `setBonusId` / `groupBonusId` で表す。
- **ゴグα/β (id 670〜679) は 1 部位に シリーズスキルが 2 つ** ある (巨戟龍の黙示録 + 部位ごとに別のシリーズスキル。例: ゴグヘルムα = 白熾龍の脈動)。MHDB の armorSet.bonus は 1 つしか持たず、ゴグβ では 護鎖刃竜の命脈 (ヘルムβ だけのもの) になっていて部位によっては誤り。そこで部位自身のスキル一覧から取り、
  - `setBonusIds` (契約外で追加) = その部位が数に入る全シリーズスキルの id。シリーズ全部位に共通するもの (= 巨戟龍の黙示録) を先頭に。
  - `setBonusId` = `setBonusIds` の先頭 (ふつうの防具は 1 つだけなので同じ)。
  - build.js は `setBonusIds` があればそれを全部数える。
- グループスキルは全部位 1 つ以下 (確認済み)。
- 下位防具にもシリーズ/グループスキルが付いているものがある (MHDB と MHWS-in-json の両方で同じ)。データのまま。
- 契約外で足した項目: `setBonusIds`, `armorSetId`, `armorSetName`。

### シリーズ/グループ (bonuses.json)
- シリーズスキル 25 件はすべて 2 部位でⅠ・4 部位でⅡ (ranks はデータから)。グループスキル 17 件はすべて 3 部位。
- `setBonuses` と `groupBonuses` の `id` は別の番号体系 (MHDB の bonus id と groupBonus id)。同じ数字が両方にあり得る。
- 契約外で足した項目: ranks の `name` (例 加速再生Ⅰ)、グループの `level` と `effectName` (例 根性【果敢】)。

### 片手剣 (weapons_sns.json)
- `attack` = MHDB の `damage.raw` (係数なし)。全件で 表示値 = raw × 1.4 を確認。`attackDisplay` に表示値も残した。
- `element.value` は表示値 (MHDB `damage.display`)。隠し属性の片手剣は無かった。
- `sharpness.base` = [赤, 橙, 黄, 緑, 青, 白] のヒット数 (紫は全件 0 なので落とした)。`handicraftMax` = 匠 Lv5 の斬れ味。MHDB の `handicraft` (各色に何 Lv 足すか。先頭は素の最上位の色) を 1 Lv = 10 で足した。MHWS-in-json の `TakumiValList` と全件一致。
- **アーティア系** = MHDB で series が null の 6 本 (アーティアソードⅠ・Ⅱ、ヴェルドロート、破滅のキリエヴェルド×3)。`artian: true`、`element: null`、note「属性は手入力」。MHWS-in-json の AttributeValue (属性未選択のときの値) を `mhwsAttributeValue` に目安として残した (確度 low)。
- **破滅のキリエヴェルド×3 (id 1180〜1182) は除外しない**。`gogmaArtian: true` (かつ `artian: true`)。3 本の名前が同じなので `variant` と `displayName` を足した: 攻撃力が最も高い 1180 = 攻撃激化 (200 / -10%)、会心率が最も高い 1181 = 会心激化 (180 / +15%)、残り 1182 = 属性激化 (190 / 0%。AttributeValue も 3 本で最大の 30)。
- 入手経路の無い重複: MHDB 側には無かった (同名は上の 3 本だけで、性能が違う)。MHWS-in-json には名前の無いダミー `ShortSword_201` (表示名 `ShortSword_106`、攻撃 100) があるが、MHDB に載っていないので何もしていない。
- 契約外で足した項目: `attackDisplay`, `defenseBonus`, `elderseal`, `handicraft`, `series`, `gameId`, `variant`, `displayName`, `mhwsAttributeValue`。

### 固定護石 (charms_fixed.json)
- MHDB の charms のうち `random=false` の 60 系統の全段階 (183 件)。`id` は MHDB の charm rank id、`charmId` が系統の id。
- MHDB で `random=true` の 4 件 (未解・史伝・秘歴・栄世の護石) は鑑定護石なので talisman_rules 側。

### 鑑定護石の規則 (talisman_rules.json)
- 生ファイルの AmuletType の数値 = MHDB の鑑定護石の gameId。ここで名前とレア度 (ゲーム内表示) を取った:
  未解の護石 = レア5、史伝の護石 = レア6、秘歴の護石 = レア7、栄世の護石 = レア8。
  PROCESSED_DATA の `amulet_pool.json` の "Rare 4〜7" はこの 5〜8 にあたる (ずれは全件 +1 で確認)。
- `patterns` = 抽選表の 1 行 (スロット構成番号 + スキル枠 1〜3 の群番号)。同じ行が何回載っているかを `weight` に畳んだ。
  - レア8 (栄世) は 48 行 → 重複を除くと 24 構成。重みは スロット構成ごとに **武器Lv1 だけ = 3、武器Lv1 + 防具Lv1 = 2、武器Lv1 + 防具Lv1×2 = 1** (行がそれぞれ 3 回・2 回・1 回載っている)。
  - レア5〜7 は重複なし (weight 1)。
- `groups[群番号]` = その群で付くスキルと Lv。群 1〜4 は LotSkill01 = 武器スキル、群 5〜10 は LotSkill02 = 防具スキル (MHDB の kind と全件一致を確認。`groupKinds`)。
- `slotPatterns` (スロット構成と重み) と `skillSlots` (枠ごとに出る群・種類・枠なしがあり得るか) は契約の形。ただし**スロットとスキル群は独立でない** (例: 秘歴の護石の 防具Lv3 は (武器Lv2, 武器Lv1, 防具群8) の行にしか付かない) ので、検証は `patterns` で行う。
- `skillMaxLevel[skillId]` = そのレア度でそのスキルが取りうる最大 Lv。
- 泣シミュの選択肢 (防具 [0,0,0] [1,0,0] [1,1,0] [1,1,1] [2,0,0] [2,1,0] [3,0,0]、武器 [0,0,0] [1,0,0]) と照合: 抽選表のスロット構成はすべて泣シミュの選択肢に入っている (**矛盾なし**)。泣シミュの [1,1,1] は抽選表のどのレア度でも使われていない (スロット構成番号 3 として定義はあるが行が無い)。
- 秘歴の護石 (レア7) に武器用スロットは付かない (栄世の護石だけ)。

### 本人の護石 (charms.json)
- 写真から読んだ内容: 秘歴の護石・RARE 7・ガード性能 Lv3 (skillId 59, 武器スキル)・属性吸収 Lv1 (skillId 133, 防具スキル)・防具用スロット Lv2 が 1 つ・武器用スロットなし。
- `validateCharm` を**通った** (エラー・警告なし)。当てはまる行: スロット構成 4 (防具 [2,0,0]) × スキル群 (3, 10, 0) = 武器スキル群3 の Lv3 + 防具スキル群10 の Lv1 で Lv も一致。この組み合わせはレア7 でしか出ない (`possibleRarities` = [7])。
- 泣シミュ形式: `ガード性能,3,属性吸収,1,,0,2,0,0,0,0,0`。

### 泣シミュ形式
- 泣シミュの画面のスクリプト (2026-10-21 時点) で確認: 一括取り込みは 1 行 = カンマ区切り 12 項目 (`スキル1,Lv1,スキル2,Lv2,スキル3,Lv3,防具スロ1,2,3,武器スロ1,2,3`)、改行区切り。空きスキルは名前が空・Lv 0。スキル名はゲームと同じ全角表記 (`ＫＯ術`, `体力回復量ＵＰ` など)。

## 未確定事項

| 事項 | 確度 | メモ |
|---|---|---|
| 防具の限界突破後のスロット | — (持たない) | 機械可読な出典が無い。`slots` は限界突破前。必要になったら手入力の仕組みを別に作る |
| 破滅のキリエヴェルド 3 本の種類 (攻撃/会心/属性の激化) | medium | 攻撃力・会心率・AttributeValue からの推定。MHDB・MHWS-in-json とも種類名を持たない |
| アーティア系の属性値の目安 `mhwsAttributeValue` | low | 属性未選択 (Attribute=NONE) の行の値×10。実際の属性値は生産時の選択で決まるので my_weapons.json に手入力 |
| 鑑定護石のスキル Lv は表の値で固定か | medium | 抽選表は群ごとに Lv を 1 つだけ持つ (固定と読める)。検証では表の Lv を**上限**として扱い、低いときは警告 `not-exact` に留めた |
| 抽選表の行数 = 出やすさ | medium | weight は行数。ほかに確率を決める要素があるかは未確認 |
| 同じスキルが 2 回付く護石 | low | 抽選表上は同じ群から 2 回引く行がある (例 (4,1,1))。重複が実際に起きるか不明なので警告だけ |
| 名前の無い護石の種類 AT_0193 (7 行・防具Lv1 スロットのみ) | low | MHDB にも MHWS-in-json の AmuletCollection にも名前が無い。レア度不明なので `unmapped` に置き、検証には使わない |
| MHDB の取得版 | medium | 生 API なので版を固定できない。今回取得分は 1.42.0.2 の生データと照合して食い違いなし。再取得したら照合結果 (meta.checks) を見ること |
| `node --test tests/` (ディレクトリ指定) | — | Node 24 では `tests` をモジュールとして読もうとして失敗する。`node --test "tests/**/*.test.mjs"` か `node --test tests/*.test.mjs` で回す |
