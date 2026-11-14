import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import { applyListing, balanceRow, listing, listingCard, listingLine } from "./test/cardListingPayloads.js";
import { judgeLatestBankCupoCapture } from "./ccBankCupoCheck.js";
import { annulledPurchaseOwedEvents, listAnnulledPurchases, annulOpenBucketLines } from "./ccAnnulledPurchases.js";
import { reconcileOpenWebPasteAfterPdfClose } from "./ccOpenWebPastePdfReconcile.js";
import { resolveCcExpensePurchaseKey } from "./ccExpenseCategories.js";
import { webPasteLineDedupeKey, type CcListingLine } from "./ccWebPasteParse.js";
import { snapshotTables } from "./test/snapshotTables.js";
import { applyLinePlan } from "./cards/lineWrites.js";
import { getFlowCategory } from "./flows/flowCategories.js";

const restoreDerivedCardState = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_metrics"]);

const LAST4 = "9966";
const BANK_ACCOUNT = "800099990066";
const CARD_GROUP = "santander";
const AUG_CLP = 3_400_000;
const AUG_USD = 556.21;

describe("annulled purchases: the writers", () => {
  let accountId = 0;
  let tmpDir = "";
  const prevIdentifiers = process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS;
  let feedSeq = 0;

  function insertStatement(opts: {
    source: string;
    date: string;
    from?: string | null;
    to?: string | null;
    currency: "clp" | "usd";
    monto?: number | null;
    nextFrom?: string | null;
    nextTo?: string | null;
  }): number {
    return Number(
      db
        .prepare(
          `INSERT INTO cc_statements (
             account_id, card_group, source_pdf, statement_date, period_from, period_to,
             card_last4, layout, currency, monto_facturado, next_period_from, next_period_to
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'compact', ?, ?, ?, ?)`
        )
        .run(
          accountId,
          CARD_GROUP,
          opts.source,
          opts.date,
          opts.from ?? null,
          opts.to ?? null,
          LAST4,
          opts.currency,
          opts.monto ?? null,
          opts.nextFrom ?? null,
          opts.nextTo ?? null
        ).lastInsertRowid
    );
  }

  function webLine(dateIso: string, merchant: string, clp: number): CcListingLine {
    return { transaction_date: dateIso, merchant, currency: "clp", amount: clp, raw_line: merchant };
  }

  /** A bucket line with the key a feed row gives it (pesos, debt-positive; negative = a credit). */
  function insertLine(statementId: number, dateIso: string, merchant: string, clp: number, withKey = true): number {
    const [y, m, d] = dateIso.split("-");
    const key = webPasteLineDedupeKey(CARD_GROUP, webLine(dateIso, merchant, clp));
    return Number(
      db
        .prepare(
          `INSERT INTO cc_statement_lines (
             statement_id, transaction_date, merchant, amount, installment_flag, dedupe_key, parser_row_id, raw_line
           ) VALUES (?, ?, ?, ?, 0, ?, ?, 'vitest')`
        )
        .run(statementId, `${Number(d)}/${Number(m)}/${y}`, merchant, clp, withKey ? key : null, withKey ? `web:${key}` : null)
        .lastInsertRowid
    );
  }

  /** A per-line category override (what keeps the line's flow alive once the line goes). */
  function overrideCategory(lineId: number): number {
    const cat = db.prepare(`SELECT id FROM cc_expense_categories ORDER BY id LIMIT 1`).get() as { id: number };
    db.prepare(`INSERT INTO cc_expense_line_categories (statement_line_id, category_id) VALUES (?, ?)`).run(lineId, cat.id);
    return cat.id;
  }

  const lineExists = (id: number): boolean => db.prepare(`SELECT 1 FROM cc_statement_lines WHERE id = ?`).get(id) !== undefined;
  const annulments = () => listAnnulledPurchases(accountId);

  function bucket(): number {
    return insertStatement({ source: "import:web-paste|open|2026-09", date: "20/09/2026", currency: "clp" });
  }

  type Feed = {
    lines: CcListingLine[] | ReturnType<typeof listingLine>[];
    /** The listing states the SALDO INICIAL close (Santander); false = a BCI-style listing with none. */
    close?: boolean;
    bankUsed?: { clp: number; usd: number };
    observedAt?: string;
  };

  function feed(opts: Feed) {
    const ref = `card-movements-vitest-annul-${++feedSeq}.json`;
    const observed = opts.observedAt ?? "2026-09-20T01:00:00.000Z";
    return applyListing(
      listing(
        [
          listingCard(
            BANK_ACCOUNT,
            opts.lines as ReturnType<typeof listingLine>[],
            opts.close === false ? null : { date: "2026-08-25", clp: AUG_CLP, usd: AUG_USD }
          ),
        ],
        opts.bankUsed
          ? {
              status: "observed",
              observed_at: observed,
              rows: [
                balanceRow(BANK_ACCOUNT, LAST4, "clp", 12_000_000, opts.bankUsed.clp),
                balanceRow(BANK_ACCOUNT, LAST4, "usd", 12_000, opts.bankUsed.usd),
              ],
            }
          : undefined,
        observed
      ),
      ref
    ).accounts[0]!;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-20T15:00:00Z"));
    const group = db
      .prepare(`SELECT id FROM asset_groups WHERE slug IN ('credit_card', 'credit_cards__credit_card') LIMIT 1`)
      .get() as { id: number };
    const importKey = `credit_card_master|santander|vitest-annulled-${LAST4}`;
    accountId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'Vitest · annulled', ?, ?)`)
        .run(group.id, importKey, importKey).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4, issuer)
       VALUES (?, 21, 20, ?, 'santander')`
    ).run(accountId, LAST4);
    insertStatement({
      source: "vitest 2026-08-25 clp.pdf",
      date: "25/08/2026",
      from: "23/07/2026",
      to: "25/08/2026",
      currency: "clp",
      monto: AUG_CLP,
      nextFrom: "25/08/2026",
      nextTo: "24/09/2026",
    });
    insertStatement({ source: "vitest 2026-08-25 usd.pdf", date: "25/08/2026", from: "23/07/2026", to: "25/08/2026", currency: "usd", monto: AUG_USD });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vitest-annulled-"));
    const identifiers = path.join(tmpDir, "organize-identifiers.json");
    fs.writeFileSync(identifiers, JSON.stringify({ santander_80_account_to_card_last4: { [BANK_ACCOUNT]: LAST4 } }));
    process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS = identifiers;
  });

  afterEach(() => {
    vi.useRealTimers();
    db.prepare(`DELETE FROM cc_annulled_purchases WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM cc_bank_cupo_captures WHERE source_file LIKE 'card-movements-vitest-annul-%'`).run();
    db.prepare(`DELETE FROM cc_feed_billing_closes WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM cc_billing_month_metrics WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM flow_categories WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM import_batches WHERE raw_text LIKE ?`).run(`%"account_id":${accountId},%`);
    db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevIdentifiers == null) delete process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS;
    else process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS = prevIdentifiers;
    restoreDerivedCardState();
  });

  // ── the feed mirror ──────────────────────────────────────────────────────────────────────────

  it("annuls a purchase a SALDO-INICIAL listing no longer shows, keeping its key and flow", () => {
    const sept = bucket();
    const kept = insertLine(sept, "2026-09-03", "VITEST TIENDA", 10_000);
    const voided = insertLine(sept, "2026-09-10", "VITEST VOIDED STORE", 71_300);
    const key = resolveCcExpensePurchaseKey(voided);
    const catId = overrideCategory(voided);

    const result = feed({ lines: [listingLine("2026-09-03", "VITEST TIENDA", 10_000)] });
    expect(lineExists(voided)).toBe(false);
    expect(lineExists(kept)).toBe(true);
    const [row] = annulments();
    expect(row).toMatchObject({
      currency: "clp",
      amount: 71_300,
      merchant: "VITEST VOIDED STORE",
      purchase_date: "2026-09-10",
      annulled_on: "2026-09-19", // the Chile day of the 01:00Z fetch
      basis: "feed_drop",
      purchase_key: key,
      bank_credit: 0,
    });
    // The line's override went with it; the purchase keeps the category as its «Único» row, and
    // the flow it hangs on is the one the annulment records.
    expect(row!.flow_id).not.toBeNull();
    expect(getFlowCategory(accountId, key)).toEqual({ category_id: catId });
    expect(row!.evidence).toMatch(/^card-movements-vitest-annul-/);
    expect(result.mirror?.removed).toEqual([]);
    expect(result.mirror?.annulled.map((a) => a.id)).toEqual([voided]);
    expect(result.annulled).toHaveLength(1);
    // The walk: the purchase on its day, minus it on the annulment day.
    expect(annulledPurchaseOwedEvents(accountId).map((e) => [e.date, e.amount])).toEqual([
      ["2026-09-10", 71_300],
      ["2026-09-19", -71_300],
    ]);
  });

  it("deletes a renamed restatement and a re-settled pre-authorization as before", () => {
    const sept = bucket();
    const voided = insertLine(sept, "2026-09-03", "CONVENIO P.A.T.", 29_436);
    const settled = insertLine(sept, "2026-09-07", "SEG AUTO VITEST", 29_436);
    const preAuth = insertLine(sept, "2026-09-08", "SUPERMERCADO VITEST", 10_000);
    const result = feed({
      lines: [
        listingLine("2026-09-07", "SEG AUTO VITEST", 29_436),
        listingLine("2026-09-09", "SUPERMERCADO VITEST", 10_500),
      ],
    });
    expect(result.mirror!.removed.map((r) => r.id)).toEqual([voided, preAuth]);
    expect(lineExists(voided)).toBe(false);
    expect(lineExists(preAuth)).toBe(false);
    expect(lineExists(settled)).toBe(true);
    expect(annulments()).toEqual([]);
  });

  it("keeps the deletion limit over annulled and restated lines together", () => {
    const sept = bucket();
    for (let i = 1; i <= 13; i++) insertLine(sept, "2026-09-10", `COMERCIO ${i}`, 1_000 + i);
    expect(() => feed({ lines: [listingLine("2026-09-15", "OTRO COMERCIO", 5_000)] })).toThrow(/no longer lists 13 open-bucket lines/);
    expect(annulments()).toEqual([]);
  });

  // ── the cupo gap ─────────────────────────────────────────────────────────────────────────────

  /** A listing with no SALDO INICIAL (BCI's shape) and the bank's cupo; judged right after, as the nightly does. */
  function noCloseFeed(lines: ReturnType<typeof listingLine>[], bankClp: number, observedAt: string) {
    const result = feed({ lines, close: false, bankUsed: { clp: bankClp, usd: AUG_USD }, observedAt });
    judgeLatestBankCupoCapture({ issuer: "santander" });
    return result;
  }

  it("annuls the one unlisted charge the bank's gap moved by, on a listing with no close", () => {
    const sept = bucket();
    insertLine(sept, "2026-09-03", "VITEST TIENDA", 10_000);
    const merc = insertLine(sept, "2026-09-10", "VITEST VOIDED", 71_300);
    // Observation 1: bank and app agree (facturado + both lines); the check stores `ok`.
    const first = noCloseFeed(
      [listingLine("2026-09-03", "VITEST TIENDA", 10_000), listingLine("2026-09-10", "VITEST VOIDED", 71_300)],
      AUG_CLP + 81_300,
      "2026-09-20T01:00:00.000Z"
    );
    expect(first.cupo_gap.map((g) => [g.currency, g.outcome])).toEqual([
      ["clp", "no_reference"],
      ["usd", "no_reference"],
    ]);
    expect(lineExists(merc)).toBe(true);

    // Observation 2: the bank stopped counting 71.300 and its listing no longer shows it.
    const second = noCloseFeed([listingLine("2026-09-03", "VITEST TIENDA", 10_000)], AUG_CLP + 10_000, "2026-09-20T12:00:00.000Z");
    const clp = second.cupo_gap.find((g) => g.currency === "clp")!;
    expect(clp).toMatchObject({ residual_now: 71_300, residual_ref: 0, reference: "ok", delta: 71_300, candidates: 1, outcome: "annulled" });
    expect(second.mirror).toBeNull();
    expect(lineExists(merc)).toBe(false);
    expect(annulments()).toHaveLength(1);
    expect(annulments()[0]).toMatchObject({ basis: "cupo_gap", amount: 71_300, annulled_on: "2026-09-20" });
  });

  it("writes nothing when two unlisted charges have the gap's amount", () => {
    const sept = bucket();
    insertLine(sept, "2026-09-03", "VITEST TIENDA", 10_000);
    const a = insertLine(sept, "2026-09-08", "VITEST UNO", 71_300);
    const b = insertLine(sept, "2026-09-09", "VITEST DOS", 71_300);
    noCloseFeed(
      [listingLine("2026-09-03", "VITEST TIENDA", 10_000), listingLine("2026-09-08", "VITEST UNO", 71_300), listingLine("2026-09-09", "VITEST DOS", 71_300)],
      AUG_CLP + 10_000 + 142_600,
      "2026-09-20T01:00:00.000Z"
    );
    // The bank stopped counting one of them; the listing lost both rows.
    const second = noCloseFeed([listingLine("2026-09-03", "VITEST TIENDA", 10_000)], AUG_CLP + 10_000 + 71_300, "2026-09-20T12:00:00.000Z");
    expect(second.cupo_gap.find((g) => g.currency === "clp")).toMatchObject({ delta: 71_300, candidates: 2, outcome: "ambiguous" });
    expect(lineExists(a) && lineExists(b)).toBe(true);
    expect(annulments()).toEqual([]);
  });

  // ── a listing that shows the purchase again ──────────────────────────────────────────────────

  it("undoes an annulment when the listing shows the purchase again", () => {
    const sept = bucket();
    const voided = insertLine(sept, "2026-09-10", "VITEST VOIDED STORE", 71_300);
    feed({ lines: [listingLine("2026-09-03", "VITEST TIENDA", 10_000)] });
    expect(annulments()).toHaveLength(1);
    expect(lineExists(voided)).toBe(false);

    const again = feed({
      lines: [listingLine("2026-09-03", "VITEST TIENDA", 10_000), listingLine("2026-09-10", "VITEST VOIDED STORE", 71_300)],
      observedAt: "2026-09-20T12:00:00.000Z",
    });
    expect(again.relisted_annulments.map((r) => r.amount)).toEqual([71_300]);
    expect(annulments()).toEqual([]);
    const back = db
      .prepare(
        `SELECT l.id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id = ? AND l.merchant = 'VITEST VOIDED STORE'`
      )
      .all(accountId);
    expect(back).toHaveLength(1);
  });

  it("does not let a still-listed twin undo its voided sibling's annulment", () => {
    const sept = bucket();
    insertLine(sept, "2026-09-10", "VITEST TWIN", 5_000);
    const gone = insertLine(sept, "2026-09-10", "VITEST TWIN", 5_000, false);
    feed({ lines: [listingLine("2026-09-10", "VITEST TWIN", 5_000)] });
    expect(lineExists(gone)).toBe(false);
    expect(annulments()).toHaveLength(1);
    const next = feed({ lines: [listingLine("2026-09-10", "VITEST TWIN", 5_000)], observedAt: "2026-09-20T12:00:00.000Z" });
    expect(next.relisted_annulments).toEqual([]);
    expect(annulments()).toHaveLength(1);
  });

  // ── the statement close ──────────────────────────────────────────────────────────────────────

  function septemberStatement(): number {
    return insertStatement({
      source: "vitest 2026-09-24 clp.pdf",
      date: "24/09/2026",
      from: "25/08/2026",
      to: "24/09/2026",
      currency: "clp",
      monto: 100_000,
      nextFrom: "24/09/2026",
      nextTo: "24/10/2026",
    });
  }

  it("annuls an unbilled bucket line at the close but deletes a re-settled one", () => {
    vi.setSystemTime(new Date("2026-09-26T15:00:00Z"));
    const sept = bucket();
    const voided = insertLine(sept, "2026-09-04", "VITEST ANULADO", 20_000);
    const resettled = insertLine(sept, "2026-09-05", "VITEST AJUSTADO", 10_000);
    const stmt = septemberStatement();
    insertLine(stmt, "2026-09-05", "VITEST AJUSTADO", 10_500);
    const result = reconcileOpenWebPasteAfterPdfClose(accountId, "2026-09");
    expect(result.annulled_line_ids).toEqual([voided]);
    expect(result.deleted_line_ids.sort()).toEqual([voided, resettled].sort());
    expect(lineExists(voided)).toBe(false);
    expect(lineExists(resettled)).toBe(false);
    expect(annulments()).toHaveLength(1);
    expect(annulments()[0]).toMatchObject({ merchant: "VITEST ANULADO", basis: "statement_close", annulled_on: "2026-09-24", purchase_date: "2026-09-04" });
  });

  it("removes an annulment the statement bills after all, and folds its flow", () => {
    vi.setSystemTime(new Date("2026-09-26T15:00:00Z"));
    const sept = bucket();
    const was = insertLine(sept, "2026-09-06", "VITEST FACTURADO", 5_000);
    overrideCategory(was);
    const { plan, annulled } = annulOpenBucketLines(accountId, [was], { annulledOn: "2026-09-12", basis: "feed_drop", evidence: "vitest" });
    applyLinePlan(accountId, "vitest annul", plan);
    expect(annulled[0]!.flow_id).not.toBeNull();
    const stmt = septemberStatement();
    const billed = insertLine(stmt, "2026-09-07", "VITEST FACTURADO", 5_000); // another day: another key, another flow
    const result = reconcileOpenWebPasteAfterPdfClose(accountId, "2026-09");
    expect(result.annulments_settled).toEqual([
      { annulled_purchase_id: annulled[0]!.id, outcome: "billed", statement_line_id: billed, folded: true },
    ]);
    expect(annulments()).toEqual([]);
    // The user's flow now answers for the billed line.
    const billedFlow = (db.prepare(`SELECT flow_id FROM cc_statement_lines WHERE id = ?`).get(billed) as { flow_id: number }).flow_id;
    expect(billedFlow).toBe(annulled[0]!.flow_id);
  });

  it("keeps the purchase and drops the synthetic refund when the bank refunds it with a credit line", () => {
    vi.setSystemTime(new Date("2026-09-26T15:00:00Z"));
    const sept = bucket();
    const was = insertLine(sept, "2026-09-06", "VITEST REEMBOLSADO", 7_000);
    const { plan, annulled } = annulOpenBucketLines(accountId, [was], { annulledOn: "2026-09-12", basis: "feed_drop", evidence: "vitest" });
    applyLinePlan(accountId, "vitest annul", plan);
    const stmt = septemberStatement();
    const credit = insertLine(stmt, "2026-09-15", "VITEST REEMBOLSADO", -7_000);
    const result = reconcileOpenWebPasteAfterPdfClose(accountId, "2026-09");
    expect(result.annulments_settled).toEqual([
      { annulled_purchase_id: annulled[0]!.id, outcome: "bank_credit", statement_line_id: credit, folded: false },
    ]);
    expect(annulments()[0]).toMatchObject({ bank_credit: 1, annulled_on: "2026-09-15" });
    // Only the purchase leg: the credit line is the refund.
    expect(annulledPurchaseOwedEvents(accountId).map((e) => [e.leg, e.date, e.amount])).toEqual([["purchase", "2026-09-06", 7_000]]);
  });
});
