import type { CcBillingMonthBalanceRow } from "./ccBillingBalances.js";
import { getCreditCardAccountConfig } from "./ccAccountConfig.js";
import { listCcBillingMonthBalances } from "./ccBillingBalances.js";
import {
  pendingCuotaPurchaseLines,
  type CcBillingDetailMonthRow,
  type CcFacturacionRow,
  type CcPendingCuotaPurchase,
} from "./ccBillingViews.js";
import { billingDetailCacheForAccount } from "./ccBillingDetailCache.js";
import type { CreditCardBillingConfig } from "./ccBillingMonth.js";
import { loadCreditCardBillingConfig } from "./ccBillingMonth.js";
import {
  ccStatementRowCount,
  ccStatementsPayloadForAccount,
  type CcStatementRow,
  type CcStatementLineRow,
} from "./ccStatementsDb.js";
import { billingMonthForManualLedgerPurchase } from "./ccManualBillingMonth.js";
import { associatedCardLast4sForMaster } from "./ccConsolidatedCards.js";
import { buildCcHistorialChartSeries, type CcHistorialChartPoint } from "./creditCardChartSeries.js";
import type { DataOrigin } from "./dataOrigin.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { ccInstallmentDebtAtMonthEndsClp } from "./ccInstallmentDebtDaily.js";
import {
  computeProxyLot,
  getCcProxyTickers,
  installmentPurchaseToLot,
  aggregateProxyByFacturacion,
  buildNormalPurchaseProxyForAccount,
  tickersWithData,
  type ProxyLotResult,
  type ProxyFacturacionAggregate,
} from "./ccInvestmentProxy.js";

export { parseYearMonth, addCalendarMonths } from "./ccYearMonth.js";


export type CcInstallmentPurchaseRow = {
  purchase_id: string;
  label: string;
  principal_clp: number;
  installment_count: number;
  installments_paid: number;
  cuota_clp: number;
  annual_interest_pct: number;
  /** Calendar month (YYYY-MM) of installment index 0 (first cuota of the contract). */
  first_due_month: string;
  /** Extra months added to every installment index (persistent in CSV; e.g. +1 if statement slipped a month). */
  schedule_offset_months: number;
  purchase_month: string | null;
  note: string | null;
};

export type CcInstallmentPurchaseComputed = CcInstallmentPurchaseRow & {
  /** SQLite row id (DB ledger only). */
  purchase_db_id?: number;
  remaining_installments: number;
  remaining_principal_clp: number;
  next_due_month: string | null;
  next_installment_index: number | null;
  /** Calendar month (YYYY-MM) of the last recorded installment payment (`pay_by` / schedule). */
  last_paid_month: string | null;
  /** Constant cuota for upcoming months (CLP). */
  upcoming_cuota_clp: number;
  /** Payment rows linked to this purchase (DB source only), for manual audit in UI. */
  payment_statements?: {
    pay_by_date: string;
    statement_date: string | null;
    source_pdf: string | null;
    cuota_current: number | null;
    amount_clp: number;
  }[];
  /** Canonical + sibling purchase ids merged by logical fingerprint dedupe. */
  merged_purchase_ids?: number[];
  /** Why sibling IDs were merged. */
  merge_reason?: string | null;
  /** Human-readable notes for heuristics used in this logical row. */
  heuristic_hints?: string[];
  /** How this purchase entered the system. */
  origin: DataOrigin;
  /** @deprecated Use `origin`. */
  purchase_source?: "pdf" | "manual";
  /** Purchase date (YYYY-MM-DD; DB ledger only). */
  purchase_date?: string;
  /** Facturación month the purchase falls into (billing config applied to the purchase date). */
  purchase_billing_month?: string | null;
};

export type CcInstallmentMonthBreakdown = {
  purchase_id: string;
  label: string;
  installment_index: number;
  installment_count: number;
  amount_clp: number;
};

export type CcInstallmentMonthRow = {
  /** Facturación (statement) month — the close that bills these cuotas. */
  month: string;
  total_clp: number;
  breakdown: CcInstallmentMonthBreakdown[];
};

/** Cuotas-del-mes calendar row: one facturación event with its pay-by date and the plan debt left after it. */
export type CcInstallmentCalendarMonthRow = CcInstallmentMonthRow & {
  /** Statement `PAGAR HASTA` when the facturación is closed; derived (~10th of next month) for open/projected. */
  pay_by_date: string;
  /** Plan debt remaining after this facturación's cuotas are paid (suffix sum; last row = 0). */
  debt_after_clp: number;
};

export type CcInstallmentsTotals = {
  total_remaining_principal_clp: number;
  /** Sum of all cuotas due in the earliest month that still has a payment (any purchase). */
  next_calendar_month_total_clp: number | null;
  next_calendar_month: string | null;
};

/**
 * Credit line snapshot for the card's summary cards: the configured CLP cupo, the balance
 * used on the open billing month (else the latest closed statement), and what is left.
 * Computed here so the account page and the Pasivos group page show the same numbers.
 */
