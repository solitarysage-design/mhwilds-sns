// 相手タブ: モンスター (34 体) と狙う部位を選ぶ / 肉質を手入力する。
// - 部位の一覧: 切断肉質・属性の肉質・傷口の肉質・弱点 (剣は切断・盾は打撃の肉質が 45 以上) の印。部位不明は既定で隠す。
// - いくつかの部位を割合で混ぜられる (火力の期待値は割合で平均)。指定は state の tabs.target に置く (target_mix.js)。
// - おすすめの属性 (monsters.json の elementRecommendation) と、咆哮・風圧・振動・属性やられ・状態異常を防ぐスキル
//   (monster_threats.json の rules。出典 Monster Hunter Wiki / CC BY-SA 4.0)。
// - 段階 3 (docs/RECOMMEND_DESIGN.md 4.2 節): 個体 (通常・歴戦の個体・歴戦王など)・クエスト・人数・体力と強さ・
//   この相手のおすすめ・このクエストの相手 (多頭)・歴戦王で変わること は target_hunt.js のカード。
//   個体の傷口の置き換え (歴戦王ウズ・トゥナなど) は部位の一覧・肉質・おすすめの属性にも反映する (hunt.js の hitzoneFor)。
// 選んだ相手は state.target に入り、装備タブ・火力タブの計算に使われる。
import { useMemo } from 'preact/hooks';
import {
  html, Card, Hint, Badge, Notice, Loading, ErrorBox, Segmented, Toggle, Slider, NumberInput, TextInput, PickerField,
  ELEMENT_LABEL, formatNumber,
} from '../components/index.js';
import {
  useAppState, setTargetMode, selectPart, setWound, setManualHitzone, setTarget, setTabState, setUseUncertainWound,
} from '../../state.js';
import { useTargetData } from '../../data.js';
import { computeBuild } from '../../model/build.js';
import { useEquipIndex } from './equip_index.js';
import { resolveWeaponRef } from './equip_logic.js';
import { hitzoneFor, elementRecommendationOf } from '../../model/hunt.js';
import {
  visibleParts, findMonster, findPart, isUnknownPart, readMix, mixShares, mainPartKey,
  threatInfo, partLabel, weakInfo, recommendationView, setShare, addShare, removeShare, individualKindOf, individualName,
  MIX_MIN_SHARE,
  ELEMENT_KEYS, HITZONE_INPUT_KEYS, WEAK_POINT_MIN,
} from './target_mix.js';
import { HuntCards, QuestNameEntry, MarkBadge, WoundMarkLine, pickMonster } from './target_hunt.js';

const EMPTY = Object.freeze({});
const cx = (...a) => a.filter(Boolean).join(' ');

// ---------------------------------------------------------------- 見た目 (このタブだけの class。色は styles.css の変数)

const STYLE_ID = 'mhwilds-sns-target-style';
const CSS = `
.tg-reco { display: flex; align-items: center; gap: 6px 10px; flex-wrap: wrap; font-size: 20px; font-weight: 700; }
.tg-order { display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: 13px; color: var(--text-sub); margin-top: 6px;
  font-variant-numeric: tabular-nums; }
.tg-parts { margin: 12px -16px 0; border-top: 1px solid var(--border); }
.tg-part { display: grid; grid-template-columns: minmax(0, 1fr) 46px 46px 46px; align-items: center; gap: 4px;
  width: 100%; min-height: var(--tap); padding: 8px 12px 8px 16px; border: 0; border-bottom: 1px solid var(--border);
  background: transparent; text-align: left; font-size: 16px; color: inherit; }
.tg-part-head { min-height: 0; padding-top: 6px; padding-bottom: 6px; font-size: 12px; font-weight: 700; color: var(--text-sub); }
button.tg-part:active { background: var(--surface-2); }
.tg-part.is-selected { background: var(--accent-soft); box-shadow: inset 4px 0 0 var(--accent); }
.tg-part-name { min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; }
.tg-num { text-align: right; font-variant-numeric: tabular-nums; }
.tg-num.is-weak { font-weight: 700; color: var(--ok); }
.tg-reco-sub { font-size: 14px; font-weight: 400; color: var(--text-sub); }
.tg-num.is-none { color: var(--text-sub); }
.tg-share { font-size: 13px; color: var(--accent); font-weight: 700; }
.tg-mix-slider { padding: 0 16px 8px; border-bottom: 1px solid var(--border); background: var(--accent-soft); }
.tg-detail { overflow-x: auto; margin-top: 4px; }
.tg-hz { border-collapse: collapse; width: 100%; font-size: 14px; font-variant-numeric: tabular-nums; }
.tg-hz th, .tg-hz td { padding: 6px 2px; text-align: center; border-bottom: 1px solid var(--border); white-space: nowrap; }
.tg-hz th { font-size: 12px; color: var(--text-sub); font-weight: 700; }
.tg-hz th[scope=row] { text-align: left; }
.tg-hz td.is-weak { font-weight: 700; color: var(--ok); }
.tg-badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.tg-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; margin-top: 12px; }
.tg-grid > .field { margin-top: 0; }
.tg-threats { list-style: none; margin: 0; padding: 0; }
.tg-threats li { padding: 8px 0; border-bottom: 1px solid var(--border); }
.tg-threats li:last-child { border-bottom: 0; }
.tg-th-head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.tg-th-label { font-weight: 700; min-width: 0; }
.tg-th-value { flex: none; }
.tg-th-need { font-size: 14px; margin-top: 2px; display: flex; flex-wrap: wrap; gap: 2px 8px; align-items: center; }
.tg-th-text { display: block; font-size: 13px; color: var(--text-sub); margin-top: 2px; }
`;

