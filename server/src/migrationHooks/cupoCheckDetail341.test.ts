import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const migration341 = fs.readFileSync(
  path.join(here, "..", "..", "migrations", "341_cc_bank_cupo_check_detail_foreign.sql"),
  "utf8"
);

function runMigration(dbi: Database.Database): void {
  // The loader's own split (`db.ts`): comments dropped, statements on `;`.
  const sql = migration341.replace(/--[^\n]*/g, "");
  for (const stmt of sql.split(";").map((s) => s.trim()).filter(Boolean)) dbi.exec(stmt);
}

describe("migration 341 — stored cupo-check details keep the foreign side per currency", () => {
  it("moves a legacy `owed.usd` entry under `owed.foreign.usd` and leaves the other rows alone", () => {
    const dbi = new Database(":memory:");
    dbi.exec(`CREATE TABLE cc_bank_cupo_checks (id INTEGER PRIMARY KEY, detail TEXT NOT NULL)`);
    const clp = { facturado: 1000, installment_remainder: 200, remaining_cuotas: 2, open_cycle_lines: 30, total: 1230 };
    const usd = { facturado: 12.5, open_cycle_lines: 3.25, total: 15.75 };
    const base = { account_id: 7, last_closed_billing_month: "2030-01", close_iso: "2030-01-24", clp };
    const ins = dbi.prepare(`INSERT INTO cc_bank_cupo_checks (id, detail) VALUES (?, ?)`);
    ins.run(1, JSON.stringify({ reason: null, owed: { ...base, usd } }));
    ins.run(2, JSON.stringify({ reason: null, owed: { ...base, foreign: { usd, eur: { facturado: 1, open_cycle_lines: 0, total: 1 } } } }));
    ins.run(3, JSON.stringify({ reason: "not comparable", owed: null }));

    runMigration(dbi);
    runMigration(dbi); // a second run changes nothing

    const detail = (id: number) =>
      JSON.parse((dbi.prepare(`SELECT detail FROM cc_bank_cupo_checks WHERE id = ?`).get(id) as { detail: string }).detail);
    expect(detail(1)).toEqual({ reason: null, owed: { ...base, foreign: { usd } } });
    expect(detail(2)).toEqual({
      reason: null,
      owed: { ...base, foreign: { usd, eur: { facturado: 1, open_cycle_lines: 0, total: 1 } } },
    });
    expect(detail(3)).toEqual({ reason: "not comparable", owed: null });
  });
});
