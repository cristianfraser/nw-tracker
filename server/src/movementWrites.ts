/**
 * The movements write funnel (docs/untangle-plan.md F11): the one writer of the `movements` table
 * (`movementWritesGuard.test.ts`). A row inserted ({@link insertMovement}; a bank's peso row with
 * its retired flow taken back, {@link insertBankPesoMovement}), deleted, re-dated with the bank's
 * day kept as its posting day, or restated in place by the few shapes the writers need.
 *
 * Beyond what its name says, a function writes its row and nothing else. The mark-input and write-log triggers see each
 * write (docs/cache-registry.md) and the `flow_movements_ai` trigger gives a new row its flow; a
 * posting, an evidence record or a side table is the caller's. What a write still owes is the
 * expense deposit-link re-sync (`expenseAssignmentWrites.ts`), which an import asks for once, at its
 * end ({@link movementWrite}); writers that never asked for it (routes, mirror converters, brokers,
 * pensions, the demo generator) call the functions bare.
 *
 * Every function takes the database handle its caller writes through (the checking importers also
 * run against a script's handle).
 */
import type { Database, Statement } from "better-sqlite3";
import { HOME_CURRENCY } from "nw-tracker-contracts/dto/apiConstants";
import { db } from "./db.js";
import { recordBankPosting, type OccurredOnBasis } from "./movementBankPostings.js";
import { requestExpenseLinkSync, withExpenseLinkSyncDeferred } from "./expenseLinkSync.js";
import { adoptRetiredMovementFlow, type RetiredMovementAdoption } from "./flows/flowAdoption.js";
import { recordMovementFlowFirstSeen } from "./flows/flowFirstSeen.js";
import { recordBankListingFacts, type BankListingFacts } from "./movementListingFacts.js";
import { signedClpDeltaForAccountMovement, type MovementTransferRow } from "./movementTransfer.js";

/**
 * Runs an import's movement writes; the expense deposit links re-sync once when it ends — unless it
 * wrote nothing (a document already on file as it states), which leaves every link as it was.
 */
export function movementWrite<T>(body: () => T): T {
  const changes = () => (db.prepare(`SELECT total_changes() AS n`).get() as { n: number }).n;
  return withExpenseLinkSyncDeferred(() => {
    const before = changes();
    const result = body();
    if (changes() !== before) requestExpenseLinkSync();
    return result;
  });
}

type MovementCommon = {
  /**
   * The id the row takes: only a repair that restores a row under the id its keys were written
   * against (a mirror conversion undone by script) names one; every other row gets the next id.
   */
  id?: number;
  /** Single-leg pesos are signed; a transfer and a single-leg foreign row are positive (direction in `flowKind`). */
  amount: number;
  currency: string;
  occurredOn: string;
  note?: string | null;
  /** A decimal string, as a broker document printed the units, is bound as it is. */
  unitsDelta?: number | string | null;
  flowKind?: string | null;
};

/** A row on one account. */
export type SingleLegMovement = MovementCommon & { accountId: number };

/**
 * A transfer between two accounts. `counterAmount` + `counterCurrency` are the to-leg of a
 * cross-currency transfer (both or neither, never the from-leg's currency); `counterUnitsDelta`
 * the to-leg's units when both sides move units.
 */
export type TransferMovement = MovementCommon & {
  fromAccountId: number;
  toAccountId: number;
  counterAmount?: number | null;
  counterCurrency?: string | null;
  counterUnitsDelta?: number | null;
};

export type MovementInsert = SingleLegMovement | TransferMovement;

function isTransfer(row: MovementInsert): row is TransferMovement {
  return "fromAccountId" in row || "toAccountId" in row;
}

