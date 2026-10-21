# モンスター・脅威・クエストの出典と未確定事項 (担当: monsters)

対象: モンスターハンターワイルズ Ver.1.042 (数値の最終調整は Ver.1.040 / TU4)。取り込み 2026-10-21。

生成物: `data/monsters.json` / `data/monster_threats.json` / `data/quests.json`

再生成:

```
PYTHONIOENCODING=utf-8 python tools/build_monsters.py            # キャッシュが無ければ取得してから生成
PYTHONIOENCODING=utf-8 python tools/build_monsters.py --refresh  # 生データを取り直す
node --test tests/monsters.test.mjs
```

- 生データは `tools/.cache/monsters/` (git 管理外)。取得元 URL と取得時刻は `tools/.cache/monsters/manifest.json`。
- `meta.generatedAt` は「使った生データの取得時刻の最大値」。同じキャッシュからは何度実行しても同じファイルになる
  (2 回続けて実行し SHA-256 が一致することを確認済み)。
- スクリプト: `tools/build_monsters.py` (入口)、`tools/monsters_fetch.py` (取得)、`tools/monsters_parts.py`
  (monsters.json)、`tools/monsters_wiki.py` (monster_threats.json / quests.json)。
- `--refresh` で取り直したら、`tests/monsters.test.mjs` 冒頭の `EXPECT` (件数) を見直す。

## 出典とライセンス

| データ | 出典 | ライセンス | 固定点 |
|---|---|---|---|
| 大型 34 体・部位スラッグ・肉質 (0〜1)・部位体力・状態異常の★・報酬 | wilds.mhdb.io `/ja/monsters` | データ API (出典表記) | 取得時点 |
| 部位スラッグ → 日本語名、英語名・個体名 (alpha 等) | GitHub `LartTyler/mhdb-wilds-data` `output/merged/PartNames.json`, `LargeMonsters.json` | MIT | commit `c50a1eb` |
| 通常/破壊後/custom1〜5 の肉質・傷口の肉質 | GitHub `dzxrly/MHWS-in-json` release PROCESSED_DATA の `damage_calculator.zh-Hans.json` | MIT | tag `database-20261020-070700-4a99b26` (ゲーム版 1.42.0.2) |
| gameId ↔ EM ID、気絶肉質・弱点・破壊・切断・歴戦倍率 | 同リポの natives 生ファイル (`EnemyData` / `Resident` / `ParamPack` / `Param_Parts` / `Param_PartsLost` / `Param_Legendary`) | MIT | commit `4a99b26` |
| クエストの日本語名・体力倍率 | 同 release の DATABASE ja-JP / en-US の `MissionData.xlsx` | MIT | 同上 |
| 咆哮・風圧・振動・属性やられ・状態異常 | monsterhunterwiki.org Bucket API `monsters_games` | **CC BY-SA 4.0** | 取得時点 |
| クエスト (名前・★・種類・対象・乱入・装備) | monsterhunterwiki.org Bucket API `quests` (`where game = MHWilds`) | **CC BY-SA 4.0** | 取得時点 |
| 防御スキルの規則のしきい値 | monsterhunterwiki.org `Status Effects (MHWilds)` | **CC BY-SA 4.0** | 取得時点 |
| 防御スキルの id とレベルごとの効果文 | wilds.mhdb.io `/ja/skills`, `/en/skills` | データ API | 取得時点 |

- `monster_threats.json` と `quests.json` は wiki 由来なので、ファイルの `meta.license` に CC BY-SA 4.0 と出典を入れてある。
  画面でこの 2 ファイルの内容を出すときも出典 (Monster Hunter Wiki) とライセンスを表示すること。
- Kiranico は規約が不明なので取り込み元にしていない (照合にも今回は使っていない)。
- MHWS-in-json の `FullText.xlsx` (ゲーム内テキスト) は日本語の用語 (凍結・糸拘束・泡状態【小】など) の確認だけに使い、
  データとしては取り込んでいない。

## 件数

