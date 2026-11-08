import { db } from "../db.js";
import { ensureVitestCreditCardFixtures, getVitestSantanderCcMasterAccountId } from "./vitestDbSeed.js";

/**
 * Rows for tests that hang an assignment (a piece, a big group, a note) off an expense line: an
 * assignment sits on a flow (docs/untangle-flow-identity.md), so the line it names must be on file.
 * Each helper writes the row with the id the test names (the insert trigger gives it its flow) and
 * returns a cleanup that deletes it.
 */

/** A single-leg peso movement `id` on account 1. */
export function fixtureMovement(id: number, amount = -1000, occurredOn = "2021-11-22"): () => void {
  db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  db.prepare(`INSERT INTO movements (id, account_id, amount, currency, occurred_on, note) VALUES (?, 1, ?, 'clp', ?, 'vitest fixture')`).run(
    id,
    amount,
    occurredOn
  );
  return () => {
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  };
}

/** A one-shot card line `id` on the vitest card master (its own statement). */
export function fixtureCardLine(id: number, amountClp = 1000): () => void {
  ensureVitestCreditCardFixtures();
  const accountId = getVitestSantanderCcMasterAccountId()!;
  db.prepare(`DELETE FROM cc_statement_lines WHERE id = ?`).run(id);
  const statementId = Number(
    db
      .prepare(
        `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, layout, currency)
         VALUES (?, 'A', ?, '24/09/2026', 'compact', 'clp')`
      )
      .run(accountId, `vitest fixture line ${id}.pdf`).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO cc_statement_lines (id, statement_id, transaction_date, merchant, amount_clp, installment_flag, dedupe_key)
     VALUES (?, ?, '03/09/2026', 'VITEST FIXTURE LINE', ?, 0, ?)`
  ).run(id, statementId, amountClp, `vitest-fixture-${id}`);
  return () => {
    db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(statementId);
  };
}
