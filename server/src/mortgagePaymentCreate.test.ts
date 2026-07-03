import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  commitMortgagePayment,
  previewMortgagePayment,
} from "./mortgagePaymentCreate.js";
import { loadDeptoDividendosSheetLedgerFromDb } from "./deptoDividendosLedger.js";
import { deptoAccountMarkClpAtYmd } from "./deptoLedgerFromMovements.js";

describe("mortgage payment create API layer", () => {
  it("preview and commit update ledger balances", () => {
    const mortgage = db
      .prepare(
        `SELECT id FROM accounts WHERE notes = 'import:excel|key=mortgage' AND account_kind = 'master' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!mortgage) return;

    const ledgerBefore = loadDeptoDividendosSheetLedgerFromDb();
    if (ledgerBefore.length === 0) return;

    const testCuota = `vitest-pay-${Date.now()}`;
    const occurredOn = "2098-07-11";
    // pago must cover the SCHEDULED cuota (amortización from the min-UF schedule, which
    // grows with the ledger/UF) plus any prepago — a hardcoded 400.000 rotted once the
    // scheduled amortización outgrew its residual. Large pago keeps prepago ≥ 0.
    const input = {
      occurred_on: occurredOn,
      pago_clp: 1_000_000,
      interes_clp: 250_000,
      incendio_clp: 41_651,
      desgravamen_clp: 3000,
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

    const ledgerAfter = loadDeptoDividendosSheetLedgerFromDb();
    expect(ledgerAfter.some((r) => r.cuota === testCuota && r.occurred_on === occurredOn)).toBe(true);

    const propertyAfter = deptoAccountMarkClpAtYmd("property", occurredOn);
    if (propertyBefore != null && propertyAfter != null) {
      expect(propertyAfter.value_clp).not.toBe(propertyBefore.value_clp);
    }

    db.prepare(`DELETE FROM movements WHERE id IN (?, ?)`).run(
      committed.mortgage_movement_id,
      committed.property_movement_id
    );
    db.prepare(`DELETE FROM depto_dividendos_sheet_rows WHERE cuota = ?`).run(testCuota);
  });
});
