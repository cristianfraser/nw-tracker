/**
 * Additional-card spending vs the reimbursements paying it back («Tarjetas adicionales»).
 *
 * An additional cardholder's charges on the user's card (origin in the registry's
 * `additional_card_last4s`) are auto-tagged `additional_card`. The cardholder pays them back by wires
 * into checking, which are refunds in that category (`checkingExpenseRefunds.ts`): negative gastos
 * lines, so the category itself nets to what he still owes. This section shows the two sides per
 * month / year: charges, reimbursements, net and the running balance owed.
 *
 * `matchCardReimbursements` is the matcher behind the report-first proposal script
 * (`server/scripts/propose-card-reimbursements.ts`); nothing on a request path reads it.
 */
import { isAdditionalCardExpenseLine } from "./ccAdditionalCardExpenseMatch.js";
import { ADDITIONAL_CARD_CC_EXPENSE_SLUG } from "./ccExpenseCategories.js";

/** The fields of a gastos line (`FlowCcExpenseLineRow`) the summary reads. */
export type AdditionalCardChargeLineInput = {
  source: "cc" | "checking" | "manual" | "payslip";
  origin_card_last4: string | null;
  primary_card_last4: string | null;
  category_slug: string;
  line_role: "purchase" | "installment_cuota" | "installment_purchase_total";
  gastos_scope?: "both" | "total_only" | "split_only" | "excluded";
  expense_month: string;
  amount_clp: number;
  amount_usd_at_expense: number | null;
};

export type AdditionalCardsPeriodRow = {
  /** YYYY-MM (a year row: YYYY-12). */
  period_month: string;
  as_of_date: string;
  /** Signed: charges +, notas de crédito −. */
  charges_clp: number;
  /** Null when a line of the period has no USD equivalent. */
  charges_usd: number | null;
  charge_count: number;
  reimbursements_clp: number;
  reimbursements_usd: number | null;
  reimbursement_count: number;
  /** charges − reimbursements. */
  net_clp: number;
  net_usd: number | null;
  /** Running Σ net through the period: what the cardholder still owes (negative = paid ahead). */
  balance_clp: number;
  balance_usd: number | null;
};

export type AdditionalCardsSummary = {
  /** Oldest first. */
  by_month: AdditionalCardsPeriodRow[];
  by_year: AdditionalCardsPeriodRow[];
  totals: {
    charges_clp: number;
    charges_usd: number | null;
    reimbursements_clp: number;
    reimbursements_usd: number | null;
    balance_clp: number;
    balance_usd: number | null;
  };
};

/**
 * A charge the additional cardholder owes: an additional-card CC line the user left in
 * `additional_card`, counted the way it bills (one-shots and cuotas; never an installment purchase
 * total, which only the «Total» gastos mode shows). A line the user recategorized is his own spend.
 */
export function isAdditionalCardChargeLine(line: AdditionalCardChargeLineInput): boolean {
  if (line.source !== "cc") return false;
  if (!isAdditionalCardExpenseLine(line.origin_card_last4, line.primary_card_last4)) return false;
  if (line.category_slug !== ADDITIONAL_CARD_CC_EXPENSE_SLUG) return false;
  if (line.line_role === "installment_purchase_total") return false;
  if (line.gastos_scope === "excluded" || line.gastos_scope === "total_only") return false;
  return true;
}

/** A reimbursement: a checking refund line (negative) in `additional_card`. */
export function isAdditionalCardReimbursementLine(line: AdditionalCardChargeLineInput): boolean {
  return line.source === "checking" && line.category_slug === ADDITIONAL_CARD_CC_EXPENSE_SLUG && line.amount_clp < 0;
}

type Bucket = {
  charges_clp: number;
  charges_usd: number | null;
  charge_count: number;
  reimbursements_clp: number;
  reimbursements_usd: number | null;
  reimbursement_count: number;
};

function emptyBucket(): Bucket {
  return {
    charges_clp: 0,
    charges_usd: 0,
    charge_count: 0,
    reimbursements_clp: 0,
    reimbursements_usd: 0,
    reimbursement_count: 0,
  };
}

function addUsd(total: number | null, usd: number | null): number | null {
  return total == null || usd == null ? null : total + usd;
}

