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

  it("a plan stated only by a withheld statement stays, with its cuotas; the rest of the ledger is rebuilt", () => {
    const keep = importStatements([cuotaRow("keep3", "VITEST REBUILD KEEP3", "06/05/26", 60_000)]);
    const held = "VITEST REBUILD WITHHELD";
    importStatements([cuotaRow("withheld", held, "07/05/26", 90_000)]);
    const heldId = planId(held)!;
    const cuotas = () => db.prepare(`SELECT COUNT(*) AS n FROM cc_installment_payments WHERE purchase_id = ?`).get(heldId);
    expect(cuotas()).toEqual({ n: 1 });
    const result = mergeInstallmentLedgerFromStatements(card, keep, {
      replaceLedger: true,
      withheldDocuments: new Set(["vitest-rebuild-withheld-2026-05-22.pdf"]),
    });
    expect(planId(held)).toBe(heldId);
    expect(cuotas()).toEqual({ n: 1 });
    expect(result.stale_plans_retired_with_assignments).toEqual([]);
    // Without it, the plan is no longer stated and goes.
    mergeInstallmentLedgerFromStatements(card, keep, { replaceLedger: true });
    expect(planId(held)).toBeUndefined();
  });

  const stampFlow = (flow: number, on: string) => {
    db.prepare(`DELETE FROM flow_first_seen WHERE flow_id = ?`).run(flow);
    db.prepare(`INSERT INTO flow_first_seen (flow_id, first_seen_on, first_seen_at, first_seen_seq) VALUES (?, ?, NULL, NULL)`).run(flow, on);
  };
  const noteOn = (flow: number, text: string) =>
    db.prepare(`INSERT INTO flow_notes (flow_id, portion, piece_seq, account_id, notes, updated_at) VALUES (?, 'gastos', -1, ?, ?, datetime('now'))`).run(flow, card, text);
  const noteOf = (flow: number) => (db.prepare(`SELECT notes FROM flow_notes WHERE flow_id = ?`).get(flow) as { notes: string } | undefined)?.notes;

  it("a plan whose total moves a peso keeps its row, flow, note and arrival; both days are evidence", () => {
    const merchant = "VITEST REBUILD TOTAL";
    importStatements([cuotaRow("tot", merchant, "05/05/26", 60_000)]);
    const id = planId(merchant)!;
    const flow = planFlow(id);
    stampFlow(flow, "2026-05-06");
    noteOn(flow, "filed on the plan");

    const changed = parsedStatements([cuotaRow("tot", merchant, "05/05/26", 60_006)]);
    const result = mergeInstallmentLedgerFromStatements(card, changed, { replaceLedger: true });

    expect(planId(merchant)).toBe(id);
    expect(planFlow(id)).toBe(flow);
    expect(noteOf(flow)).toBe("filed on the plan");
    expect(flowArrival(flow)).toEqual({ kind: "stamped", stamp: expect.objectContaining({ on: "2026-05-06" }) });
    expect(result.earliestChangedEvidenceDate).toBe("2026-05-05");
  });

  it("a plan the parse no longer states puts its purchase day into the write's evidence", () => {
    const keep = importStatements([cuotaRow("keep2", "VITEST REBUILD KEEP2", "06/05/26", 60_000)]);
    importStatements([cuotaRow("phantom", "VITEST REBUILD PHANTOM", "07/04/26", 90_000)]);
    const result = mergeInstallmentLedgerFromStatements(card, keep, { replaceLedger: true });
    expect(planId("VITEST REBUILD PHANTOM")).toBeUndefined();
    expect(result.earliestChangedEvidenceDate).toBe("2026-04-07");
    expect(result.stale_plans_retired_with_assignments).toEqual([]);
  });

  it("a plan whose identity and canonical row both changed hands its flow, note, arrival and prepayment to its replacement, unstamped", () => {
    const old = cuotaRow("loose", "VITEST REBUILD LOOSE", "05/05/26", 60_000);
    importStatements([old]);
    const oldId = planId("VITEST REBUILD LOOSE")!;
    const oldFlow = planFlow(oldId);
    stampFlow(oldFlow, "2026-05-06");
    noteOn(oldFlow, "filed on the old plan");
    db.prepare(`INSERT INTO cc_plan_prepayments (purchase_id, account_id, paid_on, amount_clp) VALUES (?, ?, '2026-05-20', 60000)`).run(oldId, card);

    // The parser now reads the same purchase with another total and another canonical row id.
    const reread = { ...cuotaRow("loose", "VITEST REBUILD LOOSE", "05/05/26", 60_006), canonical_row_id: "vitest-rebuild-loose-plan-2" };
    const statements = parsedStatements([reread]);
    const result = mergeInstallmentLedgerFromStatements(card, statements, { replaceLedger: true });

    const newId = planId("VITEST REBUILD LOOSE")!;
    expect(newId).not.toBe(oldId);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM cc_installment_purchases WHERE account_id = ?`).get(card)).toEqual({ n: 1 });
    const flow = planFlow(newId);
    expect(noteOf(flow)).toBe("filed on the old plan");
    expect(flowArrival(flow)).toEqual({ kind: "stamped", stamp: expect.objectContaining({ on: "2026-05-06" }) });
    expect(db.prepare(`SELECT 1 FROM cc_plan_prepayments WHERE purchase_id = ?`).get(newId)).toBeDefined();
    expect(result.stale_plans_retired_with_assignments).toEqual([]);
  });

  it("a stale plan with filed work and no replacement is reported", () => {
    const keep = importStatements([cuotaRow("k3", "VITEST REBUILD K3", "06/05/26", 60_000)]);
    importStatements([cuotaRow("g3", "VITEST REBUILD G3", "07/05/26", 90_000)]);
    noteOn(planFlow(planId("VITEST REBUILD G3")!), "filed");
    const result = mergeInstallmentLedgerFromStatements(card, keep, { replaceLedger: true });
    expect(result.stale_plans_retired_with_assignments).toEqual([
      expect.objectContaining({ merchant: "VITEST REBUILD G3", total_amount_clp: 90_000 }),
    ]);
  });

  it("the ordinary merge is unchanged: nothing deleted, restated or stamped; a new plan is stamped and its day noted", () => {
    const statements = importStatements([cuotaRow("n1", "VITEST REBUILD N1", "05/05/26", 60_000)]);
    importStatements([cuotaRow("n2", "VITEST REBUILD N2", "06/05/26", 30_000)]);
    const snapshot = () => ({
      plans: db
        .prepare(`SELECT id, flow_id, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales, first_due_month, source FROM cc_installment_purchases WHERE account_id = ? ORDER BY id`)
        .all(card),
      payments: db
        .prepare(`SELECT p.purchase_id, p.pay_by_date, p.amount_clp, p.cuota_current FROM cc_installment_payments p JOIN cc_installment_purchases pr ON pr.id = p.purchase_id WHERE pr.account_id = ? ORDER BY p.id`)
        .all(card),
      stamps: db
        .prepare(`SELECT f.flow_id, f.first_seen_on FROM flow_first_seen f JOIN cc_installment_purchases pr ON pr.flow_id = f.flow_id WHERE pr.account_id = ? ORDER BY f.flow_id`)
        .all(card),
    });
    const before = snapshot();
    // n1's statement alone: n2 is not in the batch, and a plain merge never removes it.
    const result = mergeInstallmentLedgerFromStatements(card, statements, { replaceLedger: false });
    expect(snapshot()).toEqual(before);
    expect(result.earliestNewPurchaseDate).toBeNull();
    expect(result.earliestChangedEvidenceDate).toBeNull();
    expect(result.stale_plans_retired_with_assignments).toEqual([]);
    expect(before.plans).toHaveLength(2);
    expect(before.stamps).toHaveLength(2);

    const fresh = parsedStatements([cuotaRow("n3", "VITEST REBUILD N3", "08/05/26", 12_000)]);
    const added = mergeInstallmentLedgerFromStatements(card, fresh, { replaceLedger: false });
    expect(added.earliestNewPurchaseDate).toBe("2026-05-08");
    const n3 = planId("VITEST REBUILD N3")!;
    expect(db.prepare(`SELECT 1 FROM flow_first_seen WHERE flow_id = ?`).get(planFlow(n3))).toBeDefined();
    expect(planId("VITEST REBUILD N2")).toBeDefined();
  });
});
