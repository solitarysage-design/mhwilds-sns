// 設定タブ: アプリとデータの版・保存領域の状態・全データの書き出し/読み込み・初期化・出典とライセンス。
// core データが読めなくても開ける (書き出しと初期化はデータが無くても使えるように)。
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  html, Card, Button, Hint, KeyValue, Notice, Loading, BottomSheet, toast,
  formatDateTime, formatBytes, formatNumber,
} from '../components/index.js';
import { getAppVersion, checkForUpdate, isOfflineReady } from '../components/app-update.js';
import { isStandalone } from '../shell.js';
import { DATA_FILES, useData, useTargetData } from '../../data.js';
import {
  storageInfo, requestPersist, exportAllText, parseBackupText, importBackup, saveTextFile, copyText,
  readFileText, backupFileName, kvClear,
} from '../../store.js';
import { flushState, reloadState, resetState, getSaveStatus, useAppState, STATE_KEY } from '../../state.js';

// ---------------------------------------------------------------- アプリの版

function AppCard({ active }) {
  const [version, setVersion] = useState(undefined);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (!active) return;
    getAppVersion().then(setVersion);
  }, [active]);
  const check = async () => {
    setChecking(true);
    const ok = await checkForUpdate();
    setChecking(false);
    toast(ok ? '確かめました。新しい版があれば画面の下にお知らせが出ます' : '確かめられませんでした (電波が無いなど)');
  };
  const offline = isOfflineReady();
  return html`
    <${Card} title="アプリ">
      <${KeyValue} rows=${[
        ['アプリの版', version === undefined ? '…' : version || '— (オフライン用の仕組みがまだ動いていません)'],
        ['オフライン', offline ? '電波が無くても開けます' : 'まだ準備できていません (電波のある所で一度開くと使えるようになります)'],
      ]} />
      <div class="btn-row">
        <${Button} onClick=${check} disabled=${checking}>${checking ? '確かめています…' : '新しい版を確かめる'}</${Button}>
      </div>
    </${Card}>`;
}

// ---------------------------------------------------------------- データの版

function countOf(key, d) {
  if (!d) return null;
  const listKey = { skills: 'skills', armor: 'armor', weapons: 'weapons', decorations: 'decorations',
    charmsFixed: 'charms', charms: 'charms', myWeapons: 'weapons', combos: 'combos', motions: 'moves',
    monsters: 'monsters', quests: 'quests', threats: 'monsters' }[key];
  if (key === 'bonuses') return (d.setBonuses?.length || 0) + (d.groupBonuses?.length || 0);
  if (key === 'skillEffects') return d.effects ? Object.keys(d.effects).length : null;
  if (key === 'talismanRules') return d.rarities ? Object.keys(d.rarities).length : null;
  return listKey && Array.isArray(d[listKey]) ? d[listKey].length : null;
}

function DataRow({ f, file }) {
  const meta = file && (file.meta || null);
  const n = countOf(f.key, file);
  let detail;
  if (!file) detail = '';
  else if (meta) {
    detail = [
      meta.generatedAt ? `作成 ${formatDateTime(meta.generatedAt)}` : null,
      meta.gameVersion ? `ゲームの版 ${meta.gameVersion}` : null,
    ].filter(Boolean).join('・');
  } else {
    detail = '手で増やすファイル';
  }
  return html`
    <li class="data-row">
      <div class="data-row-head">
        <span class="data-row-label">${f.label}</span>
        <span class="data-row-count">${n != null ? `${formatNumber(n)} 件` : ''}</span>
      </div>
      ${detail && html`<div class="data-row-sub">${detail}</div>`}
    </li>`;
}

/** ファイル名 (技術的な中身) は畳んでおく。人に聞かれたときや報告のときに開く */
function FileNames({ files }) {
  return html`
    <details class="more">
      <summary>くわしく (ファイル名)</summary>
      <ul class="hint data-files">
        ${files.map((f) => html`<li key=${f.key}>${f.label}: <code>data/${f.file}</code></li>`)}
      </ul>
    </details>`;
}

