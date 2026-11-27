import { describe, expect, it } from "vitest";
import type { BankAccountStatementsPayload } from "nw-tracker-contracts";
import { db } from "./db.js";
import { CheckingLedgerRebuildRefused, checkingAccountId, finishCartolaImportRun, importCartolaList, importCheckingCartola, rebuildCheckingLedgerFromCartolas } from "./checkingCartolaImport.js";
import type { ParsedCheckingCartola, ParsedCheckingMovement } from "./checkingCartolaParse.js";
import type { CheckingCartolaFileImportLog } from "./checkingCartolaParseLog.js";
import { importCheckingPartialMovements } from "./checkingPartialMovementsImport.js";
import { ensureCheckingLedgerAnchor, storedCheckingLedgerAnchor } from "./checkingCartolaBalances.js";
import { checkingLedgerMonthsOffTheirCartolas } from "./checkingCartolaLedgerGuard.js";
import { cartolaMonthListingOnFile } from "./checkingCartolaCrossCheck.js";
import { cartolaCoversWholeMonth } from "./checkingCartolaMonthBounds.js";
import { applyBankAccountStatements } from "./bankAccountStatementsApply.js";
import { convertMirrorPairs } from "./movementMirrorConvert.js";
import { insertMovement } from "./movementWrites.js";
import { READ_AFTER_ROWS } from "./test/listingFetch.js";
import { agreeingCartolaBalances } from "./test/cartolaFixtureBalances.js";
import { rolledBack } from "./ingestReceiver.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { CHECKING_LEDGER_CONTRADICTED, CheckingLedgerContradictedError, guardCheckingLedgerWrite } from "./checkingLedgerWriteGuard.js";
import { supersedeImportedCheckingRowsForTransfer } from "./checkingTransferLegReconcile.js";

/**
 * The cartola import's ledger guard (`checkingCartolaLedgerGuard.ts`) and the second-document
 * cross-check (`checkingCartolaCrossCheck.ts`), on a synthetic checking account of three months
 * (1807-01 … 1807-03, Santander's DESDE = the previous month's close). Every case runs in a
 * rolled-back transaction.
 */
const TAG = "VITEST LEDGERGUARD";

const inRollback = (fn: () => void) => () => {
  try {
    rolledBack(fn);
  } finally {
    clearAggregationCache();
  }
};

