import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  cartolaMovementDedupeKey,
  parseCartolaAmount,
  parseCheckingCartolaFile,
  periodMonthFromCartolaFileName,
} from "./checkingCartolaParse.js";
import { resolveCfraserCheckingCartolasDir } from "./cfraserPaths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("checkingCartolaParse", () => {
  it("parses period month from Spanish file name", () => {
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

  it("parses April 2026 sample cartola movements", () => {
    const sample = path.join(
      resolveCfraserCheckingCartolasDir(),
      "2026-04-30 Cartola de cuenta Corriente - Abril 2026.xlsx"
    );
    const cartola = parseCheckingCartolaFile(sample);
    expect(cartola.period_month).toBe("2026-04");
    expect(cartola.saldo_final_clp).toBe(51802);
    expect(cartola.movements.length).toBeGreaterThan(0);
    const fintual = cartola.movements.find((m) => m.description.includes("FINTUAL"));
    expect(fintual?.amount_clp).toBe(-5_000_000);
    expect(fintual?.occurred_on).toBe("2026-04-17");
    const tesoreria = cartola.movements.find((m) => m.description.includes("TESORERIA"));
    expect(tesoreria?.amount_clp).toBe(23_097_197);
    const dupes = new Set(cartola.movements.map((m) => cartolaMovementDedupeKey(m)));
    expect(dupes.size).toBe(cartola.movements.length);
  });

  it("keeps same-day same-amount rows when document numbers differ (Feb 2024)", () => {
    const sample = path.join(
      resolveCfraserCheckingCartolasDir(),
      "2024-02-29 Cartola de cuenta Corriente - Febrero 2024.xlsx"
    );
    const cartola = parseCheckingCartolaFile(sample);
    expect(cartola.period_month).toBe("2024-02");
    const fraser = cartola.movements.filter((m) =>
      m.description.includes("0081172943")
    );
    expect(fraser.length).toBeGreaterThanOrEqual(2);
    const feb21 = fraser.filter((m) => m.occurred_on === "2024-02-21" && m.amount_clp === 4_000_000);
    expect(feb21.length).toBe(2);
    expect(new Set(feb21.map((m) => m.document_no))).toEqual(new Set(["1113415", "1113423"]));
    const dupSkips = cartola.skipped.filter((s) => s.reason === "duplicate_in_cartola");
    expect(dupSkips).toHaveLength(0);
  });

  it("keeps same-day same-amount rows without document number (Dec 2022)", () => {
    const sample = path.join(
      resolveCfraserCheckingCartolasDir(),
      "2022-12-31 Cartola de cuenta Corriente - Diciembre 2022.xlsx"
    );
    const cartola = parseCheckingCartolaFile(sample);
    const dec15 = cartola.movements.filter(
      (m) => m.occurred_on === "2022-12-15" && m.amount_clp === -1000
    );
    expect(dec15.length).toBe(2);
    expect(dec15.every((m) => !String(m.document_no ?? "").trim())).toBe(true);
    const dupSkips = cartola.skipped.filter(
      (s) => s.reason === "duplicate_in_cartola" && s.amount_clp === -1000
    );
    expect(dupSkips).toHaveLength(0);
  });

  it("keeps duplicate doc rows when saldo requires both (Nov 2024)", () => {
    const sample = path.join(
      resolveCfraserCheckingCartolasDir(),
      "2024-11-30 Cartola de cuenta Corriente - Noviembre 2024.xlsx"
    );
    const cartola = parseCheckingCartolaFile(sample);
    const nov15 = cartola.movements.filter(
      (m) =>
        m.occurred_on === "2024-11-15" &&
        m.description.includes("0768106274") &&
        m.document_no === "9243207"
    );
    expect(nov15.filter((m) => m.amount_clp === 7_000_000)).toHaveLength(2);
    expect(nov15.find((m) => m.amount_clp === 5_500_000)).toBeDefined();
    expect(cartola.skipped.filter((s) => s.reason === "duplicate_in_cartola")).toHaveLength(0);
  });

  it("infers missing abono from saldo column (Mar 2024)", () => {
    const sample = path.join(
      resolveCfraserCheckingCartolasDir(),
      "2024-03-31 Cartola de cuenta Corriente - Marzo 2024.xlsx"
    );
    const cartola = parseCheckingCartolaFile(sample);
    const mar21 = cartola.movements.filter((m) => m.occurred_on === "2024-03-21");
    const fraser = mar21.find((m) => m.description.includes("0081172943"));
    expect(fraser?.amount_clp).toBe(1_000_000);
    expect(cartola.notes.some((n) => n.message.includes("inferred abono"))).toBe(true);
    expect(cartola.skipped.filter((s) => s.reason === "no_amount" && s.fecha === "21/03")).toHaveLength(
      0
    );
  });

  it("cartolaMovementDedupeKey treats different document numbers as distinct", () => {
    const a = cartolaMovementDedupeKey({
      occurred_on: "2024-02-21",
      amount_clp: 4_000_000,
      description: "Transf. Cristian Alejandro Fraser",
      document_no: "1113415",
    });
    const b = cartolaMovementDedupeKey({
      occurred_on: "2024-02-21",
      amount_clp: 4_000_000,
      description: "Transf. Cristian Alejandro Fraser",
      document_no: "1113423",
    });
    expect(a).not.toBe(b);
  });
});
