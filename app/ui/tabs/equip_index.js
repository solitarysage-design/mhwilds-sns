// 装備の索引 (computeBuild に渡すもの) を、画面で足した所持武器・護石も含めて作る hook。
// 装備タブで足したアーティア武器 (state.tabs.equip.myWeapons) と、護石タブで足した護石 ("mhwilds-sns:charms-local") は
// data.index に入っていないので、火力タブなどで装備を計算するときもこれを使う:
//   const { idx } = useEquipIndex(data);
//   const result = computeBuild(build, idx);
//   const weapon = resolveWeaponRef(build.weapon, idx);   // equip_logic.js
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useAppState } from '../../state.js';
import { kvGet } from '../../store.js';
import * as L from './equip_logic.js';

const EMPTY = Object.freeze([]);

/** 装備タブで足した所持武器 (state.tabs.equip.myWeapons を整えたもの)。無ければ同じ空の配列 */
export function useLocalWeapons() {
  const saved = useAppState((s) => (s.tabs.equip ? s.tabs.equip.myWeapons : undefined));
  return useMemo(() => {
    const list = L.sanitizeLocalWeapons(saved);
    return list.length ? list : EMPTY;
  }, [saved]);
}

// 護石タブ (charms.js) が持つ「この端末で足した護石」の入れ物を使う (足す・消すとすぐこちらにも出る)。
// charms.js を読めないときは、同じ保存キーを直接読む (active になるたびに読み直す)。
let charmsModule = null;
function loadCharmsModule() {
  if (!charmsModule) {
    charmsModule = import('./charms.js').then((m) => {
      if (typeof m.subscribeLocalCharms !== 'function' || typeof m.getLocalCharms !== 'function') {
        throw new Error('charms.js に subscribeLocalCharms / getLocalCharms がありません');
      }
      return m;
    });
  }
  return charmsModule;
}

/**
 * 護石タブで足した護石の配列。active が true になるたびに保存領域から読み直す
 * (設定タブの「全データの読み込み」のあとなどに合わせるため)。
 */
export function useLocalCharms(active = true) {
  const [list, setList] = useState(EMPTY);
  const viaStore = useRef(false);
  const put = (raw) => {
    const next = L.sanitizeLocalCharms(raw);
    setList((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : (next.length ? next : EMPTY)));
  };
  useEffect(() => {
    let alive = true;
    let off = null;
    loadCharmsModule().then((m) => {
      if (!alive) return;
      viaStore.current = true;
      const pull = () => alive && put(m.getLocalCharms());
      off = m.subscribeLocalCharms(pull);
      pull();
      if (typeof m.loadLocalCharms === 'function') m.loadLocalCharms().then(pull, () => {});
    }).catch((e) => {
      console.warn('護石タブの入れ物を使えないので、保存してある護石を直接読みます', e);
    });
    return () => {
      alive = false;
      if (off) off();
    };
  }, []);
  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    (async () => {
      try {
        const m = await loadCharmsModule().catch(() => null);
        if (m && typeof m.refreshLocalCharms === 'function') {
          await m.refreshLocalCharms(); // 変われば購読で届く
          return;
        }
        const raw = await kvGet(L.LOCAL_CHARMS_KEY);
        if (alive && !viaStore.current) put(raw);
      } catch (e) {
        console.warn('端末の護石を読めませんでした', e); // 読めなくても data/charms.json の分で動く
      }
    })();
    return () => {
      alive = false;
    };
  }, [active]);
  return list;
}

/**
 * 画面で足した所持武器・護石を含めた索引。
 * @param data data.js の core データ (タブの data prop)
 * @param opts.active タブが見えているか (護石を読み直すきっかけ)
 * @returns {{idx, localWeapons, localCharms}} idx は computeBuild / resolveWeaponRef にそのまま渡せる
 */
export function useEquipIndex(data, { active = true } = {}) {
  const localWeapons = useLocalWeapons();
  const localCharms = useLocalCharms(active);
  const idx = useMemo(() => L.buildEquipIndex(data, { localWeapons, localCharms }), [data, localWeapons, localCharms]);
  return { idx, localWeapons, localCharms };
}
