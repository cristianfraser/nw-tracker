import fs from "node:fs";
import path from "node:path";
import type { CcBillingMonthBalanceRow } from "./ccBillingBalances.js";
import { listCcBillingMonthBalances } from "./ccBillingBalances.js";
import {
  buildBillingDetailByMonth,
  buildFacturaciones,
  type CcBillingDetailMonthRow,
  type CcFacturacionRow,
} from "./ccBillingViews.js";
import type { CreditCardBillingConfig } from "./ccBillingMonth.js";
import { loadCreditCardBillingConfig } from "./ccBillingMonth.js";
import {
  ccStatementRowCount,
  ccStatementsPayloadForAccount,
  type CcStatementRow,
  type CcStatementLineRow,
} from "./ccStatementsDb.js";
import { ccInstallmentLedgerRowCount, ccInstallmentsDbApiPayload } from "./ccInstallmentLedgerDb.js";
import { addCalendarMonths, parseYearMonth } from "./ccYearMonth.js";
import { numCsv, readSemicolonCsv } from "./deptoDividendosLedger.js";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";

export { parseYearMonth, addCalendarMonths } from "./ccYearMonth.js";

export const CREDIT_CARD_INSTALLMENTS_CSV = "credit-card-installments.csv";

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
  /** `pdf` from statement import; `manual` from UI/API. Omitted on CSV fallback. */
  purchase_source?: "pdf" | "manual";
};

export type CcInstallmentMonthBreakdown = {
  purchase_id: string;
  label: string;
  installment_index: number;
  amount_clp: number;
};

export type CcInstallmentMonthRow = {
  month: string;
  total_clp: number;
  breakdown: CcInstallmentMonthBreakdown[];
};

export type CcInstallmentsTotals = {
  total_remaining_principal_clp: number;
  /** Sum of all cuotas due in the earliest month that still has a payment (any purchase). */
  next_calendar_month_total_clp: number | null;
  next_calendar_month: string | null;
};

export type CcInstallmentsMeta = {
  csv_path: string;
  csv_absolute_path: string;
  csv_file_exists: boolean;
  /** Populated when `source === "db"` (ledger from PDF import). */
  db_purchase_count?: number;
  db_payment_count?: number;
  pay_by_rule?: string;
  remaining_balance_line_rule?: string;
};

