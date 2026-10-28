import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { db } from "./db.js";
import {
  closeDayOffsetDays,
  closeEvidenceForBillingMonth,
  ddMmYyyyFromIso,
  feedCloseStatementMismatches,
  nextPeriodStartIsoForBillingMonth,
  recordFeedBillingClose,
} from "./ccBillingCloses.js";
import {
  billingMonthContainingPurchase,
  billingMonthForManualLedgerPurchase,
  isProvisionallyClosedBillingMonth,
  lastClosedBillingMonthForAccount,
  lastPdfBillingMonthForAccount,
  pdfClosedBillingMonthsForAccount,
  statementCloseDdMmYyyyForBillingMonth,
  targetBillingMonthForManualImports,
} from "./ccManualBillingMonth.js";
import { feedLineBillingMonths } from "./cardUnbilledMovementsApply.js";
import { importCcWebPasteLines } from "./accountImports.js";
import {
  ccInstallmentsDbApiPayload,
  ccLedgerMonthEndIso,
  liveCreditCardOutstandingClp,
} from "./ccInstallmentLedgerDb.js";
import { ccInstallmentDebtDailyClp } from "./ccInstallmentDebtDaily.js";
import { creditCardInstallmentsResponse } from "./creditCardInstallments.js";
import { creditCardGroupLedgerResponse } from "./creditCardGroupLedger.js";
import { ccLedgerStatementClosingPointsClp } from "./ccCreditCardValuations.js";
import { invalidateCcBillingDetail } from "./aggregationCache.js";
import { buildBillingDetailByMonth, buildFacturaciones } from "./ccBillingViews.js";
import { usdBilledFromStatementLines } from "./ccUsdStatementBilled.js";
import { applyListing, listing, listingCard, listingLine } from "./test/cardListingPayloads.js";
import {
  facturacionMonthByStatementDate,
  reconcileOpenWebPasteAfterPdfClose,
  statementDatesForFacturacion,
} from "./ccOpenWebPastePdfReconcile.js";
import { buildCcExpenseLines } from "./flowsExpenses.js";
import { repairMisplacedOpenWebPasteBuckets } from "./ccOpenWebPasteRepair.js";
import { listCcBillingMonthBalances, recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import { ccWebPasteToCsvRecords, webPasteLineDedupeKey, type CcWebPasteLine } from "./ccWebPasteParse.js";

/**
 * Synthetic Santander card modelled on the September 2026 close: the August statement announces
 * «PRÓXIMO PERÍODO DE FACTURACIÓN 25/08/2026 24/09/2026», the feed of 2026-09-25 opens with a
 * SALDO INICIAL dated 24/09, and purchases dated the close day belong to October.
 */
const LAST4 = "9911";
const BANK_ACCOUNT = "800099990011";
const CARD_GROUP = "santander";

function ymdSlash(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${Number(d)}/${Number(m)}/${y}`;
}

describe("credit-card close evidence", () => {
  let accountId = 0;
  let tmpDir = "";
  const prevIdentifiers = process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS;

  function insertStatement(opts: {
    source: string;
    date: string;
    from?: string | null;
    to?: string | null;
    currency: "clp" | "usd";
    monto?: number | null;
    nextFrom?: string | null;
    nextTo?: string | null;
  }): number {
    return Number(
      db
        .prepare(
          `INSERT INTO cc_statements (
             account_id, card_group, source_pdf, statement_date, period_from, period_to,
             card_last4, layout, currency, monto_facturado, next_period_from, next_period_to
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'compact', ?, ?, ?, ?)`
        )
        .run(
          accountId,
          CARD_GROUP,
          opts.source,
          opts.date,
          opts.from ?? null,
          opts.to ?? null,
          LAST4,
          opts.currency,
          opts.monto ?? null,
          opts.nextFrom ?? null,
          opts.nextTo ?? null
        ).lastInsertRowid
    );
  }

  function insertLine(statementId: number, line: { date: string; merchant: string; clp?: number; usd?: number; key?: string }): number {
    return Number(
      db
        .prepare(
          `INSERT INTO cc_statement_lines (
             statement_id, transaction_date, merchant, amount_clp, amount_usd, installment_flag,
             dedupe_key, parser_row_id, raw_line
           ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'vitest')`
        )
        .run(
          statementId,
          line.date,
          line.merchant,
          line.clp ?? 0,
          line.usd ?? null,
          line.key ?? `vitest-${line.merchant}-${line.date}`,
          line.key ? `web:${line.key}` : null
        ).lastInsertRowid
    );
  }

  function webLine(dateIso: string, merchant: string, clp: number): CcWebPasteLine {
    return { transaction_date: dateIso, merchant, amount_clp: clp, amount_usd: null, currency: "clp", raw_line: merchant };
  }

  /** Bucket line with the exact key the feed/paste would give it (clp stored debt-positive). */
  function insertBucketLine(bucketId: number, dateIso: string, merchant: string, clp: number): number {
    return insertLine(bucketId, {
      date: ymdSlash(dateIso),
      merchant,
      clp,
      key: webPasteLineDedupeKey(CARD_GROUP, webLine(dateIso, merchant, -clp)),
    });
  }

  function bucketId(billingMonth: string): number | null {
    const row = db
      .prepare(`SELECT id FROM cc_statements WHERE account_id = ? AND source_pdf = ?`)
      .get(accountId, `import:web-paste|open|${billingMonth}`) as { id: number } | undefined;
    return row?.id ?? null;
  }

  function merchantsIn(statementId: number | null): string[] {
    if (statementId == null) return [];
    return (
      db.prepare(`SELECT merchant FROM cc_statement_lines WHERE statement_id = ? ORDER BY merchant`).all(statementId) as {
        merchant: string;
      }[]
    ).map((r) => r.merchant);
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T15:00:00Z")); // 12:00 Chile, two days after the close
    const bucket = db
      .prepare(`SELECT id FROM asset_groups WHERE slug IN ('credit_card', 'credit_cards__credit_card') LIMIT 1`)
      .get() as { id: number };
    const importKey = `credit_card_master|santander|vitest-close-evidence-${LAST4}`;
    accountId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'Vitest · close evidence', ?, ?)`)
        .run(bucket.id, importKey, importKey).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4)
       VALUES (?, 21, 20, ?)`
    ).run(accountId, LAST4);
    // August, closed by its statements; the CLP one announces September's close.
    insertStatement({
      source: "vitest 2026-08-25 clp.pdf",
      date: "25/08/2026",
      from: "23/07/2026",
      to: "25/08/2026",
      currency: "clp",
      monto: 3_476_163,
      nextFrom: "25/08/2026",
      nextTo: "24/09/2026",
    });
    insertStatement({
      source: "vitest 2026-08-25 usd.pdf",
      date: "25/08/2026",
      from: "23/07/2026",
      to: "25/08/2026",
      currency: "usd",
      monto: 556.21,
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vitest-close-evidence-"));
    const identifiers = path.join(tmpDir, "organize-identifiers.json");
    fs.writeFileSync(identifiers, JSON.stringify({ santander_80_account_to_card_last4: { [BANK_ACCOUNT]: LAST4 } }));
    process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS = identifiers;
  });

  afterEach(() => {
    vi.useRealTimers();
    db.prepare(
      `DELETE FROM cc_installment_payments WHERE purchase_id IN (SELECT id FROM cc_installment_purchases WHERE account_id = ?)`
    ).run(accountId);
    db.prepare(`DELETE FROM cc_installment_purchases WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM cc_feed_billing_closes WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM cc_billing_month_balances WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM import_batches WHERE raw_text LIKE ?`).run(`%"account_id":${accountId},%`);
    db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevIdentifiers == null) delete process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS;
    else process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS = prevIdentifiers;
  });

  it("reads the announced close and Santander's close-day rule from the statement", () => {
    expect(closeEvidenceForBillingMonth(accountId, "2026-09")).toEqual({
      close_iso: "2026-09-24",
      source: "announced",
    });
    expect(closeDayOffsetDays(accountId)).toBe(0);
    expect(nextPeriodStartIsoForBillingMonth(accountId, "2026-09")).toEqual({
      iso: "2026-09-24",
      source: "announced",
    });
    expect(closeEvidenceForBillingMonth(accountId, "2026-10").source).toBe("estimated");
    // The open bucket stays keyed on the config close — an identity, never the real date.
    expect(statementCloseDdMmYyyyForBillingMonth(accountId, "2026-09")).toBe("20/09/2026");
  });

  it("estimates an unpublished close on the card's latest close day, the config cycle only with none on record", () => {
    // Latest known close: September's, announced for 24/09 — later months carry the 24th.
    expect(closeEvidenceForBillingMonth(accountId, "2026-10")).toEqual({ close_iso: "2026-10-24", source: "estimated" });
    expect(closeEvidenceForBillingMonth(accountId, "2027-02")).toEqual({ close_iso: "2027-02-24", source: "estimated" });
    // A later observed close on the 31st moves the estimate, clamped to a shorter month.
    recordFeedBillingClose(accountId, {
      close_iso: "2026-10-31",
      saldo_inicial_clp: 100_000,
      saldo_inicial_usd: null,
      source_file: "vitest",
    });
    expect(closeEvidenceForBillingMonth(accountId, "2026-11")).toEqual({ close_iso: "2026-11-30", source: "estimated" });
    // The open bucket keeps the config close as its identity either way.
    expect(statementCloseDdMmYyyyForBillingMonth(accountId, "2026-11")).toBe("20/11/2026");
    db.prepare(`DELETE FROM cc_feed_billing_closes WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(accountId);
    expect(closeEvidenceForBillingMonth(accountId, "2026-10")).toEqual({ close_iso: "2026-10-20", source: "estimated" });
  });

  it("closes a CLP-only month once the bank has closed a later facturación, never inside the twins' window", () => {
    // July: CLP only — a dollar-quiet cycle. August's statements are later: its twin is not coming.
    insertStatement({
      source: "vitest 2026-07-23 clp.pdf",
      date: "23/07/2026",
      from: "24/06/2026",
      to: "23/07/2026",
      currency: "clp",
      monto: 900_000,
    });
    expect(pdfClosedBillingMonthsForAccount(accountId).has("2026-07")).toBe(true);
    expect(buildFacturaciones(accountId, []).find((f) => f.billing_month === "2026-07")).toMatchObject({
      is_open_month: false,
      facturado_clp: 900_000,
    });
    // September's CLP twin lands first: nothing later is closed, so its USD twin is still due.
    insertStatement({
      source: "vitest 2026-09-24 clp.pdf",
      date: "24/09/2026",
      from: "25/08/2026",
      to: "24/09/2026",
      currency: "clp",
      monto: 1_892_666,
      nextFrom: "24/09/2026",
      nextTo: "24/10/2026",
    });
    expect(pdfClosedBillingMonthsForAccount(accountId).has("2026-09")).toBe(false);
    expect(lastPdfBillingMonthForAccount(accountId)).toBe("2026-08");
    // Once the October close it announced has passed, September's twin is not coming either.
    vi.setSystemTime(new Date("2026-10-25T15:00:00Z"));
    expect(pdfClosedBillingMonthsForAccount(accountId).has("2026-09")).toBe(true);
    expect(lastPdfBillingMonthForAccount(accountId)).toBe("2026-09");
  });

  it("gives a card that stopped billing no provisional facturación for a close it announced", () => {
    // Nothing billed since August and nothing owed: the announced September close has passed, but
    // no statement is coming, so the month is not «closed, statement pending» on the card's table.
    expect(isProvisionallyClosedBillingMonth(accountId, "2026-09")).toBe(true);
    expect(buildFacturaciones(accountId, []).map((f) => f.billing_month)).toEqual(["2026-08"]);
    // Nor an open facturación: a card that stopped billing has no next cycle.
    expect(buildBillingDetailByMonth(accountId, []).map((d) => d.billing_month)).toEqual(["2026-08"]);
  });

  it("gives each statement's lines one facturación: a stale bucket's the open month, a provisional month's bucket its own", () => {
    // August closed by its statements; September closed at the bank, CLP statement pending; October open.
    const aug = insertStatement({ source: "import:web-paste|open|2026-08", date: "20/08/2026", currency: "clp" });
    const sep = insertStatement({ source: "import:web-paste|open|2026-09", date: "20/09/2026", currency: "clp" });
    const leftover = insertBucketLine(aug, "2026-08-10", "LEFTOVER VITEST", 3_000);
    const september = insertBucketLine(sep, "2026-09-11", "PAYU VITEST", 13_993);
    expect(Object.fromEntries(facturacionMonthByStatementDate(accountId))).toEqual({
      "25/08/2026": "2026-08",
      "20/08/2026": "2026-10",
      "20/09/2026": "2026-09",
    });
    expect(statementDatesForFacturacion(accountId, "2026-10")).toEqual(["20/08/2026"]);
    // The expense lines carry the same month — what the facturación modal filters on.
    const lines = new Map(buildCcExpenseLines([accountId]).map((l) => [l.statement_line_id, l]));
    expect(lines.get(september)).toMatchObject({ billing_month: "2026-09", web_paste: true });
    expect(lines.get(leftover)).toMatchObject({ billing_month: "2026-10", web_paste: true });
    // Two statements on one date in different facturaciones is a data contradiction.
    insertStatement({ source: "vitest conflicting.pdf", date: "25/08/2026", to: "24/07/2026", currency: "clp" });
    expect(() => facturacionMonthByStatementDate(accountId)).toThrow(/belong to 2026-0\d and 2026-0\d/);
  });

  it("creates the open bucket only when a post-close line moves into it", () => {
    // Every card merge runs the repair; with nothing to move it must leave no empty bucket.
    expect(repairMisplacedOpenWebPasteBuckets(accountId).lines_moved).toBe(0);
    expect(bucketId("2026-10")).toBeNull();
    const sept = insertStatement({ source: "import:web-paste|open|2026-09", date: "20/09/2026", currency: "clp" });
    insertBucketLine(sept, "2026-09-25", "POSTCLOSE VITEST", 12_000);
    expect(repairMisplacedOpenWebPasteBuckets(accountId).lines_moved).toBe(1);
    expect(merchantsIn(bucketId("2026-10"))).toEqual(["POSTCLOSE VITEST"]);
  });

  it("puts a purchase in the bank's cycle, not the config's 21→20", () => {
    // August closed on 25/08 and announced September's close for 24/09; Santander starts each
    // cycle ON the previous close day.
    expect(billingMonthContainingPurchase(accountId, "2026-08-24")).toBe("2026-08");
    expect(billingMonthContainingPurchase(accountId, "2026-08-25")).toBe("2026-09");
    expect(billingMonthContainingPurchase(accountId, "2026-09-22")).toBe("2026-09");
    expect(billingMonthContainingPurchase(accountId, "2026-09-24")).toBe("2026-10");
    // A hand-entered plan bought on 22/09 — after the config's 20th, before the real close — bills
    // its first cuota at the 24/09 close, and the purchase table files it under September.
    db.prepare(
      `INSERT INTO cc_installment_purchases (
         account_id, card_group, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales,
         merchant, description_merged, source
       ) VALUES (?, ?, 'vitest-close-evidence-cycle', '2026-09-22', 60000, 2, 'VITEST CYCLE', 'VITEST CYCLE', 'manual')`
    ).run(accountId, CARD_GROUP);
    const plan = ccInstallmentsDbApiPayload(accountId).purchases.find((p) => p.label === "VITEST CYCLE");
    expect(plan).toMatchObject({ purchase_billing_month: "2026-09", first_due_month: "2026-09" });
  });

  it("closes the month once its announced next cycle has started, without touching schedule evidence", () => {
    expect(lastClosedBillingMonthForAccount(accountId, "2026-09-23")).toBe("2026-08");
    expect(lastClosedBillingMonthForAccount(accountId, "2026-09-24")).toBe("2026-09");
    expect(billingMonthForManualLedgerPurchase(accountId)).toBe("2026-10");
    expect(isProvisionallyClosedBillingMonth(accountId, "2026-09")).toBe(true);
    expect(lastPdfBillingMonthForAccount(accountId)).toBe("2026-08");
  });

  /**
   * One dólar for every day of [from, to], restored afterwards. A facturación's dollars are worth
   * the rate the bank was paid (today's while unpaid) on its row and the pay-by − 1 rate as debt,
   * so a test equating the two must give both days the same rate rather than inherit the test
   * DB's series.
   */
  function pinFx(fromIso: string, toIso: string, clpPerUsd: number): () => void {
    const prior = db.prepare(`SELECT date, clp_per_usd FROM fx_daily WHERE date BETWEEN ? AND ?`).all(fromIso, toIso) as {
      date: string;
      clp_per_usd: number;
    }[];
    const upsert = db.prepare(
      `INSERT INTO fx_daily (date, clp_per_usd) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET clp_per_usd = excluded.clp_per_usd`
    );
    for (let d = fromIso; d <= toIso; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
      upsert.run(d, clpPerUsd);
    }
    return () => {
      db.prepare(`DELETE FROM fx_daily WHERE date BETWEEN ? AND ?`).run(fromIso, toIso);
      for (const r of prior) upsert.run(r.date, r.clp_per_usd);
    };
  }

  it("closes September on the feed's SALDO INICIAL and files every post-close row under October", () => {
    // September's pay-by falls around 10/10; today (faked) is 26/09.
    const restoreFx = pinFx("2026-09-20", "2026-10-15", 950);
    onTestFinished(restoreFx);
    const sept = insertStatement({
      source: "import:web-paste|open|2026-09",
      date: "20/09/2026",
      currency: "clp",
    });
    insertBucketLine(sept, "2026-09-03", "SUPERMERCADO VITEST", 10_000);
    insertBucketLine(sept, "2026-09-23", "FARMACIA VITEST", 5_000);
    // Close-day purchase and a pending authorization that settled after the close: the bank's
    // post-close feed lists both as unbilled, so both must follow it to October.
    insertBucketLine(sept, "2026-09-24", "CLINICA VITEST", 2_400);
    insertBucketLine(sept, "2026-09-22", "PENDIENTE VITEST", 7_000);

    const result = applyListing(
      listing([
        listingCard(
          BANK_ACCOUNT,
          [
            listingLine("2026-09-24", "CLINICA VITEST", 2_400),
            listingLine("2026-09-22", "PENDIENTE VITEST", 7_000),
            listingLine("2026-09-25", "SWITCH VITEST", 15_500),
          ],
          { date: "2026-09-24", clp: 1_892_666, usd: 577.34 }
        ),
      ]),
      "card-movements-2026-09-25T15-55-26.json"
    );
    const imported = result.accounts[0]!;
    expect(imported.inserted).toBe(1);
    expect(imported.feed_close).toMatchObject({
      close_iso: "2026-09-24",
      billing_month: "2026-09",
      status: "new",
      saldo_inicial_clp: 1_892_666,
      saldo_inicial_usd: 577.34,
      rows_billing_month: "2026-10",
      lines_moved_forward: 2,
    });

    expect(merchantsIn(bucketId("2026-09"))).toEqual(["FARMACIA VITEST", "SUPERMERCADO VITEST"]);
    expect(merchantsIn(bucketId("2026-10"))).toEqual(["CLINICA VITEST", "PENDIENTE VITEST", "SWITCH VITEST"]);
    expect(closeEvidenceForBillingMonth(accountId, "2026-09").source).toBe("feed");

    const ledger = ccInstallmentsDbApiPayload(accountId);
    const facturaciones = buildFacturaciones(accountId, ledger.months);
    const september = facturaciones.find((f) => f.billing_month === "2026-09")!;
    expect(september).toMatchObject({
      is_open_month: false,
      is_provisional_close: true,
      close_date: "24/09/2026",
      close_date_iso: "2026-09-24",
      close_date_source: "feed",
      facturado_clp: 1_892_666,
      facturado_usd: 577.34,
      provisional_estimate_total_clp: 15_000,
    });
    expect(september.facturado_total_clp).toBe(1_892_666 + (september.facturado_usd_clp ?? 0));
    expect(september.facturado_usd_clp).toBeGreaterThan(0);
    const october = facturaciones.find((f) => f.billing_month === "2026-10")!;
    expect(october).toMatchObject({ is_open_month: true, is_provisional_close: false, close_date_source: "estimated" });

    const detail = buildBillingDetailByMonth(accountId, ledger.months);
    expect(detail.find((d) => d.billing_month === "2026-09")).toMatchObject({
      as_of_kind: "statement",
      as_of_date: "2026-09-24",
      provisional: true,
      total_facturado_clp: september.facturado_total_clp,
    });

    // The feed repeats the same close every day; a different figure for it is a contradiction.
    expect(recordFeedBillingClose(accountId, {
      close_iso: "2026-09-24",
      saldo_inicial_clp: 1_892_666,
      saldo_inicial_usd: 577.34,
      source_file: "repeat",
    }).status).toBe("seen");
    expect(() =>
      recordFeedBillingClose(accountId, {
        close_iso: "2026-09-24",
        saldo_inicial_clp: 1_892_000,
        saldo_inicial_usd: 577.34,
        source_file: "changed",
      })
    ).toThrow(/SALDO INICIAL .* changed/);
  });

  it("files a close-day row under the next cycle while the listing still opens with the previous close", () => {
    // The evening of the announced close day: the bank rolls the unbilled list the night AFTER a
    // close, so this listing still opens with August's SALDO INICIAL (every row's default month
    // is September) while a purchase dated 24/09 already bills in October (Santander starts the
    // next cycle ON the close day). 21:30 Chile on 24/09.
    vi.setSystemTime(new Date("2026-09-25T00:30:00Z"));
    const restoreFx = pinFx("2026-08-20", "2026-10-15", 950);
    onTestFinished(restoreFx);
    // A pending authorization of the close day the previous listing had filed under September.
    const sept = insertStatement({ source: "import:web-paste|open|2026-09", date: "20/09/2026", currency: "clp" });
    insertBucketLine(sept, "2026-09-03", "SUPERMERCADO VITEST", 10_000);
    insertBucketLine(sept, "2026-09-24", "PENDIENTE VITEST", 7_000);

    const result = applyListing(
      listing([
        listingCard(
          BANK_ACCOUNT,
          [
            listingLine("2026-09-03", "SUPERMERCADO VITEST", 10_000),
            listingLine("2026-09-23", "FARMACIA VITEST", 5_000),
            listingLine("2026-09-24", "CLINICA VITEST", 2_400),
            listingLine("2026-09-24", "PENDIENTE VITEST", 7_000),
          ],
          { date: "2026-08-25", clp: 3_476_163, usd: 556.21 }
        ),
      ]),
      "card-movements-2026-09-25T00-30-00.json"
    );
    const imported = result.accounts[0]!;
    expect(imported.inserted).toBe(2);
    expect(imported.feed_close).toMatchObject({
      close_iso: "2026-08-25",
      billing_month: "2026-08",
      rows_billing_month: "2026-09",
      lines_in_later_cycle: 2,
      lines_moved_forward: 1,
    });
    expect(merchantsIn(bucketId("2026-09"))).toEqual(["FARMACIA VITEST", "SUPERMERCADO VITEST"]);
    expect(merchantsIn(bucketId("2026-10"))).toEqual(["CLINICA VITEST", "PENDIENTE VITEST"]);
    expect(bucketId("2026-11")).toBeNull();

    // The next night's listing has rolled: it opens with September's close and lists only the
    // October rows, which are already where they belong — nothing moves, nothing imports twice.
    vi.setSystemTime(new Date("2026-09-26T00:30:00Z"));
    const rolled = applyListing(
      listing([
        listingCard(
          BANK_ACCOUNT,
          [listingLine("2026-09-24", "CLINICA VITEST", 2_400), listingLine("2026-09-24", "PENDIENTE VITEST", 7_000)],
          { date: "2026-09-24", clp: 1_892_666, usd: 577.34 }
        ),
      ]),
      "card-movements-2026-09-26T00-30-00.json"
    ).accounts[0]!;
    expect(rolled.inserted).toBe(0);
    expect(rolled.feed_close).toMatchObject({ rows_billing_month: "2026-10", lines_in_later_cycle: 0, lines_moved_forward: 0 });
    expect(merchantsIn(bucketId("2026-10"))).toEqual(["CLINICA VITEST", "PENDIENTE VITEST"]);
  });

  it("routes each feed row by its own cycle, never before the feed's month, and refuses a row without a date", () => {
    // Santander: the next cycle starts ON the close day (the August statement prints 25/08 → 25/08).
    expect(
      feedLineBillingMonths(
        accountId,
        [
          webLine("2026-08-24", "ATRASADA VITEST", 1_000), // a pending row from before the close: unbilled, so the feed's month
          webLine("2026-09-23", "FARMACIA VITEST", 5_000),
          webLine("2026-09-24", "CLINICA VITEST", 2_400),
        ],
        "2026-09"
      )
    ).toEqual(["2026-09", "2026-09", "2026-10"]);
    expect(() => feedLineBillingMonths(accountId, [webLine("24/09/2026", "SIN FECHA VITEST", 1)], "2026-09")).toThrow(
      /bad date/
    );

    // BCI-style close-day rule: the next cycle starts the day AFTER the close (26/08 → 27/08).
    db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(accountId);
    insertStatement({
      source: "vitest bci-style 2026-08-26 clp.pdf",
      date: "26/08/2026",
      from: "27/07/2026",
      to: "26/08/2026",
      currency: "clp",
      monto: 1_000_000,
      nextFrom: "27/08/2026",
      nextTo: "26/09/2026",
    });
    expect(
      feedLineBillingMonths(
        accountId,
        [webLine("2026-09-26", "CIERRE VITEST", 1_000), webLine("2026-09-27", "SIGUIENTE VITEST", 2_000)],
        "2026-09"
      )
    ).toEqual(["2026-09", "2026-10"]);
  });

  it("keeps the hand paste in the open month whatever the lines' dates", () => {
    // Faked today is 26/09, past the announced 24/09 close: the open month is October, and a
    // paste files every line there — a line dated inside September's cycle included.
    const openMonth = targetBillingMonthForManualImports(accountId, LAST4);
    expect(openMonth).toBe("2026-10");
    const result = importCcWebPasteLines(accountId, {
      lines: [webLine("2026-09-03", "PASTE SEPT VITEST", -10_000), webLine("2026-09-25", "PASTE OCT VITEST", -2_400)],
      errors: [],
    });
    expect(result.inserted).toBe(2);
    expect(bucketId("2026-09")).toBeNull();
    expect(merchantsIn(bucketId(openMonth))).toEqual(["PASTE OCT VITEST", "PASTE SEPT VITEST"]);

    // A per-line month list that does not cover the lines is a caller bug, not a guess.
    expect(() =>
      ccWebPasteToCsvRecords(accountId, CARD_GROUP, LAST4, "vitest00", [webLine("2026-09-25", "X", -1)], {
        lineBillingMonths: ["2026-10", "2026-11"],
      })
    ).toThrow(/1 line\(s\)/);
  });

  function insertSeptemberPlan() {
    // A 3 × 3x.xxx plan whose first cuota bills at the September close (24/09, due 10/10).
    db.prepare(
      `INSERT INTO cc_installment_purchases (
         account_id, card_group, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales,
         merchant, description_merged, source, first_due_month
       ) VALUES (?, ?, 'vitest-close-evidence-plan', '2026-09-10', 90000, 3, 'VITEST PLAN', 'VITEST PLAN', 'manual', '2026-09')`
    ).run(accountId, CARD_GROUP);
    // Every card write ends with this; it writes the open month's snapshot row.
    recomputeCcBillingMonthBalances(accountId);
  }

  it("values a closed month with the plan remainder and the open month with what is still unbilled", () => {
    // After the close the September cuota rides inside September's facturado. The live cupo
    // learns a cuota was billed from the statement that prints it, so until September's arrives
    // it still holds that cuota: handing September the live figure counted it twice, and so did
    // October's row until it subtracted what the provisional close billed.
    insertSeptemberPlan();
    const ledger = ccInstallmentsDbApiPayload(accountId);
    const detail = buildBillingDetailByMonth(accountId, ledger.months);
    const september = detail.find((d) => d.billing_month === "2026-09")!;
    const october = detail.find((d) => d.billing_month === "2026-10")!;
    expect(september).toMatchObject({ provisional: true, cuota_a_pagar_next_mes_clp: 30_000, cupo_statement_clp: 60_000 });
    expect(september.balance_statement_clp).toBe((september.total_facturado_clp ?? 0) + 60_000);
    expect(liveCreditCardOutstandingClp(accountId)).toBe(90_000);
    expect(october.cupo_statement_clp).toBe(60_000);
  });

  it("stores the detalle's cupo and saldo in the balances snapshot, the open month's bucket included", () => {
    insertSeptemberPlan();
    // An October purchase already sits in the open bucket, so October has a statement slot too.
    const october = insertStatement({ source: "import:web-paste|open|2026-10", date: "20/10/2026", currency: "clp" });
    insertBucketLine(october, "2026-09-25", "SWITCH VITEST", 15_500);
    recomputeCcBillingMonthBalances(accountId);

    const detail = creditCardInstallmentsResponse(accountId).billing_detail_by_month ?? [];
    const stored = listCcBillingMonthBalances(accountId);
    expect(stored.map((r) => `${r.billing_month} ${r.as_of_kind}`).sort()).toEqual([
      "2026-08 statement",
      "2026-10 manual",
      "2026-10 statement",
    ]);
    for (const row of stored) {
      const d = detail.find((x) => x.billing_month === row.billing_month)!;
      expect(row.cupo_utilizado_clp).toBe(d.cupo_statement_clp);
      expect(row.saldo_total_clp).toBe(d.balance_statement_clp);
    }
    // The open month's bucket row carries every cuota still unbilled — the snapshot used to store
    // the plan remainder after October there (3x.xxx), keyed on the calendar month.
    const octoberBucket = stored.find((r) => r.billing_month === "2026-10" && r.as_of_kind === "statement")!;
    expect(octoberBucket.cupo_utilizado_clp).toBe(60_000);
  });

  it("plots the monthly «deuda en cuotas» where the daily line sits at each month-end", () => {
    insertSeptemberPlan();
    const chart = creditCardInstallmentsResponse(accountId).historial_chart ?? [];
    const line = (month: string) => chart.find((p) => p.month === month)?.cupo_en_cuotas_clp;
    // Billed on 24/09 but unpaid until 10/10: still debt at 30/09 (the September row's STATEMENT
    // cupo, 6x.xxx, has the cuota inside its facturado instead).
    expect(line("2026-09")).toBe(90_000);
    expect(line("2026-10")).toBe(60_000);
    expect(line("2026-11")).toBe(30_000);
    const months = chart.map((p) => p.month);
    const daily = ccInstallmentDebtDailyClp(accountId, months.map(ccLedgerMonthEndIso));
    expect(chart.map((p) => p.cupo_en_cuotas_clp)).toEqual(daily);
  });

  /** Every detalle row's month frame equals the historial chart point of its month. */
  function expectDetalleShowsChart(response: ReturnType<typeof creditCardInstallmentsResponse>): void {
    const chart = new Map((response.historial_chart ?? []).map((p) => [p.month, p] as const));
    const rows = response.billing_detail_by_month ?? [];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const point = chart.get(row.billing_month);
      expect(point, `chart point for ${row.billing_month}`).toBeDefined();
      expect([row.billing_month, row.cupo_en_cuotas_clp, row.balance_total_clp]).toEqual([
        row.billing_month,
        point!.cupo_en_cuotas_clp,
        point!.balance_total_clp,
      ]);
    }
  }

  it("the detalle table shows the chart's lines; the statement frame stays beside them", () => {
    insertSeptemberPlan();
    const response = creditCardInstallmentsResponse(accountId);
    expectDetalleShowsChart(response);
    const rows = response.billing_detail_by_month ?? [];
    const september = rows.find((r) => r.billing_month === "2026-09")!;
    // Month frame on the 30th: the September cuota is billed but unpaid until 10/10, so all
    // three cuotas are still plan debt; the statement frame keeps the post-close remainder.
    expect(september).toMatchObject({ cupo_en_cuotas_clp: 90_000, cupo_statement_clp: 60_000 });
    expect(september.balance_statement_clp).toBe((september.total_facturado_clp ?? 0) + 60_000);
    expect(september.balance_total_clp).not.toBeNull();
    // A projected month reads the plan tail: owed at month-end, cuota 3 after cuota 2's pay-by.
    const november = rows.find((r) => r.billing_month === "2026-11")!;
    expect(november).toMatchObject({ projected: true, cupo_en_cuotas_clp: 30_000, balance_total_clp: 30_000 });
    // The stored month-end anchors read the statement frame, unchanged by the overlay.
    const anchors = new Map(ccLedgerStatementClosingPointsClp(accountId)!.map((p) => [p.as_of_date, p.value_clp]));
    expect(anchors.get("2026-09-30")).toBe(Math.round(september.balance_statement_clp));
  });

  /** An October purchase in the open bucket, so October has a facturación row (the open month). */
  function insertOctoberBucket() {
    const october = insertStatement({ source: "import:web-paste|open|2026-10", date: "20/10/2026", currency: "clp" });
    insertBucketLine(october, "2026-09-25", "SWITCH VITEST", 15_500);
    recomputeCcBillingMonthBalances(accountId);
  }

  it("facturaciones carry the cuotas left unbilled after each close, the open month by the same rule", () => {
    insertSeptemberPlan();
    insertOctoberBucket();
    const facturaciones = creditCardInstallmentsResponse(accountId).facturaciones ?? [];
    const by = (month: string) => facturaciones.find((f) => f.billing_month === month)!;
    // August closed before the plan was bought (10/09): nothing of it was left unbilled then.
    expect(by("2026-08").deuda_en_cuotas_clp).toBe(0);
    // September (provisional close) billed cuota 1: two left.
    expect(by("2026-09")).toMatchObject({ is_provisional_close: true, deuda_en_cuotas_clp: 60_000 });
    // The open month reads the post-close rule too — never the live cupo (90.000 − the provisional
    // close's 30.000 = 60.000, the detalle's open-row figure).
    expect(by("2026-10")).toMatchObject({ is_open_month: true, deuda_en_cuotas_clp: 30_000 });
    // The open bucket holds no dollar line: US$0 billed so far, never «—»; the CLP side is whole.
    expect(by("2026-10")).toMatchObject({ facturado_usd: 0, facturado_usd_clp: 0 });
    expect(by("2026-10").facturado_total_clp).toBe(by("2026-10").facturado_clp);
    const detail = buildBillingDetailByMonth(accountId, ccInstallmentsDbApiPayload(accountId).months);
    expect(detail.find((d) => d.billing_month === "2026-10")?.cupo_statement_clp).toBe(60_000);
    // A card with no plan ledger has no figure to show.
    db.prepare(`DELETE FROM cc_installment_purchases WHERE account_id = ?`).run(accountId);
    invalidateCcBillingDetail(accountId);
    expect(buildFacturaciones(accountId, []).map((f) => f.deuda_en_cuotas_clp)).toEqual([null, null, null]);
  });

  it("a group's merged detalle rows show the group chart's lines", () => {
    insertSeptemberPlan();
    insertOctoberBucket();
    // File the card under the Santander issuer so the Pasivos group pages sum it with the vitest master.
    const santander = db.prepare(`SELECT id FROM credit_card_groups WHERE slug = 'santander'`).get() as { id: number };
    db.prepare(
      `INSERT INTO credit_card_group_items (group_id, item_kind, account_id, sort_order) VALUES (?, 'account', ?, 99)`
    ).run(santander.id, accountId);
    onTestFinished(() => {
      db.prepare(`DELETE FROM credit_card_group_items WHERE account_id = ?`).run(accountId);
    });
    const group = creditCardGroupLedgerResponse("liabilities_credit_card");
    expect(group.account_id).toBe(0);
    expectDetalleShowsChart(group);
    // The merged September row carries this card's three unpaid cuotas on top of the other masters'.
    const september = group.billing_detail_by_month!.find((r) => r.billing_month === "2026-09")!;
    const own = creditCardInstallmentsResponse(accountId).billing_detail_by_month!.find((r) => r.billing_month === "2026-09")!;
    expect(september.cupo_en_cuotas_clp!).toBeGreaterThanOrEqual(own.cupo_en_cuotas_clp!);
    expect(group.facturaciones!.find((f) => f.billing_month === "2026-10")!.deuda_en_cuotas_clp).toBeGreaterThanOrEqual(30_000);
  });

  /**
   * The night before the September close: the plan is on file and the snapshot's open month is
   * still September. Nothing is written again until a line lands, so on the close day the open
   * month (October) has neither a bucket nor a snapshot row.
   */
  function insertSeptemberPlanBeforeTheClose() {
    vi.setSystemTime(new Date("2026-09-23T15:00:00Z"));
    insertSeptemberPlan();
    expect(listCcBillingMonthBalances(accountId).map((r) => `${r.billing_month} ${r.as_of_kind}`).sort()).toEqual([
      "2026-08 statement",
      "2026-09 manual",
    ]);
    vi.setSystemTime(new Date("2026-09-24T15:00:00Z")); // 12:00 Chile on the announced close day
    invalidateCcBillingDetail(accountId);
    expect(billingMonthForManualLedgerPurchase(accountId)).toBe("2026-10");
    expect(bucketId("2026-10")).toBeNull();
  }

  it("the open facturación exists from the close day, before any line or snapshot row lands in it", () => {
    insertSeptemberPlanBeforeTheClose();
    const response = creditCardInstallmentsResponse(accountId);

    // The facturaciones carry the open month: its cuota is its facturado for now, closing on the
    // card's close day carried into October (September's statement, which would announce it, is
    // not in yet), paid by the 10th after that.
    const open = response.facturaciones!.filter((f) => f.is_open_month);
    expect(open.map((f) => f.billing_month)).toEqual(["2026-10"]);
    // Nothing billed in dollars so far is US$0, not «—» (a closed month with no USD statement).
    expect(open[0]).toMatchObject({
      facturado_clp: 30_000,
      facturado_usd: 0,
      facturado_usd_clp: 0,
      facturado_total_clp: 30_000,
      cuota_a_pagar_clp: 30_000,
      deuda_en_cuotas_clp: 30_000,
      close_date: "24/10/2026",
      close_date_iso: "2026-10-24",
      close_date_source: "estimated",
      pay_by: "10/11/2026",
      pay_by_iso: "2026-11-10",
      is_provisional_close: false,
    });
    expect(response.facturaciones!.find((f) => f.billing_month === "2026-09")).toMatchObject({
      is_open_month: false,
      is_provisional_close: true,
    });

    // The detalle has October as the open row — not a plan projection — as of today, with the
    // live cupo net of what the provisional close billed and September's balance rolled forward.
    const rows = response.billing_detail_by_month!;
    expect(rows.filter((r) => r.billing_month === "2026-10")).toHaveLength(1);
    const october = rows.find((r) => r.billing_month === "2026-10")!;
    const september = rows.find((r) => r.billing_month === "2026-09")!;
    expect(october.projected).toBeUndefined();
    expect(october).toMatchObject({
      as_of_kind: "manual",
      as_of_date: "2026-09-24",
      total_facturado_clp: 30_000,
      cuota_a_pagar_next_mes_clp: 30_000,
      cupo_statement_clp: 60_000,
      balance_statement_clp: september.balance_statement_clp,
    });
    expect(september).toMatchObject({ provisional: true, as_of_kind: "statement" });
    // The month frame beside it: the chart's lines sampled on the same months.
    expectDetalleShowsChart(response);
    expect(october.cupo_en_cuotas_clp).toBe(60_000);
    expect(rows.find((r) => r.billing_month === "2026-11")).toMatchObject({ projected: true });

    // The next card write stamps the snapshot row the detalle already stood for.
    const facturacionesBefore = response.facturaciones!;
    recomputeCcBillingMonthBalances(accountId);
    const stored = listCcBillingMonthBalances(accountId).find(
      (r) => r.billing_month === "2026-10" && r.as_of_kind === "manual"
    )!;
    expect([stored.as_of_date, stored.cupo_utilizado_clp, stored.saldo_total_clp]).toEqual([
      "2026-09-24",
      october.cupo_statement_clp,
      october.balance_statement_clp,
    ]);
    const after = creditCardInstallmentsResponse(accountId);
    expect(after.facturaciones).toEqual(facturacionesBefore);
    expect(after.billing_detail_by_month!.find((r) => r.billing_month === "2026-10")).toEqual(october);
  });

  it("the bucket takes the open row over once a line lands in it: one October row, same shape", () => {
    insertSeptemberPlanBeforeTheClose();
    const before = creditCardInstallmentsResponse(accountId);
    const october = insertStatement({ source: "import:web-paste|open|2026-10", date: "20/10/2026", currency: "clp" });
    insertBucketLine(october, "2026-09-24", "CLOSE DAY VITEST", 15_500);
    invalidateCcBillingDetail(accountId);
    const after = creditCardInstallmentsResponse(accountId);

    const openRows = after.facturaciones!.filter((f) => f.billing_month === "2026-10");
    expect(openRows).toHaveLength(1);
    const { facturado_clp: _clp, facturado_total_clp: _total, ...shape } = openRows[0]!;
    const { facturado_clp: _clpBefore, facturado_total_clp: _totalBefore, ...shapeBefore } = before.facturaciones!.find(
      (f) => f.billing_month === "2026-10"
    )!;
    expect(shape).toEqual(shapeBefore);
    expect(openRows[0]).toMatchObject({ is_open_month: true, facturado_clp: 45_500, facturado_total_clp: 45_500 });

    const detailRows = after.billing_detail_by_month!.filter((r) => r.billing_month === "2026-10");
    expect(detailRows).toHaveLength(1);
    expect(detailRows[0]).toMatchObject({
      as_of_kind: "manual",
      total_facturado_clp: 45_500,
      cupo_statement_clp: 60_000,
      balance_statement_clp:
        before.billing_detail_by_month!.find((r) => r.billing_month === "2026-10")!.balance_statement_clp + 15_500,
    });
    expect(detailRows[0]!.projected).toBeUndefined();
  });

  it("the open row closes on the announced day while the statement that announced it is in, then moves on with the bank", () => {
    insertSeptemberPlanBeforeTheClose();
    // September's statements arrive, the CLP one announcing October's close; the open month stays
    // October (no bucket, no snapshot for it) and now closes on the announced day.
    vi.setSystemTime(new Date("2026-09-26T15:00:00Z"));
    insertStatement({
      source: "vitest 2026-09-24 clp.pdf",
      date: "24/09/2026",
      from: "25/08/2026",
      to: "24/09/2026",
      currency: "clp",
      monto: 30_000,
      nextFrom: "24/09/2026",
      nextTo: "26/10/2026",
    });
    insertStatement({
      source: "vitest 2026-09-24 usd.pdf",
      date: "24/09/2026",
      from: "25/08/2026",
      to: "24/09/2026",
      currency: "usd",
      monto: 0,
    });
    invalidateCcBillingDetail(accountId);
    let facturaciones = buildFacturaciones(accountId, ccInstallmentsDbApiPayload(accountId).months);
    expect(facturaciones.filter((f) => f.is_open_month)).toEqual([
      expect.objectContaining({
        billing_month: "2026-10",
        close_date_iso: "2026-10-26",
        close_date_source: "announced",
        pay_by_iso: "2026-11-10",
        facturado_clp: 30_000,
      }),
    ]);

    // The announced close day: October is closed at the bank, November is the open facturación.
    vi.setSystemTime(new Date("2026-10-26T15:00:00Z"));
    invalidateCcBillingDetail(accountId);
    expect(billingMonthForManualLedgerPurchase(accountId)).toBe("2026-11");
    const ledger = ccInstallmentsDbApiPayload(accountId);
    facturaciones = buildFacturaciones(accountId, ledger.months);
    expect(facturaciones.map((f) => [f.billing_month, f.is_open_month, f.is_provisional_close])).toEqual([
      ["2026-11", true, false],
      ["2026-10", false, true],
      ["2026-09", false, false],
      ["2026-08", false, false],
    ]);
    // The September statement printed no cuota of the hand-entered plan, so its first cuota
    // clamps to October (negative schedule evidence): November bills cuota 2, one is left after it.
    expect(facturaciones[0]).toMatchObject({
      close_date_iso: "2026-11-26",
      close_date_source: "estimated",
      facturado_clp: 30_000,
      cuota_a_pagar_clp: 30_000,
      deuda_en_cuotas_clp: 30_000,
    });
    const detail = buildBillingDetailByMonth(accountId, ledger.months);
    expect(detail.find((d) => d.billing_month === "2026-11")).toMatchObject({
      as_of_kind: "manual",
      as_of_date: "2026-10-26",
      total_facturado_clp: 30_000,
    });
    expect(detail.find((d) => d.billing_month === "2026-11")!.projected).toBeUndefined();
  });

  it("a group's merged rows carry a member's open facturación before any line lands in it", () => {
    insertSeptemberPlanBeforeTheClose();
    const santander = db.prepare(`SELECT id FROM credit_card_groups WHERE slug = 'santander'`).get() as { id: number };
    db.prepare(
      `INSERT INTO credit_card_group_items (group_id, item_kind, account_id, sort_order) VALUES (?, 'account', ?, 99)`
    ).run(santander.id, accountId);
    onTestFinished(() => {
      db.prepare(`DELETE FROM credit_card_group_items WHERE account_id = ?`).run(accountId);
    });
    const group = creditCardGroupLedgerResponse("liabilities_credit_card");
    expectDetalleShowsChart(group);
    const october = group.facturaciones!.find((f) => f.billing_month === "2026-10")!;
    expect(october.is_open_month).toBe(true);
    // No statement prints October's PAGAR HASTA yet: the pay-by is the ~10th-of-next-month rule.
    expect(october.pay_by_source).toBe("derived");
    const statementClosed = group.facturaciones!.filter((f) => f.close_date_source === "statement");
    for (const f of statementClosed) expect(f.pay_by_source).toBe("statement");
    expect(october.facturado_total_clp!).toBeGreaterThanOrEqual(30_000);
    expect(october.deuda_en_cuotas_clp!).toBeGreaterThanOrEqual(30_000);
    const row = group.billing_detail_by_month!.find((r) => r.billing_month === "2026-10")!;
    expect(row.projected).toBeUndefined();
    expect(row.total_facturado_clp!).toBeGreaterThanOrEqual(30_000);
  });

  it("skips a pasted SALDO INICIAL row instead of importing the previous bill as a charge", () => {
    const { records, skipped_saldo_inicial } = ccWebPasteToCsvRecords(accountId, CARD_GROUP, LAST4, "b1", [
      webLine("2026-09-24", "SALDO INICIAL", -1_892_666),
      webLine("2026-09-25", "SWITCH VITEST", -15_500),
    ]);
    expect(skipped_saldo_inicial).toHaveLength(1);
    expect(records.map((r) => r.merchant)).toEqual(["SWITCH VITEST"]);
    expect(records[0]!.source_pdf).toBe("import:web-paste|open|2026-10");
  });

  it("settles the buckets against September's statement: billed lines go, unbilled ones move on", () => {
    const sept = insertStatement({ source: "import:web-paste|open|2026-09", date: "20/09/2026", currency: "clp" });
    insertBucketLine(sept, "2026-09-03", "SUPERMERCADO VITEST", 10_000); // on the statement
    insertBucketLine(sept, "2026-09-23", "FARMACIA VITEST", 4_990); // pre-auth, settled as 5.000
    const taxi = insertBucketLine(sept, "2026-09-24", "TAXI VITEST", 3_000); // close day, not billed
    const oct = insertStatement({ source: "import:web-paste|open|2026-10", date: "20/10/2026", currency: "clp" });
    const lateBilled = insertBucketLine(oct, "2026-09-22", "PENDIENTE VITEST", 7_000); // billed in Sept after all
    const nextCycle = insertBucketLine(oct, "2026-09-25", "SWITCH VITEST", 15_500);

    const clp = insertStatement({
      source: "vitest 2026-09-24 clp.pdf",
      date: "24/09/2026",
      from: "25/08/2026",
      to: "24/09/2026",
      currency: "clp",
      monto: 22_000,
      nextFrom: "24/09/2026",
      nextTo: "23/10/2026",
    });
    insertLine(clp, { date: "03/09/2026", merchant: "SUPERMERCADO VITEST", clp: 10_000 });
    insertLine(clp, { date: "23/09/2026", merchant: "FARMACIA VITEST", clp: 5_000 });
    insertLine(clp, { date: "22/09/2026", merchant: "PENDIENTE VITEST", clp: 7_000 });
    insertStatement({ source: "vitest 2026-09-24 usd.pdf", date: "24/09/2026", from: "25/08/2026", to: "24/09/2026", currency: "usd" });

    const result = reconcileOpenWebPasteAfterPdfClose(accountId, "2026-09");
    expect(result.skipped).toBe(false);
    expect(result.moved_line_ids).toEqual([taxi]);
    expect(result.deleted_line_ids).toContain(lateBilled);
    expect(result.deleted_count).toBe(3);
    expect(merchantsIn(bucketId("2026-09"))).toEqual([]);
    expect(merchantsIn(bucketId("2026-10"))).toEqual(["SWITCH VITEST", "TAXI VITEST"]);
    expect(db.prepare(`SELECT 1 FROM cc_statement_lines WHERE id = ?`).get(nextCycle)).toBeDefined();
  });

  it("settles one twin's own currency at once and leaves the other currency for its statement", () => {
    const sept = insertStatement({ source: "import:web-paste|open|2026-09", date: "20/09/2026", currency: "clp" });
    const supermercado = insertBucketLine(sept, "2026-09-03", "SUPERMERCADO VITEST", 10_000);
    const apple = insertLine(sept, { date: "01/09/2026", merchant: "APPLE.COM/BILL", usd: 13.93, key: "vitest-apple" });
    const preAuth = insertLine(sept, { date: "30/08/2026", merchant: "KIOSCO VITEST", usd: 5, key: "vitest-kiosco" });
    const closeDay = insertLine(sept, { date: "24/09/2026", merchant: "ANTHROPIC VITEST", usd: 20, key: "vitest-anthropic" });

    // The USD statement lands hours before its CLP twin (the September 2026 ·0781 case).
    const usd = insertStatement({
      source: "vitest 2026-09-24 usd.pdf",
      date: "24/09/2026",
      from: "25/08/2026",
      to: "24/09/2026",
      currency: "usd",
      monto: 20.93,
    });
    insertLine(usd, { date: "01/09/2026", merchant: "APPLE.COM/BILL", usd: 13.93 });
    insertLine(usd, { date: "02/09/2026", merchant: "KIOSCO VITEST SETTLED", usd: 7 });

    const first = reconcileOpenWebPasteAfterPdfClose(accountId, "2026-09");
    expect(first).toMatchObject({ skipped: false, currencies: ["usd"] });
    // Dollar lines: the billed one and the pre-auth go, the close-day purchase moves to October.
    expect(first.deleted_line_ids.sort()).toEqual([apple, preAuth].sort());
    expect(first.earliest_deleted_iso).toBe("2026-08-30");
    expect(first.moved_line_ids).toEqual([closeDay]);
    // Peso lines wait for their own statement.
    expect(merchantsIn(bucketId("2026-09"))).toEqual(["SUPERMERCADO VITEST"]);
    expect(merchantsIn(bucketId("2026-10"))).toContain("ANTHROPIC VITEST");
    // The month still waits for its CLP statement, and its dollars are billed once.
    recomputeCcBillingMonthBalances(accountId);
    const ledger = ccInstallmentsDbApiPayload(accountId);
    const september = buildFacturaciones(accountId, ledger.months).find((f) => f.billing_month === "2026-09")!;
    expect(september.is_open_month).toBe(false);
    expect(september.facturado_usd).toBeCloseTo(20.93, 2);

    const clp = insertStatement({
      source: "vitest 2026-09-24 clp.pdf",
      date: "24/09/2026",
      from: "25/08/2026",
      to: "24/09/2026",
      currency: "clp",
      monto: 10_000,
      nextFrom: "24/09/2026",
      nextTo: "23/10/2026",
    });
    insertLine(clp, { date: "03/09/2026", merchant: "SUPERMERCADO VITEST", clp: 10_000 });
    const second = reconcileOpenWebPasteAfterPdfClose(accountId, "2026-09");
    expect(second).toMatchObject({ skipped: false, currencies: ["clp", "usd"], deleted_line_ids: [supermercado] });
    expect(merchantsIn(bucketId("2026-09"))).toEqual([]);
  });

  it("a dollar statement with no printed total bills its lines, payments left out, and is held to the feed", () => {
    recordFeedBillingClose(accountId, {
      close_iso: "2026-09-24",
      saldo_inicial_clp: 10_000,
      saldo_inicial_usd: 30.52,
      source_file: "feed",
    });
    const clp = insertStatement({
      source: "import:santander-json|clp|24/09/2026",
      date: "24/09/2026",
      from: "25/08/2026",
      to: "24/09/2026",
      currency: "clp",
      monto: 10_000,
    });
    insertLine(clp, { date: "03/09/2026", merchant: "SUPERMERCADO VITEST", clp: 10_000 });
    // The international JSON prints no header: its dollars come from the lines.
    const usd = insertStatement({
      source: "import:santander-json|usd|24/09/2026",
      date: "24/09/2026",
      from: "25/08/2026",
      to: "24/09/2026",
      currency: "usd",
      monto: null,
    });
    insertLine(usd, { date: "01/09/2026", merchant: "APPLE.COM/BILL", usd: 13.52 });
    insertLine(usd, { date: "02/09/2026", merchant: "VITEST CLOUD", usd: 20 });
    insertLine(usd, { date: "05/09/2026", merchant: "NOTA DE CREDITO", usd: -3 });
    const payment = insertLine(usd, { date: "09/09/2026", merchant: "MONTO CANCELADO", usd: -50 });

    expect(usdBilledFromStatementLines(usd)).toBeCloseTo(30.52, 2);
    expect(feedCloseStatementMismatches(accountId)).toEqual([]);
    invalidateCcBillingDetail(accountId);
    const ledger = ccInstallmentsDbApiPayload(accountId);
    const september = buildFacturaciones(accountId, ledger.months).find((f) => f.billing_month === "2026-09")!;
    expect(september.facturado_usd).toBeCloseTo(30.52, 2);
    expect(september.facturado_total_clp).toBe(10_000 + september.facturado_usd_clp!);

    // A payment read as a charge (a dollar MONTO CANCELADO read as positive) disagrees.
    db.prepare(`UPDATE cc_statement_lines SET amount_usd = 50 WHERE id = ?`).run(payment);
    expect(feedCloseStatementMismatches(accountId)).toEqual([
      expect.stringMatching(/bills 80\.52, the feed's SALDO INICIAL for that close is 30\.52/),
    ]);
  });

  it("flags a statement that disagrees with the feed's SALDO INICIAL for the same close", () => {
    recordFeedBillingClose(accountId, {
      close_iso: "2026-09-24",
      saldo_inicial_clp: 1_892_666,
      saldo_inicial_usd: null,
      source_file: "feed",
    });
    expect(feedCloseStatementMismatches(accountId)).toEqual([]);
    insertStatement({
      source: "vitest 2026-09-24 clp.pdf",
      date: "24/09/2026",
      from: "25/08/2026",
      to: "24/09/2026",
      currency: "clp",
      monto: 1_892_000,
    });
    expect(feedCloseStatementMismatches(accountId)).toEqual([
      expect.stringMatching(/bills 1892000, the feed's SALDO INICIAL for that close is 1892666/),
    ]);
  });
});

describe("ddMmYyyyFromIso", () => {
  it("formats ISO as zero-padded dd/mm/yyyy and refuses anything else", () => {
    expect(ddMmYyyyFromIso("2026-09-24")).toBe("24/09/2026");
    expect(() => ddMmYyyyFromIso("24/09/2026")).toThrow(/expected YYYY-MM-DD/);
    expect(() => ddMmYyyyFromIso("2026-9-24")).toThrow(/expected YYYY-MM-DD/);
  });
});
