import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cardUnbilledMovementsKind } from "nw-tracker-contracts";
import { db } from "./db.js";
import { bankCupoRowsFromListing } from "./santanderBankCupo.js";
import { applyListing, balanceRow, listing, listingCard, listingLine } from "./test/cardListingPayloads.js";
import { ccOwedByCurrency } from "./ccOwedByCurrency.js";
import {
  installmentRemainderAfterFacturacionClp,
  installmentRemainingClpByCalendarMonth,
} from "./ccInstallmentLedgerDb.js";
import {
  bankCupoMessageKind,
  formatBankCupoReport,
  judgeBankCupo,
  judgeLatestBankCupoCapture,
  latestBankCupoForAccount,
  type BankCupoSnapshot,
} from "./ccBankCupoCheck.js";

/**
 * Synthetic Santander card on 2026-10-02: August closed by its statements, September by the
 * feed's SALDO INICIAL (24/09), two plans with nothing billed yet — one bought in the September
 * cycle, one in the open cycle but in calendar October — and one feed row per currency.
 */
const LAST4 = "9933";
const OTHER_LAST4 = "9944";
const BANK_ACCOUNT = "800099990033";
const CARD_GROUP = "santander";

function cupoRow(currency: "clp" | "usd", total: number, used: number, opts?: { last4?: string; available?: number }) {
  return balanceRow(BANK_ACCOUNT, opts?.last4 ?? LAST4, currency, total, used, opts?.available ?? total - used);
}

// What the bank would say for the fixture: SALDO INICIAL + unbilled cuotas + feed rows.
const BANK_CLP_USED = 1_500_000 + 300_000 + 100_000 + 20_000;
const BANK_USD_USED = 900 + 12.34;

