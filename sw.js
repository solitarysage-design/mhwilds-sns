// Service Worker: オフラインで開けるようにし、新しい版が来たら画面に知らせる。
//
// ★ app/・data/・index.html などを変えたら、公開する前に必ず
//     PYTHONIOENCODING=utf-8 python tools/sw_version.py
//   を実行して VERSION を上げること (PRECACHE のファイルの中身から版を作り直す)。
//   上げないと、ホーム画面のアプリは古いキャッシュのまま更新されない。
//   tests/smoke_ui.py は、VERSION がファイルの中身と合っていないと失敗にする。
// ★ ファイルを足したら PRECACHE にも足すこと (tests/smoke_ui.py が抜けを見つける)。
//
// しくみ:
// - install: PRECACHE を全部取ってきて版つきのキャッシュ (mhwilds-sns:app-<VERSION>) に入れる。
//   1 つでも取れなければ install を失敗させる (古い版がそのまま動き、次に開いたときブラウザが取り直す)。
//   前の版が動いている間は待機し、画面に「新しい版があります → 再読み込み」の帯が出る。
// - 帯のボタンで SKIP_WAITING が届くと切り替わり、古い版のキャッシュを消す。
// - fetch: このアプリの範囲 (/mhwilds-sns/ の下) だけを受け持つ。キャッシュにあればそれを返し、
//   無ければ通信して、取れたらキャッシュに足す。同じ github.io の別サイトには触らない。
//   画面を開く要求 (navigate) は、アプリの入口 (/mhwilds-sns/ と index.html) だけキャッシュの index.html を返す
//   (ライセンスの文書や CC BY-SA のデータを開いたときは、そのファイルを返す)。

const VERSION = '2026-10-24-626a8e3650';
const CACHE_PREFIX = 'mhwilds-sns:app-';
const CACHE = `${CACHE_PREFIX}${VERSION}`;

// スコープ (このファイルの場所) からの相対パス
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  // 画面
  './app/main.js',
  './app/state.js',
  './app/data.js',
  './app/store.js',
  './app/ui/shell.js',
  './app/ui/styles.css',
  './app/ui/styles_search.css',
  './app/ui/styles_target.css',
  './app/ui/components/index.js',
  './app/ui/components/html.js',
  './app/ui/components/card.js',
  './app/ui/components/notice.js',
  './app/ui/components/inputs.js',
  './app/ui/components/sheet.js',
  './app/ui/components/labels.js',
  './app/ui/components/toast.js',
  './app/ui/components/error-boundary.js',
  './app/ui/components/app-update.js',
  './app/ui/tabs/equip.js',
  './app/ui/tabs/equip_logic.js',
  './app/ui/tabs/equip_index.js',
  './app/ui/tabs/power.js',
  './app/ui/tabs/power_calc.js',
  './app/ui/tabs/target.js',
  './app/ui/tabs/target_mix.js',
  './app/ui/tabs/target_hunt.js',
  './app/ui/tabs/search.js',
  './app/ui/tabs/search_form.js',
  './app/ui/tabs/search_results.js',
  './app/ui/tabs/search_client.js',
  './app/ui/tabs/charms.js',
  './app/ui/tabs/settings.js',
  // 計算
  './app/model/build.js',
  './app/model/charms.js',
  './app/model/damage.js',
  './app/model/weapon.js',
  './app/model/hunt.js',
  './app/model/recommend.js',
  './app/model/search.js',
  './app/model/search/evaluator.js',
  './app/model/search/problem.js',
  './app/model/search/solver.js',
  './app/model/search/realize.js',
  // 探索の Worker (電波が無くても探せるように)
  './app/search_worker.js',
  // ライブラリ
  './app/vendor/preact.module.js',
  './app/vendor/hooks.module.js',
  './app/vendor/htm.module.js',
  './app/vendor/LICENSE-preact.txt',
  './app/vendor/LICENSE-htm.txt',
  // アイコン
  './app/icons/apple-touch-icon.png',
  './app/icons/icon-192.png',
  './app/icons/icon-512.png',
  './app/icons/icon-maskable-512.png',
  // データ
  './data/armor.json',
  './data/bonuses.json',
  './data/charms.json',
  './data/charms_fixed.json',
  './data/combos_sns.json',
  './data/decorations.json',
  './data/monster_threats.json',
  './data/monsters.json',
  './data/motions_sns.json',
  './data/my_weapons.json',
  './data/quests.json',
  './data/skill_effects.json',
  './data/skills.json',
  './data/talisman_rules.json',
  './data/weapons_sns.json',
];

const scopeUrl = () => new URL(self.registration.scope);
const abs = (path) => new URL(path, self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      // 全部取れたときだけ新しい版にする。1 つでも取れなければ install を失敗させる
      // (取りこぼしたまま切り替えると、古い版のキャッシュを消した後に電波の無い所で開けないタブが出るため)
      await Promise.all(PRECACHE.map(async (path) => {
        const url = abs(path);
        // HTTP キャッシュを通さず必ず新しいものを取る (GitHub Pages は 10 分キャッシュさせるため)
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
        await cache.put(url, await cleanResponse(res));
      }));
    } catch (e) {
      console.warn('sw: 新しい版のファイルを取れなかったので、今の版のまま動かします', String(e));
      await caches.delete(CACHE);
      throw e;
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // このアプリの古い版のキャッシュだけを消す (同じオリジンの別サイトのキャッシュには触らない)
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (data.type === 'GET_VERSION') {
    const port = event.ports && event.ports[0];
    if (port) port.postMessage({ version: VERSION, cache: CACHE });
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const scope = scopeUrl();
  // このアプリの範囲の外 (別のサイト・別のオリジン) は受け持たない
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  if (url.pathname === `${scope.pathname}sw.js`) return;
  event.respondWith(handle(req));
});

/** アプリの入口 (/mhwilds-sns/ と /mhwilds-sns/index.html) を開く要求か */
function isAppEntry(req) {
  if (req.mode !== 'navigate') return false;
  const p = new URL(req.url).pathname;
  const scope = scopeUrl().pathname;
  return p === scope || p === `${scope}index.html`;
}

async function handle(req) {
  const cache = await caches.open(CACHE);
  if (isAppEntry(req)) {
    // アプリを開く: キャッシュの index.html を返す (電波が無くても開ける)
    const page = (await cache.match(abs('./index.html'))) || (await cache.match(abs('./')));
    if (page) return page;
    return fetch(req);
  }
  // そのほか (画面を開く要求でも、ライセンスの文書やデータのファイルなら) はそのファイルを返す
  const hit = await cache.match(req, { ignoreVary: true, ignoreSearch: req.mode === 'navigate' });
  if (hit) return hit;
  try {
    // キャッシュに無いものを取るときも、古い HTTP キャッシュ (Pages は 10 分) を使わず確かめる
    const res = req.mode === 'navigate'
      ? await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
      : await fetch(new Request(req, { cache: 'no-cache' }));
    if (res.ok && res.type === 'basic') {
      await cache.put(req.url, await cleanResponse(res.clone()));
    }
    return res;
  } catch (e) {
    // 通信できず、キャッシュにも無い
    const loose = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
    if (loose) return loose;
    return new Response('オフラインのため読み込めません', {
      status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

// リダイレクトを経た応答は Safari が画面に使えないことがあるので、中身だけの応答に作り直す
async function cleanResponse(res) {
  if (!res.redirected) return res;
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
