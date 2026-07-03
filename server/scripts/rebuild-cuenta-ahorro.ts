/**
 * Rebuild ONLY the cuenta de ahorro para la vivienda (BancoEstado) movements + valuations from
 * `net worth-cash and cash equivalents.csv` + the optional forensic `cfraser/cuenta-ahorro-deposits.csv`.
 *
 * Unlike `import:excel --force-wipe`, this touches nothing else — no other accounts, no Buda ledger,
 * no mirrors/splits, no aporte-estatal tags. Use it to apply forensic-file edits (de-aggregation,
 * funding=self/family, dap_proxy) without a full rebuild.
 *
 *   npm run rebuild:cuenta-ahorro -w nw-tracker-server                # apply
 *   npm run rebuild:cuenta-ahorro -w nw-tracker-server -- --dry-run   # report, no writes
 *   IMPORT_MAX_MONTH=2024-12 npm run rebuild:cuenta-ahorro -w nw-tracker-server
 */
import { db } from "../src/db.js";
import { chileCalendarTodayYmd } from "../src/chileDate.js";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";
import { importCuentaAhorroViviendaMovements } from "../src/cuentaAhorroViviendaImport.js";
import type { ExcelMovementInsertStmt, MonthKey } from "../src/cfraserCsv.js";

const AHORRO_ACCOUNT_NOTES = "import:excel|key=cuenta_ahorro_vivienda";

function main() {
  const dryRun = process.argv.includes("--dry-run");

  const acc = db.prepare(`SELECT id FROM accounts WHERE notes = ?`).get(AHORRO_ACCOUNT_NOTES) as
    | { id: number }
    | undefined;
  if (!acc) {
    console.error(
      `rebuild:cuenta-ahorro: account not found (notes = ${AHORRO_ACCOUNT_NOTES}). Run import:excel first.`
    );
    process.exit(1);
  }
  const accountId = acc.id;

  const maxMonth: MonthKey =
    (process.env.IMPORT_MAX_MONTH as MonthKey | undefined) ??
    (chileCalendarTodayYmd().slice(0, 7) as MonthKey);
  const cfraserDir = resolveCfraserCsvDir();

  const before = db
    .prepare(`SELECT COUNT(*) AS c FROM movements WHERE account_id = ?`)
    .get(accountId) as { c: number };

  if (dryRun) {
    console.log(
      `rebuild:cuenta-ahorro DRY RUN — account ${accountId}, ${before.c} existing movement(s), maxMonth ${maxMonth}. No changes.`
    );
    return;
  }

  const upsertVal = db.prepare(`
    INSERT INTO valuations (account_id, as_of_date, value, currency)
    VALUES (@account_id, @as_of_date, @value_clp, 'clp')
    ON CONFLICT(account_id, as_of_date) DO UPDATE SET value = excluded.value, currency = excluded.currency
  `);
  const insMov = db.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta) VALUES (?,?,?,?,?)`
  ) as ExcelMovementInsertStmt;

  // Fail fast: this rebuild owns only the CSV/forensic-imported rows. A manual (or otherwise
  // foreign) movement on the account would be silently destroyed by a blanket delete — refuse.
  const foreign = db
    .prepare(
      `SELECT id, occurred_on, amount_clp, note FROM movements
       WHERE account_id = ?
         AND (note IS NULL OR note NOT LIKE 'import:excel|csv|cash|ahorro-vivienda|%')`
    )
    .all(accountId) as { id: number; occurred_on: string; amount_clp: number; note: string | null }[];
  if (foreign.length > 0) {
    console.error(
      `rebuild:cuenta-ahorro: refusing to rebuild — ${foreign.length} non-import movement(s) on account ${accountId} would be destroyed:`
    );
    for (const f of foreign.slice(0, 10)) {
      console.error(`  mov ${f.id} ${f.occurred_on} ${f.amount_clp} note=${f.note ?? "(null)"}`);
    }
    console.error("Move them to the forensic CSV or delete them explicitly, then re-run.");
    process.exit(1);
  }

  let movN = 0;
  const tx = db.transaction(() => {
    // Scoped strictly to this one account — nothing else is touched.
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(accountId);
    movN = importCuentaAhorroViviendaMovements(cfraserDir, maxMonth, accountId, insMov, upsertVal);
  });
  tx();

  console.log(
    `rebuild:cuenta-ahorro: account ${accountId} rebuilt — ${before.c} → ${movN} movement(s), valuations = cumsum of cols 3–5 (maxMonth ${maxMonth}).`
  );
}

main();
