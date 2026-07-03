import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { importCheckingCartola } from "./checkingCartolaImport.js";
import type { ParsedCheckingCartola } from "./checkingCartolaParse.js";
import { movementNote } from "./checkingCartolaParse.js";
import {
  importCheckingPartialMovements,
  partialMovementNote,
} from "./checkingPartialMovementsImport.js";

function testCheckingAccountId(): number | null {
  const row = db
    .prepare(
      `SELECT a.id FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE g.slug LIKE '%cuenta_corriente%' LIMIT 1`
    )
    .get() as { id: number } | undefined;
  return row?.id ?? null;
}

describe("checking import flow lists (inserted_flows / skipped_flows)", () => {
  it("partial import reports inserted and duplicate flows", () => {
    const accountId = testCheckingAccountId();
    if (accountId == null) return;

    const existing = {
      occurred_on: "1799-05-10",
      amount_clp: -11_111,
      description: "vitest-flow existing partial",
      document_no: "",
    };
    const fresh = {
      occurred_on: "1799-05-12",
      amount_clp: -22_222,
      description: "vitest-flow fresh partial",
      document_no: "",
    };
    const notes = [partialMovementNote(existing), partialMovementNote(fresh)];
    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note IN (?, ?)`).run(
      accountId,
      ...notes
    );
    db.prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
       VALUES (?, ?, ?, ?, NULL)`
    ).run(accountId, existing.amount_clp, existing.occurred_on, notes[0]);

    const result = importCheckingPartialMovements(accountId, [existing, fresh]);
    expect(result.inserted).toBe(1);
    expect(result.skipped_duplicate).toBe(1);
    expect(result.inserted_flows).toEqual([
      { occurred_on: fresh.occurred_on, description: fresh.description, amount_clp: fresh.amount_clp },
    ]);
    expect(result.skipped_flows).toEqual([
      {
        occurred_on: existing.occurred_on,
        description: existing.description,
        amount_clp: existing.amount_clp,
        reason: "duplicate",
      },
    ]);

    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note IN (?, ?)`).run(
      accountId,
      ...notes
    );
  });

  it("partial import reports superseded_by_cartola flows", () => {
    const accountId = testCheckingAccountId();
    if (accountId == null) return;

    const periodMonth = "1799-06";
    const mv = {
      occurred_on: "1799-06-27",
      amount_clp: -27_282,
      description: "vitest-flow superseded",
      document_no: "",
    };
    const officialNote = movementNote(periodMonth, "Agustinas", mv.description, "", {
      occurredOn: mv.occurred_on,
      amountClp: mv.amount_clp,
      cartolaIndex: 0,
    });
    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note = ?`).run(
      accountId,
      officialNote
    );
    db.prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
       VALUES (?, ?, ?, ?, NULL)`
    ).run(accountId, mv.amount_clp, mv.occurred_on, officialNote);

    const result = importCheckingPartialMovements(accountId, [mv]);
    expect(result.inserted).toBe(0);
    expect(result.inserted_flows).toEqual([]);
    expect(result.skipped_flows).toEqual([
      {
        occurred_on: mv.occurred_on,
        description: mv.description,
        amount_clp: mv.amount_clp,
        reason: "superseded_by_cartola",
      },
    ]);

    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note = ?`).run(
      accountId,
      officialNote
    );
  });

  it("cartola import reports inserted flows, then duplicates on re-import", () => {
    const accountId = testCheckingAccountId();
    if (accountId == null) return;

    const periodMonth = "1799-07";
    const movements = [
      {
        occurred_on: "1799-07-05",
        amount_clp: -10_000,
        branch: "Agustinas",
        description: "vitest-flow cartola A",
        document_no: "",
      },
      {
        occurred_on: "1799-07-20",
        amount_clp: 4_000,
        branch: "Agustinas",
        description: "vitest-flow cartola B",
        document_no: "",
      },
    ];
    const cartola: ParsedCheckingCartola = {
      source_file: "vitest-flow-lists.xlsx",
      period_month: periodMonth,
      period_from: "1799-07-01",
      period_to: "1799-07-31",
      saldo_inicial_clp: 50_000,
      saldo_final_clp: 44_000,
      movements,
      skipped: [],
      notes: [],
    };
    const cleanup = () => {
      db.prepare(
        `DELETE FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`
      ).run(accountId, periodMonth);
      db.prepare(`DELETE FROM movements WHERE account_id = ? AND note LIKE ?`).run(
        accountId,
        `import:cartola|${periodMonth}|%`
      );
    };
    cleanup();

    const first = importCheckingCartola(accountId, cartola);
    expect(first.movementsInserted).toBe(2);
    expect(first.inserted_flows).toEqual(
      movements.map((mv) => ({
        occurred_on: mv.occurred_on,
        description: mv.description,
        amount_clp: mv.amount_clp,
      }))
    );
    expect(first.skipped_flows).toEqual([]);

    const second = importCheckingCartola(accountId, cartola);
    expect(second.movementsInserted).toBe(0);
    expect(second.inserted_flows).toEqual([]);
    expect(second.skipped_flows.map((f) => f.reason)).toEqual(["duplicate", "duplicate"]);
    expect(second.skipped_flows.map((f) => f.description)).toEqual(
      movements.map((mv) => mv.description)
    );

    cleanup();
  });
});
