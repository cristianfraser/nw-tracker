import { describe, expect, it } from "vitest";
import {
  compareInterestCertificate,
  compareLoanPaymentHistory,
  derivePrepagoSplit,
  interestByPaymentMonth,
  parseInterestCertificate,
  parsePrepagoLiquidation,
  planCorrections,
  type BankCuotaRow,
  type LedgerCuotaRow,
} from "./loanPaymentHistoryCrossCheck.js";

// Synthetic figures shaped like the lender's history; nothing here is a real payment.
function bank(over: Partial<BankCuotaRow> & Pick<BankCuotaRow, "cuota">): BankCuotaRow {
  return {
    paid_on: "2090-05-11",
    total_clp: 1_000_000,
    principal_clp: 100_000,
    extra_principal_clp: 500_000,
    interest_clp: 350_000,
    insurance_fire_clp: 45_000,
    insurance_life_clp: 5_000,
    penalty_interest_clp: 0,
    other_insurance_clp: 0,
    ...over,
  };
}
function ledger(over: Partial<LedgerCuotaRow> & Pick<LedgerCuotaRow, "cuota">): LedgerCuotaRow {
  return {
    paid_on: "2090-05-11",
    total_clp: 1_000_000,
    principal_clp: 100_000,
    extra_principal_clp: 500_000,
    interest_clp: 350_000,
    insurance_fire_clp: 45_000,
    insurance_life_clp: 5_000,
    ...over,
  };
}

describe("compareLoanPaymentHistory", () => {
  it("compares every field of the cuotas both sides list and reports the rest", () => {
    const r = compareLoanPaymentHistory(
      [
        bank({ cuota: "1", total_clp: 0, principal_clp: 0, extra_principal_clp: 0, interest_clp: 0, insurance_fire_clp: 0, insurance_life_clp: 0 }),
        bank({ cuota: "2" }),
        bank({ cuota: "3", paid_on: "2090-06-05", extra_principal_clp: 500_011, penalty_interest_clp: 84 }),
        bank({ cuota: "9" }),
      ],
      [ledger({ cuota: "2" }), ledger({ cuota: "3", paid_on: "2090-06-11", extra_principal_clp: null }), ledger({ cuota: "4" })]
    );
    expect(r.compared).toBe(2);
    expect(r.agreeing).toEqual(["2"]);
    expect(r.differences).toEqual([
      { cuota: "3", field: "paid_on", bank: "2090-06-05", ledger: "2090-06-11" },
      { cuota: "3", field: "extra_principal", bank: 500_011, ledger: null },
    ]);
    expect(r.bank_only).toEqual(["9"]);
    expect(r.ledger_only).toEqual(["4"]);
    expect(r.unmodelled).toEqual([{ cuota: "3", column: "penalty_interest", amount_clp: 84 }]);
  });
});

describe("planCorrections", () => {
  const b = [bank({ cuota: "4", interest_clp: 0, total_clp: 1_000_000, principal_clp: 150_000, extra_principal_clp: 600_000, insurance_fire_clp: 150_000, insurance_life_clp: 20_000 }), bank({ cuota: "10", extra_principal_clp: 500_000 }), bank({ cuota: "19", paid_on: "2090-09-24" })];
  const l = [ledger({ cuota: "4", interest_clp: null, principal_clp: 150_000, extra_principal_clp: 600_000, insurance_fire_clp: 150_000, insurance_life_clp: 20_000 }), ledger({ cuota: "10", extra_principal_clp: 500_011 }), ledger({ cuota: "19", paid_on: "2090-09-30" })];
  const cmp = compareLoanPaymentHistory(b, l);

  it("turns the plan into corrections and leaves the rest reported", () => {
    const r = planCorrections(cmp, b, l, [
      { kind: "set_field", cuota: "10", field: "extra_principal", source: "bank" },
      { kind: "set_interest_residual", cuota: "4" },
      { kind: "accept", cuota: "4", field: "interes_clp", reason: "printed outside the column" },
    ]);
    expect(r.corrections).toEqual([
      { cuota: "10", kind: "set_field", field: "extra_principal", from: 500_011, to: 500_000 },
      { cuota: "4", kind: "set_interest_residual", from: null, to: 80_000 },
    ]);
    expect(r.accepted).toEqual([{ cuota: "4", field: "interes_clp", reason: "printed outside the column" }]);
    expect(r.unplanned).toEqual([{ cuota: "19", field: "paid_on", bank: "2090-09-24", ledger: "2090-09-30" }]);
  });

  it("takes the bank's date and refuses a residual where the row prints interest", () => {
    const r = planCorrections(cmp, b, l, [{ kind: "set_date", cuota: "19", source: "bank" }]);
    expect(r.corrections).toEqual([{ cuota: "19", kind: "set_date", from: "2090-09-30", to: "2090-09-24" }]);
    expect(() => planCorrections(cmp, b, l, [{ kind: "set_interest_residual", cuota: "10" }])).toThrow(/residual/);
    expect(() => planCorrections(cmp, b, l, [{ kind: "set_date", cuota: "99", source: "bank" }])).toThrow(/not in both/);
  });
});

