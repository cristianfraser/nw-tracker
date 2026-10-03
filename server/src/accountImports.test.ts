import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CARD_PASTED_LISTING, type CardPastedListing } from "nw-tracker-contracts";
import { db } from "./db.js";
import { importCcWebPaste } from "./accountImports.js";

const BCI_PASTE = `11/06/2026\tVITEST BCI WEB PASTE\t$9.999
11/06/2026\tVITEST BCI WEB PASTE\t$9.999`;

/** What the ingest service reads from BCI_PASTE (its own tests cover the reading). */
const BCI_LISTING: CardPastedListing = {
  lines: [1, 2].map(() => ({
    date: "2026-06-11",
    merchant: "VITEST BCI WEB PASTE",
    amount: 9999,
    currency: "clp" as const,
    raw_line: "11/06/2026\tVITEST BCI WEB PASTE\t$9.999",
  })),
  errors: [],
};

describe("importCcWebPaste", () => {
  let insertedLineId: number | null = null;
  let insertedStmtId: number | null = null;
  let stub: Server | null = null;
  let parsedTexts: string[] = [];
  const previousUrl = process.env.INGEST_URL;

  // A stand-in ingest service: answers the paste format with BCI_LISTING.
  beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.post("/parse/card.web_paste", (req, res) => {
      parsedTexts.push(Buffer.from(String(req.body.content_base64), "base64").toString("utf8"));
      res.json({ ...CARD_PASTED_LISTING, payload: BCI_LISTING });
    });
    stub = await new Promise<Server>((resolve) => {
      const s: Server = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    process.env.INGEST_URL = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    if (previousUrl === undefined) delete process.env.INGEST_URL;
    else process.env.INGEST_URL = previousUrl;
    const s = stub;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  });

  afterEach(() => {
    parsedTexts = [];
    if (insertedLineId != null) {
      db.prepare(`DELETE FROM cc_statement_lines WHERE id = ?`).run(insertedLineId);
      insertedLineId = null;
    }
    if (insertedStmtId != null) {
      const remaining = db
        .prepare(`SELECT COUNT(*) AS c FROM cc_statement_lines WHERE statement_id = ?`)
        .get(insertedStmtId) as { c: number };
      if (remaining.c === 0) {
        db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(insertedStmtId);
      }
      insertedStmtId = null;
    }
  });

  it("rejects non credit-card master accounts", async () => {
    const checking = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug = 'cuenta_corriente' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!checking) return;
    await expect(importCcWebPaste(checking.id, "01/01/2026\tSHOP\t-$100")).rejects.toThrow(/not a credit card/i);
    // Refused before the paste ever reaches the service.
    expect(parsedTexts).toEqual([]);
  });

  it("imports web paste for BCI master account", async () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|bci|4343'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const result = await importCcWebPaste(master.id, BCI_PASTE);
    expect(parsedTexts).toEqual([BCI_PASTE]);
    expect(result.inserted).toBeGreaterThanOrEqual(1);
    // Per-line outcome arrays (parity with checking imports): the inserted line plus the
    // in-paste repeat of the same line, each with date/description/amount detail.
    expect(result.inserted_flows).toContainEqual(
      expect.objectContaining({
        occurred_on: "2026-06-11",
        description: "VITEST BCI WEB PASTE",
        amount_clp: 9999,
      })
    );
    expect(result.skipped_flows).toContainEqual(
      expect.objectContaining({
        occurred_on: "2026-06-11",
        description: "VITEST BCI WEB PASTE",
        amount_clp: 9999,
        reason: "duplicate_in_paste",
      })
    );
    expect(result.skipped_duplicate_in_paste).toBe(1);

    const line = db
      .prepare(
        `SELECT l.id, l.amount_clp, l.merchant, s.id AS statement_id, s.card_group
         FROM cc_statement_lines l
         JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id = ? AND l.merchant = 'VITEST BCI WEB PASTE'
         ORDER BY l.id DESC LIMIT 1`
      )
      .get(master.id) as
      | {
          id: number;
          amount_clp: number;
          merchant: string;
          statement_id: number;
          card_group: string;
        }
      | undefined;
    expect(line).toBeDefined();
    expect(line!.amount_clp).toBe(9999);
    expect(line!.card_group).toBe("BCI");
    insertedLineId = line!.id;
    insertedStmtId = line!.statement_id;
  });
});