function ensureStyle() {
  try {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
  } catch { /* DOM の無い所では何もしない */ }
}
ensureStyle();

const elemName = (t) => ELEMENT_LABEL[t] || t;

// ---------------------------------------------------------------- モンスターを選ぶ

function bestText(monster) {
  const v = recommendationView(monster.elementRecommendation, null);
  if (v.kind === 'none') return 'なし';
  if (v.kind === 'weak') return 'どれもほとんど効かない';
  if (v.kind === 'close') return `どれもほぼ同じ (少しだけ ${v.best.map(elemName).join('・')})`;
  return v.best.map(elemName).join('・');
}

function MonsterPicker({ td, target, ui }) {
  const items = useMemo(() => {
    const en = new Map(td.lists.threats.map((x) => [x.monsterId, x.nameEn || '']));
    return td.lists.monsters.map((m) => ({
      value: m.id, label: m.name, sub: `おすすめの属性: ${bestText(m)}`, keywords: en.get(m.id) || '',
    }));
  }, [td]);
  return html`
    <${Card} title="モンスター">
      <${PickerField} title="モンスターを選ぶ" items=${items} value=${target.monsterId}
        onChange=${(v) => pickMonster(td, ui, target, v)} allowNone noneLabel="選ばない" placeholder="選んでいません"
        searchPlaceholder="名前で探す (ひらがなでも)" />
      <${QuestNameEntry} td=${td} target=${target} ui=${ui} />
    </${Card}>`;
}

function tieText(tb) {
  if (!tb) return null;
  const tied = (tb.tied || []).map(elemName).join('・');
  if (tb.by === 'woundAvg') return `${tied} が同じ値だったので、主な部位の傷口の肉質の平均で決めました。`;
  if (tb.by === 'allPartsAvg') return `${tied} が同じ値で、傷口でも同じだったので、全部位の平均で決めました。`;
  return `${tied} が同じ値です。`;
}

/**
 * 個体の傷口で計算し直したおすすめを使っているときの印 (確かめていない置き換え = 未確認、
 * いつ置き換わるか分からない置き換え = 未確定)。通常のおすすめのままなら null
 */
function individualRecoMark(monster, target) {
  const kind = individualKindOf(target);
  if (kind == null) return null;
  const rec = elementRecommendationOf(monster, kind, { useUncertain: target.useUncertainWound === true });
  if (!rec || rec === monster.elementRecommendation) return null;
  const ind = (monster.individuals || []).find((i) => (i.kind ?? null) === kind);
  return ind && ind.hitzone && ind.hitzone.sameAsBase === false ? 'unverified' : 'uncertain';
}

