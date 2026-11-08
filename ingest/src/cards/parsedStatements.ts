import fs from "node:fs";
import {
  canonicalStatementsFromParsedPayload,
  cardParsedStatementsKind,
  cardStatementKind,
  type CardCanonicalStatementsPayload,
  type CardParsedStatementsPayload,
} from "nw-tracker-contracts";

/**
 * The card statement parser's merged output (`cfraser/cc-statements-parsed-all.csv`, written by
 * `parse:cc-pdfs`) → canonical card statements (`card.statement`, format `canonical`): the parser's
 * cells read once, here, by the contracts' converter (`canonicalStatementsFromParsedPayload`). The
 * CSV is read as the parser writes it (RFC 4180 quoting, headers trimmed / lower-cased / spaces to
 * `_`, blank rows dropped, a short row padded with "").
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

export function parsedStatementsPayload(csv: { columns: string[]; rows: string[][] }, opts: { full: boolean }): CardParsedStatementsPayload {
  return cardParsedStatementsKind.payload.parse({ full: opts.full, columns: csv.columns, rows: csv.rows });
}

/** The parsed CSV as canonical statements, the `card.statement` payload the server imports. */
export function canonicalStatementsPayload(csv: { columns: string[]; rows: string[][] }, opts: { full: boolean }): CardCanonicalStatementsPayload {
  const statements = canonicalStatementsFromParsedPayload(parsedStatementsPayload(csv, opts));
  return cardStatementKind.payload.parse({ format: "canonical", full: opts.full, statements }) as CardCanonicalStatementsPayload;
}
