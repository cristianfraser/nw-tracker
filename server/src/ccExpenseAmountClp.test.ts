import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { fxRowOnOrBefore } from "./fxRates.js";
import {
  effectiveCcExpenseLineAmountClp,
  effectiveCcExpenseLineAmountUsd,
} from "./ccExpenseAmountClp.js";

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
        amount_clp: 5555,
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
    // Rate from fx_daily (revisable by backfills) — a hardcoded rate rots when Yahoo
    // history is re-synced.
    const fx = fxRowOnOrBefore("2025-05-22");
    expect(fx).not.toBeNull();
    expect(amount).toBe(Math.round(68.29 * fx!.clp_per_usd));
  });

  it("converts USD cuota when CLP cuota is missing", () => {
    // Own fx fixture — the date may predate whatever fx_daily history the test DB has.
    const fxDate = "2024-08-31";
    const hadRow =
      db.prepare(`SELECT 1 FROM fx_daily WHERE date = ?`).get(fxDate) != null;
    db.prepare(
      `INSERT INTO fx_daily (date, clp_per_usd) VALUES (?, 920)
       ON CONFLICT(date) DO NOTHING`
    ).run(fxDate);
    try {
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
    } finally {
      if (!hadRow) db.prepare(`DELETE FROM fx_daily WHERE date = ?`).run(fxDate);
    }
  });
});

describe("effectiveCcExpenseLineAmountUsd", () => {
  it("returns amount_usd on USD statements", () => {
    expect(
      effectiveCcExpenseLineAmountUsd({
        installment_flag: 0,
        amount_clp: 5555,
        amount_usd: 4.53,
        valor_cuota_mensual_clp: null,
        valor_cuota_mensual_usd: null,
        statement_currency: "usd",
      })
    ).toBe(4.53);
  });

  it("returns null for CLP-only revolving lines", () => {
    expect(
      effectiveCcExpenseLineAmountUsd({
        installment_flag: 0,
        amount_clp: 50_000,
        amount_usd: null,
        valor_cuota_mensual_clp: null,
        valor_cuota_mensual_usd: null,
        statement_currency: "clp",
      })
    ).toBeNull();
  });

  it("uses valor_cuota_mensual_usd for installment lines", () => {
    expect(
      effectiveCcExpenseLineAmountUsd({
        installment_flag: 1,
        amount_clp: 881_134,
        amount_usd: 100,
        valor_cuota_mensual_clp: 73_428,
        valor_cuota_mensual_usd: 80,
        statement_currency: "usd",
      })
    ).toBe(80);
  });
});