const INSERT_MOVEMENT_SQL = `INSERT INTO movements (
   account_id, from_account_id, to_account_id, amount, currency, counter_amount, counter_currency,
   occurred_on, note, units_delta, counter_units_delta, flow_kind
 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const INSERT_MOVEMENT_WITH_ID_SQL = INSERT_MOVEMENT_SQL.replace("INSERT INTO movements (", "INSERT INTO movements (\n   id,").replace("VALUES (?,", "VALUES (?, ?,");
const insertStatements = new WeakMap<Database, Statement>();
const insertWithIdStatements = new WeakMap<Database, Statement>();

function insertWithIdStatement(dbHandle: Database): Statement {
  let stmt = insertWithIdStatements.get(dbHandle);
  if (!stmt) {
    stmt = dbHandle.prepare(INSERT_MOVEMENT_WITH_ID_SQL);
    insertWithIdStatements.set(dbHandle, stmt);
  }
  return stmt;
}

function insertStatement(dbHandle: Database): Statement {
  let stmt = insertStatements.get(dbHandle);
  if (!stmt) {
    stmt = dbHandle.prepare(INSERT_MOVEMENT_SQL);
    insertStatements.set(dbHandle, stmt);
  }
  return stmt;
}

/**
 * Inserts one movement and returns its id: the one INSERT on `movements`
 * (`movementWritesGuard.test.ts`). The shape the table's CHECKs require is checked here, so a bad
 * row fails naming what is wrong. It writes the row and its flow's first-seen stamp
 * (`flows/flowFirstSeen.ts`) and nothing else: the flow row is the `flow_movements_ai` trigger's,
 * and a posting, an evidence record or a link sync is the caller's.
 */
export function insertMovement(row: MovementInsert, dbHandle: Database = db): number {
  if (!Number.isFinite(row.amount)) throw new Error(`movement: amount ${row.amount} is not a number`);
  if (!row.currency) throw new Error("movement: no currency");
  if (!row.occurredOn) throw new Error("movement: no day");
  let params: unknown[];
  if (isTransfer(row)) {
    if ("accountId" in row) throw new Error("movement: a transfer names two accounts, not an account of its own");
    if (row.fromAccountId == null || row.toAccountId == null) {
      throw new Error("movement: a transfer needs both accounts");
    }
    if (row.fromAccountId === row.toAccountId) {
      throw new Error(`movement: a transfer from account ${row.fromAccountId} to itself`);
    }
    const counterAmount = row.counterAmount ?? null;
    const counterCurrency = row.counterCurrency ?? null;
    if ((counterAmount == null) !== (counterCurrency == null)) {
      throw new Error("movement: a counter leg is an amount and a currency, both or neither");
    }
    if (counterCurrency != null && counterCurrency === row.currency) {
      throw new Error(`movement: a counter leg in the transfer's own currency (${row.currency})`);
    }
    params = [
      null, row.fromAccountId, row.toAccountId, row.amount, row.currency, counterAmount, counterCurrency,
      row.occurredOn, row.note ?? null, row.unitsDelta ?? null, row.counterUnitsDelta ?? null, row.flowKind ?? null,
    ];
  } else {
    if (row.accountId == null) throw new Error("movement: no account");
    const stray = row as Partial<TransferMovement>;
    if (stray.counterAmount != null || stray.counterCurrency != null || stray.counterUnitsDelta != null) {
      throw new Error("movement: only a transfer carries a counter leg");
    }
    params = [
      row.accountId, null, null, row.amount, row.currency, null, null,
      row.occurredOn, row.note ?? null, row.unitsDelta ?? null, null, row.flowKind ?? null,
    ];
  }
  if (row.id != null && (!Number.isInteger(row.id) || row.id <= 0)) throw new Error(`movement: bad id ${row.id}`);
  const id =
    row.id != null
      ? Number(insertWithIdStatement(dbHandle).run(row.id, ...params).lastInsertRowid)
      : Number(insertStatement(dbHandle).run(...params).lastInsertRowid);
  recordMovementFlowFirstSeen(id, dbHandle);
  return id;
}

