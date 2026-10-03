import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { classifyLiderLines, findLedgerLineSameDayAndAmount } from "./liderCardLines.js";
import type { CcWebPasteLine } from "./ccWebPasteParse.js";

describe("liderCardLines", () => {
  const created: number[] = [];

  afterEach(() => {
    for (const sid of created.splice(0)) {
      db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(sid);
      db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(sid);
    }
  });

  /** The synthetic BCI master — same issuer as Lider, so the web-paste card group matches. */
  function masterId(): number | null {
    const row = db
      .prepare(
        `SELECT id FROM accounts WHERE notes LIKE 'credit_card_master|bci|%' ORDER BY id LIMIT 1`
      )
      .get() as { id: number } | undefined;
    return row?.id ?? null;
  }

  function seedLine(accountId: number, txDate: string, merchant: string, amountClp: number): void {
    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency)
       VALUES (?, 'vitest-lider', 'vitest-lider.pdf', '20/08/2026', '20/07/2026', '20/08/2026', 'clp')`
    ).run(accountId);
    const sid = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    created.push(sid);
    db.prepare(
      `INSERT INTO cc_statement_lines (statement_id, merchant, amount_clp, installment_flag, transaction_date, dedupe_key)
       VALUES (?, ?, ?, 0, ?, ?)`
    ).run(sid, merchant, amountClp, txDate, `vitest-lider-${sid}`);
  }

  function line(partial: Partial<CcWebPasteLine>): CcWebPasteLine {
    return {
      transaction_date: "2026-07-30",
      merchant: "EXPRESS LYON, SANTIAGO",
      amount_clp: 20470,
      amount_usd: null,
      currency: "clp",
      raw_line: "vitest",
      ...partial,
    };
  }

  it("matches an existing ledger line by day+amount regardless of merchant text", () => {
    const id = masterId();
    if (id == null) return;
    // The manual paste recorded this purchase under a different merchant rendering.
    seedLine(id, "30/7/2026", "SUPERMERCADO PLAZA LYON LTDA.", 20470);

    expect(findLedgerLineSameDayAndAmount(id, "2026-07-30", 20470)?.merchant).toBe(
      "SUPERMERCADO PLAZA LYON LTDA."
    );
    expect(findLedgerLineSameDayAndAmount(id, "2026-07-29", 20470)).toBeNull();
    expect(findLedgerLineSameDayAndAmount(id, "2026-07-30", 20471)).toBeNull();
  });

  it("withholds a feed line the ledger already covers under another merchant", () => {
    const id = masterId();
    if (id == null) return;
    seedLine(id, "30/7/2026", "SUPERMERCADO PLAZA LYON LTDA.", 20470);

    const { importable, sameDayAmount } = classifyLiderLines(id, [
      line({}),
      line({ transaction_date: "2026-08-03", merchant: "EXPRESS FICTICIA 2., SANTIAGO", amount_clp: 9080 }),
    ]);
    expect(importable.map((l) => l.merchant)).toEqual(["EXPRESS FICTICIA 2., SANTIAGO"]);
    expect(sameDayAmount).toHaveLength(1);
    expect(sameDayAmount[0]!.same_day_amount_match?.merchant).toBe("SUPERMERCADO PLAZA LYON LTDA.");
  });

  it("leaves a fuzzy-matching merchant to the shared dedupe so the skip is logged", () => {
    const id = masterId();
    if (id == null) return;
    // The PDF convention adds " (T)"; the BCI normalizer already matches these two.
    seedLine(id, "30/7/2026", "EXPRESS LYON, SANTIAGO (T)", 20470);

    const { importable, sameDayAmount } = classifyLiderLines(id, [line({})]);
    expect(sameDayAmount).toHaveLength(0);
    expect(importable).toHaveLength(1);
  });
});
