# 相手別のおすすめ・多頭クエスト (段階 3) と、探索・おすすめの画面 (段階 2・3) の設計

相手 (モンスター + 個体、またはクエスト) を選ぶと、武器の属性・守りのスキル・狙う部位を決めて装備探索 (段階 2 のソルバ) に渡し、
上位の装備を iPhone の画面に出す。歴戦王 (5 体) のデータ (体力・攻撃の倍率・傷口の肉質・専用の脅威・γ 防具) もここで使う。

- 正にするもの: データの形 = `docs/ARCHITECTURE.md`、計算モデル = `docs/MODEL_API.md`、画面の部品と状態 = `docs/UI_API.md`、
  探索 (ソルバ) = `docs/SEARCH_DESIGN.md`。この文書はそれらを変えずに、上に載せる部分を決める。実装の段で各文書に反映する (8 章)。
- 書いた日: 2026-10-21。数字はこの日のデータ (片手剣 95 本・防具 714 個・大型 34 体・クエスト 220 件・多頭 34 件) で確かめた。
- 「方針」と書いたものは、データの根拠ではなく、このアプリの決めごと (本人に確かめる。9 章)。

---

## 0. 結論

1. **おすすめは「必須 (オン/オフ) の条件」に直してソルバに渡す。重み付きの目的にはしない。** 火力と守りは単位が違い、重みを本人が
   決められないため。代わりに「守りのスキルを付けると火力が何 % 下がるか」を出す (2.5 節)。
2. **守りのスキルは、脅威のデータ (monster_threats.json の rules と歴戦王の variants) から機械的に作る。** 既定でオンにするのは
   「歴戦王の脅威のうち防げるもの」と「確定している属性やられ」だけ (方針・仮)。咆哮・風圧・振動・状態異常は「参考」で、
   1 タップでオンにでき、オンにしたときの火力の差を出す。体力・回復系は自動では足さない (攻撃の倍率の確度が low で、受けるダメージを
   計算できないため)。
3. **多頭クエストは「倒すまでのコンボの回数の合計」を小さくする。** ソルバは加重平均しか扱えないので、重みを「時間のかかる相手を重く」
   (体力 ÷ 基準の期待値²) にして探し、上位を正しい回数の合計で並べ直す (3 章)。属性の違う相手がいれば、防具・護石は共通で
   武器を 2 本持ち替える案も出す (3.3 節)。
4. **画面は 6 つ目のタブ「探す」を足す** (並び: 装備・火力・相手・探す・護石・設定)。段階 2 (自分で条件を決める) と段階 3 (相手に
   合わせる) は同じタブで、段階 3 は条件が先に埋まった段階 2 にする。相手タブには 個体 (通常/歴戦の個体/歴戦王)・クエスト・人数・
   体力と強さ・討伐までの回数の目安・歴戦王で変わること・「この相手で装備を探す」を足す (4 章)。
5. **計算は model に置く**: `app/model/hunt.js` (体力・回数・個体の肉質。速い純粋関数) と `app/model/recommend.js` (おすすめの組み立て・
   多頭の重み・並べ直し・守りのチェック・複数回の探索をまとめて回す `createPlanRunner`)。探索は Worker の中で、
   `createSearch` と同じ `step / progress / result / cancel / extend` の形で回す (5 章)。

---

## 1. 使うもの (いまあるもの)

| もの | 中身 | 使い道 |
|---|---|---|
| `monsters.json` の `individuals[]` | 個体ごとの群・倍率・クエスト・`hitzone.woundOverrides`・`hitzone.elementRecommendation`・`threatVariant`・`rewards` | 個体の選択、歴戦王の傷口、おすすめ属性、γ 防具の印 |
| `monsters.json` の `elementRecommendation` / `legendaryParams` | 主な部位の属性肉質の平均 / 群ごとの倍率 (`woundVital` など) | おすすめ属性、傷の付きにくさ |
| `quests.json` の `mission.targets[]` | `healthCalc` (ソロの体力)・`multi` (人数の倍率・確度 low)・`attackRate` (確度 low)・`paramGroup` | 体力・人数・攻撃の強さ・多頭の重み |
| `quests.json` の `availability` / `fixedEquipment` / `multi` / `intruders` | 常設/終了・装備固定・多頭・乱入 | クエストの一覧と既定の選び方 |
| `monster_threats.json` の `rules` と `monsters[].variants['arch-tempered']` | 咆哮・風圧・振動・属性やられ・状態異常と防ぐスキル / 歴戦王の `hazards`・`moveChanges`・`sameAsBase` | 守りのスキル |
| `target_mix.js` | `resolveTargetMix` / `recommendationView` / `threatInfo` / `defaultPartKey` / `WEAK_POINT_MIN` | 部位の割合・おすすめ属性の見せ方 |
| `power_calc.js` / `equip_logic.js` | `mixTotal` / `summarizePower` / `resolveWeaponRef` / `autoSharpness` | いまの装備の期待値・討伐までの回数 |
| 探索 (`SEARCH_DESIGN.md`) | `createSearch(input, data)`。`targets` の加重平均・`required`・`armorExclude`・`step(ms)` | 段階 2・3 の本体 |

歴戦王のデータで分かっていること (確度は `docs/sources/monsters.md`):

| 歴戦王 | おすすめ属性 (傷口の置き換え後) | 防具スキルで防げる専用の脅威 | 傷口の肉質 |
|---|---|---|---|
| レ・ダウ | 氷 (はっきり) | なし | 通常と同じ (medium) |
| ウズ・トゥナ | 雷 (はっきり) | なし | **変わる** (弾・雷。medium) |
| ヌ・エグドラ | 水 (はっきり) | 点火中の炎 → 環境適応 Lv2 (high) | 通常と同じ (medium) |
| ジン・ダハド | 火 (どれも効きにくい) | 冷気のつむじ風 → 拘束耐性 Lv3 (medium)。ノヴァは防げない (一撃で力尽きる) | 通常と同じ (medium) |
| アルシュベルド | 龍 (どれも効きにくい・全属性 2.5) | なし | 置き換えがあるが、いつ使われるか不明 (low) |

(「はっきり」「どれも効きにくい」は `recommendationView` の `clear` / `weak`。上は 2026-10-21 のデータで計算した値)

---

## 2. 段階 3 のおすすめの作り方

### 2.1 流れ

```
相手タブ (state.target: monsterId / individual / questId / questTargetIndex / players / 部位 / 傷口)
   │  buildPlan (recommend.js。画面のスレッドで数 ms)
   ▼
Plan = { subjects (戦う相手の一覧), element (武器の選び方), requirements (守りのスキルの候補),
         notes (防げない攻撃など), exclusions (作れない防具), weights (多頭の重み) }
   │  探すタブで本人がオン/オフ・Lv・プリセットを変える (state.search)
   │  planToJob
   ▼
Job = { runs: [createSearch の入力, ...], merge: {single | multi | twoWeapons}, K }
   │  Worker (createPlanRunner が createSearch を順に回す)
   ▼
結果: 上位 K 件 (いまの装備との差・守りのチェック・討伐までの回数・多頭なら相手ごとの回数)
```

- `subjects` = 戦う大型の一覧。モンスターを選んだだけなら 1 件、多頭クエストなら `mission.targets[]` の行ごと (同じモンスターが
  2 頭なら 2 件。体力が違うことがある。例: 『ハンター達の永い夢』のケマトリス 4 頭は 19,000 / 16,400 / 14,400 / 12,000)。
  乱入 (`intruders`) は入れない (必ず来るわけではない。画面に「乱入の可能性」として名前だけ出す)。
- 装備固定のクエスト (`fixedEquipment: true`。アリーナなど) は探索しない (「装備が決められたクエストです」と出す。体力などは出す)。

### 2.2 相手の決め方と、クエストの既定

- モンスター → 個体 (`individuals[].kind`。null = 通常) → クエスト の順に選ぶ。クエストは選ばなくてもよい (体力と回数が出ないだけ)。
- 個体を選んだら、クエストを自動で 1 つ選んでおく (方針): その個体が**狩猟対象**のクエスト (`questIds`) のうち、
  1. 装備固定でない、2. `mission` がある (体力が分かる)、3. 多頭でない、4. 受けられる (`availability.status` が
  permanent / standard / active)、を満たすものの中で ★ が一番高いもの。同じ ★ なら一覧の先頭。無ければ選ばない。
  - 歴戦王なら ★10 の単体クエスト (例 アルシュベルド → 『孤独から出でし君という自由』、体力 79,923)。
- 多頭クエストには、そのクエストに出るモンスターを 1 体選んでからクエスト欄で選ぶ。全クエストを名前で探す入り口も置く (4.2 節)。

### 2.3 (a) 武器の属性

- 個体のおすすめ属性 = `individuals[].hitzone.elementRecommendation` (傷口の置き換えがある個体) か、無ければモンスターの
  `elementRecommendation`。見せ方は既存の `recommendationView` (`clear` / `close` / `weak` / `none`) をそのまま使う。
- 探す武器の範囲 (`state.search.weaponMode`。既定 `auto`):

