import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CARD_PARSED_STATEMENT_COLUMNS } from "nw-tracker-contracts";
import { parsedStatementsPayload, readParsedStatementsCsv } from "./parsedStatements.js";

function csvFile(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vitest-parsed-statements-"));
  const file = path.join(dir, "parsed.csv");
  fs.writeFileSync(file, text);
  return file;
}

const header = CARD_PARSED_STATEMENT_COLUMNS.join(",");
const line = (merchant: string) => CARD_PARSED_STATEMENT_COLUMNS.map((c) => (c === "merchant" ? merchant : c === "card_last4" ? "0001" : "")).join(",");

describe("readParsedStatementsCsv", () => {
  it("reads quoted fields, CRLF, a BOM header and drops blank rows, as the server's reader did", () => {
    const file = csvFile(`﻿${header}\r\n${line('"TIENDA, ""UNO"""')}\r\n\r\n${line("DOS")}\n`);
    const csv = readParsedStatementsCsv(file)!;
    expect(csv.columns).toEqual([...CARD_PARSED_STATEMENT_COLUMNS]);
    const merchant = csv.columns.indexOf("merchant");
    expect(csv.rows.map((r) => r[merchant])).toEqual(['TIENDA, "UNO"', "DOS"]);
    expect(parsedStatementsPayload(csv, { apply: true, full: false }).rows).toHaveLength(2);
  });

  it("pads a short row and refuses a file whose columns are not the parser's", () => {
    const short = csvFile(`${header}\n0001,x\n`);
    expect(readParsedStatementsCsv(short)!.rows[0]).toHaveLength(CARD_PARSED_STATEMENT_COLUMNS.length);
    const missing = csvFile(`${CARD_PARSED_STATEMENT_COLUMNS.slice(1).join(",")}\n${line("X").split(",").slice(1).join(",")}\n`);
    expect(() => parsedStatementsPayload(readParsedStatementsCsv(missing)!, { apply: true, full: false })).toThrow(/missing: card_group/);
  });

  it("is null for a missing or empty file", () => {
    expect(readParsedStatementsCsv(path.join(os.tmpdir(), "no-such-parsed.csv"))).toBeNull();
    expect(readParsedStatementsCsv(csvFile(`${header}\n`))).toBeNull();
  });
});
