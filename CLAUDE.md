# mhwilds-sns

モンハンワイルズ (PS5) の片手剣ビルドアプリ。iPhone のブラウザで使う。公開リポ + GitHub Pages (ブランチ配信)。
設計とデータの形は `docs/ARCHITECTURE.md` が正。変えるときはそちらを先に直す。

## 護石を足すとき (「護石取り込んで」「護石追加して」)

1. 写真/スクショを読む。1 枚から 名前・RARE・スロット (防具用/武器用と Lv)・スキル名と Lv を取る。
2. `data/skills.json` でスキル名を `skillId` に解決する。見つからなければ止めて本人に聞く。
3. `app/model/charms.js` の検証 (`data/talisman_rules.json`) に通す。通らなければ誤読を疑い、画像を見直してから本人に確認する。
4. `data/charms.json` に追記 (id は連番)。読み取った内容を一覧で本人に見せる。
5. `PYTHONIOENCODING=utf-8 python tools/sw_version.py` で `sw.js` の版を上げる (上げないとホーム画面のアプリに届かない)。
6. 写真はリポに入れない (`.gitignore` 済み。PSN 名などが写り込む)。

## 護石のシートから取り込むとき (「護石のシートを取り込んで」)

本人の所持護石の一覧は Google スプレッドシート「MHWs｜所持護石一覧（日付）」の 1 枚目「護石一覧」。

2026-10-24 にシートは護石の動画 (IMG_7657.MOV) の全コマで直され、410 行・スロット確認済みになった (RARE 8 のスロット①は武器用。
追加分は No.257 以降・欠番あり)。別に動画を読み直した結果 (`C:\Users\solit\Documents\mhwilds_護石_動画で読み直し_2026-10-25.csv`) と
410 個すべて一致した。2026-10-29 に No.424〜465 (動画 IMG_7674・IMG_7667・IMG_7675) を足し、スロットを動画で確かめて 18 行を直した
(別の AI が Lv1 の印を「2」と読んでいた)。2026-10-31 に No.466〜512 を足した。No.466〜475・487〜512 の 36 個は動画 (IMG_7692〜7694) の全コマで
確かめ、シートと全項目一致。No.476〜486 の 11 個は元の動画 IMG_7687 が手元に無いので「スロット未確認」(`slotsProvisional: true`) で、5 個はシートより
低い形 (No.478・479・482・483・485) にしてある。いまの `data/charms.json` は 496 個 (生産護石と同じ 2 行と二重登録だった No.447 は除く)。
シートの 2 行目には「スロット確認済」が無いので、次の取り込みでも `--slots-confirmed` は付けない (付けると未確認の 11 個が確認済みになる)。
付けなくても、確かめ済みの護石のスロットは前のまま残る。No.476〜486 を動画で確かめたら、下の「シートの護石のスロットを本人が確かめたとき」の手順で直す。

1. Claude の Google Drive コネクタで「護石一覧」を CSV に書き出す。CSV はリポの外 (作業用のフォルダ) に置き、リポに入れない。
2. `node tools/import_charms.mjs <CSV> --slots-confirmed --report <一覧.json>` で `data/charms.json` を書き換える (`--dry-run` で書かずに確かめられる)。
   - `--slots-confirmed` は、シートのスロット①〜③を確かめた Lv として読む (RARE 8 は 1 つ目が武器用)。シートの 2 行目の説明に
     「スロット確認済」が無い (動画の読み取りで Lv があやしい) ときは付けない。
   - id はシートの No. から決まる (No.88 → `s088`)。取り込み直しても同じ護石は同じ id (ブラウザに保存した装備が id を持つため)。
   - 「防具スロット」「武器スロット」の列があればそちらを使う (書き方はスクリプトの頭のコメント)。無ければスロットの数だけを信じて、
     一番低い Lv の形にし、「スロット未確認」にする。
   - 写真で足した護石 (`c0001` など) は残る。No.5 は `c0001` として扱う (スロットは写真の値のまま)。写真で足した護石がシートにも
     載ったときは、スクリプトの `LINKS` に No. と id を足す (足さないと同じ護石が 2 つになる)。
   - 前に確かめたスロット (`slotsProvisional: false`) は、その行の「防具スロット」「武器スロット」の列に値が無ければ前のまま残る。
     `note` も前のまま。
3. 出た一覧 (前から変わった護石・取り込まない行・確かめてほしいこと・消した護石) を本人に見せる。名前が見つからない行は、
   正しい名前を本人に聞く。前から変わった護石は、前と後のどちらが正しいかを本人に聞く。
4. `node --test tests/*.test.mjs` を通し、`PYTHONIOENCODING=utf-8 python tools/sw_version.py` で `sw.js` の版を上げる。

## シートの護石のスロットを本人が確かめたとき (「シート No.88 のスロットは…」)

1. `data/charms.json` のその護石 (`s088`) の `armorSlots`・`weaponSlots` を直し、`slotsProvisional` を `false` にし、`note` に
   「ゲームで確かめた (日付)」と書く。合っていたときも `slotsProvisional` を `false` にする (「スロット未確認」の印が消える)。
2. id は変えない。`LINKS` に足して `c` の id にしない (`s` の id が消えて、ブラウザに保存した装備の護石が読めなくなる)。
3. `node --test tests/*.test.mjs` (検証に通るか) を通し、`PYTHONIOENCODING=utf-8 python tools/sw_version.py` で `sw.js` の版を上げる。
- 次にシートを取り込んでも、その行の「防具スロット」「武器スロット」の列に値が無ければ、直した値のまま残る。列に値があれば列が先
  (前と違えば「前から変わった護石」に出る)。

## ルール

- データは `tools/` のスクリプトで生成する。`data/*.json` を手で直さない (`charms.json`・`my_weapons.json` は例外)。
- `app/`・`data/`・`index.html` などを変えたら、公開する前に `PYTHONIOENCODING=utf-8 python tools/sw_version.py` で `sw.js` の
  `VERSION` を作り直す (ファイルの中身のハッシュ。Service Worker はキャッシュ優先なので、上げないとホーム画面のアプリに変更が届かない)。
  スモークテストは、`VERSION` が中身と合っていないと失敗にする。
- ゲームのアイコン画像は載せない (カプコンの二次創作ガイドライン)。
- ブラウザ保存のキーは `mhwilds-sns:` 接頭辞 (同じ github.io オリジンに earnings-monitor がある)。トークンは保存しない。
- Pages の配信で Actions (pages-build-deployment) が動く。public なので無料だが、`dividend-toolkit/ops/expected_jobs.yml` に載せてある前提で、独自の workflow は足さない。
- テスト: `node --test tests/*.test.mjs` (計算モデル。Node 24 では `tests/` とディレクトリで渡すと落ちる)、`python tests/smoke_ui.py` (iPhone 幅の画面確認)。
