import path from 'path';
import fs from 'fs';
import xlsx from 'xlsx';

function safeText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function parseBaseDateFromFilename(filename) {
  // Supports filenames like "260112 ...xlsx" => 2026-01-12
  const base = path.basename(filename);
  const m = base.match(/(^|\D)(\d{6})(\D|$)/);
  if (!m) return null;
  const y = 2000 + Number(m[2].slice(0, 2));
  const mo = Number(m[2].slice(2, 4));
  const d = Number(m[2].slice(4, 6));
  if (!y || !mo || !d) return null;
  return { y, mo, d };
}

function toISODate(y, m, d) {
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

function normalizeDateCell(cell, baseYearGuess) {
  if (cell instanceof Date && !Number.isNaN(cell.getTime())) {
    const y = cell.getFullYear();
    const m = cell.getMonth() + 1;
    const d = cell.getDate();
    return toISODate(y, m, d);
  }
  // Sometimes dates come as numbers even with cellDates
  if (typeof cell === 'number' && Number.isFinite(cell)) {
    const dc = xlsx.SSF.parse_date_code(cell);
    if (dc && dc.y && dc.m && dc.d) {
      return toISODate(dc.y, dc.m, dc.d);
    }
  }
  const s = safeText(cell).trim();
  if (!s) return null;
  // "1/12\n(월)" or "1/12 (월)" or "1/12"
  const md = s.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
  if (md) {
    const m = Number(md[1]);
    const d = Number(md[2]);
    const y = baseYearGuess ?? new Date().getFullYear();
    return toISODate(y, m, d);
  }
  // "2026-01-12" etc
  const iso = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    return toISODate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }
  return null;
}

function splitMenuItems(text) {
  const t = safeText(text)
    .replace(/\r/g, '')
    .replace(/\u00A0/g, ' ')
    .trim();
  if (!t) return [];
  // Split by newline and also by consecutive spaces around bullets.
  const parts = t.split(/\n+/).map(p => p.trim()).filter(Boolean);
  // Filter out obvious headers
  return parts.filter(p => !/^\s*(조식|중식|석식|야식|샐러드|A\s*코너|B\s*코너)\s*$/i.test(p));
}

function detectHeaderColumns(rows) {
  // Try to detect which columns correspond to meals by scanning early rows.
  const keywords = {
    breakfast: ['조식'],
    lunch: ['중식'],
    dinner: ['석식'],
    night: ['야식'],
    salad: ['샐러드'],
    corner: ['코너']
  };
  const found = { breakfast: new Set(), lunch: new Set(), dinner: new Set(), night: new Set(), salad: new Set(), corner: new Set() };

  const scanLimit = Math.min(rows.length, 35);
  for (let r = 0; r < scanLimit; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      const s = safeText(row[c]).replace(/\s+/g, ' ').trim();
      if (!s) continue;
      for (const [k, arr] of Object.entries(keywords)) {
        if (arr.some(kw => s.includes(kw))) found[k].add(c);
      }
    }
  }

  const pick = (set) => Array.from(set).sort((a, b) => a - b);
  return {
    breakfast: pick(found.breakfast),
    lunch: pick(found.lunch),
    dinner: pick(found.dinner),
    night: pick(found.night),
    salad: pick(found.salad)
  };
}

function defaultColumnsForSite(site) {
  // Fallback for the sample files you shared.
  if (site === 'main') {
    return {
      breakfast: [1],
      lunch: [3, 4],
      dinner: [5, 6],
      extras: { night: [7, 8] }
    };
  }
  // cancer
  return {
    breakfast: [1, 2],
    lunch: [3, 4],
    dinner: [5, 6],
    extras: { salad: [7], night: [8] }
  };
}

function mondayOf(dateISO) {
  const d = new Date(dateISO + 'T00:00:00');
  const day = d.getDay(); // 0=Sun
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  return toISODate(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

export function parseMealExcel(filePath, originalFilename, site) {
  const wb = xlsx.readFile(filePath, { cellDates: true });
  const sheetName = wb.SheetNames.includes('게시메뉴') ? '게시메뉴' : wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, blankrows: false });

  const base = parseBaseDateFromFilename(originalFilename);
  const baseYearGuess = base?.y;

  // Build column mapping
  const detected = detectHeaderColumns(rows);
  const fallback = defaultColumnsForSite(site);

  const mealCols = {
    breakfast: detected.breakfast.length ? detected.breakfast : fallback.breakfast,
    lunch: detected.lunch.length ? detected.lunch : fallback.lunch,
    dinner: detected.dinner.length ? detected.dinner : fallback.dinner,
    extras: {}
  };

  // Extras are optional; keep fallback extras (hard to reliably detect)
  if (fallback.extras) mealCols.extras = fallback.extras;

  const days = {}; // dateISO -> {breakfast:[], lunch:[], dinner:[], extras:{...}}

  let currentDate = null;
  let allDates = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || [];
    const dateISO = normalizeDateCell(row[0], baseYearGuess);
    if (dateISO) {
      currentDate = dateISO;
      allDates.push(dateISO);
      if (!days[currentDate]) {
        days[currentDate] = { breakfast: [], lunch: [], dinner: [], extras: {} };
      }
      continue;
    }
    if (!currentDate) continue;

    const addTo = (key, cols) => {
      const bucket = key === 'extras' ? null : days[currentDate][key];
      for (const c of cols) {
        const items = splitMenuItems(row[c]);
        if (!items.length) continue;
        if (key === 'extras') {
          // handled elsewhere
        } else {
          bucket.push(...items);
        }
      }
    };

    addTo('breakfast', mealCols.breakfast);
    addTo('lunch', mealCols.lunch);
    addTo('dinner', mealCols.dinner);

    // extras
    for (const [ek, cols] of Object.entries(mealCols.extras || {})) {
      for (const c of cols) {
        const items = splitMenuItems(row[c]);
        if (!items.length) continue;
        if (!days[currentDate].extras[ek]) days[currentDate].extras[ek] = [];
        days[currentDate].extras[ek].push(...items);
      }
    }
  }

  // Dedupe while preserving order
  const dedupe = (arr) => {
    const seen = new Set();
    const out = [];
    for (const x of arr) {
      const k = x.trim();
      if (!k) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
    return out;
  };

  for (const d of Object.keys(days)) {
    days[d].breakfast = dedupe(days[d].breakfast);
    days[d].lunch = dedupe(days[d].lunch);
    days[d].dinner = dedupe(days[d].dinner);
    const ex = days[d].extras || {};
    for (const k of Object.keys(ex)) ex[k] = dedupe(ex[k]);
    // Remove empty extras
    for (const k of Object.keys(ex)) if (!ex[k].length) delete ex[k];
    if (Object.keys(ex).length === 0) delete days[d].extras;
  }

  // Determine weekStart
  const uniqueDates = Array.from(new Set(allDates)).sort();
  const weekStart = uniqueDates.length ? mondayOf(uniqueDates[0]) : null;

  return {
    site,
    source: {
      filename: originalFilename,
      sheet: sheetName
    },
    weekStart,
    days
  };
}