| 場合 | `auto` の決め方 | ソルバに渡す `weapons` |
|---|---|---|
| いまの武器があり、属性が 1 位と同じか差が小さい (`weapon` が `same` / `close`) | いまの武器 | `[いまの武器]` (B1 と同じ速さ) |
| おすすめがはっきり (`clear`) で、いまの武器が違う属性 | おすすめ属性から | おすすめ属性 (1 位と差が 2 以内の属性も) の片手剣 + 同じ属性の所持アーティア + いまの武器 (比べるため) |
| どれも効きにくい (`weak` / `none`) | いまの武器 (無ければ全部) | `[いまの武器]` か `'sns-all'` |
| 多頭 | おすすめ属性から | 相手ごとの `clear` の 1 位の属性を合わせたもの + いまの武器 |

- 本人は「いまの武器 / おすすめ属性から / 全部から (遅い)」を選び直せる。全部から = B3 (Node でビームと仕上げまで 2.4 秒・
  iPhone は 2〜3 倍の見込み)。
- 状態異常の武器 (毒・麻痺・睡眠・爆破) は、計算に蓄積が入っていないので物理だけで評価される (不利に見える)。画面の「くわしく」に書く。

### 2.4 (b) 守りのスキル

#### 脅威を集める (`collectThreats`)

subject ごとに次を集め、1 件ずつ「防ぐスキルと Lv」を付ける。どれも `monster_threats.json` の値と `rules` だけを使う (Game8 の値は使わない)。

| 脅威 | 出どころ | 防ぐスキル (無効にする Lv) |
|---|---|---|
| 咆哮【小】/【大】 | `roar` | `rules.roar.weak/strong` (耳栓 Lv2 / Lv3) |
| 風圧【小】/【大】/龍風圧 | `windPressure` | `rules.windPressure.*` (風圧耐性 Lv1 / 2 / 3) |
| 振動【小】/【大】 | `tremor` | `rules.tremor.*` (耐震 Lv2 / 3) |
| 属性やられ (確定) | `blights` | 属性やられ耐性 Lv3 **か** その属性の耐性の値が 20 以上 (`rules.elementalBlight`) |
| 属性やられ (未確認) | `blightsUncertain` | 同上。既定はどのプリセットでも「参考」 |
| 状態異常 | `statusEffects` | `rules.status[key]` (無ければ `rules.noSkill` の文) |
| 歴戦王の専用の脅威 | `variants[kind].hazards` (`skill` あり) | `hazards[].skill` (例 環境適応 Lv2・拘束耐性 Lv3) |
| 防げない攻撃 | `hazards[].oneShot` / `skill: null`・`rules.noSkill` | なし → 注意の文 (`notes`) だけ |

- 同じスキルの要るものはまとめる (Lv は大きい方。理由は全部残す)。例: ジン・ダハドの歴戦王は 状態異常の凍結 と 冷気のつむじ風 が
  どちらも拘束耐性 Lv3 なので 1 行。
- 個体の `variants[kind].sameAsBase` が true なら、咆哮などは通常の値を使う (確度 medium → 画面の「くわしく」に「通常と同じと見ています」)。
- 軽減の Lv (`mitigateLevel`) がある脅威は、行の中で「軽く Lv1 / 無効 Lv2」を選べる (既定は無効の Lv)。

#### 段 (プリセット) — 方針・仮

| 脅威 | 火力優先 | **バランス (既定)** | 安全 |
|---|---|---|---|
| 歴戦王の専用の脅威 (防ぐスキルあり) | 参考 | **オン** | オン |
| 属性やられ (確定) | 参考 | **オン** | オン |
| 咆哮・風圧・振動 | 参考 | 参考 | オン |
| 状態異常 (防ぐスキルあり) | 参考 | 参考 | オン |
| 属性やられ (未確認)・確度 low の脅威 | 参考 | 参考 | 参考 |
| 防げない攻撃 | 注意の文 | 注意の文 | 注意の文 |

- 「オン」= ソルバの必須にする。「参考」= 必須にしないが、一覧に出して 1 タップでオンにでき、「付けると火力 −x.x%」を試せる。
- 本人がオン/オフを変えたものは `state.search.toggles` に残り、プリセットより優先する。
- プリセットの中身は根拠の無い決めごとなので、プリセットの選択欄に「仮」の印を付ける (2.8 節)。

#### 属性やられ (「または」の条件)

- 防ぎ方が 2 通り (属性やられ耐性 Lv3 / その属性の耐性の値 ≥ 20) あり、ソルバの `required` (全部満たす) では書けない。
- **やり方: 探索を 2 回に分けて、結果を合わせる** (ソルバは変えない)。
  1. 属性やられ耐性 Lv3 を必須にした探索
  2. 各属性の耐性スキル Lv3 (耐性 +20) を必須にした探索 (多頭で属性が複数でも、この 1 回にまとめる)
- 耐性の値の合計は防具の耐性値でも変わる (例 レダゼルトγ は 1 部位で雷 +4、5 部位で +20)。ソルバは耐性の値を知らないので、
  2 の探索は「スキルで +20」だけを狙い、結果は返したあとで耐性の合計を計算して (`resistTotals`)、20 に届かない組には
  「あと 3 足りない」と出して下に並べる。防具の耐性値だけで 20 に届く組は狙っては探さない (たまたま見つかれば ✓ になる)。
  ソルバに「耐性の値 ≥ 20」の条件を足すのは後回し (7 章の 3c)。
- 耐性スキルの値 (Lv1 +6・Lv2 +12・Lv3 +20) は MHDB のスキルの説明文にあるが、構造化されたデータが無い。tools で
  `skill_effects.json` に `rules.resistSkills` を生成する (5.8 節)。

#### 歴戦王の攻撃の強さと、体力・回復系の扱い

- 受けるダメージは計算できない (技ごとの攻撃値が無い。`attackRate` は掛け方が推定で確度 low)。なので**体力・回復系のスキルは
  自動では足さない**。
- 画面には攻撃の強さを「同じモンスターの別のクエストの何倍か」で出し、「未確定」の印を付ける (4.2 節)。
  例: 歴戦王アルシュベルド ★10 は 8.4、狩猟演習 (★9 歴戦の個体) は 7.15 → 約 1.17 倍。
- 探すタブに「守りのスキルを足す」の一覧を置き、本人が選ぶ: 回復速度・体力回復量ＵＰ・精霊の加護・防御・ひるみ軽減・回避性能・
  回避距離ＵＰ・ガード性能・ガード強化 (いずれも `skills.json` にある)。Lv は本人が決める。足すと「火力 −x.x%」を出す。
- ヌシの魂 (γ 防具 3 部位) は火力スキルでもある (根性が出るまで攻撃 ×1.05。条件 `beforeGuts` の既定は 100%)。歴戦王で被弾が多い人は
  火力タブでこの発動率を下げる、と「くわしく」に書く (自動では変えない)。

### 2.5 必須か、重み付きか (決めたこと)

| やり方 | よい | わるい | 判断 |
|---|---|---|---|
| **必須 (オン/オフ)** | ソルバがそのまま扱える (上界・刈り込みが効く)。結果が「守りを満たす中で火力が最高」とはっきりする | 少しの火力の差で守りを全部捨てる/全部取る、の二択になる | **採用** |
| 重み付き (火力 × (1 + Σ 重み × 満たしたか)) | 「少しなら守りを取る」ができる | 重みの単位が無く本人が決められない。ソルバの上界の前提 (目的 = 期待値) が崩れる | 採らない |
| 守りの点を別に出して 2 つの軸で並べる | 両方見える | 上位 K の選び方が決まらない。iPhone の画面で 2 軸は読みにくい | 採らない |

二択の弱さは、**火力の差を見せて**補う:

- 探索が終わったら、守りの「オン」を全部外した探索を 1 回 (途中の結果まで。B1 なら Node で約 0.8 秒) 回して、
  「守りのスキルのために火力 −3.2%」のように出す。
- 「参考」の行には「試す」ボタン。押すとその 1 つを足した探索を途中の結果まで回し、「付けると火力 −1.1%」をその行に出す
  (結果は探索の条件が変わるまで覚えておく)。

### 2.6 (c) 部位の狙い方

`state.search.partsPolicy` (既定 `asSelected`):

| 値 | 中身 |
|---|---|
| `asSelected` | 相手タブで選んだ部位・割合 (`tabs.target`)。多頭で、そのモンスターを相手タブで開いたことが無ければ `weak1` |
| `weak1` | 弱点 1 か所 = `defaultPartKey` (名前のある部位で切断肉質が一番高いもの。同じなら傷口が高いもの) |
| `main3` | 主な部位 = 名前のある部位で切断 45 以上 (`WEAK_POINT_MIN`) の上位 3 か所を等分 (無ければ `weak1`)。方針・仮 |