const LIQUIDATION = `
                                              VALOR EN UF                        VALOR EN $
MONTO DE PREPAGO A CAPITAL                               500,0000                                20.000.000
COMISION DE PREPAGO                                        3,0000                                   120.000
INTERES DEVENGADO                                          1,0000                                    40.000
SEGUROS MES PREPAGO                                        0,0000                                         0
SEGUROS MESES DE GRACIA                                    0,0000                                         0
INTERES PENAL DIV.                                         0,0025                                       100
TOTAL A PAGAR                                            504,0025                                20.160.100
*NUEVO SALDO ACTUAL EN MONEDA ORIGEN:            3.000,0000 UF
                                      Valores calculados al:                                     12/06/2090
                                      Paridad:                                                    40.000,00
`;

describe("prepago liquidations", () => {
  it("reads a liquidation in either digit grouping", () => {
    const q = parsePrepagoLiquidation(LIQUIDATION, "a.pdf");
    expect(q).toMatchObject({
      calculated_on: "2090-06-12",
      principal_uf: 500,
      principal_clp: 20_000_000,
      charge_clp: 120_000,
      accrued_interest_clp: 40_000,
      penalty_interest_clp: 100,
      total_clp: 20_160_100,
      uf_parity: 40_000,
      new_balance_uf: 3000,
    });
    const us = LIQUIDATION.replace(/(?<=\d)[.,](?=\d)/g, (m) => (m === "." ? "," : "."));
    expect(parsePrepagoLiquidation(us, "b.pdf")).toMatchObject({ total_clp: 20_160_100, principal_uf: 500, uf_parity: 40_000, new_balance_uf: 3000 });
  });

  it("splits a prepago by the liquidation whose total it paid, charge apart from interest", () => {
    const q = parsePrepagoLiquidation(LIQUIDATION, "a.pdf");
    const s = derivePrepagoSplit({ label: "prepago 1", paid_on: "2090-06-12", total_clp: 20_160_100, balance_before_uf: 3500, balance_after_uf: 3000 }, [q]);
    expect(s).toEqual({
      label: "prepago 1",
      liquidation: "a.pdf",
      basis: "total_matches",
      principal_clp: 20_000_000,
      interest_clp: 40_000,
      prepayment_charge_clp: 120_100,
      printed_charge_scaled_clp: null,
    });
  });

  it("re-derives principal and interest from the balance drop when a round figure was paid", () => {
    const q = parsePrepagoLiquidation(LIQUIDATION, "a.pdf");
    // 505 UF prepaid against a 500 UF liquidation: interest and the printed charge scale by 1.01.
    const s = derivePrepagoSplit({ label: "prepago 2", paid_on: "2090-06-13", total_clp: 20_400_000, balance_before_uf: 3500, balance_after_uf: 2995 }, [q]);
    expect(s.basis).toBe("round_payment");
    expect(s.principal_clp).toBe(505 * 40_000);
    expect(s.interest_clp).toBe(40_400);
    expect(s.prepayment_charge_clp).toBe(20_400_000 - 20_200_000 - 40_400);
    expect(s.printed_charge_scaled_clp).toBe(121_301);
    expect(() => derivePrepagoSplit({ label: "p", paid_on: "2090-06-01", total_clp: 1, balance_before_uf: 2, balance_after_uf: 1 }, [q])).toThrow(/on or before/);
  });
});

const CERTIFICATE = `
certifica ... que el Sr. X, durante el año 2090 en cumplimiento ... ha pagado los siguientes intereses:
Enero 2090                                  0                            1,0360                            0
Febrero                                  900.000                         1,0260                         923.400
Marzo                                    400.000                         1,0220                         408.800
Abril                                    0                               1,0160                         0
Mayo                                     0                               1,0140                         0
Junio                                    0                               1,0212                         0
Julio                                    0                               1,0170                         0
Agosto                                   0                               1,0080                         0
Septiembre                               0                               1,0070                         0
Octubre                                  0                               1,0030                         0
Noviembre                                0                               1,0030                         0
Diciembre                                100.000                         1,0000                         100.000
Totales                                 1.400.000                                                      1.432.200
`;

describe("interest certificate", () => {
  it("reads the year and the months, checked against the Totales line", () => {
    const c = parseInterestCertificate(CERTIFICATE);
    expect(c.year).toBe(2090);
    expect(c.months[1]).toEqual({ month: "2090-02", interest_clp: 900_000 });
    expect(() => parseInterestCertificate(CERTIFICATE.replace("1.400.000", "1.400.001"))).toThrow(/Totales/);
  });

  it("compares Σ interest by payment month, a prepago's accrued interest included and its charge not", () => {
    const c = parseInterestCertificate(CERTIFICATE);
    const months = interestByPaymentMonth(
      [
        { paid_on: "2090-02-10", interest_clp: 500_000 },
        { paid_on: "2090-02-11", interest_clp: 400_000 },
        { paid_on: "2090-03-11", interest_clp: 400_000 },
        { paid_on: "2090-12-11", interest_clp: 100_001 },
        { paid_on: "2089-12-11", interest_clp: 7 },
      ],
      2090
    );
    const r = compareInterestCertificate(c.months, months);
    expect(r.agreeing).toBe(11);
    expect(r.differences).toEqual([{ month: "2090-12", certificate_clp: 100_000, ledger_clp: 100_001 }]);
  });
});