function RecommendCard({ monster, target, weaponElem }) {
  const kind = individualKindOf(target);
  const rec = elementRecommendationOf(monster, kind, { useUncertain: target.useUncertainWound === true }) || {};
  const recMark = individualRecoMark(monster, target);
  const order = rec.order || [];
  const v = recommendationView(rec, weaponElem);
  const bestName = v.best.map(elemName).join('・');
  let main;
  if (v.kind === 'none') main = 'どの属性もほとんど効きません';
  else if (v.kind === 'weak') main = html`どの属性もほとんど効きません <span class="tg-reco-sub">(いちばん高い ${bestName} でも ${formatNumber(v.top, 1)})</span>`;
  else if (v.kind === 'close') main = html`どの属性もほぼ同じ <span class="tg-reco-sub">(${bestName} が少しだけ上)</span>`;
  else main = bestName;
  let badge = null;
  if (v.weapon === 'same') badge = html`<${Badge} kind="ok">いまの武器と同じ</${Badge}>`;
  else if (v.weapon === 'close') badge = html`<${Badge} kind="ok">いまの武器 (${elemName(weaponElem)}) でも大差なし</${Badge}>`;
  else if (v.weapon === 'other') badge = html`<${Badge} kind="info">いまの武器は${elemName(weaponElem)}</${Badge}>`;
  return html`
    <${Card} title="おすすめの属性">
      <p class="tg-reco" data-target-reco data-reco-kind=${v.kind}>${main} ${badge}</p>
      <${Hint}>主な部位 (切断肉質 ${WEAK_POINT_MIN} 以上) の属性肉質の平均がいちばん高い属性です。1 位と 2 位の差が小さいときは「ほぼ同じ」と出します。</${Hint}>
      ${order.length > 0 && html`
        <div class="tg-order">${order.map((o) => html`<span key=${o.type}>${elemName(o.type)} ${formatNumber(o.avg, 1)}</span>`)}</div>`}
      ${rec.tieBreak && v.kind !== 'weak' && html`<${Hint}>${tieText(rec.tieBreak)}</${Hint}>`}
      ${recMark && html`
        <p class="hint th-mark-line" data-th-reco-mark=${recMark}><${MarkBadge} mark=${recMark} /> この個体の傷口の肉質 (置き換え後) で計算し直したおすすめです。</p>`}
    </${Card}>`;
}

// ---------------------------------------------------------------- 部位

function writeMix(monster, on, weights) {
  setTabState('target', { mix: { on, monsterId: monster.id, weights } });
  // 割合で混ぜている間も、一番割合の大きい部位を state.target.partKey に入れておく (1 部位だけで計算する画面用)
  const main = mainPartKey(monster, weights);
  if (main) selectPart(main);
}

/** 弱点の印の文言 (剣・盾のどちらに弱点特効が効くか) */
function weakBadgeText(w) {
  if (w.sword && w.shield) return '弱点';
  if (w.sword) return '弱点 (剣だけ)';
  if (w.shield) return '弱点 (盾だけ)';
  return null;
}

function PartRow({ part, monster, elemCol, selected, share, onClick, ihz }) {
  // 個体の傷口の置き換え (ihz = hunt.js の hitzoneFor の結果。通常なら null) を入れた部位で弱点・傷口の数字を出す
  const wound = ihz ? ihz.wound : part.wound;
  const w = weakInfo(ihz ? { ...part, wound } : part);
  const weakText = weakBadgeText(w);
  const hz = part.hitzone || {};
  const woundChanged = !!ihz && (ihz.woundSource === 'override' || ihz.woundSource === 'override-uncertain')
    && ihz.changed.includes('slash');
  return html`
    <button type="button" class=${cx('tg-part', selected && 'is-selected')} aria-pressed=${selected ? 'true' : 'false'}
      data-part=${part.key} onClick=${onClick}>
      <span class="tg-part-name">
        <span>${partLabel(part, monster)}</span>
        ${weakText && html`<${Badge} kind="ok">${weakText}</${Badge}>`}
        ${share != null && html`<span class="tg-share">全体の ${formatNumber(share * 100, 0)}%</span>`}
      </span>
      <span class=${cx('tg-num', w.sword && 'is-weak')}>${hz.slash ?? '—'}</span>
      <span class="tg-num">${hz[elemCol] ?? '—'}</span>
      <span class=${cx('tg-num', !wound && 'is-none', w.woundSword && 'is-weak', woundChanged && 'th-changed')}>${wound ? wound.slash : '—'}</span>
    </button>`;
}