- 傷口を狙うか (`state.target.isWound`) は全部の相手に同じに使う。
- **歴戦王の傷口**: `individuals[].hitzone` を見て `target.wound` を置き換える (`hunt.hitzoneFor`)。
  - `sameAsBase: false` (ウズ・トゥナ) → `woundOverrides` を使う (例 頭の傷口 弾 88→70・雷 25→20)。印「未確認」(確度 medium)。
  - `sameAsBase: null` (アルシュベルド) → 既定は通常の傷口のまま。相手タブの「置き換わった傷口で計算する (参考)」で
    `woundOverrides` を使える (`state.target.useUncertainWound`)。印「未確定」。
- 歴戦王は傷が付きにくい (`legendaryParams[群].woundVital.normal` = 1.5〜2.7。意味は推定・確度 low)。コンボの傷口の段は
  「傷口がある前提」の値なので、相手タブと結果に「歴戦王は傷が付きにくいので、傷口を狙う技の回数は減ります」と出す。数値には入れない。

### 2.7 作れない防具・護石 (γ と狩猟証γ の護石)

- γ 防具 25 個と狩猟証γ で作る固定護石 10 個は、その歴戦王を狩らないと作れない。`individuals[].rewards` から
  `armorExclude` / `charms.fixedExclude` を作る (`recommend.gammaExclusions`)。
- 本人が「倒した歴戦王」を探すタブで選ぶ (`state.search.archTemperedHunted`。既定 = 5 体とも倒した扱い。本人に確かめる)。
  外すと グループスキル「ヌシの魂」(γ にだけ付く) も使えなくなる、と出す。
- 結果の防具に γ があれば「歴戦王〇〇の素材が要ります」と印を出す (B1 の上位には ダハディラメイルγ などが入る)。

### 2.8 確度の出し方 (印の使い分け)

`docs/UI_API.md` の決まり (仮 = 根拠の無い仮置き、未確認 = データで確かめていない事実、未確定 = 根拠の弱い数値) に合わせる。

| もの | 印 |
|---|---|
| プリセットの中身・部位の `main3`・おすすめの行のうち根拠の確度が high でないもの | **仮** (おすすめそのものが仮の判断) |
| 属性やられの `blightsUncertain`、歴戦王の `sameAsBase` (medium)、歴戦王の脅威で確度 medium のもの (ジン・ダハドのつむじ風)、ウズ・トゥナの傷口 | **未確認** (「くわしく」に理由) |
| マルチの体力 (`multi` の確度 low)、攻撃の強さ (`attackRate`)、傷の付きにくさ、アルシュベルドの置き換えた傷口 | **未確定** |
| ソロの体力 (`healthCalc` の確度 medium) | 印なし。「くわしく」に「ゲームデータから計算 (第三者の実測 1 件と一致)」 |
| 探索の結果 (最適の証明が無い) | **近似** (info の印。`SEARCH_DESIGN.md` 2.11 節) |

### 2.9 Game8 との違い (照合だけ・値は取り込まない)

Game8 の歴戦王ごとの対策ページ (2026-10-21 に人が見たもの) と、上の作り方 (プリセット「安全」) を比べた結果の見込み。テスト (6.3 節) で固定する。

| 歴戦王 | 両方にある | Game8 にだけある (こちらに出典が無い) | こちらだけ |
|---|---|---|---|
| レ・ダウ | 雷属性やられ (雷耐性 Lv3)・耳栓 Lv2 | 気絶耐性 Lv3・回避距離ＵＰ | — |
| ウズ・トゥナ | 水属性やられ (水耐性 Lv3) | ヌシの魂・精霊の加護・回避距離ＵＰ | 耳栓 Lv2 |
| ヌ・エグドラ | 火属性やられ (火耐性 Lv3)・環境適応 Lv2 | ガード強化 (盾でブレスを受ける) | 耳栓 Lv2 |
| ジン・ダハド | 拘束耐性 Lv3 | 氷耐性 Lv3 (こちらは氷属性やられが未確認なので「参考」) | 耳栓 Lv3 |
| アルシュベルド | 龍属性やられ (龍耐性 20 以上) | — | 耳栓 Lv2・風圧耐性 Lv1 |

- 「Game8 にだけある」ものは、wiki のデータ (`monster_threats.json`) に根拠が無いので自動では出さない。本人が「守りのスキルを足す」で選べる。
- Game8 の片手剣の構成は 4 つとも火属性の巨戟アーティアで、相手ごとの属性を変えていない。属性のおすすめは比べない。

---

## 3. 多頭クエスト

### 3.1 何を最小にするか

相手 i の体力を H_i、その相手での 1 コンボの期待値 (部位の割合で平均) を D_i とすると、全部倒すまでのコンボの回数は

```
T = Σ_i  H_i / D_i
```

これを小さくしたい。ソルバの目的は加重平均 Σ w_i D_i (線形) なので、基準の装備のまわりで T を 1 次で近づけた重みを使う:

```
w_i ∝ H_i / D_ref_i²        (= 基準の装備での「その相手にかかる時間の割合」÷ D_ref_i)
```

- D_ref_i = いまの装備 (武器があれば) の期待値。武器が無ければ、候補の先頭の武器のスキルなしの期待値。
- 相手の中の部位の割合は、その相手の重みに掛ける (ソルバの `targets` = 相手 × 部位 の行を全部並べ、重みは w_i × 部位の割合)。
- ソルバの結果は相手ごとの値 (`perGroup`、5.4 節) を持つので、**上位 K 件を本当の T で並べ直す** (近づけた重みで並びが変わっても、
  出す順は正しい)。画面の主な数字も T (「全部倒すまで 約 210 回」) にする。
- 比べた案:

| 重み | よい | わるい |
|---|---|---|
| 等分 | 単純 | 体力 3 万と 1 万 2 千の相手を同じに見る |
| 体力の比 (H_i) | 分かりやすい | 肉質の硬い相手 (時間がかかる相手) を軽く見る |
| **時間の比 (H_i / D_ref_i²)** | T を小さくする向きと 1 次で一致 | 基準の装備しだいで少し変わる (並べ直しで補う) |
| T を直接 | 正しい | 目的が非線形で、ソルバの上界・刈り込みが使えない |

- 基準を探索の 1 位に替えてもう 1 回、は既定ではしない (時間が倍になる)。小さい問題で総当たりと比べて差を測り (6.2 節)、
  差が大きければ入れる。

### 3.2 体力が分からないとき・人数

- `mission: null` (フリーチャレンジなど) か `healthCalc` が無い相手は、分かっている相手の体力の平均で置き、「体力不明のため仮」と出す。
  全員分からなければ等分。
- 人数の倍率 (`multi.health`) は同じクエストの相手でふつう同じ表なので、重みには入れない (全員に同じ倍率が掛かる)。
  表が違う相手がいれば、H_i × 倍率 で重みを作る。
- 1 人あたりの回数 = H_i × 倍率 ÷ 人数 ÷ D_i (全員が同じだけ当てる前提の目安・未確定)。

### 3.3 武器を 2 本にする案 (防具・護石は共通)

ワイルズは武器を 2 本持って出られ、セクレトで持ち替えられる (ゲームの仕様。データでは確かめていない)。
属性の違う相手がいる多頭クエストでは、防具・護石を共通にして武器を 2 本にすると回数が減ることがある。

- 共通のもの: 防具 5 部位・護石・防具の珠・護石の珠。武器ごとのもの: 武器・武器の珠・巨戟アーティアのシリーズ/グループ (1 部位)。
  - 武器スキルは防具に付かない (`SEARCH_DESIGN.md` 2.1 節の前提) ので、武器の側は武器スキルだけを変える。
  - 護石の武器用スロットの珠を 2 本で共有するかは**未確認** (共通として扱う)。
- 目的: 相手ごとに良い方の武器を使う → `T = Σ_i H_i / max(D_i(武器1), D_i(武器2))`。
- やり方 (ソルバの本体は変えない。5.4 節の `optimizeWeaponSide` を足す):
  1. **1 回目**: 武器 1 本で全員を相手に探す (候補 = 2.3 節の多頭の武器)。上位 K 件。
  2. **2 本目を合わせる**: 上位 5 件の防具の組それぞれで、防具・護石・珠を固定したまま、2 本目の武器と武器の珠を選び直す
     (`optimizeWeaponSide` に「T を小さくする」採点の関数を渡す)。続けて 1 本目も同じように 1 回だけ選び直す。
  3. T で並べ直し、上位 5 件を出す。「武器 1 本で通すと 約 +18 回」も出す (1 回目の 1 位と比べる)。
  4. 「続けて探す」: 2 本目を使う相手だけを重く見た探索をもう 1 回 → 同じように合わせて、良くなれば差し替える。
- いつ出すか (`state.search.twoWeapons`。既定 `auto`): おすすめがはっきり (`clear`) の相手で 1 位の属性が 2 種類以上あるとき。
  3 種類以上なら、時間の割合が大きい 2 つの属性を候補の中心にする (残りの相手も max で良い方を使う)。
- 例 『英雄の証』(★10・歴戦王 4 体): レ・ダウ 氷 (32,850)・ウズ・トゥナ 雷 (46,574)・ヌ・エグドラ 水 (40,242)・アルシュベルド
  どれも効きにくい (71,701)。属性が 3 種類あるので 2 本の案を出す。アルシュベルドはどちらの武器でもよく、良い方で数える。
