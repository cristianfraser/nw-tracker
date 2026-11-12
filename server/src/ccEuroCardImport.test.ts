import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_CARD_STATEMENT_HEADER, type CardCanonicalLine, type CardCanonicalStatement } from "nw-tracker-contracts";
import { clearAggregationCache } from "./cacheRegistry.js";
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import { openFacturacionCredits, openMonthForeignFacturado } from "./ccBillingBalances.js";
import { facturadoForeignIn } from "./ccBillingViews.js";
import { judgeBankCupo } from "./ccBankCupoCheck.js";
import { ccOwedByCurrency, foreignOwedIn } from "./ccOwedByCurrency.js";
import { ccOwedByCurrencyAtYmd } from "./ccOwedWalk.js";
import { applyCanonicalCardStatements } from "./ccParsedStatementsApply.js";
import { statementCloseDdMmYyyyForBillingMonth } from "./cards/facturacion.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { buildDashboardCcUpcomingPayments } from "./dashboardCcUpcomingPayments.js";
import { db } from "./db.js";
import { buildCcExpenseLines } from "./flowsExpenses.js";
import { lineAmount, withLineMoney } from "./lineMoney.js";
import { convertCurrency } from "./rates.js";
import { wipeVitestCcFixtureData } from "./test/vitestDbSeed.js";

/**
 * A card that bills in euros (the fictional issuer `euronova`), end to end through the import every
 * card's statements go through (`applyCanonicalCardStatements`, docs/any-currency-plan.md C3): the
 * import takes the currency its issuer declares, and the month-end anchors, the facturaciones, the
 * expense lines, Pasivos (the card's valuations), «Próximos pagos» and the bank cupo check count its
 * euros — the open cycle's too.
 */

const IMPORT_KEY = "credit_card_master|euronova|vitest-euro-import";
const LAST4 = "4404";
const TODAY = chileCalendarTodayYmd();
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

const CLOSE_1 = addDays(TODAY, -50);
const CLOSE_2 = addDays(TODAY, -20);
const PAYMENT_DAY = addDays(CLOSE_1, 10);

function line(day: string, merchant: string, amount: number, kind: CardCanonicalLine["kind"], id: string): CardCanonicalLine {
  return {
    kind,
    transaction_date: day,
    posting_date: null,
    printed_transaction_date: ddmm(day),
    printed_posting_date: null,
    merchant,
    description: merchant,
    place: null,
    country: null,
    currency: "eur",
    amount,
    origin_amount: null,
    installment: null,
    origin_card_last4: null,
    cuota_purchase: null,
    document: {
      line_id: id,
      dedupe_key: id,
      section: "international_usd",
      raw_text: `${ddmm(day)} ${merchant}`,
      duplicate_across_statements: false,
      baseline_match: null,
    },
  } as CardCanonicalLine;
}

function statement(opts: {
  close: string;
  saldoAnterior: number;
  paid: number;
  facturado: number;
  lines: CardCanonicalLine[];
}): CardCanonicalStatement {
  return {
    document: `vitest-euronova-${opts.close}.pdf`,
    card_group: "EURONOVA",
    close: ddmm(opts.close),
    period_from: ddmm(addDays(opts.close, -29)),
    period_to: ddmm(opts.close),
    pay_by: ddmm(addDays(opts.close, 25)),
    card_last4: LAST4,
    card_product: "Euronova Classic",
    currency: "eur",
    layout: "international_usd",
    header: {
      ...EMPTY_CARD_STATEMENT_HEADER,
      saldo_anterior: opts.saldoAnterior,
      abono: -opts.paid,
      compras_cargos: opts.facturado,
      monto_facturado: opts.facturado,
      deuda_total: opts.saldoAnterior - opts.paid + opts.facturado,
      next_period_from: ddmm(addDays(opts.close, 1)),
      next_period_to: ddmm(addDays(opts.close, 30)),
    },
    lines: opts.lines,
  };
}

let cardId = 0;
let bucketId = 0;

