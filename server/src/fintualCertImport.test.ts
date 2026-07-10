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

  it("report-only never writes: no accounts or movements created", () => {
    cleanupCertData();
    writeCsv(["10/01/2025,1164983,Reserva,5000000,0,100,0,Transferencia electronica,50000"]);

    const res = importFintualCertificado({ maxMonth: "2099-12" });
    expect(res.applied).toBe(false);
    expect(res.missing).toHaveLength(1);
    // Nothing was persisted — the report rolls back its account-ensure.
    expect(certAccountId("import:fintual|cert|key=reserva2")).toBeUndefined();
  });

  it("apply adds missing rows, writing state bonus to the column and leaving personal NULL", () => {
    cleanupCertData();
    writeCsv([
      "10/01/2025,1164983,Reserva,5000000,0,100,0,Transferencia electronica,50000",
      "15/03/2025,16749,mega caca APV-A,400000,0,10,0,Deposito CL,40000",
    ]);

    const res = importFintualCertificado({ maxMonth: "2099-12", apply: true });
    expect(res.applied).toBe(true);
    expect(res.missing).toHaveLength(2);
    expect(res.dbOnly).toHaveLength(0);

    const reservaRows = db
      .prepare("SELECT flow_kind, note FROM movements WHERE account_id = ?")
      .all(certAccountId("import:fintual|cert|key=reserva2")!) as { flow_kind: string | null; note: string }[];
    expect(reservaRows).toHaveLength(1);
    expect(reservaRows[0].flow_kind).toBeNull();
    expect(reservaRows[0].note).not.toContain("flow_kind=");

    const apvRows = db
      .prepare("SELECT flow_kind FROM movements WHERE account_id = ?")
      .all(certAccountId("import:fintual|cert|key=apv_a")!) as { flow_kind: string | null }[];
    expect(apvRows).toHaveLength(1);
    expect(apvRows[0].flow_kind).toBe("aporte_estatal_clp");
  });

  it("is idempotent and non-destructive: re-apply matches existing, adds nothing, deletes nothing", () => {
    cleanupCertData();
    writeCsv(["10/01/2025,1164983,Reserva,5000000,0,100,0,Transferencia electronica,50000"]);

    const first = importFintualCertificado({ maxMonth: "2099-12", apply: true });
    expect(first.missing).toHaveLength(1);
    expect(first.matched).toBe(0);

    const reservaId = certAccountId("import:fintual|cert|key=reserva2")!;
    const firstId = (db.prepare("SELECT id FROM movements WHERE account_id = ?").get(reservaId) as { id: number }).id;

    const second = importFintualCertificado({ maxMonth: "2099-12", apply: true });
    expect(second.matched).toBe(1);
    expect(second.missing).toHaveLength(0);

    const rows = db.prepare("SELECT id FROM movements WHERE account_id = ?").all(reservaId) as { id: number }[];
    // Same single row, same id — nothing deleted or re-inserted.
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(firstId);
  });

  it("matches mirror-merge/manual transfer legs (outflow-day skew) so covered flows are not re-added", () => {
    cleanupCertData();
    writeCsv([
      // Deposit settled 09/01 — DB records it as a transfer dated the checking-outflow day (06/01).
      "09/01/2025,1164983,Reserva,5000000,0,100,0,Transferencia electronica,50000",
      // Rescate settled 20/02 — DB records it as a fund→checking transfer dated 21/02.
      "20/02/2025,1164983,Reserva,0,2000000,0,40,Transferencia electronica,50000",
    ]);
    // Ensure the account exists, then curate the two flows as transfer legs.
    importFintualCertificado({ maxMonth: "2099-12", apply: true });
    const reservaId = certAccountId("import:fintual|cert|key=reserva2")!;
    db.prepare("DELETE FROM movements WHERE account_id = ?").run(reservaId);
    const counterpartId = (
      db.prepare("SELECT id FROM accounts WHERE id != ? ORDER BY id LIMIT 1").get(reservaId) as { id: number }
    ).id;
    db.prepare(
      "INSERT INTO movements (account_id, from_account_id, to_account_id, amount_clp, occurred_on, note, units_delta) VALUES (NULL, ?, ?, 5000000, '2025-01-06', 'mirror-merge|test', 100)"
    ).run(counterpartId, reservaId);
    db.prepare(
      "INSERT INTO movements (account_id, from_account_id, to_account_id, amount_clp, occurred_on, note, units_delta) VALUES (NULL, ?, ?, 2000000, '2025-02-21', 'manual rescate', 40)"
    ).run(reservaId, counterpartId);

    const res = importFintualCertificado({ maxMonth: "2099-12" });
    expect(res.matched).toBe(2);
    expect(res.missing).toHaveLength(0);
    expect(res.dbOnly).toHaveLength(0);

    // Cleanup the transfer legs (cleanupCertData only removes account_id rows).
    db.prepare("DELETE FROM movements WHERE from_account_id = ? OR to_account_id = ?").run(reservaId, reservaId);
  });

  it("never touches curated rows: an edited amount is reported, not overwritten", () => {
    cleanupCertData();
    writeCsv(["10/01/2025,1164983,Reserva,5000000,0,100,0,Transferencia electronica,50000"]);
    importFintualCertificado({ maxMonth: "2099-12", apply: true });

    const reservaId = certAccountId("import:fintual|cert|key=reserva2")!;
    const curatedId = (db.prepare("SELECT id FROM movements WHERE account_id = ?").get(reservaId) as { id: number }).id;
    // The user edits the curated amount (correcting the cert).
    db.prepare("UPDATE movements SET amount_clp = 5100000 WHERE id = ?").run(curatedId);

    // Report-only: both sides of the disagreement are surfaced, nothing is written.
    const res = importFintualCertificado({ maxMonth: "2099-12" });
    expect(res.missing.some((m) => m.amountClp === 5000000)).toBe(true);
    expect(res.dbOnly.some((d) => d.amountClp === 5100000)).toBe(true);
    const edited = db.prepare("SELECT amount_clp FROM movements WHERE id = ?").get(curatedId) as { amount_clp: number };
    expect(edited.amount_clp).toBe(5100000);
  });
});