- 「装備に入れる」は 1 本ずつ (いまの `state.build` は武器 1 本)。「2 本ともマイセットに保存」で
  「英雄の証 1 本目 (雷)」「英雄の証 2 本目 (水)」の 2 つを作る。`state.build` に 2 本目を持たせるのは後で (9 章)。
- 近似の度合い: 1 回目の防具に 2 本目を合わせるだけなので、2 本を前提にした防具の最良は保証しない。小さい問題で総当たり
  (防具の組 × 武器 2 本の全組) と比べて差を測る (6.2 節)。

### 3.4 守りのスキルを合わせる

- subject ごとに 2.4 節で集め、同じスキルは Lv の大きい方にまとめる。理由に「どの相手のためか」を全部残す
  (例「耳栓 Lv3: ジン・ダハドの咆哮【大】」「耳栓 Lv2: レ・ダウ・ウズ・トゥナ・…の咆哮【小】」→ 1 行で Lv3)。
- 属性やられは属性が複数でも 1 行 (「属性やられ耐性 Lv3、または 雷・水・火・龍 の耐性をそれぞれ 20 以上」)。
  2 回目の探索は耐性スキルを全部 Lv3 にするので重い。満たせなければ `infeasible` になり、画面は「属性やられ耐性 Lv3 の方だけで探しました」と出す。
- 武器スキルの必須 (ガード強化など) は、武器を 2 本にするときは 2 本とも満たす。

### 3.5 時間の見込み (未計測)

| 場合 | 探索の回数 | Node の見込み (ビームと仕上げまで) | iPhone の見込み (×2〜3) |
|---|---|---|---|
| 1 体・いまの武器 | 1 (+ 属性やられがオンなら 2) | 0.8 秒 (B1) / 1.6 秒 | 2〜5 秒 |
| 1 体・おすすめ属性の武器 | 1〜2 | 1〜2.4 秒 (B1 と B3 の間) | 3〜7 秒 |
| 多頭・武器 1 本 | 1〜2 | 相手 × 部位の数で評価が重くなる (B5 は 2 部位で B1 と同じ 0.8 秒) | 未計測 |
| 多頭・武器 2 本 | 1〜2 + 合わせ (上位 5 件) | 合わせの目標は 1 件 0.1 秒以内 | 8〜15 秒の見込み |

- 途中の結果 (1 回目の仕上げのあと) を先に出し、残りは裏で続ける。ベンチに S1〜S3 (6.4 節) を足して測ってから予算を決める。

---

## 4. 画面

### 4.1 どこに置くか

| 案 | よい | わるい |
|---|---|---|
| **A. 6 つ目のタブ「探す」(採用)** | 計算中もタブが残り、ほかのタブを見ながら待てる (タブは閉じても隠すだけ)。段階 2 と 3 が同じ場所。結果を何度も見返せる | タブが 1 つ増える (幅 375px で 1 つ 62px。ラベルは 2 文字なので収まる) |
| B. 装備タブの中に下からのシート | タブが増えない | シートを閉じると結果が見えない。条件の入力が長く、シートに向かない。計算中にほかのタブを見られない |
| C. 相手タブの中 | 相手から近い | 段階 2 (相手なしで探す) の置き場が無い。相手タブがさらに長くなる |

- 並び: **装備・火力・相手・探す・護石・設定** (最初の 3 つは今の位置のまま。「相手を決めて探す」の順)。絵は虫眼鏡の線画。
- 相手タブには結果を出さない。「この相手のおすすめ」(何を必須にするかの要約) と「この相手で装備を探す」ボタンだけを置き、押すと
  探すタブへ移って探索を始める。
- 探すタブ以外を見ているときに結果が出たら、タブの絵に小さな点を付ける (shell.js)。

### 4.2 相手タブに足すもの

上から (既存のカードは `*`):

```
* 相手の決め方   [モンスターから選ぶ][肉質を手入力]
* モンスター     アルシュベルド ›          「クエストの名前から選ぶ ›」
  個体 (新)      [通常][歴戦の個体][歴戦王]
  クエスト (新)  孤独から出でし君という自由 ›
                 ★10・狩猟・常設・体力 79,923
  人数 (新)      [1 人][2 人][3 人][4 人]
  体力と強さ (新・下の図)
  この相手のおすすめ (新・下の図)  [この相手で装備を探す]
  このクエストの相手 (新・多頭のときだけ)
  歴戦王で変わること (新・歴戦王のときだけ)
* おすすめの属性 (個体のおすすめを使う)
* 狙う部位 (傷口の列は個体の置き換えを反映。印「未確認」/「未確定」)
* 部位の肉質 / * 傷口 / * 気をつけること (歴戦王の脅威を足す)
```

- **個体**: `individuals` が 1 つ (通常だけ) なら出さない。3 つまでは `Segmented`、4 つ以上 (ネルスキュラなど) は `Select`。
  変えるとクエストを 2.2 節の規則で選び直す。
- **クエスト**: `PickerField`。見出しは「狩猟対象」「乱入の可能性」。行の 2 行目に ★・種類・体力 (分からなければ「体力不明」)・配信の状態。
  印: 終了中 = `warn`「いまは受けられません」、配信中 = `info`、装備固定 = `info`「装備固定」、多頭 = `info`「2 頭」など。
  「クエストの名前から選ぶ」は全 220 件の `Picker` (★ ごとの見出し)。選ぶと `monsterId` = そのクエストの大型の 1 体目・
  個体 = その行の `variant` にする。
- **人数**: `mission.maxPlayers` まで。クエストを選んでいないときは出さない。

体力と強さ (幅 375px の目安):

```
┌ 体力と強さ ───────────────────────────┐
│ 孤独から出でし君という自由 ★10                   │
│ 体力 (1 人)        79,923                        │
│                    76,726〜83,120 (出るたびに少し違う) │
│ 4 人のとき         約 239,769  [未確定]          │
│ 攻撃の強さ         狩猟演習 (★9 歴戦の個体) の    │
│                    約 1.17 倍  [未確定]          │
│ 傷の付きにくさ     ふつうの 1.6 倍  [未確定]       │
│ 討伐まで           約 87 回                      │
│   いまの装備・「ジャストラッシュ1周」・頭で        │
│ ▸ くわしく                                        │
└──────────────────────────────────┘
```

- 討伐までの回数 = 体力 ÷ いまの装備の 1 コンボの期待値 (部位の割合で平均。`power_calc.mixTotal`)。中央値と範囲 (体力の範囲から)。
  上の 87 回は B1 の 1 位 (920.6) で計算した例。
- 「くわしく」の中: 体力の式・出典 (MHWS-in-json の MissionData、Monster Hunter Wiki CC BY-SA 4.0)、
  **入っていないもの** (傷口の付け方・部位破壊・ダウン・状態異常・属性やられ・肉質の変化・回避や移動の時間・捕獲 (捕獲できる体力のデータが無い))。
  回数は「目安」で、狩猟クエストは捕獲ならもっと少なく済む、と書く。
- 攻撃の強さは、同じモンスターで `attackRate` のある別のクエスト (歴戦の個体の一番高い ★) と比べた倍率。比べるものが無ければ
  値だけ (`平常 8.4・怒り 8.4`)。通常の個体 (群なし) は `attackRate` が null なので出さない。
- 多頭: 「このクエストの相手」カードに 1 体 1 行 (名前・個体・体力・討伐まで約 n 回) と合計。行をタップすると、その相手を
  下のカード (属性・部位・肉質) に出す (`questTargetIndex`)。部位の選び方はモンスターごとに覚える (5.6 節の `tabs.target.memo`)。

この相手のおすすめ:

```
┌ この相手のおすすめ ─────────────[仮]┐
│ 属性      水 (いまの武器は火。水の方が通る)       │
│ 守り      環境適応 Lv2 (点火中の炎)     いま なし │
│           火属性やられ (耐性 20 以上)   いま 7   │
│ 参考      耳栓 Lv2 (咆哮【小】)          いま 2 ✓ │
│ 注意      (防げない攻撃があればここ)              │
│ [この相手で装備を探す]                           │
└──────────────────────────────────┘
```

- 「いま」は装備タブの装備で計算 (スキルの Lv と、属性の耐性の合計 `resistTotals`)。
- 歴戦王で変わること: `moveChanges` の日本語 (`text`。null なら英文を「くわしく」に)、防げる脅威と防げない攻撃、「咆哮・風圧・振動は
  通常と同じと見ています」[未確認]、肉質 (同じ / 傷口が変わる [未確認] / 分からない [未確定])、報酬の γ 防具と固定護石。
  出典 (Monster Hunter Wiki・CC BY-SA 4.0) を小さく添える。

### 4.3 探すタブ

上から:

```
┌ 相手 ───────────────────────────────┐
│ ヌ・エグドラ（歴戦王）・黒き揺り篭の吾子 ★10       │
│ 狙う部位: 頭 (弱点)            [相手タブで変える] │
│ [✓] 相手に合わせたおすすめを使う                 │
└──────────────────────────────────┘
┌ 武器 ───────────────────────────────┐
│ [いまの武器][おすすめの属性から][全部から(遅い)]  │
│ おすすめの属性: 水。いまの武器は火です            │
│ (多頭) [✓] 属性の違う相手がいるので武器を 2 本使う │
└──────────────────────────────────┘
┌ 守りのスキル ─────────────────────[仮]┐
│ [火力優先][バランス][安全]                        │
│ ☑ 環境適応 Lv2      点火中の炎 (歴戦王)            │
│ ☑ 火属性やられを防ぐ  属性やられ耐性3 か 火耐性で20 │
│ ☐ 耳栓 Lv2          咆哮【小】   [試す]            │
│ 防げない攻撃: (あれば)                             │
│ [＋ 守りのスキルを足す]                            │
└──────────────────────────────────┘
┌ 自分で決める必須スキル ───────────────────┐
│ 耐震  Lv [−] 3 [＋]                        [×]   │
│ [＋ スキルを足す]                                 │
└──────────────────────────────────┘
┌ 護石・防具・珠 ───────────────────────┐
│ 持っている護石 (この端末の分も)            [on]   │
│ 生産できる護石                             [on]   │
│ 限界突破 [装備タブと同じ][全部する][しない]        │
│ 倒した歴戦王 ›  5 体とも (γ 防具・護石を使う)      │
│ 使わない防具 ›  なし                              │
│ 珠は全部持っている前提で探します                   │
└──────────────────────────────────┘
┌ 条件つきスキルの発動率 ──────────────────[仮]┐
│ 発動率が仮 (50%) の条件が 23 個あります            │
│ [仮の条件は 0% で探す][火力タブの値で探す]         │
└──────────────────────────────────┘
[ この条件で探す ]  (6 秒くらい)
┌ 結果 ──────────── 火力の高い順・[近似] ┐
│ 1  927.7   いまより +12.4%                        │
│    武器はそのまま・頭 胴 腰 護石が変わる            │
│    攻撃5 見切り3 弱点特効5 超会心3 …               │
│    守り ✓環境適応2 ✓火耐性 合計22                  │
│    討伐まで 約 72 回       γ: 歴戦王の素材         │
│ 2  …                                              │
│ 守りのスキルのために火力 −3.2%                     │
│ [続けて探す (+6 秒)]                               │
└──────────────────────────────────┘
```

- 「相手に合わせたおすすめを使う」をオフにすると段階 2 (相手のおすすめ無し。武器・必須・護石は自分で)。相手が決まっていなければ
  相手のカードは「相手を選ぶとおすすめも使えます」と既定の肉質の説明だけ。
- 「スキルを足す」「守りのスキルを足す」は `Picker` (スキル一覧。種類で見出し)。足した行は Lv を −/＋ で (1〜最大 Lv)。
  シリーズ/グループスキルは段の Lv (例 ヌシの魂 Lv1・鎖刃竜の飢餓 Lv2)。ソルバがシリーズ/グループの必須に対応するまで
  (`SEARCH_DESIGN.md` の 2b) は選べない (行に「準備中」)。
- 発動率の扱いは既定を「仮の条件は 0% で探す」にする案 (`SEARCH_DESIGN.md` 4 章の 3。条件つきスキルを積んだ現実的でない構成ばかり
  出るのを防ぐ)。本人に確かめる (9 章)。0% で探したときは、結果に「火力タブの値と違うのは、仮の発動率を 0% にしたため」と出す。
  本人が入れた発動率 (`state.uptimes` にあるもの) はどちらでもそのまま使う。
- 結果の 1 行: 順位・値 (多頭は「全部倒すまで 約 n 回」)・いまの装備との差 (%)・変わる部位・主な火力スキル・守りのチェック
  (`defenseCheck`)・討伐までの回数・γ の印。行全体をタップで詳しく (下)。

結果の詳しく (`BottomSheet`):

```
1 位  927.7 (いまより +12.4%)               [近似]
[装備に入れる]  [マイセットに保存]
武器   破滅のキリエヴェルド (属性激化)    珠: …
頭     ダハディラヘルムγ  限界突破      珠: …
       同じ値になる防具: ほか 2 個 ›
…
護石   痛撃の護石Ⅲ
スキル (いまと比べて)
  ＋ 弱点特効 5  (いま 3)
  − 耳栓 2       (いま 2 → なし)
守り   ✓ 環境適応 Lv2   ✓ 火耐性の合計 22
討伐まで 約 72 回 (いまの装備は 約 81 回)
▸ くわしく (計算し直した値・段階ごとの時間・警告)
```

- 「装備に入れる」= `setBuild(result.build)`。toast「装備に入れました」に「元に戻す」(前の `state.build` に戻す) と「火力タブで見る」。
- 多頭・武器 2 本の結果は、相手ごとの表 (相手・使う武器・1 回の期待値・回数) と、「1 本目を装備に入れる」「2 本目を装備に入れる」
  「2 本ともマイセットに保存」。

### 4.4 操作の流れとタップ数

| やりたいこと | 操作 | タップ |
|---|---|---|
| 歴戦王のおすすめ装備 (モンスター未選択から) | 相手タブ → モンスター欄 → 選ぶ (検索欄に「ぬえ」など) → 個体「歴戦王」→「この相手で装備を探す」(自動で探し始める) | 5 (+文字) |
| 多頭クエストのおすすめ | 相手タブ →「クエストの名前から選ぶ」→ 選ぶ →「このクエストで装備を探す」 | 4 (+文字) |
| 結果を装備に入れる | 結果の行 →「装備に入れる」 | 2 |
| 守りのスキルの火力の差を見る | 「参考」の行の「試す」 | 1 |
| 必須スキルを足して探し直す (段階 2) | 探すタブ →「スキルを足す」→ 選ぶ → Lv ＋ →「この条件で探す」 | 5 |
| 途中でやめる | 「やめる」 | 1 |

### 4.5 計算中・中止・そのほかの状態

| 状態 | 画面 |
|---|---|
| 計算中 | 結果の場所に「探しています」カード: 段階の文 (準備しています → 候補を絞っています → 仕上げています → もっと良い組を探しています)・ 進み具合の帯 (段階ごとの目安の割合 + B&B の続きは予算に対する経過)・経過の秒・いまの最良の値・「やめる」。「この条件で探す」は押せない |
| 途中の結果 (`partial`) | 結果を出し、見出しに「途中の結果」。裏で続ける。終わって上位が変わったら「もっと良い組が見つかりました」と差し替える |
| 終わり (`done` / `stopped`) | 結果 +「近似」+「続けて探す (+6 秒)」 |
| やめた (`cancelled`) | それまでの上位があれば出し、「途中でやめました」 |
| 満たせない (`infeasible`) | 「必須のスキルを全部満たす組み合わせはありません」+ 足りないスキル + 「〇〇を外して探す」ボタン (プリセットで足したものから順に) |
| 条件が変わった | 結果の上に「条件が変わりました。もう一度探してください」(結果は残す)。比べ方は 5.7 節の `inputKey` |
| エラー | `ErrorBox` (「もう一度」)。Worker が作れない端末では画面のスレッドで 16ms ずつ区切って回す (遅いが動く) |

- iPhone で裏に回すと Worker のタイマーが止まる。予算は**実際に計算した時間の合計**で数え (`budget.activeMs`、5.4 節)、
  戻ったら続ける。
- 計算中に装備・相手を変えてもよい (探索は始めた時の条件の写しで続く。終わったら「条件が変わりました」)。
- 結果は端末に保存し、次に開いたときも出す (5.7 節)。

### 4.6 文言

- 「探索」「ソルバ」「ビーム」「B&B」は画面に出さない。「探す」「候補を絞っています」と書く。段階の名前は「くわしく」の中だけ。
- 値の単位は火力タブと同じ「1 コンボの期待値」。多頭は「全部倒すまで 約 n 回」を大きく出し、期待値は小さく。
- 「近似」の説明 (「くわしく」): 「時間内に見つけた上位です。もっと良い組み合わせが残っていることがあります (差は 1〜2% くらい)」。

---

## 5. API と分担

### 5.1 ファイル

```
app/model/hunt.js            体力・討伐までの回数・個体の肉質・クエストの選び方 (純粋関数。速い)
app/model/recommend.js       おすすめの組み立て・多頭の重み・並べ直し・守りのチェック・耐性の合計・createPlanRunner
app/model/search.js ほか     探索 (SEARCH_DESIGN.md。5.4 節の追加をお願いする)
app/search_worker.js         Worker (SEARCH_DESIGN.md 3.5 節に job の種類を足す。5.5 節)
app/ui/tabs/search.js        探すタブ (部品)
app/ui/tabs/search_form.js   探すタブの純粋関数: state → Plan の選び → Job、必須の行の編集、結果の見せ方 (いまとの差・変わる部位)
app/ui/tabs/search_client.js Worker の出し入れ (作る・start・cancel・extend・作り直し・Worker が無いときの代わり)・hook useSearchRun
app/ui/tabs/search_results.js 結果の一覧と詳しくのシート (部品)
app/ui/tabs/target_hunt.js   相手タブの新しいカード (個体・クエスト・人数・体力と強さ・この相手のおすすめ・多頭・歴戦王)
```