function PartsCard({ monster, target, ui, weaponElem }) {
  const showUnknown = !!ui.showUnknown;
  const sort = ui.sort === 'slash' ? 'slash' : 'body';
  const kind = individualKindOf(target);
  const useUncertain = target.useUncertainWound === true;
  const rec = elementRecommendationOf(monster, kind, { useUncertain });
  const best = (rec && rec.best) || [];
  // 個体の肉質 (傷口の置き換え)。通常なら null
  const ihzOf = (p) => (kind != null ? hitzoneFor(monster, p, kind, { useUncertain }) : null);
  const elemCol = ELEMENT_KEYS.includes(ui.elem) ? ui.elem : (weaponElem || best[0] || 'fire');
  const mix = readMix(ui, monster.id, monster);
  const shares = mix.on ? mixShares(monster, mix.weights) : [];
  const shareOf = new Map(shares.map((x) => [x.part.key, x.share]));
  const keepKeys = mix.on ? shares.map((x) => x.part.key) : [target.partKey].filter(Boolean);
  const parts = visibleParts(monster, { showUnknown, sort, keepKeys });
  const unknownCount = (monster.parts || []).filter(isUnknownPart).length;

  const onTap = (p) => {
    if (!mix.on) {
      selectPart(p.key);
      return;
    }
    if (mix.weights[p.key] > 0) {
      if (Object.keys(mix.weights).length <= 1) return; // 最後の 1 部位は外さない (狙う部位が無くならないように)
      writeMix(monster, true, removeShare(mix.weights, p.key));
    } else {
      writeMix(monster, true, addShare(mix.weights, p.key));
    }
  };
  const setMixOn = (on) => {
    let w = mix.weights;
    if (on && !Object.keys(w).length && target.partKey) w = { [target.partKey]: 1 };
    writeMix(monster, on, w);
  };
  // つまみの値 = その部位の割合そのもの。ほかの部位は今の比のまま残りを分ける (合計はいつも 100%)
  const setWeight = (key, x) => writeMix(monster, true, setShare(mix.weights, key, x));
  const maxShare = 1 - MIX_MIN_SHARE * Math.max(0, shares.length - 1);

  return html`
    <${Card} title="狙う部位" sub=${mix.on ? 'タップで加える・外す。割合は下のつまみで' : 'タップで選ぶ'}>
      <${Segmented} label="属性の列に出す属性" value=${elemCol} onChange=${(v) => setTabState('target', { elem: v })}
        options=${ELEMENT_KEYS.map((k) => ({ value: k, label: elemName(k) }))} />
      ${weaponElem && elemCol !== weaponElem && html`<${Hint}>いまの武器の属性は${elemName(weaponElem)}です。</${Hint}>`}
      <div class="tg-parts" data-target-parts>
        <div class="tg-part tg-part-head" aria-hidden="true">
          <span>部位</span><span class="tg-num">切断</span><span class="tg-num">${elemName(elemCol)}</span><span class="tg-num">傷口</span>
        </div>
        ${parts.map((p) => {
          const selected = mix.on ? shareOf.has(p.key) : target.partKey === p.key;
          const share = mix.on && shareOf.has(p.key) && shares.length > 1 ? shareOf.get(p.key) : null;
          return html`
            <${PartRow} key=${p.key} part=${p} monster=${monster} elemCol=${elemCol} selected=${selected} share=${share}
              ihz=${ihzOf(p)} onClick=${() => onTap(p)} />
            ${mix.on && shareOf.has(p.key) && shares.length > 1 && html`
              <div class="tg-mix-slider" key=${`${p.key}-w`}>
                <${Slider} label=${`${partLabel(p, monster)}を狙う割合`} value=${shareOf.get(p.key)} min=${MIX_MIN_SHARE} max=${maxShare}
                  step=${0.05} format=${(v) => `全体の ${formatNumber(v * 100, 0)}%`}
                  hint=${shares.length === 2 ? 'もう一方の部位は、残りの割合になります。' : 'ほかの部位は、今の比のまま残りを分けます。'}
                  onChange=${(x) => setWeight(p.key, x)} />
              </div>`}`;
        })}
      </div>
      <${Hint}>数字は肉質 (0〜100。大きいほど通る)。剣は切断・盾は打撃の肉質が ${WEAK_POINT_MIN} 以上 (傷口を狙うときは傷口の肉質) のとき、弱点特効が効きます。「弱点 (剣だけ)」の部位では、盾のヒットには効きません。傷口の「—」は傷口ができない部位です。</${Hint}>
      <${IndividualWoundNote} monster=${monster} target=${target} parts=${parts} ihzOf=${ihzOf} />
      ${unknownCount > 0 && html`
        <${Toggle} label=${`部位不明も出す (${unknownCount} か所)`} checked=${showUnknown}
          onChange=${(on) => setTabState('target', { showUnknown: on })}
          hint="データに名前の無い部位です。どこか分からないので、ふつうは選ばなくて大丈夫です。" />`}
      <div class="field">
        <${Segmented} label="並べ方" value=${sort} onChange=${(v) => setTabState('target', { sort: v })}
          options=${[{ value: 'body', label: '体の順' }, { value: 'slash', label: '切断肉質の高い順' }]} />
      </div>
      <${Toggle} label="いくつかの部位を割合で混ぜる" checked=${mix.on} onChange=${setMixOn}
        hint="頭 6 割・尻尾 4 割のように、当てる割合で期待値を平均します。部位をタップで足して、つまみで割合を決めます" />
    </${Card}>`;
}

