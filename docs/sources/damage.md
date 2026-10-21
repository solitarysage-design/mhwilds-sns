# 火力計算の出典と未確定事項 (担当: damage)

対象: モンスターハンターワイルズ Ver.1.042 (数値の最終調整は Ver.1.040 / TU4)。
ゲームデータのスナップショット: GitHub `dzxrly/MHWS-in-json` タグ `database-20261020-070700-4a99b26`
(ゲーム版 1.42.0.2、MIT)。生ファイルはタグ固定の raw URL から取り、`meta.sourceSha256` に SHA-256 を残している。

再生成: `PYTHONIOENCODING=utf-8 python tools/build_effects.py` (生データは `tools/.cache/damage/`。無ければ取得する。
中身が変わらなければファイルも `generatedAt` も変えない)。

## 出さないもの

- **秒あたり DPS は出さない。** 技の時間 (モーションのフレーム数) が公開データに無いため。
  代表コンボ 1 回の期待値と、その比 (スキルなし比・1 つ外したときの低下・Lv ごとの上昇) だけを出す。
- 1 ヒットごとの端数処理 (ゲーム内の切り捨て) はしない。期待値なので小数のまま足す。

## 生成物と一次資料

| 生成物 | 一次資料 (ゲームデータ) | 補助 |
|---|---|---|
| `data/skill_effects.json` の各スキル | `Common/Equip/SkillData.user.3.json` の `_value[0..3]` (Lv ごと) | Lv の並びと日本語名は `data/skills.json` (MHDB の id、gameId で結合) |
| 連撃・会心撃【属性】・灼熱化などの内部値 | `Player/ActionData/Common/GlobalParam/Part/PlayerSkillParam.user.3.json` | 並びの解釈は MHWS-in-json の加工コード (`src/processed_data/skill_effects`) を参照 |
| 会心倍率・マイナス会心・属性上限・狂竜症克服 | `.../Part/PlayerStatusParam.user.3.json` | |
| 斬れ味補正 | `Enemy/CommonData/Data/EmCommonData.user.3.json` の `_KireajiTable` | |
| `data/motions_sns.json` の MV・属性補正など | `Player/ActionData/Wp01/Collision/Collider/Wp01_{Attack,SubAttack,Shell}.rcol.38.json` の `AttackParamPl` | 技とヒットの対応は DATABASE ja-JP の `WeaponActionValues.xlsx` (MappingInternalName) |
| 子弾の数・白傷ヒットの寿命 | `Player/ActionData/Wp01/Shell/MainParam/*.user.3.json`、`Wp01ShellList.user.3.json` | |

### 計算ルールの値 (`skill_effects.json` の `rules`)

| 値 | 出典 | 確度 |
|---|---|---|
| 会心倍率 1.25 / マイナス会心 0.75 | PlayerStatusParam `_CriticalAttackRate` / `_NegativeAttackRate` | high |
| 斬れ味 物理 赤0.5/橙0.75/黄1.0/緑1.05/青1.20/**白1.32**/紫1.39 | EmCommonData `_KireajiTable[].Damage` | high (白 1.33 説は誤り) |
| 斬れ味 属性 0.25/0.5/0.75/1.0/1.0625/1.15/1.25 | 同 `.Elem` | high |
| 属性の上限 max(元+400, 元×2.3) | PlayerStatusParam `_ElementAttack_AddLimit`=40 (内部値=表示400) / `_ElementAttack_RateLimit`=2.3 | medium (2 つの上限の組み合わせ方は調査値「大きい方」に従った) |
| 攻撃の上限 倍率4.0 / 加算400 | PlayerStatusParam `_PhysicalAttack_RateLimit` / `_PhysicalAttack_AddLimit` | medium (実用上は届かない) |
| 弱点特効の肉質しきい値 45 | PlayerSkillParam `_WeakAttackMeatThreshold` | high |
| 心眼の肉質しきい値 44 | PlayerSkillParam `_Shingan_MeatThreshold` | medium (「以下」と読んだ) |
| 狂竜症克服 会心+15% を 60 秒 | PlayerStatusParam `_Frenzy_Overcome_CriticalRate` / `_Frenzy_Overcome_Duration` | high |

### モーション値の項目 (`motions_sns.json` の `moves[].hits[]`)

| 項目 | RCOL の項目 |
|---|---|
| `mv` | `_Attack` |
| `elementRate` | `_StatusAttrRate`。ただし `_UseStatusAttrPower=false` のヒット (盾) は 0 |
| `sharpnessMul` (斬れ味補正が掛かる) | `!_IsNoUseKireaji || _IsForceUseKireajiAttackRate` |
| `consumesSharpness` (斬れ味を消費する) | `!_IsNoUseKireaji` |
| `canCrit` | `!_IsNoCritical` |
| `hien` (飛燕の対象) | `_IsSkillHien` |
| `additionalDamage` (灼熱化などの対象と推定) | `_UseSkillAdditionalDamage` |
| `type` | `_ActionTypeFixed` (SLASH=斬撃、BLOW=打撃=盾) |

