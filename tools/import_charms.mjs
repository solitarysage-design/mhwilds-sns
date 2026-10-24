// 所持護石の一覧 (Google スプレッドシート「所持護石一覧」を CSV に書き出したもの) を data/charms.json に取り込む。
//
//   node tools/import_charms.mjs <シートの CSV> [--out data/charms.json] [--report 一覧.json] [--date 2026-10-24] [--dry-run]
//
// 決まり (docs/ARCHITECTURE.md の data/charms.json の節。2026-10-24 本人の決定):
// - 見出しは「No.」で始まる行 (その前の行は表の題などなので読まない)。列は見出しの名前で探す
//   (No. / RARE / スキル①〜③ / Lv①〜③ / スロット①〜③。任意で 防具スロット / 武器スロット)。評価の列 (片手剣 など) は使わない。
// - id はシートの No. から決める (No.88 → "s088")。取り込み直しても同じ護石は同じ id になる (ブラウザに保存した装備が護石の id を持つため)。
//   シートの行が、前からある護石 (写真で取り込んだ c0001 など) と同じ護石なら、その id を保つ (LINKS の表と、data/charms.json で
//   sheetNo を持つ "s" 以外の id の護石)。その護石のスロットは写真で確かめた値を正とし、シートの値で上書きしない。
// - スロットの読み方:
//   - 「防具スロット」「武器スロット」の列があり、その行に値があれば、それを使う (slotsProvisional: false)。書き方は
//     "2-1-0" / "2,1" / "2・1" / "21" / "①②" (どれも Lv の並び。0 は穴なし) / "1" / 空 (= その種類の穴なし) / "なし"。
//     「?」など読めない値・両方とも空 (鑑定護石は必ず穴が 1 つ以上ある) は「読めていない」として下の読み方にする。
//     抽選表に無い形だったときも下の読み方にして、一覧に出す (スキルは合っているので、護石ごと落とさない)。
//   - 列が無い・読めていないとき: シートのスロット①〜③は「数」だけを信じ (Lv は動画の読み取りで当てにならない。剣・兜の印を
//     「2」と読んでいた)、そのレア度とスキルで抽選表が許す形のうち、その数で一番低い Lv の形にする (出した装備が必ずゲームで
//     組めるように。いまの抽選表では、同じ数の形の中で一番低い形はほかのどの形よりも各段が低いか同じ)。slotsProvisional: true。
//     RARE 8 は武器用 Lv1 が必ず 1 つ付くので、1 つ目が武器用 Lv1、残りが防具用 Lv1 になる (抽選表どおり)。
// - 取り込まない行 (標準出力と --report に No.・読み取り・理由を出す): スキルの名前が見つからない・スキルの組み合わせが抽選表に無い・
//   生産する護石 (charms_fixed.json) と同じ (探索は生産する護石を全部入れるので、足すと 2 回出る)・その数のスロットの形が無い・
//   No. や Lv が読めない・No. が重なる。
// - 同じ護石 (同じ RARE・スキル・スロット) が 2 行あってもどちらも残す (別の個体のことがある。探索では同じ類になるだけ)。
// - 検証は app/model/charms.js (findSkillByName / validateCharm / normalizeSlots)。出す護石は全部 validateCharm を通ることを確かめてから書く。
// - シートに無くなった "s" の護石は消える (一覧に出す)。シートと関係の無い護石 (sheetNo の無いもの) はそのまま残す。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findSkillByName, validateCharm, normalizeSlots } from '../app/model/charms.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** シートの行と、前からある護石が同じもの (2026-10-24 本人の確認: No.5 = c0001。動画でも六角形の印 = Lv2 以上が 1 つ) */
export const LINKS = { 5: 'c0001' };

/** シートの名前 (source に入れる) */
export const SHEET_NAME = '所持護石一覧';

// ---------------------------------------------------------------- CSV