/**
 * 個体 (歴戦王など) の傷口の注記: 印 (未確認 / 未確定) と、いつ置き換わるか分からない置き換えを使うかのスイッチ。
 * 印は一覧に出ている部位のうち一番重いもの (ウズ・トゥナの歴戦王 = 未確認、アルシュベルドの歴戦王 = 未確定)。
 */
function IndividualWoundNote({ target, parts, ihzOf }) {
  if (individualKindOf(target) == null) return null;
  const list = parts.map(ihzOf).filter(Boolean);
  const pick = list.find((h) => h.mark === 'uncertain') || list.find((h) => h.mark === 'unverified');
  const hasUncertain = list.some((h) => h.overrideWound && h.sameAsBase == null);
  return html`
    ${pick && html`<${WoundMarkLine} hz=${pick} />`}
    ${hasUncertain && html`
      <${Toggle} label="置き換わった傷口で計算する (参考)" checked=${target.useUncertainWound === true}
        onChange=${(on) => setUseUncertainWound(on)}
        hint="この個体は、傷口の肉質が置き換わることがあります (いつかは分かりません)。オンにすると、置き換わったときの値で計算します (未確定)" />`}`;
}

/** 肉質の表。rows = [[見出し, 肉質, 置き換えで変わった項目の Set か null]] */
function HitzoneTable({ rows, noWound }) {
  const keys = HITZONE_INPUT_KEYS;
  const row = ([label, hz, changed]) => html`
    <tr key=${label}>
      <th scope="row">${label}</th>
      ${keys.map((k) => html`<td key=${k} class=${cx(k === 'slash' && (hz[k] ?? 0) >= WEAK_POINT_MIN && 'is-weak', changed && changed.has(k) && 'th-changed')}>${hz[k] ?? '—'}</td>`)}
    </tr>`;
  return html`
    <div class="tg-detail">
      <table class="tg-hz">
        <thead><tr><th scope="col"></th>${keys.map((k) => html`<th scope="col" key=${k}>${ELEMENT_LABEL[k]}</th>`)}</tr></thead>
        <tbody>
          ${rows.map(row)}
          ${noWound && html`<tr><th scope="row">傷口</th><td colspan=${keys.length}>できません</td></tr>`}
        </tbody>
      </table>
    </div>`;
}

/** 部位の肉質の表の行 (個体の傷口の置き換えがあれば、計算に使う傷口と通常の傷口を並べる) */
function hitzoneRows(part, ihz) {
  const rows = [['通常', part.hitzone || {}, null]];
  if (!part.wound) return rows;
  if (!ihz || !ihz.overrideWound) {
    rows.push(['傷口', part.wound, null]);
    return rows;
  }
  const changed = new Set(ihz.changed);
  if (ihz.woundSource === 'override' || ihz.woundSource === 'override-uncertain') {
    rows.push(['傷口 (この個体)', ihz.wound, changed]);
    rows.push(['傷口 (通常)', part.wound, null]);
  } else {
    rows.push(['傷口', part.wound, null]);
    rows.push(['置き換わったとき', ihz.overrideWound, changed]);
  }
  return rows;
}