function DataCard() {
  const core = useData();
  const target = useTargetData({ load: false });
  const coreFiles = DATA_FILES.filter((f) => f.group === 'core');
  const targetFiles = DATA_FILES.filter((f) => f.group === 'target');
  const gameVersion = core.data?.meta?.skills?.gameVersion;
  return html`
    <${Card} title="データの版" sub=${gameVersion ? `ゲームの版 ${gameVersion} のデータ` : null}>
      ${core.status === 'loading' && html`<${Loading} text="データを読み込み中…" />`}
      ${core.status === 'error' && html`
        <${Notice} kind="error" title="データを読み込めませんでした" actions=${html`<${Button} onClick=${core.retry}>もう一度</${Button}>`}>
          <p>${core.error?.message}</p>
          ${core.error?.detail && html`<details class="more"><summary>くわしく</summary><p class="hint">${core.error.detail}</p></details>`}
        </${Notice}>`}
      ${core.status === 'ready' && html`
        <ul class="data-list">
          ${coreFiles.map((f) => html`<${DataRow} key=${f.key} f=${f} file=${core.data[f.key]} />`)}
        </ul>`}
      <h3 class="card-subhead">相手タブのデータ</h3>
      ${target.status === 'ready' ? html`
        <ul class="data-list">
          ${targetFiles.map((f) => html`<${DataRow} key=${f.key} f=${f} file=${target.data[f.key]} />`)}
        </ul>` : target.status === 'loading' ? html`<${Loading} text="読み込み中…" />` : html`
        <${Hint}>相手タブを開いたときに読み込みます (モンスター・クエスト)。</${Hint}>
        ${target.status === 'error' && html`<p class="hint text-danger">${target.error?.message}</p>`}
        <div class="btn-row"><${Button} onClick=${target.retry}>今読み込んで確かめる</${Button}></div>`}
      <${FileNames} files=${DATA_FILES} />
    </${Card}>`;
}

// ---------------------------------------------------------------- 保存領域

function StorageCard({ active, refreshKey }) {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => storageInfo().then(setInfo).catch(() => setInfo(null));
  useEffect(() => {
    if (active) refresh();
  }, [active, refreshKey]);
  const ask = async () => {
    setBusy(true);
    const r = await requestPersist({ force: true });
    setBusy(false);
    toast(r === true ? '消されにくい設定になりました' : r === false ? 'この端末では今は認められませんでした' : 'このブラウザには仕組みがありません');
    refresh();
  };
  const save = getSaveStatus();
  if (!info) return html`<${Card} title="保存領域"><${Loading} /></${Card}>`;
  return html`
    <${Card} title="保存領域">
      ${!info.available && html`
        <${Notice} kind="warn" title="この端末に保存できません">
          <p>選んだ装備などは画面を閉じると消えます。プライベートブラウズを使っていないか確かめてください。</p>
          ${info.error && html`<p class="hint">${info.error}</p>`}
        </${Notice}>`}
      <${KeyValue} rows=${[
        ['保存', info.available ? 'この端末に保存しています' : 'メモリだけ (閉じると消えます)'],
        ['消されにくさ', info.persisted === true ? html`守られています` : info.persisted === false
          ? html`<span>ふつう (容量が足りないと消されることがあります)</span>` : '不明'],
        ['使っている量', info.usage != null ? `${formatBytes(info.usage)}${info.quota ? ` / 上限 ${formatBytes(info.quota)}` : ''}` : '不明'],
        ['保存している項目', `${info.keys} 件`],
        ['最後に保存', save.at ? `${formatDateTime(save.at)}${save.status === 'memory' ? ' (メモリだけ)' : ''}` : '—'],
      ]} />
      ${!isStandalone() && html`
        <${Notice} kind="info" title="ホーム画面に追加すると、保存が消えにくくなります">
          <p>Safari のまま使っていると、しばらくこのページを開かないときに、保存したデータが消されることがあります (ホーム画面に追加したアプリは対象外です)。Safari の共有ボタンから「ホーム画面に追加」を選んでください。</p>
        </${Notice}>`}
      <${Hint}>
        ホーム画面に追加したアプリと Safari では保存場所が別です。移すときは下の「書き出し」と「読み込み」を使ってください。
      </${Hint}>
      ${info.persisted !== true && html`
        <div class="btn-row"><${Button} onClick=${ask} disabled=${busy}>消されないよう頼む</${Button}></div>`}
    </${Card}>`;
}

// ---------------------------------------------------------------- 書き出し / 読み込み

