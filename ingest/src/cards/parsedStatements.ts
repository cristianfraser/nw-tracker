import fs from "node:fs";
import { cardParsedStatementsKind, type CardParsedStatementsPayload } from "nw-tracker-contracts";

/**
 * The card statement parser's merged output (`cfraser/cc-statements-parsed-all.csv`, written by
 * `parse:cc-pdfs`) → one `card.parsed_statements`. Read exactly as the server's importer read it
 * (RFC 4180 quoting, headers trimmed / lower-cased / spaces to `_`, blank rows dropped, a short row
 * padded with ""), because the server hashes each statement's rows to decide what changed.
 */

function normHeader(s: string): string {
  return String(s ?? "")
    .trim()
    .replace(/^﻿/, "")
    .toLowerCase()
    .replace(/\s+/g, "_");
}

export function parseCsvWithQuotes(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    if (row.length > 1 || row.some((x) => String(x).trim())) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      pushField();
    } else if (c === "\n") {
      pushField();
      pushRow();
    } else if (c !== "\r") {
      field += c;
    }
  }
  pushField();
  if (row.length) pushRow();
  return rows;
}

/** The parsed CSV as columns + rows; null when the file is missing or holds no line. */
export function readParsedStatementsCsv(file: string): { columns: string[]; rows: string[][] } | null {
  if (!fs.existsSync(file)) return null;
  const table = parseCsvWithQuotes(fs.readFileSync(file, "utf8"));
  if (table.length < 2) return null;
  const columns = table[0]!.map(normHeader);
  const rows = table
    .slice(1)
    .filter((row) => row.some((c) => String(c).trim()))
    .map((row) => columns.map((_, j) => row[j] ?? ""));
  return rows.length > 0 ? { columns, rows } : null;
}

export function parsedStatementsPayload(csv: { columns: string[]; rows: string[][] }, opts: { apply: boolean; full: boolean }): CardParsedStatementsPayload {
  return cardParsedStatementsKind.payload.parse({ apply: opts.apply, full: opts.full, columns: csv.columns, rows: csv.rows });
}
