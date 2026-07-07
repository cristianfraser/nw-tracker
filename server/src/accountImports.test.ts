import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { importCcWebPaste } from "./accountImports.js";

const BCI_PASTE = `11/06/2026\tVITEST BCI WEB PASTE\t$9.999`;

describe("importCcWebPaste", () => {
  let insertedLineId: number | null = null;
  let insertedStmtId: number | null = null;

  afterEach(() => {
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

  it("rejects non credit-card master accounts", () => {
    const checking = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug = 'cuenta_corriente' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!checking) return;
    expect(() => importCcWebPaste(checking.id, "01/01/2026\tSHOP\t-$100")).toThrow(
      /not a credit card/i
    );
  });

  it("imports web paste for BCI master account", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|bci|4343'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const result = importCcWebPaste(master.id, BCI_PASTE);
    expect(result.inserted).toBeGreaterThanOrEqual(1);

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