- `app/model/` と Worker は相対パスの import だけ (Worker に import map が効かない)。`recommend.js` は `damage.js` / `build.js` /
  `search.js` / `hunt.js` だけを読む。`equip_logic.js` の斬れ味などは `SEARCH_DESIGN.md` 4 章の 1 で `app/model/weapon.js` に移ったものを使う。
- 新しいファイルは `sw.js` の `PRECACHE` に足し、`tools/sw_version.py` で版を作り直す。

### 5.2 app/model/hunt.js

```js
import { individualsOf, individualOf, elementRecommendationOf, hitzoneFor, questsFor, defaultQuestId,
         questSubjects, targetHealth, combosToDefeat, attackView, woundVitalOf } from './model/hunt.js';

individualsOf(monster)                 // → [{kind, label, name, stars, questCount}] (monsters.json の individuals の並び)
individualOf(monster, kind)            // → individuals の 1 件 (kind = null は通常)
elementRecommendationOf(monster, kind) // → 個体のおすすめ (置き換えがあればそちら)
hitzoneFor(monster, part, kind, { useUncertain = false })
  // → {hitzone, wound, woundSource: 'base'|'override'|'override-uncertain'|'none', confidence, note}
  //   sameAsBase false なら woundOverrides、null なら useUncertain のときだけ
questsFor(targetData, monsterId, kind) // → [{quest, role: 'target'|'intruder', stars, available, status, fixedEquipment, multi, health}]
defaultQuestId(targetData, monsterId, kind)   // → 2.2 節の規則で選んだ id か null
questSubjects(quest, targetData)       // → [{index, key, monsterId, name, kind, missionTarget, health}] (mission.targets の行ごと)
targetHealth(missionTarget, { players = 1 })
  // → {known, solo: {mid, min, max}, players, multiplier, total: {mid, min, max}, perPlayer: {mid},
  //    confidence: {solo: 'medium', multi: 'low' | null}}   (mission が無ければ known: false)
combosToDefeat(health, comboValue)     // → {mid, min, max} (切り上げ) か null (値が 0 以下・体力不明)
attackView(quest, subjectIndex, targetData)
  // → {calm, angry, compareTo: {questId, name, calm, angry} | null, ratio: {calm, angry} | null, confidence: 'low'}
woundVitalOf(monster, group)           // → {normal, tear, temperedScar, confidence: 'low'} (legendaryParams[group].woundVital)
```

### 5.3 app/model/recommend.js

```js
import { collectThreats, requirementsFrom, elementPlan, partsTargets, multiWeights, gammaExclusions,
         buildPlan, planToJob, createPlanRunner, rerankMulti, defenseCheck, resistTotals,
         PRESETS } from './model/recommend.js';

const plan = buildPlan({
  target: state.target, tabTarget: state.tabs.target, search: state.search,
  targetData,                 // data.js の target データ (monsters / quests / threats)
  core: { index, skillEffects, motions, combos },   // data.js の core データ
  current: { build: state.build, combo, uptimes, sharpness },
});
// plan = {
//   subjects: [{key, monsterId, kind, name, health, targets: [{weight, label, partKey, target}], element, threats}],
//   element: {mode, weapons: [ref...], perSubject: [{key, view}], twoWeapons: {suggested, groups}},
//   requirements: [{key, label, options: [[{skillId, level}]...] /* 「または」 */, tier: 'on'|'ref', defaultOn, on,
//                   why: [{subjectKey, text}], provisional (仮), unconfirmed (未確認), mitigateLevel, negateLevel}],
//   notes: [{subjectKey, text, oneShot, source}], exclusions: {armor: [id...], charmsFixed: [id...], labels},
//   weights: [{key, weight, reason}] /* 多頭 */, warnings: [{code, message}], license: [...CC BY-SA の出典] }

const job = planToJob(plan, { K: 10, budgetMs: 6000, placeholders: 'zero', userRequired: state.search.required });
// job = {runs: [{label, input /* createSearch の入力 */}], merge: {mode: 'single'|'multi'|'twoWeapons', subjects, weights}, K}

// Worker の中で:
const runner = createPlanRunner(job, data, { createSearch, optimizeWeaponSide });
// createSearch と同じ形: runner.step(ms) / runner.progress() / runner.result() / runner.cancel() / runner.extend({ms})
// progress() に {run: {index, count, label}} が加わる。result().results[] に次が加わる:
//   {score: {kind: 'damage'|'combos', value, better: 'higher'|'lower'}, perSubject: [{key, value, combos, weapon: 1|2}],
//    weapons: [ref, ref?], builds: [build, build?], defense: defenseCheck(...), baseline: {value, combos} | null}
```

| 関数 | 中身 |
|---|---|
| `collectThreats(threats, subjects)` | 2.4 節の表の正規化 (`{key, subjectKey, type, value, skill, oneShot, confidence, uncertain, text, source}`) |
| `requirementsFrom(items, {preset, toggles})` | 段・まとめ・「または」・仮/未確認の印 |
| `elementPlan(subjects, current, index)` | 2.3 節。候補の武器の参照の配列と 2 本の案 |
| `partsTargets(monster, kind, policy, memo, isWound)` | 2.6 節。個体の傷口の置き換えを入れた `targets` |
| `multiWeights(subjects, dRef)` | 3.1 節の重み (理由つき) |
| `gammaExclusions(targetData, hunted)` | 2.7 節 |
| `rerankMulti(results, subjects, {twoWeapons})` | 本当の T で並べ直す (`perGroup` から) |
| `defenseCheck(build, requirements, index, effects)` | 行ごとに `ok` / `mitigated` / `missing` と詳細 (属性やられは耐性の合計も) |
| `resistTotals(build, index, effects)` | 防具の耐性値の和 + 耐性スキル (`rules.resistSkills`)。`{fire, water, thunder, ice, dragon}` |

- `buildPlan` は DOM も state.js も読まない (引数で受ける)。相手タブの「この相手のおすすめ」も同じ `buildPlan` の結果を出す
  (探索はしない)。

### 5.4 探索 (search.js) にお願いする追加

`SEARCH_DESIGN.md` の API (3 章) に、次を足してほしい。どれも段階 3 のつなぎ目。

| 追加 | 形 | なぜ |
|---|---|---|
| `targets[].group` と `results[].perGroup` | `targets` の行に任意の文字列 `group`。結果に `{[group]: その group の行だけの加重平均の値}` | 多頭の並べ直し (計算し直さずに相手ごとの値が要る) |
| `charms.fixedExclude` | 使わない生産護石の id の配列 | 狩猟証γ の護石 (2.7 節) |
| `optimizeWeaponSide(input, fixed, data, {score, N})` | `fixed` = `{armor, charm, limitBreak, decorations (防具・護石の分)}`。`input.weapons` の候補と武器の珠の組から、`score(perGroup)` が最大の N 件 `[{weapon, decorations: {weapon}, perGroup, score}]` | 武器 2 本 (3.3 節)。Worker の中で使うので `score` は関数でよい |
| `budget.activeMs` | 計算した時間だけで数える予算 (裏に回っていた時間を数えない) | iPhone で裏に回したとき |
| `stopAfter: 'partial'` | 途中の結果 (仕上げ 1) で止める | 「火力の差」を測る軽い探索 (2.5 節) |
| `objective: 'damage'` の比較用に `baseline` | 入力に `current` (いまの装備) を渡すと、同じ評価で値を返す (計算できなければ null) | 「いまより +12.4%」をソルバと同じ式で出す |

- `optimizeWeaponSide` の目標: 防具の組 1 つあたり Node で 0.1 秒以内 (候補の武器の支配除去と、武器の珠の組のパレート集合と、
  上界での刈り込み)。届かなければ合わせる防具の組を上位 3 件に減らす。
- `armorExclude` と `required` は `SEARCH_DESIGN.md` のまま使う。「または」の条件・耐性の値の条件はソルバに足さない (2.4 節)。

### 5.5 Worker のメッセージ (SEARCH_DESIGN.md 3.5 節への追加)

| 向き | type | 中身 |
|---|---|---|
| 画面 → Worker | `start` | `{id, job}`。`job.kind = 'search'` (`{input}`。今の案) か `'plan'` (`{runs, merge, K}`。5.3 節の Job) |
| Worker → 画面 | `progress` | 今の項目に `run: {index, count, label}` を足す |
| Worker → 画面 | `partial` / `done` | `result` は 5.3 節の形 (plan のとき) |

- Worker は core データだけを読む (相手のデータは読まない)。肉質・体力・重みは Job に数値で入っている。
- 同時に 1 つだけ。新しい `start` が来たら前の job を捨てる (今の決まりのまま)。

### 5.6 state.js に足すもの (足すだけなので `STATE_SCHEMA` は 1 のまま)

