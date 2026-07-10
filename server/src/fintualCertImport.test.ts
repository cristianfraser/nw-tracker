import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { importFintualCertificado } from "./fintualCertImport.js";
import { FINTUAL_CERT_V2_ACCOUNT_NAMES } from "./fintualCertV2.js";

const CERT_NOTES = Object.keys(FINTUAL_CERT_V2_ACCOUNT_NAMES);

function certAccountId(notes: string): number | undefined {
  return (db.prepare("SELECT id FROM accounts WHERE notes = ?").get(notes) as { id: number } | undefined)?.id;
}

function cleanupCertData(): void {
  for (const notes of CERT_NOTES) {
    const id = certAccountId(notes);
    if (id == null) continue;
    db.prepare("DELETE FROM movements WHERE account_id = ?").run(id);
    db.prepare("DELETE FROM account_sync_sources WHERE account_id = ?").run(id);
    db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  }
}

describe("importFintualCertificado", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    delete process.env.FINTUAL_CERTIFICADO_CSV;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
    cleanupCertData();
  });

  function writeCsv(lines: string[]): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fintual-cert-import-"));
    const csvPath = path.join(tmpDir, "certificado.csv");
    fs.writeFileSync(
      csvPath,
      [
        "fecha,id_inversión,nombre_inversión,aporte_pesos_chilenos,rescate_pesos_chilenos,aporte_cuotas,rescate_cuotas,medio,valor_cuota",
        ...lines,
      ].join("\n"),
      "utf8"
    );
    process.env.FINTUAL_CERTIFICADO_CSV = csvPath;
    return csvPath;
  }

  it("writes state bonus to the flow_kind column, personal deposits stay null, no flow_kind note tag", () => {
    cleanupCertData();
    writeCsv([
      // reserva2 personal deposit
      "10/01/2025,1164983,Reserva,5000000,0,100,0,Transferencia electronica,50000",
      // apv_a state bonus (medio "Deposito CL" classifies as aporte_estatal_clp)
      "15/03/2025,16749,mega caca APV-A,400000,0,10,0,Deposito CL,40000",
      // apv_a personal deposit
      "20/03/2025,16749,mega caca APV-A,900000,0,20,0,Transferencia electronica,45000",
    ]);

    const res = importFintualCertificado({ maxMonth: "2099-12" });
    expect(res.movementsInserted).toBe(3);
    expect(res.accounts).toBe(4);

    const reservaId = certAccountId("import:fintual|cert|key=reserva2")!;
    const apvAId = certAccountId("import:fintual|cert|key=apv_a")!;

    const reservaRows = db
      .prepare("SELECT amount_clp, flow_kind, note FROM movements WHERE account_id = ?")
      .all(reservaId) as { amount_clp: number; flow_kind: string | null; note: string }[];
    expect(reservaRows).toHaveLength(1);
    expect(reservaRows[0].flow_kind).toBeNull();
    expect(reservaRows[0].note).not.toContain("flow_kind=");
    expect(reservaRows[0].note).toContain("|medio=");

    const apvRows = db
      .prepare("SELECT amount_clp, flow_kind, note FROM movements WHERE account_id = ? ORDER BY occurred_on")
      .all(apvAId) as { amount_clp: number; flow_kind: string | null; note: string }[];
    expect(apvRows).toHaveLength(2);
    const stateRow = apvRows.find((r) => r.flow_kind === "aporte_estatal_clp");
    const personalRow = apvRows.find((r) => r.flow_kind === null);
    expect(stateRow).toBeDefined();
    expect(personalRow).toBeDefined();
    // No movement carries the flow_kind tag in its note anymore.
    expect(apvRows.every((r) => !r.note.includes("flow_kind="))).toBe(true);
  });

  it("is idempotent: re-import delete+rebuilds the same rows", () => {
    cleanupCertData();
    writeCsv(["10/01/2025,1164983,Reserva,5000000,0,100,0,Transferencia electronica,50000"]);

    const first = importFintualCertificado({ maxMonth: "2099-12" });
    expect(first.movementsInserted).toBe(1);
    expect(first.movementsDeleted).toBe(0);

    const second = importFintualCertificado({ maxMonth: "2099-12" });
    expect(second.movementsInserted).toBe(1);
    expect(second.movementsDeleted).toBe(1);

    const reservaId = certAccountId("import:fintual|cert|key=reserva2")!;
    const count = (db.prepare("SELECT COUNT(*) c FROM movements WHERE account_id = ?").get(reservaId) as { c: number }).c;
    expect(count).toBe(1);
  });

  it("preserves an externally-set state-bonus classification across re-import", () => {
    cleanupCertData();
    // Medio "Transferencia electronica" is indistinguishable from a personal deposit, so the
    // certificate alone classifies it as personal (flow_kind NULL).
    writeCsv(["19/11/2025,16749,mega caca APV-A,416684,0,122,0,Transferencia electronica,3403"]);
    importFintualCertificado({ maxMonth: "2099-12" });

    const apvAId = certAccountId("import:fintual|cert|key=apv_a")!;
    const before = db
      .prepare("SELECT id, flow_kind FROM movements WHERE account_id = ?")
      .get(apvAId) as { id: number; flow_kind: string | null };
    expect(before.flow_kind).toBeNull();

    // Tag it as the yearly state match (as the retired aporte-estatal backfill / a manual edit would).
    db.prepare("UPDATE movements SET flow_kind = 'aporte_estatal_clp' WHERE id = ?").run(before.id);

    const res = importFintualCertificado({ maxMonth: "2099-12" });
    expect(res.classificationsPreserved).toBe(1);
    const after = db
      .prepare("SELECT flow_kind FROM movements WHERE account_id = ?")
      .get(apvAId) as { flow_kind: string | null };
    expect(after.flow_kind).toBe("aporte_estatal_clp");
  });

  it("preserves manual (non-cert-movement) rows on cert accounts across re-import", () => {
    cleanupCertData();
    writeCsv(["10/01/2025,1164983,Reserva,5000000,0,100,0,Transferencia electronica,50000"]);
    importFintualCertificado({ maxMonth: "2099-12" });

    const reservaId = certAccountId("import:fintual|cert|key=reserva2")!;
    db.prepare(
      "INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta) VALUES (?, ?, ?, ?, ?)"
    ).run(reservaId, 123456, "2025-02-01", "manual|adjustment", 5);

    importFintualCertificado({ maxMonth: "2099-12" });
    const manual = db
      .prepare("SELECT COUNT(*) c FROM movements WHERE account_id = ? AND note = 'manual|adjustment'")
      .get(reservaId) as { c: number };
    expect(manual.c).toBe(1);
  });
});
