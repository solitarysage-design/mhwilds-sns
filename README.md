# mhwilds-sns

『モンスターハンターワイルズ』(PS5) の片手剣ビルドを iPhone のブラウザで組むための、個人用の非公式アプリ。

- 開く: https://solitarysage-design.github.io/mhwilds-sns/ (ホーム画面に追加して使う)
- できること: 装備を選ぶと付くスキルを出す / 代表コンボ 1 回の期待ダメージとスキルごとの効き目 / 相手 (モンスター・部位) の肉質 / 所持護石の一覧と取り込み
- 設計とデータの形: `docs/ARCHITECTURE.md`。作業の決まりごと: `CLAUDE.md`

## 出典とライセンス

- 装備データ: [MHDB](https://wilds.mhdb.io) ([LartTyler/mhdb-wilds-data](https://github.com/LartTyler/mhdb-wilds-data)・MIT)
- 火力の係数・モーション値・鑑定護石の抽選表: [dzxrly/MHWS-in-json](https://github.com/dzxrly/MHWS-in-json) (MIT)
- モンスターの咆哮・風圧・振動、クエストの構成: [Monster Hunter Wiki](https://monsterhunterwiki.org) の寄稿者 ([CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/deed.ja))。ここから作った `data/monster_threats.json`・`data/quests.json` も CC BY-SA 4.0
- 同梱ライブラリ: Preact 10.24.3 (MIT)・htm 3.1.1 (Apache-2.0)。`app/vendor/` に LICENSE あり

『モンスターハンターワイルズ』のゲームの名前・数値・文章などの著作権は株式会社カプコンにあります (© CAPCOM)。
このアプリは個人が作った非公式のもので、株式会社カプコンとは関係ありません。ゲームの画像やアイコンは使っていません。