| 項目 | 件数 |
|---|---|
| 大型モンスター | 34 体 (MHDB の kind=large 全部) |
| 部位 | 340 (うち 部位不明 27、傷口の肉質あり 306) |
| 状態別肉質 (states) | custom1 98 / custom2 39 / custom3 20 / custom4 1 / break 34 / weakPoint 43 + weakPoint2 2 |
| 破壊できる部位 / 切断できる部位 | 125 / 29 |
| wiki `monsters_games` | 全 2,729 行を 6 ページでめくり、Wilds は 53 行 (うち 34 体に対応 34、それ以外 19 は `otherMonsters`) |
| wiki `quests` (game = MHWilds) | 220 件 (1 ページ) |
| 多頭クエスト (multi) | 34 件 |
| 装備固定 | true 17 / false 198 / null 5 |
| MissionData と名前で結合できたクエスト | 206 / 220 (あいまい一致 1: 「Awakening From a Dream」→「Awaking From a Dream」) |

## monsters.json の作り方

### 結合

1. MHDB の `gameId` は MHWS-in-json `EnemyData.user.3.json` の `_enemyId` ("[26] EM0001_00_0" の数字) と一致するので、
   これで EM ID を引く (34/34)。
2. EM ID → `Enemy/Resident/EmXXXX_YY_0_Resident.user.3.json` の `_Parts` 参照で Param_Parts を特定する。
   **護竜アルシュベルド (EM0160_50) は自前の Param_Parts を持たず、アルシュベルド (EM0160_00) のものを参照している。**
   そのため damage_calculator にも EM0160_50 が無いが、同じ部位表を使っている (MHDB の肉質も完全に同じ)。
3. MHDB の部位 ↔ damage_calculator の部位は「部位の種類 (HEAD → head) + 通常肉質の完全一致」で対応させる。
   同じ種類が複数ある部位 (hide など) は肉質一致の先頭から順に割り当てる。
4. **検証: 全 340 部位で MHDB の肉質 × 100 = damage_calculator の通常肉質 = 生の Param_Parts の肉質 (気絶含む)** が一致。
   一致しなければ生成を例外で止める。

### 項目

- `hitzone` / `wound` / `states.*` は `slash, blunt, shot, fire, water, thunder, ice, dragon, stun` の 0〜100 の整数。
  `stun` は生データの `_Stun` (MHDB の stun と一致)。
- `wound` = 傷口の肉質 (Param_Parts `_ScarPointArray` の `_MeatGuid`)。傷口の無い部位は null (34 部位)。
- `states` のキーは内部名のまま (意味は下の未確定事項)。`meta.stateKeys` に内部名・意味・確度を入れてある。
- 部位の日本語名は `PartNames.json` の `ja`。名前が無いスラッグ (今回は `hide` だけ) は捨てずに
  `name: "部位不明（hide）"`、`unknownPart: true`。同じモンスターに複数あるときは `key` を `hide-1`, `hide-2` … にする。
- 日本語名が重なる部位 (ゾ・シアの `head` と `head-hide` がどちらも「頭」など) は、スラッグが長い方に
  `（head-hide）` を付けて区別した。
- `internalType` は生データの部位種類 (HEAD 等)、`ordinal` は damage_calculator の並び順 (部位の並びはこれ)。
- `variants` は MHDB の `tempered` (歴戦の個体) / `arch-tempered` (歴戦王) / `frenzied` (狂竜化) / `alpha`
  (ボス個体・クローン)。日本語の個体名は `variantNames`。
- `statusWeakness`: MHDB の weaknesses の `level` (★)。無効 (resistances) は 0 にして `immune` に入れる。
  どちらにも無ければ null。`stun` と `exhaust` は MHDB に段階が無く、効くなら 1 しか入らない。
- `itemEffects`: 閃光 (`flash`) と音爆弾 (`noise`) が効くか。条件つき (「地中に潜っている間のみ」など) は `conditions`。
- MHDB の**属性弱点フラグ (weaknesses の element) は使っていない** (ゴグマジオスに 1 件も無いなど抜けが多い)。

### 推奨属性 (`bestElement` と `elementRecommendation`)

