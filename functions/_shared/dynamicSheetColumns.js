/**
 * dynamicSheetColumns.js  (SERVER-ONLY)
 *
 * Generic helper for reading Google Sheets that are hand-maintained by
 * non-engineering teams (ops/CS), where the column ORDER can't be trusted
 * to stay fixed across tabs or over time. Locates fields by matching
 * header TEXT ("this column is called Max Bonus") instead of a hardcoded
 * column index ("Max Bonus is always column G") — the same way a human
 * reads an unfamiliar sheet.
 *
 * Background / full write-up of every failure mode this fixes (missing
 * columns shifting everything after them, vertically-merged cells,
 * section-title rows instead of a real header, header rows repeated
 * mid-data, inserted columns, truncated read ranges): see
 * PROMO_CODE_LOGIC_NOTES.md. First consumer: functions/api/promo-search.js
 * (11 hand-maintained team tabs, one workbook).
 *
 * Only use this for sheets edited by hand by people other than us. If a
 * sheet's schema is entirely owned by our own code (e.g. the Apps Script
 * logger writes it, nothing else touches it), a hardcoded column index is
 * simpler and there's nothing here to buy you.
 *
 * ---------------------------------------------------------------------
 * Usage:
 *
 *   const mapper = createColumnMapper({
 *     fields: [
 *       // [fieldName, loose regex used to FIND the header,
 *       //  optional strict regex used to detect a REPEATED header row
 *       //  mixed into the data — defaults to the loose regex anchored
 *       //  with ^...$]
 *       ["promoCode", /promo\s*code/],
 *       ["maxBonus",  /max\s*bonus/],
 *     ],
 *     requiredField: "promoCode",   // must be found for a row to count as "the header"
 *     identityFields: ["promoCode"], // never inherit these via forwardFill
 *   });
 *
 *   const { headerIndex, colMap, dataRows } = mapper.prepare(allRowsFromSheetsApi);
 *   for (const row of dataRows) {
 *     const promoCode = mapper.col(colMap, "promoCode", row);
 *     if (!promoCode) continue; // no identity field = not a real data row
 *     const maxBonus = mapper.col(colMap, "maxBonus", row);
 *   }
 */

