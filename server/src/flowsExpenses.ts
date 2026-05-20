import { monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import { db } from "./db.js";

export const EXPENSE_FLOW_GROUPS = ["real_estate"] as const;
export type ExpenseFlowGroupSlug = (typeof EXPENSE_FLOW_GROUPS)[number];

const GROUP_LABEL: Record<ExpenseFlowGroupSlug, string> = {
  real_estate: "Real estate",
};

export type FlowExpenseRow = {
  spent_on: string;
  group_slug: ExpenseFlowGroupSlug;
  group_label: string;
  account_id: number;
  account_slug: string;
  account_name: string;
  amount_clp: number;
  category: string | null;
  note: string | null;
};

export type FlowExpenseChartPoint = {
  as_of_date: string;
  real_estate: number;
  lastarria: number;
  suecia: number;
  el_vergel: number;
  total: number;
};

export type FlowExpenseAccountBlock = {
  account_id: number;
  account_slug: string;
  label: string;
  rows: FlowExpenseRow[];
  total_clp: number;
};

export type FlowExpenseGroupBlock = {
  label: string;
  total_clp: number;
  by_account: Record<string, FlowExpenseAccountBlock>;
};

export type FlowsExpensesPayload = {
  rows: FlowExpenseRow[];
  chart_monthly: FlowExpenseChartPoint[];
  chart_yearly: FlowExpenseChartPoint[];
  total_clp: number;
  by_group: Record<ExpenseFlowGroupSlug, FlowExpenseGroupBlock>;
};

type AccountRow = {
  account_id: number;
  account_slug: string;
  account_name: string;
  group_slug: ExpenseFlowGroupSlug;
};

function listExpenseFlowAccounts(): AccountRow[] {
  return db
    .prepare(
      `SELECT a.id AS account_id, a.slug AS account_slug, a.label AS account_name, g.slug AS group_slug
       FROM expense_accounts a
       JOIN expense_groups g ON g.id = a.group_id
       WHERE g.slug IN (${EXPENSE_FLOW_GROUPS.map(() => "?").join(",")})
       ORDER BY g.sort_order, a.sort_order, a.label`
    )
    .all(...EXPENSE_FLOW_GROUPS) as AccountRow[];
}

function periodEndFromSpentOn(spentOn: string, granularity: "month" | "year"): string {
  if (granularity === "year") return `${spentOn.slice(0, 4)}-12-31`;
  const mk = monthKeyFromYmd(spentOn);
  return mk ? monthEndUtcYmd(mk) : spentOn;
}

function aggregateExpenseChartPoints(
  rows: readonly FlowExpenseRow[],
  granularity: "month" | "year"
): FlowExpenseChartPoint[] {
  const byPeriod = new Map<string, FlowExpenseChartPoint>();
  for (const r of rows) {
    if (r.amount_clp <= 0) continue;
    const pe = periodEndFromSpentOn(r.spent_on, granularity);
    let pt = byPeriod.get(pe);
    if (!pt) {
      pt = {
        as_of_date: pe,
        real_estate: 0,
        lastarria: 0,
        suecia: 0,
        el_vergel: 0,
        total: 0,
      };
      byPeriod.set(pe, pt);
    }
    if (r.account_slug === "lastarria") pt.lastarria += r.amount_clp;
    else if (r.account_slug === "suecia") pt.suecia += r.amount_clp;
    else if (r.account_slug === "el_vergel") pt.el_vergel += r.amount_clp;
    pt.real_estate += r.amount_clp;
    pt.total += r.amount_clp;
  }
  return [...byPeriod.values()].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
}

export function buildFlowsExpensesPayload(): FlowsExpensesPayload {
  const accounts = listExpenseFlowAccounts();
  const accountById = new Map(accounts.map((a) => [a.account_id, a]));

  const dbRows = db
    .prepare(
      `SELECT e.id, e.amount_clp, e.spent_on, e.category, e.note, e.expense_account_id
       FROM expense_entries e
       WHERE e.expense_account_id IS NOT NULL
       ORDER BY e.spent_on DESC, e.id DESC`
    )
    .all() as {
    id: number;
    amount_clp: number;
    spent_on: string;
    category: string | null;
    note: string | null;
    expense_account_id: number;
  }[];

  const rows: FlowExpenseRow[] = [];
  for (const e of dbRows) {
    const acc = accountById.get(e.expense_account_id);
    if (!acc) continue;
    rows.push({
      spent_on: e.spent_on,
      group_slug: acc.group_slug,
      group_label: GROUP_LABEL[acc.group_slug],
      account_id: acc.account_id,
      account_slug: acc.account_slug,
      account_name: acc.account_name,
      amount_clp: Math.round(e.amount_clp),
      category: e.category,
      note: e.note,
    });
  }

  const chart_monthly = aggregateExpenseChartPoints(rows, "month");
  const chart_yearly = aggregateExpenseChartPoints(rows, "year");

  const by_group = {} as Record<ExpenseFlowGroupSlug, FlowExpenseGroupBlock>;
  for (const g of EXPENSE_FLOW_GROUPS) {
    const groupAccounts = accounts.filter((a) => a.group_slug === g);
    const by_account: Record<string, FlowExpenseAccountBlock> = {};
    for (const acc of groupAccounts) {
      const accRows = rows.filter((r) => r.account_id === acc.account_id);
      by_account[acc.account_slug] = {
        account_id: acc.account_id,
        account_slug: acc.account_slug,
        label: acc.account_name,
        rows: accRows,
        total_clp: accRows.filter((r) => r.amount_clp > 0).reduce((s, r) => s + r.amount_clp, 0),
      };
    }
    const groupRows = rows.filter((r) => r.group_slug === g);
    by_group[g] = {
      label: GROUP_LABEL[g],
      total_clp: groupRows.filter((r) => r.amount_clp > 0).reduce((s, r) => s + r.amount_clp, 0),
      by_account,
    };
  }

  return {
    rows,
    chart_monthly,
    chart_yearly,
    total_clp: rows.filter((r) => r.amount_clp > 0).reduce((s, r) => s + r.amount_clp, 0),
    by_group,
  };
}

export function expenseAccountIdByGroupSlug(
  groupSlug: ExpenseFlowGroupSlug,
  accountSlug: string
): number | null {
  const row = db
    .prepare(
      `SELECT a.id FROM expense_accounts a
       JOIN expense_groups g ON g.id = a.group_id
       WHERE g.slug = ? AND a.slug = ?`
    )
    .get(groupSlug, accountSlug) as { id: number } | undefined;
  return row?.id ?? null;
}
