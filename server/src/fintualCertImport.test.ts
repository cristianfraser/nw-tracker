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
    expect(res.divergent).toHaveLength(0);

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

  it("never touches curated rows: adds only the genuinely missing ones", () => {
    cleanupCertData();
    // First cert has one deposit.
    writeCsv(["10/01/2025,1164983,Reserva,5000000,0,100,0,Transferencia electronica,50000"]);
    importFintualCertificado({ maxMonth: "2099-12", apply: true });

    const reservaId = certAccountId("import:fintual|cert|key=reserva2")!;
    const curatedId = (db.prepare("SELECT id FROM movements WHERE account_id = ?").get(reservaId) as { id: number }).id;
    // The user edits the curated amount (correcting the cert).
    db.prepare("UPDATE movements SET amount_clp = 5100000 WHERE id = ?").run(curatedId);

    // A newer cert adds a second deposit and still lists the original (unedited) amount.
    writeCsv([
      "10/01/2025,1164983,Reserva,5000000,0,100,0,Transferencia electronica,50000",
      "20/02/2025,1164983,Reserva,3000000,0,60,0,Transferencia electronica,50000",
    ]);
    const res = importFintualCertificado({ maxMonth: "2099-12", apply: true });

    // The edited curated row is reported as divergent and left untouched.
    expect(res.divergent.some((d) => d.amountClp === 5100000)).toBe(true);
    const edited = db.prepare("SELECT amount_clp FROM movements WHERE id = ?").get(curatedId) as { amount_clp: number };
    expect(edited.amount_clp).toBe(5100000);

    // The genuinely new Feb deposit was added.
    const febRows = db
      .prepare("SELECT COUNT(*) c FROM movements WHERE account_id = ? AND occurred_on = '2025-02-20'")
      .get(reservaId) as { c: number };
    expect(febRows.c).toBe(1);
  });
});