`_IsNoUseKireaji` は「斬れ味を消費しない」の意味と判断した。true のヒットのほぼ全部で
`_IsForceUseKireajiAttackRate` (斬れ味の倍率は掛ける) が立っているため (片手剣 46 件中 42 件)。

## 調査値 (Ver.1.040) との照合

食い違ったらゲームデータを採る。ビルドスクリプトが照合して食い違いを表示する (各スキルの `verification`)。

| 項目 | ゲームデータ | 調査値 | 判定 |
|---|---|---|---|
| 攻撃 Lv1-5 | +3/+5/+7/×1.02+8/×1.04+9 | 同 | 一致 |
| 見切り | 4/8/12/16/20% | 同 | 一致 |
| 超会心 | 1.28〜1.40、基本 1.25、マイナス 0.75 | 同 | 一致 |
| 弱点特効 | 5/10/15/20/30%、傷口 +3/5/10/15/20%、肉質 45 | 同 | 一致 |
| 挑戦者 | 攻撃 4/8/12/16/20、会心 3/5/7/10/15% | 同 | 一致 |
| フルチャージ / 逆恨み / 逆襲 / 渾身 / 力の解放 | 3〜20 / 5〜25 / 10,15,25 / 10〜30% / 10〜50% | 同 | 一致 |
| 攻めの守勢 | ×1.05/1.10/1.15 | 同 | 一致 (掛かる場所は下の未確定事項) |
| 連撃 (片手剣) | 1〜4 ヒット目 +5攻/+50属、強化後 +8/10/12/15/18攻・+60/80/100/120/140属 | 同 | 一致 (並びの解釈は medium) |
| 会心撃【属性】 片手剣 | 1.05/1.10/1.15 (`_AttrPowerRateData[0..2]`) | 1.05/1.10/1.15 (攻略サイトのみ・low) | **ゲームデータで確認できた** |
| 属性攻撃強化 | +40 / ×1.1+50 / ×1.2+60 (表示値) | 同 | 一致 |
| 黒蝕竜の力 Ⅰ | 攻撃なし、克服で会心 +15% を 60 秒 | 同 | 一致 |
| 無我の境地 | 克服時 会心 +3/6/10% | 同 | 一致 |
| 兇爪竜の力 | +8 / +18 | 同 | 一致 |
| 凍峰竜の反逆 | +25 / +50 を 90 秒 | 同 | 一致 |
| ヌシの魂 | 攻撃 ×1.05 | 同 | 一致 |
| 巨戟龍の黙示録 | ×1.2+20 / ×1.3+40 (表示値) | 同 | 一致 |
| 暗器蛸の力 | +15 / +30 (180 秒) | 同 | 一致 |
| 灼熱化 (火竜の力) | 確率 33%、上位 Ⅰ 固定20+火600 / Ⅱ 固定40+火1200 | 確率 1/3、同 | 一致 |
| 灼熱化 CT | `_ScorchingHeatData[0]` = **2.4** (候補) | 2 秒 | **食い違い** (計算には CT を入れていないので影響なし) |
| ジャストラッシュ (ジャスト成功) | 40・40・45 / 60 / 80・25・34×3、属性補正 0/1.5/1.5 / 0 / 1.5/0/1.0 | 属性補正 0/1.5/1.5/0/1.5/1 | MV 一致。3段目の盾ヒット (MV25) は**属性 0** (盾は `_UseStatusAttrPower=false`)。調査値は 25 と 34×3 をまとめて 1 としていた |
| 集中急所突き | 15 (傷なし) / 15・15 (傷口) / 15・15・19×3 (白傷) | 同 | 一致 (×3 は推定、下記) |
| 溜め斬り落とし | 18・28・14×4、3〜6 ヒット目の属性補正 0.3 | 0.3 と 1.25 に割れる | **割れる理由が分かった**: 子弾が 2 種類ある (INDEX_1: MV14・補正0.3 ×4 / INDEX_2: MV28・補正1.25 ×4)。通常を INDEX_1 とした |
| 盾攻撃 | 属性 0 倍 | 同 | 一致 |

## 未確定事項