function PartDetailCard({ monster, part, target }) {
  const kind = individualKindOf(target);
  const ihz = kind != null ? hitzoneFor(monster, part, kind, { useUncertain: target.useUncertainWound === true }) : null;
  const w = weakInfo(ihz ? { ...part, wound: ihz.wound } : part);
  const weakText = weakBadgeText(w);
  return html`
    <${Card} title=${`${partLabel(part, monster)} の肉質`} sub=${individualName(monster, kind)}>
      <${HitzoneTable} rows=${hitzoneRows(part, ihz)} noWound=${!part.wound} />
      <${WoundMarkLine} hz=${ihz} />
      <div class="tg-badges">
        ${weakText && html`<${Badge} kind="ok">${weakText}</${Badge}>`}
        ${part.breakable && html`<${Badge} kind="info">部位破壊できる</${Badge}>`}
        ${part.severable && html`<${Badge} kind="info">切断できる</${Badge}>`}
        ${isUnknownPart(part) && html`<${Badge} kind="warn">部位不明</${Badge}>`}
      </div>
      ${part.note && html`<${Hint}>${part.note}</${Hint}>`}
      <${Hint}>片手剣の剣は切断、盾の攻撃は打撃の肉質で計算します。弱点特効もヒットごとに、その肉質が ${WEAK_POINT_MIN} 以上かで決まります (傷口を狙うときは傷口の肉質)。</${Hint}>
      ${w.sword && !w.shield && html`<${Hint}>この部位は打撃が ${WEAK_POINT_MIN} 未満なので、盾のヒットには弱点特効が効きません。</${Hint}>`}
    </${Card}>`;
}

// ---------------------------------------------------------------- 手入力

function HitzoneInputs({ hz, wound }) {
  return html`
    <div class="tg-grid">
      ${HITZONE_INPUT_KEYS.map((k) => html`
        <${NumberInput} key=${k} label=${ELEMENT_LABEL[k]} value=${hz[k]} min=${0} max=${100} step=${1} stepper=${false}
          onChange=${(v) => setManualHitzone({ [k]: v }, { wound })} />`)}
    </div>`;
}

function ManualCard({ target }) {
  const m = target.manual;
  return html`
    <${Card} title="肉質を手入力" sub="0〜100 (大きいほど通る)">
      <${TextInput} label="名前 (メモ)" value=${m.name} placeholder="手入力"
        onChange=${(v) => setTarget({ manual: { ...m, name: v.trim() || '手入力' } })} />
      <${HitzoneInputs} hz=${m.hitzone} wound=${false} />
      ${(m.hitzone.slash ?? 0) >= WEAK_POINT_MIN
        ? html`<p class="hint"><${Badge} kind="ok">弱点</${Badge}> 切断 ${WEAK_POINT_MIN} 以上なので、剣のヒットに弱点特効が効きます${(m.hitzone.blunt ?? 0) >= WEAK_POINT_MIN ? ' (打撃も 45 以上なので盾のヒットにも)' : ' (盾のヒットは打撃の肉質で決まります)'}。</p>`
        : html`<${Hint}>剣は切断・盾は打撃の肉質が ${WEAK_POINT_MIN} 以上のとき、弱点特効が効きます。</${Hint}>`}
      <div class="field">
        <${Toggle} label="傷口の肉質も入れる" checked=${m.wound != null}
          onChange=${(on) => (on ? setManualHitzone({}, { wound: true }) : setManualHitzone(null, { wound: true }))}
          hint="入れないと、傷口ができない相手として計算します" />
      </div>
      ${m.wound && html`
        <p class="card-subhead">傷口の肉質</p>
        <${HitzoneInputs} hz=${m.wound} wound=${true} />`}
    </${Card}>`;
}

// ---------------------------------------------------------------- 傷口

function WoundCard({ target, noWound }) {
  return html`
    <${Card} title="傷口">
      <${Toggle} label="傷口を狙う" checked=${target.isWound} onChange=${(on) => setWound(on)}
        hint="オンにすると、コンボの技をすべて傷口の肉質で計算します" />
      <${Hint}>コンボ「集中弱点攻撃で傷を突く」は、このスイッチに関係なく傷口で計算します。</${Hint}>
      ${target.mode !== 'manual' && individualKindOf(target) === 'arch-tempered' && html`
        <${Hint}>歴戦王は傷が付きにくいので、傷口を狙う技の回数は減ります (期待値は傷口ができている前提の値です)。</${Hint}>`}
      ${noWound && html`
        <${Notice} kind="warn" title=${noWound}>
          <p>傷口を狙うコンボも、傷口なしで計算します。</p>
        </${Notice}>`}
    </${Card}>`;
}

