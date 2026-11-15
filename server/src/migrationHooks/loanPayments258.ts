import type { Database as DatabaseType } from "better-sqlite3";

/**
 * Migration 258 hook: move `depto_payments` into `loan_payments` + `property_appraisals` and drop
 * it. Pure (no `db` import — the module graph is still initializing when it runs).
 *
 * - Every row keeps its movement, origin and cuota; `kind` becomes `leg` ('dividendos' — the
 *   property account's row — → 'property', 'mortgage' → 'loan'). `loan_account_id` is the
 *   mortgage account: the movement's own account on a loan row, the depto mortgage master on a
 *   property row (a property row with no mortgage master throws).
 * - Balance after, min and max payment: the `*_uf` columns, `loan_currency` 'uf'. The parts of
 *   the charge: the `*_clp` columns, `payment_currency` 'clp'. The `*_uf` part columns and the
 *   stored derived figures (amount_uf, valor_neto_*, pagado_neto_uf, pago_acumulado_clp) are not
 *   copied: they are derived when read.
 * - `valor_vivienda_uf` of the property rows → one `property_appraisals` row per (property
 *   account, payment day), in UF. Two rows of one day stating different appraisals throw.
 */
export function runLoanPayments258(dbi: DatabaseType): void {
  const hasOld = dbi
    .prepare(`SELECT 1 AS o FROM sqlite_master WHERE type = 'table' AND name = 'depto_payments'`)
    .get();
  if (!hasOld) return;

  const mortgage = dbi
    .prepare(`SELECT id FROM accounts WHERE import_key = 'import:excel|key=mortgage' ORDER BY id LIMIT 1`)
    .get() as { id: number } | undefined;

  const rows = dbi
    .prepare(
      `SELECT p.*, m.account_id AS movement_account_id, m.occurred_on AS occurred_on
       FROM depto_payments p JOIN movements m ON m.id = p.movement_id
       ORDER BY p.movement_id`
    )
    .all() as Array<{
    movement_id: number;
    kind: "dividendos" | "mortgage";
    origin: string;
    cuota: string;
    credito_restante_uf: number | null;
    valor_vivienda_uf: number | null;
    min_uf: number | null;
    max_uf: number | null;
    amortizacion_clp: number | null;
    amortizacion_ext_clp: number | null;
    interes_clp: number | null;
    incendio_clp: number | null;
    desgravamen_clp: number | null;
    movement_account_id: number | null;
    occurred_on: string;
  }>;
  const total = (dbi.prepare(`SELECT COUNT(*) AS c FROM depto_payments`).get() as { c: number }).c;
  if (total !== rows.length) {
    throw new Error(`migration 258: ${total - rows.length} depto_payments row(s) have no movement`);
  }

  const ins = dbi.prepare(
    `INSERT INTO loan_payments (
       movement_id, loan_account_id, leg, origin, cuota,
       loan_currency, balance_after, min_payment, max_payment,
       payment_currency, principal, extra_principal, interest, insurance_fire, insurance_life
     ) VALUES (?, ?, ?, ?, ?, 'uf', ?, ?, ?, 'clp', ?, ?, ?, ?, ?)`
  );
  const appraisals = new Map<string, { account_id: number; as_of_date: string; value: number }>();
  for (const r of rows) {
    const leg = r.kind === "mortgage" ? "loan" : "property";
    const loanAccountId = leg === "loan" ? r.movement_account_id : (mortgage?.id ?? null);
    if (loanAccountId == null) {
      throw new Error(
        `migration 258: depto_payments row ${r.movement_id} (${r.kind}, cuota ${r.cuota}) has no mortgage account`
      );
    }
    ins.run(
      r.movement_id,
      loanAccountId,
      leg,
      r.origin,
      r.cuota,
      r.credito_restante_uf,
      r.min_uf,
      r.max_uf,
      r.amortizacion_clp,
      r.amortizacion_ext_clp,
      r.interes_clp,
      r.incendio_clp,
      r.desgravamen_clp
    );
    if (leg === "property" && r.valor_vivienda_uf != null && r.movement_account_id != null) {
      const key = `${r.movement_account_id}|${r.occurred_on}`;
      const prev = appraisals.get(key);
      if (prev && prev.value !== r.valor_vivienda_uf) {
        throw new Error(
          `migration 258: two appraisals on ${r.occurred_on} for account ${r.movement_account_id}: ${prev.value} vs ${r.valor_vivienda_uf}`
        );
      }
      appraisals.set(key, { account_id: r.movement_account_id, as_of_date: r.occurred_on, value: r.valor_vivienda_uf });
    }
  }
  const insA = dbi.prepare(
    `INSERT INTO property_appraisals (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'uf')`
  );
  for (const a of appraisals.values()) insA.run(a.account_id, a.as_of_date, a.value);

  dbi.exec(`DROP TABLE depto_payments`);
}
