/**
 * The cupo-gap proof called directly (`planCupoGap`, `cupoGapReference`) on a synthetic card, with
 * the earlier verdicts written as rows so each reference path is chosen on purpose, and the
 * writers' pure planners (`ccAnnulmentWriters.ts`). The planner writes nothing: every outcome is
 * checked to leave the bucket lines and the annulment table as they were. The full listing path
 * (`applyCardUnbilledMovements` → planner → writer) is `ccAnnulledPurchasesWriters.test.ts`'.
 *
 * The card: an August facturación of 3.400.000 (closed 2026-08-25) and a September bucket with
 * 10.000 (09-03) and 71.300 (09-10) → the app owes 3.481.300 on 2026-09-20.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import { cupoGapReference, planCupoGap } from "./ccAnnulmentCupoGap.js";
import {
  annulUnlistedLines,
  bucketLineAnnullableGiven,
  planAnnulmentSettlements,
  statementLineRestatingBucketLine,
  type AnnulmentForSettlement,
  type StatementChargeLike,
} from "./ccAnnulmentWriters.js";
import { listAnnulledPurchases, annulledPurchaseOwedEvents } from "./ccAnnulledPurchases.js";
import { listOpenBucketLines } from "./ccFeedCuotaPurchases.js";
import { webPasteLineDedupeKey, type CcListingLine } from "./ccWebPasteParse.js";
import { applyLinePlan } from "./cards/lineWrites.js";
import { snapshotTables } from "./test/snapshotTables.js";

const restoreDerivedCardState = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_metrics"]);

const LAST4 = "9977";
const CARD_GROUP = "santander";
const AUG_CLP = 3_400_000;
const OBSERVED = "2026-09-20T12:00:00.000Z";
const APP_OWED = AUG_CLP + 10_000 + 71_300; // 3.481.300

describe("planCupoGap", () => {
  let accountId = 0;
  let captureSeq = 0;
  let tienda = 0;
  let voided = 0;

  function insertStatement(source: string, date: string, extra: { from?: string; to?: string; monto?: number; nextFrom?: string; nextTo?: string } = {}): number {
    return Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, card_last4, layout, currency, monto_facturado, next_period_from, next_period_to)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'compact', 'clp', ?, ?, ?)`
        )
        .run(accountId, CARD_GROUP, source, date, extra.from ?? null, extra.to ?? null, LAST4, extra.monto ?? null, extra.nextFrom ?? null, extra.nextTo ?? null).lastInsertRowid
    );
  }

  function insertLine(statementId: number, dateIso: string, merchant: string, clp: number): number {
    const [y, m, d] = dateIso.split("-");
    const key = webPasteLineDedupeKey(CARD_GROUP, { transaction_date: dateIso, merchant, currency: "clp", amount: clp, raw_line: merchant });
    return Number(
      db
        .prepare(
          `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, installment_flag, dedupe_key, parser_row_id, raw_line)
           VALUES (?, ?, ?, ?, 0, ?, ?, 'vitest')`
        )
        .run(statementId, `${Number(d)}/${Number(m)}/${y}`, merchant, clp, key, `web:${key}`).lastInsertRowid
    );
  }

  const feedLine = (dateIso: string, merchant: string, clp: number): CcListingLine => ({ transaction_date: dateIso, merchant, currency: "clp", amount: clp, raw_line: merchant });

  /** An earlier cupo-check verdict of this card: what `cupoGapReference` reads. */
  function verdict(observedAt: string, status: "ok" | "mismatch" | "indeterminate", diff: number | null, currency = "clp"): void {
    const capture = Number(
      db.prepare(`INSERT INTO cc_bank_cupo_captures (source_file, observed_at, issuer) VALUES (?, ?, 'santander')`).run(`vitest-cupogap-${++captureSeq}`, observedAt).lastInsertRowid
    );
    const snapshot = Number(
      db
        .prepare(
          `INSERT INTO cc_bank_cupo_snapshots (capture_id, account_id, currency, bank_account, plastic_last4, cupo_total, cupo_utilizado, cupo_disponible)
           VALUES (?, ?, ?, 'vitest', ?, 1, 0, 1)`
        )
        .run(capture, accountId, currency, LAST4).lastInsertRowid
    );
    db.prepare(`INSERT INTO cc_bank_cupo_checks (snapshot_id, status, diff, detail) VALUES (?, ?, ?, 'vitest')`).run(snapshot, status, diff);
  }

  function august(): void {
    insertStatement("vitest cupogap 2026-08-25 clp.pdf", "25/08/2026", { from: "23/07/2026", to: "25/08/2026", monto: AUG_CLP, nextFrom: "25/08/2026", nextTo: "24/09/2026" });
  }

  function september(): void {
    const bucket = insertStatement("import:web-paste|open|2026-09", "20/09/2026");
    tienda = insertLine(bucket, "2026-09-03", "VITEST TIENDA", 10_000);
    voided = insertLine(bucket, "2026-09-10", "VITEST VOIDED STORE", 71_300);
  }

  const plan = (bankUsed: number, feedLines: CcListingLine[] = [feedLine("2026-09-03", "VITEST TIENDA", 10_000)], feedCloseIso: string | null = null) =>
    planCupoGap(accountId, { currency: "clp", bankUsed, observedAt: OBSERVED, feedCloseIso, feedLines });

  const bucketIds = () => listOpenBucketLines(accountId).map((l) => l.id);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-20T15:00:00Z"));
    const group = db.prepare(`SELECT id FROM asset_groups WHERE slug IN ('credit_card', 'credit_cards__credit_card') LIMIT 1`).get() as { id: number };
    const importKey = `credit_card_master|santander|vitest-cupogap-${LAST4}`;
    accountId = Number(
      db.prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'Vitest · cupo gap', ?, ?)`).run(group.id, importKey, importKey).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4, issuer) VALUES (?, 21, 20, ?, 'santander')`
    ).run(accountId, LAST4);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.prepare(`DELETE FROM cc_annulled_purchases WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM cc_bank_cupo_captures WHERE source_file LIKE 'vitest-cupogap-%'`).run();
    db.prepare(`DELETE FROM cc_billing_month_metrics WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM flow_categories WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    restoreDerivedCardState();
  });

  it("has no reference without an earlier verdict, and states the residual it would judge", () => {
    august();
    september();
    const r = plan(AUG_CLP + 10_000);
    // app − bank = 3.481.300 − 3.410.000.
    expect(r.report).toMatchObject({ bank_used: 3_410_000, app_owed: APP_OWED, residual_now: 71_300, residual_ref: null, reference: null, delta: null, outcome: "no_reference" });
    expect(r.toAnnul).toBeNull();
    expect(r.toRemove).toBeNull();
  });

  it("reads no gap when the residual did not grow (equal, or the bank now above the app)", () => {
    august();
    september();
    verdict("2026-09-19T12:00:00.000Z", "ok", 0);
    expect(plan(APP_OWED).report).toMatchObject({ residual_now: 0, residual_ref: 0, reference: "ok", delta: 0, outcome: "no_gap" });
    // Bank 3.500.000: residual −18.700, delta −18.700.
    expect(plan(3_500_000).report).toMatchObject({ residual_now: -18_700, delta: -18_700, outcome: "no_gap", candidates: 0 });
  });

  it("finds no candidate when no unlisted charge has the gap's amount", () => {
    august();
    september();
    verdict("2026-09-19T12:00:00.000Z", "ok", 0);
    // Gap 50.000; the only unlisted line is 71.300.
    const r = plan(APP_OWED - 50_000);
    expect(r.report).toMatchObject({ delta: 50_000, candidates: 0, outcome: "no_candidate" });
    expect(r.toAnnul).toBeNull();
  });

  it("names the one unlisted charge of the gap's amount for annulment and writes nothing itself", () => {
    august();
    september();
    verdict("2026-09-19T12:00:00.000Z", "ok", 0);
    const r = plan(AUG_CLP + 10_000);
    expect(r.report).toMatchObject({ residual_now: 71_300, residual_ref: 0, reference: "ok", delta: 71_300, candidates: 1, outcome: "annulled" });
    expect(r.toAnnul?.id).toBe(voided);
    expect(r.toRemove).toBeNull();
    expect(bucketIds()).toEqual([tienda, voided]);
    expect(listAnnulledPurchases(accountId)).toEqual([]);
  });

  it("removes rather than annuls a candidate the listing restated under another name", () => {
    august();
    september();
    verdict("2026-09-19T12:00:00.000Z", "ok", 0);
    // The bank re-listed the 71.300 a day later as another merchant: a restatement, not a void.
    const r = plan(AUG_CLP + 10_000, [feedLine("2026-09-03", "VITEST TIENDA", 10_000), feedLine("2026-09-11", "OTRO NOMBRE SPA", 71_300)]);
    expect(r.report).toMatchObject({ delta: 71_300, candidates: 1, outcome: "restatement_removed" });
    expect(r.toRemove?.id).toBe(voided);
    expect(r.toAnnul).toBeNull();
    expect(bucketIds()).toEqual([tienda, voided]);
  });

  it("falls back to the smallest recent difference, the latest among equals", () => {
    august();
    september();
    verdict("2026-09-17T12:00:00.000Z", "mismatch", -120);
    verdict("2026-09-18T12:00:00.000Z", "mismatch", 500);
    verdict("2026-09-19T12:00:00.000Z", "mismatch", 120);
    // Ignored: indeterminate, another currency, at or after the observation.
    verdict("2026-09-19T13:00:00.000Z", "indeterminate", 1);
    verdict("2026-09-19T14:00:00.000Z", "mismatch", 2, "usd");
    verdict(OBSERVED, "mismatch", 3);
    expect(cupoGapReference(accountId, "clp", OBSERVED)).toEqual({ residual: 120, kind: "smallest" });
    // The card carries 120 of difference; the bank dropped 71.300 more: residual 71.420, delta 71.300.
    const r = plan(APP_OWED - 71_300 - 120);
    expect(r.report).toMatchObject({ residual_now: 71_420, residual_ref: 120, reference: "smallest", delta: 71_300, outcome: "annulled" });
    expect(r.toAnnul?.id).toBe(voided);
  });

  it("prefers the latest matched verdict over a smaller mismatch", () => {
    august();
    verdict("2026-09-15T12:00:00.000Z", "ok", 5);
    verdict("2026-09-16T12:00:00.000Z", "ok", 8);
    verdict("2026-09-18T12:00:00.000Z", "mismatch", 0.4);
    expect(cupoGapReference(accountId, "clp", OBSERVED)).toEqual({ residual: 8, kind: "ok" });
    expect(cupoGapReference(accountId, "clp", "2026-09-15T00:00:00.000Z")).toBeNull();
  });

  it("is ambiguous with two unlisted charges of the gap's amount, and annuls neither", () => {
    august();
    september();
    const bucket = db.prepare(`SELECT id FROM cc_statements WHERE account_id = ? AND source_pdf LIKE 'import:web-paste%'`).get(accountId) as { id: number };
    const twin = insertLine(bucket.id, "2026-09-12", "VITEST OTRA TIENDA", 71_300);
    verdict("2026-09-19T12:00:00.000Z", "ok", 0);
    // App 3.552.600; the bank dropped one 71.300.
    const r = plan(APP_OWED);
    expect(r.report).toMatchObject({ app_owed: APP_OWED + 71_300, delta: 71_300, candidates: 2, outcome: "ambiguous" });
    expect(r.toAnnul).toBeNull();
    expect(r.toRemove).toBeNull();
    expect(bucketIds()).toEqual([tienda, voided, twin]);
  });

  it("refuses a listing whose close the app does not share", () => {
    august();
    september();
    verdict("2026-09-19T12:00:00.000Z", "ok", 0);
    expect(plan(AUG_CLP + 10_000, undefined, "2026-08-24").report.outcome).toBe("close_mismatch");
    expect(plan(AUG_CLP + 10_000, undefined, "2026-08-25").report.outcome).toBe("annulled");
  });

  it("has no close on a card with only an open bucket", () => {
    september();
    verdict("2026-09-19T12:00:00.000Z", "ok", 0);
    expect(plan(10_000).report.outcome).toBe("no_close");
    // A listing stating a close the app lacks is a mismatch first.
    expect(plan(10_000, undefined, "2026-08-25").report.outcome).toBe("close_mismatch");
  });

  it("annuls on the fetch day, a forward-dated line on its own day, and keeps the purchase", () => {
    august();
    september();
    const bucket = db.prepare(`SELECT id FROM cc_statements WHERE account_id = ? AND source_pdf LIKE 'import:web-paste%'`).get(accountId) as { id: number };
    const forward = insertLine(bucket.id, "2026-09-22", "VITEST PREAUTORIZADO", 4_000);
    const lines = listOpenBucketLines(accountId).filter((l) => l.id === voided || l.id === forward);
    const { plan: linePlan, annulled } = annulUnlistedLines(accountId, lines, { fetchedOnIso: "2026-09-20", basis: "cupo_gap", evidence: "vitest-cupogap" });
    expect(linePlan.deleteLineIds).toEqual([voided, forward]);
    expect(annulled.map((a) => [a.id, a.basis])).toEqual([
      [voided, "cupo_gap"],
      [forward, "cupo_gap"],
    ]);
    applyLinePlan(accountId, "vitest cupo gap", linePlan);
    expect(bucketIds()).toEqual([tienda]);
    const rows = listAnnulledPurchases(accountId);
    expect(rows.map((r) => [r.merchant, r.amount, r.purchase_date, r.annulled_on, r.basis])).toEqual([
      ["VITEST VOIDED STORE", 71_300, "2026-09-10", "2026-09-20", "cupo_gap"],
      ["VITEST PREAUTORIZADO", 4_000, "2026-09-22", "2026-09-22", "cupo_gap"],
    ]);
    // The walk counts each purchase until its annulment day.
    expect(annulledPurchaseOwedEvents(accountId).map((e) => [e.date, e.amount])).toEqual([
      ["2026-09-10", 71_300],
      ["2026-09-20", -71_300],
      ["2026-09-22", 4_000],
      ["2026-09-22", -4_000],
    ]);
  });
});

describe("the annulment writers' pure rules", () => {
  it("annuls only a plain positive one-shot charge", () => {
    expect(bucketLineAnnullableGiven({ installment_flag: 0, amount: 5_000 }, null)).toBe(true);
    expect(bucketLineAnnullableGiven({ installment_flag: 1, amount: 5_000 }, null)).toBe(false);
    expect(bucketLineAnnullableGiven({ installment_flag: false, amount: 5_000 }, "cuota_comercio")).toBe(false);
    expect(bucketLineAnnullableGiven({ installment_flag: 0, amount: -5_000 }, null)).toBe(false);
    expect(bucketLineAnnullableGiven({ installment_flag: 0, amount: 0 }, null)).toBe(false);
    expect(bucketLineAnnullableGiven({ installment_flag: 0, amount: null }, null)).toBe(false);
  });

  const stmt = (id: number, merchant: string, amount: number | null, iso: string | null, currency = "clp"): StatementChargeLike => ({ id, merchant, amount, currency, iso });

  it("finds the statement line restating a bucket line: same amount under any name, or the same merchant at another amount, within 4 days", () => {
    const bucket = { id: 1, merchant: "VITEST SUPERMERCADO", currency: "clp", amount: 10_000, iso: "2026-09-08" };
    expect(statementLineRestatingBucketLine(bucket, [stmt(10, "OTRO NOMBRE", 10_000, "2026-09-12")])?.id).toBe(10);
    expect(statementLineRestatingBucketLine(bucket, [stmt(11, "VITEST SUPERMERCADO", 10_500, "2026-09-09")])?.id).toBe(11);
    // 5 days away, another currency, a credit, or another merchant at another amount: none.
    expect(
      statementLineRestatingBucketLine(bucket, [
        stmt(12, "VITEST SUPERMERCADO", 10_000, "2026-09-13"),
        stmt(13, "VITEST SUPERMERCADO", 10_000, "2026-09-08", "usd"),
        stmt(14, "VITEST SUPERMERCADO", -10_000, "2026-09-08"),
        stmt(15, "OTRO NOMBRE", 9_000, "2026-09-08"),
        stmt(16, "VITEST SUPERMERCADO", 10_000, null),
      ])
    ).toBeUndefined();
  });

  const annulment = (id: number, merchant: string, amount: number, purchase: string, bankCredit = 0): AnnulmentForSettlement => ({
    id,
    currency: "clp",
    amount,
    merchant,
    purchase_date: purchase,
    bank_credit: bankCredit,
    flow_id: null,
    purchase_key: `k${id}`,
  });

  it("settles each annulment once: billed by a charge within 4 days, else refunded by a credit within 180 days after", () => {
    const a = annulment(1, "VITEST TIENDA", 7_000, "2026-09-06");
    const b = annulment(2, "VITEST TIENDA", 7_000, "2026-09-06");
    const c = annulment(3, "VITEST OTRA", 3_000, "2026-03-01");
    const lines = [
      stmt(20, "VITEST TIENDA", 7_000, "2026-09-09"), // bills a
      stmt(21, "VITEST TIENDA", -7_000, "2026-09-15"), // refunds b (the charge is taken)
      stmt(22, "VITEST OTRA", -3_000, "2026-08-29"), // 181 days after c's purchase: too late
    ];
    expect(planAnnulmentSettlements([a, b, c], lines, new Set())).toEqual([
      { annulment: a, outcome: "billed", statement_line_id: 20 },
      { annulment: b, outcome: "bank_credit", statement_line_id: 21, credit_iso: "2026-09-15" },
    ]);
    // 180 days is still in: 2026-03-01 + 180 = 2026-08-28.
    expect(planAnnulmentSettlements([c], [stmt(23, "VITEST OTRA", -3_000, "2026-08-28")], new Set())).toEqual([
      { annulment: c, outcome: "bank_credit", statement_line_id: 23, credit_iso: "2026-08-28" },
    ]);
  });

  it("never takes a credit dated before the purchase, a line a bucket line already used, or a bank-credited annulment", () => {
    const a = annulment(1, "VITEST TIENDA", 7_000, "2026-09-06");
    expect(planAnnulmentSettlements([a], [stmt(30, "VITEST TIENDA", -7_000, "2026-09-05")], new Set())).toEqual([]);
    expect(planAnnulmentSettlements([a], [stmt(31, "VITEST TIENDA", 7_000, "2026-09-06")], new Set([31]))).toEqual([]);
    expect(planAnnulmentSettlements([annulment(2, "VITEST TIENDA", 7_000, "2026-09-06", 1)], [stmt(32, "VITEST TIENDA", 7_000, "2026-09-06")], new Set())).toEqual([]);
    // A charge 5 days away does not bill it.
    expect(planAnnulmentSettlements([a], [stmt(33, "VITEST TIENDA", 7_000, "2026-09-11")], new Set())).toEqual([]);
  });
});