- 部位ごとの `bestElement`: 通常肉質で一番高い属性 (同値は全部)。最大が 0 なら `types: []`。
- モンスター全体の `elementRecommendation.best`:
  1. 主要部位 = 名前のある部位 (unknownPart 以外) のうち **斬撃肉質 45 以上** (弱点特効が効く肉質) の部位。
  2. 主要部位が 2 部位未満なら、斬撃肉質の上位 3 部位 (同値は ordinal 順) を主要部位にする
     (グラビモス・タマミツネ・ゴグマジオスが該当。`basis` に方式を書いてある)。
  3. 主要部位の属性肉質を**単純平均** (左右の脚などはそれぞれ 1 部位として数える) し、最大の属性を `best` (同値は全部)。
     `order` は平均の高い順。`allPartsAvg` は名前のある全部位の平均 (参考)。
- 参考値 `stateMaxAvg` / `bestStateMax`: 主要部位ごとに通常と states の中で一番高い値を取って平均したもの。
  通常肉質だけの推奨とずれるのは 護竜ドシャグマ (火・龍 → 火)、護竜アンジャナフ亜種 (氷 → 水)、
  ゴグマジオス (火 → 龍) の 3 体。形態で肉質が大きく変わるので、画面では states を見られるようにすること。
- アルシュベルド/護竜アルシュベルドは主要部位の属性肉質がほぼ全属性同じ (平均 2.5) なので `best` に 5 属性すべてが並ぶ
  (= 属性で差が付かない)。

### 破壊・切断

- `severable` (切断): 生の `Param_PartsLost` → `_PartsBreakGuid` → `_PartsBreakArray` の対象部位のうち、
  `_PartsType` が同じ部位。MHDB の報酬に切断剥ぎ取り (carve-severed) があるモンスター 21 体と、PartsLost が
  あるモンスターは完全に一致する (一致しなければ生成を止める)。MHDB の carve-severed には部位名が無いので部位の特定には生データを使った。
- `breakable` (破壊): 生の `_PartsBreakArray` のうち切断以外の対象部位。複数部位にまたがる破壊 (MultiParts) は、
  破壊の種類名と部位の種類名が重なる部位に絞る (重ならなければリンク先の全部位)。
- `breakReward`: MHDB の報酬 (broken-part) が付いている部位スラッグか。**作業指示は「報酬から」だったが、MHDB は
  複数部位にまたがる破壊の報酬を 1 部位 (例: レ・ダウの翼の破壊 → `hide`) に寄せているため、破壊可否はゲームデータを正とし、
  報酬の部位は `breakReward` に分けて持った。** 食い違う部位には `note` を付けた (18 部位):
  - ゲームデータでは破壊対象だが報酬に無い: ゾ・シアの白纏晶 3 部位、レ・ダウの左右の翼、ネルスキュラの外套膜・毒トゲ、
    ケマトリスの尻尾、ププロポルの左前脚、護竜オドガロン亜種の左前脚・左後脚・尻尾、ゴグマジオスの尻尾。
  - 報酬は `hide` に付いているが hide が複数あって特定できない (`breakReward: null`): レ・ダウ 3 部位、ネルスキュラ 2 部位。

## monster_threats.json の作り方

- Bucket API に LIKE が無いので、`monsters_games` を `page_name` 順に `limit(500).offset(n)` で全件めくり
  (2,729 行・6 回)、`page_name` が `(MHWilds)` で終わる行を取った。英語名は mhdb-wilds-data の `names.en` で MHDB id に結合。
