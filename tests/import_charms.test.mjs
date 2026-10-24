// tools/import_charms.mjs (所持護石のシートの取り込み) のテスト。小さな CSV で、id の決め方・スロットの読み方・取り込まない行・
// c0001 の扱い・取り込み直しを確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseCsv, readSheet, parseSlotCell, importSheet, charmsJsonText, sheetIdOf, lowestPattern, allowedSlotPatterns, summaryText,
} from '../tools/import_charms.mjs';
import { validateCharm, nextCharmId } from '../app/model/charms.js';

const readJson = (rel) => JSON.parse(fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'));
const ctx = { skills: readJson('data/skills.json'), rules: readJson('data/talisman_rules.json'), charmsFixed: readJson('data/charms_fixed.json') };

const HEAD = [
  'モンスターハンターワイルズ｜所持護石一覧,,,,,,,,,,,,,,,,,,',
  '2026-10-24 更新　｜　登録 n 個,,,,,,,,,,,,,,,,,,',
  ',,,,,,,,,,,,,,,,,,',
  'No.,RARE,スキル①,Lv①,スキル②,Lv②,スキル③,Lv③,スロット①,スロット②,スロット③,片手剣,ランス,双剣,弓,王アルシュ片手剣,評価メモ,元画像・動画,確認',
];
/** シートの 1 行 (評価の 5 列とメモは空) */
const row = (no, rare, s, slots = [], src = '') => {
  const sk = [...s, ['', ''], ['', ''], ['', '']].slice(0, 3).flat();
  const sl = [...slots, '', '', ''].slice(0, 3);
  return [no, rare, ...sk, ...sl, 'B', 'C', 'C', 'C', 'C', '', src, 'スロット暫定'].join(',');
};
const C0001 = {
  id: 'c0001', name: '秘歴の護石', rarity: 7,
  skills: [{ skillId: 59, name: 'ガード性能', level: 3 }, { skillId: 133, name: '属性吸収', level: 1 }],
  armorSlots: [2, 0, 0], weaponSlots: [0], source: '写真 2026-10-21', addedAt: '2026-10-21', note: '',
};
const ROWS = [
  row(88, 7, [['KO術', 3], ['連撃', 1]], [2], 'IMG_7657.mp4 #087'),   // 半角の KO術 → ＫＯ術。穴 1 つ → 防具用 Lv1
  row(177, 5, [['KO術', 1], ['耳栓', 1], ['広域化', 3]], [2, 2]),       // レア5 の穴 2 つ → 防具用 1-1
  row(201, 5, [['会心撃【属性】', 1], ['属性やられ耐性', 2]], [1]),     // レア5 の穴 1 つは Lv2 から (Lv1 の形は無い)
  row(29, 8, [['KO術', 2], ['見切り', 1], ['攻勢', 1]], [1, 1]),        // レア8: 1 つ目が武器用 Lv1、残りが防具用 Lv1
  row(23, 8, [['業物', 3], ['威嚇', 3]], [3]),                          // レア8 は Lv1 だけ: 「3」でも武器用 Lv1
  row(5, 7, [['ガード性能', 3], ['属性吸収', 1]], [1]),                 // = c0001 (写真のスロット [2,0,0] を正とする)
  row(55, 7, [['ガード性能', 3], ['属性吸収', 1]], [1, 1]),             // 同じスキルの別の個体 (どちらも残す)
  row(56, 7, [['ガード性能', 3], ['属性吸収', 1]], [1, 1]),             // まったく同じ護石が 2 行目 (どちらも残す)
  row(17, 8, [['抜刀術【技】', 2], ['騎乗回復量UP', 3], ['耳栓', 1]], [1, 1, 1]), // 名前が見つからない
  row(75, 7, [['通常弾・通常矢強化', 1], ['氷耐性', 3], ['キノコ大好き', 1]], [2]), // 抽選表に無い組
  row(247, 4, [['鎖刃刺撃', 1]], []),                                    // 生産する護石と同じ
  row(255, 7, [['達人芸', 1], ['属性変換', 1]], []),                    // 穴なしの形は無い
];
const csvOf = (rows, { crlf = false, bom = false } = {}) => `${bom ? '﻿' : ''}${[...HEAD, ...rows].join(crlf ? '\r\n' : '\n')}\n`;
const run = (rows, existing = { schema: 1, charms: [C0001] }, opts = { date: '2026-10-24' }, csvOpts) =>
  importSheet(readSheet(csvOf(rows, csvOpts)), ctx, existing, opts);
const byNo = (res, no) => res.charms.find((c) => c.sheetNo === no);

test('CSV: 引用符・行の中の改行・CRLF・BOM を読む。見出しは「No.」の行', () => {
  assert.deepEqual(parseCsv('a,"b,c","d""e"\r\n"x\ny",z\n'), [['a', 'b,c', 'd"e'], ['x\ny', 'z']]);
  const s = readSheet(csvOf(ROWS.slice(0, 2), { crlf: true, bom: true }));
  assert.equal(s.rows.length, 2);
  assert.equal(s.rows[0].cells['No.'], '88');
  assert.equal(s.rows[0].cells['スキル1'], 'KO術', '見出しは NFKC でそろえる (スキル① → スキル1)');
  assert.equal(s.rows[0].line, 5, 'CSV の何行目か (題の 3 行 + 見出しの次)');
  assert.throws(() => readSheet('a,b\n1,2\n'), /見出し/);
});

test('id はシートの No. から (s088)。名前の揺れ (KO術) は吸収。生成した護石は全部検証を通る', () => {
  const res = run(ROWS);
  assert.equal(sheetIdOf(88), 's088');
  assert.equal(sheetIdOf(1234), 's1234');
  const c = byNo(res, 88);
  assert.equal(c.id, 's088');
  assert.equal(c.name, '秘歴の護石');
  assert.deepEqual(c.skills.map((s) => s.name), ['ＫＯ術', '連撃']);
  assert.equal(c.source, 'シート「所持護石一覧」No.88 (IMG_7657.mp4 #087)');
  assert.equal(c.addedAt, '2026-10-24');
  for (const x of res.charms) assert.equal(validateCharm(x, ctx.rules, ctx.skills, { charmsFixed: ctx.charmsFixed }).ok, true, x.id);
  // 写真で足す護石の連番 (c0002 から) は、シートの "s" の id を数えない
  assert.equal(nextCharmId(res.charms), 'c0002');
});

test('スロットの列が無いとき: 数だけを信じ、抽選表で一番低い Lv の形・未確認の印・シートの値は sheetSlots に', () => {
  const res = run(ROWS);
  const slots = (no) => { const c = byNo(res, no); return [c.armorSlots, c.weaponSlots, c.slotsProvisional, c.sheetSlots]; };
  assert.deepEqual(slots(88), [[1, 0, 0], [0], true, [2]], 'シートの「2」は当てにならないので Lv1 にする');
  assert.deepEqual(slots(177), [[1, 1, 0], [0], true, [2, 2]], '[2,2] は抽選表に無い。穴 2 つの一番低い形');
  assert.deepEqual(slots(201), [[2, 0, 0], [0], true, [1]], 'レア5 の穴 1 つは Lv2 か Lv3 なので Lv2');
  assert.deepEqual(slots(29), [[1, 0, 0], [1], true, [1, 1]], 'レア8 の 2 つ = 武器用 Lv1 + 防具用 Lv1');
  assert.deepEqual(slots(23), [[0, 0, 0], [1], true, [3]], 'レア8 の 1 つ = 武器用 Lv1');
  // 一番低い形は、同じ数のほかの形のどれよりも各段が低いか同じ (いまの抽選表ではいつもそう)
  for (const c of res.charms.filter((x) => x.sheetNo !== 5)) {
    const allowed = allowedSlotPatterns(c, ctx.rules, ctx.skills, ctx.charmsFixed);
    const lp = lowestPattern(allowed, c.sheetSlots.length);
    assert.equal(lp.lowest, true, c.id);
    assert.deepEqual([lp.armor, lp.weapon], [c.armorSlots, c.weaponSlots], c.id);
  }
});

test('取り込まない行: 名前が見つからない・抽選表に無い組・生産する護石と同じ・その数のスロットの形が無い', () => {
  const res = run(ROWS);
  const sk = Object.fromEntries(res.skipped.map((s) => [s.no, s]));
  assert.deepEqual(res.skipped.map((s) => s.no), [17, 75, 247, 255], 'No. の順');
  assert.equal(sk[17].code, 'unknown-name');
  assert.match(sk[17].reason, /騎乗回復量UP/);
  assert.match(sk[17].read, /^RARE8 抜刀術【技】2・騎乗回復量UP3・耳栓1 \/ スロット 1,1,1$/);
  assert.equal(sk[75].code, 'not-in-table');
  assert.equal(sk[247].code, 'fixed-charm');
  assert.match(sk[247].reason, /鎖刃の護石Ⅰ/);
  assert.equal(sk[255].code, 'slot-count');
  for (const no of [17, 75, 247, 255]) assert.equal(byNo(res, no), undefined);
  assert.equal(res.counts.rows, ROWS.length);
  assert.equal(res.counts.skipped, 4);
});

test('c0001 = シートの No.5: id とスロット (写真で確かめた [2,0,0]) を保ち、sheetNo だけ足す。同じ護石の別の行は残す', () => {
  const res = run(ROWS);
  const c = byNo(res, 5);
  assert.equal(c.id, 'c0001');
  assert.deepEqual([c.armorSlots, c.weaponSlots, c.slotsProvisional, c.sheetSlots], [[2, 0, 0], [0], false, [1]]);
  assert.equal(c.source, '写真 2026-10-21');
  assert.equal(c.addedAt, '2026-10-21');
  assert.ok(res.notes.some((n) => n.code === 'linked' && n.id === 'c0001'));
  assert.equal(res.charms.filter((x) => x.id === 'c0001').length, 1);
  // No.55・56 は同じスキルの別の行 (56 は 55 とまったく同じ護石)。どちらも残す
  assert.deepEqual([byNo(res, 55).id, byNo(res, 56).id], ['s055', 's056']);
  assert.deepEqual(byNo(res, 56).armorSlots, byNo(res, 55).armorSlots);
  // c0001 が無いデータに取り込むと、No.5 はシートの護石 (s005) になる
  const fresh = run(ROWS, { schema: 1, charms: [] });
  assert.equal(byNo(fresh, 5).id, 's005');
  // スキルが違う (読み違い) なら c0001 にせず、取り込まない行に出す (c0001 はそのまま残る)
  const wrong = run([row(5, 7, [['ガード性能', 2], ['属性吸収', 1]], [1])]);
  assert.equal(wrong.skipped[0].code, 'link-mismatch');
  assert.ok(wrong.charms.some((x) => x.id === 'c0001' && x.sheetNo === undefined));
});

test('取り込み直し: 同じ中身・入れた日を保つ・シートに無くなった s の護石は消える・シートと関係の無い護石は残す', () => {
  const first = run(ROWS);
  const text1 = charmsJsonText(first.charms);
  const again = run(ROWS, JSON.parse(text1), { date: '2026-11-01' });
  assert.equal(charmsJsonText(again.charms), text1, '2 回目も同じ中身 (入れた日は前のまま)');
  const extra = { ...C0001, id: 'c0002', skills: [{ skillId: 59, name: 'ガード性能', level: 3 }, { skillId: 133, name: '属性吸収', level: 1 }] };
  const less = run(ROWS.filter((r) => !r.startsWith('88,')), { schema: 1, charms: [...JSON.parse(text1).charms, extra] }, { date: '2026-11-01' });
  assert.deepEqual(less.removed, [{ id: 's088', sheetNo: 88 }]);
  assert.ok(less.charms.some((x) => x.id === 'c0002'), '写真で足した護石 (sheetNo なし) は残る');
  assert.equal(less.charms[less.charms.length - 1].id, 'c0002', 'シートの護石 (No. 順) の後ろ');
  // c0001 の行が無くなっても c0001 は消さない (写真の分として残し、sheetNo を外す)
  const noFive = run(ROWS.filter((r) => !r.startsWith('5,')), JSON.parse(text1));
  const c1 = noFive.charms.find((x) => x.id === 'c0001');
  assert.ok(c1 && c1.sheetNo === undefined && c1.sheetSlots === undefined);
  assert.ok(noFive.notes.some((n) => n.code === 'link-row-gone'));
});

test('取り込み直し: 確かめたスロット (slotsProvisional false) と note は前のまま。変わった護石は一覧に前と後を出す', () => {
  const first = JSON.parse(charmsJsonText(run(ROWS).charms));
  // 本人がゲームで No.88 のスロットを確かめ、Claude が data/charms.json を直した (防具用 Lv2 が 1 つ)
  const edit = (patch) => ({ schema: 1, charms: first.charms.map((c) => (c.id === 's088' ? { ...c, ...patch } : c)) });
  const confirmed = edit({ armorSlots: [2, 0, 0], slotsProvisional: false, note: 'ゲームで確かめた' });
  const again = run(ROWS, confirmed, { date: '2026-11-01' });
  const c = byNo(again, 88);
  assert.deepEqual([c.armorSlots, c.weaponSlots, c.slotsProvisional, c.note], [[2, 0, 0], [0], false, 'ゲームで確かめた'],
    '列が無い取り込み直しで、一番低い形 [1,0,0] に戻さない');
  assert.equal(again.counts.keptConfirmed, 1, '前に確かめた値のままにした数');
  assert.match(summaryText(again), /前に確かめたスロットのままにした護石 1 個/);
  assert.ok(!again.notes.some((n) => n.no === 88), 'シートの数 (1 つ) と同じなら行は出さない (確かめた護石が増えても一覧が埋まらない)');
  assert.deepEqual(again.changed, [], '確かめた値のままなので、変わった護石は無い');
  assert.equal(again.counts.added, 0);
  // シートのスロットの数と違うときは行も出す (確かめた値のまま)
  const two = run(ROWS, edit({ armorSlots: [1, 1, 0], slotsProvisional: false }));
  assert.deepEqual([byNo(two, 88).armorSlots, byNo(two, 88).slotsProvisional], [[1, 1, 0], false]);
  assert.ok(two.notes.some((n) => n.no === 88 && n.code === 'kept-confirmed' && /防具用 1-1/.test(n.text) && /1 つで、違います/.test(n.text)));
  assert.equal(charmsJsonText(run(ROWS, JSON.parse(charmsJsonText(again.charms))).charms), charmsJsonText(again.charms), '3 回目も同じ');
  // note は未確認の護石でも保つ (人が書く欄)
  assert.equal(byNo(run(ROWS, edit({ note: 'メモ' })), 88).note, 'メモ');
  // シートのスキルが変わった (読み直した) ら、前の確かめた値は使わない。変わった護石に前と後を出す
  const reread = ROWS.map((r) => (r.startsWith('88,') ? row(88, 7, [['KO術', 2], ['連撃', 1]], [2]) : r));
  const sk = run(reread, confirmed);
  assert.deepEqual([byNo(sk, 88).armorSlots, byNo(sk, 88).slotsProvisional], [[1, 0, 0], true]);
  const ch = sk.changed.find((x) => x.id === 's088');
  assert.deepEqual(ch.fields, ['レア度かスキル', 'スロット', '未確認に戻った']);
  assert.match(ch.before, /ＫＯ術3・連撃1 \/ 防具用 2・武器用 なし$/);
  assert.match(ch.after, /ＫＯ術2・連撃1 \/ 防具用 1・武器用 なし \(スロット未確認\)$/);
  assert.match(summaryText(sk), /前から変わった護石[^]*No\.88 \(s088\)/, '一覧 (標準出力) に出す');
  // 確かめた値が抽選表に無い形 (直し間違い) なら使わず、一番低い形にして一覧に出す
  const bad = run(ROWS, edit({ armorSlots: [3, 3, 3], slotsProvisional: false }));
  assert.deepEqual([byNo(bad, 88).armorSlots, byNo(bad, 88).slotsProvisional], [[1, 0, 0], true]);
  assert.ok(bad.notes.some((n) => n.no === 88 && n.code === 'confirmed-not-in-table'));
  assert.ok(bad.changed.some((x) => x.id === 's088' && x.fields.includes('未確認に戻った')));
  // 初めての取り込みは「新しい護石」に数える (変わった護石には出さない)
  const fresh = run(ROWS);
  assert.equal(fresh.counts.added, fresh.charms.filter((x) => /^s/.test(x.id)).length);
  assert.deepEqual(fresh.changed, []);
});

test('取り込み直し: スロットの列の値は前に確かめた値より先。列が読めないときは前に確かめた値', () => {
  const first = JSON.parse(charmsJsonText(run(ROWS).charms));
  const confirmed = { schema: 1, charms: first.charms.map((c) => (c.id === 's088' ? { ...c, armorSlots: [2, 0, 0], slotsProvisional: false } : c)) };
  const head = [...HEAD.slice(0, 3), `${HEAD[3]},防具スロット,武器スロット`];
  const csv = (a) => `${[...head, `${row(88, 7, [['KO術', 3], ['連撃', 1]], [2])},${a},`].join('\n')}\n`;
  const imp = (a) => importSheet(readSheet(csv(a)), ctx, confirmed, { date: '2026-11-01' });
  // 列の値 (動画で読み直した値) があればそれを使い、前と違えば一覧に出す
  const col = imp('1');
  assert.deepEqual([byNo(col, 88).armorSlots, byNo(col, 88).slotsProvisional], [[1, 0, 0], false]);
  assert.deepEqual(col.changed.find((x) => x.id === 's088').fields, ['スロット']);
  // 列が読めない (?) ・空なら前に確かめた値。読めないときは、そのことを行で出す (一番低い形にしたとは書かない)
  for (const a of ['?', '']) {
    const r = imp(a);
    assert.deepEqual([byNo(r, 88).armorSlots, byNo(r, 88).slotsProvisional], [[2, 0, 0], false], `列が「${a}」`);
    assert.equal(r.counts.keptConfirmed, 1);
    assert.equal(r.notes.some((n) => n.no === 88 && n.code === 'kept-confirmed' && /読めないので、前に確かめた/.test(n.text)), a === '?');
    assert.ok(!r.notes.some((n) => n.no === 88 && /一番低い形にしました/.test(n.text)), '一番低い形にしたとは書かない');
  }
});

test('スロットの列 (防具スロット・武器スロット) があればそちらを使う。読めない・抽選表に無い・空は数から一番低い形', () => {
  assert.deepEqual(parseSlotCell('2-1-0'), [2, 1]);
  assert.deepEqual(parseSlotCell('1'), [1]);
  assert.deepEqual(parseSlotCell(''), []);
  assert.deepEqual(parseSlotCell('なし'), []);
  assert.deepEqual(parseSlotCell('②①'), [2, 1], '丸数字 (NFKC で数字に)');
  assert.deepEqual(parseSlotCell('１・２'), [2, 1], '全角');
  assert.deepEqual(parseSlotCell('21'), [2, 1]);
  assert.equal(parseSlotCell('?'), null);
  assert.equal(parseSlotCell('4'), null);
  assert.equal(parseSlotCell('1-1-1-1'), null);
  const head = [...HEAD.slice(0, 3), `${HEAD[3]},防具スロット,武器スロット`];
  const r2 = (base, a, w) => `${base},${a},${w}`;
  const text = `${[...head,
    r2(row(148, 6, [['ガード強化', 2], ['スタミナ急速回復', 1], ['龍耐性', 2]], [2, 1]), '2-1-0', ''),
    r2(row(29, 8, [['KO術', 2], ['見切り', 1], ['攻勢', 1]], [1, 1]), '1', '1'),
    r2(row(23, 8, [['業物', 3], ['威嚇', 3]], [3]), '', '1'),
    r2(row(88, 7, [['KO術', 3], ['連撃', 1]], [2]), '2-2', ''),
    r2(row(71, 7, [['ガード強化', 3], ['ボマー', 3]], [2, 2]), '', ''),
    r2(row(177, 5, [['KO術', 1], ['耳栓', 1], ['広域化', 3]], [2, 2]), '?', ''),
  ].join('\n')}\n`;
  const res = importSheet(readSheet(text), ctx, { schema: 1, charms: [] }, { date: '2026-10-24' });
  const s = (no) => { const c = byNo(res, no); return [c.armorSlots, c.weaponSlots, c.slotsProvisional]; };
  assert.deepEqual(s(148), [[2, 1, 0], [0], false]);
  assert.deepEqual(s(29), [[1, 0, 0], [1], false]);
  assert.deepEqual(s(23), [[0, 0, 0], [1], false], 'レア8 の防具用が空 = 防具用の穴なし');
  assert.deepEqual(s(88), [[1, 0, 0], [0], true], '[2,2] は抽選表に無い → 数 (1) から一番低い形');
  assert.deepEqual(s(71), [[1, 1, 0], [0], true], '両方とも空は読めていない (鑑定護石は必ず穴がある)');
  assert.deepEqual(s(177), [[1, 1, 0], [0], true]);
  const codes = Object.fromEntries(res.notes.map((n) => [n.no, n.code]));
  assert.equal(codes[88], 'slot-columns-invalid');
  assert.equal(codes[177], 'slot-columns-unreadable');
});

test('コマンド: --out に書き、--report に取り込まない行の JSON を出す。data/charms.json の形 (2 回読んでも同じ)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhwilds-import-'));
  try {
    const csv = path.join(dir, 'sheet.csv');
    const out = path.join(dir, 'charms.json');
    const rep = path.join(dir, 'report.json');
    fs.writeFileSync(csv, csvOf(ROWS));
    fs.writeFileSync(out, charmsJsonText([C0001]));
    const tool = fileURLToPath(new URL('../tools/import_charms.mjs', import.meta.url));
    const p = spawnSync(process.execPath, [tool, csv, '--out', out, '--report', rep, '--date', '2026-10-24'], { encoding: 'utf8' });
    assert.equal(p.status, 0, p.stderr);
    assert.match(p.stdout, /取り込み 8 個/);
    assert.match(p.stdout, /No\.17 .*騎乗回復量UP/);
    const written = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(written.schema, 1);
    assert.equal(written.charms.length, 8);
    assert.ok(!fs.readFileSync(out, 'utf8').includes('\r'), '改行は LF');
    const report = JSON.parse(fs.readFileSync(rep, 'utf8'));
    assert.deepEqual(report.skipped.map((s) => s.no), [17, 75, 247, 255]);
    assert.equal(report.counts.imported, 8);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('data/charms.json: シートの護石は s + No.、c0001 は No.5、全部検証を通り、未確認の印と sheetSlots を持つ', () => {
  const data = readJson('data/charms.json');
  const ids = new Set();
  for (const c of data.charms) {
    assert.ok(!ids.has(c.id), `id ${c.id} が重なる`);
    ids.add(c.id);
    assert.equal(validateCharm(c, ctx.rules, ctx.skills, { charmsFixed: ctx.charmsFixed }).ok, true, c.id);
    if (c.sheetNo == null) continue;
    assert.equal(typeof c.slotsProvisional, 'boolean', c.id);
    assert.ok(Array.isArray(c.sheetSlots), c.id);
    if (c.id !== 'c0001') assert.equal(c.id, sheetIdOf(c.sheetNo));
  }
  const c1 = data.charms.find((c) => c.id === 'c0001');
  assert.equal(c1.sheetNo, 5);
  assert.deepEqual(c1.armorSlots, [2, 0, 0]);
  assert.equal(c1.slotsProvisional, false);
});