/** CSV の文字列 → 行の配列 (引用符・行の中の改行・CRLF・BOM に対応) */
export function parseCsv(text) {
  const src = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let f = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"' && src[i + 1] === '"') { f += '"'; i++; } else if (ch === '"') q = false; else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; }
    else f += ch;
  }
  if (f || row.length) { row.push(f.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

const nfkc = (s) => String(s ?? '').normalize('NFKC').trim();

/** 列の名前 (見出しは NFKC でそろえて比べる。「スキル①」は「スキル1」になる) */
const COL = {
  no: 'No.', rare: 'RARE',
  skill: ['スキル①', 'スキル②', 'スキル③'].map(nfkc), lv: ['Lv①', 'Lv②', 'Lv③'].map(nfkc),
  slot: ['スロット①', 'スロット②', 'スロット③'].map(nfkc),
  armorSlots: nfkc('防具スロット'), weaponSlots: nfkc('武器スロット'), src: nfkc('元画像・動画'),
};

/**
 * CSV → {header, rows: [{line (CSV の何行目), cells: {列名: 値}}]}。見出しは 1 列目が「No.」の行。
 * 見出しより後の、全部空の行は飛ばす。
 */
export function readSheet(text) {
  const all = parseCsv(text);
  const hi = all.findIndex((r) => /^No\.?$/i.test(nfkc(r[0])));
  if (hi < 0) throw new Error('見出しの行 (1 列目が「No.」) が見つかりません');
  const header = all[hi].map((h) => nfkc(h));
  for (const need of [COL.no, COL.rare, COL.skill[0], COL.lv[0]]) {
    if (!header.includes(need)) throw new Error(`見出しに「${need}」の列がありません (${header.join(',')})`);
  }
  const rows = [];
  for (let i = hi + 1; i < all.length; i++) {
    const r = all[i];
    if (!r.some((x) => String(x).trim())) continue;
    rows.push({ line: i + 1, cells: Object.fromEntries(header.map((h, j) => [h, String(r[j] ?? '').trim()])) });
  }
  return { header, rows };
}

// ---------------------------------------------------------------- スロット

/**
 * 「防具スロット」「武器スロット」の 1 つのセル → Lv の配列 (大きい順。穴なしは [])、読めなければ null。
 * 書き方: "2-1-0" / "2,1" / "2・1" / "2 1" / "21" / "①②" / "1" / 空 / "なし" / "-"。
 */
export function parseSlotCell(text) {
  const s = nfkc(text).replace(/\s+/g, ' ');
  if (s === '' || /^(なし|無し|無|-|ー|—|0)$/.test(s)) return [];
  if (!/^[0-3](?:[\s\-,、・/]*[0-3])*$/.test(s)) return null;
  const vals = s.replace(/[^0-3]/g, '').split('').map(Number);
  if (vals.length > 3) return null;
  return vals.filter((v) => v > 0).sort((a, b) => b - a);
}

/** シートのスロット①〜③ → 数の配列 (空欄は除く。数でないものは null のまま) */
function sheetSlotsOf(cells) {
  return COL.slot.map((k) => nfkc(cells[k])).filter((v) => v !== '')
    .map((v) => (/^\d+$/.test(v) ? Number(v) : v));
}

/** 防具用/武器用の各段について、a の「Lv t 以上の数」が b 以下か (a の穴に入る珠は、必ず b にも入る) */
function slotsLe(a, b) {
  for (let t = 1; t <= 3; t++) {
    const na = a.filter((x) => x >= t).length;
    const nb = b.filter((x) => x >= t).length;
    if (na > nb) return false;
  }
  return true;
}

const countOf = (p) => p.armor.filter((v) => v > 0).length + p.weapon.filter((v) => v > 0).length;
const sumOf = (p) => [...p.armor, ...p.weapon].reduce((a, v) => a + v, 0);
const slotText = (armor, weapon) => {
  const a = armor.filter((v) => v > 0);
  const w = weapon.filter((v) => v > 0);
  return `防具用 ${a.length ? a.join('-') : 'なし'}・武器用 ${w.length ? w.join('-') : 'なし'}`;
};

/** そのレア度・スキルで抽選表が許すスロットの形 [{armor, weapon}] (validateCharm で 1 つずつ確かめる) */
export function allowedSlotPatterns(base, rules, skills, charmsFixed) {
  const rr = rules.rarities[String(base.rarity)];
  if (!rr) return [];
  const out = [];
  const seen = new Set();
  for (const p of rr.slotPatterns) {
    const armor = normalizeSlots(p.armor, 3);
    const weapon = normalizeSlots(p.weapon, 1);
    const key = `${armor}|${weapon}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const v = validateCharm({ ...base, armorSlots: armor, weaponSlots: weapon }, rules, skills, { charmsFixed });
    if (v.ok) out.push({ armor, weapon, warnings: v.warnings });
  }
  return out;
}

/**
 * 数だけを信じたときの形: 穴の数が n の形のうち、Lv の合計が一番小さいもの (同じなら防具用の並びの小さい方)。
 * → {armor, weapon, lowest: ほかの同じ数の形のどれよりも各段が低いか同じか} | null (その数の形が無い)
 */
export function lowestPattern(allowed, n) {
  const same = allowed.filter((p) => countOf(p) === n);
  if (!same.length) return null;
  same.sort((a, b) => sumOf(a) - sumOf(b) || a.armor.join().localeCompare(b.armor.join()));
  const best = same[0];
  const lowest = same.every((p) => slotsLe(best.armor, p.armor) && slotsLe(best.weapon, p.weapon));
  return { ...best, lowest };
}

// ---------------------------------------------------------------- 取り込み

const sigOf = (c) => `${c.rarity}|${(c.skills || []).map((s) => `${s.skillId}:${s.level}`).sort().join('+')}`;
const padNo = (n) => String(n).padStart(3, '0');
/** シートの No. → id ("s088") */
export const sheetIdOf = (no) => `s${padNo(no)}`;

/**
 * シートの行を護石にする (ファイルは読み書きしない)。
 * @param sheet readSheet の結果
 * @param ctx {skills: skills.json, rules: talisman_rules.json, charmsFixed: charms_fixed.json}
 * @param existing いまの data/charms.json ({charms: [...]})
 * @param opts {date: 新しく足す護石の addedAt, links: {No.: 前からある id} (既定 LINKS)}
 * @returns {{charms, skipped: [{no, line, read, code, reason}], notes: [{no, id, code, text}], removed: [{id, sheetNo}], counts}}
 */
export function importSheet(sheet, ctx, existing, opts = {}) {
  const { skills, rules, charmsFixed } = ctx;
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const links = { ...LINKS, ...(opts.links || {}) };
  const prev = Array.isArray(existing && existing.charms) ? existing.charms : [];
  const prevById = new Map(prev.map((c) => [c.id, c]));
  // 前からある護石のうち、シートの行と結び付いたもの (No. → 護石)。"s" の id はシートから作り直すので入れない
  const linkedByNo = new Map();
  for (const c of prev) if (c.sheetNo != null && !/^s\d+$/.test(c.id)) linkedByNo.set(Number(c.sheetNo), c);
  for (const [no, id] of Object.entries(links)) {
    const c = prevById.get(id);
    if (c && !linkedByNo.has(Number(no))) linkedByNo.set(Number(no), c);
  }
  const hasSlotCols = sheet.header.includes(COL.armorSlots) || sheet.header.includes(COL.weaponSlots);

  const skipped = [];
  const notes = [];
  const out = [];
  const seenNo = new Set();
  for (const { line, cells } of sheet.rows) {
    const noText = nfkc(cells[COL.no]);
    const no = /^\d+$/.test(noText) ? Number(noText) : null;
    const rareText = nfkc(cells[COL.rare]);
    const rarity = /^\d+$/.test(rareText) ? Number(rareText) : null;
    const rawSkills = COL.skill.map((a, i) => ({ name: String(cells[a] ?? '').trim(), lvText: nfkc(cells[COL.lv[i]]) }))
      .filter((s) => s.name);
    const sheetSlots = sheetSlotsOf(cells);
    const armorCell = String(cells[COL.armorSlots] ?? '').trim();
    const weaponCell = String(cells[COL.weaponSlots] ?? '').trim();
    const read = `RARE${rarity ?? rareText} ${rawSkills.map((s) => `${s.name}${s.lvText}`).join('・') || 'スキルなし'}`
      + ` / スロット ${sheetSlots.length ? sheetSlots.join(',') : 'なし'}`
      + (hasSlotCols ? ` / 防具スロット ${armorCell || '空'}・武器スロット ${weaponCell || '空'}` : '');
    const skip = (code, reason) => skipped.push({ no, line, read, code, reason });
    if (no == null) { skip('no-invalid', `No. が読めません (${noText || '空'})`); continue; }
    if (seenNo.has(no)) { skip('no-duplicate', `No.${no} が 2 回あります (後の行は取り込みません)`); continue; }
    seenNo.add(no);
    if (rarity == null) { skip('rarity-invalid', `RARE が読めません (${rareText || '空'})`); continue; }
    // スキルの名前と Lv
    const sk = [];
    const unknown = [];
    let badLv = null;
    for (const s of rawSkills) {
      const def = findSkillByName(s.name, skills);
      const lv = /^\d+$/.test(s.lvText) ? Number(s.lvText) : null;
      if (!def) unknown.push(s.name);
      else if (lv == null || lv < 1) badLv = `${s.name} の Lv が読めません (${s.lvText || '空'})`;
      else sk.push({ skillId: def.id, name: def.name, level: lv });
    }
    if (unknown.length) { skip('unknown-name', `スキル「${unknown.join('」「')}」が見つかりません`); continue; }
    if (badLv) { skip('level-invalid', badLv); continue; }
    if (!sk.length) { skip('no-skills', 'スキルがありません'); continue; }
    const base = { name: rules.rarities[String(rarity)]?.name ?? null, rarity, skills: sk };
    // 生産する護石と同じ (スキルと Lv とレア度が同じ)
    const fixed = (charmsFixed.charms || []).find((c) => c.rarity === rarity && sigOf(c) === sigOf(base));
    if (fixed) { skip('fixed-charm', `生産する護石「${fixed.name}」と同じです (探索は生産する護石を全部使うので足しません)`); continue; }
    if (!rules.rarities[String(rarity)]) {
      skip('rarity-unknown', `RARE ${rarity} の鑑定する護石は抽選表にありません (あるのは ${Object.keys(rules.rarities).join('・')})`);
      continue;
    }
    const allowed = allowedSlotPatterns(base, rules, skills, charmsFixed);
    if (!allowed.length) {
      const v = validateCharm({ ...base, armorSlots: rules.rarities[String(rarity)].slotPatterns[0].armor,
        weaponSlots: rules.rarities[String(rarity)].slotPatterns[0].weapon }, rules, skills, { charmsFixed });
      const msg = v.errors.find((e) => !['slots-not-possible', 'slots-skill-combination', 'combination-not-in-table'].includes(e.code));
      skip('not-in-table', `このスキルと Lv の組み合わせは、RARE ${rarity} の抽選表にありません${msg ? ` (${msg.message})` : ''}`);
      continue;
    }
    // 前からある護石と結び付いた行: その護石を保つ (id・スロット・出どころ)。sheetNo とシートのスロットだけ足す
    const linked = linkedByNo.get(no);
    if (linked) {
      if (sigOf(linked) !== sigOf(base)) {
        skip('link-mismatch', `前からある護石 ${linked.id} と同じはずですが、レア度かスキルが違います (取り込みません。表を確かめてください)`);
        continue;
      }
      out.push({ ...linked, sheetNo: no, slotsProvisional: linked.slotsProvisional === true, sheetSlots });
      notes.push({ no, id: linked.id, code: 'linked', text: `前からある護石 ${linked.id} として扱いました (スロットは ${slotText(linked.armorSlots, linked.weaponSlots)} のまま)` });
      continue;
    }
    // スロット
    let chosen = null;
    let provisional = true;
    if (hasSlotCols) {
      const a = parseSlotCell(armorCell);
      const w = parseSlotCell(weaponCell);
      const blank = !nfkc(armorCell) && !nfkc(weaponCell);
      if (a && w && !blank) {
        const armor = normalizeSlots(a, 3);
        const weapon = normalizeSlots(w, 1);
        const hit = armor.length === 3 && weapon.length === 1
          && allowed.find((p) => p.armor.join() === armor.join() && p.weapon.join() === weapon.join());
        if (hit) { chosen = hit; provisional = false; }
        else notes.push({ no, id: sheetIdOf(no), code: 'slot-columns-invalid',
          text: `防具スロット「${armorCell}」・武器スロット「${weaponCell}」は抽選表に無い形なので、スロットの数から一番低い形にしました` });
      } else if (!blank) {
        notes.push({ no, id: sheetIdOf(no), code: 'slot-columns-unreadable',
          text: `防具スロット「${armorCell}」・武器スロット「${weaponCell}」が読めないので、スロットの数から一番低い形にしました` });
      }
    }
    if (!chosen) {
      const n = sheetSlots.length;
      if (sheetSlots.some((v) => typeof v !== 'number' || v < 0 || v > 3)) {
        skip('slot-invalid', `スロット①〜③に 0〜3 の数でない値があります (${sheetSlots.join(',')})`);
        continue;
      }
      const lp = lowestPattern(allowed, n);
      if (!lp) {
        const counts = [...new Set(allowed.map(countOf))].sort((x, y) => x - y);
        skip('slot-count', `スロット ${n} つの形は、このレア度とスキルでは出ません (出るのは ${counts.join('・')} つ)`);
        continue;
      }
      if (!lp.lowest) notes.push({ no, id: sheetIdOf(no), code: 'slot-not-lowest', text: '一番低い形がほかの形より低いとは限りません (抽選表を確かめてください)' });
      chosen = lp;
    }
    const v = validateCharm({ ...base, armorSlots: chosen.armor, weaponSlots: chosen.weapon }, rules, skills, { charmsFixed });
    if (!v.ok) throw new Error(`No.${no}: 選んだスロットで検証に通りません (${v.errors.map((e) => e.message).join(' / ')})`);
    for (const wn of v.warnings) {
      const text = wn.code === 'not-exact'
        ? `スキルの Lv が抽選表の Lv より低くなっています (読み違いかもしれません。${sk.map((s) => `${s.name}${s.level}`).join('・')})`
        : wn.message;
      notes.push({ no, id: sheetIdOf(no), code: wn.code, text });
    }
    const id = sheetIdOf(no);
    const old = prevById.get(id);
    const src = nfkc(cells[COL.src]);
    out.push({
      id, name: base.name, rarity, skills: sk, armorSlots: chosen.armor, weaponSlots: chosen.weapon,
      sheetNo: no, slotsProvisional: provisional, sheetSlots,
      source: `シート「${SHEET_NAME}」No.${no}${src ? ` (${src})` : ''}`,
      addedAt: old && old.addedAt ? old.addedAt : date,
      note: '',
    });
  }

  // シートと関係の無い前からある護石 (sheetNo が無いもの。写真で足した分など) は残す。"s" でシートに無くなったものは消える
  const outIds = new Set(out.map((c) => c.id));
  const removed = [];
  const keep = [];
  for (const c of prev) {
    if (outIds.has(c.id)) continue;
    if (/^s\d+$/.test(c.id)) removed.push({ id: c.id, sheetNo: c.sheetNo ?? null });
    else if (c.sheetNo != null && !seenNo.has(Number(c.sheetNo))) {
      // 前からある護石で、結び付いたシートの行が無くなった: 護石は残し、結び付きだけ外す
      const { sheetNo, sheetSlots, ...rest } = c;
      keep.push(rest);
      notes.push({ no: Number(c.sheetNo), id: c.id, code: 'link-row-gone', text: `シートに No.${c.sheetNo} の行が無いので、${c.id} は写真の分として残しました` });
    } else if (c.sheetNo != null) {
      // 結び付いた行が取り込めなかった (link-mismatch など): 護石はそのまま残す
      keep.push(c);
    } else keep.push(c);
  }
  out.sort((a, b) => a.sheetNo - b.sheetNo);
  const byNo = (a, b) => (a.no ?? Infinity) - (b.no ?? Infinity);
  skipped.sort(byNo);
  notes.sort(byNo);
  const charms = [...out, ...keep];
  // 全部の検証 (出す護石は全部通る)
  for (const c of charms) {
    const v = validateCharm(c, rules, skills, { charmsFixed });
    if (!v.ok) throw new Error(`${c.id}: 検証に通りません (${v.errors.map((e) => e.message).join(' / ')})`);
  }
  const ids = new Set();
  for (const c of charms) {
    if (ids.has(c.id)) throw new Error(`id ${c.id} が 2 つあります`);
    ids.add(c.id);
  }
  return {
    charms, skipped, notes, removed,
    counts: {
      rows: sheet.rows.length, imported: out.length, provisional: out.filter((c) => c.slotsProvisional).length,
      skipped: skipped.length, kept: keep.length, removed: removed.length, total: charms.length,
    },
  };
}

// ---------------------------------------------------------------- 書き出し

/** data/charms.json の書き方 (1 個ずつ。スキルは 1 行に 1 つ。今までのファイルと同じ形) */
export function charmsJsonText(charms) {
  const q = (v) => JSON.stringify(v);
  const KEYS = ['id', 'name', 'rarity', 'skills', 'armorSlots', 'weaponSlots', 'sheetNo', 'slotsProvisional', 'sheetSlots',
    'source', 'addedAt', 'note'];
  const body = charms.map((c) => {
    const keys = [...KEYS.filter((k) => k in c), ...Object.keys(c).filter((k) => !KEYS.includes(k))];
    const lines = keys.map((k) => {
      const v = c[k];
      if (k === 'skills') {
        return `   "skills": [\n${v.map((s) => `    {"skillId": ${q(s.skillId)}, "name": ${q(s.name)}, "level": ${q(s.level)}}`).join(',\n')}\n   ]`;
      }
      if (Array.isArray(v)) return `   ${q(k)}: [${v.map(q).join(', ')}]`;
      return `   ${q(k)}: ${q(v)}`;
    });
    return `  {\n${lines.join(',\n')}\n  }`;
  });
  return `{\n "schema": 1,\n "charms": [\n${body.join(',\n')}\n ]\n}\n`;
}

/** 取り込みの結果を、本人に見せる一覧 (文字) にする */
export function summaryText(res) {
  const L = [];
  const c = res.counts;
  L.push(`シート ${c.rows} 行 → 取り込み ${c.imported} 個 (うちスロット未確認 ${c.provisional} 個)・取り込まない ${c.skipped} 行`);
  L.push(`data/charms.json は全部で ${c.total} 個 (シートと関係の無い護石 ${c.kept} 個を含む)`);
  if (res.skipped.length) {
    L.push('', '取り込まない行:');
    for (const s of res.skipped) L.push(`  No.${s.no ?? '?'}  ${s.read}\n      → ${s.reason}`);
  }
  if (res.notes.length) {
    L.push('', '確かめてほしいこと (取り込んだ行):');
    for (const n of res.notes) L.push(`  No.${n.no} (${n.id})  ${n.text}`);
  }
  if (res.removed.length) {
    L.push('', 'シートに無くなったので消した護石:');
    for (const r of res.removed) L.push(`  ${r.id} (No.${r.sheetNo ?? '?'})`);
  }
  return L.join('\n');
}

// ---------------------------------------------------------------- コマンド

function parseArgs(argv) {
  const o = { csv: null, out: path.join(ROOT, 'data', 'charms.json'), report: null, date: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i];
    else if (a === '--report') o.report = argv[++i];
    else if (a === '--date') o.date = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else if (!o.csv) o.csv = a;
    else throw new Error(`知らない引数: ${a}`);
  }
  if (!o.csv) throw new Error('使い方: node tools/import_charms.mjs <シートの CSV> [--out data/charms.json] [--report 一覧.json] [--date YYYY-MM-DD] [--dry-run]');
  return o;
}

export function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', rel), 'utf8'));
  const ctx = { skills: readJson('skills.json'), rules: readJson('talisman_rules.json'), charmsFixed: readJson('charms_fixed.json') };
  const existing = fs.existsSync(o.out) ? JSON.parse(fs.readFileSync(o.out, 'utf8')) : { schema: 1, charms: [] };
  const sheet = readSheet(fs.readFileSync(o.csv, 'utf8'));
  const res = importSheet(sheet, ctx, existing, { date: o.date || undefined });
  if (!o.dryRun) fs.writeFileSync(o.out, charmsJsonText(res.charms));
  if (o.report) {
    fs.writeFileSync(o.report, `${JSON.stringify({ csv: path.basename(o.csv), counts: res.counts, skipped: res.skipped, notes: res.notes, removed: res.removed }, null, 1)}\n`);
  }
  process.stdout.write(`${summaryText(res)}\n${o.dryRun ? '(--dry-run なので書いていません)\n' : `${path.relative(process.cwd(), o.out)} に書きました\n`}`);
  return res;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`${e.message || e}\n`);
    process.exit(1);
  }
}