/**
 * A single-leg peso row a bank document lists (cartola, «últimos movimientos», a paste). Returns its
 * id. Its evidence states what the listing printed (`listed`, `movementListingFacts.ts`). A row whose
 * document was on file before (a cartola month re-imported, a daily row listed again) takes its
 * retired flow back (F9 step 4, `adoptRetiredMovementFlow`): every assignment returns with it.
 * Pairings that could not be decided go to `adoptions` for the import's report.
 */
export function insertBankPesoMovement(
  row: { accountId: number; amount: number; occurredOn: string; note: string; flowKind: string | null; listed: BankListingFacts },
  dbHandle: Database = db,
  adoptions?: NonNullable<RetiredMovementAdoption>[]
): number {
  const id = insertMovement(
    { accountId: row.accountId, amount: row.amount, currency: HOME_CURRENCY, occurredOn: row.occurredOn, note: row.note, flowKind: row.flowKind },
    dbHandle
  );
  recordBankListingFacts(id, row.listed, dbHandle);
  const adopted = adoptRetiredMovementFlow(id, dbHandle);
  if (adopted) adoptions?.push(adopted);
  return id;
}

/**
 * A row replacing another (the same money: a cartola row, a transfer leg or a mail row listing a
 * daily row) that a record outside the flows names by id as the money it describes: the payslip a
 * daily salary row paid (the link references movements without a cascade, so a row still carrying
 * one cannot be deleted), a payslip's advance paid by that row (a kept row naming it already keeps
 * its own), and a broker withdrawal booked onto the row (`incoming_wire_bookings`, whose transfer the
 * dollar cost lots require; its fee row is another movement). Everything on the flow follows through
 * adoption.
 */
export function repointMovementReferences(fromId: number, toId: number, dbHandle: Database = db): void {
  repointTaxSettlements(fromId, toId, dbHandle);
  dbHandle.prepare(`UPDATE payroll_work_earnings SET movement_id = ? WHERE movement_id = ?`).run(toId, fromId);
  dbHandle.prepare(`UPDATE OR IGNORE payslip_advances SET movement_id = ? WHERE movement_id = ?`).run(toId, fromId);
  dbHandle.prepare(`DELETE FROM payslip_advances WHERE movement_id = ?`).run(fromId);
  dbHandle.prepare(`UPDATE incoming_wire_bookings SET transfer_movement_id = ? WHERE transfer_movement_id = ?`).run(toId, fromId);
}

/**
 * A tax settlement that names a row the import folds away or removes, refused: it can only move to
 * a row that moves the same pesos on its account (and, for the 1040, one no other settlement names).
 */
export class TaxSettlementRepointError extends Error {
  constructor(
    readonly table: "f22_settlements" | "us_f1040_settlements",
    readonly taxYear: number,
    readonly fromId: number,
    readonly toId: number,
    reason: string
  ) {
    super(`${table} of tax year ${taxYear} names movement ${fromId}, which the import replaces by movement ${toId}: ${reason}`);
  }
}

/**
 * The F22 and 1040 settlements naming `fromId` name `toId` instead (the row that records the same
 * money once `fromId` goes: a fold, a daily row a transfer leg or mail row lists). The settlement
 * keeps its account, day and pesos; `toId` must move those pesos on that account
 * (`signedClpDeltaForAccountMovement`), else `TaxSettlementRepointError`.
 */
