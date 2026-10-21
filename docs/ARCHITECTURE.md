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

### data/motions_sns.json と data/combos_sns.json
技ごとのモーション値と属性補正、代表コンボ (技とヒット数の並び)。日本語の技名。

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

### data/monster_threats.json (CC BY-SA 4.0)
咆哮・風圧・振動・属性やられ・状態異常の種類。防御スキルを勧めるかの判定に使う。欠損は null。

### data/quests.json
クエスト名・★・種類・狩猟対象・装備固定かどうか。

## 計算モデルの方針 (app/model/damage.js)

- 物理 = 攻撃力 × MV/100 × 物理肉質/100 × 斬れ味物理補正 × 会心期待値
- 属性 = (属性値 × 乗算 + 加算)/10 × 属性肉質/100 × 斬れ味属性補正 × 技の属性補正 × 会心撃【属性】期待値
- 攻撃力 = 武器攻撃力 × 乗算 + 加算 (乗算が先)。会心率は -100〜100% で切る。
- 条件つきスキル (挑戦者・連撃・フルチャージ・逆恨み・力の解放 など) は発動率 (0〜1) を人が入れる。
  組み合わせは独立と仮定し、発動/非発動の全パターンで加重平均する。
- 「DPS」は秒数が公開されていないので出さない。**代表コンボ1回の期待値**と、**スキルなし比の上昇率 (%)** を出す。
- 弱点特効は肉質 45 以上 (弱点) で効く。傷口には追加分。
- 灼熱化などシリーズ由来の追加ダメージは、肉質に依存する部分と固定部分を分けて持つ。

## 段階

1. データ + 計算モデル + 装備からスキル表示 + 火力比較 + 護石一覧 (←いまここ)
2. 所持護石を使った装備探索
3. モンスター別・多頭クエストの推奨
