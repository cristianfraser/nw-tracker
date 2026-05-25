import { billingMonthForStatementDate } from "./ccBillingMonth.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import { listCcBillingMonthBalances, type CcBillingMonthBalanceRow } from "./ccBillingBalances.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { facturadoFromStatement } from "./ccBillingBalances.js";
import {
  cupoEnCuotasClpForCalendarMonth,
  liveCreditCardOutstandingClp,
} from "./ccInstallmentLedgerDb.js";
import { parseDdMmYyToIso, resolveInstallmentPayByIso } from "./ccInstallmentPayBy.js";
import { loadCcFacturadoPlaceholdersMap } from "./ccBillingPlaceholders.js";
import { listCcStatementsForAccount, type CcStatementRow } from "./ccStatementsDb.js";
import type { CcInstallmentMonthRow } from "./creditCardInstallments.js";
import { fxMonthEndForBalanceUsd } from "./fxRates.js";

export type CcBillingDetailMonthRow = {
  billing_month: string;
  as_of_date: string;
  as_of_kind: "statement" | "manual";
  /** Closed-statement facturado only; null when not yet closed. */
  total_facturado_actual_clp: number | null;
  /** User estimate while actual is missing; null when not set. */
  facturado_placeholder_clp: number | null;
  /** Effective facturado for balance (actual or placeholder). */
  total_facturado_clp: number | null;
  facturado_is_placeholder: boolean;
  facturado_editable: boolean;
  cupo_en_cuotas_clp: number;
  /** Ledger cuota due in the pay-by month (~10th of month after close). */
  cuota_a_pagar_next_mes_clp: number;
  balance_total_clp: number;
};

export type CcFacturacionRow = {
  billing_month: string;
  close_date: string;
  close_date_iso: string;
  pay_by: string | null;
  pay_by_iso: string | null;
  facturado_clp: number | null;
  facturado_usd: number | null;
  facturado_usd_clp: number | null;
  facturado_total_clp: number | null;
  cuota_a_pagar_clp: number | null;
};

function pickSnapshotRow(
  rows: CcBillingMonthBalanceRow[],
  billingMonth: string
): CcBillingMonthBalanceRow | null {
  const forMonth = rows.filter(
    (r) => r.billing_month === billingMonth && r.as_of_kind !== "month_end"
  );
  const statement = forMonth.find((r) => r.as_of_kind === "statement");
  if (statement) return statement;
  const manual = forMonth.find((r) => r.as_of_kind === "manual");
  return manual ?? null;
}

function cupoEnCuotasForBillingMonth(
  accountId: number,
  billingMonth: string,
  cupoLive: number
): number {
  const currentBillingMonth = billingMonthForStatementDate(chileCalendarTodayYmd());
  if (currentBillingMonth && billingMonth === currentBillingMonth) return cupoLive;
  return cupoEnCuotasClpForCalendarMonth(accountId, billingMonth);
}

function statementSlotsByBillingMonth(accountId: number): Map<
  string,
  { clp: CcStatementRow | null; usd: CcStatementRow | null }
> {
  const byMonth = new Map<
    string,
    { clp: CcStatementRow | null; usd: CcStatementRow | null }
  >();
  for (const st of listCcStatementsForAccount(accountId)) {
    const bm = st.billing_month;
    if (!bm) continue;
    let slot = byMonth.get(bm);
    if (!slot) {
      slot = { clp: null, usd: null };
      byMonth.set(bm, slot);
    }
    if (st.currency === "usd") slot.usd = st;
    else slot.clp = st;
  }
  return byMonth;
}

function cuotaAPagarNextMesClp(
  billingMonth: string,
  ledgerMonths: CcInstallmentMonthRow[],
  slots: Map<string, { clp: CcStatementRow | null; usd: CcStatementRow | null }>
): number {
  const slot = slots.get(billingMonth);
  const primary = slot?.clp ?? slot?.usd;
  if (slot && primary) {
    const { pay_by_iso: payByIso } = resolveFacturacionPayBy(slot, primary);
    const cuota = cuotaForPayByMonth(payByIso, ledgerMonths);
    if (cuota != null) return cuota;
  }
  const payYm = addCalendarMonths(billingMonth, 1);
  const row = ledgerMonths.find((m) => m.month === payYm);
  return row && row.total_clp > 0 ? row.total_clp : 0;
}

export function buildBillingDetailByMonth(
  accountId: number,
  ledgerMonths: CcInstallmentMonthRow[] = []
): CcBillingDetailMonthRow[] {
  const balances = listCcBillingMonthBalances(accountId).filter(
    (r) => r.as_of_kind !== "month_end"
  );
  const placeholders = loadCcFacturadoPlaceholdersMap(accountId);
  const cupoLive = liveCreditCardOutstandingClp(accountId) ?? 0;
  const slots = statementSlotsByBillingMonth(accountId);
  const months = new Set<string>();
  for (const r of balances) {
    months.add(r.billing_month);
  }

  const out: CcBillingDetailMonthRow[] = [];
  for (const billingMonth of months) {
    const snap = pickSnapshotRow(balances, billingMonth);
    if (!snap) continue;
    const kind = snap.as_of_kind === "manual" ? "manual" : "statement";
    const totalFacturadoActual =
      kind === "statement" && snap.facturado_clp != null && snap.facturado_clp > 0
        ? snap.facturado_clp
        : null;
    const placeholder = placeholders.get(billingMonth) ?? null;
    const facturadoEditable = totalFacturadoActual == null;
    let totalFacturado: number | null = totalFacturadoActual;
    let facturadoIsPlaceholder = false;
    if (totalFacturado == null && placeholder != null && placeholder > 0) {
      totalFacturado = placeholder;
      facturadoIsPlaceholder = true;
    }
    const cupo = cupoEnCuotasForBillingMonth(accountId, billingMonth, cupoLive);
    const cuotaNext = cuotaAPagarNextMesClp(billingMonth, ledgerMonths, slots);
    const balanceTotal = (totalFacturado ?? 0) + cupo - cuotaNext;
    out.push({
      billing_month: billingMonth,
      as_of_date: snap.as_of_date,
      as_of_kind: kind,
      total_facturado_actual_clp: totalFacturadoActual,
      facturado_placeholder_clp: placeholder,
      total_facturado_clp: totalFacturado,
      facturado_is_placeholder: facturadoIsPlaceholder,
      facturado_editable: facturadoEditable,
      cupo_en_cuotas_clp: cupo,
      cuota_a_pagar_next_mes_clp: cuotaNext,
      balance_total_clp: balanceTotal,
    });
  }

  out.sort((a, b) => b.billing_month.localeCompare(a.billing_month));
  return out;
}

