// 相手タブ: モンスター (34 体) と狙う部位を選ぶ / 肉質を手入力する。
// - 部位の一覧: 切断肉質・属性の肉質・傷口の肉質・弱点 (剣は切断・盾は打撃の肉質が 45 以上) の印。部位不明は既定で隠す。
// - いくつかの部位を割合で混ぜられる (火力の期待値は割合で平均)。指定は state の tabs.target に置く (target_mix.js)。
// - おすすめの属性 (monsters.json の elementRecommendation) と、咆哮・風圧・振動・属性やられ・状態異常を防ぐスキル
//   (monster_threats.json の rules。出典 Monster Hunter Wiki / CC BY-SA 4.0)。
// 選んだ相手は state.target に入り、装備タブ・火力タブの計算に使われる。
import { useMemo } from 'preact/hooks';
import {
  html, Card, Hint, Badge, Notice, Loading, ErrorBox, Segmented, Toggle, Slider, NumberInput, TextInput, PickerField,
  ELEMENT_LABEL, formatNumber,
} from '../components/index.js';
import {
  useAppState, setTargetMode, selectMonster, selectPart, setWound, setManualHitzone, setTarget, setTabState,
} from '../../state.js';
import { useTargetData } from '../../data.js';
import { computeBuild } from '../../model/build.js';
import { useEquipIndex } from './equip_index.js';
import { resolveWeaponRef } from './equip_logic.js';
import {
  visibleParts, defaultPartKey, findMonster, findPart, isUnknownPart, readMix, mixShares, mainPartKey,
  threatInfo, partLabel, weakInfo, recommendationView, setShare, addShare, removeShare, MIX_MIN_SHARE,
  ELEMENT_KEYS, HITZONE_INPUT_KEYS, WEAK_POINT_MIN,
} from './target_mix.js';

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

function pickMonster(td, id) {
  if (id == null) {
    selectMonster(null);
    return;
  }
  selectMonster(id, defaultPartKey(findMonster(td, id)));
}

function MonsterPicker({ td, target }) {
  const items = useMemo(() => {
    const en = new Map(td.lists.threats.map((x) => [x.monsterId, x.nameEn || '']));
    return td.lists.monsters.map((m) => ({
      value: m.id, label: m.name, sub: `おすすめの属性: ${bestText(m)}`, keywords: en.get(m.id) || '',
    }));
  }, [td]);
  return html`
    <${Card} title="モンスター">
      <${PickerField} title="モンスターを選ぶ" items=${items} value=${target.monsterId}
        onChange=${(v) => pickMonster(td, v)} allowNone noneLabel="選ばない" placeholder="選んでいません"
        searchPlaceholder="名前で探す (ひらがなでも)" />
    </${Card}>`;
}

function tieText(tb) {
  if (!tb) return null;
  const tied = (tb.tied || []).map(elemName).join('・');
  if (tb.by === 'woundAvg') return `${tied} が同じ値だったので、主な部位の傷口の肉質の平均で決めました。`;
  if (tb.by === 'allPartsAvg') return `${tied} が同じ値で、傷口でも同じだったので、全部位の平均で決めました。`;
  return `${tied} が同じ値です。`;
}

function RecommendCard({ monster, weaponElem }) {
  const rec = monster.elementRecommendation || {};
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

function PartRow({ part, monster, elemCol, selected, share, onClick }) {
  const w = weakInfo(part);
  const weakText = weakBadgeText(w);
  const hz = part.hitzone || {};
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
      <span class=${cx('tg-num', !part.wound && 'is-none', w.woundSword && 'is-weak')}>${part.wound ? part.wound.slash : '—'}</span>
    </button>`;
}

function PartsCard({ monster, target, ui, weaponElem }) {
  const showUnknown = !!ui.showUnknown;
  const sort = ui.sort === 'slash' ? 'slash' : 'body';
  const best = (monster.elementRecommendation && monster.elementRecommendation.best) || [];
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
              onClick=${() => onTap(p)} />
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

function HitzoneTable({ part }) {
  const keys = HITZONE_INPUT_KEYS;
  const row = (label, hz) => html`
    <tr>
      <th scope="row">${label}</th>
      ${keys.map((k) => html`<td key=${k} class=${k === 'slash' && (hz[k] ?? 0) >= WEAK_POINT_MIN ? 'is-weak' : ''}>${hz[k] ?? '—'}</td>`)}
    </tr>`;
  return html`
    <div class="tg-detail">
      <table class="tg-hz">
        <thead><tr><th scope="col"></th>${keys.map((k) => html`<th scope="col" key=${k}>${ELEMENT_LABEL[k]}</th>`)}</tr></thead>
        <tbody>
          ${row('通常', part.hitzone || {})}
          ${part.wound ? row('傷口', part.wound) : html`<tr><th scope="row">傷口</th><td colspan=${keys.length}>できません</td></tr>`}
        </tbody>
      </table>
    </div>`;
}

function PartDetailCard({ monster, part }) {
  const w = weakInfo(part);
  const weakText = weakBadgeText(w);
  return html`
    <${Card} title=${`${partLabel(part, monster)} の肉質`} sub=${monster.name}>
      <${HitzoneTable} part=${part} />
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
  return html`
    <${Card} title="気をつけること" sub="咆哮・風圧・振動・属性やられ・状態異常と、防ぐスキル">
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
  const skillLevels = useMemo(() => {
    try {
      return computeBuild(build, idx).skillLevels;
    } catch {
      return {};
    }
  }, [build, idx]);

  if (t.status === 'error') return html`<${ErrorBox} title="モンスターのデータを読み込めませんでした" error=${t.error} onRetry=${t.retry} />`;
  if (t.status !== 'ready') return html`<${Loading} text="モンスターのデータを読み込み中…" />`;
  const td = t.data;
  const isManual = target.mode === 'manual';
  const monster = isManual ? null : findMonster(td, target.monsterId);
  const mix = monster ? readMix(ui, monster.id, monster) : null;
  const mixShareList = monster && mix.on ? mixShares(monster, mix.weights) : [];
  const part = monster && !(mix.on && mixShareList.length > 1) ? findPart(monster, target.partKey) : null;
  const info = monster ? threatInfo(td.threats, monster.id, skillLevels) : null;

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
        <${MonsterPicker} td=${td} target=${target} />
        ${!monster && html`<${Hint}>モンスターを選ぶと、部位ごとの肉質・おすすめの属性・気をつけることが出ます。</${Hint}>`}
        ${monster && html`<${RecommendCard} monster=${monster} weaponElem=${weaponElem} />`}
        ${monster && html`<${PartsCard} monster=${monster} target=${target} ui=${ui} weaponElem=${weaponElem} />`}
        ${monster && !part && !(mix && mix.on && mixShareList.length) && html`<${Notice} kind="info" title="部位を選んでください" />`}
        ${part && html`<${PartDetailCard} monster=${monster} part=${part} />`}`}
      <${WoundCard} target=${target} noWound=${noWound} />
      ${info && html`<${ThreatCard} info=${info} />`}
      ${monster && !info && html`<${Hint}>このモンスターの咆哮・風圧などのデータがありません。</${Hint}>`}
    </div>`;
}
