import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db.js";
import { importCcStatementsWipeAndReload } from "../ccStatementsImport.js";
import { parsedStatements } from "../test/parsedStatementRecords.js";
import { VITEST_SANTANDER_CC_MASTER_NOTES } from "../test/vitestDbSeed.js";

const PREFIX = "vitest-refund-link";

function fixtureAccountId(): number {
  const row = db.prepare(`SELECT id FROM accounts WHERE notes = ?`).get(VITEST_SANTANDER_CC_MASTER_NOTES) as { id: number } | undefined;
  if (!row) throw new Error("vitest CC fixture master missing (vitestDbSeed)");
  return row.id;
}

function record(rowId: string, merchant: string, amountClp: number) {
  return {
    card_group: "santander",
    source_pdf: `${PREFIX}.pdf`,
    statement_date: "20/01/2025",
    period_from: "2024-12-21",
    period_to: "2025-01-20",
    card_last4: "",
    parser_layout: "compact",
    installment_flag: "false",
    amount_clp: String(amountClp),
    merchant,
    transaction_date: "02/01/2025",
    posting_date: "05/01/2025",
    row_id: rowId,
    dedupe_key: `${PREFIX}-${rowId}`,
    raw_line: `02/01/2025 ${merchant} $${amountClp}`,
    description_merged: merchant,
  };
}

/** The flow each of the fixture card's lines carries, by merchant. */
function lineFlows(accountId: number): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT l.merchant, l.flow_id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ?`
    )
    .all(accountId) as { merchant: string; flow_id: number }[];
  return new Map(rows.map((r) => [r.merchant, r.flow_id]));
}

/** The fixture card's statements and lines; the flows this file's links kept alive go with them. */
function cleanup(accountId: number): void {
  const linked = db.prepare(`SELECT flow_id AS a, purchase_flow_id AS b FROM card_refund_links`).all() as { a: number; b: number }[];
  const ours = new Set(lineFlowsBeforeCleanup(accountId));
  db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id IN (SELECT id FROM cc_statements WHERE account_id = ?)`).run(accountId);
  db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(accountId);
  for (const { a, b } of linked) {
    if (ours.has(a) || ours.has(b)) db.prepare(`DELETE FROM flows WHERE id IN (?, ?)`).run(a, b);
  }
}

function lineFlowsBeforeCleanup(accountId: number): number[] {
  return [...lineFlows(accountId).values()];
}

describe("a card refund link through a statement re-import", () => {
  let accountId = 0;
  beforeAll(() => {
    accountId = fixtureAccountId();
    cleanup(accountId);
  });
  afterAll(() => cleanup(accountId));

  it("holds both flows, so the re-imported lines carry the link", () => {
    const purchase = "VITEST REFUND LINK SHOP";
    const credit = "VITEST REFUND LINK CREDIT";
    importCcStatementsWipeAndReload(accountId, parsedStatements([record("p", purchase, 50_000), record("c", credit, -12_000)]));
    const before = lineFlows(accountId);
    db.prepare(`INSERT INTO card_refund_links (flow_id, purchase_flow_id) VALUES (?, ?)`).run(before.get(credit)!, before.get(purchase)!);

    // The same printed lines under new parser row ids: new line rows, the old ones deleted.
    importCcStatementsWipeAndReload(accountId, parsedStatements([record("p2", purchase, 50_000), record("c2", credit, -12_000)]));
    const after = lineFlows(accountId);
    const link = db.prepare(`SELECT purchase_flow_id AS p FROM card_refund_links WHERE flow_id = ?`).get(after.get(credit)!) as
      | { p: number }
      | undefined;
    expect(link?.p).toBe(after.get(purchase));
  });
});