export type CcCupoSnapshot = {
  total_clp: number | null;
  used_clp: number | null;
  /** `total − used` when both are known, else null (an unconfigured cupo is not 0). */
  available_clp: number | null;
  /** Billing month whose `balance_total_clp` is `used_clp` (open month, else latest statement). */
  billing_month: string | null;
};

export function ccCupoSnapshot(
  totalClp: number | null,
  rows: readonly Pick<CcBillingDetailMonthRow, "billing_month" | "as_of_kind" | "balance_total_clp">[],
  openBillingMonth: string | null
): CcCupoSnapshot {
  const openRow =
    openBillingMonth != null ? rows.find((r) => r.billing_month === openBillingMonth) : undefined;
  const latestStatement = rows
    .filter((r) => r.as_of_kind === "statement")
    .reduce<(typeof rows)[number] | undefined>(
      (best, r) => (best == null || r.billing_month > best.billing_month ? r : best),
      undefined
    );
  const row = openRow ?? latestStatement;
  const used = row?.balance_total_clp ?? null;
  const total = totalClp != null && Number.isFinite(totalClp) ? totalClp : null;
  return {
    total_clp: total,
    used_clp: used,
    available_clp: total != null && used != null ? total - used : null,
    billing_month: row?.billing_month ?? null,
  };
}

function ccCupoSnapshotForAccount(
  accountId: number,
  rows: readonly CcBillingDetailMonthRow[],
  openBillingMonth: string | null
): CcCupoSnapshot {
  const cupoClp = getCreditCardAccountConfig(accountId).cupo.find((c) => c.currency === "clp")?.value ?? null;
  return ccCupoSnapshot(cupoClp, rows, openBillingMonth);
}

export type CcInstallmentsMeta = {
  installment_purchase_count?: number;
  installment_payment_count?: number;
  /** master.json key resolved client-side via t() — server payloads carry no display prose. */
  pay_by_rule_i18n_key?: string;
};


/** Interest portion of cuota at 0-based installment index (0% APR → 0). */
export function installmentInterestClpForCuota(
  principal: number,
  annualPct: number,
  installmentCount: number,
  installmentIndex: number,
  cuota: number
): number {
  if (annualPct <= 0 || principal <= 0 || installmentCount <= 0 || cuota <= 0) return 0;
  if (installmentIndex < 0 || installmentIndex >= installmentCount) return 0;
  const r = annualPct / 100 / 12;
  let bal = principal;
  for (let i = 0; i < installmentIndex; i++) {
    if (bal <= 0) return 0;
    const interest = bal * r;
    const princPart = cuota - interest;
    bal = Math.max(0, bal - princPart);
  }
  if (bal <= 0) return 0;
  return Math.round(bal * r);
}

export type CcInstallmentsResponseBase = {
  account_id: number;
  has_installment_ledger: boolean;
  has_imported_statements: boolean;
  meta: CcInstallmentsMeta | null;
  purchases: CcInstallmentPurchaseComputed[];
  purchases_completed: CcInstallmentPurchaseComputed[];
  hidden_cancelled_purchases?: CcInstallmentPurchaseComputed[];
  months: CcInstallmentCalendarMonthRow[];
  totals: CcInstallmentsTotals;
  installment_history_months?: {
    month: string;
    remaining_balance_clp: number;
    installment_payments_clp: number;
    ledger_remaining_installments_clp?: number;
  }[];
  statements?: (CcStatementRow & { lines: CcStatementLineRow[] })[];
  billing_month_balances?: CcBillingMonthBalanceRow[];
  billing_detail_by_month?: CcBillingDetailMonthRow[];
  facturaciones?: CcFacturacionRow[];
  billing_config?: CreditCardBillingConfig;
  /** Credit line snapshot for the summary cards — see {@link ccCupoSnapshot}. */
  cupo?: CcCupoSnapshot;
  /**
   * Feed-typed cuota purchases still waiting for their count (`pendingCuotaPurchaseLines`): the
   * card page asks for it. Per card only — a merged group ledger does not carry it.
   */
  pending_cuota_purchases?: CcPendingCuotaPurchase[];
  open_billing_month?: string | null;
  associated_card_last4s?: string[];
  historial_chart?: CcHistorialChartPoint[];
  /** Tracked proxy tickers for this response. */
  proxy_tickers?: string[];
  /** Per-purchase proxy earnings, keyed by purchase_db_id. */
  purchase_proxy?: Record<number, ProxyLotResult>;
  /** Per-facturación aggregated proxy earnings. */
  facturacion_proxy?: ProxyFacturacionAggregate[];
};

