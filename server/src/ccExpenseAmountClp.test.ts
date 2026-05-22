import { describe, expect, it } from "vitest";
import { effectiveCcExpenseLineAmountClp } from "./ccExpenseAmountClp.js";

describe("effectiveCcExpenseLineAmountClp", () => {
  it("uses valor_cuota_mensual_clp for installment lines", () => {
    expect(
      effectiveCcExpenseLineAmountClp(
        {
          installment_flag: 1,
          amount_clp: 881_134,
          amount_usd: 100,
          valor_cuota_mensual_clp: 73_428,
          valor_cuota_mensual_usd: 80,
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

  it("prefers amount_usd on USD statements over reference amount_clp", () => {
    const amount = effectiveCcExpenseLineAmountClp(
      {
        installment_flag: 0,
        amount_clp: 4112,
        amount_usd: 4.53,
        valor_cuota_mensual_clp: null,
        valor_cuota_mensual_usd: null,
        statement_currency: "usd",
      },
      "2025-08-25"
    );
    expect(amount).toBeGreaterThan(3_000);
    expect(amount).toBeLessThan(6_000);
  });

  it("converts USD when amount_clp is zero placeholder", () => {
    const amount = effectiveCcExpenseLineAmountClp(
      {
        installment_flag: 0,
        amount_clp: 0,
        amount_usd: 68.29,
        valor_cuota_mensual_clp: null,
        valor_cuota_mensual_usd: null,
      },
      "2025-05-22"
    );
    expect(amount).toBe(Math.round(68.29 * 942.21));
  });

  it("converts USD cuota when CLP cuota is missing", () => {
    const fxDate = "2024-08-31";
    const amount = effectiveCcExpenseLineAmountClp(
      {
        installment_flag: 1,
        amount_clp: null,
        amount_usd: 50,
        valor_cuota_mensual_clp: null,
        valor_cuota_mensual_usd: 25,
      },
      fxDate
    );
    expect(amount).not.toBeNull();
    expect(amount!).toBeGreaterThan(20_000);
  });
});
