import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import type { UsdAccountMovementsApplyDetails } from "nw-tracker-contracts";
import { accountIdForIssuerBankAccount, applyBankAccountMovements, assertListingNamesAccount } from "./bankAccountMovementsApply.js";

/**
 * The listing's own account number against `bank_account_numbers`. The rows are synthetic: a
 * number declared for the checking account (unless the DB already declares one, in which case
 * that one is read back) and one for another account, both removed afterwards.
 */
describe("assertListingNamesAccount", () => {
  const OWN = "009900112233";
  let accountId: number;
  let ownNumber: string;
  let insertedOwn = false;
  let otherAccountId: number;
  let insertedOther = false;

  beforeAll(() => {
    accountId = checkingAccountId();
    const existing = db.prepare(`SELECT number FROM bank_account_numbers WHERE account_id = ?`).get(accountId) as { number: string } | undefined;
    if (existing) {
      ownNumber = existing.number;
    } else {
      db.prepare(`INSERT INTO bank_account_numbers (account_id, issuer, number, currency) VALUES (?, 'santander', ?, 'clp')`).run(accountId, OWN);
      ownNumber = OWN;
      insertedOwn = true;
    }
    const other = db
      .prepare(
        `SELECT a.id FROM accounts a
         WHERE a.id <> ? AND a.id NOT IN (SELECT account_id FROM bank_account_numbers) ORDER BY a.id LIMIT 1`
      )
      .get(accountId) as { id: number } | undefined;
    if (!other) throw new Error("test DB has no second account");
    otherAccountId = other.id;
    db.prepare(`INSERT INTO bank_account_numbers (account_id, issuer, number, currency) VALUES (?, 'santander', ?, 'clp')`).run(
      otherAccountId,
      "009900998877"
    );
    insertedOther = true;
  });

  afterAll(() => {
    if (insertedOwn) db.prepare(`DELETE FROM bank_account_numbers WHERE account_id = ? AND number = ?`).run(accountId, OWN);
    if (insertedOther) db.prepare(`DELETE FROM bank_account_numbers WHERE account_id = ?`).run(otherAccountId);
  });

  it("accepts the declared number, leading zeros ignored, and a listing that names none", () => {
    const account = { issuer: "santander", product: "checking" as const, currency: "clp" as const };
    expect(() => assertListingNamesAccount(accountId, { ...account, number: ownNumber })).not.toThrow();
    expect(() => assertListingNamesAccount(accountId, { ...account, number: `00${ownNumber}` })).not.toThrow();
    expect(() => assertListingNamesAccount(accountId, { ...account, number: ownNumber.replace(/^0+/, "") })).not.toThrow();
    expect(() => assertListingNamesAccount(accountId, account)).not.toThrow();
  });

  it("refuses another declared account's number and a number that is not the account's", () => {
    const account = { issuer: "santander", product: "checking" as const, currency: "clp" as const };
    expect(() => assertListingNamesAccount(accountId, { ...account, number: "009900998877" })).toThrow(/not the number declared/);
    expect(() => assertListingNamesAccount(accountId, { ...account, number: "123456789012" })).toThrow(/not the number declared/);
    expect(() => assertListingNamesAccount(otherAccountId, { ...account, number: ownNumber })).toThrow(/declared for ledger account/);
  });
});

/**
 * A DOLLAR account's listing (v2): the rows the ledger holds from their documents are confirmed
 * (posting day recorded), an incoming wire not booked yet waits, anything else is unexplained —
 * nothing is ever inserted. Synthetic: a USD cash account under the USD savings bucket with a
 * declared number no real account carries, removed afterwards.
 */
