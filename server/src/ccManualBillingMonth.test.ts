import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { ymCompare } from "./calendarMonth.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import {
  billingMonthForLedgerPurchase,
  billingMonthForManualLedgerPurchase,
  lastPdfBillingMonthForAccount,
  targetBillingMonthForManualImports,
} from "./ccManualBillingMonth.js";

describe("lastPdfBillingMonthForAccount", () => {
  const accountIds: number[] = [];

  afterEach(() => {
    for (const id of accountIds) {
      db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    }
    accountIds.length = 0;
  });

  function makeFixtureAccount(key: string): number {
    const group = db.prepare(`SELECT id FROM asset_groups LIMIT 1`).get() as { id: number };
    const id = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, import_key) VALUES (?, ?, ?)`)
        .run(group.id, `Vitest · cc open month ${key}`, `vitest-cc-open-month|${key}`).lastInsertRowid
    );
    accountIds.push(id);
    return id;
  }

  function insertStatement(
    accountId: number,
    opts: { periodTo: string; currency: "clp" | "usd"; sourcePdf: string }
  ): void {
    db.prepare(
      `INSERT INTO cc_statements (
         account_id, card_group, source_pdf, statement_date, period_to, layout, currency
       ) VALUES (?, 'santander', ?, ?, ?, 'compact', ?)`
    ).run(accountId, opts.sourcePdf, opts.periodTo, opts.periodTo, opts.currency);
  }

  it("does not close a month on the USD twin alone when the card has a USD statement stream", () => {
    const id = makeFixtureAccount("two-currency");
    insertStatement(id, { periodTo: "20/05/2026", currency: "clp", sourcePdf: "vitest 2026-05 clp.pdf" });
    insertStatement(id, { periodTo: "20/05/2026", currency: "usd", sourcePdf: "vitest 2026-05 usd.pdf" });
    insertStatement(id, { periodTo: "20/06/2026", currency: "clp", sourcePdf: "vitest 2026-06 clp.pdf" });
    insertStatement(id, { periodTo: "20/06/2026", currency: "usd", sourcePdf: "vitest 2026-06 usd.pdf" });
    // July's USD statement arrived first; the CLP twin is still missing.
    insertStatement(id, { periodTo: "20/07/2026", currency: "usd", sourcePdf: "vitest 2026-07 usd.pdf" });

    expect(lastPdfBillingMonthForAccount(id)).toBe("2026-06");

    insertStatement(id, { periodTo: "20/07/2026", currency: "clp", sourcePdf: "vitest 2026-07 clp.pdf" });
    expect(lastPdfBillingMonthForAccount(id)).toBe("2026-07");
  });

  it("closes on CLP alone while the account has no USD statement stream", () => {
    const id = makeFixtureAccount("clp-stream");
    insertStatement(id, { periodTo: "26/06/2026", currency: "clp", sourcePdf: "vitest 2026-06 clp.pdf" });
    insertStatement(id, { periodTo: "26/07/2026", currency: "clp", sourcePdf: "vitest 2026-07 clp.pdf" });
    expect(lastPdfBillingMonthForAccount(id)).toBe("2026-07");
  });

  it("ignores web-paste statements entirely", () => {
    const id = makeFixtureAccount("web-paste");
    insertStatement(id, { periodTo: "20/06/2026", currency: "clp", sourcePdf: "vitest 2026-06 clp.pdf" });
    db.prepare(
      `INSERT INTO cc_statements (
         account_id, card_group, source_pdf, statement_date, layout, currency
       ) VALUES (?, 'santander', 'import:web-paste|open|2026-07', '20/07/2026', 'compact', 'clp')`
    ).run(id);
    expect(lastPdfBillingMonthForAccount(id)).toBe("2026-06");
  });
});

describe("targetBillingMonthForManualImports", () => {
  it("returns month after last PDF close for 4242 (any card_last4 on account)", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;
    const lastPdf = lastPdfBillingMonthForAccount(master.id);
    if (!lastPdf) return;
    const target = targetBillingMonthForManualImports(master.id, "4242");
    expect(ymCompare(target, addCalendarMonths(lastPdf!, 1))).toBeGreaterThanOrEqual(0);
  });

  it("maps manual ledger purchases to open month regardless of purchase date", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;
    const lastPdf = lastPdfBillingMonthForAccount(master.id);
    const open = billingMonthForManualLedgerPurchase(master.id);
    if (!lastPdf || !open) return;
    expect(ymCompare(open, addCalendarMonths(lastPdf, 1))).toBeGreaterThanOrEqual(0);
    expect(
      billingMonthForLedgerPurchase(master.id, {
        purchase_date: "2026-03-15",
        source: "manual",
      })
    ).toBe(open);
    expect(
      billingMonthForLedgerPurchase(master.id, {
        purchase_date: "2026-04-25",
        source: "manual",
      })
    ).toBe(open);
  });
});
