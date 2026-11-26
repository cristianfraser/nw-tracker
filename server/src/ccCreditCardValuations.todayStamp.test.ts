import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { clearAggregationCache } from "./cacheRegistry.js";
import {
  latestCreditCardBillingBalanceTotalClp,
  upsertCreditCardValuationsFromLedger,
} from "./ccCreditCardValuations.js";
import { ccOwedWalkClpAtYmd } from "./ccOwedWalk.js";
import { db } from "./db.js";
import { latestCreditCardDisplayedBalance } from "./valuationLatest.js";

/**
 * Today's stamp is the owed walk (the anchor strictly before today plus the evidence after it).
 * A card with nothing before today to walk from — a new card whose first month-end is still
 * ahead — gets no stamp and no anchor for today: the billing total was once written there as
 * `{clp, usd: 0}`, an anchor every later walk would have started from. Today's value is then
 * read live, never stored.
 */

const NOW = new Date("2026-03-15T15:00:00Z"); // 12:00 in Santiago, mid-month
const TODAY = "2026-03-15";
const PREFIX = "vitest-today-stamp";

let ccId: number | null = null;

function seedPlan(purchaseDate: string): void {
  db.prepare(
    `INSERT INTO cc_installment_purchases (
       account_id, card_group, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales,
       merchant, description_merged, source
     ) VALUES (?, 'A', ?, ?, 600000, 6, 'VITEST TODAY STAMP', 'VITEST TODAY STAMP', 'pdf')`
  ).run(ccId, `${PREFIX}-plan`, purchaseDate);
  clearAggregationCache();
}

function todayRows(): { valuation: number | undefined; anchors: number } {
  const v = db
    .prepare(`SELECT value FROM valuations WHERE account_id = ? AND as_of_date = ?`)
    .get(ccId, TODAY) as { value: number } | undefined;
  const a = db
    .prepare(`SELECT COUNT(*) AS n FROM cc_owed_anchors WHERE account_id = ? AND as_of_date = ?`)
    .get(ccId, TODAY) as { n: number };
  return { valuation: v?.value, anchors: a.n };
}

function wipeCard(): void {
  if (ccId == null) return;
  db.prepare(
    `DELETE FROM cc_statement_lines WHERE statement_id IN (SELECT id FROM cc_statements WHERE account_id = ?)`
  ).run(ccId);
  db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(ccId);
  db.prepare(`DELETE FROM cc_installment_purchases WHERE account_id = ?`).run(ccId);
  db.prepare(`DELETE FROM cc_owed_anchors WHERE account_id = ?`).run(ccId);
  db.prepare(`DELETE FROM cc_billing_month_metrics WHERE account_id = ?`).run(ccId);
  db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(ccId);
  clearAggregationCache();
}

beforeAll(() => {
  const leaf = db
    .prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%__credit_card' OR slug LIKE 'credit_cards__%' LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!leaf) throw new Error("no credit-card asset group in the test database");
  ccId = Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'Vitest · today stamp card', ?, ?)`)
      .run(leaf.id, PREFIX, PREFIX).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO credit_card_account_config (account_id, card_last4, billing_cycle_start_day, billing_cycle_end_day, issuer)
     VALUES (?, '7771', 21, 20, 'santander')`
  ).run(ccId);
});

afterEach(() => {
  vi.useRealTimers();
  wipeCard();
});

afterAll(() => {
  if (ccId == null) return;
  wipeCard();
  db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(ccId);
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(ccId);
  clearAggregationCache();
});

describe("upsertCreditCardValuationsFromLedger — today's stamp", () => {
  it("writes no stamp and no anchor for today when there is no anchor before today to walk from", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    // Bought this month: the plan's first month-end (2026-03-31) is still ahead.
    seedPlan("2026-03-02");
    upsertCreditCardValuationsFromLedger(ccId!);

    expect(ccOwedWalkClpAtYmd(ccId!, TODAY)).toBeNull();
    expect(todayRows()).toEqual({ valuation: undefined, anchors: 0 });
    const earlier = db
      .prepare(`SELECT COUNT(*) AS n FROM cc_owed_anchors WHERE account_id = ? AND as_of_date < ?`)
      .get(ccId, TODAY) as { n: number };
    expect(earlier.n).toBe(0);

    // Today's value is still read, live, from the billing detail — nothing stored.
    const live = latestCreditCardBillingBalanceTotalClp(ccId!);
    expect(live).not.toBeNull();
    expect(latestCreditCardDisplayedBalance(ccId!, TODAY)?.value_clp).toBe(live);
  });

  it("stamps today with the walk once a month-end anchor before today exists", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    // February's statement makes 2026-02-28 a month-end anchor before today.
    const statementId = Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency)
           VALUES (?, 'santander', ?, '2026-02-20', '2026-01-21', '2026-02-20', 'clp')`
        )
        .run(ccId, `${PREFIX}.pdf`).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, installment_flag, dedupe_key)
       VALUES (?, '2026-02-10', 'TIENDA VITEST', 50000, 0, ?)`
    ).run(statementId, `${PREFIX}-1`);
    seedPlan("2026-03-02");
    upsertCreditCardValuationsFromLedger(ccId!);

    const walked = ccOwedWalkClpAtYmd(ccId!, TODAY);
    expect(walked).not.toBeNull();
    const rows = todayRows();
    expect(rows.anchors).toBeGreaterThan(0);
    expect(rows.valuation).toBe(walked!.value_clp);
  });
});
