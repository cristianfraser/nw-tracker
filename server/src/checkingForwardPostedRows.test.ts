import { afterEach, describe, expect, it } from "vitest";
import type { BankAccountMovementsPayload } from "nw-tracker-contracts";
import { readOnChileDay } from "./test/listingFetch.js";
import { db } from "./db.js";
import { applyBankAccountMovements } from "./bankAccountMovementsApply.js";
import { importCheckingCartola } from "./checkingCartolaImport.js";
import type { ParsedCheckingCartola } from "./checkingCartolaParse.js";
import { checkingMovementBalanceAtMonthEnd, nonAnchorClpFlowTotals } from "./checkingCartolaBalances.js";
import {
  importCheckingPartialMovements,
  partialMovementNote,
  type PartialBankMovement,
} from "./checkingPartialMovementsImport.js";
import { applyForwardPostedRedates, planForwardPostedRedates } from "./forwardPostedCheckingRedate.js";
import { IngestRefusal } from "./ingestReceiver.js";
import { bankPostedOn } from "./movementBankPostings.js";

// Santander's bank day ends at 14:00: a movement after the cutoff is listed under the next
// workday. The listing is stored on the day it was read, the bank's day kept as posting day.

const PREFIX = "vitest-fwd";

function checkingId(): number {
  const row = db
    .prepare(
      `SELECT a.id FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE g.slug LIKE '%cuenta_corriente%' ORDER BY a.id LIMIT 1`
    )
    .get() as { id: number } | undefined;
  if (!row) throw new Error("test DB has no cuenta corriente");
  return row.id;
}

const row = (occurred_on: string, amount_clp: number, what: string): PartialBankMovement => ({
  occurred_on,
  amount_clp,
  description: `${PREFIX} ${what}`,
  document_no: "",
});

function stored(accountId: number, mv: PartialBankMovement): { id: number; occurred_on: string } | undefined {
  return db
    .prepare(`SELECT id, occurred_on FROM movements WHERE account_id = ? AND note = ?`)
    .get(accountId, partialMovementNote(mv)) as { id: number; occurred_on: string } | undefined;
}