// Folds fullwidth punctuation, collapses whitespace (including non-
// breaking spaces, which \s already matches in JS), and lowercases —
// so "Max Bonus", " max  bonus ", "Max　Bonus" (fullwidth space) all
// compare equal.
function normalizeCell(value) {
  return String(value == null ? "" : value)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Scans a single row against the field patterns and returns
// { fieldName: columnIndex }. Each field only ever keeps the FIRST
// column that matches it — critical so that an unexpected column
// inserted later (e.g. "Bengali/Urdu Bonus Code" next to the real
// "Bonus Code") can't steal a field that was already found further
// left in the row.
function buildColumnMap(headerRow, fields) {
  const map = {};
  (headerRow || []).forEach((cell, i) => {
    const norm = normalizeCell(cell);
    if (!norm) return;
    for (const [field, pattern] of fields) {
      if (map[field] !== undefined) continue;
      if (pattern.test(norm)) {
        map[field] = i;
        break;
      }
    }
  });
  return map;
}

// Scans the first `maxScanRows` rows looking for the real header row,
// instead of assuming it's always row 1 — some tabs have a section
// title, a blank row, or explanatory text above the real header.
function findHeaderRow(allRows, { fields, requiredField, minFields = 3, maxScanRows = 25 }) {
  const limit = Math.min(allRows.length, maxScanRows);
  for (let i = 0; i < limit; i++) {
    const map = buildColumnMap(allRows[i], fields);
    if ((!requiredField || map[requiredField] !== undefined) && Object.keys(map).length >= minFields) {
      return { index: i, colMap: map };
    }
  }
  // Fallback: nothing looked like a real header — behave like the old
  // hardcoded-layout code did (assume row 1) rather than throwing, so a
  // totally-empty or unrecognized tab just yields zero matches instead
  // of blowing up the whole search.
  return { index: 0, colMap: buildColumnMap(allRows[0], fields) };
}

// Some tabs re-print the header row in the middle of the data (for easier
// human reading while scrolling). If left in, a later forwardFillMergedCells
// pass would treat header LABELS as real values and inherit them downward.
// Requires >=2 field matches (not 1) so a normal data row that happens to
// contain one label-like value (e.g. Products = "ALL") is never misfiled
// as a header repeat.
function isHeaderRepeatRow(row, colMap, strictPatterns, minMatches = 2) {
  let matches = 0;
  for (const [field, idx] of Object.entries(colMap)) {
    const pattern = strictPatterns[field];
    if (!pattern) continue;
    if (pattern.test(normalizeCell(row[idx]))) {
      matches++;
      if (matches >= minMatches) return true;
    }
  }
  return false;
}

// Google Sheets API only returns a value in the TOP-LEFT cell of a
// vertically-merged range; every other cell in that merge reads back
// empty. This fills each empty cell in with the nearest non-empty value
// above it in the same column, so a merged "one value shared by a group
// of rows" reads correctly on every row in the group.
//
// `skipCols` (a Set of column indices) must include every identity
// column (the columns that tell rows apart, e.g. Promo Code / Bonus
// Code / Brand) — those must NEVER inherit a value from above, or two
// distinct rows silently collapse into one, or a genuinely blank row
// gets mistaken for real data.
function forwardFillMergedCells(rows, width, skipCols) {
  const lastSeen = new Array(width).fill(undefined);
  for (const row of rows) {
    for (let c = 0; c < width; c++) {
      if (skipCols.has(c)) continue;
      if (row[c] === undefined || row[c] === null || row[c] === "") {
        if (lastSeen[c] !== undefined) row[c] = lastSeen[c];
      } else {
        lastSeen[c] = row[c];
      }
    }
  }
}

/**
 * @param {Array} fieldDefs - [fieldName, loosePattern, strictPattern?][]
 * @param {string} [requiredField] - field that must be present for a row to count as the header
 * @param {string[]} [identityFields] - fields that identify a row; excluded from merged-cell inheritance
 * @param {number} [minFields] - minimum matched fields for a row to count as the header (default 3)
 * @param {number} [maxScanRows] - how many leading rows to scan looking for the header (default 25)
 * @param {number} [minRepeatMatches] - matched fields required to treat a data row as a repeated header (default 2)
 */
export function createColumnMapper({
  fields,
  requiredField,
  identityFields = [],
  minFields = 3,
  maxScanRows = 25,
  minRepeatMatches = 2,
}) {
  const loosePatterns = fields.map(([name, loose]) => [name, loose]);
  const strictPatterns = {};
  for (const [name, loose, strict] of fields) {
    strictPatterns[name] = strict || new RegExp(`^(?:${loose.source})$`, loose.flags.replace("g", ""));
  }

  function prepare(allRows) {
    const rows = allRows || [];
    const { index: headerIndex, colMap } = findHeaderRow(rows, {
      fields: loosePatterns,
      requiredField,
      minFields,
      maxScanRows,
    });

    const width = Math.max(0, ...Object.values(colMap).map((i) => i + 1), 1);
    const identityCols = new Set(identityFields.map((f) => colMap[f]).filter((i) => i !== undefined));

    const dataRows = rows
      .slice(headerIndex + 1)
      .filter((row) => !isHeaderRepeatRow(row, colMap, strictPatterns, minRepeatMatches));

    forwardFillMergedCells(dataRows, width, identityCols);

    return { headerIndex, colMap, dataRows };
  }

  function col(colMap, field, row) {
    const idx = colMap[field];
    if (idx === undefined) return "";
    const v = row[idx];
    return v == null ? "" : String(v).trim();
  }

  return { prepare, col };
}
