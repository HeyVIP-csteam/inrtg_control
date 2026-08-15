/**
 * depositColumns.js  (SERVER-ONLY)
 *
 * Column layout for the Deposit Issue / Deposit Backup Google Sheets
 * differs by MODULE, not by brand — confirmed 2026-08-01 from two real
 * screenshots: Crickex's Deposit Issue sheet (module = "issue") and
 * BetVisa's Deposit Backup sheet ("BV INR Deposit August Settled",
 * module = "backup"). Every brand's Deposit Issue sheet uses the same
 * "issue" layout below; every brand's Deposit Backup sheet uses the
 * same "backup" layout — NOT the other way around (an earlier revision
 * of this file guessed it was per-brand instead of per-module and got
 * it wrong; don't reintroduce a brand-keyed lookup here).
 *
 * The two layouts diverge starting at column O — "issue" has PG Remarks/
 * CS Remarks/Payment Status/Order ID/PIC Name/Cart ID/Amount/Final
 * Status/UPI in O–W; "backup" instead has Payment Status/Order ID/PIC
 * Name/Remark PIC/CS Remarks/Memo/Condition in O–U (3 columns shorter,
 * with 3 fields "issue" doesn't have — Remark PIC, Memo, Condition —
 * and without "issue"'s PG Remarks/Cart ID/Amount/Final Status/UPI).
 *
 * Both deposit-issue and deposit-backup's search.js/update.js import
 * from here — don't duplicate a COLS object in those files again.
 */

// Deposit Issue — confirmed from Crickex's real sheet screenshot.
export const ISSUE_COLUMNS = {
  date: "A", time: "B", username: "C", pg: "D", utr: "E", slip: "F",
  pgStaffName: "G",
  // H — checkbox-formatted, no header, deliberately skipped everywhere
  pgTid: "I", slipAmount: "J", status: "K",
  followUpTimes: "L", chatIds: "M", agentUpi: "N", pgRemarks: "O",
  csRemarks: "P", // the CS-editable column for Deposit Issue
  paymentStatus: "Q", orderId: "R", picName: "S",
  cartId: "T", amount: "U", statusFinal: "V", upi: "W",
  lastCol: "W",
};

// Deposit Backup — confirmed from BetVisa's real "BV INR Deposit August
// Settled" sheet screenshot. Read-only in the app (no update.js for this
// module), so csRemarks here is only ever used for display, never write.
export const BACKUP_COLUMNS = {
  date: "A", time: "B", username: "C", pg: "D", utr: "E", slip: "F",
  pgStaffName: "G", // header text is "Payment PIC" but same meaning/position
  pgTid: "I", slipAmount: "J", status: "K", // header text is "PG STATUS"
  followUpTimes: "L", chatIds: "M",
  agentUpi: "N", // header text is "UPI ID" but same meaning/position
  // no pgRemarks column in this layout
  paymentStatus: "O", orderId: "P", picName: "Q",
  remarkPic: "R", // no equivalent in "issue"
  csRemarks: "S",
  memo: "T", // no equivalent in "issue"
  condition: "U", // no equivalent in "issue"
  // no cartId / amount / statusFinal / upi columns in this layout
  lastCol: "U",
};