function createAccount(name: string): number {
  const group = db
    .prepare(
      `SELECT a.asset_group_id AS id FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE g.slug LIKE '%cuenta_corriente%' ORDER BY a.id LIMIT 1`
    )
    .get() as { id: number } | undefined;
  if (!group) throw new Error("no checking group in the test person");
  const key = `import:panel|vitest-ledger-guard-${name}`;
  return Number(
    db.prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, ?, ?, ?)`).run(group.id, `Vitest · ${name}`, key, key).lastInsertRowid
  );
}

const mv = (day: string, amount: number, what: string, branch = "Agustinas"): ParsedCheckingMovement => ({
  occurred_on: day,
  amount_clp: amount,
  branch,
  description: `${TAG} ${what}`,
  document_no: "",
});

const PREV_CLOSE: Record<string, string> = { "1807-01": "1806-12-31", "1807-02": "1807-01-31", "1807-03": "1807-02-28" };
const MONTH_END: Record<string, string> = { "1807-01": "1807-01-31", "1807-02": "1807-02-28", "1807-03": "1807-03-31" };

function cartola(month: string, document: string, opening: number, movements: ParsedCheckingMovement[], over: Partial<ParsedCheckingCartola> = {}): ParsedCheckingCartola {
  return {
    source_file: document,
    period_month: month,
    period_from: PREV_CLOSE[month]!,
    period_to: MONTH_END[month]!,
    saldo_inicial_clp: opening,
    saldo_final_clp: opening + movements.reduce((s, m) => s + m.amount_clp, 0),
    movements,
    skipped: [],
    notes: [],
    ...over,
  };
}

const JAN = () => cartola("1807-01", "1807-01 cartola.xlsx", 100_000, [mv("1807-01-05", 50_000, "Sueldo"), mv("1807-01-20", -20_000, "Compra A")]);
const FEB_MOVES = () => [mv("1807-02-05", -10_000, "Compra B"), mv("1807-02-10", -5_000, "Compra C"), mv("1807-02-12", 7_000, "Abono D")];
const FEB = (document = "1807-02 cartola.xlsx", moves = FEB_MOVES()) => cartola("1807-02", document, 130_000, moves);
const MAR = () => cartola("1807-03", "1807-03 cartola.xlsx", 122_000, [mv("1807-03-03", -2_000, "Compra E")]);

/** The February daily listing, as the daily import writes it. */
function febDailyRows(account: number): void {
  importCheckingPartialMovements(
    account,
    FEB_MOVES().map((m) => ({ occurred_on: m.occurred_on, amount_clp: m.amount_clp, description: m.description, document_no: "" })),
    READ_AFTER_ROWS
  );
}

/** One import run (`importCartolaList` + `finishCartolaImportRun`), its file logs. */
function run(account: number, cartolas: ParsedCheckingCartola[], opts: { forceReimport?: boolean } = {}): CheckingCartolaFileImportLog[] {
  const logs: CheckingCartolaFileImportLog[] = [];
  importCartolaList(account, cartolas.map((c) => ({ cartola: c, label: c.source_file })), opts, logs);
  finishCartolaImportRun(account, {}, logs);
  return logs;
}

const rows = (account: number) =>
  db.prepare(`SELECT id, amount, occurred_on FROM movements WHERE account_id = ? AND note NOT LIKE 'import:cartola|anchor|%' ORDER BY id`).all(account) as {
    id: number;
    amount: number;
    occurred_on: string;
  }[];
const anchorOf = (account: number) => {
  const a = storedCheckingLedgerAnchor(account);
  return a == null ? null : { amount_clp: a.amount_clp, occurred_on: a.occurred_on };
};
const record = (account: number, month: string) =>
  db.prepare(`SELECT source_file, movement_count, confirmed_by_file FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`).get(account, month) as
    | { source_file: string; movement_count: number; confirmed_by_file: string | null }
    | undefined;

describe("the cartola ledger guard", () => {
  it("the incident: a cartola whose descriptions pair with none of the daily rows is refused, nothing written, the anchor unmoved", inRollback(() => {
    const account = createAccount("incident");
    run(account, [JAN()]);
    febDailyRows(account);
    const before = { rows: rows(account), anchor: anchorOf(account) };
    // The reader kept the branch in front of every description: no movement pairs with its daily row.
    const prefixed = FEB("1807-02 cartola.pdf", FEB_MOVES().map((m) => ({ ...m, description: `${m.branch} ${m.description}` })));
    const [log] = run(account, [prefixed]);
    expect(log!.status).toBe("refused");
    expect(log!.problems!.join("\n")).toMatch(/the ledger at 1807-02-28 reads 114000 CLP but the cartola's closing balance is 122000 CLP \(ledger − cartola = -8000\)/);
    expect(log!.error).toMatch(/^Cartola 1807-02 \(1807-02 cartola\.pdf\) refused/);
    expect(rows(account)).toEqual(before.rows);
    expect(anchorOf(account)).toEqual(before.anchor);
    expect(record(account, "1807-02")).toBeUndefined();
  }));

  it("a correct cartola of the same data imports, restating the daily rows in place, the anchor unmoved", inRollback(() => {
    const account = createAccount("correct");
    run(account, [JAN()]);
    febDailyRows(account);
    const daily = rows(account).filter((r) => r.occurred_on.startsWith("1807-02"));
    const anchor = anchorOf(account);
    const [log] = run(account, [FEB()]);
    expect([log!.status, log!.movements_imported]).toEqual(["imported", 0]);
    expect(rows(account).filter((r) => r.occurred_on.startsWith("1807-02")).map((r) => r.id)).toEqual(daily.map((r) => r.id));
    expect(anchorOf(account)).toEqual(anchor);
  }));

  it("the first cartola of a new account sets the anchor; a later cartola cannot move it", inRollback(() => {
    const account = createAccount("first");
    expect(anchorOf(account)).toBeNull();
    expect(run(account, [JAN()]).map((f) => f.status)).toEqual(["imported"]);
    expect(anchorOf(account)).toEqual({ amount_clp: 100_000, occurred_on: "1806-12-31" });
    febDailyRows(account);
    expect(run(account, [FEB()]).map((f) => f.status)).toEqual(["imported"]);
    // January again, forced, with one purchase of another amount: its own balances add up, but
    // February's no longer chain from it — the anchor would have to move to absorb it.
    const changed = cartola("1807-01", "1807-01 cartola.xlsx", 100_000, [mv("1807-01-05", 50_000, "Sueldo"), mv("1807-01-20", -25_000, "Compra A")]);
    const before = rows(account);
    const [log] = run(account, [changed], { forceReimport: true });
    expect(log!.status).toBe("refused");
    expect(log!.problems!.join("\n")).toMatch(/newest cartola \(1807-02\) no longer lands on its closing balance: the anchor would move from 100000 CLP on 1806-12-31 to 105000 CLP/);
    expect(anchorOf(account)).toEqual({ amount_clp: 100_000, occurred_on: "1806-12-31" });
    expect(rows(account)).toEqual(before);
  }));

  it("an opening the ledger does not reach (a movement missing before the month, a month with no cartola) is refused with expected and found", inRollback(() => {
    const account = createAccount("opening");
    run(account, [JAN()]);
    // February has no cartola on file, and its daily listing lacks «Compra C».
    importCheckingPartialMovements(
      account,
      FEB_MOVES().filter((m) => m.amount_clp !== -5_000).map((m) => ({ occurred_on: m.occurred_on, amount_clp: m.amount_clp, description: m.description, document_no: "" })),
      READ_AFTER_ROWS
    );
    const before = rows(account);
    const [log] = run(account, [MAR()]);
    expect(log!.status).toBe("refused");
    expect(log!.problems).toEqual([
      "the ledger at 1807-02-28 reads 127000 CLP but the cartola's opening balance is 122000 CLP (ledger − cartola = 5000) — a movement before the month is missing or extra; nothing of this cartola was written",
    ]);
    expect(rows(account)).toEqual(before);
    expect(record(account, "1807-03")).toBeUndefined();
  }));

  it("one bad cartola of a payload of two: the good one imports, the bad one is refused and reported", inRollback(() => {
    const account = createAccount("two");
    run(account, [JAN()]);
    febDailyRows(account);
    importCheckingPartialMovements(account, [{ occurred_on: "1807-03-03", amount_clp: -2_000, description: `${TAG} Compra E`, document_no: "" }], READ_AFTER_ROWS);
    const prefixedMarch = cartola("1807-03", "1807-03 cartola.pdf", 122_000, [mv("1807-03-03", -2_000, "Agustinas Compra E")]);
    const logs = run(account, [FEB(), prefixedMarch]);
    expect(logs.map((f) => [f.period_month, f.status])).toEqual([
      ["1807-02", "imported"],
      ["1807-03", "refused"],
    ]);
    expect(record(account, "1807-02")?.source_file).toBe("1807-02 cartola.xlsx");
    expect(record(account, "1807-03")).toBeUndefined();
    expect(logs[1]!.problems!.join("\n")).toMatch(/ledger − cartola = -2000/);
    // January's two rows, February's three and March's daily row: no duplicate written.
    expect(rows(account)).toHaveLength(6);
  }));

  it("the ingest kind reports a refused statement's problems in its details", inRollback(() => {
    const account = checkingAccountId();
    const month = "1806-04";
    const moves = [mv("1806-04-07", -9_000, "Pago Uno"), mv("1806-04-09", -1_000, "Pago Dos")];
    importCheckingPartialMovements(account, moves.map((m) => ({ occurred_on: m.occurred_on, amount_clp: m.amount_clp, description: m.description, document_no: "" })), READ_AFTER_ROWS);
    const period = { period_month: month, period_from: "1806-03-31", period_to: "1806-04-30" };
    const { opening, closing } = agreeingCartolaBalances(account, period, moves.map((m) => m.amount_clp));
    const payload: BankAccountStatementsPayload = {
      account: { issuer: "santander", product: "checking" },
      force_reimport: false,
      statements: [
        {
          document: `${month} vitest-ledger-guard.pdf`,
          ...period,
          opening_balance: opening,
          closing_balance: closing,
          month_closing_balances: null,
          movements: moves.map((m) => ({ date: m.occurred_on, branch: m.branch, description: `Agustinas ${m.description}`, document_no: "", amount: m.amount_clp })),
          skipped_rows: [],
          notes: [],
        },
      ],
      unreadable: [],
    };
    const details = applyBankAccountStatements(payload);
    expect(details.files.map((f) => f.status)).toEqual(["refused"]);
    expect(details.files[0]!.problems.join("\n")).toMatch(/ledger − cartola = 10000/);
    expect(details.report.some((l) => l.includes("REFUSED"))).toBe(true);
  }));
});

describe("a month on file and a second document", () => {
  /** January and February on file, February from the xlsx (the daily rows restated). */
  function febOnFile(name: string): number {
    const account = createAccount(name);
    run(account, [JAN()]);
    febDailyRows(account);
    run(account, [FEB()]);
    return account;
  }
  // Both readers store a cell in the one shared reading, so the PDF states the xlsx's text.
  const pdfMoves = () => FEB_MOVES();

  it("a second document stating the month alike writes nothing but the confirmation; it is the same document after", inRollback(() => {
    const account = febOnFile("confirm");
    const before = rows(account);
    const [log] = run(account, [FEB("1807-02 cartola.pdf", pdfMoves())]);
    expect(log!.status).toBe("confirmed");
    expect(record(account, "1807-02")).toEqual({ source_file: "1807-02 cartola.xlsx", movement_count: 3, confirmed_by_file: "1807-02 cartola.pdf" });
    expect(rows(account)).toEqual(before);
    expect(run(account, [FEB("1807-02 cartola.pdf", pdfMoves()), FEB()]).map((f) => f.status)).toEqual(["skipped_already_imported", "skipped_already_imported"]);
  }));

  it("a second document with an amount, a description or a row of its own is refused, every difference listed", inRollback(() => {
    const account = febOnFile("differs");
    const before = { rows: rows(account), record: record(account, "1807-02") };
    const moves = pdfMoves();
    const amount = FEB("1807-02 amount.pdf", moves.map((m, i) => (i === 1 ? { ...m, amount_clp: -6_000 } : m)));
    const description = FEB("1807-02 description.pdf", moves.map((m, i) => (i === 1 ? { ...m, description: `${TAG} Compra Z` } : m)));
    const extra = FEB("1807-02 extra.pdf", [...moves, mv("1807-02-20", 1_000, "Abono F")]);
    const logs = run(account, [amount, description, extra]);
    expect(logs.map((f) => f.status)).toEqual(["refused", "refused", "refused"]);
    expect(logs[0]!.problems).toEqual(["1807-02 closing_balance: on file 122000, document 121000", "1807-02 movement 2 amount: on file -5000, document -6000"]);
    expect(logs[1]!.problems).toEqual([`1807-02 movement 2 description: on file ${TAG} Compra C, document ${TAG} Compra Z`]);
    expect(logs[2]!.problems).toEqual([
      "1807-02 movement_count: on file 3, document 4",
      "1807-02 closing_balance: on file 122000, document 123000",
      `1807-02 movement 4 movement: on file —, document 1807-02-20 1000 «${TAG} Abono F»`,
    ]);
    expect({ rows: rows(account), record: record(account, "1807-02") }).toEqual(before);
  }));

  it("a description that differs only in case, an accent or a space is a difference: the text compares exactly", inRollback(() => {
    const account = febOnFile("exact-text");
    const variants = [(d: string) => d.toUpperCase(), (d: string) => d.replace("Compra", "Comprá"), (d: string) => d.replace(" Compra", "  Compra")];
    const logs = run(
      account,
      variants.map((v, k) => FEB(`1807-02 variant ${k}.pdf`, pdfMoves().map((m, i) => (i === 1 ? { ...m, description: v(m.description) } : m))))
    );
    expect(logs.map((f) => f.status)).toEqual(["refused", "refused", "refused"]);
    expect(logs.map((f) => f.problems?.length)).toEqual([1, 1, 1]);
    expect(logs[0]!.problems![0]).toMatch(/^1807-02 movement 2 description: on file .*Compra C, document .*COMPRA C$/);
  }));

  it("a month whose row was converted into a transfer still compares equal", inRollback(() => {
    const account = febOnFile("mirror");
    const other = createAccount("mirror-other");
    const credit = rows(account).find((r) => r.amount === 7_000)!;
    const debit = insertMovement({ accountId: other, amount: -7_000, currency: "clp", occurredOn: "1807-02-12", note: `${TAG} traspaso` });
    const { converted } = convertMirrorPairs([{ out_movement_id: debit, in_movement_id: credit.id }]);
    expect(converted).toHaveLength(1);
    expect([...cartolaMonthListingOnFile(account, "1807-02").values()].map((r) => r.kept_on)).toEqual(["cartola_row", "cartola_row", "converted_leg"]);
    expect(run(account, [FEB("1807-02 cartola.pdf", pdfMoves())]).map((f) => f.status)).toEqual(["confirmed"]);
  }));

  it("the same rows of one day in another order confirm the month, the order reported apart", inRollback(() => {
    const account = createAccount("order-day");
    run(account, [JAN()]);
    const x = mv("1807-02-10", -10_000, "Compra X");
    const y = mv("1807-02-10", -5_000, "Compra Y");
    const d = mv("1807-02-12", 7_000, "Abono D");
    run(account, [FEB("1807-02 cartola.xlsx", [x, y, d])]);
    const [log] = run(account, [FEB("1807-02 cartola.pdf", [y, x, d])]);
    expect([log!.status, log!.problems]).toEqual(["confirmed", undefined]);
    expect(log!.order_notes).toEqual([
      "1807-02 movement 1 of the document is movement 2 on file (same day)",
      "1807-02 movement 2 of the document is movement 1 on file (same day)",
    ]);
  }));

  it("a document covering part of a month keeps the fuller-replaces rule; a forced re-import replaces", inRollback(() => {
    const account = createAccount("partial");
    run(account, [JAN()]);
    febDailyRows(account);
    // A document whose period ends inside the month (it covers its first eleven days).
    const slice = cartola("1807-02", "1807-02 slice.pdf", 130_000, FEB_MOVES().slice(0, 2), { period_to: "1807-02-11" });
    expect(cartolaCoversWholeMonth(slice)).toBe(false);
    expect(run(account, [slice]).map((f) => f.status)).toEqual(["imported"]);
    // The whole month, fuller: it replaces the slice (the guards hold it to the ledger).
    expect(run(account, [FEB()]).map((f) => f.status)).toEqual(["imported"]);
    expect(record(account, "1807-02")?.source_file).toBe("1807-02 cartola.xlsx");
    // The slice again: a lesser document of the month, nothing written.
    expect(run(account, [slice]).map((f) => f.status)).toEqual(["skipped_already_imported"]);
    // Forced, another whole document replaces the month instead of cross-checking it.
    const forced = run(account, [FEB("1807-02 cartola.pdf", pdfMoves())], { forceReimport: true });
    expect(forced.map((f) => f.status)).toEqual(["imported"]);
    expect(record(account, "1807-02")).toEqual({ source_file: "1807-02 cartola.pdf", movement_count: 3, confirmed_by_file: null });
  }));
});

describe("the guard's frame: drift, order, the anchor at the run's end", () => {
  it("a ledger that already disagrees with its cartolas refuses the next cartola as drift, not as the cartola's fault", inRollback(() => {
    const account = createAccount("drift");
    run(account, [JAN()]);
    febDailyRows(account);
    run(account, [FEB()]);
    // A row in January written past every guard: the cartolas on file no longer derive the anchor.
    insertMovement({ accountId: account, amount: -3_000, currency: "clp", occurredOn: "1807-01-25", note: `${TAG} stray` });
    const [log] = run(account, [MAR()]);
    expect(log!.status).toBe("refused");
    expect(log!.problems!.join("\n")).toMatch(/the ledger already disagrees with the cartolas on file before this one: .*difference 3000\)/);
  }));

  it("an anchor that no longer matches at the run's end is reported as its own entry; the run's cartolas stay", inRollback(() => {
    const account = createAccount("finish");
    run(account, [JAN()]);
    insertMovement({ accountId: account, amount: -3_000, currency: "clp", occurredOn: "1807-01-25", note: `${TAG} stray` });
    const logs: CheckingCartolaFileImportLog[] = [{ file: "x.xlsx", period_month: "1807-01", status: "imported", movements_parsed: 0, movements_imported: 0, skipped_rows: [], saldo_final_clp: null, saldo_inicial_clp: null }];
    expect(() => finishCartolaImportRun(account, {}, logs)).not.toThrow();
    expect(logs.map((f) => [f.file, f.status])).toEqual([
      ["x.xlsx", "imported"],
      ["(ledger anchor)", "refused"],
    ]);
  }));

  it("an account's cartolas are imported oldest month first, whatever the payload's order", inRollback(() => {
    const account = createAccount("order");
    run(account, [JAN()]);
    febDailyRows(account);
    importCheckingPartialMovements(account, [{ occurred_on: "1807-03-03", amount_clp: -2_000, description: `${TAG} Compra E`, document_no: "" }], READ_AFTER_ROWS);
    expect(run(account, [MAR(), FEB()]).map((f) => [f.period_month, f.status])).toEqual([
      ["1807-02", "imported"],
      ["1807-03", "imported"],
    ]);
  }));
});

describe("a tax settlement on a row the import replaces", () => {
  it("moves to the row that records its money once a daily row folds into it", inRollback(() => {
    const account = createAccount("settle-fold");
    run(account, [JAN()]);
    febDailyRows(account);
    // A second listing of «Compra C» (the pending row re-listed): the cartola folds it into the first.
    importCheckingPartialMovements(account, [{ occurred_on: "1807-02-10", amount_clp: -5_000, description: `${TAG} Compra C Comercio`, document_no: "" }], READ_AFTER_ROWS);
    const twins = rows(account).filter((r) => r.amount === -5_000);
    db.prepare(`INSERT INTO f22_settlements (tax_year, kind, account_id, movement_id, occurred_on, amount, description) VALUES (1807, 'payment', ?, ?, '1807-02-10', 5000, 'vitest')`).run(account, twins[twins.length - 1]!.id);
    expect(run(account, [FEB("1807-02 cartola.xlsx", [FEB_MOVES()[0]!, mv("1807-02-10", -5_000, "Compra C Comercio"), FEB_MOVES()[2]!])]).map((f) => f.status)).toEqual(["imported"]);
    const kept = rows(account).filter((r) => r.amount === -5_000);
    expect(kept).toHaveLength(1);
    expect(db.prepare(`SELECT movement_id FROM f22_settlements WHERE tax_year = 1807`).get()).toEqual({ movement_id: kept[0]!.id });
  }));

  it("a replaced month's row the new cartola no longer lists is refused naming the row, the table and the tax year", inRollback(() => {
    const account = createAccount("settle-left");
    run(account, [JAN()]);
    febDailyRows(account);
    run(account, [FEB()]);
    const compraC = rows(account).find((r) => r.amount === -5_000)!;
    db.prepare(`INSERT INTO f22_settlements (tax_year, kind, account_id, movement_id, occurred_on, amount, description) VALUES (1807, 'payment', ?, ?, '1807-02-10', 5000, 'vitest')`).run(account, compraC.id);
    // Corrected February: the 5.000 on another day under other text — no row takes the settled one's money.
    const corrected = FEB("1807-02 cartola.xlsx", [FEB_MOVES()[0]!, mv("1807-02-11", -5_000, "Compra Z"), FEB_MOVES()[2]!]);
    const [log] = run(account, [corrected], { forceReimport: true });
    expect(log!.status).toBe("refused");
    expect(log!.problems).toEqual([
      `movement ${compraC.id} (1807-02-10, -5000 CLP) is named by f22_settlements of tax year 1807, and the cartola lists no movement for it: link the settlement to the row that records its money, then import again`,
    ]);
    expect(db.prepare(`SELECT movement_id FROM f22_settlements WHERE tax_year = 1807`).get()).toEqual({ movement_id: compraC.id });
  }));
});

describe("a hand movement on a cartola account (checkingLedgerWriteGuard)", () => {
  function threeMonths(name: string): number {
    const account = createAccount(name);
    run(account, [JAN()]);
    febDailyRows(account);
    run(account, [FEB(), MAR()]);
    return account;
  }
  const hand = (account: number, day: string, amount: number) => () => insertMovement({ accountId: account, amount, currency: "clp", occurredOn: day, note: `${TAG} hand` });

  it("one dated in a month a cartola states is refused, coded with the month, and rolled back", inRollback(() => {
    const account = threeMonths("hand-closed");
    const before = rows(account);
    let err: unknown;
    try {
      guardCheckingLedgerWrite([account], "1807-02-15", hand(account, "1807-02-15", -4_000));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CheckingLedgerContradictedError);
    expect((err as CheckingLedgerContradictedError).status).toBe(409);
    expect((err as CheckingLedgerContradictedError).fields).toEqual({ code: CHECKING_LEDGER_CONTRADICTED, account_id: account, month: "1807-02", difference: -4_000 });
    expect(rows(account)).toEqual(before);
  }));

  it("one after the newest cartola is written; an earlier drift is reported, never blamed on it", inRollback(() => {
    const account = threeMonths("hand-after");
    expect(guardCheckingLedgerWrite([account], "1807-04-05", hand(account, "1807-04-05", -4_000)).drift).toEqual([]);
    insertMovement({ accountId: account, amount: -3_000, currency: "clp", occurredOn: "1807-01-25", note: `${TAG} stray` });
    const { drift } = guardCheckingLedgerWrite([account], "1807-04-06", hand(account, "1807-04-06", -1_000));
    expect(drift).toEqual([{ account_id: account, stored_anchor_clp: 100_000, derived_anchor_clp: 103_000 }]);
  }));

  it("a transfer that supersedes the bank row it stands for nets to zero and is written", inRollback(() => {
    const account = threeMonths("hand-transfer");
    const other = createAccount("hand-transfer-other");
    const compraC = rows(account).find((r) => r.amount === -5_000)!;
    const { result } = guardCheckingLedgerWrite([account, other], "1807-02-10", () => {
      const id = insertMovement({ fromAccountId: account, toAccountId: other, amount: 5_000, currency: "clp", occurredOn: "1807-02-10" });
      return supersedeImportedCheckingRowsForTransfer(id, account, other, 5_000, "1807-02-10");
    });
    expect(result.removed_ids).toEqual([compraC.id]);
  }));
});

describe("the deliberate rebuild of a ledger that absorbed bad data", () => {
  /** The incident on a synthetic account: February written twice by a reader that kept the branch, the anchor moved to hide it. */
  function incident(name: string): number {
    const account = createAccount(name);
    run(account, [JAN()]);
    febDailyRows(account);
    const prefixed = FEB("1807-02 cartola.pdf", FEB_MOVES().map((m) => ({ ...m, description: `${m.branch} ${m.description}` })));
    importCheckingCartola(account, prefixed, db, { rebuild: true });
    ensureCheckingLedgerAnchor(account, db, { repin: true });
    return account;
  }

  it("the ordinary forced import refuses the repair; the rebuild restates the month, folds the copies away and pins the anchor back", inRollback(() => {
    const account = incident("rebuild");
    expect(anchorOf(account)).toEqual({ amount_clp: 108_000, occurred_on: "1806-12-31" });
    const daily = rows(account).filter((r) => r.occurred_on.startsWith("1807-02")).slice(0, 3);
    expect(run(account, [FEB("1807-02 cartola.pdf")], { forceReimport: true }).map((f) => f.status)).toEqual(["refused"]);
    const r = rebuildCheckingLedgerFromCartolas(account, [FEB("1807-02 cartola.pdf")]);
    expect(r.anchor_before).toEqual({ amount_clp: 108_000, occurred_on: "1806-12-31" });
    expect(r.anchor_after).toEqual({ amount_clp: 100_000, occurred_on: "1806-12-31" });
    expect(r.months).toEqual([
      { period_month: "1807-02", replaced: true, inserted: 0, restated: 3, folded: 0, removed: 0, cartola_rows_removed: 0, cartola_rows_folded: 3, fold_conflicts: [], restatement_carry: expect.objectContaining({ rows_changed: 0, own_categories: [], rules_passed: [] }) },
    ]);
    expect(rows(account).filter((x) => x.occurred_on.startsWith("1807-02")).map((x) => x.id)).toEqual(daily.map((x) => x.id));
    expect(checkingLedgerMonthsOffTheirCartolas(account)).toEqual([]);
  }));

  const flowOf = (id: number) => (db.prepare(`SELECT flow_id FROM movements WHERE id = ?`).get(id) as { flow_id: number }).flow_id;
  const copies = (account: number) =>
    db
      .prepare(
        `SELECT m.id, m.amount FROM movements m JOIN flow_evidence e ON e.source_table = 'movements' AND e.source_row_id = m.id
         WHERE m.account_id = ? AND e.source_kind = 'cartola' AND e.stated_period = '1807-02' ORDER BY m.id`
      )
      .all(account) as { id: number; amount: number }[];
  const fileNote = (account: number, id: number, text: string) =>
    db.prepare(`INSERT INTO flow_notes (flow_id, portion, piece_seq, account_id, notes) VALUES (?, 'gastos', -1, ?, ?)`).run(flowOf(id), account, text);
  const noteOf = (id: number) => (db.prepare(`SELECT notes FROM flow_notes WHERE flow_id = ?`).get(flowOf(id)) as { notes: string } | undefined)?.notes ?? null;
  const categoryOf = (id: number) => (db.prepare(`SELECT category_id FROM flow_categories WHERE flow_id = ?`).get(flowOf(id)) as { category_id: number } | undefined)?.category_id ?? null;

  it("what the user filed on a copy moves to the row that stays: its category, its note joined with the kept row's", inRollback(() => {
    const account = incident("rebuild-fold");
    const daily = rows(account).filter((r) => r.occurred_on.startsWith("1807-02")).slice(0, 3);
    const copy = copies(account).find((c) => c.amount === -10_000)!;
    const keptRow = daily.find((d) => d.amount === -10_000)!;
    const cat = (db.prepare(`SELECT id FROM cc_expense_categories ORDER BY id LIMIT 1`).get() as { id: number }).id;
    db.prepare(`INSERT INTO flow_categories (flow_id, portion, piece_seq, account_id, category_id) VALUES (?, 'gastos', -1, ?, ?)`).run(flowOf(copy.id), account, cat);
    fileNote(account, copy.id, "filed on the copy");
    fileNote(account, keptRow.id, "filed on the daily row");
    const r = rebuildCheckingLedgerFromCartolas(account, [FEB("1807-02 cartola.pdf")]);
    expect(r.months[0]!.cartola_rows_folded).toBe(3);
    expect(r.months[0]!.fold_conflicts).toEqual([{ row_id: keptRow.id, folded: [copy.id], notes_joined: "filed on the daily row\nfiled on the copy", dropped: [] }]);
    expect(rows(account).filter((x) => x.occurred_on.startsWith("1807-02")).map((x) => x.id)).toEqual(daily.map((x) => x.id));
    expect(categoryOf(keptRow.id)).toBe(cat);
    expect(noteOf(keptRow.id)).toBe("filed on the daily row\nfiled on the copy");
  }));

  it("a copy with filed work and no row of its day and pesos to fold into refuses the rebuild, naming it", inRollback(() => {
    const account = incident("rebuild-unfoldable");
    const copy = copies(account).find((c) => c.amount === 7_000)!;
    fileNote(account, copy.id, "filed on the copy");
    const before = { rows: rows(account), anchor: anchorOf(account) };
    // A cartola that no longer lists the 1807-02-12 credit.
    const without = FEB("1807-02 cartola.pdf", FEB_MOVES().filter((m) => m.amount_clp !== 7_000));
    expect(() => rebuildCheckingLedgerFromCartolas(account, [without])).toThrow(new RegExp(`cartola row ${copy.id} .*carries what the user filed`));
    expect({ rows: rows(account), anchor: anchorOf(account) }).toEqual(before);
  }));

  it("same-file ownership (the cuenta vista): another document's slice of a month on file is left out, its own document replaces it", inRollback(() => {
    const account = createAccount("rebuild-owner");
    run(account, [JAN(), FEB()]);
    const before = rows(account);
    const other = rebuildCheckingLedgerFromCartolas(account, [FEB("1807-02 other slice.pdf", FEB_MOVES().slice(0, 2))], db, { sameFileOnly: true });
    expect(other.months).toEqual([
      { period_month: "1807-02", replaced: false, inserted: 0, restated: 0, folded: 0, removed: 0, cartola_rows_removed: 0, cartola_rows_folded: 0, fold_conflicts: [], restatement_carry: null, owned_by: "1807-02 cartola.xlsx" },
    ]);
    expect(rows(account)).toEqual(before);
    // Without the rule the slice would replace the month and remove the row it does not list.
    const slice = FEB("1807-02 other slice.pdf", FEB_MOVES().slice(0, 2));
    expect(rolledBack(() => (rebuildCheckingLedgerFromCartolas(account, [slice]), rows(account).length))).toBe(before.length - 1);
    const own = rebuildCheckingLedgerFromCartolas(account, [FEB()], db, { sameFileOnly: true });
    expect(own.months[0]!.replaced).toBe(true);
    expect(rows(account)).toEqual(before);
  }));

  it("a rebuild that leaves a month off its cartola writes nothing", inRollback(() => {
    const account = incident("rebuild-refused");
    const before = { rows: rows(account), anchor: anchorOf(account) };
    const prefixed = FEB("1807-02 cartola.pdf", FEB_MOVES().map((m) => ({ ...m, description: `Agustinas ${m.description}` })));
    expect(() => rebuildCheckingLedgerFromCartolas(account, [prefixed])).toThrow(CheckingLedgerRebuildRefused);
    expect({ rows: rows(account), anchor: anchorOf(account) }).toEqual(before);
  }));
});

describe("whole-month coverage", () => {
  it("HASTA on the month's last bank day, on the next month's DESDE, later or none is the whole month; a HASTA before it is part", () => {
    // 2025-10-31 is a holiday and 2025-12-31 a bank holiday: the month closes the day before.
    expect(cartolaCoversWholeMonth({ period_month: "2025-10", period_from: "2025-09-30", period_to: "2025-10-30" })).toBe(true);
    expect(cartolaCoversWholeMonth({ period_month: "2025-12", period_from: "2025-11-28", period_to: "2025-12-30" })).toBe(true);
    expect(cartolaCoversWholeMonth({ period_month: "2025-10", period_from: "2025-09-30", period_to: "2025-10-29" })).toBe(false);
    // An older month the calendar knows no holiday of: the next month's DESDE states the close.
    expect(cartolaCoversWholeMonth({ period_month: "2019-10", period_from: "2019-09-30", period_to: "2019-10-30" })).toBe(false);
    expect(cartolaCoversWholeMonth({ period_month: "2019-10", period_from: "2019-09-30", period_to: "2019-10-30" }, "2019-10-30")).toBe(true);
    expect(cartolaCoversWholeMonth({ period_month: "2026-09", period_from: "2026-08-31", period_to: null })).toBe(true);
    expect(cartolaCoversWholeMonth({ period_month: "2026-09", period_from: "2026-09-12", period_to: "2026-09-30" })).toBe(false);
  });
});
