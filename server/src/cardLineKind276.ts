import { cardLineKind } from "nw-tracker-contracts";
import type { Database as DatabaseType } from "better-sqlite3";

/**
 * `cc_line_kind(installment_flag, merchant, amount_clp, amount_usd, statement_currency)`: the one
 * card-line classifier (`cards/lineKinds.ts`) as an SQL function, registered on every connection
 * `db.ts` opens. The triggers of migration 276 call it, so a line written by any path — the
 * importer sets the kind itself, a script or a test fixture does not — carries its kind, and an
 * update of the fields it reads re-decides it. A connection without the function (the sqlite3 CLI)
 * cannot write card lines: the trigger fails, which is the point.
 */
export function registerCardLineKindFunction(dbi: DatabaseType): void {
  dbi.function(
    "cc_line_kind",
    { deterministic: true },
    (flag: unknown, merchant: unknown, clp: unknown, usd: unknown, currency: unknown) =>
      cardLineKind({
        installment_flag: Number(flag ?? 0),
        merchant: merchant == null ? null : String(merchant),
        amount_clp: clp == null ? null : Number(clp),
        amount_usd: usd == null ? null : Number(usd),
        statement_currency: String(currency ?? ""),
      })
  );
  // Migration 319: a line stores its amount in its own currency. The same classifier, fed what the
  // two legacy slots read for it (a dollar line: 0 pesos and its dollars; any other: its amount as
  // the peso slot, which only decides the sign and the peso section-3 rule).
  dbi.function(
    "cc_line_kind_native",
    { deterministic: true },
    (flag: unknown, merchant: unknown, amount: unknown, lineCurrency: unknown, currency: unknown) => {
      const amt = amount == null ? null : Number(amount);
      const usd = String(lineCurrency ?? "") === "usd";
      return cardLineKind({
        installment_flag: Number(flag ?? 0),
        merchant: merchant == null ? null : String(merchant),
        amount_clp: usd ? 0 : amt,
        amount_usd: usd ? amt : null,
        statement_currency: String(currency ?? ""),
      });
    }
  );
}

const KIND_EXPR = `cc_line_kind(NEW.installment_flag, NEW.merchant, NEW.amount_clp, NEW.amount_usd,
  (SELECT currency FROM cc_statements WHERE id = NEW.statement_id))`;

/**
 * Migration 276 hook: the two triggers that keep a line's kind (a line written without one gets
 * it; a change of its flag, merchant or amounts re-decides it), then every line on file gets its
 * kind from the classifier. It reports the count per kind (no amounts).
 */
export function runCardLineKind276(dbi: DatabaseType): void {
  dbi.exec(`
    CREATE TRIGGER IF NOT EXISTS cc_statement_lines_kind_ai
    AFTER INSERT ON cc_statement_lines WHEN NEW.kind IS NULL
    BEGIN
      UPDATE cc_statement_lines SET kind = ${KIND_EXPR} WHERE id = NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS cc_statement_lines_kind_au
    AFTER UPDATE OF installment_flag, merchant, amount_clp, amount_usd ON cc_statement_lines
    BEGIN
      UPDATE cc_statement_lines SET kind = ${KIND_EXPR} WHERE id = NEW.id;
    END;
  `);
  dbi.exec(`UPDATE cc_statement_lines SET kind = cc_line_kind(installment_flag, merchant, amount_clp, amount_usd,
    (SELECT currency FROM cc_statements s WHERE s.id = cc_statement_lines.statement_id))`);
  const orphans = dbi.prepare(`SELECT COUNT(*) AS c FROM cc_statement_lines WHERE kind IS NULL`).get() as { c: number };
  if (orphans.c > 0) throw new Error(`migration 276: ${orphans.c} card line(s) without a kind`);
  const counts = dbi
    .prepare(`SELECT kind, COUNT(*) AS c FROM cc_statement_lines GROUP BY kind ORDER BY kind`)
    .all() as { kind: string; c: number }[];
  console.log(`migration 276 card line kind: ${JSON.stringify(Object.fromEntries(counts.map((r) => [r.kind, r.c])))}`);
}
