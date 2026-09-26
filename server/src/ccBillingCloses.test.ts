import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import {
  closeDayOffsetDays,
  closeEvidenceForBillingMonth,
  feedCloseStatementMismatches,
  nextPeriodStartIsoForBillingMonth,
  recordFeedBillingClose,
} from "./ccBillingCloses.js";
import {
  billingMonthForManualLedgerPurchase,
  isProvisionallyClosedBillingMonth,
  lastClosedBillingMonthForAccount,
  lastPdfBillingMonthForAccount,
  pdfClosedBillingMonthsForAccount,
  statementCloseDdMmYyyyForBillingMonth,
} from "./ccManualBillingMonth.js";
import {
  ccInstallmentsDbApiPayload,
  ccLedgerMonthEndIso,
  liveCreditCardOutstandingClp,
} from "./ccInstallmentLedgerDb.js";
import { ccInstallmentDebtDailyClp } from "./ccInstallmentDebtDaily.js";
import { creditCardInstallmentsResponse } from "./creditCardInstallments.js";
import { buildBillingDetailByMonth, buildFacturaciones } from "./ccBillingViews.js";
import { importSantanderMovementsFile } from "./santanderMovementsImport.js";
import { santanderFeedClosesByAccount } from "./santanderCardMovements.js";
import {
  facturacionMonthByStatementDate,
  reconcileOpenWebPasteAfterPdfClose,
  statementDatesForFacturacion,
} from "./ccOpenWebPastePdfReconcile.js";
import { buildCcExpenseLines } from "./flowsCreditCardExpenses.js";
import { repairMisplacedOpenWebPasteBuckets } from "./ccOpenWebPasteRepair.js";
import { recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
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

  function writeFeed(slides: unknown[]): string {
    const file = path.join(tmpDir, `card-movements-2026-09-25T15-55-26.json`);
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: "2026-09-25T15:56:23.387Z", slides }));
    return file;
  }

  function feedRow(fecha: string, comercio: string, importe: string) {
    return {
      Fecha: fecha,
      Descripcion: "COMPRA NORMAL",
      Comercio: comercio,
      Importe: importe,
      DescripcionRubro: "COMERCIO",
      Ciudad: "SANTIAGO",
      TipoBen: "X",
      IndicadorDebeHaber: "D",
    };
  }

  function saldoInicial(fecha: string, importe: string, indicador = "D") {
    return {
      Fecha: fecha,
      Descripcion: "SALDO INICIAL",
      Comercio: null,
      Importe: importe,
      DescripcionRubro: null,
      Ciudad: null,
      TipoBen: null,
      IndicadorDebeHaber: indicador,
    };
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

  it("closes the month once its announced next cycle has started, without touching schedule evidence", () => {
    expect(lastClosedBillingMonthForAccount(accountId, "2026-09-23")).toBe("2026-08");
    expect(lastClosedBillingMonthForAccount(accountId, "2026-09-24")).toBe("2026-09");
    expect(billingMonthForManualLedgerPurchase(accountId)).toBe("2026-10");
    expect(isProvisionallyClosedBillingMonth(accountId, "2026-09")).toBe(true);
    expect(lastPdfBillingMonthForAccount(accountId)).toBe("2026-08");
  });

  it("reads each card's SALDO INICIAL from the feed, zero and credit balances included", () => {
    const closes = santanderFeedClosesByAccount({
      fetchedAt: "x",
      slides: [
        { account: BANK_ACCOUNT, currency: "CLP", rows: [], saldoInicial: [saldoInicial("24/09/2026", "1.892.666")] },
        { account: BANK_ACCOUNT, currency: "USD", rows: [], saldoInicial: [saldoInicial("24/09/2026", "0,00")] },
        { account: "800000000077", currency: "CLP", rows: [], saldoInicial: [saldoInicial("24/09/2026", "5.000", "H")] },
      ],
    });
    expect(closes).toEqual([
      { account: BANK_ACCOUNT, close_iso: "2026-09-24", saldo_inicial_clp: 1_892_666, saldo_inicial_usd: 0 },
      { account: "800000000077", close_iso: "2026-09-24", saldo_inicial_clp: -5_000, saldo_inicial_usd: null },
    ]);
    expect(() =>
      santanderFeedClosesByAccount({
        fetchedAt: "x",
        slides: [
          { account: BANK_ACCOUNT, currency: "CLP", rows: [], saldoInicial: [saldoInicial("24/09/2026", "1")] },
          { account: BANK_ACCOUNT, currency: "USD", rows: [], saldoInicial: [saldoInicial("25/08/2026", "1,00")] },
        ],
      })
    ).toThrow(/two closes/);
  });

  it("closes September on the feed's SALDO INICIAL and files every post-close row under October", () => {
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

    const file = writeFeed([
      {
        account: BANK_ACCOUNT,
        currency: "CLP",
        rows: [
          feedRow("24/09/2026", "CLINICA VITEST", "2.400"),
          feedRow("22/09/2026", "PENDIENTE VITEST", "7.000"),
          feedRow("25/09/2026", "SWITCH VITEST", "15.500"),
        ],
        saldoInicial: [saldoInicial("24/09/2026", "1.892.666")],
      },
      { account: BANK_ACCOUNT, currency: "USD", rows: [], saldoInicial: [saldoInicial("24/09/2026", "577,34")] },
    ]);
    const result = importSantanderMovementsFile(file);
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
    expect(september).toMatchObject({ provisional: true, cuota_a_pagar_next_mes_clp: 30_000, cupo_en_cuotas_clp: 60_000 });
    expect(september.balance_total_clp).toBe((september.total_facturado_clp ?? 0) + 60_000);
    expect(liveCreditCardOutstandingClp(accountId)).toBe(90_000);
    expect(october.cupo_en_cuotas_clp).toBe(60_000);
  });

  it("plots the monthly «deuda en cuotas» where the daily line sits at each month-end", () => {
    insertSeptemberPlan();
    const chart = creditCardInstallmentsResponse(accountId).historial_chart ?? [];
    const line = (month: string) => chart.find((p) => p.month === month)?.cupo_en_cuotas_clp;
    // Billed on 24/09 but unpaid until 10/10: still debt at 30/09 (the table's September cupo,
    // 6x.xxx, is the billing frame — the cuota sits in its facturado there).
    expect(line("2026-09")).toBe(90_000);
    expect(line("2026-10")).toBe(60_000);
    expect(line("2026-11")).toBe(30_000);
    const months = chart.map((p) => p.month);
    const daily = ccInstallmentDebtDailyClp(accountId, months.map(ccLedgerMonthEndIso));
    expect(chart.map((p) => p.cupo_en_cuotas_clp)).toEqual(daily);
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