function usdToClpAtPayBy(usd: number, payByIso: string | null): number | null {
  if (!Number.isFinite(usd) || usd <= 0) return null;
  const fxDate = payByIso ?? "";
  const fx = fxMonthEndForBalanceUsd(fxDate);
  if (!fx?.clp_per_usd || fx.clp_per_usd <= 0) return null;
  return Math.round(usd * fx.clp_per_usd);
}

function isoToDdMmYyyy(iso: string): string {
  const [y, mo, d] = iso.split("-");
  return `${d}/${mo}/${y}`;
}

/** Explicit PDF pay_by when present; else statement close + 10th of next month (see ccInstallmentPayBy). */
function resolveFacturacionPayBy(
  slot: { clp: CcStatementRow | null; usd: CcStatementRow | null },
  primary: CcStatementRow
): { pay_by: string | null; pay_by_iso: string | null } {
  for (const st of [slot.clp, slot.usd]) {
    if (!st) continue;
    const explicit = String(st.pay_by ?? "").trim();
    if (explicit) {
      return {
        pay_by: explicit,
        pay_by_iso: parseDdMmYyToIso(explicit),
      };
    }
  }
  const payByIso = resolveInstallmentPayByIso({
    statement_date: primary.statement_date_iso ?? primary.statement_date,
    period_to: primary.period_to ?? undefined,
  });
  if (!payByIso) return { pay_by: null, pay_by_iso: null };
  return { pay_by: isoToDdMmYyyy(payByIso), pay_by_iso: payByIso };
}

function cuotaForPayByMonth(
  payByIso: string | null,
  ledgerMonths: CcInstallmentMonthRow[]
): number | null {
  if (!payByIso) return null;
  const ym = billingMonthForStatementDate(payByIso);
  if (!ym) return null;
  const row = ledgerMonths.find((m) => m.month === ym);
  if (!row || row.total_clp <= 0) return null;
  return row.total_clp;
}

export function buildFacturaciones(
  accountId: number,
  ledgerMonths: CcInstallmentMonthRow[]
): CcFacturacionRow[] {
  const statements = listCcStatementsForAccount(accountId);
  const byMonth = new Map<
    string,
    {
      clp: (typeof statements)[0] | null;
      usd: (typeof statements)[0] | null;
    }
  >();

  for (const st of statements) {
    const bm = st.billing_month;
    if (!bm) continue;
    let slot = byMonth.get(bm);
    if (!slot) {
      slot = { clp: null, usd: null };
      byMonth.set(bm, slot);
    }
    if (st.currency === "usd") {
      slot.usd = st;
    } else {
      slot.clp = st;
    }
  }

  const out: CcFacturacionRow[] = [];
  for (const [billingMonth, slot] of byMonth) {
    const primary = slot.clp ?? slot.usd;
    if (!primary) continue;

    const clpDerived = slot.clp
      ? facturadoFromStatement(accountId, slot.clp.statement_date, slot.clp, slot.clp.statement_date_iso)
      : { facturado_clp: null as number | null, facturado_usd: null as number | null };
    const usdDerived = slot.usd
      ? facturadoFromStatement(accountId, slot.usd.statement_date, slot.usd, slot.usd.statement_date_iso)
      : { facturado_clp: null as number | null, facturado_usd: null as number | null };

    const facturadoClp =
      slot.clp?.monto_facturado != null && slot.clp.monto_facturado > 0
        ? Math.round(slot.clp.monto_facturado)
        : clpDerived.facturado_clp;
    const facturadoUsd =
      slot.usd?.monto_facturado != null && slot.usd.monto_facturado > 0
        ? slot.usd.monto_facturado
        : usdDerived.facturado_usd;

    const { pay_by, pay_by_iso: payByIso } = resolveFacturacionPayBy(slot, primary);
    const facturadoUsdClp =
      facturadoUsd != null
        ? usdToClpAtPayBy(facturadoUsd, payByIso) ?? usdDerived.facturado_clp
        : null;
    const facturadoTotal =
      (facturadoClp ?? 0) + (facturadoUsdClp ?? 0) > 0
        ? (facturadoClp ?? 0) + (facturadoUsdClp ?? 0)
        : null;

    out.push({
      billing_month: billingMonth,
      close_date: primary.statement_date,
      close_date_iso: primary.statement_date_iso,
      pay_by,
      pay_by_iso: payByIso,
      facturado_clp: facturadoClp,
      facturado_usd: facturadoUsd,
      facturado_usd_clp: facturadoUsdClp,
      facturado_total_clp: facturadoTotal,
      cuota_a_pagar_clp: cuotaForPayByMonth(payByIso, ledgerMonths),
    });
  }

  out.sort((a, b) => b.billing_month.localeCompare(a.billing_month));
  return out;
}
