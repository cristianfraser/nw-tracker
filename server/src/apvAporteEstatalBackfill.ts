import path from "node:path";
import { db } from "./db.js";
import { numCsv, readSemicolonCsv } from "./cfraserCsv.js";

/** mega caca = the Fintual APV-A account (régimen A, which receives the yearly state match). */
const MEGA_CACA_NOTES = "import:fintual|cert|key=apv_a";

function yearFromMonthLabel(label: string): number | null {
  const m = label.trim().match(/[A-Za-z]{3,}\s+(\d{2})$/);
  return m ? 2000 + Number(m[1]) : null;
}

/**
 * Tag the APV-A "aporte estatal" deposits — the yearly ~15% state match, read from
 * `cfraser/net worth-retiro.csv` column "aporte estado" — with `flow_kind=aporte_estatal_clp` so the
 * deposits reconciliation excludes them (state money, never funded by a checking outflow). The
 * Fintual certificate can't distinguish them from personal deposits (both arrive as medio
 * "Transferencia electronica"), so we cross-reference the ledger here.
 *
 * Matched by exact amount *within the match's year* (December matches are credited in early January,
 * so the window runs through Q1 of the next year). The year guard is essential: e.g. 295.050 is both
 * a 2021 state match and an unrelated 2019 personal deposit — only the in-year one is tagged.
 * Idempotent (only rewrites deposit_clp notes); call after the Fintual certificate import.
 */
export function backfillApvAporteEstatal(cfraserDir: string): number {
  const account = db.prepare(`SELECT id FROM accounts WHERE notes = ?`).get(MEGA_CACA_NOTES) as
    | { id: number }
    | undefined;
  if (!account) return 0;

  let rows: string[][];
  try {
    rows = readSemicolonCsv(path.join(cfraserDir, "net worth-retiro.csv"));
  } catch {
    return 0;
  }

  const findDep = db.prepare(
    `SELECT id FROM movements
     WHERE account_id = ? AND amount_clp = ? AND occurred_on BETWEEN ? AND ?
       AND note LIKE '%flow_kind=deposit_clp%'
     ORDER BY occurred_on LIMIT 1`
  );
  const upd = db.prepare(
    `UPDATE movements SET note = REPLACE(note, 'flow_kind=deposit_clp', 'flow_kind=aporte_estatal_clp')
     WHERE id = ?`
  );

  let tagged = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const year = yearFromMonthLabel(row[0] ?? "");
      const amount = numCsv(row[8]); // col 9 (1-indexed) = "aporte estado"
      if (year == null || amount == null || amount <= 0) continue;
      const dep = findDep.get(account.id, Math.round(amount), `${year}-01-01`, `${year + 1}-03-31`) as
        | { id: number }
        | undefined;
      if (dep) {
        upd.run(dep.id);
        tagged += 1;
      }
    }
  });
  tx();
  return tagged;
}
