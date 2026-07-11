import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  commitMortgagePayment,
  previewMortgagePayment,
} from "./mortgagePaymentCreate.js";
import {
  deptoAccountMarkClpAtYmd,
  loadDeptoLedgerFromMovements,
} from "./deptoLedgerFromMovements.js";

describe("mortgage payment create API layer", () => {
  it("preview and commit update ledger balances", () => {
    const mortgage = db
      .prepare(
        `SELECT id FROM accounts WHERE notes = 'import:excel|key=mortgage' AND account_kind = 'master' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!mortgage) return;

    const ledgerBefore = loadDeptoLedgerFromMovements();
    if (ledgerBefore.length === 0) return;

    const testCuota = `vitest-pay-${Date.now()}`;
    const occurredOn = "2098-07-11";
    // This test exercises the API/DB layer (commit writes both movements + depto rows and
    // cascades), not split precision — so it supplies amortización extra directly rather than
    // a cuota mínima whose split would depend on the test DB's UF rate. amort = pago − interés
    // − seguros − prepago; prepago 0 keeps the whole residual as scheduled amortización.
    const input = {
      occurred_on: occurredOn,
      pago_clp: 1_000_000,
      interes_clp: 250_000,
      incendio_clp: 41_651,
      desgravamen_clp: 3000,
      amortizacion_ext_clp: 0,
      cuota: testCuota,
    };

    const preview = previewMortgagePayment(mortgage.id, input);
    // Split semantics: scheduled amortización + prepago (ext) = pago − interés − seguros.
    expect(preview.sheet.amortizacion_clp).toBeGreaterThan(0);
    expect(preview.sheet.amortizacion_ext_clp ?? 0).toBeGreaterThanOrEqual(0);
    expect(
      (preview.sheet.amortizacion_clp ?? 0) + (preview.sheet.amortizacion_ext_clp ?? 0)
    ).toBe(1_000_000 - 250_000 - 41_651 - 3000);

    const propertyBefore = deptoAccountMarkClpAtYmd("property", occurredOn);

    const committed = commitMortgagePayment(mortgage.id, input);
    expect(committed.mortgage_movement_id).toBeGreaterThan(0);
    expect(committed.property_movement_id).toBeGreaterThan(0);

    // Both movements carry a depto_payments row; the mortgage one carries the flow kind column.
    const paymentRows = db
      .prepare(`SELECT movement_id, kind, origin FROM depto_payments WHERE cuota = ? ORDER BY kind`)
      .all(testCuota) as { movement_id: number; kind: string; origin: string }[];
    expect(paymentRows.map((r) => r.kind)).toEqual(["dividendos", "mortgage"]);
    expect(paymentRows.every((r) => r.origin === "manual")).toBe(true);
    const mortgageFlowKind = db
      .prepare(`SELECT flow_kind FROM movements WHERE id = ?`)
      .get(committed.mortgage_movement_id) as { flow_kind: string | null };
    expect(mortgageFlowKind.flow_kind).toBe("pago_cuota_hipotecario");

    const ledgerAfter = loadDeptoLedgerFromMovements();
    expect(ledgerAfter.some((r) => r.cuota === testCuota && r.occurred_on === occurredOn)).toBe(true);

    const propertyAfter = deptoAccountMarkClpAtYmd("property", occurredOn);
    if (propertyBefore != null && propertyAfter != null) {
      expect(propertyAfter.value_clp).not.toBe(propertyBefore.value_clp);
    }

    // depto_payments rows cascade with the movements.
    db.prepare(`DELETE FROM movements WHERE id IN (?, ?)`).run(
      committed.mortgage_movement_id,
      committed.property_movement_id
    );
    const left = db.prepare(`SELECT COUNT(*) c FROM depto_payments WHERE cuota = ?`).get(testCuota) as {
      c: number;
    };
    expect(left.c).toBe(0);
  });
});
