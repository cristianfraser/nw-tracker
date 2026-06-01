import { describe, expect, it } from "vitest";
import { isCartolaDesdeBoundaryPhantomMonth } from "./calendarMonth.js";
import { movementNote } from "./checkingCartolaParse.js";
import type { ParsedCheckingCartola } from "./checkingCartolaParse.js";
import {
  cartolaCalendarMonths,
  splitCuentaVistaCartolaByCalendarMonth,
} from "./cuentaVistaCartolaSplit.js";

function baseCartola(overrides: Partial<ParsedCheckingCartola> = {}): ParsedCheckingCartola {
  return {
    source_file: "2019-10-31 cartola cuenta vista.pdf",
    period_month: "2020-01",
    period_from: "2019-11-01",
    period_to: "2020-01-31",
    saldo_inicial_clp: 1_000_000,
    saldo_final_clp: 2_500_000,
    movements: [],
    skipped: [],
    notes: [],
    ...overrides,
  };
}

describe("splitCuentaVistaCartolaByCalendarMonth", () => {
  it("returns single-month cartola unchanged", () => {
    const cartola = baseCartola({
      period_month: "2021-04",
      period_from: "2021-04-01",
      period_to: "2021-04-30",
      movements: [
        {
          occurred_on: "2021-04-15",
          amount_clp: -5000,
          branch: "401",
          description: "Giro ATM",
          document_no: "123",
        },
      ],
    });
    expect(splitCuentaVistaCartolaByCalendarMonth(cartola)).toEqual([cartola]);
  });

  it("returns boundary single-month cartola unchanged (DESDE in prior month)", () => {
    const cartola = baseCartola({
      period_month: "2024-04",
      period_from: "2024-03-28",
      period_to: "2024-04-30",
      saldo_inicial_clp: 1_251_492,
      saldo_final_clp: 527_317,
      movements: [
        {
          occurred_on: "2024-04-07",
          amount_clp: -600_000,
          branch: "Agustinas",
          description: "Transf a INMOBILIARIA Y CONSTR",
          document_no: "5034296",
        },
        {
          occurred_on: "2024-04-24",
          amount_clp: -124_175,
          branch: "O.Gerencia",
          description: "PAGO EN LINEA PROM. CMR FALABELLA S.A.",
          document_no: "6007021",
        },
      ],
    });
    expect(splitCuentaVistaCartolaByCalendarMonth(cartola)).toEqual([cartola]);
    expect(cartolaCalendarMonths(cartola)).toEqual(["2024-04"]);
  });

  it("splits Nov 2019–Jan 2020 into three monthly slices", () => {
    const cartola = baseCartola({
      movements: [
        {
          occurred_on: "2019-11-05",
          amount_clp: -7500,
          branch: "401",
          description: "Giro ATM",
          document_no: "1",
        },
        {
          occurred_on: "2019-12-28",
          amount_clp: 550_000,
          branch: "401",
          description: "Abono",
          document_no: "2",
        },
        {
          occurred_on: "2020-01-02",
          amount_clp: -100_000,
          branch: "401",
          description: "Transfer",
          document_no: "3",
        },
      ],
    });

    const slices = splitCuentaVistaCartolaByCalendarMonth(cartola);
    expect(slices.map((s) => s.period_month)).toEqual(["2019-11", "2019-12", "2020-01"]);
    expect(slices[0]!.movements).toHaveLength(1);
    expect(slices[1]!.movements).toHaveLength(1);
    expect(slices[2]!.movements).toHaveLength(1);
    expect(slices[0]!.saldo_inicial_clp).toBe(1_000_000);
    expect(slices[0]!.saldo_final_clp).toBeNull();
    expect(slices[2]!.saldo_final_clp).toBe(2_500_000);

    const noteNov = movementNote("2019-11", "401", "Giro ATM", "1", {
      occurredOn: "2019-11-05",
      amountClp: -7500,
      cartolaIndex: 0,
    });
    expect(noteNov.startsWith("import:cartola|2019-11|")).toBe(true);
  });

  it("includes empty months inside a four-month span", () => {
    const cartola = baseCartola({
      period_from: "2019-01-01",
      period_to: "2019-04-30",
      period_month: "2019-04",
      movements: [
        {
          occurred_on: "2019-01-10",
          amount_clp: -1000,
          branch: "401",
          description: "A",
          document_no: "1",
        },
        {
          occurred_on: "2019-04-20",
          amount_clp: -2000,
          branch: "401",
          description: "B",
          document_no: "2",
        },
      ],
    });

    const slices = splitCuentaVistaCartolaByCalendarMonth(cartola);
    expect(slices.map((s) => [s.period_month, s.movements.length])).toEqual([
      ["2019-01", 1],
      ["2019-02", 0],
      ["2019-03", 0],
      ["2019-04", 1],
    ]);
    expect(cartolaCalendarMonths(cartola)).toEqual(["2019-01", "2019-02", "2019-03", "2019-04"]);
  });

  it("assigns per-month saldo referencia from month_saldo_final_clp", () => {
    const cartola = baseCartola({
      period_from: "2019-11-01",
      period_to: "2020-01-31",
      month_saldo_final_clp: {
        "2019-11": 900_000,
        "2019-12": 950_000,
        "2020-01": 2_500_000,
      },
      movements: [
        {
          occurred_on: "2019-11-05",
          amount_clp: -7500,
          branch: "401",
          description: "Giro ATM",
          document_no: "1",
        },
        {
          occurred_on: "2020-01-02",
          amount_clp: -100_000,
          branch: "401",
          description: "Transfer",
          document_no: "3",
        },
      ],
    });

    const slices = splitCuentaVistaCartolaByCalendarMonth(cartola);
    expect(slices[0]!.saldo_final_clp).toBe(900_000);
    expect(slices[1]!.saldo_final_clp).toBe(950_000);
    expect(slices[1]!.saldo_inicial_clp).toBe(900_000);
    expect(slices[2]!.saldo_final_clp).toBe(2_500_000);
    expect(slices[2]!.saldo_inicial_clp).toBe(950_000);
  });

  it("does not emit Oct 2016 on annual cartola (Nov 2016 first data month)", () => {
    const cartola = baseCartola({
      source_file: "2017-10-31 cartola cuenta vista.pdf",
      period_month: "2017-10",
      period_from: "2016-10-28",
      period_to: "2017-10-31",
      saldo_inicial_clp: 1074,
      saldo_final_clp: 962,
      month_saldo_final_clp: {
        "2016-10": 1074,
        "2016-11": 1074,
        "2017-10": 962,
      },
      movements: [
        {
          occurred_on: "2016-11-10",
          amount_clp: -100,
          branch: "401",
          description: "Giro",
          document_no: "1",
        },
        {
          occurred_on: "2017-10-02",
          amount_clp: -50,
          branch: "401",
          description: "Giro",
          document_no: "2",
        },
      ],
    });

    const slices = splitCuentaVistaCartolaByCalendarMonth(cartola);
    expect(slices.map((s) => s.period_month)).not.toContain("2016-10");
    expect(slices[0]!.period_month).toBe("2016-11");
    expect(slices[0]!.saldo_inicial_clp).toBe(1074);
    expect(
      isCartolaDesdeBoundaryPhantomMonth({
        period_month: "2016-10",
        period_from: cartola.period_from,
        period_to: cartola.period_to,
        movement_count: 0,
      })
    ).toBe(true);
  });
});
