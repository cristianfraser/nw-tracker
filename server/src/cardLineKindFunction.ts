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
