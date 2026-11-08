import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { importCcListingLines } from "./accountImports.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { listingLineFromCardListingLine } from "./cardListingLines.js";
import { resolveMasterAccountIdForImportCardLast4 } from "./ccConsolidatedCards.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { ufProjector } from "./ufProjection.js";
import { snapshotTables } from "./test/snapshotTables.js";

const restoreTables = snapshotTables([
  "cc_statements",
  "cc_statement_lines",
  "cc_expense_line_categories",
  "cc_billing_month_balances",
  "valuations",
  "import_batches",
]);

const NAME = "vitest-recurring-pending";
let master = 0;
const today = chileCalendarTodayYmd();
const posted = chileCalendarAddDays(today, -2);
const pending = chileCalendarAddDays(today, -5);

beforeAll(() => {
  const id = resolveMasterAccountIdForImportCardLast4("4321");
  if (id == null) throw new Error("synthetic preset master ·4321 missing from the test DB");
  master = id;
  const r = db
    .prepare(
      `INSERT INTO recurring_payments (name, manual, frequency, due_month, due_day, amount, currency, match_days_before, match_days_after, amount_tolerance_pct)
       VALUES (?, 0, 'monthly', NULL, 6, 0.5, 'uf', 14, 7, 0.5)`
    )
    .run(NAME);
  for (const p of ["VITEST CONVENIO", "VITEST SEGURO"]) {
    db.prepare(`INSERT INTO recurring_payment_patterns (recurring_payment_id, pattern) VALUES (?, ?)`).run(Number(r.lastInsertRowid), p);
  }
});

afterAll(() => {
  db.prepare(`DELETE FROM recurring_payments WHERE name = ?`).run(NAME);
  restoreTables();
  clearAggregationCache();
});

function feed(date: string, merchant: string, amount: number) {
  const line = listingLineFromCardListingLine("santander", {
    date,
    merchant,
    currency: "clp",
    amount,
    raw_text: `${date} ${merchant} ${amount}`,
    holder: "titular",
  });
  return importCcListingLines(master, { lines: [line], errors: [] }, "cc_santander_fetch");
}

function linesNamed(merchant: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ? AND l.merchant = ?`
      )
      .get(master, merchant) as { n: number }
  ).n;
}

describe("replaceRecurringPendingLines", () => {
  it("the posted line replaces the pending listing of the same pesos; another amount stays", () => {
    const pesos = Math.round(0.5 * ufProjector().ufOn(posted));
    feed(pending, "VITEST CONVENIO", pesos);
    feed(pending, "VITEST CONVENIO", pesos + 3_000);
    expect(linesNamed("VITEST CONVENIO")).toBe(2);
    const r = feed(posted, "VITEST SEGURO", pesos);
    expect(r.recurring_pending?.replaced).toHaveLength(1);
    expect(r.recurring_pending?.replaced[0]).toMatchObject({ entry: NAME, amount_clp: pesos, pending_on: pending });
    expect(linesNamed("VITEST CONVENIO")).toBe(1);
    expect(linesNamed("VITEST SEGURO")).toBe(1);
  });
});