// ---------------------------------------------------------------- 咆哮・風圧・属性やられ など

function NeedLine({ need }) {
  if (!need) return null;
  let state;
  if (need.negated) state = html`<${Badge} kind="ok">防げています</${Badge}>`;
  else if (need.mitigated) state = html`<${Badge} kind="warn">軽くなります</${Badge}>`;
  return html`
    <div class="tg-th-need">
      <span>${need.name} <strong>Lv${need.negateLevel}</strong> で無効${need.mitigateLevel ? ` (Lv${need.mitigateLevel} で軽く)` : ''}</span>
      <span class="hint" style="margin-top: 0;">いま ${need.have > 0 ? `Lv${need.have}` : 'なし'}</span>
      ${state}
    </div>`;
}

function ThreatCard({ info }) {
  const v = info.variant;
  return html`
    <${Card} title="気をつけること" sub="咆哮・風圧・振動・属性やられ・状態異常と、防ぐスキル">
      ${v && v.sameAsBase && v.sameAsBase.all && html`
        <p class="hint th-hint-first" data-th-threat-same>${v.name || 'この個体'}も、咆哮・風圧・振動・属性やられ・状態異常は通常と同じと見ています ${v.sameAsBase.confidence !== 'high' && html`<${MarkBadge} mark="unverified" />`}</p>`}
      <ul class="tg-threats" data-target-threats>
        ${info.hazards.map((h) => html`
          <li key=${h.key}>
            <div class="tg-th-head"><span class="tg-th-label">${h.label}</span><span class="tg-th-value">${h.text}</span></div>
            <${NeedLine} need=${h.need} />
            ${h.unknown && html`<span class="tg-th-text">出典にデータがありません。</span>`}
          </li>`)}
      </ul>
      <p class="card-subhead">属性やられ</p>
      ${info.blights.length === 0 ? html`<p class="hint" style="margin-top: 0;">ありません (出典に記載なし)</p>` : html`
        <ul class="tg-threats" data-target-blights>
          ${info.blights.map((b) => html`
            <li key=${b.element}>
              <div class="tg-th-head">
                <span class="tg-th-label">${b.name} ${b.uncertain && html`<${Badge} kind="warn">未確認</${Badge}>`}</span>
              </div>
              <${NeedLine} need=${b.need} />
              <span class="tg-th-text">${b.resistName}の値が ${b.resistThreshold} 以上でも防げます。</span>
              ${b.uncertain && html`<span class="tg-th-text">${elemName(b.element)}属性の攻撃はありますが、属性やられになるかはまだ確かめられていません。</span>`}
            </li>`)}
        </ul>`}
      ${v && v.hazards.length > 0 && html`
        <p class="card-subhead">${v.kind === 'arch-tempered' ? '歴戦王' : 'この個体'}だけの攻撃</p>
        <ul class="tg-threats" data-th-variant-hazards>
          ${v.hazards.map((h) => html`
            <li key=${h.key}>
              <div class="tg-th-head"><span class="tg-th-label">${h.text} ${h.unverified && html`<${MarkBadge} mark="unverified" />`}</span></div>
              ${h.need ? html`<${NeedLine} need=${h.need} />` : html`<span class="tg-th-text">${h.noSkill}</span>`}
            </li>`)}
        </ul>`}
      <p class="card-subhead">状態異常</p>
      ${info.status.length === 0 ? html`<p class="hint" style="margin-top: 0;">ありません (出典に記載なし)</p>` : html`
        <ul class="tg-threats" data-target-status>
          ${info.status.map((s) => html`
            <li key=${s.key}>
              <div class="tg-th-head"><span class="tg-th-label">${s.name} ${s.nameUncertain && html`<${Badge} kind="warn">名前は未確認</${Badge}>`}</span></div>
              <${NeedLine} need=${s.need} />
              ${s.noSkill && html`<span class="tg-th-text">${s.noSkill}</span>`}
            </li>`)}
        </ul>`}
      <p class="hint">
        「いま」は装備タブの装備のスキル Lv です。
        出典: ${info.wikiUrl
          ? html`<a href=${info.wikiUrl} target="_blank" rel="noopener noreferrer">Monster Hunter Wiki</a>`
          : 'Monster Hunter Wiki'} (CC BY-SA 4.0)。
      </p>
    </${Card}>`;
}