describe("bank cupo check", () => {
  let accountId = 0;
  let otherAccountId = 0;
  let tmpDir = "";
  const prevIdentifiers = process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS;

  function insertStatement(currency: "clp" | "usd", monto: number): void {
    db.prepare(
      `INSERT INTO cc_statements (
         account_id, card_group, source_pdf, statement_date, period_from, period_to,
         card_last4, layout, currency, monto_facturado, next_period_from, next_period_to
       ) VALUES (?, ?, ?, '25/08/2026', '23/07/2026', '25/08/2026', ?, 'compact', ?, ?, ?, ?)`
    ).run(
      accountId,
      CARD_GROUP,
      `vitest bank cupo 2026-08-25 ${currency}.pdf`,
      LAST4,
      currency,
      monto,
      currency === "clp" ? "25/08/2026" : null,
      currency === "clp" ? "24/09/2026" : null
    );
  }

  function insertPlan(purchaseIso: string, total: number, cuotas: number, firstDue: string): void {
    db.prepare(
      `INSERT INTO cc_installment_purchases (
         account_id, card_group, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales,
         merchant, source, first_due_month
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?)`
    ).run(accountId, CARD_GROUP, `vitest-bank-cupo-${purchaseIso}`, purchaseIso, total, cuotas, `VITEST PLAN ${purchaseIso}`, firstDue);
  }

  /** The fixture's listing: one line per currency, the 24/09 close; `balances` as the feeder reports them. */
  function feed(balances?: Parameters<typeof listing>[1]) {
    return listing(
      [
        listingCard(
          BANK_ACCOUNT,
          [
            listingLine("2026-09-25", "VITEST TIENDA", 20_000),
            listingLine("2026-09-26", "VITEST APP", 12.34, { currency: "usd" }),
          ],
          { date: "2026-09-24", clp: 1_500_000, usd: 900 }
        ),
      ],
      balances
    );
  }

  function cupos(clpUsed = BANK_CLP_USED, usdUsed = BANK_USD_USED, observedAt = "2026-10-02T00:59:40.000Z") {
    return {
      status: "observed" as const,
      observed_at: observedAt,
      rows: [cupoRow("clp", 5_000_000, clpUsed), cupoRow("usd", 5_000, usdUsed)],
    };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T15:00:00Z")); // 12:00 Chile, eight days after the close
    const bucket = db
      .prepare(`SELECT id FROM asset_groups WHERE slug IN ('credit_card', 'credit_cards__credit_card') LIMIT 1`)
      .get() as { id: number };
    const insertMaster = (last4: string): number => {
      const importKey = `credit_card_master|santander|vitest-bank-cupo-${last4}`;
      const id = Number(
        db
          .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, ?, ?, ?)`)
          .run(bucket.id, `Vitest · bank cupo ${last4}`, importKey, importKey).lastInsertRowid
      );
      db.prepare(
        `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4)
         VALUES (?, 21, 20, ?)`
      ).run(id, last4);
      return id;
    };
    accountId = insertMaster(LAST4);
    otherAccountId = insertMaster(OTHER_LAST4);
    insertStatement("clp", 2_000_000);
    insertStatement("usd", 400);
    insertPlan("2026-09-05", 300_000, 3, "2026-10");
    insertPlan("2026-10-01", 100_000, 2, "2026-11");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vitest-bank-cupo-"));
    const identifiers = path.join(tmpDir, "organize-identifiers.json");
    fs.writeFileSync(identifiers, JSON.stringify({ santander_80_account_to_card_last4: { [BANK_ACCOUNT]: LAST4 } }));
    process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS = identifiers;
  });

  afterEach(() => {
    vi.useRealTimers();
    db.prepare(`DELETE FROM cc_bank_cupo_captures WHERE source_file LIKE 'card-movements-vitest-%'`).run();
    for (const id of [accountId, otherAccountId]) {
      db.prepare(
        `DELETE FROM cc_installment_payments WHERE purchase_id IN (SELECT id FROM cc_installment_purchases WHERE account_id = ?)`
      ).run(id);
      db.prepare(`DELETE FROM cc_installment_purchases WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM cc_feed_billing_closes WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM cc_billing_month_balances WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM import_batches WHERE raw_text LIKE ?`).run(`%"account_id":${id},%`);
      db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevIdentifiers == null) delete process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS;
    else process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS = prevIdentifiers;
  });

  it("routes each reported balance to its card master", () => {
    const [clp, usd] = bankCupoRowsFromListing([cupoRow("clp", 5_000_000, 1_234_567), cupoRow("usd", 5_000, 912.34)]);
    expect(clp).toMatchObject({ account_id: accountId, currency: "clp", plastic_last4: LAST4, cupo_total: 5_000_000, cupo_utilizado: 1_234_567, cupo_disponible: 3_765_433 });
    expect(usd).toMatchObject({ currency: "usd", cupo_total: 5_000, cupo_utilizado: 912.34, cupo_disponible: 4_087.66 });
  });

  it("throws on a plastic routed elsewhere and on two rows for one card and currency", () => {
    expect(() => bankCupoRowsFromListing([cupoRow("clp", 5_000_000, 0, { last4: OTHER_LAST4 })])).toThrow(
      /routes to card master \d+ but plastic ·9944 to \d+/
    );
    expect(() => bankCupoRowsFromListing([cupoRow("clp", 1, 0), cupoRow("clp", 1, 0)])).toThrow(/two clp rows/);
  });

  it("refuses a balance that breaks limit = used + available (the contract's check)", () => {
    expect(
      cardUnbilledMovementsKind.payload.safeParse(
        feed({ status: "observed", observed_at: "2026-10-02T00:59:40.000Z", rows: [cupoRow("clp", 5_000_000, 1_234_567, { available: 3_000_000 })] })
      ).success
    ).toBe(false);
  });

  it("counts a plan bought in the open cycle whatever calendar month it was bought in", () => {
    expect(installmentRemainderAfterFacturacionClp(accountId, "2026-09", "2026-10-02")).toEqual({
      amount_clp: 400_000,
      cuotas: 5,
    });
    // The calendar-month frame stops at September 30 and misses the October plan.
    expect(installmentRemainingClpByCalendarMonth(accountId).get("2026-09")).toBe(300_000);
    // Bounded by the close, it is the bank's «saldo capital cuotas» frame.
    expect(installmentRemainderAfterFacturacionClp(accountId, "2026-09", "2026-09-24").amount_clp).toBe(300_000);
  });

  it("records the summary with the import and judges it against the app's owed per currency", () => {
    const result = applyListing(feed(cupos()), "card-movements-vitest-ok.json");
    expect(result.bank_cupo).toMatchObject({ status: "recorded", snapshots: 2, observed_at: "2026-10-02T00:59:40.000Z" });

    const owed = ccOwedByCurrency(accountId, "2026-10-02");
    expect(owed).toMatchObject({
      last_closed_billing_month: "2026-09",
      close_iso: "2026-09-24",
      clp: { facturado: 1_500_000, installment_remainder: 400_000, remaining_cuotas: 5, open_cycle_lines: 20_000, total: BANK_CLP_USED },
      usd: { facturado: 900, open_cycle_lines: 12.34, total: 912.34 },
    });

    const run = judgeLatestBankCupoCapture();
    expect(run.capture_error).toBeNull();
    expect(run.verdicts.map((v) => [v.snapshot.currency, v.status, v.diff, v.fresh])).toEqual([
      ["clp", "ok", 0, true],
      ["usd", "ok", 0, true],
    ]);
    expect(bankCupoMessageKind(run.verdicts)).toBe("log");
    expect(latestBankCupoForAccount(accountId)).toMatchObject({
      observed_at: "2026-10-02T00:59:40.000Z",
      currencies: [
        { currency: "clp", cupo_utilizado: BANK_CLP_USED, app_owed: BANK_CLP_USED, diff: 0, status: "ok" },
        { currency: "usd", cupo_utilizado: 912.34, app_owed: 912.34, diff: 0, status: "ok" },
      ],
    });

    // A second run on the same capture reports the stored verdicts, fresh no more.
    const again = judgeLatestBankCupoCapture();
    expect(again.capture?.already_checked).toBe(true);
    expect(again.verdicts.every((v) => !v.fresh)).toBe(true);
  });

  it("flags a card the app over-counts, then reports the recovery", () => {
    // The bank owes 3xx.xxx less than the app counts — a plan the bank never had.
    applyListing(feed(cupos(BANK_CLP_USED - 300_000)), "card-movements-vitest-1.json");
    const bad = judgeLatestBankCupoCapture();
    const clp = bad.verdicts.find((v) => v.snapshot.currency === "clp")!;
    expect(clp).toMatchObject({ status: "mismatch", diff: 300_000, tolerance: 5 });
    expect(bankCupoMessageKind(bad.verdicts)).toBe("notification");
    const report = formatBankCupoReport(bad.verdicts, () => "Vitest card");
    expect(report).toContain("CLP: bank $1.620.000 · app $1.920.000 · +$300.000 (tolerance $5) MISMATCH");
    expect(report).toContain("cuotas por facturar $400.000 (5)");
    expect(report).toContain("USD: bank US$912,34 · app US$912,34 · ±US$0,00 ok");

    applyListing(feed(cupos(BANK_CLP_USED, BANK_USD_USED, "2026-10-02T12:00:00.000Z")), "card-movements-vitest-2.json");
    const fixed = judgeLatestBankCupoCapture();
    expect(fixed.verdicts.every((v) => v.status === "ok")).toBe(true);
    expect(bankCupoMessageKind(fixed.verdicts)).toBe("notification");
  });

  it("tolerates a peso per unbilled cuota and nothing in dollars", () => {
    applyListing(feed(cupos(BANK_CLP_USED - 5, BANK_USD_USED - 0.01)), "card-movements-vitest-round.json");
    const run = judgeLatestBankCupoCapture();
    expect(run.verdicts.map((v) => [v.snapshot.currency, v.status, v.diff])).toEqual([
      ["clp", "ok", 5],
      ["usd", "mismatch", 0.01],
    ]);
  });

  it("does not compare across different closes", () => {
    const snapshot: BankCupoSnapshot = {
      id: 1,
      account_id: accountId,
      currency: "clp",
      observed_at: "2026-10-02T00:59:40.000Z",
      plastic_last4: LAST4,
      cupo_total: 5_000_000,
      cupo_utilizado: BANK_CLP_USED,
      cupo_disponible: 5_000_000 - BANK_CLP_USED,
      feed_close_iso: "2026-10-24",
    };
    expect(judgeBankCupo(snapshot, ccOwedByCurrency(accountId, "2026-10-02"))).toMatchObject({
      status: "indeterminate",
      reason: "the feed states the close 2026-10-24 but the app's latest is 2026-09-24",
    });
  });

  it("records a session with no summary as a failed capture, reported once", () => {
    const result = applyListing(
      feed({ status: "unavailable", reason: "the landing page made no cruceProductosOnline call this session" }),
      "card-movements-vitest-missing.json"
    );
    expect(result.bank_cupo).toEqual({
      status: "missing",
      error: "the landing page made no cruceProductosOnline call this session",
    });
    const first = judgeLatestBankCupoCapture();
    expect(first.capture_error).toMatch(/no cruceProductosOnline call/);
    expect(first.capture?.already_checked).toBe(false);
    expect(judgeLatestBankCupoCapture().capture?.already_checked).toBe(true);
  });

  it("ignores a listing without balances, and re-applies idempotently", () => {
    const legacy = applyListing(feed(), "card-movements-vitest-legacy.json");
    expect(legacy.bank_cupo).toEqual({ status: "absent" });

    const ref = "card-movements-vitest-repeat.json";
    expect(applyListing(feed(cupos()), ref).bank_cupo.status).toBe("recorded");
    expect(applyListing(feed(cupos()), ref).bank_cupo.status).toBe("seen");
    expect(() => applyListing(feed(cupos(BANK_CLP_USED + 1)), ref)).toThrow(/already recorded differently/);
  });

  it("validates the balances before the import writes anything", () => {
    expect(() =>
      applyListing(
        feed({ status: "observed", observed_at: "2026-10-02T00:59:40.000Z", rows: [cupoRow("clp", 5_000_000, 1, { last4: OTHER_LAST4 })] }),
        "card-movements-vitest-bad.json"
      )
    ).toThrow(/routes to card master/);
    const lines = db
      .prepare(
        `SELECT COUNT(*) AS c FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ?`
      )
      .get(accountId) as { c: number };
    expect(lines.c).toBe(0);
  });
});
