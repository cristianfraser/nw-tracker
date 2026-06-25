import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { buildInstallmentPlanGastosLines } from "./ccInstallmentPlanGastosLines.js";
import { buildFlowsCreditCardExpensesPayload } from "./flowsCreditCardExpenses.js";

describe("ccInstallmentPlanGastosLines", () => {
  it("emits scheduled cuotas for pay-by months not yet on statement PDFs", () => {
    const accountId = (
      db.prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`).get() as
        | { id: number }
        | undefined
    )?.id;
    if (!accountId) return;

    const payload = buildFlowsCreditCardExpensesPayload();
    const aug = payload.lines.filter(
      (ln) =>
        ln.account_id === accountId &&
        ln.line_role === "installment_cuota" &&
        ln.billing_month === "2026-08"
    );
    if (aug.length === 0) return;

    const sum = aug.reduce((s, ln) => s + ln.amount_clp, 0);
    expect(sum).toBeGreaterThan(0);
    const bySlot = new Map<string, number>();
    for (const ln of aug) {
      const key = `${ln.purchase_on}:${ln.nro_cuota_current}/${ln.nro_cuota_total}:${ln.amount_clp}`;
      bySlot.set(key, (bySlot.get(key) ?? 0) + 1);
    }
    for (const [key, count] of bySlot) {
      expect(count, key).toBe(1);
    }
  });

  it("does not duplicate cuotas already covered by statement or payment gastos lines", () => {
    const accountId = (
      db.prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`).get() as
        | { id: number }
        | undefined
    )?.id;
    if (!accountId) return;

    const payload = buildFlowsCreditCardExpensesPayload();
    const june = payload.lines.filter(
      (ln) =>
        ln.account_id === accountId &&
        ln.line_role === "installment_cuota" &&
        ln.billing_month === "2026-06"
    );
    if (june.length === 0) return;

    const fromPlanOnly = buildInstallmentPlanGastosLines([accountId], payload.lines);
    const junePlan = fromPlanOnly.filter(
      (ln) => ln.account_id === accountId && ln.billing_month === "2026-06"
    );
    expect(junePlan).toHaveLength(0);
  });

  it("projects 01/03 not 03/03 after 00/03 preamble when July open", () => {
    const accountId = (
      db.prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`).get() as
        | { id: number }
        | undefined
    )?.id;
    if (!accountId) return;

    const payload = buildFlowsCreditCardExpensesPayload();
    const blund = payload.lines.find(
      (ln) =>
        ln.account_id === accountId &&
        ln.line_role === "installment_cuota" &&
        ln.billing_month === "2026-08" &&
        String(ln.merchant ?? "").toUpperCase().includes("BLUNDSTONE")
    );
    if (!blund) return;
    expect(blund.nro_cuota_current).toBe(1);
    expect(blund.nro_cuota_total).toBe(3);
    expect(blund.amount_clp).toBe(63_300);
  });
});