```js
TABS = ['equip', 'power', 'target', 'search', 'charms', 'settings']

target: {
  ...今のまま,
  individual: null,          // monsters.json の individuals[].kind (null = 通常)。'tempered' | 'arch-tempered' | 'frenzied' | 'alpha'
  questId: null,             // 今もある (多頭の印)。クエストを選んでいなければ null
  questTargetIndex: 0,       // 多頭のとき、下のカードに出す相手 (mission.targets の行)
  players: 1,                // 1〜4 (体力の表示だけ)
  useUncertainWound: false,  // 確度の低い傷口の置き換え (歴戦王アルシュベルド) を計算に使う
}

search: {                    // 探すタブの条件 (小さいので state に置く)
  useTarget: true,           // 相手に合わせたおすすめを使う
  preset: 'balance',         // 'power' | 'balance' | 'safe'
  toggles: {},               // {要件の key: true|false} プリセットから変えたものだけ
  levels: {},                // {要件の key: Lv} 軽減の Lv を選んだものだけ
  required: [],              // 自分で足した必須 [{skillId, level}]
  weaponMode: 'auto',        // 'auto' | 'current' | 'element' | 'all'
  twoWeapons: 'auto',        // 'auto' | 'on' | 'off'
  partsPolicy: 'asSelected', // 'asSelected' | 'weak1' | 'main3'
  charms: { owned: true, local: true, fixed: true },
  limitBreak: 'build',       // 'build' (装備タブと同じ) | 'all' | 'none'
  archTemperedHunted: {},    // {monsterId: false} 倒していない歴戦王だけ (無い = 倒した扱い)
  armorExclude: [],          // 使わない防具の id
  placeholders: 'zero',      // 'zero' | 'keep' (仮の発動率)
  budgetSec: 6,
  K: 10,
}
```

- 変更関数: `selectIndividual(kind)` (クエストも選び直す)・`selectQuest(questId, {targetIndex})`・`setPlayers(n)`・
  `setSearch(patch)`・`setSearchToggle(key, on)`・`addRequired(skillId, level)`・`setRequiredLevel(skillId, level)`・
  `removeRequired(skillId)`。`sanitizeState` に `search` と `target` の新しい項目の検査を足す。
- `selectMonster` は `individual` を null に、`questId` を null にする (今は questId を残している。多頭の途中で別のモンスターを選んだら
  クエストから外れる)。
- `resolveTarget` (state.js) と `resolveTargetMix` (target_mix.js) は `target.individual` を見て `hunt.hitzoneFor` で傷口を置き換える
  (引数の形は変えない。装備・火力タブはそのまま歴戦王の傷口で計算される)。ラベルは「ウズ・トゥナ（歴戦王） 頭」。
- `tabs.target.memo` = `{[monsterId]: {partKey, mix}}`。相手タブでモンスターを替えるとき、前のモンスターの部位の選び方を覚える
  (多頭で `asSelected` に使う)。`tabs.search` = 探すタブの小さな画面状態 (開いているカードなど)。

### 5.7 端末に保存するもの (IndexedDB)

| キー | 中身 | 書き出し |
|---|---|---|
| `mhwilds-sns:search-last` | 最後の結果 `{savedAt, appVersion, inputKey, summary, result}` (上位 K 件。数十 KB) | する |
| `mhwilds-sns:search-timing` | 最近 20 回の段階ごとの時間と端末の種類 (iPhone での実測のため。設定タブの「くわしく」にも出す) | しない (この端末だけの記録。`persist-asked` と同じ扱い) |

- `inputKey` = Job の入力 (データの版を含む) の短いハッシュ。いまの状態から作った `inputKey` と違えば「条件が変わりました」。
- 結果の `build` は state の `build` と同じ形なので、保存データが古くても `sanitizeBuild` を通して使う。

### 5.8 データに足すもの (tools で生成)

- `skill_effects.json` の `rules.resistSkills`:
  `{"125": {"element": "fire", "levels": {"1": 6, "2": 12, "3": 20}, "source": "...", "confidence": "high"}, ...}`
  (火・水・雷・氷・龍の耐性スキル 5 つ)。`tools/effects_skills.py` が MHWS-in-json の SkillData から作り、MHDB の説明文
  (「火耐性＋６」など) と照合する (合わなければ生成を止める)。
- 防具の限界突破で耐性の値が変わるかは分からない (armor.json の `resist` は 1 つだけ)。変わらないものとして計算し、「くわしく」に書く。
- 捕獲できる体力は入れない (`docs/sources/monsters.md` の未確定事項のまま)。分かったら `mission.targets[].captureAt` を足し、
  `combosToDefeat` に捕獲までの回数を足す。

---

## 6. テスト計画

`node --test tests/*.test.mjs` に入るものは、探索の分と合わせて 20 秒以内 (`SEARCH_DESIGN.md` 6 章)。

### 6.1 hunt.js (`tests/hunt.test.mjs`)

- 歴戦王の 5 体: `individualsOf` に歴戦王があり、`defaultQuestId` が ★10 の単体クエストになる (アルシュベルド → 『孤独から出でし君という自由』)。
- `targetHealth` が `quests.json` の `healthCalc` と同じ: 歴戦王のクエスト 11 件と『英雄の証』4 体
  (35,550 / 49,500 / 47,250 / 65,120 / 16,275 / 54,675 / 77,517 / 66,977 / 73,593 / 79,923 / 28,944、英雄の証 32,850 / 46,574 / 40,242 / 71,701)。
  4 人の『孤独から』= 79,923 × 3.0 = 239,769。`mission: null` は `known: false`。
- `hitzoneFor`: ウズ・トゥナの歴戦王の頭の傷口が 弾 70・雷 20、通常は 88・25。アルシュベルドの歴戦王は既定で通常の傷口、
  `useUncertain` で置き換え。傷口の無い部位は `wound: null` のまま。
- `combosToDefeat`: 切り上げ・0 や null で null。`attackView`: アルシュベルドの歴戦王 ★10 が 8.4 で、比べる相手が狩猟演習 (7.15)。

### 6.2 recommend.js (`tests/recommend.test.mjs`)

- 脅威 → 要件: 咆哮【小】→ 耳栓 Lv2、【大】→ Lv3、ヌ・エグドラの歴戦王 → 環境適応 Lv2 (バランスでオン)、ジン・ダハドの歴戦王 →
  拘束耐性 Lv3 が 1 行 (理由 2 つ)・ノヴァは `notes` だけ・氷属性やられは「参考」+未確認。プリセット 3 つの表 (2.4 節) をそのまま確かめる。
- 「または」: 属性やられがオンなら Job の `runs` が 2 つ。多頭で属性が 4 つでも 2 つ。オフなら 1 つ。
- 多頭の重み: `multiWeights` が H_i / D_ref_i² に比例。体力不明の相手は平均で置き、警告が出る。
- **並べ直しの正しさ (小さい問題)**: 相手 2〜3 体・防具の類を絞った問題 (乱数の種を固定して 5 問) で、全組を `computeBuild` +
  `comboExpected` で計算した本当の T の上位と、`createPlanRunner` の結果を比べる。上位 1 件の T の差を記録し、0.5% を超えたら失敗。
- **武器 2 本**: 防具を固定した問題で、`optimizeWeaponSide` の 2 本目が、候補の武器 × 武器の珠の全組の総当たりと同じになる。
  防具も含めた全組の総当たりとの差は記録する (近似なので閾値 2%)。
- `defenseCheck` / `resistTotals`: 手で足した耐性の値 (防具 5 部位の `resist` + 耐性スキル) と一致。レダゼルトγ 5 部位で雷 20 →
  スキルなしでも雷属性やられが ✓。
- `gammaExclusions`: 倒していない歴戦王の γ 防具 5 個と固定護石が外れる。ヌシの魂の注意が出る。
- 歴戦王の傷口: ウズ・トゥナの歴戦王を選んだ Plan の `targets` の傷口が置き換え後の値。
- 探索は差し替え可能 (`createPlanRunner` に渡す `createSearch` を作り物にして、段の進み方・中止・途中の結果の順を確かめる。
  本物の探索ができる前から書ける)。

### 6.3 Game8 との照合 (`tests/recommend_game8.test.mjs`)

- `tests/fixtures/game8_at_reco.json` に、人が Game8 の歴戦王ごとの対策ページを見て写したスキル名を置く (URL と写した日を付ける)。
  **テストの中だけで使い、アプリは読まない** (取り込みではない。`tests/review_numbers.test.mjs` と同じ扱い)。
- プリセット「安全」の Plan のスキル名と比べ、「両方にある / Game8 にだけある / こちらだけ」が 2.9 節の表と同じことを確かめる。
  データや規則が変わって違いが増えたら落ちる (気づけるように)。表を直すときは理由を書く。

### 6.4 ベンチ (`tools/bench_search.mjs` に足す)

| ケース | 中身 |
|---|---|
| S1 | ヌ・エグドラの歴戦王・『黒き揺り篭の吾子』・B1 の武器・バランス (環境適応 Lv2 + 火属性やられ → 2 回の探索) |
| S2 | 『英雄の証』・おすすめ属性の武器・武器 2 本 |
| S3 | 『閃電猛りて、その粋やよし！』(ラギアクルスとレ・ダウの歴戦の個体)・武器 1 本 |

