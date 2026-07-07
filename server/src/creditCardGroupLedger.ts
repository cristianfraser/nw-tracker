import { resolveOperationalAccountId } from "./accountSource.js";
import type { CcBillingDetailMonthRow, CcFacturacionRow } from "./ccBillingViews.js";
import type { CcFinancingPlMonthRow } from "./creditCardPerformancePl.js";
import { getCreditCardGroupBySlug, listCreditCardGroupMasterAccountIds } from "./creditCardTree.js";
import {
  creditCardInstallmentsResponse,
  type CcInstallmentsTotals,
} from "./creditCardInstallments.js";
import { buildCcBillingMonthChartSeries, buildCcHistorialChartSeries } from "./creditCardChartSeries.js";
import { listLiabilitiesTabAccountRows } from "./liabilityTabAccounts.js";
import { isNavRetiredCcMaster } from "./ccNavRetired.js";

type CcLedgerResponse = ReturnType<typeof creditCardInstallmentsResponse>;

function sumNullable(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

function resolveCcMasterAccountIds(portfolioGroupSlug: string): number[] {
  if (getCreditCardGroupBySlug(portfolioGroupSlug)) {
    return listCreditCardGroupMasterAccountIds(portfolioGroupSlug);
  }
  if (portfolioGroupSlug === "liabilities_credit_card" || portfolioGroupSlug === "liabilities") {
    return listLiabilitiesTabAccountRows("credit_card").map((r) =>
      resolveOperationalAccountId(r.account_id)
    );
  }
  return [];
}

function mergeFacturaciones(ledgers: CcLedgerResponse[]): CcFacturacionRow[] {
  const byMonth = new Map<string, CcFacturacionRow>();
  for (const ledger of ledgers) {
    for (const row of ledger.facturaciones ?? []) {
      const prev = byMonth.get(row.billing_month);
      if (!prev) {
        byMonth.set(row.billing_month, { ...row });
        continue;
      }
      byMonth.set(row.billing_month, {
        ...prev,
        facturado_clp: sumNullable(prev.facturado_clp, row.facturado_clp),
        facturado_usd: sumNullable(prev.facturado_usd, row.facturado_usd),
        facturado_usd_clp: sumNullable(prev.facturado_usd_clp, row.facturado_usd_clp),
        facturado_total_clp: sumNullable(prev.facturado_total_clp, row.facturado_total_clp),
        cuota_a_pagar_clp: sumNullable(prev.cuota_a_pagar_clp, row.cuota_a_pagar_clp),
        is_open_month: prev.is_open_month || row.is_open_month,
        close_date: prev.billing_month >= row.billing_month ? prev.close_date : row.close_date,
        close_date_iso:
          prev.billing_month >= row.billing_month ? prev.close_date_iso : row.close_date_iso,
        pay_by: prev.pay_by ?? row.pay_by,
        pay_by_iso: prev.pay_by_iso ?? row.pay_by_iso,
      });
    }
  }
  return [...byMonth.values()].sort((a, b) => b.billing_month.localeCompare(a.billing_month));
}

function mergeBillingDetail(ledgers: CcLedgerResponse[]): CcBillingDetailMonthRow[] {
  const byMonth = new Map<string, CcBillingDetailMonthRow>();
  for (const ledger of ledgers) {
    for (const row of ledger.billing_detail_by_month ?? []) {
      const prev = byMonth.get(row.billing_month);
      if (!prev) {
        byMonth.set(row.billing_month, { ...row });
        continue;
      }
      const asOfKind =
        prev.as_of_kind === "statement" || row.as_of_kind === "statement" ? "statement" : "manual";
      const asOfDate =
        prev.as_of_date.localeCompare(row.as_of_date) >= 0 ? prev.as_of_date : row.as_of_date;
      byMonth.set(row.billing_month, {
        billing_month: row.billing_month,
        as_of_date: asOfDate,
        as_of_kind: asOfKind,
        total_facturado_actual_clp: sumNullable(
          prev.total_facturado_actual_clp,
          row.total_facturado_actual_clp
        ),
        total_facturado_clp: sumNullable(prev.total_facturado_clp, row.total_facturado_clp),
        cupo_en_cuotas_clp: prev.cupo_en_cuotas_clp + row.cupo_en_cuotas_clp,
        cuota_a_pagar_next_mes_clp:
          prev.cuota_a_pagar_next_mes_clp + row.cuota_a_pagar_next_mes_clp,
        balance_total_clp: prev.balance_total_clp + row.balance_total_clp,
        ...(prev.projected === true && row.projected === true ? { projected: true } : {}),
      });
    }
  }
  return [...byMonth.values()].sort((a, b) => b.billing_month.localeCompare(a.billing_month));
}

function mergeFinancingPl(ledgers: CcLedgerResponse[]): CcFinancingPlMonthRow[] {
  const byMonth = new Map<string, CcFinancingPlMonthRow>();
  for (const ledger of ledgers) {
    for (const row of ledger.financing_pl_by_month ?? []) {
      const prev = byMonth.get(row.billing_month);
      if (!prev) {
        byMonth.set(row.billing_month, { ...row });
        continue;
      }
      byMonth.set(row.billing_month, {
        billing_month: row.billing_month,
        statement_charges_clp: prev.statement_charges_clp + row.statement_charges_clp,
        installment_interest_clp: prev.installment_interest_clp + row.installment_interest_clp,
        financing_cost_clp: prev.financing_cost_clp + row.financing_cost_clp,
        ytd_financing_cost_clp: 0,
        cumulative_financing_cost_clp: 0,
      });
    }
  }
  const sorted = [...byMonth.values()].sort((a, b) => a.billing_month.localeCompare(b.billing_month));
  let ytdYear = 0;
  let ytdRun = 0;
  let cum = 0;
  return sorted.map((row) => {
    const y = Number(row.billing_month.slice(0, 4));
    if (Number.isFinite(y) && y !== ytdYear) {
      ytdYear = y;
      ytdRun = 0;
    }
    ytdRun += row.financing_cost_clp;
    cum += row.financing_cost_clp;
    return {
      ...row,
      ytd_financing_cost_clp: ytdRun,
      cumulative_financing_cost_clp: cum,
    };
  });
}

function mergeInstallmentHistory(ledgers: CcLedgerResponse[]) {
  const byMonth = new Map<
    string,
    {
      month: string;
      remaining_balance_clp: number;
      installment_payments_clp: number;
      ledger_remaining_installments_clp?: number;
    }
  >();
  for (const ledger of ledgers) {
    for (const row of ledger.installment_history_months ?? []) {
      const prev = byMonth.get(row.month);
      if (!prev) {
        byMonth.set(row.month, { ...row });
        continue;
      }
      byMonth.set(row.month, {
        month: row.month,
        remaining_balance_clp: prev.remaining_balance_clp + row.remaining_balance_clp,
        installment_payments_clp: prev.installment_payments_clp + row.installment_payments_clp,
        ledger_remaining_installments_clp:
          (prev.ledger_remaining_installments_clp ?? 0) +
          (row.ledger_remaining_installments_clp ?? 0),
      });
    }
  }
  return [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month));
}

