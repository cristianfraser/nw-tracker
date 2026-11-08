import { db } from "../db.js";
import { movementFlowId } from "../flows/flowIdentity.js";
import { keyTarget, targetParams } from "../flows/flowKeyedAssignments.js";
import { EXPENSE_DEPOSIT_LINKS_SQL } from "../flows/flowLinks.js";
import { putFlowCategory } from "../flows/flowCategories.js";
import { expenseKeySql } from "../expenseKeys.js";
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

/** A deposit link as `expense_deposit_links` held it (now a `funded_deposit` flow link, migration 285). */
export type FixtureDepositLink = {
  account_id: number;
  purchase_key: string;
  deposit_movement_id: number;
  payment_clp: number;
  amortization_clp: number;
  link_source: "auto" | "manual" | "synthetic";
  depto_cuota?: string | null;
  depto_occurred_on?: string | null;
};

/** Writes a deposit link: the purchase's flow (the key must name a row) → the deposit movement's flow. */
export function insertDepositLink(link: FixtureDepositLink): void {
  const at = keyTarget(link.purchase_key, true);
  db.prepare(
    `INSERT INTO flow_links (flow_id, portion, piece_seq, kind, counterpart_flow_id, account_id, payment_clp,
       amortization_clp, depto_cuota, depto_occurred_on, link_source)
     VALUES (?, ?, ?, 'funded_deposit', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ...targetParams(at),
    movementFlowId(link.deposit_movement_id),
    link.account_id,
    link.payment_clp,
    link.amortization_clp,
    link.depto_cuota ?? null,
    link.depto_occurred_on ?? null,
    link.link_source
  );
}

/** The deposit links in their old shape, filtered by `where` over those columns. */
export function selectDepositLinks(where: string, ...params: unknown[]): (FixtureDepositLink & { created_at: string })[] {
  return db
    .prepare(`SELECT * FROM ${EXPENSE_DEPOSIT_LINKS_SQL} WHERE ${where} ORDER BY link_order`)
    .all(...params) as (FixtureDepositLink & { created_at: string })[];
}

/** Deletes the deposit links `where` selects (over the old columns). */
export function deleteDepositLinks(where: string, ...params: unknown[]): void {
  db.prepare(
    `DELETE FROM flow_links WHERE kind = 'funded_deposit'
       AND rowid IN (SELECT link_order FROM ${EXPENSE_DEPOSIT_LINKS_SQL} WHERE ${where})`
  ).run(...params);
}

/**
 * The «Único» rows (migration 289) with their row id, for a test's cleanup: `rid`, `purchase_key`,
 * `account_id`, `category_id`.
 */
export const FLOW_CATEGORY_ROWS_SQL = `(
  SELECT a.rowid AS rid, ${expenseKeySql("f.legacy_key", "a.portion", "NULLIF(a.piece_seq, -1)")} AS purchase_key,
         a.account_id, a.category_id
  FROM flow_categories a JOIN flows f ON f.id = a.flow_id
)`;

/** Writes an «Único» row as the old table's insert did (the key must name a row). */
export const uniqueCategoryInsert = {
  run: (accountId: number, purchaseKey: string, categoryId: number | null): void => {
    putFlowCategory(accountId, purchaseKey, categoryId, "replace");
  },
};
