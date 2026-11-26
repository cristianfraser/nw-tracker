import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { clearAggregationCache } from "../cacheRegistry.js";
import { db } from "../db.js";
import { cardStoppedBilling } from "./lifecycle.js";
import { billingMonthContainingPurchase } from "./facturacion.js";

/**
 * A card with no plans whose facturación just closed and whose new cycle holds nothing yet (an idle
 * card, or the statement still on the way after the bank's close): its just-closed facturación is
 * the one being paid, so it still bills. It stops only once a whole cycle passed with nothing.
 */

const PREFIX = "vitest-late-statement";
let ccId: number | null = null;

function at(iso: string): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
  clearAggregationCache();
}

beforeAll(() => {
  const leaf = db
    .prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%__credit_card' OR slug LIKE 'credit_cards__%' LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!leaf) throw new Error("no credit-card asset group in the test database");
  ccId = Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'Vitest · late statement card', ?, ?)`)
      .run(leaf.id, PREFIX, PREFIX).lastInsertRowid
  );
  // A Santander card: the issuer has an unbilled listing.
  db.prepare(
    `INSERT INTO credit_card_account_config (account_id, card_last4, billing_cycle_start_day, billing_cycle_end_day, issuer)
     VALUES (?, '7773', 21, 20, 'santander')`
  ).run(ccId);
  // The September facturación, closed on 24/09 (the open bucket or the statement: both are on file
  // as a statement of that month).
  const st = Number(
    db
      .prepare(
        `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency)
         VALUES (?, 'santander', ?, '24/09/2026', '25/08/2026', '24/09/2026', 'clp')`
      )
      .run(ccId, `${PREFIX}.pdf`).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, installment_flag, dedupe_key)
     VALUES (?, '10/09/2026', 'TIENDA VITEST', 45000, 0, ?)`
  ).run(st, `${PREFIX}-1`);
});

afterEach(() => {
  vi.useRealTimers();
  clearAggregationCache();
});

afterAll(() => {
  if (ccId == null) return;
  db.prepare(
    `DELETE FROM cc_statement_lines WHERE statement_id IN (SELECT id FROM cc_statements WHERE account_id = ?)`
  ).run(ccId);
  db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(ccId);
  db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(ccId);
  db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(ccId);
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(ccId);
  clearAggregationCache();
});

describe("cardStoppedBilling after a close with nothing in the new cycle", () => {
  it("still bills the cycle after its last facturación (the close's bill is being paid)", () => {
    at("2026-09-28T15:00:00Z");
    expect(billingMonthContainingPurchase(ccId!, "2026-09-28")).toBe("2026-10");
    expect(cardStoppedBilling(ccId!)).toBe(false);
  });

  it("has stopped once a whole cycle closed with nothing on file", () => {
    at("2026-10-28T15:00:00Z");
    expect(billingMonthContainingPurchase(ccId!, "2026-10-28")).toBe("2026-11");
    expect(cardStoppedBilling(ccId!)).toBe(true);
  });
});