beforeAll(() => {
  const bucket = db
    .prepare(`SELECT id FROM asset_groups WHERE slug IN ('credit_card', 'credit_cards__credit_card') LIMIT 1`)
    .get() as { id: number };
  cardId = Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'Vitest · euro card import', ?, ?)`)
      .run(bucket.id, IMPORT_KEY, IMPORT_KEY).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4, issuer)
     VALUES (?, 1, 28, ?, 'euronova')`
  ).run(cardId, LAST4);
  const details = applyCanonicalCardStatements(
    [
      statement({
        close: CLOSE_1,
        saldoAnterior: 0,
        paid: 0,
        facturado: 300,
        lines: [
          line(addDays(CLOSE_1, -12), "BOULANGERIE VITEST", 120, "card_purchase", "vitest-euronova|1|0"),
          line(addDays(CLOSE_1, -5), "LIBRAIRIE VITEST", 180, "card_purchase", "vitest-euronova|1|1"),
        ],
      }),
      statement({
        close: CLOSE_2,
        saldoAnterior: 300,
        paid: 300,
        facturado: 100,
        lines: [
          line(PAYMENT_DAY, "PAGO", -300, "card_payment", "vitest-euronova|2|0"),
          line(addDays(CLOSE_2, -8), "MARCHE VITEST", 100, "card_purchase", "vitest-euronova|2|1"),
        ],
      }),
    ],
    { dryRun: false, full: true }
  );
  expect(details.problems).toEqual([]);
  expect(details.applied).toBe(true);
  clearAggregationCache();
});

afterAll(() => {
  wipeVitestCcFixtureData(IMPORT_KEY);
  db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(cardId);
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(cardId);
  clearAggregationCache();
});

const eurRate = (day: string, side: "debt" | "mid" = "debt") => convertCurrency(1, "eur", "clp", day, { side })!;

describe("a euro card imported through the card statement import", () => {
  it("stores its lines in euros", () => {
    const rows = db
      .prepare(
        `SELECT l.currency, l.amount FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id = ? ORDER BY l.id`
      )
      .all(cardId) as { currency: string; amount: number }[];
    expect(rows.map((r) => r.currency)).toEqual(["eur", "eur", "eur", "eur"]);
    expect(rows.map((r) => r.amount).sort((a, b) => a - b)).toEqual([-300, 100, 120, 180]);
  });

  it("refuses a currency the card's issuer does not bill in", () => {
    // A dry run: nothing is written either way.
    const base = statement({ close: CLOSE_2, saldoAnterior: 0, paid: 0, facturado: 1, lines: [line(CLOSE_2, "X", 1, "card_purchase", "x")] });
    const uf = { ...base, lines: [{ ...base.lines[0]!, currency: "uf" }] };
    expect(() => applyCanonicalCardStatements([uf], { dryRun: true, full: true })).toThrow(
      /UF is not a currency the card's issuer \(euronova\) bills in/
    );
    const unknown = { ...base, currency: "xyz" };
    expect(() => applyCanonicalCardStatements([unknown], { dryRun: true, full: true })).toThrow(/not a currency the app knows/);
  });

  it("anchors its month-ends in euros: the walk owes the open balance", () => {
    const owed = ccOwedByCurrencyAtYmd(cardId, addDays(TODAY, -1));
    expect(owed).not.toBeNull();
    expect(owed!.owed.eur).toBeCloseTo(100, 2);
    expect(owed!.owed.clp ?? 0).toBe(0);
    const anchors = db.prepare(`SELECT DISTINCT currency FROM cc_owed_anchors WHERE account_id = ?`).all(cardId) as { currency: string }[];
    expect(anchors.map((a) => a.currency)).toContain("eur");
  });

  it("values it in Pasivos at the day's euro rate", () => {
    const vals = db
      .prepare(`SELECT as_of_date, value, currency FROM valuations WHERE account_id = ? ORDER BY as_of_date`)
      .all(cardId) as { as_of_date: string; value: number; currency: string }[];
    expect(vals.length).toBeGreaterThan(0);
    const last = vals.filter((v) => v.as_of_date >= CLOSE_2 && v.as_of_date < TODAY).at(-1)!;
    expect(last.currency).toBe("clp");
    expect(last.value).toBeCloseTo(100 * eurRate(last.as_of_date), -1);
  });

  it("bills each closed facturación in euros", () => {
    const rows = billingDetailCacheForAccount(cardId).facturaciones;
    const first = rows.find((r) => r.close_date_iso === CLOSE_1)!;
    const second = rows.find((r) => r.close_date_iso === CLOSE_2)!;
    expect(facturadoForeignIn(first, "eur")!.amount).toBeCloseTo(300, 2);
    expect(facturadoForeignIn(second, "eur")!.amount).toBeCloseTo(100, 2);
    expect(rows.filter((r) => r.is_open_month)).toHaveLength(1);
  });

  it("lists its charges as euro expense lines", () => {
    const lines = withLineMoney(buildCcExpenseLines([cardId]));
    const shop = lines.find((l) => l.merchant === "MARCHE VITEST")!;
    expect(lineAmount(shop)).toEqual({ value: 100, currency: "eur" });
  });

  it("«Próximos pagos» owes the unpaid euro facturación", () => {
    const payment = buildDashboardCcUpcomingPayments()
      .months.flatMap((m) => m.payments)
      .find((p) => p.account_id === cardId && p.row.close_date_iso === CLOSE_2);
    expect(payment).toBeDefined();
    expect(payment!.row.owed.eur).toBeCloseTo(100, 2);
    expect(payment!.row.amount_clp).toBe(Math.round(100 * eurRate(TODAY, "mid")));
  });

  it("the cupo check counts what it owes in euros", () => {
    const owed = ccOwedByCurrency(cardId, TODAY);
    expect(foreignOwedIn(owed, "eur").total).toBeCloseTo(100, 2);
    const snapshot = {
      id: 0,
      account_id: cardId,
      currency: "eur",
      observed_at: `${TODAY}T12:00:00Z`,
      plastic_last4: LAST4,
      cupo_total: 1000,
      cupo_utilizado: 100,
      cupo_disponible: 900,
      feed_close_iso: null,
    };
    expect(judgeBankCupo(snapshot, owed)).toMatchObject({ status: "ok", app_owed: 100, diff: 0 });
    expect(judgeBankCupo({ ...snapshot, cupo_utilizado: 99.5 }, owed)).toMatchObject({ status: "mismatch", diff: 0.5 });
  });
});

