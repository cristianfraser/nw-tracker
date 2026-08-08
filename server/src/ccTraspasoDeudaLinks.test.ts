import { afterEach, describe, expect, it } from "vitest";
import { invalidateCcBillingDetail } from "./aggregationCache.js";
import { postCloseLiveBalanceAdjustmentClp } from "./ccBillingBalances.js";
import {
  ccTraspasoLinkedClpByUsdLineId,
  computeCcTraspasoDeudaPairsForAccount,
  relinkCcTraspasoDeudaLinksForAccount,
} from "./ccTraspasoDeudaLinks.js";
import { db } from "./db.js";
import { VITEST_SANTANDER_CC_MASTER_NOTES } from "./test/vitestDbSeed.js";

/**
 * A traspaso de deuda is one reclassification recorded as two statement lines (USD abono +
 * CLP cargo of the same facturación). The link stores the bank's hard conversion so the
 * owed walk values the pair as exactly net-zero — never an fx estimate.
 */
describe("ccTraspasoDeudaLinks", () => {
  const createdStatements: number[] = [];
  let fixtureAccountId: number | null = null;

  afterEach(() => {
    for (const sid of createdStatements.splice(0)) {
      db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(sid);
      db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(sid);
    }
    if (fixtureAccountId != null) {
      db.prepare(`DELETE FROM cc_traspaso_deuda_links WHERE account_id = ?`).run(fixtureAccountId);
      invalidateCcBillingDetail(fixtureAccountId);
      fixtureAccountId = null;
    }
  });

  function masterId(): number | null {
    const row = db
      .prepare(`SELECT id FROM accounts WHERE notes = ?`)
      .get(VITEST_SANTANDER_CC_MASTER_NOTES) as { id: number } | undefined;
    fixtureAccountId = row?.id ?? null;
    return fixtureAccountId;
  }

  function newStatement(
    accountId: number,
    statementDate: string,
    currency: "clp" | "usd",
    sourcePdf = `vitest-traspaso-${currency}.pdf`
  ): number {
    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency)
       VALUES (?, ?, ?, ?, '27/07/2026', ?, ?)`
    ).run(accountId, `vitest-${currency}`, sourcePdf, statementDate, statementDate, currency);
    const sid = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    createdStatements.push(sid);
    return sid;
  }

  function addLine(
    statementId: number,
    txnIso: string,
    merchant: string,
    amounts: { clp?: number; usd?: number }
  ): number {
    db.prepare(
      `INSERT INTO cc_statement_lines (statement_id, merchant, amount_clp, amount_usd, installment_flag, transaction_date, dedupe_key)
       VALUES (?, ?, ?, ?, 0, ?, ?)`
    ).run(
      statementId,
      merchant,
      amounts.clp ?? 0,
      amounts.usd ?? null,
      txnIso,
      `vitest-tras-${statementId}-${merchant}-${amounts.clp ?? amounts.usd}`
    );
    return (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
  }

  function addPair(accountId: number, statementDate: string, txnIso: string) {
    const clpStmt = newStatement(accountId, statementDate, "clp");
    const usdStmt = newStatement(accountId, statementDate, "usd");
    const clpLineId = addLine(clpStmt, txnIso, "TRASPASO A DEUDA NACIONAL", { clp: 167_192 });
    const usdLineId = addLine(usdStmt, txnIso, "TRASPASO DE DEUDA INTERNACIO", { usd: -176.7 });
    return { clpLineId, usdLineId };
  }

  it("pairs one CLP and one USD leg per statement close and stores the hard conversion", () => {
    const id = masterId();
    if (id == null) return;
    const { clpLineId, usdLineId } = addPair(id, "20/08/2026", "2026-08-09");

    const pairs = computeCcTraspasoDeudaPairsForAccount(id);
    expect(pairs).toEqual([
      {
        statement_date: "20/08/2026",
        clp_line_id: clpLineId,
        usd_line_id: usdLineId,
        amount_clp: 167_192,
        amount_usd: 176.7,
      },
    ]);

    expect(relinkCcTraspasoDeudaLinksForAccount(id)).toEqual({ links: 1 });
    // Relink is a derived-state rebuild — a second run keeps exactly one row.
    expect(relinkCcTraspasoDeudaLinksForAccount(id)).toEqual({ links: 1 });
    expect(ccTraspasoLinkedClpByUsdLineId(id)).toEqual(new Map([[usdLineId, 167_192]]));
  });

  it("nets a linked pair to exactly zero in the post-close walk", () => {
    const id = masterId();
    if (id == null) return;
    addPair(id, "20/08/2026", "2026-07-29");
    relinkCcTraspasoDeudaLinksForAccount(id);

    expect(postCloseLiveBalanceAdjustmentClp(id, "2026-07-26", "2026-07-31")).toBe(0);
  });

  it("throws on a lone leg (missing statement currency for the facturación)", () => {
    const id = masterId();
    if (id == null) return;
    const usdStmt = newStatement(id, "20/08/2026", "usd");
    addLine(usdStmt, "2026-08-09", "TRASPASO DE DEUDA INTERNACIO", { usd: -176.7 });

    expect(() => computeCcTraspasoDeudaPairsForAccount(id)).toThrow(/exactly one CLP and one USD leg/);
  });

  it("throws when a side has more than one leg on the same close", () => {
    const id = masterId();
    if (id == null) return;
    addPair(id, "20/08/2026", "2026-08-09");
    const extraUsd = newStatement(id, "20/08/2026", "usd", "vitest-traspaso-usd-2.pdf");
    addLine(extraUsd, "2026-08-10", "TRASPASO DE DEUDA INTERNACIO", { usd: -10 });

    expect(() => computeCcTraspasoDeudaPairsForAccount(id)).toThrow(/got 1 clp \/ 2 usd/);
  });

  it("throws on sign anomalies and implausible rates", () => {
    const id = masterId();
    if (id == null) return;
    const clpStmt = newStatement(id, "20/08/2026", "clp");
    const usdStmt = newStatement(id, "20/08/2026", "usd");
    addLine(clpStmt, "2026-08-09", "TRASPASO A DEUDA NACIONAL", { clp: 167_192 });
    const badUsd = addLine(usdStmt, "2026-08-09", "TRASPASO DE DEUDA INTERNACIO", { usd: 176.7 });
    expect(() => computeCcTraspasoDeudaPairsForAccount(id)).toThrow(/negative abono/);

    db.prepare(`UPDATE cc_statement_lines SET amount_usd = ? WHERE id = ?`).run(-1.0, badUsd);
    expect(() => computeCcTraspasoDeudaPairsForAccount(id)).toThrow(/implied rate/);
  });

  it("ignores web-paste bucket legs entirely", () => {
    const id = masterId();
    if (id == null) return;
    const pasteStmt = newStatement(id, "20/08/2026", "usd", "import:web-paste|open|2026-08");
    addLine(pasteStmt, "2026-08-09", "TRASPASO DE DEUDA INTERNACIO", { usd: -176.7 });

    expect(computeCcTraspasoDeudaPairsForAccount(id)).toEqual([]);
    expect(relinkCcTraspasoDeudaLinksForAccount(id)).toEqual({ links: 0 });
  });
});