function repointTaxSettlements(fromId: number, toId: number, dbHandle: Database): void {
  const movement = dbHandle.prepare(`SELECT account_id, from_account_id, to_account_id, amount, currency, counter_amount, counter_currency, occurred_on, note, units_delta, flow_kind FROM movements WHERE id = ?`);
  for (const table of ["f22_settlements", "us_f1040_settlements"] as const) {
    const rows = dbHandle.prepare(`SELECT id, tax_year, account_id FROM ${table} WHERE movement_id = ?`).all(fromId) as { id: number; tax_year: number; account_id: number }[];
    for (const r of rows) {
      const from = movement.get(fromId) as MovementTransferRow | undefined;
      const to = movement.get(toId) as MovementTransferRow | undefined;
      if (!from || !to) throw new TaxSettlementRepointError(table, r.tax_year, fromId, toId, "a row is gone");
      const touches = to.account_id === r.account_id || to.from_account_id === r.account_id || to.to_account_id === r.account_id;
      if (!touches) throw new TaxSettlementRepointError(table, r.tax_year, fromId, toId, `movement ${toId} is not on the settlement's account ${r.account_id}`);
      const a = Math.round(signedClpDeltaForAccountMovement(from, r.account_id));
      const b = Math.round(signedClpDeltaForAccountMovement(to, r.account_id));
      if (a !== b) throw new TaxSettlementRepointError(table, r.tax_year, fromId, toId, `it moves ${b} CLP on the account, the settled row ${a}`);
      if (table === "us_f1040_settlements" && dbHandle.prepare(`SELECT 1 FROM us_f1040_settlements WHERE movement_id = ?`).get(toId) != null) {
        throw new TaxSettlementRepointError(table, r.tax_year, fromId, toId, `another 1040 settlement already names movement ${toId}`);
      }
      dbHandle.prepare(`UPDATE ${table} SET movement_id = ? WHERE id = ?`).run(toId, r.id);
    }
  }
}

/**
 * Records outside the flows that name a movement by id and go with it (a cascade) or block its
 * delete, beyond what {@link repointMovementReferences} moves and the row's own bank posting and
 * mirror-pair refusals: a superseding row's import reports them. They stay: a loan payment, a
 * pension period, an event time and a dividend detail name rows of a loan, pension or broker
 * account, never a checking row a cartola folds; a transfer notice pairing decides its row's
 * evidence kind (`mail_notice`), and the kept row carries its own pairing; a booked withdrawal's fee
 * row is not the money the kept row lists; a tax settlement blocks the delete (the row is left alone).
 */
const MOVEMENT_RECORD_REFERENCES: readonly { table: string; column: string }[] = [
  { table: "loan_payments", column: "movement_id" },
  { table: "payslip_advances", column: "movement_id" },
  { table: "pension_contribution_periods", column: "movement_id" },
  { table: "movement_transfer_notices", column: "movement_id" },
  { table: "transfer_notice_movements", column: "movement_id" },
  { table: "movement_event_times", column: "movement_id" },
  { table: "movement_dividend_details", column: "movement_id" },
  { table: "incoming_wire_bookings", column: "transfer_movement_id" },
  { table: "incoming_wire_bookings", column: "fee_movement_id" },
  { table: "f22_settlements", column: "movement_id" },
  { table: "us_f1040_settlements", column: "movement_id" },
];

