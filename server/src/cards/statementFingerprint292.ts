/**
 * Migration 292: every stored card statement's `import_fingerprint` re-derived from its stored
 * columns and lines (`cards/statementStorage.ts`, the import's own definition). A statement whose
 * import skipped a line (a duplicate of a line already on file) hashes differently from what its
 * next send states and re-imports once; every other statement's next send reads unchanged.
 */
import type { Database } from "better-sqlite3";
import { storedStatementFingerprint } from "./statementStorage.js";

export function runCardStatementFingerprint292(dbi: Database): void {
  const statements = dbi
    .prepare(
      `SELECT id, card_group, period_from, period_to, pay_by, card_last4, card_product, layout, currency,
              saldo_anterior, abono, compras_cargos, deuda_total, monto_facturado, monto_pagado_anterior,
              monto_pagado_anterior_date, next_period_from, next_period_to
       FROM cc_statements`
    )
    .all() as ({ id: number } & Record<string, unknown>)[];
  const lines = dbi.prepare(
    `SELECT transaction_date, posting_date, place, merchant, description_merged, country, amount_orig,
            amount_clp, amount_usd, installment_flag, nro_cuota_current, nro_cuota_total, valor_cuota_mensual_clp,
            interest_rate_text, tipo_cuota, parser_row_id, raw_line, origin_card_last4
     FROM cc_statement_lines WHERE statement_id = ?`
  );
  const update = dbi.prepare(`UPDATE cc_statements SET import_fingerprint = ? WHERE id = ?`);
  for (const st of statements) {
    const rows = lines.all(st.id) as Record<string, unknown>[];
    update.run(storedStatementFingerprint(st as never, rows as never), st.id);
  }
  console.log(`migration 292: ${statements.length} card statement fingerprint(s) re-derived from their stored lines`);
}
