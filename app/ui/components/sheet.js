// 下から出るシートと、検索つきの一覧から 1 つ選ぶ部品 (picker)。
// シートは position: fixed で出す。親の要素に transform を付けないこと (位置がずれる)。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html } from './html.js';

const cx = (...a) => a.filter(Boolean).join(' ');

// ---------------------------------------------------------------- 検索用の正規化

const ROMAN = { 'Ⅰ': '1', 'Ⅱ': '2', 'Ⅲ': '3', 'Ⅳ': '4', 'Ⅴ': '5', 'Ⅵ': '6', 'Ⅶ': '7', 'Ⅷ': '8', 'Ⅸ': '9', 'Ⅹ': '10' };

/**
 * 検索で比べるための文字列にする: 全角/半角をそろえ (NFKC)、小文字に、カタカナをひらがなに、
 * ローマ数字 (Ⅲ) を数字に、空白と記号の一部を消す。
 */
export function normalizeSearch(s) {
  return String(s ?? '')
    .replace(/[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]/g, (c) => ROMAN[c])
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s・【】「」()（）\[\]［］/／]/g, '');
}

/** 検索語 (空白で区切ると全部を含むもの) で items を絞る。items は {label, sub?, keywords?} */
export function filterItems(items, query) {
  const tokens = String(query ?? '').split(/[\s　]+/).map(normalizeSearch).filter(Boolean);
  if (!tokens.length) return items;
  return items.filter((it) => {
    const hay = it.__search ?? normalizeSearch(`${it.label ?? ''} ${it.sub ?? ''} ${it.keywords ?? ''}`);
    return tokens.every((t) => hay.includes(t));
  });
}

// ---------------------------------------------------------------- シート

let openCount = 0;
function lockScroll(on) {
  openCount += on ? 1 : -1;
  try {
    document.documentElement.classList.toggle('is-sheet-open', openCount > 0);
  } catch { /* 何もしない */ }
}

// ---- 戻る操作で閉じる (Safari の左端からのスワイプ・Android の戻る)
// シートを開くたびに履歴に 1 つ積み (state = {mhwSheet: 深さ})、戻る (popstate) で一番上のシートを閉じる。
// ボタンなどで閉じたときは積んだ分を history.back() で戻す。ホーム画面のアプリでは戻る操作が無いので影響しない。
// history.back() は後で (非同期に) 戻るので、戻り終わる (popstate) 前に次のシートを開いたら、積むのは戻り終わってからにする
// (先に積むと、その後の「戻る」が新しいシートの分を消してしまい、履歴とシートの数がずれる)。
let sheetDepth = 0;
let backPending = 0;              // 自分で history.back() して、まだ popstate が来ていない数
let backTimer = null;
const sheetClosers = new Map();   // 深さ → 閉じる関数
const waitingPush = new Map();    // 深さ → 戻り終わってから積む関数
let popInstalled = false;

// 開いたシートのまま再読み込みしたときは、履歴の印 (mhwSheet) だけが残る。開いたばかりのページにシートは無いので消しておく
try {
  if (history.state && history.state.mhwSheet) history.replaceState({ ...history.state, mhwSheet: 0 }, '');
} catch { /* 何もしない */ }

function flushWaitingPush() {
  if (backPending > 0) return;
  for (const [, push] of [...waitingPush.entries()].sort((a, b) => a[0] - b[0])) push();
  waitingPush.clear();
}

function installPop() {
  if (popInstalled) return;
  popInstalled = true;
  window.addEventListener('popstate', (e) => {
    if (backPending > 0) {
      backPending -= 1;
      if (backPending === 0) {
        clearTimeout(backTimer);
        flushWaitingPush();
      }
      return;
    }
    const now = (e.state && e.state.mhwSheet) || 0;
    for (const [depth, close] of [...sheetClosers.entries()].sort((a, b) => b[0] - a[0])) {
      if (depth > now) close();
    }
  });
}

