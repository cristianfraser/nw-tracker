import { describe, expect, it } from "vitest";
import type { FundTransaction } from "nw-tracker-contracts";
import { aggregateFintualCertificado } from "./fintualCertificadoTransacciones.js";

const matchReserva: (goalId: string) => string | null = (goalId) =>
  goalId === "1164983" ? "import:excel|key=fondo_reserva" : null;

function deposit(over: Partial<FundTransaction> = {}): FundTransaction {
  return {
    date: "2025-01-09",
    investment: { id: "1164983", name: " Reserva" },
    medio: "Transferencia electronica",
    clp_in: 5_000_000,
    clp_out: 0,
    units_in: 100,
    units_out: 0,
    unit_value: 1000,
    ...over,
  };
}

describe("aggregateFintualCertificado", () => {
  it("keeps multiple same-day reserva deposits as separate rows", () => {
    const scan = aggregateFintualCertificado([deposit(), deposit()], "2099-12", (goalId) => matchReserva(goalId));
    expect(scan.sortedAggregates).toHaveLength(2);
    expect(scan.sortedAggregates.every((a) => a.ymd === "2025-01-09" && a.clpNet === 5_000_000 && a.name === "Reserva")).toBe(true);
  });

  it("leaves out unknown goals, months after the cut and rows with no net flow", () => {
    const scan = aggregateFintualCertificado(
      [
        deposit({ investment: { id: "999", name: "Otra" } }),
        deposit({ date: "2100-01-02" }),
        deposit({ clp_out: 5_000_000, units_out: 100 }),
        deposit({ unit_value: null }),
      ],
      "2099-12",
      (goalId) => matchReserva(goalId)
    );
    expect(scan.sortedAggregates.map((a) => a.valorCuotaHint)).toEqual([null]);
  });
});
