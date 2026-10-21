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

## ルール

- データは `tools/` のスクリプトで生成する。`data/*.json` を手で直さない (`charms.json`・`my_weapons.json` は例外)。
- `app/`・`data/`・`index.html` などを変えたら、公開する前に `PYTHONIOENCODING=utf-8 python tools/sw_version.py` で `sw.js` の
  `VERSION` を作り直す (ファイルの中身のハッシュ。Service Worker はキャッシュ優先なので、上げないとホーム画面のアプリに変更が届かない)。
  スモークテストは、`VERSION` が中身と合っていないと失敗にする。
- ゲームのアイコン画像は載せない (カプコンの二次創作ガイドライン)。
- ブラウザ保存のキーは `mhwilds-sns:` 接頭辞 (同じ github.io オリジンに earnings-monitor がある)。トークンは保存しない。
- Pages の配信で Actions (pages-build-deployment) が動く。public なので無料だが、`dividend-toolkit/ops/expected_jobs.yml` に載せてある前提で、独自の workflow は足さない。
- テスト: `node --test tests/*.test.mjs` (計算モデル。Node 24 では `tests/` とディレクトリで渡すと落ちる)、`python tests/smoke_ui.py` (iPhone 幅の画面確認)。