- `roar`: none / weak (咆哮【小】) / strong (咆哮【大】)。wiki の値は配列なので一番強いもの。
- `windPressure`: none / minor (風圧【小】) / major (風圧【大】) / dragon (龍風圧)。
- `tremor`: none / minor (振動【小】) / major (振動【大】)。
- `attackElements` は wiki の `elements`、`blights` (属性やられ) は wiki の `status_effects` のうち Fire/Water/Thunder/Ice/Dragon。
- `statusEffects` は残りの状態異常。日本語名はゲーム内テキストで確認したもの。確度は `nameConfidence`。
- `rules`: 防御スキルの規則。
  - 属性やられ: **属性耐性 20 以上でその属性のやられ無効、属性やられ耐性 (skillId 49) Lv3 で全属性無効**、Lv1/2 は時間短縮
    (wiki Status Effects に明記。確度 high)。
  - 咆哮/風圧/振動/状態異常ごとに、無効になるレベル (`negateLevel`) と軽減が始まるレベル (`mitigateLevel`)、
    MHDB のレベルごとの効果文 (`levelText`) を持つ。skillId は MHDB の skill id (`data/skills.json` の id と一致を確認済み)。
  - 防具スキルで防げないもの (泡状態・狂竜症・雪だるま) は `noSkill` に文章で書いた。

## quests.json の作り方

- `id` は wiki の英語のクエスト名 (220 件で重複なし)。`name` は MissionData の日本語名 (結合できなかった 14 件は英語名のままで
  `nameLang: "en"`)。
- MissionData との結合: 英語名を正規化 (小文字・記号除去・先頭の「Event:」除去) して完全一致、無ければ類似度 0.9 以上。
  同名の MissionData 行が 2 つある (199xxx と 5xxxxx) ものは、中身 (★・対象) がある方を使う。結合できたものは
  ★ 206/206、大型の対象 206/206 が wiki と一致。
- `targets`: wiki の `goal_icon_names` (アイコン 1 つ = 1 体)。同じモンスター・同じ個体は `count` にまとめる。
  `variant` はアイコン種別 (Tempered / Arch Tempered / Frenzied) と、名前 (Alpha Doshaguma) や要約のリンク表示名
  (Nerscylla Clone) から。小型の討伐 (「Slay 8 Piragill」) は `large: false`・`monsterId: null` で、数は要約の数字。
- `multi`: 大型の狩猟対象が 2 体以上 (`largeTargetCount >= 2`)。34 件。
- `variant` (クエスト単位): 大型の対象の個体がすべて同じならそれ、違えば `mixed`、どれも通常なら null。
- `intruders`: wiki の `other_large_monsters` (同じフィールドに出る大型 = 乱入の可能性がある大型)。重複は除いた。
  名前に個体名が付くもの (「Tempered Rathalos」「Alpha Doshaguma」「Frenzied Gypceros」等) は接頭辞を外して `monsterId` を引き、
  個体を `variant` に入れる (2026-10-21 検証で修正。修正前は 427 件中 92 件が `monsterId: null` になっていた)。
- `fixedEquipment`:
  - true (17): `arena_info` に装備セット (Set 1〜3) の記載がある (アリーナ/チャレンジ。説明文に
    「pre-determined set of equipment」とあるものは確度 high、ほかは medium)。悪鬼 (Akuma Set) のクエストを含む。
  - null (5): タイムランキング付きのチャレンジ (Burn in Blackest Hell / The Cold Path to Oblivion / The Daunting Downpour /
    The Proud Child of the Wilds / The Shining Storm Rages)。wiki 本文では「Free Challenge Quest」と呼ばれており (The Proud Child of the Wilds で確認)
    持ち込み装備と思われるが、Bucket の項目からは判断できないので null。
  - false (198): それ以外の通常クエスト。
- `mission`: 結合できた MissionData の行。対象ごとの `health` (体力倍率)・`attack`・`partsVital`・`soloHealth`
  (ソロ時の体力の候補値)・`legendaryId` (NONE / NORMAL = 歴戦の個体 / KING = 歴戦王)。

## 未確定事項