function monthEndIso(ym: string): string {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const day = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(day).padStart(2, "0")}`;
}

function periodRows(
  buckets: Map<string, Bucket>,
  asOfDate: (period: string) => string
): AdditionalCardsPeriodRow[] {
  let balanceClp = 0;
  let balanceUsd: number | null = 0;
  return [...buckets.keys()].sort().map((period) => {
    const b = buckets.get(period)!;
    const net_clp = b.charges_clp - b.reimbursements_clp;
    const net_usd =
      b.charges_usd == null || b.reimbursements_usd == null
        ? null
        : b.charges_usd - b.reimbursements_usd;
    balanceClp += net_clp;
    balanceUsd = addUsd(balanceUsd, net_usd);
    return {
      period_month: period,
      as_of_date: asOfDate(period),
      charges_clp: b.charges_clp,
      charges_usd: b.charges_usd,
      charge_count: b.charge_count,
      reimbursements_clp: b.reimbursements_clp,
      reimbursements_usd: b.reimbursements_usd,
      reimbursement_count: b.reimbursement_count,
      net_clp,
      net_usd,
      balance_clp: balanceClp,
      balance_usd: balanceUsd,
    };
  });
}

/** Charges and reimbursements, each by its gastos month (a reimbursement's is the day it arrived). */
export function buildAdditionalCardsSummary(lines: readonly AdditionalCardChargeLineInput[]): AdditionalCardsSummary {
  const byMonth = new Map<string, Bucket>();
  const touch = (ym: string): Bucket => {
    if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error(`invalid additional-card period month: ${ym}`);
    let b = byMonth.get(ym);
    if (!b) {
      b = emptyBucket();
      byMonth.set(ym, b);
    }
    return b;
  };
  for (const line of lines) {
    if (isAdditionalCardChargeLine(line)) {
      const b = touch(line.expense_month);
      b.charges_clp += line.amount_clp;
      b.charges_usd = addUsd(b.charges_usd, line.amount_usd_at_expense);
      b.charge_count += 1;
    } else if (isAdditionalCardReimbursementLine(line)) {
      const b = touch(line.expense_month);
      b.reimbursements_clp -= line.amount_clp;
      b.reimbursements_usd = addUsd(b.reimbursements_usd, line.amount_usd_at_expense == null ? null : -line.amount_usd_at_expense);
      b.reimbursement_count += 1;
    }
  }

  const byYear = new Map<string, Bucket>();
  for (const [ym, b] of byMonth) {
    const year = `${ym.slice(0, 4)}-12`;
    const y = byYear.get(year) ?? emptyBucket();
    y.charges_clp += b.charges_clp;
    y.charges_usd = addUsd(y.charges_usd, b.charges_usd);
    y.charge_count += b.charge_count;
    y.reimbursements_clp += b.reimbursements_clp;
    y.reimbursements_usd = addUsd(y.reimbursements_usd, b.reimbursements_usd);
    y.reimbursement_count += b.reimbursement_count;
    byYear.set(year, y);
  }

  const by_month = periodRows(byMonth, monthEndIso);
  const by_year = periodRows(byYear, (p) => `${p.slice(0, 4)}-12-31`);
  let charges_clp = 0;
  let charges_usd: number | null = 0;
  let reimbursements_clp = 0;
  let reimbursements_usd: number | null = 0;
  for (const row of by_year) {
    charges_clp += row.charges_clp;
    charges_usd = addUsd(charges_usd, row.charges_usd);
    reimbursements_clp += row.reimbursements_clp;
    reimbursements_usd = addUsd(reimbursements_usd, row.reimbursements_usd);
  }
  return {
    by_month,
    by_year,
    totals: {
      charges_clp,
      charges_usd,
      reimbursements_clp,
      reimbursements_usd,
      balance_clp: charges_clp - reimbursements_clp,
      balance_usd:
        charges_usd == null || reimbursements_usd == null ? null : charges_usd - reimbursements_usd,
    },
  };
}

// --- Proposal matcher (script only) ---------------------------------------------------------

export type ReimbursementChargeInput = {
  id: number;
  /** ISO purchase date. */
  date: string;
  amount_clp: number;
  merchant: string | null;
};

export type ReimbursementCreditInput = {
  movement_id: number;
  /** ISO date the wire arrived. */
  date: string;
  amount_clp: number;
};

export type ReimbursementMatchKind =
  /** The oldest unpaid charges up to the credit's date add up to it exactly. */
  | "exact_fifo"
  /** A set of unpaid charges from the preceding window adds up to it exactly. */
  | "exact_window"
  /** No exact set: applied to the oldest unpaid charges (partially if need be). */
  | "unmatched";

export type ReimbursementMatch = {
  credit: ReimbursementCreditInput;
  kind: ReimbursementMatchKind;
  /** Charges the credit paid in full (exact kinds) or touched (unmatched, FIFO). */
  charge_ids: number[];
  /** Unpaid charges dated on/before the credit, before applying it. */
  outstanding_before_clp: number;
  /** Unmatched: the credit minus the nearest FIFO prefix sum (positive = paid more). */
  closest_fifo_delta_clp: number | null;
};

export type ReimbursementMatchResult = {
  matches: ReimbursementMatch[];
  /** Charges still (partly) unpaid after every credit: id → remaining CLP. */
  unpaid: Map<number, number>;
};

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Indices (into `amounts`) of a subset summing exactly to `target`, or null. */
function exactSubset(amounts: readonly number[], target: number): number[] | null {
  if (target <= 0) return null;
  const reached = new Map<number, { prev: number; idx: number }>();
  reached.set(0, { prev: -1, idx: -1 });
  for (let i = 0; i < amounts.length; i++) {
    const a = amounts[i]!;
    if (a <= 0) continue;
    for (const sum of [...reached.keys()]) {
      const next = sum + a;
      if (next > target || reached.has(next)) continue;
      reached.set(next, { prev: sum, idx: i });
      if (next === target) {
        const out: number[] = [];
        let cur = next;
        while (cur !== 0) {
          const step = reached.get(cur)!;
          out.push(step.idx);
          cur = step.prev;
        }
        return out.reverse();
      }
    }
  }
  return null;
}

/**
 * Pairs each reimbursement with the additional-card charges it paid, oldest first. Exact matches
 * are tried FIFO first (the oldest unpaid charges), then as any set of fully-unpaid charges from
 * the `windowDays` before the credit (the most recent `maxWindowCharges` of them); a credit with
 * no exact set pays the oldest charges FIFO, partially if need be, so the running balance stays
 * right either way.
 */
export function matchCardReimbursements(
  charges: readonly ReimbursementChargeInput[],
  credits: readonly ReimbursementCreditInput[],
  opts: { windowDays: number; maxWindowCharges: number }
): ReimbursementMatchResult {
  const sortedCharges = [...charges].sort(
    (a, b) => a.date.localeCompare(b.date) || a.id - b.id
  );
  const sortedCredits = [...credits].sort(
    (a, b) => a.date.localeCompare(b.date) || a.movement_id - b.movement_id
  );
  const remaining = new Map<number, number>(sortedCharges.map((c) => [c.id, c.amount_clp]));
  const matches: ReimbursementMatch[] = [];

  for (const credit of sortedCredits) {
    if (!(credit.amount_clp > 0)) {
      throw new Error(`reimbursement ${credit.movement_id} must be a positive credit`);
    }
    const open = sortedCharges.filter(
      (c) => c.date <= credit.date && (remaining.get(c.id) ?? 0) > 0
    );
    const outstanding = open.reduce((s, c) => s + remaining.get(c.id)!, 0);

    let fifo: number[] | null = null;
    let running = 0;
    let closestDelta: number = credit.amount_clp;
    for (let i = 0; i < open.length; i++) {
      running += remaining.get(open[i]!.id)!;
      const delta = credit.amount_clp - running;
      if (Math.abs(delta) < Math.abs(closestDelta)) closestDelta = delta;
      if (running === credit.amount_clp) {
        fifo = open.slice(0, i + 1).map((c) => c.id);
        break;
      }
      if (running > credit.amount_clp) break;
    }
    if (fifo) {
      for (const id of fifo) remaining.set(id, 0);
      matches.push({
        credit,
        kind: "exact_fifo",
        charge_ids: fifo,
        outstanding_before_clp: outstanding,
        closest_fifo_delta_clp: null,
      });
      continue;
    }

    const windowStart = addDaysIso(credit.date, -opts.windowDays);
    const windowCharges = open
      .filter((c) => c.date >= windowStart && remaining.get(c.id) === c.amount_clp)
      .slice(-opts.maxWindowCharges);
    const subset = exactSubset(
      windowCharges.map((c) => c.amount_clp),
      credit.amount_clp
    );
    if (subset) {
      const ids = subset.map((i) => windowCharges[i]!.id);
      for (const id of ids) remaining.set(id, 0);
      matches.push({
        credit,
        kind: "exact_window",
        charge_ids: ids,
        outstanding_before_clp: outstanding,
        closest_fifo_delta_clp: null,
      });
      continue;
    }

    let left = credit.amount_clp;
    const touched: number[] = [];
    for (const c of open) {
      if (left <= 0) break;
      const r = remaining.get(c.id)!;
      const pay = Math.min(r, left);
      remaining.set(c.id, r - pay);
      left -= pay;
      touched.push(c.id);
    }
    matches.push({
      credit,
      kind: "unmatched",
      charge_ids: touched,
      outstanding_before_clp: outstanding,
      closest_fifo_delta_clp: closestDelta,
    });
  }

  const unpaid = new Map<number, number>();
  for (const [id, r] of remaining) if (r !== 0) unpaid.set(id, r);
  return { matches, unpaid };
}
