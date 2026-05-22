import { describe, expect, it } from "vitest";
import {
  countsTowardCcExpenseGastosMes,
  listCreditCardGroupOperationalAccountIds,
} from "./ccExpenseCategories.js";
import { effectiveCcExpenseLineAmountClp } from "./ccExpenseAmountClp.js";
import { db } from "./db.js";
import { buildFlowsCreditCardExpensesPayload } from "./flowsCreditCardExpenses.js";
import { listCreditCardGroupOperationalAccountIds } from "./ccExpenseCategories.js";

describe("effectiveCcExpenseLineAmountClp", () => {
  it("uses valor_cuota_mensual_clp for installment lines", () => {
    expect(
      effectiveCcExpenseLineAmountClp(
        {
          installment_flag: 1,
          amount_clp: 881_134,
          amount_usd: null,
          valor_cuota_mensual_clp: 73_428,
          valor_cuota_mensual_usd: null,
        },
        "2025-04-22"
      )
    ).toBe(73_428);
  });

  it("uses amount_clp for revolving lines", () => {
    expect(
      effectiveCcExpenseLineAmountClp(
        {
          installment_flag: 0,
          amount_clp: -394_140,
          amount_usd: null,
          valor_cuota_mensual_clp: null,
          valor_cuota_mensual_usd: null,
        },
        "2025-04-22"
      )
    ).toBe(-394_140);
  });
});

describe("flowsCreditCardExpenses", () => {
  it("lists operational accounts for the credit card liability group", () => {
    const ids = listCreditCardGroupOperationalAccountIds();
    expect(ids.length).toBeGreaterThanOrEqual(0);
    for (const id of ids) {
      expect(Number.isInteger(id)).toBe(true);
    }
  });

  it("builds monthly rows with cumulative gastos when statement lines exist", () => {
    const payload = buildFlowsCreditCardExpensesPayload();
    expect(payload.group_slug).toBe("santander");
    if (payload.by_month.length === 0) return;

    const asc = [...payload.by_month].reverse();
    let expected = 0;
    for (const row of asc) {
      expect(row.gastos_mes_clp).toBeGreaterThanOrEqual(0);
      expected += row.gastos_mes_clp;
      expect(row.gastos_acumulado_clp).toBe(expected);
      expect(row.period_month).toMatch(/^\d{4}-\d{2}$/);
      expect(row.as_of_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(payload.chart_monthly.length).toBe(asc.length);
  });

  it("groups installment lines by statement billing month, not purchase date", () => {
    const payload = buildFlowsCreditCardExpensesPayload();
    const feb2025 = payload.by_month.find((m) => m.period_month === "2025-02");
    if (!feb2025) return;

    const febInstallmentFromAprStmt = payload.lines.filter(
      (ln) =>
        ln.billing_month === "2025-04" &&
        ln.installment_flag === 1 &&
        ln.purchase_on != null &&
        ln.purchase_on.startsWith("2025-02")
    );
    if (febInstallmentFromAprStmt.length === 0) return;

    const wronglyInFeb = payload.lines.filter(
      (ln) =>
        ln.billing_month === "2025-02" &&
        ln.installment_flag === 1 &&
        ln.purchase_on != null &&
        ln.purchase_on.startsWith("2025-02") &&
        febInstallmentFromAprStmt.some(
          (a) =>
            a.merchant === ln.merchant &&
            a.nro_cuota_current === ln.nro_cuota_current &&
            a.nro_cuota_total === ln.nro_cuota_total
        )
    );
    expect(wronglyInFeb.length).toBe(0);
  });

  it("gastos_mes_clp excludes negative lines, no_cuenta, and cuota 0 in the same billing month", () => {
    const payload = buildFlowsCreditCardExpensesPayload();
    for (const row of payload.by_month) {
      const monthLines = payload.lines.filter((ln) => ln.billing_month === row.period_month);
      const sumPositive = monthLines
        .filter((ln) => ln.amount_clp > 0)
        .reduce((s, ln) => s + ln.amount_clp, 0);
      const sumCounted = monthLines
        .filter(
          (ln) =>
            ln.amount_clp > 0 &&
            countsTowardCcExpenseGastosMes(ln.category_slug, {
              installment_flag: ln.installment_flag,
              nro_cuota_current: ln.nro_cuota_current,
            })
        )
        .reduce((s, ln) => s + ln.amount_clp, 0);
      expect(row.gastos_real_mes_clp).toBe(sumPositive);
      expect(row.gastos_mes_clp).toBe(sumCounted);
    }
  });

  it("includes USD-only statement lines converted to CLP", () => {
    const accountIds = listCreditCardGroupOperationalAccountIds();
    if (accountIds.length === 0) return;
    const ph = accountIds.map(() => "?").join(",");
    const usdOnlyIds = db
      .prepare(
        `SELECT l.id FROM cc_statement_lines l
         JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id IN (${ph})
           AND (l.amount_usd IS NOT NULL AND l.amount_usd != 0)
           AND (l.amount_clp IS NULL OR l.amount_clp = 0)
           AND NOT (l.installment_flag = 1 AND l.valor_cuota_mensual_clp IS NOT NULL AND l.valor_cuota_mensual_clp != 0)`
      )
      .all(...accountIds) as { id: number }[];
    if (usdOnlyIds.length === 0) return;

    const payload = buildFlowsCreditCardExpensesPayload();
    const included = new Set(payload.lines.map((ln) => ln.statement_line_id));
    const matched = usdOnlyIds.filter((r) => included.has(r.id));
    expect(matched.length).toBeGreaterThan(usdOnlyIds.length * 0.5);
    expect(payload.total_clp).toBeGreaterThan(0);
    const usdIncludedClp = payload.lines
      .filter((ln) => usdOnlyIds.some((r) => r.id === ln.statement_line_id))
      .reduce((s, ln) => s + ln.amount_clp, 0);
    expect(usdIncludedClp).toBeGreaterThan(0);
  });

  it("installment lines in payload use cuota amount, not full purchase", () => {
    const payload = buildFlowsCreditCardExpensesPayload();
    const inst = payload.lines.find(
      (ln) =>
        ln.installment_flag === 1 &&
        ln.merchant?.includes("ROCA") &&
        ln.nro_cuota_current != null &&
        ln.nro_cuota_current >= 2
    );
    if (!inst) return;
    expect(inst.amount_clp).toBeLessThan(200_000);
  });
});
