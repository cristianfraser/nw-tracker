import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import { billingMonthContainingPurchase, billingMonthForLedgerPurchase, billingMonthForManualLedgerPurchase, lastPdfBillingMonthForAccount, targetBillingMonthForManualImports } from "./cards/facturacion.js";
import { createTempCardMaster, deleteTempCardMaster } from "./test/tempCardMaster.js";

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
    db.prepare(
      `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4, issuer)
       VALUES (?, 21, 20, '0000', 'santander')`
    ).run(id);
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

describe("billingMonthContainingPurchase", () => {
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
        .run(group.id, `Vitest · purchase cycle ${key}`, `vitest-cc-purchase-cycle|${key}`).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4, issuer)
       VALUES (?, 21, 20, '0000', ?)`
    ).run(id, key === "bci" ? "bci" : "santander");
    accountIds.push(id);
    return id;
  }

  it("follows the 21→20 config cycle for a card with no close on record", () => {
    const id = makeFixtureAccount("no-close");
    expect(billingMonthContainingPurchase(id, "2026-04-25")).toBe("2026-05");
    expect(billingMonthContainingPurchase(id, "2026-05-10")).toBe("2026-05");
    expect(billingMonthContainingPurchase(id, "2026-03-15")).toBe("2026-03");
    expect(billingMonthContainingPurchase(id, "2026-03-20")).toBe("2026-03");
    expect(billingMonthContainingPurchase(id, "2026-03-21")).toBe("2026-04");
  });

  it("follows the bank's close once one is on record: BCI's cycle ends on the close day", () => {
    const id = makeFixtureAccount("bci");
    // BCI Lider prints the next cycle from the day after the close (26/08 → 27/08).
    db.prepare(
      `INSERT INTO cc_statements (
         account_id, card_group, source_pdf, statement_date, period_from, period_to,
         next_period_from, next_period_to, layout, currency
       ) VALUES (?, 'BCI', 'vitest 2026-08-26 clp.pdf', '26/08/2026', '27/07/2026', '26/08/2026',
                 '27/08/2026', '26/09/2026', 'compact', 'clp')`
    ).run(id);
    expect(billingMonthContainingPurchase(id, "2026-08-26")).toBe("2026-08");
    expect(billingMonthContainingPurchase(id, "2026-08-27")).toBe("2026-09");
    // Between the config's 20th and the announced 26/09 close: still September.
    expect(billingMonthContainingPurchase(id, "2026-09-22")).toBe("2026-09");
    expect(billingMonthContainingPurchase(id, "2026-09-26")).toBe("2026-09");
    expect(billingMonthContainingPurchase(id, "2026-09-27")).toBe("2026-10");
    // PDF plans in the ledger facturado projection read the same cycle.
    expect(billingMonthForLedgerPurchase(id, { purchase_date: "2026-09-22", source: "pdf" })).toBe("2026-09");
  });
});

describe("targetBillingMonthForManualImports", () => {
  let id = 0;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // Titular ·9977; the closed May statement was printed for the adicional ·5544.
    id = createTempCardMaster({ issuer: "santander", last4: "9977", key: "vitest-manual-target" });
    db.prepare(
      `INSERT INTO cc_statements (
         account_id, card_group, source_pdf, statement_date, period_from, period_to, card_last4, layout, currency
       ) VALUES (?, 'santander', 'vitest 2026-05-20 clp.pdf', '20/05/2026', '21/04/2026', '20/05/2026', '5544', 'compact', 'clp')`
    ).run(id);
  });

  afterEach(() => {
    vi.useRealTimers();
    deleteTempCardMaster(id);
  });

  it("returns month after last PDF close (any card_last4 on account)", () => {
    // Five days after the May close: the calendar month is still May, the open facturación is June.
    vi.setSystemTime(new Date("2026-05-25T15:00:00Z"));
    expect(lastPdfBillingMonthForAccount(id)).toBe("2026-05");
    expect(targetBillingMonthForManualImports(id, "4242")).toBe("2026-06");
    // Months later with no newer close: the current calendar month.
    vi.setSystemTime(new Date("2026-08-10T15:00:00Z"));
    expect(targetBillingMonthForManualImports(id, "4242")).toBe("2026-08");
  });

  it("maps manual ledger purchases to open month regardless of purchase date", () => {
    vi.setSystemTime(new Date("2026-05-25T15:00:00Z"));
    expect(billingMonthForManualLedgerPurchase(id)).toBe("2026-06");
    expect(billingMonthForLedgerPurchase(id, { purchase_date: "2026-03-15", source: "manual" })).toBe("2026-06");
    expect(billingMonthForLedgerPurchase(id, { purchase_date: "2026-04-25", source: "manual" })).toBe("2026-06");
    // A statement plan's purchase stays in the cycle its date falls in.
    expect(billingMonthForLedgerPurchase(id, { purchase_date: "2026-04-25", source: "pdf" })).toBe("2026-05");
  });
});