- 測るもの: 途中の結果と終わりまでの時間 (3 回の中央値)・上位の値・合わせ (`optimizeWeaponSide`) 1 件の時間・ヒープの増え。
  WebKit (Playwright) でも S1・S2 を測る。目標は 1 体 (S1) で Node 3 秒・多頭 (S2) で Node 6 秒以内。

### 6.5 画面 (`tests/smoke_ui.py` に足す)

- `@tab_check('search')`: 幅 390 (ライト) と 375 (ダーク) で、横のはみ出し・44px 未満のタップ・16px 未満の入力欄が無い。
  相手が無いとき・武器が無いときの案内が出る。スクリーンショット `…-search.png`。
- `@scenario_check search_run_and_apply`: 通しの操作 (`walkthrough_full_build`) の状態から探すタブ → 「この条件で探す」→
  段階の文が出る → 途中の結果 → 終わり → 1 位をタップ →「装備に入れる」→ `state.build` が結果の `build` と同じ →
  `tests/calc_from_state.mjs` で計算した値が結果の値と相対 1e-9 で一致 →「元に戻す」で前の装備に戻る。
  時間で結果が変わらないよう、テストでは init script で `window.__mhwSearchBudget = {work: 3000}` を入れる (画面には出さない)。
- `@scenario_check search_cancel`: 始めてすぐ「やめる」→「途中でやめました」→ もう一度探せる (Worker を使い回せる)。
- Worker が無い端末: init script で `window.Worker` を消して同じ流れ (画面のスレッドで回る)。
- 電波なし: Service Worker を入れたあと通信を切って探せる (Worker と model のファイルが `PRECACHE` にある)。
- `@scenario_check target_arch_tempered`: 相手タブでアルシュベルド → 歴戦王 → クエストが『孤独から出でし君という自由』になる →
  体力に「79,923」と「76,726〜83,120」→ 4 人で「239,769」と「未確定」→ 攻撃の強さに「未確定」→ 歴戦王で変わること (出典の表記つき) →
  ウズ・トゥナの歴戦王で傷口の列に「未確認」→ ヌ・エグドラの歴戦王で「この相手で装備を探す」→ 探すタブに 環境適応 Lv2 の行がオンで出る。
  スクリーンショット `…-target-at.png`。
- `@scenario_check target_multi_quest`: 「クエストの名前から選ぶ」→『英雄の証』→ 4 体の行と合計の回数 → 探すタブに「武器を 2 本使う」。
  装備固定のクエスト (『イベント：解鎖のアルシュベルド』) では「この相手で装備を探す」が出ず、理由が出る。
- 計算中にほかのタブへ移って戻っても続いている。結果が出たらタブの絵に点が付く。

---

## 7. 実装の分け方 (並列) とつなぎ目

| 段 | 担当 | 中身 | 待つもの | つなぎ目 |
|---|---|---|---|---|
| 3-0 | 1 人 (先に。半日) | state.js の新しい項目と変更関数・`sanitizeState`、`TABS` と shell.js の `TAB_DEFS` (中身が空の探すタブ)・絵・`TAB_LABEL`、`PRECACHE` に新しいファイル名、UI_API / MODEL_API / ARCHITECTURE の見出しだけ | — | 5.6 節の形 |
| 3a | model-hunt | `app/model/hunt.js` + `tests/hunt.test.mjs` | — | 5.2 節 |
| 3b | data | `rules.resistSkills` (tools/effects_skills.py) と ARCHITECTURE.md の追記 | — | 5.8 節 |
| 3c | model-recommend | `app/model/recommend.js` (`buildPlan`・`planToJob`・`createPlanRunner`・並べ直し・`defenseCheck`) + テスト + Game8 の照合 | 3a・3b (なくても作り物で書ける) | 5.3 節。探索は引数で受ける |
| 3d | ui-target | `target_hunt.js`・target.js の並べ替え・`target_mix.js` の個体の傷口・相手タブのスモークテスト | 3-0・3a (`buildPlan` は 3c の作り物でも可) | `buildPlan` の返り値 |
| 3e | ui-search | `search.js`・`search_form.js`・`search_results.js`・`search_client.js`・探すタブのスモークテスト | 3-0。探索ができるまでは**作り物の Worker** (決まった結果を段階ごとに返す) | 5.5 節のメッセージ |
| 2a〜2b | solver (`SEARCH_DESIGN.md` 9 章) | 探索の本体 + 5.4 節の追加 + Worker (`job.kind` で `createSearch` / `createPlanRunner` を選ぶ) | — | 5.4・5.5 節 |
| 3f | まとめ | 本物の Worker でつなぐ・ベンチ S1〜S3・WebKit・iPhone で 1 回 (本人) | 全部 | — |

- 3a・3b・3c・3d・3e・2a は並列で書ける。ぶつかりやすいのは state.js (3-0 で先に入れる) と target_mix.js (3d だけが触る) と
  sw.js (`PRECACHE` は 3-0 で先に足し、中身のハッシュは最後に `sw_version.py`)。
- 3c の `createPlanRunner` は 2a の `createSearch` が無くても、テストの作り物で段の進み方を書ける。本物とつなぐのは 3f。
- 2b の残り (シリーズ/グループの必須・`MAX_PATTERNS` の扱い・`armorExclude`) は 3c より前に入っていると良いが、必須ではない
  (無い間は「準備中」・γ は印だけ)。
- 後回し: 耐性の値 ≥ 20 をソルバの条件にする (3c の後、効くと分かれば)、`state.build` に 2 本目の武器を持たせる、
  泣シミュ型の件数 (`SEARCH_DESIGN.md` の 2c)、捕獲までの回数 (データが入ったら)。

---

## 8. 実装の段で直す文書

- `docs/UI_API.md`: タブの一覧・state の形 (5.6 節)・`search_client.js` の使い方・保存キー (5.7 節)・この端末だけの記録に `search-timing`。
- `docs/MODEL_API.md`: hunt.js・recommend.js の節。
- `docs/ARCHITECTURE.md`: `rules.resistSkills`、段階 3 の行、`app/model/` の一覧。
- `docs/SEARCH_DESIGN.md`: 3 章に 5.4・5.5 節の追加、3.6 節 (画面) はこの文書を見るように。

---

## 9. 未確定・本人に確かめること・リスク

### 本人に確かめること

1. タブを 6 つにして「探す」を足してよいか (ほかの案: 装備タブの中のシート)。
2. 仮の発動率の条件 (23 個) を、探索では 0% として扱ってよいか (既定案)。それとも火力タブの値 (50%) のままか。
3. 守りのスキルの既定 (バランス): 歴戦王の脅威と確定した属性やられだけオン、咆哮・風圧・振動・状態異常は「参考」でよいか。
4. 歴戦王 5 体を全部倒している前提 (γ 防具・狩猟証γ の護石を使う) でよいか。
5. 多頭クエストで武器を 2 本持ち替える遊び方をするか (しなければ既定を「1 本」に)。
6. 部位の狙い方の既定 (相手タブで選んだ部位。無ければ弱点 1 か所) でよいか。
7. 体力・回復系を自動で足さない方針でよいか (受けるダメージを計算できないため)。

### データ・計算の未確定 (画面にも出す)

- マルチの体力の倍率 (確度 low)・攻撃の倍率の掛け方 (low)・傷の付きにくさの意味 (low)。
- 歴戦王アルシュベルドの傷口の置き換えがいつ使われるか (low)。ウズ・トゥナの置き換え (medium)。
- 咆哮・風圧・振動・状態異常が歴戦王でも通常と同じか (medium)。ジン・ダハドの氷属性やられ (未確認)。
- 捕獲できる体力 (データ無し。回数は討伐まで)。フリーチャレンジの体力 (MissionData に無い)。
- 護石の武器用スロットの珠を武器 2 本で共有するか。武器を 2 本持てる仕様は確かめていない (ゲームの仕様として扱う)。
- 防具の限界突破で耐性の値が変わるか。
- 片手剣のガードで受けられる攻撃 (Game8 のガード強化の話) は、データに出典が無いので扱わない。

### リスク

- **時間**: 段階 3 は探索を 2〜4 回回すことがある (属性やられの「または」・火力の差・武器 2 本)。iPhone では多頭・2 本で 10 秒を
  超える見込み。途中の結果を先に出し、重いものは「試す」「続けて探す」に回す。S1〜S3 を測ってから予算を決める。
- **多頭の重みは近似** (基準の装備のまわりの 1 次)。並べ直しで出す順は正しいが、探索が見る範囲は重みで決まる。小さい問題で差を測る。
- **武器 2 本は近似** (1 回目の防具に 2 本目を合わせる)。2 本を前提にした防具の最良は保証しない。
- **属性やられの耐性の値**は探索の条件にできない (防具の耐性値だけで届く組は狙って探さない)。
- **プリセットは決めごと** (仮)。Game8 などとの違いは 2.9 節の表で見張る。
- 探索 (`SEARCH_DESIGN.md`) の未確定 (近似・`MAX_PATTERNS`・仮置きの発動率・iPhone の速さ) はそのまま引き継ぐ。
