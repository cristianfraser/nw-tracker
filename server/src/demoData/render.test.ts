import { describe, expect, it } from "vitest";
import type { CardDef } from "./person.js";
import { renderCardStatements } from "./render.js";
import type { CardStatement, InstallmentPlan, Ledger } from "./simulate.js";

const card: CardDef = { key: "main", issuer: "santander", last4: "9901", displayName: "Demo Test 9901", from: "2025-01", closeDay: 22 };

const plan: InstallmentPlan = {
  id: "plan-test",
  card: "main",
  purchaseDate: "2025-11-07",
  merchant: "DEMO TEST STORE",
  category: "Tecnología",
  totalClp: 2_700_000,
  cuotas: 12,
  cuotaClp: 225_000,
  firstClose: "2025-11-22",
};

function statement(close: string, n: number): CardStatement {
  return {
    card: "main",
    currency: "clp", // convention-ok: the demo story's documents are in pesos and dollars
    close,
    periodFrom: close,
    payBy: close,
    nextClose: close,
    lines: [],
    cuotas: [{ plan, n }],
    saldoAnterior: 0,
    paidPrevious: 0,
    paidPreviousDate: null,
    paidPreviousViaDivisas: false,
    facturado: plan.cuotaClp,
  };
}

describe("renderCardStatements", () => {
  it("prints a plan's cuota line with the principal as its amount and the cuota in the cuota field", () => {
    const ledger = { person: { cards: [card] }, statements: [statement("2025-11-22", 1), statement("2025-12-22", 2)] } as unknown as Ledger;
    const lines = renderCardStatements(ledger).flatMap((s) => s.lines);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.amount).toBe(2_700_000);
      expect(line.installment?.cuota_amount).toBe(225_000);
      expect(line.installment?.total_amount).toBe(2_700_000);
    }
    expect(lines.map((l) => l.installment?.number)).toEqual([1, 2]);
  });
});
