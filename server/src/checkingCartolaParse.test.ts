import { describe, expect, it } from "vitest";
import XLSX from "xlsx";
import {
  cartolaMovementDedupeKey,
  movementNote,
  parseCartolaAmount,
  parseCheckingCartolaWorkbook,
  periodMonthFromCartolaFileName,
} from "./checkingCartolaParse.js";

/**
 * Synthetic Santander-cartola workbooks (column layout: FECHA, sucursal, descripción,
 * documento, cargo, abono, saldo). Fixtures replicate real-file parsing scenarios with
 * made-up data — tests must not depend on the personal xlsx files under cfraser/.
 */
function cartolaWorkbook(rows: unknown[][]): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Cartola");
  return wb;
}

const HEADER = ["FECHA", "SUCURSAL", "DESCRIPCION", "N DOCUMENTO", "CARGO", "ABONO", "SALDO"];

describe("checkingCartolaParse", () => {
  it("parses period month from Spanish file name", () => {
    expect(
      periodMonthFromCartolaFileName(
        "2026-03-31 Cartola de cuenta Corriente - Abril 2026.xlsx"
      )
    ).toBe("2026-04");
    expect(periodMonthFromCartolaFileName("Cartola de cuenta Corriente - Abril 2026.xlsx")).toBe(
      "2026-04"
    );
    expect(periodMonthFromCartolaFileName("Cartola de cuenta Corriente - Diciembre 2024.xlsx")).toBe(
      "2024-12"
    );
    expect(
      periodMonthFromCartolaFileName(
        "2026-04-30 Cartola de cuenta Corriente - Abril 2026.xlsx"
      )
    ).toBe("2026-04");
  });

  it("parses Chilean amounts", () => {
    expect(parseCartolaAmount("$1.651.718")).toBe(1651718);
    expect(parseCartolaAmount("23097197")).toBe(23097197);
  });

  it("parses movements, saldos, and period from a cartola workbook", () => {
    const cartola = parseCheckingCartolaWorkbook(
      cartolaWorkbook([
        ["", "", "", "", "Desde", "01/04/2026"],
        ["", "", "", "", "Hasta", "30/04/2026"],
        ["Saldo inicial:", "$6.051.802"],
        ["Saldo final:", "$51.802"],
        HEADER,
        ["17/04", "OF.CENTRAL", "TRANSFERENCIA A CORREDORA", "5551001", "$5.000.000", "", "$1.051.802"],
        ["20/04", "INTERNET", "ABONO TRANSFERENCIA RECIBIDA", "5551002", "", "2000000", "$3.051.802"],
        ["25/04", "INTERNET", "PAGO TARJETA CREDITO", "", "$3.000.000", "", "$51.802"],
      ]),
      "2026-04-30 Cartola de cuenta Corriente - Abril 2026.xlsx"
    );
    expect(cartola.period_month).toBe("2026-04");
    expect(cartola.period_from).toBe("2026-04-01");
    expect(cartola.period_to).toBe("2026-04-30");
    expect(cartola.saldo_inicial_clp).toBe(6_051_802);
    expect(cartola.saldo_final_clp).toBe(51_802);
    expect(cartola.movements).toHaveLength(3);
    const corredora = cartola.movements.find((m) => m.description.includes("CORREDORA"));
    expect(corredora?.amount_clp).toBe(-5_000_000);
    expect(corredora?.occurred_on).toBe("2026-04-17");
    const abono = cartola.movements.find((m) => m.description.includes("RECIBIDA"));
    expect(abono?.amount_clp).toBe(2_000_000);
    const dupes = new Set(cartola.movements.map((m) => cartolaMovementDedupeKey(m)));
    expect(dupes.size).toBe(cartola.movements.length);
  });

  it("keeps same-day same-amount rows when document numbers differ", () => {
    const cartola = parseCheckingCartolaWorkbook(
      cartolaWorkbook([
        ["Saldo inicial:", "$10.000.000"],
        ["Saldo final:", "$2.000.000"],
        HEADER,
        ["21/02", "INTERNET", "Transf. a cuenta propia", "2224001", "$4.000.000", "", "$6.000.000"],
        ["21/02", "INTERNET", "Transf. a cuenta propia", "2224002", "$4.000.000", "", "$2.000.000"],
      ]),
      "2024-02-29 Cartola de cuenta Corriente - Febrero 2024.xlsx"
    );
    expect(cartola.period_month).toBe("2024-02");
    const feb21 = cartola.movements.filter(
      (m) => m.occurred_on === "2024-02-21" && m.amount_clp === -4_000_000
    );
    expect(feb21).toHaveLength(2);
    expect(new Set(feb21.map((m) => m.document_no))).toEqual(new Set(["2224001", "2224002"]));
    expect(cartola.skipped.filter((s) => s.reason === "duplicate_in_cartola")).toHaveLength(0);
  });

  it("keeps same-day same-amount rows without document number", () => {
    const cartola = parseCheckingCartolaWorkbook(
      cartolaWorkbook([
        ["Saldo inicial:", "$100.000"],
        ["Saldo final:", "$98.000"],
        HEADER,
        ["15/12", "OF.CENTRAL", "COMISION USO CAJERO", "", "$1.000", "", "$99.000"],
        ["15/12", "OF.CENTRAL", "COMISION USO CAJERO", "", "$1.000", "", "$98.000"],
      ]),
      "2022-12-31 Cartola de cuenta Corriente - Diciembre 2022.xlsx"
    );
    const dec15 = cartola.movements.filter(
      (m) => m.occurred_on === "2022-12-15" && m.amount_clp === -1000
    );
    expect(dec15).toHaveLength(2);
    expect(dec15.every((m) => !String(m.document_no ?? "").trim())).toBe(true);
    expect(
      cartola.skipped.filter((s) => s.reason === "duplicate_in_cartola" && s.amount_clp === -1000)
    ).toHaveLength(0);
  });

  it("keeps duplicate doc rows when saldo requires both", () => {
    const cartola = parseCheckingCartolaWorkbook(
      cartolaWorkbook([
        ["Saldo inicial:", "$20.000.000"],
        ["Saldo final:", "$500.000"],
        HEADER,
        ["15/11", "INTERNET", "TRANSFERENCIA A TERCERO", "9243207", "$7.000.000", "", "$13.000.000"],
        ["15/11", "INTERNET", "TRANSFERENCIA A TERCERO", "9243207", "$7.000.000", "", "$6.000.000"],
        ["15/11", "INTERNET", "TRANSFERENCIA A TERCERO", "9243207", "$5.500.000", "", "$500.000"],
      ]),
      "2024-11-30 Cartola de cuenta Corriente - Noviembre 2024.xlsx"
    );
    const nov15 = cartola.movements.filter(
      (m) => m.occurred_on === "2024-11-15" && m.document_no === "9243207"
    );
    expect(nov15.filter((m) => m.amount_clp === -7_000_000)).toHaveLength(2);
    expect(nov15.find((m) => m.amount_clp === -5_500_000)).toBeDefined();
    expect(cartola.skipped.filter((s) => s.reason === "duplicate_in_cartola")).toHaveLength(0);
  });

  it("drops a repeated line when the saldo column only accounts for one", () => {
    const cartola = parseCheckingCartolaWorkbook(
      cartolaWorkbook([
        ["Saldo inicial:", "$1.000.000"],
        ["Saldo final:", "$800.000"],
        HEADER,
        ["15/05", "INTERNET", "PAGO AUTOMATICO SERVICIO", "777001", "$200.000", "", ""],
        ["15/05", "INTERNET", "PAGO AUTOMATICO SERVICIO", "777001", "$200.000", "", "$800.000"],
      ]),
      "2025-05-31 Cartola de cuenta Corriente - Mayo 2025.xlsx"
    );
    expect(cartola.movements).toHaveLength(1);
    expect(cartola.movements[0]!.amount_clp).toBe(-200_000);
    const dupSkips = cartola.skipped.filter((s) => s.reason === "duplicate_in_cartola");
    expect(dupSkips).toHaveLength(1);
    expect(dupSkips[0]!.amount_clp).toBe(-200_000);
  });

  it("infers missing abono from saldo column", () => {
    const cartola = parseCheckingCartolaWorkbook(
      cartolaWorkbook([
        ["Saldo inicial:", "$500.000"],
        ["Saldo final:", "$1.500.000"],
        HEADER,
        ["21/03", "INTERNET", "TRANSFERENCIA RECIBIDA", "3334001", "", "", "$1.500.000"],
      ]),
      "2024-03-31 Cartola de cuenta Corriente - Marzo 2024.xlsx"
    );
    const mar21 = cartola.movements.find((m) => m.occurred_on === "2024-03-21");
    expect(mar21?.amount_clp).toBe(1_000_000);
    expect(cartola.notes.some((n) => n.message.includes("inferred abono"))).toBe(true);
    expect(
      cartola.skipped.filter((s) => s.reason === "no_amount" && s.fecha === "21/03")
    ).toHaveLength(0);
  });

  it("stops at the footer instead of re-parsing repeated Santander tables", () => {
    const movementRows = [
      ["03/02", "INTERNET", "PAGO SERVICIO BASICO", "888001", "$555.000", "", "$1.445.000"],
      ["10/02", "INTERNET", "ABONO TRANSFERENCIA", "888002", "", "$300.000", "$1.745.000"],
      ["20/02", "OF.CENTRAL", "COMISION MANTENCION", "", "$45.000", "", "$1.700.000"],
    ];
    // Some Santander exports repeat the whole movement table 2–3× after the footer.
    const cartola = parseCheckingCartolaWorkbook(
      cartolaWorkbook([
        ["Saldo inicial:", "$2.000.000"],
        ["Saldo final:", "$1.700.000"],
        HEADER,
        ...movementRows,
        ["", "", "Resumen de Comisiones", "", "", "", ""],
        HEADER,
        ...movementRows,
        HEADER,
        ...movementRows,
      ]),
      "2023-02-28 Cartola de cuenta Corriente - Febrero 2023.xlsx"
    );
    expect(cartola.period_month).toBe("2023-02");
    expect(cartola.movements).toHaveLength(3);
    expect(
      cartola.movements.some((m) => m.occurred_on === "2023-02-03" && m.amount_clp === -555_000)
    ).toBe(true);
    const notes = cartola.movements.map((m, idx) =>
      movementNote(cartola.period_month, m.branch, m.description, m.document_no, {
        occurredOn: m.occurred_on,
        amountClp: m.amount_clp,
        cartolaIndex: idx,
      })
    );
    expect(new Set(notes).size).toBe(cartola.movements.length);
  });

  it("cartolaMovementDedupeKey treats different document numbers as distinct", () => {
    const a = cartolaMovementDedupeKey({
      occurred_on: "2024-02-21",
      amount_clp: 4_000_000,
      description: "Transf. a cuenta propia",
      document_no: "2224001",
    });
    const b = cartolaMovementDedupeKey({
      occurred_on: "2024-02-21",
      amount_clp: 4_000_000,
      description: "Transf. a cuenta propia",
      document_no: "2224002",
    });
    expect(a).not.toBe(b);
  });
});
