# app/vendor (同梱ライブラリ)

実行時に CDN を読まないため、ここに置いたものだけを使う。`index.html` の import map で
`"preact"` / `"preact/hooks"` / `"htm"` をこのフォルダの相対パスに向けている。

| ファイル | パッケージ | 元のファイル | ライセンス |
|---|---|---|---|
| `preact.module.js` | preact 10.24.3 (2024-10-14 公開) | `dist/preact.module.js` | MIT (`LICENSE-preact.txt`) |
| `hooks.module.js` | preact 10.24.3 の `preact/hooks` | `hooks/dist/hooks.module.js` (中で `"preact"` を import する) | MIT (`LICENSE-preact.txt`) |
| `htm.module.js` | htm 3.1.1 (2022-04-26 公開) | `dist/htm.module.js` | Apache-2.0 (`LICENSE-htm.txt`) |

- 取得: 2026-10-21 に `npm pack preact@10.24.3 htm@3.1.1` (npm レジストリ)。
  - preact-10.24.3.tgz integrity `sha512-Z2dPnBnMUfyQfSQ+GBdsGa16hz35YmLmtTLhM169uW944hYL6xzTYkJjC07j+Wosz733pMWx0fgON3JNw1jJQA==`
  - htm-3.1.1.tgz integrity `sha512-983Vyg8NwUE7JkZ6NmOqpCZ+sh1bKv2iYTlUkzlWmA5JD2acKoxd4KVxbMmxX/85mtfdnDmTFoNKcg5DGAvxNQ==`
- 変えたところ: preact の 2 ファイルの末尾の `//# sourceMappingURL=...` の行だけを消した (.map は同梱しないため)。中身はそのまま。
- 版を上げるときは同じ手順で取り直し、この表と `sw.js` の `VERSION` を更新する。
