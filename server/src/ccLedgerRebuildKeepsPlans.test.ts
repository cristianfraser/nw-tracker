/**
 * `import:cc-parsed --replace-ledger` keeps each plan the statements still state as the row it is
 * (id, flow, arrival, note, prepayment), and refuses to drop a plan something names by id.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { replaceStatementLines } from "./cards/lineWrites.js";
import { mergeInstallmentLedgerFromStatements, statementKeysOf } from "./ccInstallmentLedgerMerge.js";
import { parsedStatements, type ParsedRecord } from "./test/parsedStatementRecords.js";
import { snapshotTables } from "./test/snapshotTables.js";
import { createTempCardMaster, deleteTempCardMaster } from "./test/tempCardMaster.js";
import { flowArrival } from "./flows/flowFirstSeen.js";

const restoreDerived = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_metrics"]);
afterAll(() => restoreDerived());

describe("a ledger rebuild", () => {
  let card = 0;
  beforeEach(() => {
    card = createTempCardMaster({ issuer: "santander", last4: "6666", key: "vitest-ledger-rebuild" });
  });
  afterEach(() => {
    deleteTempCardMaster(card);
    db.prepare(`DELETE FROM flows WHERE from_account_id = ? OR to_account_id = ?`).run(card, card);
    restoreDerived();
    clearAggregationCache();
  });

  const cuotaRow = (tag: string, merchant: string, day: string, total: number): ParsedRecord => ({
    card_group: "santander",
    source_pdf: `vitest-rebuild-${tag}-2026-05-22.pdf`,
    statement_date: "22/05/2026",
    period_from: "23/04/2026",
    period_to: "22/05/2026",
    card_last4: "6666",
    parser_layout: "compact",
    row_id: `vitest-rebuild-${tag}`,
    canonical_row_id: `vitest-rebuild-${tag}-plan`,
    dedupe_key: `vitest-rebuild-${tag}`,
    transaction_date: day,
    merchant,
    amount_clp: String(total / 6),
    raw_line: `${day} ${merchant} ${total / 6}`,
    installment_flag: "true",
    nro_cuota_current: "1",
    nro_cuota_total: "6",
    valor_cuota_mensual_clp: String(total / 6),
    monto_total_a_pagar_clp: String(total),
  });
  const importStatements = (records: ParsedRecord[]) => {
    const statements = parsedStatements(records);
    replaceStatementLines(card, statements, { replaceStatementKeys: statementKeysOf(statements) });
    return statements;
  };
  const planId = (merchant: string) =>
    (db.prepare(`SELECT id FROM cc_installment_purchases WHERE account_id = ? AND merchant = ?`).get(card, merchant) as { id: number } | undefined)?.id;
  const planFlow = (id: number) => (db.prepare(`SELECT flow_id FROM cc_installment_purchases WHERE id = ?`).get(id) as { flow_id: number }).flow_id;

  it("keeps a plan the statements still state: its id, flow, arrival, note and prepayment", () => {
    const merchant = "VITEST REBUILD ONE";
    const statements = importStatements([cuotaRow("one", merchant, "05/05/26", 60_000)]);
    const id = planId(merchant)!;
    const flow = planFlow(id);
    db.prepare(`DELETE FROM flow_first_seen WHERE flow_id = ?`).run(flow);
    db.prepare(`INSERT INTO flow_first_seen (flow_id, first_seen_on, first_seen_at, first_seen_seq) VALUES (?, '2026-05-06', NULL, NULL)`).run(flow);
    db.prepare(`INSERT INTO flow_notes (flow_id, portion, piece_seq, account_id, notes, updated_at) VALUES (?, 'gastos', -1, ?, 'filed on the plan', datetime('now'))`).run(flow, card);
    db.prepare(`INSERT INTO cc_plan_prepayments (purchase_id, account_id, paid_on, amount_clp) VALUES (?, ?, '2026-05-20', 60000)`).run(id, card);

    mergeInstallmentLedgerFromStatements(card, statements, { replaceLedger: true });

    expect(planId(merchant)).toBe(id);
    expect(planFlow(id)).toBe(flow);
    expect(flowArrival(flow)).toEqual({ kind: "stamped", stamp: expect.objectContaining({ on: "2026-05-06" }) });
    expect((db.prepare(`SELECT notes FROM flow_notes WHERE flow_id = ?`).get(flow) as { notes: string }).notes).toBe("filed on the plan");
    expect(db.prepare(`SELECT 1 FROM cc_plan_prepayments WHERE purchase_id = ?`).get(id)).toBeDefined();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM cc_installment_payments WHERE purchase_id = ?`).get(id)).toEqual({ n: 1 });
  });

  it("drops a plan no statement states any more, and refuses when something names it by id", () => {
    const keep = importStatements([cuotaRow("keep", "VITEST REBUILD KEEP", "06/05/26", 60_000)]);
    const gone = "VITEST REBUILD GONE";
    importStatements([cuotaRow("gone", gone, "07/05/26", 90_000)]);
    const goneId = planId(gone)!;
    db.prepare(`INSERT INTO cc_plan_prepayments (purchase_id, account_id, paid_on, amount_clp) VALUES (?, ?, '2026-05-20', 90000)`).run(goneId, card);

    expect(() => mergeInstallmentLedgerFromStatements(card, keep, { replaceLedger: true })).toThrow(
      new RegExp(`plan ${goneId} .*cc_plan_prepayments`)
    );
    expect(planId(gone)).toBe(goneId);

    db.prepare(`DELETE FROM cc_plan_prepayments WHERE purchase_id = ?`).run(goneId);
    mergeInstallmentLedgerFromStatements(card, keep, { replaceLedger: true });
    expect(planId(gone)).toBeUndefined();
    expect(planId("VITEST REBUILD KEEP")).toBeDefined();
  });
});
