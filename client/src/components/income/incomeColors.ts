import type { IncomeKind, PayrollBreakdownField } from "../../types";

/** One colour per income kind, in stacking order: the income chart's bars and the month rows' bars. */
export const INCOME_KIND_SERIES: readonly { kind: IncomeKind; color: string }[] = [
  { kind: "salary", color: "#22c55e" },
  { kind: "severance", color: "#f59e0b" },
  { kind: "parent_gift", color: "#a78bfa" },
  { kind: "rent", color: "#14b8a6" },
  { kind: "other", color: "#64748b" },
];

export function incomeKindColor(kind: IncomeKind): string {
  const s = INCOME_KIND_SERIES.find((x) => x.kind === kind);
  if (!s) throw new Error(`income kind without a colour: ${kind}`);
  return s.color;
}

/**
 * Gross pay as net pay plus every deduction group, bottom to top (left to right in a row's bar).
 * Chilean groups and US ones (FICA, 401(k), HSA) add up to gross either way.
 */
export const PAYROLL_STACK: readonly { field: PayrollBreakdownField; color: string }[] = [
  { field: "net", color: "#22c55e" },
  { field: "pension", color: "#3b82f6" },
  { field: "retirement_401k", color: "#2563eb" },
  { field: "voluntary_pension", color: "#60a5fa" },
  { field: "hsa", color: "#0ea5e9" },
  { field: "unemployment", color: "#818cf8" },
  // Not amber: amber is severance, which a payslip's net pay can be.
  { field: "pension_commission", color: "#f472b6" },
  { field: "health", color: "#14b8a6" },
  // Not orange: too close to severance's amber.
  { field: "social_security_medicare", color: "#c026d3" },
  { field: "income_tax", color: "#ef4444" },
  { field: "other_deductions", color: "#64748b" },
];

/** The deduction groups of {@link PAYROLL_STACK} (everything but net pay). */
export const PAYROLL_DEDUCTIONS = PAYROLL_STACK.filter((s) => s.field !== "net");