function cleanup(): void {
  const id = checkingId();
  db.prepare(`DELETE FROM movements WHERE account_id = ? AND note LIKE ?`).run(id, `%${PREFIX}%`);
  db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ? AND source_file LIKE ?`).run(id, `${PREFIX}%`);
  db.prepare(`DELETE FROM import_batches WHERE filename LIKE ?`).run(`${PREFIX}%`);
}

afterEach(cleanup);

describe("a recent-movements row the bank dated after the day the listing was read", () => {
  it("is stored on the fetch day with its bank date as posting day; rows on or before it keep their date", () => {
    cleanup();
    const account = checkingId();
    const late = row("1801-03-16", -15_000, "Giro Nacional VD");
    const sameDay = row("1801-03-15", -1_000, "same day");
    const res = importCheckingPartialMovements(account, [late, sameDay], readOnChileDay("1801-03-15"));
    expect(res.inserted).toBe(2);

    const lateRow = stored(account, late)!;
    expect(lateRow.occurred_on).toBe("1801-03-15");
    expect(bankPostedOn(lateRow.id, account)).toBe("1801-03-16");
    const sameRow = stored(account, sameDay)!;
    expect(sameRow.occurred_on).toBe("1801-03-15");
    expect(db.prepare(`SELECT 1 FROM movement_bank_postings WHERE movement_id = ?`).get(sameRow.id)).toBeUndefined();

    // Reconciliation against the bank reads the bank's day.
    expect(nonAnchorClpFlowTotals(account, { fromYmd: "1801-03-16", toYmd: "1801-03-16" }).net_clp).toBe(-15_000);
    expect(nonAnchorClpFlowTotals(account, { fromYmd: "1801-03-15", toYmd: "1801-03-15" }).net_clp).toBe(-1_000);
  });

  it("dedupes the same listing sent again and a later listing that still shows the row", () => {
    cleanup();
    const account = checkingId();
    const late = row("1801-03-16", -15_000, "Giro Nacional VD");
    importCheckingPartialMovements(account, [late], readOnChileDay("1801-03-15"));
    expect(importCheckingPartialMovements(account, [late], readOnChileDay("1801-03-15"))).toMatchObject({
      inserted: 0,
      skipped_duplicate: 1,
    });
    const next = row("1801-03-17", -2_000, "next day");
    expect(importCheckingPartialMovements(account, [late, next], readOnChileDay("1801-03-17"))).toMatchObject({
      inserted: 1,
      skipped_duplicate: 1,
    });
    expect(stored(account, late)!.occurred_on).toBe("1801-03-15");
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM movements WHERE account_id = ? AND note LIKE ?`).get(account, `%${PREFIX}%`) as { n: number }).n
    ).toBe(2);
  });

  it("keeps the real day when the monthly cartola replaces the daily row", () => {
    cleanup();
    const account = checkingId();
    const late = row("1801-03-16", -15_000, "Giro Nacional VD");
    importCheckingPartialMovements(account, [late], readOnChileDay("1801-03-15"));
    const cartola: ParsedCheckingCartola = {
      source_file: `${PREFIX}-cartola.xlsx`,
      period_month: "1801-03",
      period_from: "1801-03-01",
      period_to: "1801-03-31",
      saldo_inicial_clp: 50_000,
      saldo_final_clp: 35_000,
      movements: [{ occurred_on: "1801-03-16", amount_clp: -15_000, branch: "Agustinas", description: late.description, document_no: "" }],
      skipped: [],
      notes: [],
    };
    try {
      const imported = importCheckingCartola(account, cartola);
      expect(imported.partialsRemoved).toBe(1);
      expect(stored(account, late)).toBeUndefined();
      const official = db
        .prepare(`SELECT id, occurred_on FROM movements WHERE account_id = ? AND note LIKE ?`)
        .get(account, `import:cartola|1801-03|%${PREFIX}%`) as { id: number; occurred_on: string };
      expect(official.occurred_on).toBe("1801-03-15");
      expect(bankPostedOn(official.id, account)).toBe("1801-03-16");
      // A later listing that still shows the row is covered by the cartola, on the bank's day.
      expect(importCheckingPartialMovements(account, [late], readOnChileDay("1801-03-17"))).toMatchObject({
        inserted: 0,
        skipped_superseded_by_cartola: 1,
      });
    } finally {
      db.prepare(`DELETE FROM movements WHERE account_id = ? AND note LIKE ?`).run(account, `import:cartola|1801-03|%`);
      db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ? AND period_month = '1801-03'`).run(account);
    }
  });

  it("across a month boundary, the month table still files it in the bank's month", () => {
    cleanup();
    const account = checkingId();
    const late = row("1801-05-01", -7_000, "after cutoff on the 30th");
    const aprilBefore = checkingMovementBalanceAtMonthEnd(account, "1801-04");
    const mayBefore = checkingMovementBalanceAtMonthEnd(account, "1801-05");
    importCheckingPartialMovements(account, [late], readOnChileDay("1801-04-30"));
    expect(stored(account, late)!.occurred_on).toBe("1801-04-30");
    expect(nonAnchorClpFlowTotals(account, { fromYmd: "1801-04-01", toYmd: "1801-04-30" }).net_clp).toBe(0);
    expect(nonAnchorClpFlowTotals(account, { fromYmd: "1801-05-01", toYmd: "1801-05-31" }).net_clp).toBe(-7_000);
    expect(checkingMovementBalanceAtMonthEnd(account, "1801-04")).toBe(aprilBefore);
    expect(checkingMovementBalanceAtMonthEnd(account, "1801-05")).toBe(mayBefore - 7_000);
  });

  it("a peso listing without the instant it was read is refused", () => {
    const payload: BankAccountMovementsPayload = {
      account: { issuer: "santander", product: "checking", currency: "clp" },
      movements: [{ date: "1801-03-16", description: `${PREFIX} x`, currency: "clp", amount: -1, document_no: null, wire_reference: null }],
      rejected_rows: [],
    };
    let err: unknown = null;
    try {
      applyBankAccountMovements(payload, `${PREFIX}.xlsx`, undefined);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(IngestRefusal);
    expect((err as IngestRefusal).code).toBe("missing_fetched_at");
    expect(stored(checkingId(), row("1801-03-16", -1, "x"))).toBeUndefined();
  });
});

describe("re-dating rows stored before the fetch-day rule", () => {
  it("re-dates a daily row and a cartola row from the earliest listing that showed them", () => {
    cleanup();
    const account = checkingId();
    const daily = row("1801-06-11", -3_000, "daily stored on bank day");
    const replaced = row("1801-06-12", -4_000, "replaced by cartola");
    // As the import stored them before the rule: on the bank's day.
    for (const mv of [daily]) {
      db.prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, ?, 'clp', ?, ?)`).run(
        account,
        mv.amount_clp,
        mv.occurred_on,
        partialMovementNote(mv)
      );
    }
    const cartola: ParsedCheckingCartola = {
      source_file: `${PREFIX}-cartola-06.xlsx`,
      period_month: "1801-06",
      period_from: "1801-06-01",
      period_to: "1801-06-30",
      saldo_inicial_clp: 50_000,
      saldo_final_clp: 46_000,
      movements: [{ occurred_on: "1801-06-12", amount_clp: -4_000, branch: "Agustinas", description: replaced.description, document_no: "" }],
      skipped: [],
      notes: [],
    };
    try {
      importCheckingCartola(account, cartola);
      const listings = [
        // A later listing alone would not prove an earlier read; the earliest decides.
        { source: "late", account_id: account, fetched_at: readOnChileDay("1801-06-13").fetchedAt, rows: [daily, replaced] },
        { source: "early", account_id: account, fetched_at: readOnChileDay("1801-06-10").fetchedAt, rows: [daily] },
        { source: "early-2", account_id: account, fetched_at: readOnChileDay("1801-06-11").fetchedAt, rows: [replaced] },
      ];
      const plan = planForwardPostedRedates(listings);
      expect(plan.redates.map((r) => [r.row_kind, r.bank_date, r.new_occurred_on, r.evidence])).toEqual([
        ["daily_listing", "1801-06-11", "1801-06-10", "early"],
        ["cartola", "1801-06-12", "1801-06-11", "early-2"],
      ]);
      applyForwardPostedRedates(plan.redates);
      const d = stored(account, daily)!;
      expect(d.occurred_on).toBe("1801-06-10");
      expect(bankPostedOn(d.id, account)).toBe("1801-06-11");
      // Applied once: a second plan finds nothing left to move.
      const again = planForwardPostedRedates(listings);
      expect(again.redates).toEqual([]);
      expect(again.skipped.map((s) => s.reason)).toEqual(["already_redated", "already_redated"]);
    } finally {
      db.prepare(`DELETE FROM movements WHERE account_id = ? AND note LIKE ?`).run(account, `import:cartola|1801-06|%`);
      db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ? AND period_month = '1801-06'`).run(account);
    }
  });
});
