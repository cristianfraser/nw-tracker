import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import {
  cuotaCountFromStampTax,
  cuotaPurchaseTypeFromFeedDescription,
  firstCuotaBillingMonth,
} from "./ccCuotaPurchaseKinds.js";
import { santanderMovementsByAccount } from "./santanderCardMovements.js";
import { importSantanderMovementsFile } from "./santanderMovementsImport.js";
import { ccInstallmentsDbApiPayload, ccLedgerMonthEndIso } from "./ccInstallmentLedgerDb.js";
import {
  buildBillingDetailByMonth,
  buildFacturaciones,
  pendingCuotaPurchaseLines,
} from "./ccBillingViews.js";
import { ccInstallmentDebtDailyClp } from "./ccInstallmentDebtDaily.js";
import { creditCardInstallmentsResponse } from "./creditCardInstallments.js";
import { convertStatementLineToInstallmentPurchase } from "./ccInstallmentManual.js";
import { buildCcExpenseLines } from "./flowsCreditCardExpenses.js";
import { recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import { webPasteLineDedupeKey, type CcWebPasteLine } from "./ccWebPasteParse.js";

describe("feed cuota purchase rules", () => {
  it("maps the feed's purchase types and refuses an unknown cuota type", () => {
    expect(cuotaPurchaseTypeFromFeedDescription("CUOTA COMERCIO")).toEqual({ kind: "cuota_comercio", cuota_count: null });
    expect(cuotaPurchaseTypeFromFeedDescription("N/CUOTAS PRECIO CONTADO")).toEqual({
      kind: "precio_contado",
      cuota_count: null,
    });
    expect(cuotaPurchaseTypeFromFeedDescription("TRES CUOTAS CONTADO")).toEqual({ kind: "precio_contado", cuota_count: 3 });
    expect(cuotaPurchaseTypeFromFeedDescription("COMPRA NORMAL")).toBeNull();
    expect(() => cuotaPurchaseTypeFromFeedDescription("SEIS CUOTAS SIN INTERES")).toThrow(/Unknown Santander cuota-purchase type/);
  });

  it("reads the cuota count from the stamp tax: term = cuotas + 1 months at 0,066%, capped at 0,8%", () => {
    // Real 2026-08 purchases: Municipalidad de Maipú and the Plaza Lyon recaudación, both 3 cuotas.
    expect(cuotaCountFromStampTax(29_990, 79)).toEqual({ status: "exact", cuota_count: 3 });
    expect(cuotaCountFromStampTax(1_598_924, 4_221)).toEqual({ status: "exact", cuota_count: 3 });
    expect(cuotaCountFromStampTax(100_000, 462)).toEqual({ status: "exact", cuota_count: 6 });
    // 12 cuotas (0,858%) is past the cap: only «12 or more».
    expect(cuotaCountFromStampTax(223_930, 1_791)).toEqual({ status: "capped" });
    // A tiny principal whose peso rounding hides the term is not a count.
    expect(cuotaCountFromStampTax(1_000, 3).status).toBe("inconsistent");
  });

  it("bills cuota comercio at the close after the purchase cycle, precio contado at its own", () => {
    expect(firstCuotaBillingMonth("cuota_comercio", "2026-09")).toBe("2026-10");
    expect(firstCuotaBillingMonth("cuota_comercio", "2026-12")).toBe("2027-01");
    expect(firstCuotaBillingMonth("precio_contado", "2026-09")).toBe("2026-09");
  });
});

const LAST4 = "9922";
const BANK_ACCOUNT = "800099990022";
const CARD_GROUP = "santander";

function feedRow(fecha: string, descripcion: string, comercio: string | null, importe: string, dh = "D") {
  return {
    Fecha: fecha,
    Descripcion: descripcion,
    Comercio: comercio,
    Importe: importe,
    DescripcionRubro: null,
    Ciudad: "SANTIAGO",
    TipoBen: null,
    IndicadorDebeHaber: dh,
  };
}

function saldoInicial(fecha: string, importe: string) {
  return feedRow(fecha, "SALDO INICIAL", null, importe);
}

describe("feed annotations", () => {
  it("pairs a cuota comercio purchase with its same-day stamp tax, and only an unambiguous pair", () => {
    const groups = santanderMovementsByAccount({
      fetchedAt: "x",
      slides: [
        {
          account: BANK_ACCOUNT,
          currency: "CLP",
          rows: [
            feedRow("27/08/2026", "CUOTA COMERCIO", "MUNICIPALIDAD DE MAIPU", "29.990"),
            feedRow("27/08/2026", "IMPTO. DECRETO LEY 3475", "MUNICIPALIDAD DE MAIPU", "79"),
            feedRow("05/09/2026", "N/CUOTAS PRECIO CONTADO", "FULLNEUMATICO QUILIN", "189.990"),
            // Two cuota purchases, one tax, same day and merchant: no count.
            feedRow("06/09/2026", "CUOTA COMERCIO", "TIENDA DOBLE", "30.000"),
            feedRow("06/09/2026", "CUOTA COMERCIO", "TIENDA DOBLE", "30.000"),
            feedRow("06/09/2026", "IMPTO. DECRETO LEY 3475", "TIENDA DOBLE", "79"),
            // A close-day billing reference shares a cuota description but is not a purchase.
            feedRow("25/08/2026", "CUOTAS COMERCIO", "CUOT: 000000013OPER: 000024", "18.333"),
          ],
        },
      ],
    });
    const cuota = groups[0]!.lines.filter((l) => l.cuota_purchase).map((l) => [l.merchant, l.cuota_purchase]);
    expect(cuota).toEqual([
      ["MUNICIPALIDAD DE MAIPU", { kind: "cuota_comercio", cuota_count: 3, count_source: "stamp_tax", stamp_tax_clp: 79 }],
      ["FULLNEUMATICO QUILIN", { kind: "precio_contado", cuota_count: null, count_source: null, stamp_tax_clp: null }],
      ["TIENDA DOBLE", { kind: "cuota_comercio", cuota_count: null, count_source: null, stamp_tax_clp: null }],
      ["TIENDA DOBLE", { kind: "cuota_comercio", cuota_count: null, count_source: null, stamp_tax_clp: null }],
    ]);
  });
});

describe("feed cuota purchases, type-aware nudge and the feed mirror", () => {
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

  function webLine(dateIso: string, merchant: string, clp: number): CcWebPasteLine {
    return { transaction_date: dateIso, merchant, amount_clp: -clp, amount_usd: null, currency: "clp", raw_line: merchant };
  }

  /** A bucket line with the key a feed row / paste gives it (clp stored debt-positive). */
  function insertBucketLine(bucketId: number, dateIso: string, merchant: string, clp: number): number {
    const [y, m, d] = dateIso.split("-");
    const key = webPasteLineDedupeKey(CARD_GROUP, webLine(dateIso, merchant, clp));
    return Number(
      db
        .prepare(
          `INSERT INTO cc_statement_lines (
             statement_id, transaction_date, merchant, amount_clp, installment_flag, dedupe_key, parser_row_id, raw_line
           ) VALUES (?, ?, ?, ?, 0, ?, ?, 'vitest')`
        )
        .run(bucketId, `${Number(d)}/${Number(m)}/${y}`, merchant, clp, key, `web:${key}`).lastInsertRowid
    );
  }

  function lineExists(id: number): boolean {
    return db.prepare(`SELECT 1 FROM cc_statement_lines WHERE id = ?`).get(id) !== undefined;
  }

  function writeFeed(slides: unknown[]): string {
    const file = path.join(tmpDir, `card-movements-2026-09-20T01-00-00.json`);
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: "2026-09-20T01:00:00.000Z", slides }));
    return file;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-20T15:00:00Z")); // mid September cycle, before its 24/09 close
    const bucket = db
      .prepare(`SELECT id FROM asset_groups WHERE slug IN ('credit_card', 'credit_cards__credit_card') LIMIT 1`)
      .get() as { id: number };
    const importKey = `credit_card_master|santander|vitest-feed-cuotas-${LAST4}`;
    accountId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'Vitest · feed cuotas', ?, ?)`)
        .run(bucket.id, importKey, importKey).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4)
       VALUES (?, 21, 20, ?)`
    ).run(accountId, LAST4);
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
    insertStatement({ source: "vitest 2026-08-25 usd.pdf", date: "25/08/2026", from: "23/07/2026", to: "25/08/2026", currency: "usd", monto: 556.21 });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vitest-feed-cuotas-"));
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

  it("turns known-count cuota purchases into plans, tags the rest, and bills neither in full", () => {
    const sept = insertStatement({ source: "import:web-paste|open|2026-09", date: "20/09/2026", currency: "clp" });
    // Already on file as one-shots (a paste cut the names at 15 characters).
    const municipalidad = insertBucketLine(sept, "2026-08-27", "MUNICIPALIDAD D", 29_990);
    const neumaticos = insertBucketLine(sept, "2026-09-05", "FULLNEUMATICO Q", 189_990);
    const super1 = insertBucketLine(sept, "2026-09-03", "SUPERMERCADO VITEST", 10_000);

    const file = writeFeed([
      {
        account: BANK_ACCOUNT,
        currency: "CLP",
        rows: [
          feedRow("27/08/2026", "CUOTA COMERCIO", "MUNICIPALIDAD DE MAIPU", "29.990"),
          feedRow("27/08/2026", "IMPTO. DECRETO LEY 3475", "MUNICIPALIDAD DE MAIPU", "79"),
          feedRow("05/09/2026", "N/CUOTAS PRECIO CONTADO", "FULLNEUMATICO QUILIN", "189.990"),
          feedRow("03/09/2026", "COMPRA NORMAL", "SUPERMERCADO VITEST", "10.000"),
        ],
        saldoInicial: [saldoInicial("25/08/2026", "3.476.163")],
      },
      { account: BANK_ACCOUNT, currency: "USD", rows: [], saldoInicial: [saldoInicial("25/08/2026", "556,21")] },
    ]);
    const imported = importSantanderMovementsFile(file).accounts[0]!;

    expect(imported.plans_created).toEqual([
      expect.objectContaining({
        merchant: "MUNICIPALIDAD DE MAIPU",
        principal_clp: 29_990,
        cuotas: 3,
        kind: "cuota_comercio",
        first_due_month: "2026-10",
      }),
    ]);
    const plan = db
      .prepare(
        `SELECT p.source, p.first_due_month, f.kind, f.cuotas_source, f.stamp_tax_clp
         FROM cc_installment_purchases p JOIN cc_feed_installment_plans f ON f.purchase_id = p.id
         WHERE p.account_id = ?`
      )
      .get(accountId);
    expect(plan).toEqual({ source: "manual", first_due_month: "2026-10", kind: "cuota_comercio", cuotas_source: "stamp_tax", stamp_tax_clp: 79 });
    expect(lineExists(municipalidad)).toBe(false); // the plan replaced the one-shot
    expect(imported.cuota_lines_tagged).toBe(1);
    expect(
      db.prepare(`SELECT cuota_purchase_kind FROM cc_statement_lines WHERE id = ?`).get(neumaticos)
    ).toEqual({ cuota_purchase_kind: "precio_contado" });
    expect(lineExists(super1)).toBe(true);
    expect(imported.mirror?.removed).toEqual([]);

    recomputeCcBillingMonthBalances(accountId);
    const ledger = ccInstallmentsDbApiPayload(accountId);
    const september = buildFacturaciones(accountId, ledger.months).find((f) => f.billing_month === "2026-09")!;
    // Only the plain purchase and the stamp tax (a charge of the cycle) bill in September: the cuota
    // comercio bills from October, the precio contado's first cuota is unknown until the statement.
    expect(september).toMatchObject({ is_open_month: true, facturado_total_clp: 10_000 + 79 });
    const october = ledger.months.find((m) => m.month === "2026-10");
    expect(october?.breakdown.map((b) => b.label)).toEqual(["MUNICIPALIDAD DE MAIPU"]);
    const detail = buildBillingDetailByMonth(accountId, ledger.months).find((d) => d.billing_month === "2026-09")!;
    expect(detail.cupo_en_cuotas_clp).toBe(29_990 + 189_990);
  });

  it("carries a cuota purchase of unknown count as installment debt from its date, flat until its plan", () => {
    const sept = insertStatement({ source: "import:web-paste|open|2026-09", date: "20/09/2026", currency: "clp" });
    insertBucketLine(sept, "2026-09-03", "SUPERMERCADO VITEST", 10_000);
    const file = writeFeed([
      {
        account: BANK_ACCOUNT,
        currency: "CLP",
        rows: [
          feedRow("27/08/2026", "CUOTA COMERCIO", "MUNICIPALIDAD DE MAIPU", "29.990"),
          feedRow("27/08/2026", "IMPTO. DECRETO LEY 3475", "MUNICIPALIDAD DE MAIPU", "79"),
          feedRow("05/09/2026", "N/CUOTAS PRECIO CONTADO", "FULLNEUMATICO QUILIN", "189.990"),
          feedRow("03/09/2026", "COMPRA NORMAL", "SUPERMERCADO VITEST", "10.000"),
        ],
        saldoInicial: [saldoInicial("25/08/2026", "3.476.163")],
      },
      { account: BANK_ACCOUNT, currency: "USD", rows: [], saldoInicial: [saldoInicial("25/08/2026", "556,21")] },
    ]);
    expect(importSantanderMovementsFile(file).accounts[0]!.cuota_lines_tagged).toBe(1);
    expect(pendingCuotaPurchaseLines(accountId)).toEqual([
      expect.objectContaining({
        merchant: "FULLNEUMATICO QUILIN",
        purchase_date: "2026-09-05",
        amount_clp: 189_990,
        kind: "precio_contado",
        billing_month: "2026-09",
      }),
    ]);

    // The daily «deuda en cuotas» takes the whole principal on the purchase day, beside the
    // Municipalidad plan (2x.xxx from 27/08), and keeps it after that plan has been paid off.
    const walk = ccInstallmentDebtDailyClp(accountId, ["2026-08-26", "2026-09-04", "2026-09-05", "2027-06-30"])!;
    expect(walk[0]).toBeNull();
    expect(walk[1]).toBe(29_990);
    expect(walk[2]! - walk[1]!).toBe(189_990);
    expect(walk[3]).toBe(189_990);

    // The monthly chart samples that walk at every month-end; the projected rows hold it flat too,
    // so the balance line never sits under the cuota line.
    const chart = creditCardInstallmentsResponse(accountId).historial_chart ?? [];
    expect(chart.map((p) => p.cupo_en_cuotas_clp)).toEqual(
      ccInstallmentDebtDailyClp(accountId, chart.map((p) => ccLedgerMonthEndIso(p.month)))
    );
    const ledger = ccInstallmentsDbApiPayload(accountId);
    const projected = buildBillingDetailByMonth(accountId, ledger.months).filter((d) => d.projected);
    expect(projected.length).toBeGreaterThan(0);
    const last = projected.reduce((a, b) => (a.billing_month > b.billing_month ? a : b));
    expect(last).toMatchObject({ cupo_en_cuotas_clp: 189_990, balance_total_clp: 189_990 });
  });

  it("asks for the count: the line carries its type, and entering it pins the first cuota by type", () => {
    const sept = insertStatement({ source: "import:web-paste|open|2026-09", date: "20/09/2026", currency: "clp" });
    insertBucketLine(sept, "2026-09-03", "SUPERMERCADO VITEST", 10_000);
    const file = writeFeed([
      {
        account: BANK_ACCOUNT,
        currency: "CLP",
        rows: [
          // No same-day stamp tax: the count of this cuota comercio is unknown.
          feedRow("10/09/2026", "CUOTA COMERCIO", "TIENDA VITEST", "120.000"),
          feedRow("03/09/2026", "COMPRA NORMAL", "SUPERMERCADO VITEST", "10.000"),
        ],
        saldoInicial: [saldoInicial("25/08/2026", "3.476.163")],
      },
      { account: BANK_ACCOUNT, currency: "USD", rows: [], saldoInicial: [saldoInicial("25/08/2026", "556,21")] },
    ]);
    expect(importSantanderMovementsFile(file).accounts[0]!.cuota_lines_tagged).toBe(1);
    const pending = pendingCuotaPurchaseLines(accountId);
    expect(pending).toEqual([
      expect.objectContaining({ kind: "cuota_comercio", amount_clp: 120_000, billing_month: "2026-09" }),
    ]);
    expect(creditCardInstallmentsResponse(accountId).pending_cuota_purchases).toEqual(pending);
    const lineId = pending[0]!.statement_line_id;
    expect(buildCcExpenseLines([accountId]).find((l) => l.statement_line_id === lineId)?.cuota_purchase_kind).toBe(
      "cuota_comercio"
    );
    const walkBefore = ccInstallmentDebtDailyClp(accountId, ["2026-09-09", "2026-09-10", "2026-09-30"]);

    // The card page's «¿cuántas cuotas?» runs the ordinary line → plan conversion.
    const plan = convertStatementLineToInstallmentPurchase(accountId, lineId, 4);
    // Santander bills a cuota comercio's first cuota at the close AFTER its cycle — not the manual
    // guess (the purchase's own cycle, September).
    expect(
      db.prepare(`SELECT first_due_month, cuotas_totales, total_amount_clp FROM cc_installment_purchases WHERE id = ?`).get(plan.id)
    ).toEqual({ first_due_month: "2026-10", cuotas_totales: 4, total_amount_clp: 120_000 });
    expect(pendingCuotaPurchaseLines(accountId)).toEqual([]);
    // The plan takes the same contract over on the same day: the cuota line does not move.
    expect(ccInstallmentDebtDailyClp(accountId, ["2026-09-09", "2026-09-10", "2026-09-30"])).toEqual(walkBefore);
  });

  it("re-pins a hand-entered plan's first cuota from the feed's type", () => {
    // Entered by hand; the old nudge pinned it to the open month.
    const planId = Number(
      db
        .prepare(
          `INSERT INTO cc_installment_purchases (
             account_id, card_group, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales,
             merchant, description_merged, source, first_due_month
           ) VALUES (?, ?, 'vitest-feed-cuotas-manual', '2026-08-28', 1598924, 3, 'EXPRESS PLAZA L', NULL, 'manual', '2026-09')`
        )
        .run(accountId, CARD_GROUP).lastInsertRowid
    );
    const file = writeFeed([
      {
        account: BANK_ACCOUNT,
        currency: "CLP",
        rows: [
          feedRow("28/08/2026", "CUOTA COMERCIO", "RECAUDACION EX PLAZA LYON", "1.598.924"),
          feedRow("28/08/2026", "IMPTO. DECRETO LEY 3475", "RECAUDACION EX PLAZA LYON", "4.221"),
        ],
        saldoInicial: [saldoInicial("25/08/2026", "3.476.163")],
      },
    ]);
    const imported = importSantanderMovementsFile(file).accounts[0]!;
    expect(imported.plans_created).toEqual([]); // a plan already covers it
    expect(imported.first_due_nudges).toEqual([
      expect.objectContaining({ purchase_id: planId, from: "2026-09", to: "2026-10", rule: "feed_type" }),
    ]);
    expect(
      db.prepare(`SELECT first_due_month FROM cc_installment_purchases WHERE id = ?`).get(planId)
    ).toEqual({ first_due_month: "2026-10" });
  });

  it("removes what the bank no longer lists from the current cycle, and nothing else", () => {
    const sept = insertStatement({ source: "import:web-paste|open|2026-09", date: "20/09/2026", currency: "clp" });
    const voided = insertBucketLine(sept, "2026-09-03", "CONVENIO P.A.T.", 29_436); // restated below
    const settled = insertBucketLine(sept, "2026-09-07", "SEG AUTO SANTANDER", 29_436);
    const truncated = insertBucketLine(sept, "2026-09-09", "ALMACENES BILBA", 2_200); // pasted, 15 chars
    // Pending on the 11th, restated by the bank on the 12th: the import writes the 12th, so the
    // 11th is the stale twin.
    const restated = insertBucketLine(sept, "2026-09-11", "PAYU *UBER TRIP", 10_499);
    const payment = insertBucketLine(sept, "2026-09-08", "PAGO", -3_476_163); // planted from a receipt
    const lastCycle = insertBucketLine(sept, "2026-08-20", "OLD CYCLE PURCHASE", 5_000); // before the close
    const usdLine = Number(
      db
        .prepare(
          `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_clp, amount_usd, installment_flag, dedupe_key, raw_line)
           VALUES (?, '10/9/2026', 'APPLE.COM/BILL', 0, 13.79, 0, 'vitest-usd', 'vitest')`
        )
        .run(sept).lastInsertRowid
    );

    const file = writeFeed([
      {
        account: BANK_ACCOUNT,
        currency: "CLP",
        rows: [
          feedRow("07/09/2026", "COMPRAS P.A.T.", "SEG AUTO SANTANDER", "29.436"),
          feedRow("09/09/2026", "COMPRA NORMAL", "ALMACENES BILBAO", "2.200"),
          feedRow("12/09/2026", "COMPRA NACIONAL POR INTERNET", "PAYU *UBER TRIP", "10.499"),
        ],
        saldoInicial: [saldoInicial("25/08/2026", "3.476.163")],
      },
      // No USD slide: a failed Dólares tab must not read as «every USD purchase vanished».
    ]);
    const imported = importSantanderMovementsFile(file).accounts[0]!;
    expect(imported.mirror).toMatchObject({ window_start: "2026-08-25", currencies: ["clp"] });
    expect(imported.mirror!.removed.map((r) => r.id)).toEqual([voided, restated]);
    for (const id of [settled, truncated, payment, lastCycle, usdLine]) {
      expect(lineExists(id)).toBe(true);
    }
    const uber = db
      .prepare(
        `SELECT l.transaction_date FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id = ? AND l.merchant = 'PAYU *UBER TRIP'`
      )
      .all(accountId);
    expect(uber).toEqual([{ transaction_date: "12/9/2026" }]);
  });

  it("refuses to mirror a feed that lost more rows than voids explain", () => {
    const sept = insertStatement({ source: "import:web-paste|open|2026-09", date: "20/09/2026", currency: "clp" });
    const ids: number[] = [];
    for (let i = 1; i <= 13; i++) ids.push(insertBucketLine(sept, "2026-09-10", `COMERCIO ${i}`, 1_000 + i));
    const file = writeFeed([
      {
        account: BANK_ACCOUNT,
        currency: "CLP",
        rows: [feedRow("15/09/2026", "COMPRA NORMAL", "OTRO COMERCIO", "5.000")],
        saldoInicial: [saldoInicial("25/08/2026", "3.476.163")],
      },
    ]);
    expect(() => importSantanderMovementsFile(file)).toThrow(/no longer lists 13 open-bucket lines/);
    for (const id of ids) expect(lineExists(id)).toBe(true);
  });
});
