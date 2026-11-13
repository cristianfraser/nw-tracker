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
  splitPrincipalIntoCuotaAmounts,
} from "./ccInstallmentLedgerDb.js";
import {
  formatBankCupoReport,
  judgeBankCupo,
  judgeLatestBankCupoCapture,
  latestBankCupoForAccount,
  type BankCupoSnapshot,
} from "./ccBankCupoCheck.js";
import { lineAmountUsdSql } from "./cards/lineAmountSql.js";

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
  function feed(balances?: Parameters<typeof listing>[1], extraLines: ReturnType<typeof listingLine>[] = []) {
    return listing(
      [
        listingCard(
          BANK_ACCOUNT,
          [
            listingLine("2026-09-25", "VITEST TIENDA", 20_000),
            listingLine("2026-09-26", "VITEST APP", 12.34, { currency: "usd" }),
            ...extraLines,
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
        `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4, issuer)
         VALUES (?, 21, 20, ?, 'santander')`
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
      db.prepare(`DELETE FROM cc_billing_month_metrics WHERE account_id = ?`).run(id);
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
      foreign: { usd: { facturado: 900, open_cycle_lines: 12.34, total: 912.34 } },
    });

    const run = judgeLatestBankCupoCapture({ issuer: "santander" });
    expect(run.capture_error).toBeNull();
    expect(run.verdicts.map((v) => [v.snapshot.currency, v.status, v.diff, v.fresh])).toEqual([
      ["clp", "ok", 0, true],
      ["usd", "ok", 0, true],
    ]);
    expect(latestBankCupoForAccount(accountId)).toMatchObject({
      observed_at: "2026-10-02T00:59:40.000Z",
      currencies: [
        { currency: "clp", cupo_utilizado: BANK_CLP_USED, app_owed: BANK_CLP_USED, diff: 0, status: "ok" },
        { currency: "usd", cupo_utilizado: 912.34, app_owed: 912.34, diff: 0, status: "ok" },
      ],
    });

    // A second run on the same capture reports the stored verdicts, fresh no more.
    const again = judgeLatestBankCupoCapture({ issuer: "santander" });
    expect(again.capture?.already_checked).toBe(true);
    expect(again.verdicts.every((v) => !v.fresh)).toBe(true);
  });

  it("flags a card the app over-counts, then reports the recovery", () => {
    // The bank owes 3xx.xxx less than the app counts — a plan the bank never had.
    applyListing(feed(cupos(BANK_CLP_USED - 300_000)), "card-movements-vitest-1.json");
    const bad = judgeLatestBankCupoCapture({ issuer: "santander" });
    const clp = bad.verdicts.find((v) => v.snapshot.currency === "clp")!;
    expect(clp).toMatchObject({ status: "mismatch", diff: 300_000, tolerance: 0 });
    const report = formatBankCupoReport(bad.verdicts, () => "Vitest card");
    expect(report).toContain("CLP: bank $1.620.000 · app $1.920.000 · +$300.000 MISMATCH");
    expect(report).toContain("cuotas por facturar $400.000 (5)");
    expect(report).toContain("USD: bank US$912,34 · app US$912,34 · ±US$0,00 ok");

    applyListing(feed(cupos(BANK_CLP_USED, BANK_USD_USED, "2026-10-02T12:00:00.000Z")), "card-movements-vitest-2.json");
    const fixed = judgeLatestBankCupoCapture({ issuer: "santander" });
    expect(fixed.verdicts.every((v) => v.status === "ok")).toBe(true);
  });

  it("tolerates nothing: a peso or a cent apart is a mismatch", () => {
    applyListing(feed(cupos(BANK_CLP_USED - 1, BANK_USD_USED - 0.01)), "card-movements-vitest-round.json");
    const run = judgeLatestBankCupoCapture({ issuer: "santander" });
    expect(run.verdicts.map((v) => [v.snapshot.currency, v.status, v.diff, v.tolerance])).toEqual([
      ["clp", "mismatch", 1, 0],
      ["usd", "mismatch", 0.01, 0],
    ]);
  });

  it("counts each plan's printed principal less its billed cuotas, as the bank's saldo capital cuotas", () => {
    // Cuota 1 of each plan printed on the 25/08 statement (August billed, the rest not).
    const statementId = (
      db
        .prepare(`SELECT id FROM cc_statements WHERE account_id = ? AND currency = 'clp'`)
        .get(accountId) as { id: number }
    ).id;
    const plan = (key: string, iso: string, total: number, count: number, principal: number, cuota: number, rate: string): void => {
      const id = Number(
        db
          .prepare(
            `INSERT INTO cc_installment_purchases (
               account_id, card_group, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales, merchant, source
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pdf')`
          )
          .run(accountId, CARD_GROUP, `vitest-bank-cupo-${key}`, iso, total, count, `VITEST ${key}`).lastInsertRowid
      );
      const rowId = `vitest-bank-cupo-${key}|1`;
      db.prepare(
        `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, cuota_amount,
           installment_flag, nro_cuota_current, nro_cuota_total, interest_rate_text, parser_row_id)
         VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`
      ).run(statementId, `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`, `VITEST ${key}`, principal, cuota, count, rate, rowId);
      db.prepare(
        `INSERT INTO cc_installment_payments (purchase_id, pay_by_date, amount_clp, cuota_current, cuota_total,
           parser_row_id, statement_date, statement_period_month)
         VALUES (?, '2026-09-10', ?, 1, ?, ?, '25/08/2026', '2026-08')`
      ).run(id, cuota, count, rowId);
    };
    // Santander bills each cuota half up (120.006 / 12 = 10.000,5 → 10.001); the split rounded down
    // left 110.006 unbilled, a peso above the bank's 120.006 − 10.001.
    plan("santander-half-up", "2026-07-05", 120_006, 12, 120_006, 10_001, "0,00 %");
    // BCI stores «Total a pagar» = 18 × 1.000 = 18.000 but its principal is the printed 17.993:
    // summing the unbilled cuotas left 17.000, seven pesos above the bank's 17.993 − 1.000.
    plan("bci-total-a-pagar", "2026-07-06", 18_000, 18, 17_993, 1_000, "0,00% (T)");
    // 2,50 %: cuota 1 (40.000) carries 4.000 of interest, which is not principal.
    plan("interest", "2026-07-07", 120_000, 3, 108_000, 40_000, "2,50 %");

    const fixturePlans = 400_000;
    expect(installmentRemainderAfterFacturacionClp(accountId, "2026-08", "2026-10-02")).toEqual({
      amount_clp: fixturePlans + (120_006 - 10_001) + (17_993 - 1_000) + (108_000 - 40_000 + 4_000),
      cuotas: 5 + 11 + 17 + 2,
    });

    // So the bank's figure is the app's to the peso.
    const owed = ccOwedByCurrency(accountId, "2026-10-02");
    const snapshot: BankCupoSnapshot = {
      id: 1,
      account_id: accountId,
      currency: "clp",
      observed_at: "2026-10-02T00:59:40.000Z",
      plastic_last4: LAST4,
      cupo_total: 50_000_000,
      cupo_utilizado: owed.clp.total,
      cupo_disponible: 50_000_000 - owed.clp.total,
      feed_close_iso: null,
    };
    expect(judgeBankCupo(snapshot, owed)).toMatchObject({ status: "ok", diff: 0, tolerance: 0 });
  });

  it("splits Santander's unprinted cuotas half up, every other issuer's down", () => {
    expect(splitPrincipalIntoCuotaAmounts(120_006, 12, "round_half_up_last_absorbs")).toEqual([
      ...Array(11).fill(10_001),
      9_995,
    ]);
    expect(splitPrincipalIntoCuotaAmounts(120_006, 12)).toEqual([...Array(11).fill(10_000), 10_006]);
  });

  it("imports a row the listing shows twice as two charges, which the bank's cupo counts too", () => {
    // The feed is the whole unbilled list: two identical rows are two charges (a subscription
    // billed twice on one day), and the bank's utilizado counts both. Before 2026-10-11 the
    // second collapsed on the one-shot key and the check failed by exactly one charge.
    const twin = listingLine("2026-09-26", "VITEST APP", 12.34, { currency: "usd" });
    const ref = "card-movements-vitest-twins.json";
    const first = applyListing(feed(cupos(BANK_CLP_USED, BANK_USD_USED + 12.34), [twin]), ref);
    expect(first.accounts[0]).toMatchObject({ inserted: 3, skipped_duplicate: 0 });
    const usdLines = () =>
      (
        db
          .prepare(
            `SELECT l.dedupe_key FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
             WHERE s.account_id = ? AND ${lineAmountUsdSql("l")} = 12.34 ORDER BY l.id`
          )
          .all(accountId) as { dedupe_key: string }[]
      ).map((r) => r.dedupe_key);
    const keys = usdLines();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(`${keys[0]}#dup1`);

    const run = judgeLatestBankCupoCapture({ issuer: "santander" });
    expect(run.verdicts.map((v) => [v.snapshot.currency, v.status, v.diff])).toEqual([
      ["clp", "ok", 0],
      ["usd", "ok", 0],
    ]);
    expect(run.verdicts.find((v) => v.snapshot.currency === "usd")!.app_owed).toBe(924.68);

    // The next night lists the same two rows again: nothing new, nothing dropped.
    const again = applyListing(feed(cupos(BANK_CLP_USED, BANK_USD_USED + 12.34, "2026-10-02T12:00:00.000Z"), [twin]), "card-movements-vitest-twins-2.json");
    expect(again.accounts[0]).toMatchObject({ inserted: 0, skipped_duplicate: 3 });
    expect(usdLines()).toEqual(keys);
    // A listing that shows the row once again is the bank dropping one: the mirror removes one twin.
    const dropped = applyListing(feed(cupos(BANK_CLP_USED, BANK_USD_USED, "2026-10-02T13:00:00.000Z")), "card-movements-vitest-twins-3.json");
    expect(dropped.accounts[0]?.mirror?.removed).toHaveLength(1);
    expect(usdLines()).toHaveLength(1);
    expect(judgeLatestBankCupoCapture({ issuer: "santander" }).verdicts.every((v) => v.status === "ok")).toBe(true);
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
    const first = judgeLatestBankCupoCapture({ issuer: "santander" });
    expect(first.capture_error).toMatch(/no cruceProductosOnline call/);
    expect(first.capture?.already_checked).toBe(false);
    expect(judgeLatestBankCupoCapture({ issuer: "santander" }).capture?.already_checked).toBe(true);
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