describe("the open cycle of a euro card", () => {
  let openMonth = "";

  beforeAll(() => {
    openMonth = billingDetailCacheForAccount(cardId).facturaciones.find((r) => r.is_open_month)!.billing_month;
    // A bucket of the open facturación, as a listing would leave one (euronova lists none: written here).
    bucketId = Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, currency, layout)
           VALUES (?, 'EURONOVA', ?, ?, 'clp', 'compact')`
        )
        .run(cardId, `import:web-paste|open|${openMonth}`, statementCloseDdMmYyyyForBillingMonth(cardId, openMonth))
        .lastInsertRowid
    );
    const ins = db.prepare(
      `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, currency, installment_flag, dedupe_key)
       VALUES (?, ?, ?, ?, 'eur', 0, ?)`
    );
    ins.run(bucketId, ddmm(addDays(CLOSE_2, 5)), "CAFE VITEST", 40, "vitest-euronova|open|0");
    ins.run(bucketId, ddmm(addDays(CLOSE_2, 6)), "NOTA DE CREDITO", -10, "vitest-euronova|open|1");
    clearAggregationCache();
  });

  it("splits the open cycle's euros out of its facturado", () => {
    const foreign = openMonthForeignFacturado(cardId, openMonth);
    expect(foreign.get("eur")!.amount).toBeCloseTo(30, 2);
    expect(foreign.get("eur")!.clp).toBeGreaterThan(0);
    const open = billingDetailCacheForAccount(cardId).facturaciones.find((r) => r.is_open_month)!;
    expect(facturadoForeignIn(open, "eur")!.amount).toBeCloseTo(30, 2);
    expect(open.facturado_clp).toBe(0);
    expect(open.facturado_total_clp).toBe(foreign.get("eur")!.clp);
  });

  it("counts the open cycle's credit in euros", () => {
    expect(openFacturacionCredits(cardId, openMonth)).toEqual({ clp: 0, usd: 0, eur: 10 });
  });

  it("the cupo check adds the open cycle's euros", () => {
    const owed = foreignOwedIn(ccOwedByCurrency(cardId, TODAY), "eur");
    expect(owed.open_cycle_lines).toBeCloseTo(30, 2);
    expect(owed.total).toBeCloseTo(130, 2);
  });
});
