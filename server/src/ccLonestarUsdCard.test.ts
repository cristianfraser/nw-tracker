import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CARD_PARSED_STATEMENT_COLUMNS } from "nw-tracker-contracts";
import { clearAggregationCache } from "./cacheRegistry.js";
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import { ccFinancingCostByDateInUnit } from "./ccFinancingCostDaily.js";
import { CC_ISSUERS, ccIssuerBySlug } from "./ccIssuers.js";
import { ccDerivedPayByRuleForAccount, ccIssuerSlugForMasterAccount } from "./ccIssuerForAccount.js";
import { derivedPayByIso } from "./ccInstallmentPayBy.js";
import { ccOwedByCurrencyAtYmd, ccOwedClpAtYmd, ccUsdOwedRateClp } from "./ccOwedWalk.js";
import { applyCanonicalCardStatements } from "./ccParsedStatementsApply.js";
import { pdfClosedBillingMonthsForAccount } from "./cards/facturacion.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { buildDashboardCcUpcomingPayments } from "./dashboardCcUpcomingPayments.js";
import { fxForLiveMtm } from "./fxLive.js";
import { listCreditCardMasterAccountIdsInNavOrder } from "./creditCardTree.js";
import { parsedStatements } from "./test/parsedStatementRecords.js";
import {
  VITEST_LONESTAR_CARD_LAST4,
  VITEST_LONESTAR_CC_MASTER_NOTES,
  ensureVitestLonestarFixture,
  wipeVitestCcFixtureData,
} from "./test/vitestDbSeed.js";

/**
 * The fictional US issuer (Lonestar): a card with a dollar side only. Two monthly statements go
 * through the same import every issuer's go through; the owed walk, the facturaciones table, the
 * financing cost and «Próximos pagos» read them with no peso statement ever on file.
 */

