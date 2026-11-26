import { describe, expect, it } from "vitest";
import type { BankAccountStatement, BankAccountStatementsPayload } from "nw-tracker-contracts";
import { db } from "./db.js";
import { applyBankAccountStatements } from "./bankAccountStatementsApply.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { importCheckingPartialMovements, partialMovementNote } from "./checkingPartialMovementsImport.js";
import { insertBankPesoMovement } from "./movementWrites.js";
import { dailyListingFacts } from "./movementListingFacts.js";
import { READ_AFTER_ROWS } from "./test/listingFetch.js";
import { rolledBack } from "./ingestReceiver.js";
import { clearAggregationCache } from "./cacheRegistry.js";

/**
 * A cartola over the daily rows, through the ingest kind's apply (`applyBankAccountStatements`):
 * the rows the daily listing wrote are restated in place, the same cartola again writes nothing, a
 * month imported again from a corrected file keeps the rows it still lists, and two identical
 * movements stay two rows on two flows. Each case runs in a transaction that is rolled back: the
 * cartola run re-derives the account's opening anchor and clears its stored valuations.
 */
const MONTH = "1805-04";
const TAG = "VITEST KEEPROWS";

const mv = (date: string, amount: number, what: string) => ({ date, branch: "Agustinas", description: `${TAG} ${what}`, document_no: "", amount });

function statement(movements: ReturnType<typeof mv>[], opening = 500_000): BankAccountStatement {
  return {
    document: `vitest-keep-rows-${MONTH}.xlsx`,
    period_month: MONTH,
    period_from: `${MONTH}-01`,
    period_to: `${MONTH}-30`,
    opening_balance: opening,
    closing_balance: opening + movements.reduce((s, m) => s + m.amount, 0),
    month_closing_balances: null,
    movements,
    skipped_rows: [],
    notes: [],
  };
}

function payload(st: BankAccountStatement, force = false): BankAccountStatementsPayload {
  return { account: { issuer: "santander", product: "checking" }, force_reimport: force, statements: [st], unreadable: [] };
}

const rowsOfMonth = () =>
  db
    .prepare(
      `SELECT m.id, m.flow_id, m.amount, m.note FROM movements m WHERE m.account_id = ? AND m.note LIKE ? ORDER BY m.id`
    )
    .all(checkingAccountId(), `%${TAG}%`) as { id: number; flow_id: number; amount: number; note: string }[];

const changes = () => ({
  total: (db.prepare(`SELECT total_changes() AS n`).get() as { n: number }).n,
  logged: (db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM mark_input_changes`).get() as { n: number }).n,
});

const inRollback = (fn: () => void) => () => {
  try {
    rolledBack(fn);
  } finally {
    clearAggregationCache();
  }
};

describe("a checking cartola over the daily rows, through the cartola apply", () => {
  it("restates the daily rows in place, and the same cartola again writes nothing", inRollback(() => {
    const account = checkingAccountId();
    const daily = [
      { occurred_on: "1805-04-03", amount_clp: -12_000, description: `${TAG} Compra Uno`, document_no: "" },
      { occurred_on: "1805-04-05", amount_clp: -8_000, description: `${TAG} Compra Dos`, document_no: "" },
    ];
    importCheckingPartialMovements(account, daily, READ_AFTER_ROWS);
    const before = rowsOfMonth();
    expect(before).toHaveLength(2);

    const st = statement([mv("1805-04-03", -12_000, "Compra Uno"), mv("1805-04-05", -8_000, "Compra Dos"), mv("1805-04-07", -3_000, "Compra Tres")]);
    const first = applyBankAccountStatements(payload(st));
    expect(first.files.map((f) => [f.status, f.movements_imported])).toEqual([["imported", 1]]);
    const after = rowsOfMonth();
    // The daily rows are the cartola's rows now: same ids and flows, the cartola's notes.
    expect(after.slice(0, 2).map((r) => [r.id, r.flow_id])).toEqual(before.map((r) => [r.id, r.flow_id]));
    expect(after.every((r) => r.note.startsWith(`import:cartola|${MONTH}|`))).toBe(true);
    expect(after).toHaveLength(3);

    const mark = changes();
    const again = applyBankAccountStatements(payload(st));
    expect(again.files.map((f) => f.status)).toEqual(["skipped_already_imported"]);
    expect(changes()).toEqual(mark);
    expect(rowsOfMonth()).toEqual(after);
  }));

  it("a month imported again from a corrected file keeps the rows it still lists", inRollback(() => {
    const st = statement([mv("1805-04-03", -12_000, "Compra Uno"), mv("1805-04-05", -8_000, "Compra Dos")]);
    applyBankAccountStatements(payload(st));
    const before = rowsOfMonth();
    // The corrected cartola: the first movement as before, the second gone, a new one.
    const corrected = statement([mv("1805-04-03", -12_000, "Compra Uno"), mv("1805-04-09", -4_000, "Compra Cuatro")]);
    const r = applyBankAccountStatements(payload(corrected, true));
    expect(r.files.map((f) => f.status)).toEqual(["imported"]);
    const after = rowsOfMonth();
    expect(after.map((x) => x.amount)).toEqual([-12_000, -4_000]);
    expect([after[0]!.id, after[0]!.flow_id]).toEqual([before[0]!.id, before[0]!.flow_id]);
    expect(after.some((x) => x.id === before[1]!.id)).toBe(false);
  }));

  it("two identical movements of one day stay two rows on two flows", inRollback(() => {
    const account = checkingAccountId();
    const twin = { occurred_on: "1805-04-11", amount_clp: -5_000, description: `${TAG} Pago Twin`, document_no: "" };
    const ids = [0, 1].map(() =>
      insertBankPesoMovement({ accountId: account, amount: twin.amount_clp, occurredOn: twin.occurred_on, note: partialMovementNote(twin), flowKind: null, listed: dailyListingFacts(twin) })
    );
    const st = statement([mv("1805-04-11", -5_000, "Pago Twin"), mv("1805-04-11", -5_000, "Pago Twin")]);
    applyBankAccountStatements(payload(st));
    const after = rowsOfMonth();
    expect(after.map((x) => x.id)).toEqual(ids);
    expect(new Set(after.map((x) => x.flow_id)).size).toBe(2);
  }));

  it("more identical daily rows than cartola movements fail that cartola, naming the rows, and write nothing", inRollback(() => {
    const account = checkingAccountId();
    const twin = { occurred_on: "1805-04-12", amount_clp: -6_000, description: `${TAG} Pago Doble`, document_no: "" };
    const ids = [0, 1].map(() =>
      insertBankPesoMovement({ accountId: account, amount: twin.amount_clp, occurredOn: twin.occurred_on, note: partialMovementNote(twin), flowKind: null, listed: dailyListingFacts(twin) })
    );
    const before = rowsOfMonth();
    const r = applyBankAccountStatements(payload(statement([mv("1805-04-12", -6_000, "Pago Doble")])));
    expect(r.files.map((f) => f.status)).toEqual(["parse_error"]);
    expect(r.files[0]!.error).toMatch(new RegExp(`cannot pair the daily rows one to one, nothing was written: daily row ${ids[1]}`));
    expect(rowsOfMonth()).toEqual(before);
  }));
});