function normHeader(s: string): string {
  return String(s ?? "")
    .trim()
    .replace(/^\ufeff/, "")
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function ymCompare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Nominal APR, monthly compounding: fixed payment for fully amortizing loan. */
function amortizedCuotaClp(principal: number, annualPct: number, n: number): number {
  if (n <= 0 || principal <= 0) return 0;
  const r = annualPct / 100 / 12;
  if (r <= 0) return principal / n;
  const factor = 1 - Math.pow(1 + r, -n);
  if (factor <= 0) return principal / n;
  return (principal * r) / factor;
}

/** Balance after `paid` full payments (same fixed cuota each month). */
function balanceAfterPayments(
  principal: number,
  annualPct: number,
  n: number,
  paid: number,
  cuota: number
): number {
  let bal = principal;
  const r = annualPct / 100 / 12;
  const steps = Math.min(Math.max(0, paid), n);
  for (let i = 0; i < steps; i++) {
    if (bal <= 0) break;
    const interest = r > 0 ? bal * r : 0;
    const princPart = cuota - interest;
    bal = Math.max(0, bal - princPart);
  }
  return bal;
}

function parseIntCell(v: unknown, fallback: number): number {
  const n = numCsv(v);
  if (n == null || !Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

export function parseExtraOffsetsJson(raw: unknown): Record<string, number> {
  if (raw == null || raw === "") return {};
  try {
    const o = JSON.parse(String(raw)) as Record<string, unknown>;
    if (!o || typeof o !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(o)) {
      const key = String(k).trim();
      if (!key) continue;
      const n = typeof v === "number" ? v : Number(String(v));
      if (!Number.isFinite(n) || n === 0) continue;
      out[key] = Math.trunc(n);
    }
    return out;
  } catch {
    return {};
  }
}

export function resolveCreditCardInstallmentsCsvPath(): string {
  return path.join(resolveCfraserCsvDir(), CREDIT_CARD_INSTALLMENTS_CSV);
}

export function loadCreditCardInstallmentPurchases(csvDir?: string): CcInstallmentPurchaseRow[] {
  const dir = csvDir ?? resolveCfraserCsvDir();
  const fp = path.join(dir, CREDIT_CARD_INSTALLMENTS_CSV);
  const rows = readSemicolonCsv(fp);
  if (rows.length < 2) return [];
  const header = rows[0]!.map((c) => normHeader(String(c ?? "")));
  const idx = (name: string) => header.indexOf(name);

  const iId = idx("purchase_id");
  const iLabel = idx("label");
  const iPrincipal = idx("principal_clp");
  const iN = idx("installment_count");
  const iPaid = idx("installments_paid");
  const iCuota = idx("cuota_clp");
  const iRate = idx("annual_interest_pct");
  const iFirst = idx("first_due_month");
  const iOff = idx("schedule_offset_months");
  const iPurchaseMonth = idx("purchase_month");
  const iNote = idx("note");

  if (iId < 0 || iLabel < 0 || iPrincipal < 0 || iN < 0 || iPaid < 0 || iCuota < 0 || iFirst < 0) {
    return [];
  }

  const out: CcInstallmentPurchaseRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row.some((c) => String(c ?? "").trim())) continue;
    const line0 = String(row[0] ?? "").trim();
    if (line0.startsWith("#")) continue;

    const purchase_id = String(row[iId] ?? "").trim();
    const label = String(row[iLabel] ?? "").trim();
    if (!purchase_id || !label) continue;

    const principal_clp = numCsv(row[iPrincipal]);
    const installment_count = parseIntCell(row[iN], 0);
    const installments_paid = parseIntCell(row[iPaid], 0);
    const cuotaRaw = numCsv(row[iCuota]);
    const annual_interest_pct = iRate >= 0 ? numCsv(row[iRate]) ?? 0 : 0;
    const firstRaw = String(row[iFirst] ?? "").trim();
    const first_due_month = parseYearMonth(firstRaw) ?? "";

    if (
      principal_clp == null ||
      principal_clp <= 0 ||
      installment_count <= 0 ||
      installments_paid < 0 ||
      installments_paid > installment_count ||
      !first_due_month
    ) {
      continue;
    }

    let cuota_clp = cuotaRaw != null && cuotaRaw > 0 ? cuotaRaw : 0;
    if (cuota_clp <= 0) {
      cuota_clp = amortizedCuotaClp(principal_clp, annual_interest_pct, installment_count);
    }

    const schedule_offset_months = iOff >= 0 ? parseIntCell(row[iOff], 0) : 0;
    const purchase_month =
      iPurchaseMonth >= 0 ? parseYearMonth(String(row[iPurchaseMonth] ?? "").trim()) : null;
    const note = iNote >= 0 && String(row[iNote] ?? "").trim() ? String(row[iNote]).trim() : null;

    out.push({
      purchase_id,
      label,
      principal_clp,
      installment_count,
      installments_paid,
      cuota_clp,
      annual_interest_pct: Math.max(0, annual_interest_pct),
      first_due_month,
      schedule_offset_months,
      purchase_month,
      note,
    });
  }
  return out;
}

function computePurchase(
  p: CcInstallmentPurchaseRow,
  extraOffsetMonths: number
): CcInstallmentPurchaseComputed {
  const paid = Math.min(Math.max(0, p.installments_paid), p.installment_count);
  const remaining_installments = Math.max(0, p.installment_count - paid);
  const off = p.schedule_offset_months + extraOffsetMonths;

  let remaining_principal_clp = 0;
  if (p.annual_interest_pct <= 0) {
    remaining_principal_clp = remaining_installments * p.cuota_clp;
  } else {
    remaining_principal_clp = balanceAfterPayments(
      p.principal_clp,
      p.annual_interest_pct,
      p.installment_count,
      paid,
      p.cuota_clp
    );
  }

  let next_due_month: string | null = null;
  let next_installment_index: number | null = null;
  if (remaining_installments > 0 && paid < p.installment_count) {
    next_installment_index = paid;
    next_due_month = addCalendarMonths(p.first_due_month, paid + off);
  }

  const last_paid_month =
    paid >= 1 ? addCalendarMonths(p.first_due_month, paid - 1 + off) : null;

  return {
    ...p,
    remaining_installments,
    remaining_principal_clp,
    next_due_month,
    next_installment_index,
    last_paid_month,
    upcoming_cuota_clp: p.cuota_clp,
  };
}

export function buildCreditCardInstallmentSchedule(
  purchases: CcInstallmentPurchaseRow[],
  extraOffsetsByPurchaseId: Record<string, number>
): {
  purchases: CcInstallmentPurchaseComputed[];
  months: CcInstallmentMonthRow[];
  totals: CcInstallmentsTotals;
} {
  const computed = purchases.map((p) =>
    computePurchase(p, extraOffsetsByPurchaseId[p.purchase_id] ?? 0)
  );

  const byMonth = new Map<string, CcInstallmentMonthBreakdown[]>();

  for (const p of computed) {
    const paid = Math.min(Math.max(0, p.installments_paid), p.installment_count);
    const off = p.schedule_offset_months + (extraOffsetsByPurchaseId[p.purchase_id] ?? 0);
    for (let i = paid; i < p.installment_count; i++) {
      const month = addCalendarMonths(p.first_due_month, i + off);
      const amt = p.upcoming_cuota_clp;
      const list = byMonth.get(month) ?? [];
      list.push({
        purchase_id: p.purchase_id,
        label: p.label,
        installment_index: i,
        amount_clp: amt,
      });
      byMonth.set(month, list);
    }
  }

  const months = [...byMonth.keys()].sort(ymCompare).map((month) => {
    const breakdown = byMonth.get(month) ?? [];
    const total_clp = breakdown.reduce((s, b) => s + b.amount_clp, 0);
    return { month, total_clp, breakdown };
  });

  let total_remaining_principal_clp = 0;
  for (const p of computed) {
    total_remaining_principal_clp += p.remaining_principal_clp;
  }

  let next_calendar_month: string | null = null;
  let next_calendar_month_total_clp: number | null = null;
  for (const m of months) {
    if (m.total_clp > 0) {
      next_calendar_month = m.month;
      next_calendar_month_total_clp = m.total_clp;
      break;
    }
  }

  return {
    purchases: computed,
    months,
    totals: {
      total_remaining_principal_clp,
      next_calendar_month_total_clp,
      next_calendar_month,
    },
  };
}

export function creditCardInstallmentsResponse(
  accountId: number,
  extraOffsets: Record<string, number>
): {
  account_id: number;
  source: "csv" | "db" | "none";
  meta: CcInstallmentsMeta | null;
  purchases: CcInstallmentPurchaseComputed[];
  purchases_completed: CcInstallmentPurchaseComputed[];
  months: CcInstallmentMonthRow[];
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
} {
  if (ccInstallmentLedgerRowCount(accountId) > 0) {
    const db = ccInstallmentsDbApiPayload(accountId);
    return {
      account_id: accountId,
      source: "db",
      meta: {
        csv_path: "SQLite · cc_installment_purchases / cc_installment_payments",
        csv_absolute_path: "",
        csv_file_exists: true,
        db_purchase_count: db.meta.db_purchase_count,
        db_payment_count: db.meta.db_payment_count,
        pay_by_rule: db.meta.pay_by_rule,
        remaining_balance_line_rule: db.meta.remaining_balance_line_rule,
      },
      purchases: db.purchases,
      purchases_completed: db.purchases_completed,
      months: db.months,
      totals: db.totals,
      installment_history_months: db.installment_history_months,
      statements: ccStatementsPayloadForAccount(accountId).statements,
      billing_month_balances: listCcBillingMonthBalances(accountId),
      billing_detail_by_month: buildBillingDetailByMonth(accountId, db.months),
      facturaciones: buildFacturaciones(accountId, db.months),
      billing_config: loadCreditCardBillingConfig(accountId),
    };
  }

  if (ccStatementRowCount(accountId) > 0) {
    const billing = listCcBillingMonthBalances(accountId);
    const latestCupo =
      billing.length > 0
        ? [...billing].sort((a, b) => b.as_of_date.localeCompare(a.as_of_date))[0]!.cupo_utilizado_clp
        : 0;
    return {
      account_id: accountId,
      source: "db",
      meta: {
        csv_path: "SQLite · cc_statements / cc_statement_lines",
        csv_absolute_path: "",
        csv_file_exists: true,
        pay_by_rule:
          "Estados de cuenta importados (PDF). Sin compras en cuotas en el ledger hasta importar estados CLP.",
      },
      purchases: [],
      purchases_completed: [],
      months: [],
      totals: {
        total_remaining_principal_clp: latestCupo,
        next_calendar_month_total_clp: null,
        next_calendar_month: null,
      },
      statements: ccStatementsPayloadForAccount(accountId).statements,
      billing_month_balances: billing,
      billing_detail_by_month: buildBillingDetailByMonth(accountId, []),
      facturaciones: buildFacturaciones(accountId, []),
      billing_config: loadCreditCardBillingConfig(accountId),
    };
  }

  const csv_absolute_path = resolveCreditCardInstallmentsCsvPath();
  const csv_file_exists = fs.existsSync(csv_absolute_path);
  const csv_path = `cfraser/${CREDIT_CARD_INSTALLMENTS_CSV}`;
  const raw = loadCreditCardInstallmentPurchases();
  const meta: CcInstallmentsMeta = { csv_path, csv_absolute_path, csv_file_exists };
  if (raw.length === 0) {
    return {
      account_id: accountId,
      source: csv_file_exists ? ("csv" as const) : ("none" as const),
      meta,
      purchases: [],
      purchases_completed: [],
      months: [],
      totals: {
        total_remaining_principal_clp: 0,
        next_calendar_month_total_clp: null,
        next_calendar_month: null,
      },
    };
  }
  const { purchases: allPurchases, months, totals } = buildCreditCardInstallmentSchedule(raw, extraOffsets);
  const purchases = allPurchases.filter((p) => p.remaining_principal_clp > 0 || p.remaining_installments > 0);
  const purchases_completed = allPurchases
    .filter((p) => p.remaining_principal_clp <= 0 && p.remaining_installments <= 0)
    .sort((a, b) => {
      const cmp = ymCompare(b.purchase_month ?? "1970-01", a.purchase_month ?? "1970-01");
      if (cmp !== 0) return cmp;
      return a.label.localeCompare(b.label);
    });
  return {
    account_id: accountId,
    source: "csv",
    meta: { csv_path, csv_absolute_path, csv_file_exists },
    purchases,
    purchases_completed,
    months,
    totals,
  };
}
