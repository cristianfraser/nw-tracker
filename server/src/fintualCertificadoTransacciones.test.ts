import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { aggregateFintualCertificado } from "./fintualCertificadoTransacciones.js";

const matchReserva: (goalId: string) => string | null = (goalId) =>
  goalId === "1164983" ? "import:excel|key=fondo_reserva" : null;

describe("aggregateFintualCertificado", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps multiple same-day reserva deposits as separate rows", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fintual-cert-"));
    const csvPath = path.join(tmpDir, "cert.csv");
    fs.writeFileSync(
      csvPath,
      [
        "fecha,id_inversión,nombre_inversión,aporte_pesos_chilenos,rescate_pesos_chilenos,aporte_cuotas,rescate_cuotas,medio,valor_cuota",
        "09/01/2025,1164983,Reserva,5000000,0,100,0,Transferencia electronica,1000",
        "09/01/2025,1164983,Reserva,5000000,0,100,0,Transferencia electronica,1000",
      ].join("\n"),
      "utf8"
    );

    const scan = aggregateFintualCertificado(csvPath, "2099-12", (goalId, _name) =>
      matchReserva(goalId)
    );
    expect(scan).not.toBeNull();
    const reserva = scan!.sortedAggregates.filter(
      (a) => matchReserva(a.goalId) === "import:excel|key=fondo_reserva"
    );
    expect(reserva).toHaveLength(2);
    expect(reserva.every((a) => a.ymd === "2025-01-09" && a.clpNet === 5_000_000)).toBe(true);
  });
});