function summarize(backup) {
  const e = backup.entries || {};
  const st = e[STATE_KEY];
  const parts = [];
  if (st && Array.isArray(st.mySets)) parts.push(`マイセット ${st.mySets.length} 件`);
  if (st && st.build) parts.push('今の装備');
  const others = Object.keys(e).filter((k) => k !== STATE_KEY).length;
  if (others) parts.push(`ほか ${others} 項目`);
  return parts.join('・') || '空のデータ';
}

function BackupCard({ onImported }) {
  const fileRef = useRef(null);
  const [pending, setPending] = useState(null);   // 読み込む前の確認 {backup, keys}
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [busy, setBusy] = useState(false);

  // 書き出しの文字を作る。版は一度聞けたものを使い回す (iPhone はタップから時間がたつと共有・コピーを断るので、早く作る)
  const makeText = async () => {
    await flushState();
    return exportAllText({ appVersion: (await getAppVersion({ cached: true })) || null });
  };
  const doExport = async () => {
    setBusy(true);
    try {
      const r = await saveTextFile(await makeText(), backupFileName());
      if (r === 'downloaded') toast('ファイルを保存しました (ダウンロード)');
      else if (r === 'shared') toast('書き出しました');
    } catch (e) {
      toast(`書き出せませんでした (${e.message || e})`, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const doCopy = async () => {
    // 文字ができるのを待たずに、タップの処理の中でクリップボードに渡す (Promise のまま渡す。iPhone の Safari 向け)
    const ok = await copyText(makeText());
    toast(ok ? 'コピーしました。メモ帳などに貼って保管してください' : 'コピーできませんでした', { kind: ok ? 'info' : 'error' });
  };
  const check = (text) => {
    const r = parseBackupText(text);
    if (!r.ok) {
      toast(r.message, { kind: 'error', ms: 4000 });
      return false;
    }
    setPending(r);
    return true;
  };
  const onFile = async (e) => {
    const file = e.currentTarget.files && e.currentTarget.files[0];
    e.currentTarget.value = '';
    if (!file) return;
    try {
      check(await readFileText(file));
    } catch (err) {
      toast(`ファイルを読めませんでした (${err.message || err})`, { kind: 'error' });
    }
  };
  const doImport = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const n = await importBackup(pending.backup, { replace: true });
      await reloadState();
      setPending(null);
      toast(`読み込みました (${n} 項目)`);
      onImported && onImported();
    } catch (e) {
      toast(`読み込めませんでした (${e.message || e})`, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return html`
    <${Card} title="全データの書き出し・読み込み">
      <${Hint}>選んだ装備・マイセット・発動率などを 1 つのテキストファイル (.txt) にします。機種変更や控えに使えます。</${Hint}>
      <div class="btn-col">
        <${Button} variant="primary" block onClick=${doExport} disabled=${busy}>書き出す (ファイル)</${Button}>
        <${Button} block onClick=${doCopy} disabled=${busy}>書き出す (テキストをコピー)</${Button}>
        <${Button} block onClick=${() => fileRef.current && fileRef.current.click()} disabled=${busy}>ファイルから読み込む</${Button}>
        <${Button} block onClick=${() => { setPasteText(''); setPasteOpen(true); }} disabled=${busy}>テキストを貼り付けて読み込む</${Button}>
      </div>
      <input ref=${fileRef} type="file" accept=".txt,.json,text/plain,application/json" class="visually-hidden"
        tabindex="-1" aria-hidden="true" onChange=${onFile} />
      ${pending && html`
        <${Notice} kind="warn" title="読み込むと今のデータは置き換わります"
          actions=${html`
            <${Button} variant="primary" onClick=${doImport} disabled=${busy}>読み込む</${Button}>
            <${Button} variant="ghost" onClick=${() => setPending(null)} disabled=${busy}>やめる</${Button}>`}>
          <p>${summarize(pending.backup)}${pending.backup.exportedAt ? ` (書き出し ${formatDateTime(pending.backup.exportedAt)})` : ''}</p>
        </${Notice}>`}
      <${BottomSheet} open=${pasteOpen} title="テキストを貼り付け" onClose=${() => setPasteOpen(false)}
        footer=${html`<${Button} variant="primary" block disabled=${!pasteText.trim()}
          onClick=${() => { if (check(pasteText)) setPasteOpen(false); }}>中身を確かめる</${Button}>`}>
        <textarea class="input textarea" rows="8" placeholder="書き出したテキストをここに貼り付け"
          value=${pasteText} onInput=${(e) => setPasteText(e.currentTarget.value)}></textarea>
      </${BottomSheet}>
    </${Card}>`;
}

// ---------------------------------------------------------------- 初期化

function ResetCard({ onReset }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const doReset = async () => {
    setBusy(true);
    try {
      await kvClear();
      await resetState();
      toast('初期化しました');
      onReset && onReset();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  const sets = useAppState((s) => s.mySets.length);
  return html`
    <${Card} title="初期化">
      <${Hint}>この端末に保存した装備・マイセット・発動率などを全部消して、最初の状態に戻します。ゲームのデータは消えません。</${Hint}>
      ${!confirming ? html`
        <div class="btn-row"><${Button} variant="danger" onClick=${() => setConfirming(true)}>すべて初期化する</${Button}></div>` : html`
        <${Notice} kind="warn" title="本当に消しますか？"
          actions=${html`
            <${Button} variant="danger" onClick=${doReset} disabled=${busy}>消す</${Button}>
            <${Button} variant="ghost" onClick=${() => setConfirming(false)} disabled=${busy}>やめる</${Button}>`}>
          <p>マイセット ${sets} 件も消えます。元に戻せません。先に「書き出す」で控えを取るのがおすすめです。</p>
        </${Notice}>`}
    </${Card}>`;
}

// ---------------------------------------------------------------- 出典とライセンス

const ext = (href, text) => html`<a href=${href} target="_blank" rel="noopener noreferrer">${text}</a>`;

function CreditsCard() {
  return html`
    <${Card} title="出典とライセンス">
      <ul class="credit-list">
        <li>
          <strong>MHDB</strong> (${ext('https://wilds.mhdb.io', 'wilds.mhdb.io')}・${ext('https://github.com/LartTyler/mhdb-wilds-data', 'LartTyler/mhdb-wilds-data')} MIT)
          <span class="credit-what">防具・スキル・装飾品・片手剣・護石・モンスターの基本データ。名前と数値だけを使っています。</span>
        </li>
        <li>
          <strong>MHWS-in-json</strong> (${ext('https://github.com/dzxrly/MHWS-in-json', 'dzxrly/MHWS-in-json')}・MIT ライセンス)
          <span class="credit-what">スキルの内部の数値・技のモーション値・斬れ味の補正・鑑定護石の抽選表・肉質の詳細・クエストの日本語名。</span>
        </li>
        <li>
          <strong>Monster Hunter Wiki</strong> (${ext('https://monsterhunterwiki.org', 'monsterhunterwiki.org')} の寄稿者・${ext('https://creativecommons.org/licenses/by-sa/4.0/deed.ja', 'CC BY-SA 4.0')})
          <span class="credit-what">咆哮・風圧・振動・属性やられ・クエストの構成。これを加工した
            ${ext('./data/monster_threats.json', 'monster_threats.json')} と ${ext('./data/quests.json', 'quests.json')}
            も同じ CC BY-SA 4.0 で提供します。</span>
        </li>
        <li>
          <strong>画面の部品</strong>
          <span class="credit-what">
            Preact 10.24.3 (${ext('./app/vendor/LICENSE-preact.txt', 'MIT ライセンス')})・
            htm 3.1.1 (${ext('./app/vendor/LICENSE-htm.txt', 'Apache License 2.0')})
          </span>
        </li>
      </ul>
      <${Notice} kind="info" title="権利について">
        <p>『モンスターハンターワイルズ』のゲームの名前・数値・文章などの著作権は株式会社カプコンにあります (© CAPCOM)。</p>
        <p>このアプリは個人が作った非公式のもので、株式会社カプコンとは関係ありません。ゲームの画像やアイコンは使っていません。</p>
      </${Notice}>
    </${Card}>`;
}

// ---------------------------------------------------------------- タブ本体

export default function SettingsTab({ active }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = () => setRefreshKey((k) => k + 1);
  return html`
    <div class="stack">
      <${AppCard} active=${active} />
      <${DataCard} />
      <${StorageCard} active=${active} refreshKey=${refreshKey} />
      <${BackupCard} onImported=${bump} />
      <${ResetCard} onReset=${bump} />
      <${CreditsCard} />
    </div>`;
}