describe("applyBankAccountMovements for a dollar account", () => {
  const NUMBER = "009900445566";
  const PREFIX = "vitest-usd-feed";
  let usdAccountId = 0;
  let brokerUsdId = 0;
  let cardId = 0;
  const createdAccounts: number[] = [];

  function account(name: string, groupSlug: string): number {
    const group = db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(groupSlug) as { id: number } | undefined;
    if (!group) throw new Error(`test DB has no asset group ${groupSlug}`);
    db.prepare(`INSERT INTO accounts (asset_group_id, name, exclude_from_group_totals, created_at) VALUES (?, ?, 0, datetime('now'))`).run(
      group.id,
      name
    );
    const id = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    createdAccounts.push(id);
    return id;
  }

  function movementsOf(accountId: number) {
    return db
      .prepare(`SELECT COUNT(*) AS n FROM movements WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?`)
      .get(accountId, accountId, accountId) as { n: number };
  }

  beforeAll(() => {
    usdAccountId = account(`${PREFIX} Santander USD`, "cash_eqs__cash_savings__usd");
    brokerUsdId = account(`${PREFIX} broker USD`, "cash_eqs__cash_savings__usd");
    cardId = account(`${PREFIX} card`, "cash_eqs__cash_savings__usd");
    if (db.prepare(`SELECT 1 FROM bank_account_numbers WHERE number = ?`).get(NUMBER)) throw new Error("test DB already declares the synthetic number");
    db.prepare(`INSERT INTO bank_account_numbers (account_id, issuer, number, currency) VALUES (?, 'santander', ?, 'usd')`).run(usdAccountId, NUMBER);
  });

  afterAll(() => {
    db.prepare(`DELETE FROM movements WHERE note LIKE ?`).run(`${PREFIX}%`);
    db.prepare(`DELETE FROM bank_account_numbers WHERE number = ?`).run(NUMBER);
    db.prepare(`DELETE FROM import_batches WHERE kind = 'usd_account_feed' AND filename LIKE ?`).run(`${PREFIX}%`);
    for (const id of createdAccounts) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  });

  const account_ = { issuer: "santander", product: "checking" as const, currency: "usd" as const };
  const row = (date: string, amount: number, description: string, wire_reference: string | null = null) => ({
    date,
    description,
    currency: "usd" as const,
    amount,
    document_no: null,
    wire_reference,
  });

  it("maps the listing to the account declaring its number, and refuses an unnamed or unknown one", () => {
    expect(accountIdForIssuerBankAccount({ ...account_, number: NUMBER })).toBe(usdAccountId);
    expect(accountIdForIssuerBankAccount({ ...account_, number: NUMBER.replace(/^0+/, "") })).toBe(usdAccountId);
    expect(() => accountIdForIssuerBankAccount(account_)).toThrow(/must name its account number/);
    expect(() => accountIdForIssuerBankAccount({ ...account_, number: "009900000000" })).toThrow(/No ledger account declares/);
  });

  it("confirms the rows the ledger holds, waits for an unbooked wire, reports the rest, inserts nothing", () => {
    // The wire's booking (broker USD → the account) and a card payment entered by hand, dated the
    // day before the bank listed them, as a 14:00-cutoff posting would be.
    const wire = db
      .prepare(`INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note) VALUES (?, ?, 1138.53, 'usd', '2097-10-07', ?)`)
      .run(brokerUsdId, usdAccountId, `${PREFIX} wire booking`);
    const payment = db
      .prepare(
        `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, ?, 1138.53, 'usd', '2097-10-09', ?, 'pago_tarjeta')`
      )
      .run(usdAccountId, cardId, `${PREFIX} card payment`);
    const before = movementsOf(usdAccountId).n;
    const result = applyBankAccountMovements(
      {
        account: { ...account_, number: NUMBER },
        movements: [
          row("2097-10-08", 1138.53, "Rec Or de Pago REC OR DE PAGO 1", "1"),
          row("2097-10-09", -1138.53, "Giro en Efectivo por Caja"),
          row("2097-10-12", 500, "Rec Or de Pago REC OR DE PAGO 2", "2"),
          row("2097-10-12", -0.08, "Comision mantencion"),
        ],
        rejected_rows: [],
      },
      `${PREFIX} capture`
    ) as UsdAccountMovementsApplyDetails;
    expect(result.account_id).toBe(usdAccountId);
    expect(result.confirmed).toBe(2);
    expect(result.confirmed_flows.map((f) => f.movement_id)).toEqual([Number(wire.lastInsertRowid), Number(payment.lastInsertRowid)]);
    expect(result.awaiting_wire_booking).toBe(1);
    expect(result.awaiting_flows).toEqual([{ occurred_on: "2097-10-12", description: "Rec Or de Pago REC OR DE PAGO 2", amount: 500, wire_reference: "2" }]);
    expect(result.unexplained).toBe(1);
    expect(result.unexplained_flows).toEqual([{ occurred_on: "2097-10-12", description: "Comision mantencion", amount: -0.08 }]);
    expect(movementsOf(usdAccountId).n).toBe(before);
    // The wire's bank day is its posting day on this account (the booking keeps the value date).
    expect(
      db.prepare(`SELECT posted_on FROM movement_bank_postings WHERE movement_id = ? AND account_id = ?`).get(Number(wire.lastInsertRowid), usdAccountId)
    ).toEqual({ posted_on: "2097-10-08" });
    // Sent again: the same legs match on their recorded posting day, nothing changes.
    const again = applyBankAccountMovements(
      { account: { ...account_, number: NUMBER }, movements: [row("2097-10-08", 1138.53, "Rec Or de Pago REC OR DE PAGO 1", "1")], rejected_rows: [] },
      `${PREFIX} capture again`
    ) as UsdAccountMovementsApplyDetails;
    expect(again.confirmed).toBe(1);
    expect(again.confirmed_flows[0]!.movement_id).toBe(Number(wire.lastInsertRowid));
    expect(movementsOf(usdAccountId).n).toBe(before);
  });

  it("refuses a dollar listing with rows the feeder could not read", () => {
    expect(() =>
      applyBankAccountMovements({ account: { ...account_, number: NUMBER }, movements: [], rejected_rows: ["Fila 3: ?"] }, `${PREFIX} bad`)
    ).toThrow(/could not read/);
  });
});
