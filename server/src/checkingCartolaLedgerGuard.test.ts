import { describe, expect, it } from "vitest";
import type { BankAccountStatementsPayload } from "nw-tracker-contracts";
import { db } from "./db.js";
import { finishCartolaImportRun, importCartolaList, checkingAccountId } from "./checkingCartolaImport.js";
import type { ParsedCheckingCartola, ParsedCheckingMovement } from "./checkingCartolaParse.js";
import type { CheckingCartolaFileImportLog } from "./checkingCartolaParseLog.js";
import { importCheckingPartialMovements } from "./checkingPartialMovementsImport.js";
import { storedCheckingLedgerAnchor } from "./checkingCartolaBalances.js";
import { cartolaMonthListingOnFile } from "./checkingCartolaCrossCheck.js";
import { cartolaCoversWholeMonth } from "./checkingCartolaMonthBounds.js";
import { applyBankAccountStatements } from "./bankAccountStatementsApply.js";
import { convertMirrorPairs } from "./movementMirrorConvert.js";
import { deleteMovements, insertMovement } from "./movementWrites.js";
import { READ_AFTER_ROWS } from "./test/listingFetch.js";
import { agreeingCartolaBalances } from "./test/cartolaFixtureBalances.js";
import { rolledBack } from "./ingestReceiver.js";
import { clearAggregationCache } from "./cacheRegistry.js";

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

  it("an opening the ledger does not reach (an earlier movement missing) is refused with expected and found", inRollback(() => {
    const account = createAccount("opening");
    run(account, [JAN()]);
    febDailyRows(account);
    run(account, [FEB()]);
    const compraC = rows(account).find((r) => r.amount === -5_000)!;
    deleteMovements([compraC.id]);
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
  const pdfMoves = () => FEB_MOVES().map((m) => ({ ...m, description: m.description.toUpperCase().replace("COMPRA", "COMPRÁ") }));

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