function pushSheet(close) {
  try {
    installPop();
    sheetDepth += 1;
    const depth = sheetDepth;
    sheetClosers.set(depth, close);
    const push = () => history.pushState({ ...(history.state || {}), mhwSheet: depth }, '');
    if (backPending > 0) waitingPush.set(depth, push);
    else push();
    return depth;
  } catch {
    return 0;
  }
}

function popSheet(depth) {
  if (!depth) return;
  sheetClosers.delete(depth);
  sheetDepth = Math.max(0, depth - 1);
  // まだ積んでいない (戻り終わるのを待っていた) なら、積むのをやめるだけ
  if (waitingPush.delete(depth)) return;
  try {
    // 戻る操作で閉じたとき (履歴はもう戻っている) は何もしない。ボタンで閉じたときは積んだ分を戻す
    if (history.state && history.state.mhwSheet === depth) {
      backPending += 1;
      history.back();
      // popstate が来ない (ブラウザの都合) ときの保険: 少し待ったら待ちを解く
      clearTimeout(backTimer);
      backTimer = setTimeout(() => {
        backPending = 0;
        flushWaitingPush();
      }, 1000);
    }
  } catch { /* 何もしない */ }
}

// ---- キーボードで隠れないように (iPhone はキーボードが画面の上に重なり、position: fixed の下端が隠れる)
function watchKeyboard(layer) {
  const vv = window.visualViewport;
  if (!vv || !layer) return () => {};
  const update = () => {
    const kb = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
    layer.style.setProperty('--kb', `${Math.round(kb)}px`);
    layer.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
  };
  update();
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  return () => {
    vv.removeEventListener('resize', update);
    vv.removeEventListener('scroll', update);
  };
}

/** つかみ (上の帯) を下へスワイプして閉じる。panel を指に合わせて動かし、離したときに十分下げていれば閉じる */
function useSwipeDown(panelRef, onClose) {
  const st = useRef(null);
  const move = (dy) => {
    const el = panelRef.current;
    if (el) el.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
  };
  return {
    onTouchStart: (e) => {
      const t = e.touches && e.touches[0];
      if (t) st.current = { y: t.clientY, t: Date.now(), dy: 0 };
    },
    onTouchMove: (e) => {
      const t = e.touches && e.touches[0];
      if (!st.current || !t) return;
      st.current.dy = t.clientY - st.current.y;
      move(st.current.dy);
    },
    onTouchEnd: () => {
      const s = st.current;
      st.current = null;
      if (!s) return;
      const fast = s.dy > 40 && Date.now() - s.t < 250;
      const el = panelRef.current;
      if (s.dy > 90 || fast) {
        if (onClose) onClose();
      } else if (el) {
        el.style.transition = 'transform 0.15s ease-out';
        move(0);
        setTimeout(() => { if (el) el.style.transition = ''; }, 160);
      }
    },
    onTouchCancel: () => {
      st.current = null;
      move(0);
    },
  };
}

/**
 * 下から出るシート。open=false のときは何も描かない。
 * <BottomSheet open=${open} title="武器を選ぶ" onClose=${() => setOpen(false)} footer=${...}>中身</BottomSheet>
 * 背景のタップ・閉じるボタン・Esc キー・つかみ (上の帯) を下へスワイプ・ブラウザの「戻る」で onClose。
 * tall=true で高さを画面の 9 割に固定。キーボードが出ている間は、その上に持ち上げる。
 */