function mergeTotals(ledgers: CcLedgerResponse[]): CcInstallmentsTotals {
  const total_remaining_principal_clp = ledgers.reduce(
    (sum, l) => sum + l.totals.total_remaining_principal_clp,
    0
  );
  const byMonth = new Map<string, number>();
  for (const l of ledgers) {
    const m = l.totals.next_calendar_month;
    const t = l.totals.next_calendar_month_total_clp;
    if (m && t != null && t > 0) {
      byMonth.set(m, (byMonth.get(m) ?? 0) + t);
    }
  }
  const months = [...byMonth.keys()].sort();
  const next_calendar_month = months[0] ?? null;
  return {
    total_remaining_principal_clp,
    next_calendar_month,
    next_calendar_month_total_clp: next_calendar_month
      ? (byMonth.get(next_calendar_month) ?? null)
      : null,
  };
}

function mergeOpenBillingMonth(ledgers: CcLedgerResponse[]): string | null {
  const active = ledgers.filter(
    (l) => l.open_billing_month != null && !isNavRetiredCcMaster(l.account_id)
  );
  if (active.length === 0) return null;
  const first = active[0]!.open_billing_month!;
  return active.every((l) => l.open_billing_month === first) ? first : null;
}

/** Merge per-master CC ledger payloads into one group-shaped response. */
export function mergeCreditCardLedgers(ledgers: CcLedgerResponse[]): CcLedgerResponse {
  if (ledgers.length === 0) {
    return {
      account_id: 0,
      has_installment_ledger: false,
      has_imported_statements: false,
      meta: null,
      purchases: [],
      purchases_completed: [],
      months: [],
      totals: {
        total_remaining_principal_clp: 0,
        next_calendar_month_total_clp: null,
        next_calendar_month: null,
      },
      financing_pl_by_month: [],
    };
  }
  if (ledgers.length === 1) {
    return { ...ledgers[0]!, account_id: 0 };
  }

  const associated = new Set<string>();
  for (const l of ledgers) {
    for (const last4 of l.associated_card_last4s ?? []) {
      associated.add(last4);
    }
  }

  const facturaciones = mergeFacturaciones(ledgers);
  const financing_pl_by_month = mergeFinancingPl(ledgers);
  const installment_history_months = mergeInstallmentHistory(ledgers);
  const billing_detail_by_month = mergeBillingDetail(ledgers);
  return {
    account_id: 0,
    has_installment_ledger: ledgers.some((l) => l.has_installment_ledger),
    has_imported_statements: ledgers.some((l) => l.has_imported_statements),
    meta: null,
    purchases: [],
    purchases_completed: [],
    months: [],
    totals: mergeTotals(ledgers),
    installment_history_months,
    facturaciones,
    billing_detail_by_month,
    financing_pl_by_month,
    billing_month_chart: buildCcBillingMonthChartSeries(facturaciones, financing_pl_by_month),
    historial_chart: buildCcHistorialChartSeries(installment_history_months, billing_detail_by_month, facturaciones),
    open_billing_month: mergeOpenBillingMonth(ledgers),
    associated_card_last4s: [...associated].sort(),
  };
}

export function creditCardGroupLedgerResponse(
  portfolioGroupSlug: string,
  extraOffsets: Record<string, number> = {}
): CcLedgerResponse {
  const masterIds = resolveCcMasterAccountIds(portfolioGroupSlug);
  if (masterIds.length === 0) {
    return mergeCreditCardLedgers([]);
  }
  const ledgers = masterIds.map((id) => creditCardInstallmentsResponse(id, extraOffsets));
  return mergeCreditCardLedgers(ledgers);
}
