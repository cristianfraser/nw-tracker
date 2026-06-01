import { describe, expect, it } from "vitest";
import type { ParsedCheckingCartola } from "./checkingCartolaParse.js";
import { validateCheckingCartolaSaldoIdentity } from "./checkingCartolaSaldoValidation.js";

function cartola(partial: Partial<ParsedCheckingCartola> & Pick<ParsedCheckingCartola, "period_month">): ParsedCheckingCartola {
  return {
    source_file: "test.pdf",
    period_from: null,
    period_to: null,
    saldo_inicial_clp: null,
    saldo_final_clp: null,
    movements: [],
    skipped: [],
    notes: [],
    ...partial,
  };
}

describe("validateCheckingCartolaSaldoIdentity", () => {
  it("passes when saldo inicial + abonos − cargos = saldo final", () => {
    const err = validateCheckingCartolaSaldoIdentity(
      cartola({
        period_month: "2017-12",
        saldo_inicial_clp: 778_114,
        saldo_final_clp: 403_351,
        movements: [
          { occurred_on: "2017-12-01", amount_clp: 2_300_142, branch: "", description: "in", document_no: "" },
          { occurred_on: "2017-12-29", amount_clp: -2_674_905, branch: "", description: "out", document_no: "" },
        ],
      })
    );
    expect(err).toBeNull();
  });

  it("fails on identity mismatch", () => {
    const err = validateCheckingCartolaSaldoIdentity(
      cartola({
        period_month: "2017-12",
        saldo_inicial_clp: 33_574,
        saldo_final_clp: 0,
        movements: [
          { occurred_on: "2017-12-01", amount_clp: 2_300_142, branch: "", description: "in", document_no: "" },
          { occurred_on: "2017-12-29", amount_clp: -2_674_905, branch: "", description: "out", document_no: "" },
        ],
      })
    );
    expect(err).toMatch(/saldo identity mismatch/);
    expect(err).toMatch(/33574/);
  });
});