export function BottomSheet({ open, title, onClose, children, footer, tall = false, label }) {
  const panelRef = useRef(null);
  const layerRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const swipe = useSwipeDown(panelRef, () => closeRef.current && closeRef.current());
  // useLayoutEffect: シートが画面に出た時点で履歴に積み終えておく (useEffect は描いた後に回るので、
  // 開いた直後に「戻る」を押すと、まだ積んでいない履歴を戻ってアプリを離れてしまう)
  useLayoutEffect(() => {
    if (!open) return undefined;
    lockScroll(true);
    const onKey = (e) => {
      if (e.key === 'Escape' && closeRef.current) closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    // 読み上げのためにシートへ移す (入力欄には移さない: iPhone でキーボードが勝手に出るため)
    if (panelRef.current) panelRef.current.focus({ preventScroll: true });
    const depth = pushSheet(() => closeRef.current && closeRef.current());
    const offKb = watchKeyboard(layerRef.current);
    return () => {
      lockScroll(false);
      document.removeEventListener('keydown', onKey);
      offKb();
      popSheet(depth);
    };
  }, [open]);
  if (!open) return null;
  return html`
    <div class="sheet-layer" ref=${layerRef}>
      <div class="sheet-backdrop" onClick=${onClose}></div>
      <div class=${cx('sheet', tall && 'sheet-tall')} role="dialog" aria-modal="true" aria-label=${label || title}
        tabindex="-1" ref=${panelRef}>
        <div class="sheet-top" ...${swipe}>
          <div class="sheet-grip" aria-hidden="true"></div>
          <header class="sheet-head">
            <h2 class="sheet-title">${title}</h2>
            <button type="button" class="btn btn-ghost sheet-close" onClick=${onClose}>閉じる</button>
          </header>
        </div>
        <div class="sheet-body">${children}</div>
        ${footer && html`<footer class="sheet-foot">${footer}</footer>`}
      </div>
    </div>`;
}

// ---------------------------------------------------------------- 一覧から選ぶ

/**
 * 検索つきの一覧から 1 つ選ぶシート。
 * items: [{value, label, sub?, group?, keywords?, badge?, disabled?}]
 *   value  … 選んだときに onSelect に渡る値 (id など。数でも文字でもよい)
 *   label  … 表示名 (検索の対象)
 *   sub    … 2 行目の小さい文字 (検索の対象)
 *   group  … 見出し (同じ group が続くとまとめて見出しを 1 つ出す。並び順は items のまま)
 *   keywords … 表示しないが検索に使う文字 (読みがな・英名など)
 *   badge  … 右端に出すもの (Badge 部品など)
 * onSelect(value, item) … 選んだら呼ばれる (allowNone で「なし」を選ぶと onSelect(null, null))。シートは閉じる。
 * maxItems 件より多いときは「さらに表示」で足す (iPhone で重くならないように)。
 */
export function Picker({
  open, title, items, value, onSelect, onClose, allowNone = false, noneLabel = 'なし (外す)',
  searchPlaceholder = '名前で探す', emptyText = '見つかりません', maxItems = 150, footer,
}) {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(maxItems);
  const listRef = useRef(null);
  const prepared = useMemo(() => (items || []).map((it) => ({
    ...it, __search: normalizeSearch(`${it.label ?? ''} ${it.sub ?? ''} ${it.keywords ?? ''}`),
  })), [items]);
  const filtered = useMemo(() => filterItems(prepared, query), [prepared, query]);

  // 閉じたら検索を空に戻す (開いた直後に空にすると、開いてすぐ打った文字が消えるため閉じるときにする)。
  // 開いたら選んでいるものを見える位置へ
  useEffect(() => {
    if (!open) {
      setQuery('');
      setLimit(maxItems);
      return;
    }
    const idx = prepared.findIndex((it) => Object.is(it.value, value));
    if (idx >= maxItems) setLimit((l) => Math.max(l, idx + 20));
    requestAnimationFrame(() => {
      const el = listRef.current && listRef.current.querySelector('.is-selected');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
    });
  }, [open]);

  const choose = (it) => {
    if (it && it.disabled) return;
    if (onSelect) onSelect(it ? it.value : null, it ? stripInternal(it) : null);
    if (onClose) onClose();
  };

  const shown = filtered.slice(0, limit);
  let lastGroup;
  return html`
    <${BottomSheet} open=${open} title=${title} onClose=${onClose} tall footer=${footer}>
      <div class="picker-search">
        <input class="input" type="search" placeholder=${searchPlaceholder} value=${query}
          enterkeyhint="search" autocomplete="off" aria-label=${searchPlaceholder}
          onInput=${(e) => { setQuery(e.currentTarget.value); setLimit(maxItems); }} />
        <span class="picker-count">${filtered.length} 件</span>
      </div>
      <ul class="picker-list" ref=${listRef} role="listbox" aria-label=${title}>
        ${allowNone && !query && html`
          <li role="none">
            <button type="button" role="option" aria-selected=${value == null ? 'true' : 'false'}
              class=${cx('picker-item', 'picker-none', value == null && 'is-selected')} onClick=${() => choose(null)}>
              <span class="picker-label">${noneLabel}</span>
            </button>
          </li>`}
        ${shown.map((it) => {
          const head = it.group != null && it.group !== lastGroup ? it.group : null;
          lastGroup = it.group;
          const selected = Object.is(it.value, value);
          return html`
            ${head != null && html`<li class="picker-group" role="presentation">${head}</li>`}
            <li role="none" key=${String(it.value)}>
              <button type="button" role="option" aria-selected=${selected ? 'true' : 'false'}
                class=${cx('picker-item', selected && 'is-selected', it.disabled && 'is-disabled')}
                disabled=${it.disabled} onClick=${() => choose(it)}>
                <span class="picker-text">
                  <span class="picker-label">${it.label}</span>
                  ${it.sub && html`<span class="picker-sub">${it.sub}</span>`}
                </span>
                ${it.badge && html`<span class="picker-badge">${it.badge}</span>`}
                ${selected && html`<span class="picker-check" aria-hidden="true">✓</span>`}
              </button>
            </li>`;
        })}
      </ul>
      ${filtered.length === 0 && html`<p class="empty">${emptyText}</p>`}
      ${filtered.length > shown.length && html`
        <div class="picker-more">
          <button type="button" class="btn btn-secondary btn-block" onClick=${() => setLimit(limit + maxItems)}>
            さらに表示 (残り ${filtered.length - shown.length} 件)
          </button>
        </div>`}
    </${BottomSheet}>`;
}

function stripInternal(it) {
  const { __search, ...rest } = it;
  return rest;
}

/**
 * 「ラベル + 今の値」の行。タップすると Picker が開く。いちばんよく使う形。
 * <PickerField label="武器" title="武器を選ぶ" items=${items} value=${weaponId}
 *   onChange=${(v) => setWeapon(v)} allowNone placeholder="選んでいません" />
 * 値の表示は items の label (見つからなければ placeholder)。display で上書きできる。
 */
export function PickerField({
  label, title, items, value, onChange, placeholder = '選んでいません', display, sub, end,
  disabled = false, ...pickerProps
}) {
  const [open, setOpen] = useState(false);
  const current = useMemo(() => (items || []).find((it) => Object.is(it.value, value)), [items, value]);
  const text = display ?? (current ? current.label : null);
  return html`
    <div class="picker-field">
      <button type="button" class="row row-button" disabled=${disabled} onClick=${() => setOpen(true)}>
        <span class="row-main">
          ${label != null && html`<span class="row-label">${label}</span>`}
          <span class=${cx('row-value', text == null && 'is-placeholder')}>${text ?? placeholder}</span>
          ${(sub ?? current?.sub) && html`<span class="row-sub">${sub ?? current.sub}</span>`}
        </span>
        ${end != null && html`<span class="row-end">${end}</span>`}
        <span class="row-chevron" aria-hidden="true">›</span>
      </button>
      <${Picker} open=${open} title=${title || label} items=${items} value=${value}
        onSelect=${(v, it) => onChange && onChange(v, it)} onClose=${() => setOpen(false)} ...${pickerProps} />
    </div>`;
}