const TODAY = chileCalendarTodayYmd();
function addDaysIso(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
function ddmmyyyy(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}
const usd = (n: number) => n.toFixed(2).replace(".", ",");

const CLOSE_1 = addDaysIso(TODAY, -50);
const CLOSE_2 = addDaysIso(TODAY, -20);
const PAY_BY_1 = addDaysIso(CLOSE_1, 25);
const PAY_BY_2 = addDaysIso(CLOSE_2, 25);
const PAYMENT_DATE = addDaysIso(TODAY, -30);
const INTEREST_DATE = CLOSE_2;

type Line = { date: string; merchant: string; amount: number };

function statementRecords(opts: {
  close: string;
  from: string;
  payBy: string;
  nextClose: string;
  saldoAnterior: number;
  paid: number;
  facturado: number;
  /** The interest and fees (section 3) inside `facturado`. */
  interest: number;
  lines: Line[];
}): Record<string, string>[] {
  const header = () => ({
    ...Object.fromEntries(CARD_PARSED_STATEMENT_COLUMNS.map((c) => [c, ""])),
    card_group: "A",
    source_pdf: `vitest-lonestar-${opts.close}.pdf`,
    statement_date: ddmmyyyy(opts.close),
    period_from: ddmmyyyy(opts.from),
    period_to: ddmmyyyy(opts.close),
    pay_by: ddmmyyyy(opts.payBy),
    card_last4: VITEST_LONESTAR_CARD_LAST4,
    card_product: "Lonestar Rewards",
    parser_layout: "international_usd",
    currency: "usd",
    statement_saldo_anterior: usd(opts.saldoAnterior),
    statement_compras_cargos: usd(opts.facturado - opts.interest),
    statement_monto_facturado: usd(opts.facturado),
    statement_abono: usd(-opts.paid),
    statement_deuda_total: usd(opts.saldoAnterior - opts.paid + opts.facturado),
    statement_next_period_from: ddmmyyyy(opts.close),
    statement_next_period_to: ddmmyyyy(opts.nextClose),
  });
  return opts.lines.map((l, i) => ({
    ...header(),
    transaction_date: ddmmyyyy(l.date),
    merchant: l.merchant,
    description_merged: l.merchant,
    raw_line: `${ddmmyyyy(l.date)} ${l.merchant}`,
    installment_flag: "false",
    amount_usd: usd(l.amount),
    row_id: `vitest-lonestar|${opts.close}|${i}`,
    dedupe_key: `vitest-lonestar|${opts.close}|${i}`,
    canonical_row_id: `vitest-lonestar|${opts.close}|${i}`,
  }));
}

let accountId = 0;

beforeAll(() => {
  accountId = ensureVitestLonestarFixture();
  const records = [
    ...statementRecords({
      close: CLOSE_1,
      from: addDaysIso(CLOSE_1, -30),
      payBy: PAY_BY_1,
      nextClose: CLOSE_2,
      saldoAnterior: 0,
      paid: 0,
      facturado: 300,
      interest: 0,
      lines: [
        { date: addDaysIso(CLOSE_1, -12), merchant: "GROCERY MART #12 AUSTIN TX", amount: 120 },
        { date: addDaysIso(CLOSE_1, -5), merchant: "TRAIL OUTFITTERS DENVER CO", amount: 180 },
      ],
    }),
    ...statementRecords({
      close: CLOSE_2,
      from: addDaysIso(CLOSE_2, -29),
      payBy: PAY_BY_2,
      nextClose: addDaysIso(CLOSE_2, 30),
      saldoAnterior: 300,
      paid: 300,
      facturado: 100,
      interest: 5.5,
      lines: [
        { date: PAYMENT_DATE, merchant: "PAYMENT - THANK YOU", amount: -300 },
        { date: addDaysIso(CLOSE_2, -8), merchant: "GROCERY MART #12 AUSTIN TX", amount: 94.5 },
        { date: INTEREST_DATE, merchant: "INTEREST CHARGE ON PURCHASES", amount: 5.5 },
      ],
    }),
  ];
  const details = applyCanonicalCardStatements(parsedStatements(records), { dryRun: false, full: true });
  expect(details.problems).toEqual([]);
  expect(details.applied).toBe(true);
  clearAggregationCache();
});

afterAll(() => {
  wipeVitestCcFixtureData(VITEST_LONESTAR_CC_MASTER_NOTES);
  clearAggregationCache();
});

describe("a USD-only card of a US issuer", () => {
  it("the issuer is data: close + 25 days, listed after the other issuers", () => {
    expect(ccIssuerSlugForMasterAccount(accountId)).toBe("lonestar");
    expect(ccDerivedPayByRuleForAccount(accountId)).toEqual({ kind: "close_plus_days", days: 25 });
    expect(derivedPayByIso("2026-03-31", ccDerivedPayByRuleForAccount(accountId))).toBe("2026-04-25");
    const order = CC_ISSUERS.map((i) => i.sort_order);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(ccIssuerBySlug("lonestar")!.sort_order).toBeGreaterThan(ccIssuerBySlug("cmr")!.sort_order);
    expect(listCreditCardMasterAccountIdsInNavOrder()).toContain(accountId);
  });

  it("the owed walk values the dollars at the day's rate, with no peso side", () => {
    const owed = ccOwedByCurrencyAtYmd(accountId, addDaysIso(TODAY, -1));
    expect(owed).not.toBeNull();
    expect(owed!.clp).toBe(0);
    expect(owed!.usd).toBeCloseTo(100, 2);
    const day = addDaysIso(TODAY, -1);
    const rate = ccUsdOwedRateClp(100, day)!;
    expect(ccOwedClpAtYmd(accountId, day)!.value_clp).toBeCloseTo(100 * rate, 0);
  });

  it("the facturaciones table shows the statement close and pay-by, then a derived pay-by", () => {
    const rows = billingDetailCacheForAccount(accountId).facturaciones;
    const closed = rows.find((r) => r.close_date_iso === CLOSE_2);
    expect(closed).toBeDefined();
    expect(closed!.pay_by_iso).toBe(PAY_BY_2);
    expect(closed!.pay_by_source).toBe("statement");
    expect(closed!.facturado_usd).toBeCloseTo(100, 2);
    const open = rows.find((r) => r.is_open_month);
    expect(open).toBeDefined();
    expect(open!.pay_by_source).toBe("derived");
    expect(open!.pay_by_iso).toBe(derivedPayByIso(open!.close_date_iso, { kind: "close_plus_days", days: 25 }));
    // The months close on their dollar statements alone: nothing waits for a peso twin.
    expect([...pdfClosedBillingMonthsForAccount(accountId)].sort()).toEqual(rows.map((r) => r.billing_month).filter((m) => !rows.find((r) => r.billing_month === m)!.is_open_month).sort());
    expect(rows.filter((r) => r.is_open_month)).toHaveLength(1);
  });

  it("the interest line is the card's cost of financing; the payment is not", () => {
    const costs = ccFinancingCostByDateInUnit(accountId, "usd");
    expect(costs.get(INTEREST_DATE)).toBeCloseTo(5.5, 2);
    expect(costs.get(PAYMENT_DATE) ?? 0).toBeCloseTo(0, 6);
  });

  it("«Próximos pagos» lists the unpaid closed facturación", () => {
    const block = buildDashboardCcUpcomingPayments();
    const payment = block.months.flatMap((m) => m.payments).find((p) => p.account_id === accountId && p.row.close_date_iso === CLOSE_2);
    expect(payment).toBeDefined();
    expect(payment!.row.pay_by_iso).toBe(PAY_BY_2);
    expect(payment!.row.close_observed).toBe(true);
    // US$100 owed, in pesos at today's live rate.
    expect(payment!.row.amount_clp).toBe(Math.round(100 * (fxForLiveMtm(TODAY)?.clp_per_usd ?? NaN)));
  });
});
