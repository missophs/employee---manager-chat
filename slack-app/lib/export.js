"use strict";

/**
 * Builds the CSV Export sends. Same row shape as the website's Export tab
 * (Section, Item, Detail, Status, Who, Date), but only for the sections that
 * actually exist in this server's storage: the agenda, actions, and wrap-up
 * history. Goals, Development, Career, Achievements, Feedback, Concerns and
 * Review drafts live only in the website's browser storage — this can't see
 * them, so they're not in this file either.
 */

function fmt(ts) {
  return ts ? new Date(ts).toLocaleDateString() : "";
}

function buildExportRows(topics, actions, history) {
  const rows = [["Section", "Item", "Detail", "Status", "Who", "Date"]];

  topics.forEach((t) => rows.push(["1:1 preparation", t.text, t.category || "", t.status, "", fmt(t.at)]));

  history.forEach((h) => {
    const detail = [
      "Discussed: " + (h.discussed || "—"),
      h.agreed ? "Agreed: " + h.agreed : "",
      h.revisit ? "Revisit: " + h.revisit : "",
      h.start ? "Start: " + h.start : "",
      h.stop ? "Stop: " + h.stop : "",
      h.cont ? "Continue: " + h.cont : "",
      h.nextDate ? "Next 1:1: " + fmt(h.nextDate) : ""
    ].filter(Boolean).join(" | ");
    rows.push(["1:1 update", "1:1 summary", detail, "", "", fmt(h.at)]);
  });

  actions.forEach((a) => rows.push(["Actions", a.text, "", a.done ? "Done" : "Open", "", fmt(a.at)]));

  return rows;
}

/* Excel/Sheets runs a cell as a formula if it starts with =, +, -, or @ —
   so a topic or action typed as e.g. "=HYPERLINK(...)" would execute on
   open instead of displaying as text. Prefixing with a tab neutralizes it
   without changing what the cell visibly shows. */
const FORMULA_PREFIX = /^[=+\-@]/;
const escapeCsvCell = (value) => {
  const s = String(value);
  return FORMULA_PREFIX.test(s) ? "\t" + s : s;
};

/** BOM so Excel reads accented characters correctly — matches the website. */
function toCsv(rows) {
  const body = rows
    .map((r) => r.map((cell) => '"' + escapeCsvCell(cell).replace(/"/g, '""') + '"').join(","))
    .join("\r\n");
  return "﻿" + body;
}

module.exports = { buildExportRows, toCsv };