function buildInstallmentProxy(
  accountId: number,
  purchases: readonly CcInstallmentPurchaseComputed[],
  facturaciones: readonly CcFacturacionRow[],
  tickers: string[],
  today: string
): { purchaseProxy: Record<number, ProxyLotResult>; facturacionProxy: ProxyFacturacionAggregate[] } {
  const purchaseProxy: Record<number, ProxyLotResult> = {};
  const allLotResults: ProxyLotResult[] = [];
  const activeTickers = tickersWithData(tickers);

  if (activeTickers.length > 0) {
    for (const p of purchases) {
      if (!p.purchase_db_id) continue;
      const lot = installmentPurchaseToLot(p);
      if (!lot) continue;
      const result = computeProxyLot(lot, activeTickers, today);
      purchaseProxy[p.purchase_db_id] = result;
      allLotResults.push(result);
    }
  }

  // Normal purchase lots, dated by the same facturaciones rows the table shows. Every withdrawal,
  // cuota or one-shot, carries the facturación that billed it.
  allLotResults.push(...buildNormalPurchaseProxyForAccount(accountId, tickers, today, facturaciones));

  const facturacionProxy = aggregateProxyByFacturacion(allLotResults, activeTickers);
  return { purchaseProxy, facturacionProxy };
}

export function creditCardInstallmentsResponse(
  accountId: number,
  proxyTickers?: string[]
): CcInstallmentsResponseBase {
  const associated_card_last4s = associatedCardLast4sForMaster(accountId);
  const open_billing_month = billingMonthForManualLedgerPurchase(accountId);
  const tickers = proxyTickers ?? getCcProxyTickers();
  const today = chileCalendarTodayYmd();

  // Ledger payload + billing detail + facturaciones come from the per-account aggregation
  // cache (cc.billing_detail|<id>) — shared with the CC valuations sync, one build per
  // cache generation instead of a full rebuild per request (the Pasivos group ledger calls
  // this once per master).
  const bundle = billingDetailCacheForAccount(accountId);

  if (bundle.payload != null) {
    const db = bundle.payload;
    const billingDetail = bundle.detail;
    const facturaciones = bundle.facturaciones;
    const { purchaseProxy, facturacionProxy } = buildInstallmentProxy(
      accountId,
      [...db.purchases, ...db.purchases_completed],
      facturaciones,
      tickers,
      today
    );
    return {
      account_id: accountId,
      has_installment_ledger: true,
      has_imported_statements: ccStatementRowCount(accountId) > 0,
      open_billing_month,
      associated_card_last4s,
      meta: {
        installment_purchase_count: db.meta.installment_purchase_count,
        installment_payment_count: db.meta.installment_payment_count,
        pay_by_rule_i18n_key: db.meta.pay_by_rule_i18n_key,
      },
      purchases: db.purchases,
      purchases_completed: db.purchases_completed,
      hidden_cancelled_purchases: db.hidden_cancelled_purchases,
      months: db.months,
      totals: db.totals,
      installment_history_months: db.installment_history_months,
      statements: ccStatementsPayloadForAccount(accountId).statements,
      billing_month_balances: listCcBillingMonthBalances(accountId),
      billing_detail_by_month: billingDetail,
      facturaciones,
      billing_config: loadCreditCardBillingConfig(accountId),
      cupo: ccCupoSnapshotForAccount(accountId, billingDetail, open_billing_month),
      pending_cuota_purchases: pendingCuotaPurchaseLines(accountId),
      historial_chart: buildCcHistorialChartSeries(
        db.installment_history_months,
        billingDetail,
        facturaciones,
        { installmentDebtForMonths: (months) => ccInstallmentDebtAtMonthEndsClp([accountId], months) }
      ),
      proxy_tickers: tickers,
      purchase_proxy: purchaseProxy,
      facturacion_proxy: facturacionProxy,
    };
  }

  if (ccStatementRowCount(accountId) > 0) {
    const billing = listCcBillingMonthBalances(accountId);
    const latestCupo =
      billing.length > 0
        ? [...billing].sort((a, b) => b.as_of_date.localeCompare(a.as_of_date))[0]!.cupo_utilizado_clp
        : 0;
    const billingDetail = bundle.detail;
    const facturaciones = bundle.facturaciones;
    return {
      account_id: accountId,
      has_installment_ledger: false,
      has_imported_statements: true,
      open_billing_month,
      associated_card_last4s,
      meta: {
        pay_by_rule_i18n_key: "account.creditCard.payByRule.statementsOnly",
      },
      purchases: [],
      purchases_completed: [],
      hidden_cancelled_purchases: [],
      months: [],
      totals: {
        total_remaining_principal_clp: latestCupo,
        next_calendar_month_total_clp: null,
        next_calendar_month: null,
      },
      statements: ccStatementsPayloadForAccount(accountId).statements,
      billing_month_balances: billing,
      billing_detail_by_month: billingDetail,
      facturaciones,
      billing_config: loadCreditCardBillingConfig(accountId),
      cupo: ccCupoSnapshotForAccount(accountId, billingDetail, open_billing_month),
      pending_cuota_purchases: pendingCuotaPurchaseLines(accountId),
      historial_chart: buildCcHistorialChartSeries([], billingDetail, facturaciones),
    };
  }

  return {
    account_id: accountId,
    has_installment_ledger: false,
    has_imported_statements: false,
    open_billing_month,
    associated_card_last4s,
    meta: null,
    purchases: [],
    purchases_completed: [],
    hidden_cancelled_purchases: [],
    months: [],
    totals: {
      total_remaining_principal_clp: 0,
      next_calendar_month_total_clp: null,
      next_calendar_month: null,
    },
  };
}