| 項目 | 状態 | 確度 | メモ |
|---|---|---|---|
| `states.custom1〜5` の意味 | 内部名 (`_MeatGuidCustomN`) のまま | low | モンスター固有の状態 (形態変化・部位の展開・怒りなど) と思われるが、どの行動で切り替わるかはデータに無い。例: ゴア・マガラの翼脚 custom1 は斬 27→60 (翼脚展開?)、ゴグマジオスの頭 custom1〜3 で龍 25/50/65 |
| `states.break` の意味 | 「部位破壊後」と解釈 | medium | 内部名 `_MeatGuidBreak` から。破壊後に切り替わることの実地確認はしていない |
| `states.weakPoint` (弱点) の意味と出現条件 | 内部名 `_WeakPointArray` の肉質を入れた | low | 斬 100 など高い値が多い。出現条件 (部位破壊後・傷口・特定の行動中など) は不明。部位に直接ひも付かない弱点 (MultiParts 等へのリンク) が 10 体 16 件あり、これは入れていない |
| 怒り時の肉質 | 専用の項目は無い | medium | Param_Parts に怒り専用の肉質欄は無い。custom のどれかが怒りの可能性はある。Param_Legendary の Angry は攻撃倍率で肉質ではない |
| 歴戦の個体・歴戦王の肉質差 | 差は無いと判断 | medium | 肉質は Param_Parts 1 つで、個体別の肉質表は見つからない。歴戦/歴戦王で変わるのは体力・攻撃などの倍率 |
| 歴戦の個体・歴戦王・★10 の体力倍率 | 2 か所にある | medium | (1) `monsters[].legendaryParams` = Param_Legendary の倍率を内部名の群 (`normal` / `king` / `hard` / `kingHard`) のまま入れた。`normal` = 歴戦の個体、`king` = 歴戦王と見ているが、**`hard` の意味 (★10 や高難度版?) は不明**。(2) クエスト単位の倍率は `quests[].mission.targets[].health` (MissionData の `_Health`)。両者がどう掛け合わさるかは未確認 |
| MHDB の stun / exhaust の★ | 1 (効く) しか入らない | high | MHDB に段階が無い。気絶・減気の効きやすさの段階は出典が無い |
| ゾ・シアの風圧 | wiki の値が wiki マークアップの生文字列 | high | 文字列中の「Dragon Wind Pressure」を読んで `dragon` にした (issues に記録) |
| ケマトリスの咆哮・風圧・振動 | wiki に値が無い | - | null のまま |
| wiki の「Soiled」 | 悪臭 (stench) と解釈 | medium | wiki の状態異常ページには「Stench」節があり、ババコンガ系の状態として同じものと判断 |
| wiki の「Snowman」 | 雪だるま | low | ゲーム内テキストで確認できなかった |
| wiki の「Frostblight」 | 凍結 (拘束の一種、拘束耐性で防ぐ) | high | 氷属性やられ (Iceblight) とは別物。wiki の `Ice` が氷属性やられ |
| 乱入 (`intruders`) | wiki の other_large_monsters | medium | 「同じフィールドに出る大型」であって、必ず乱入するわけではない。MissionData の `_SubBossInfoArray` も同じ趣旨と思われるが使っていない |
| フリーチャレンジ 5 件の装備 | null | low | 上記の通り |
| 日本語名の無いクエスト 14 件 | 英語名 | - | MissionData に無い (タイムアタック系・一部イベント)。Boundless Blades / Burn in Blackest Hell / Congalala Cravings / Doshaguma of the Hollow / Fleeting Bubbles / Gravios Blockade / Peak Nerscylla / Romping Around / Stalking Supper / The Cold Path to Oblivion / The Daunting Downpour / The Proud Child of the Wilds / The Shining Storm Rages / Where You'd Least Expect |
| オメガ・プラネテスの個体 | 解消 (通常個体) | high | 「Invader from the Stars」「Planetes Protocol」の 2 件は wiki のアイコン種別も N/A で、MissionData も NONE。以前 tempered になっていたのは、MHDB の歴戦の個体名が基本種と同じ「Omega Planetes」なので要約のリンク表示名から歴戦と誤判定していたため (2026-10-21 検証で修正。基本種と同名の個体名は手がかりにしない)。歴戦/歴戦王は MissionData の `_LegendaryID` と全件一致 |
| `hide` の部位名 | 部位不明 | - | PartNames.json に名前が無い。damage_calculator (中国語) では「外皮」。27 部位、推奨の計算から除外 |