/** The tables of {@link MOVEMENT_RECORD_REFERENCES} holding a row that names `movementId`. */
export function movementRecordsNaming(movementId: number, dbHandle: Database = db): string[] {
  return [
    ...new Set(
      MOVEMENT_RECORD_REFERENCES.filter(
        ({ table, column }) => dbHandle.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`).get(movementId) != null
      ).map((r) => r.table)
    ),
  ];
}

/** Deletes movements another row supersedes; returns how many went. */
export function deleteMovements(ids: readonly number[], dbHandle: Database = db): number {
  const del = dbHandle.prepare(`DELETE FROM movements WHERE id = ?`);
  let n = 0;
  for (const id of ids) n += del.run(id).changes;
  return n;
}

/** Deletes the account's single-leg rows whose note matches a LIKE pattern; returns how many went. */
export function deleteAccountMovementsByNote(accountId: number, noteLike: string, dbHandle: Database = db): number {
  return dbHandle.prepare(`DELETE FROM movements WHERE account_id = ? AND note LIKE ?`).run(accountId, noteLike).changes;
}

/** Deletes every single-leg row of an account (a ledger wipe before a reload); returns how many went. */
export function deleteAccountMovements(accountId: number, dbHandle: Database = db): number {
  return dbHandle.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId).changes;
}

/** Sets the units a row moves (a ledger row re-priced from its document). */
export function setMovementUnits(movementId: number, unitsDelta: number | null, dbHandle: Database = db): void {
  dbHandle.prepare(`UPDATE movements SET units_delta = ? WHERE id = ?`).run(unitsDelta, movementId);
}

/** Restates a derived row's amount, currency, day and note in place (the checking ledger anchor). */
export function restateMovementAmount(
  movementId: number,
  row: { amount: number; currency: string; occurredOn: string; note: string | null },
  dbHandle: Database = db
): void {
  dbHandle
    .prepare(`UPDATE movements SET amount = ?, currency = ?, occurred_on = ?, note = ? WHERE id = ?`)
    .run(row.amount, row.currency, row.occurredOn, row.note, movementId);
}

/** Restates a derived units row's amount, units, kind and note in place (a statement true-up re-measured). */
export function restateMovementUnits(
  movementId: number,
  row: { amount: number; unitsDelta: number | null; flowKind: string | null; note: string | null },
  dbHandle: Database = db
): void {
  dbHandle
    .prepare(`UPDATE movements SET amount = ?, units_delta = ?, flow_kind = ?, note = ? WHERE id = ?`)
    .run(row.amount, row.unitsDelta, row.flowKind, row.note, movementId);
}

/**
 * Restates a bank row in place from the document that now lists it (a daily-listing row its cartola
 * lists: `checkingCartolaRestate.ts`): the row takes the document's note (its identity) and flow
 * kind; its id, amount and day stay. Throws when the row is gone.
 */
export function restateBankRowDocument(movementId: number, row: { note: string; flowKind: string | null }, dbHandle: Database = db): void {
  const changes = dbHandle.prepare(`UPDATE movements SET note = ?, flow_kind = ? WHERE id = ?`).run(row.note, row.flowKind, movementId).changes;
  if (changes !== 1) throw new Error(`movement ${movementId}: no row to restate`);
}

/**
 * Turns an unpaired single-leg row into a transfer in place (a bank credit that a mail says came
 * from another of the person's accounts): the row keeps its id, amount and currency, takes the two
 * accounts, the note and the units, and the day when one is given. Returns whether a row changed
 * (false: the row is gone or is already a transfer).
 */
export function promoteSingleLegToTransfer(
  movementId: number,
  row: {
    fromAccountId: number;
    toAccountId: number;
    note: string | null;
    unitsDelta: number | string | null;
    occurredOn: string | null;
  },
  dbHandle: Database = db
): boolean {
  const changes = dbHandle
    .prepare(
      `UPDATE movements
       SET account_id = NULL, from_account_id = ?, to_account_id = ?, note = ?, units_delta = ?,
           occurred_on = COALESCE(?, occurred_on)
       WHERE id = ? AND from_account_id IS NULL AND to_account_id IS NULL`
    )
    .run(row.fromAccountId, row.toAccountId, row.note, row.unitsDelta, row.occurredOn, movementId).changes;
  return changes === 1;
}

/**
 * Moves a movement to the day the money moved (`occurred_on`), keeping the day a bank document
 * filed it on the account as its posting day (`movement_bank_postings`), which reconciliation reads.
 * `basis` says what the new day rests on (default `evidence`; `fetch` for a listing's fetch day).
 */
export function redateMovementKeepingBankDay(
  row: { movementId: number; accountId: number; occurredOn: string; bankPostedOn: string; basis?: OccurredOnBasis },
  dbHandle: Database = db
): void {
  dbHandle.prepare(`UPDATE movements SET occurred_on = ? WHERE id = ?`).run(row.occurredOn, row.movementId);
  recordBankPosting(row.movementId, row.accountId, row.bankPostedOn, dbHandle, row.basis ?? "evidence");
}