// ---------------------------------------------------------------- 本体

export default function TargetTab({ data, active }) {
  const t = useTargetData();
  const target = useAppState((s) => s.target);
  const ui = useAppState((s) => s.tabs.target) || EMPTY;
  const build = useAppState((s) => s.build);
  // 装備タブで足した武器・護石も含めた索引 (武器の属性と、防ぐスキルの「いまの Lv」に使う)
  const { idx } = useEquipIndex(data, { active });
  const weapon = useMemo(() => resolveWeaponRef(build.weapon, idx), [build.weapon, idx]);
  const weaponElem = weapon && weapon.element && ELEMENT_KEYS.includes(weapon.element.type) ? weapon.element.type : null;
  // いまの装備 (防ぐスキルの「いまの Lv」と、討伐までの回数に使う 1 コンボの期待値)
  const buildResult = useMemo(() => {
    try {
      return computeBuild(build, idx);
    } catch {
      return null;
    }
  }, [build, idx]);
  const skillLevels = (buildResult && buildResult.skillLevels) || EMPTY;

  if (t.status === 'error') return html`<${ErrorBox} title="モンスターのデータを読み込めませんでした" error=${t.error} onRetry=${t.retry} />`;
  if (t.status !== 'ready') return html`<${Loading} text="モンスターのデータを読み込み中…" />`;
  const td = t.data;
  const isManual = target.mode === 'manual';
  const monster = isManual ? null : findMonster(td, target.monsterId);
  const mix = monster ? readMix(ui, monster.id, monster) : null;
  const mixShareList = monster && mix.on ? mixShares(monster, mix.weights) : [];
  const part = monster && !(mix.on && mixShareList.length > 1) ? findPart(monster, target.partKey) : null;
  const info = monster ? threatInfo(td.threats, monster.id, skillLevels, { kind: individualKindOf(target) }) : null;

  let noWound = null;
  if (isManual && !target.manual.wound) noWound = '傷口の肉質を入れていません';
  else if (part && !part.wound) noWound = 'この部位には傷口ができません';
  else if (mixShareList.some((x) => !x.part.wound)) {
    noWound = `${mixShareList.filter((x) => !x.part.wound).map((x) => partLabel(x.part, monster)).join('・')} には傷口ができません`;
  }

  return html`
    <div class="stack" data-target-root data-target-loaded="1">
      <${Card} title="相手の決め方">
        <${Segmented} value=${target.mode} onChange=${(v) => setTargetMode(v)}
          options=${[{ value: 'monster', label: 'モンスターから選ぶ' }, { value: 'manual', label: '肉質を手入力' }]} />
        <${Hint}>選んだ相手は、装備タブと火力タブの計算に使われます。</${Hint}>
      </${Card}>
      ${isManual ? html`<${ManualCard} target=${target} />` : html`
        <${MonsterPicker} td=${td} target=${target} ui=${ui} />
        ${!monster && html`<${Hint}>モンスターを選ぶと、部位ごとの肉質・おすすめの属性・気をつけることが出ます。クエストの名前からも選べます。</${Hint}>`}
        ${monster && html`
          <${HuntCards} data=${data} td=${td} monster=${monster} target=${target} ui=${ui} idx=${idx} buildResult=${buildResult}
            weaponFull=${weapon} weaponElem=${weaponElem} info=${info} active=${active} />`}
        ${monster && html`<${RecommendCard} monster=${monster} target=${target} weaponElem=${weaponElem} />`}
        ${monster && html`<${PartsCard} monster=${monster} target=${target} ui=${ui} weaponElem=${weaponElem} />`}
        ${monster && !part && !(mix && mix.on && mixShareList.length) && html`<${Notice} kind="info" title="部位を選んでください" />`}
        ${part && html`<${PartDetailCard} monster=${monster} part=${part} target=${target} />`}`}
      <${WoundCard} target=${target} noWound=${noWound} />
      ${info && html`<${ThreatCard} info=${info} />`}
      ${monster && !info && html`<${Hint}>このモンスターの咆哮・風圧などのデータがありません。</${Hint}>`}
    </div>`;
}