| 項目 | 現状の扱い | 確度 | メモ |
|---|---|---|---|
| 攻めの守勢の掛かる場所 | 武器攻撃力に掛ける倍率 (攻撃 Lv4/5 の ×1.02 と同じ段) | medium | MHWS-in-json の加工コードが `attack.stat.rate` に置いている |
| 連撃の元データの並び | `[?, 初期攻撃, 初期属性, Lv1攻撃, Lv1属性, …]`。先頭 4 は不明 (強化までのヒット数の候補) | medium | 元データ `_ContinuousAttackWp01Data=[4,5,5,8,6,10,8,12,10,15,12,18,14]` |
| 連撃の発動率 | 「強化後」の割合を発動率にし、非発動側は 1〜4 ヒット目の効果 (`whenInactive`) | medium | 攻撃を当て続けている前提 |
| 弱点特効の傷口分 | 傷口なら肉質に関係なく足す | medium | 肉質 45 未満の傷口で付くかは未確認 |
| 心眼のしきい値 | 物理肉質 44 以下 | medium | `_Shingan_MeatThreshold=44` が「未満」の可能性 |
| 黒蝕竜の力 Ⅱ | 感染中 +10、克服時 +15 (合計) + 会心 15% | medium | 「さらに +15 (合計 +25)」の読みも残る |
| 灼熱化の値 | `_ScorchingHeatData[7..10]` を上位 Ⅰ/Ⅱ の (固定, 火属性内部値) と読んだ | medium | 先頭 2.4 と [1..6]=50,100,20,24,30,60 の意味は不明 (下位の値の可能性)。SkillData `_value[1]`=24/60 も不明 |
| 灼熱化のクールタイム | 計算に入れない | — | 技の秒数が無いので回数を制限できない。多段の技ほど過大評価 |
| 灼熱化の対象ヒット | `_UseSkillAdditionalDamage=true` のヒットだけ | medium | フラグ名からの推定 |
| 灼熱化と属性強化 | 火属性の追加分は属性スキル・会心を掛けない固定値 | low | |
| 白傷ヒットの回数 | 3 回 (`_LifeSec=0.5` / `_MultiHitTimer=10` を 60fps と仮定) | medium | 調査値 ×3 と一致 |
| 溜め斬り落とし INDEX_2 子弾の発生条件 | `finish_slash_strong` として別の技にした。代表コンボでは使わない | low | |
| 技名の対応表に無いヒット | `unusedHits` に残し、代表コンボに入れない | — | A#40 (△連携に付く MV7)、A#700/701/702、多段 A#14/A#18/A#33 など。発生条件・回数が不明 |
| ジャストラッシュ3段目の盾ヒット (SA#160, MV25) | 3段目 (ジャスト成功) に入れた (`mapping: inferred`) | medium | 対応表には無いが、調査値の 25 に当たる |
| 代表コンボの入力の並び | ゲーム内ガイド (ActionGuideData_Wp01Combo) の名前を参考にした代表例 | medium | ガイドの各段の文言は取れていない |
| 属性の上限の組み合わせ | max(元+400, 元×2.3) | medium | ゲームは倍率と加算を別々に切る可能性もある |
| 条件つきスキルの発動率 | 根拠の無いものは 0.5 (`uptimeBasis` に「仮置き」) | low | 画面で人が入れる前提 |
| 条件つきスキル同士の関係 | すべて独立と仮定 (例: 黒蝕竜の克服と無我の境地も独立に扱う) | — | 設計どおり |
| 祈り系 (花舞/踊火/夢灯/祝謡) Ⅱ | `_value[0]=109` を攻撃 ×1.09 と読んだ。発動率 1.0 (期間外は 0 にする) | low | |
| 海竜の渦雷 | 会心 +15% (`_value[1]`) だけ。追加の雷ダメージは未対応 | low | |
| ヌシの憤激 | 攻撃 +10 | medium | 倍率の可能性は低いが未確認 |
| 千刃竜の闘志 Ⅱ | 攻撃 ×1.05 | low | |
| 濡れ刃紋 | 濡れ時の値で計算。泡状態は `altAffinityAdd` | medium | |
| 状態異常属性の武器 (毒・麻痺など) | 属性ダメージ 0 | — | 蓄積値は火力計算の対象外 |

### 計算は未対応 (データとしては持つ。`supported: false`)

鎖刃刺撃 (蓄積しきい値が非公開なので推定しない)、白熾の奔流 (`_ViolentData=[2,45,85]` の意味が未確定)、
抜刀術【力】、研鑽、破壊王、チャージマスター (片手剣の対象ヒットが不明)、煌雷竜の力 (力の解放の時間延長)、
獄焔蛸の反逆、雪獅子の闘志、毛皮の昂揚、属性変換、パワーストーン、炎の料理人、オメガレゾナンス。
`comboExpected` / `skillContribution` の戻り値の `unsupported` に入る (画面では「未対応」と出す)。
