import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { assertListingNamesAccount } from "./bankAccountMovementsApply.js";

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
    const account = { issuer: "santander", product: "checking" as const };
    expect(() => assertListingNamesAccount(accountId, { ...account, number: ownNumber })).not.toThrow();
    expect(() => assertListingNamesAccount(accountId, { ...account, number: `00${ownNumber}` })).not.toThrow();
    expect(() => assertListingNamesAccount(accountId, { ...account, number: ownNumber.replace(/^0+/, "") })).not.toThrow();
    expect(() => assertListingNamesAccount(accountId, account)).not.toThrow();
  });

  it("refuses another declared account's number and a number that is not the account's", () => {
    const account = { issuer: "santander", product: "checking" as const };
    expect(() => assertListingNamesAccount(accountId, { ...account, number: "009900998877" })).toThrow(/not the number declared/);
    expect(() => assertListingNamesAccount(accountId, { ...account, number: "123456789012" })).toThrow(/not the number declared/);
    expect(() => assertListingNamesAccount(otherAccountId, { ...account, number: ownNumber })).toThrow(/declared for ledger account/);
  });
});
