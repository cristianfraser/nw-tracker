/**
 * The pairing of a Fintual retiro mail with its checking credit, called directly
 * (`fintualWithdrawalPairing.ts`); the planner that uses it is `fintualEmailImport.test.ts`'.
 * Dates in March 2087, where no other row of the checking account lives.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { bankPostedOn } from "./movementBankPostings.js";
import {
  WITHDRAWAL_PAIR_WINDOW_DAYS,
  findUnpairedBankCredit,
  fintualGoalAccountId,
  promoteBankCreditToTransfer,
  retiroDestinationAccount,
} from "./fintualWithdrawalPairing.js";

const PREFIX = "vitest-fintual-pairing";

describe("fintualWithdrawalPairing", () => {
  const created: number[] = [];
  let goalId = 0;
  let otherId = 0;
  let checking = 0;

  const credit = (on: string, amount: number, currency = "clp"): number => {
    const id = Number(
      db
        .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, ?, ?, ?, ?)`)
        .run(checking, amount, currency, on, `${PREFIX} credit`).lastInsertRowid
    );
    created.push(id);
    return id;
  };

  beforeAll(() => {
    checking = checkingAccountId();
    const group = (db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as { id: number }).id;
    const account = (name: string, key: string) =>
      Number(db.prepare(`INSERT INTO accounts (asset_group_id, name, import_key) VALUES (?, ?, ?)`).run(group, name, key).lastInsertRowid);
    goalId = account(`${PREFIX} Reserva`, `import:fintual|cert|key=${PREFIX}-reserva`);
    // Same name, but not a Fintual goal account.
    otherId = account(`${PREFIX} Viaje`, `import:panel|key=${PREFIX}-viaje`);
  });

  afterEach(() => {
    for (const id of created.splice(0)) {
      db.prepare(`DELETE FROM movement_bank_postings WHERE movement_id = ?`).run(id);
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
    }
  });

  afterAll(() => {
    for (const id of [goalId, otherId]) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  });

  it("reads the destination account from the number a mail prints, ignoring punctuation and leading zeros", () => {
    const number = "9990003003";
    db.prepare(`INSERT INTO bank_account_numbers (account_id, issuer, number, currency) VALUES (?, 'santander', ?, 'clp')`).run(otherId, `0-${number}`);
    try {
      expect(retiroDestinationAccount(number)).toEqual({ account_id: otherId });
      expect(retiroDestinationAccount(`000${number}`)).toEqual({ account_id: otherId });
      expect(retiroDestinationAccount("9990009998")).toMatchObject({ requires_manual: expect.stringMatching(/not in bank_account_numbers/) });
      expect(retiroDestinationAccount(null)).toMatchObject({ requires_manual: expect.stringMatching(/names no destination account/) });
    } finally {
      db.prepare(`DELETE FROM bank_account_numbers WHERE number = ?`).run(`0-${number}`);
    }
  });

  it("finds a goal by its name, ignoring case and spaces, only among the Fintual goal accounts", () => {
    expect(fintualGoalAccountId(`  ${PREFIX.toUpperCase()} RESERVA `)).toBe(goalId);
    expect(fintualGoalAccountId(`${PREFIX} Viaje`)).toBeNull();
    expect(fintualGoalAccountId(`${PREFIX} nothing`)).toBeNull();
  });

  it("pairs the one credit of the amount dated from the payment day through the window", () => {
    expect(WITHDRAWAL_PAIR_WINDOW_DAYS).toBe(5);
    const id = credit("2087-03-03", 1_300_000);
    expect(findUnpairedBankCredit(checking, 1_300_000, "2087-03-02")).toEqual({ id, occurred_on: "2087-03-03" });
    // Whole pesos: a stored 1.300.000,4 rounds to the mail's amount.
    expect(findUnpairedBankCredit(checking, 1_300_000.4, "2087-03-02")).toEqual({ id, occurred_on: "2087-03-03" });
    expect(findUnpairedBankCredit(checking, 1_300_001, "2087-03-02")).toBeNull();
  });

  it("reaches exactly five days after the payment day and never before it", () => {
    const last = credit("2087-03-07", 200_000);
    expect(findUnpairedBankCredit(checking, 200_000, "2087-03-02")).toEqual({ id: last, occurred_on: "2087-03-07" });
    // From 2087-03-01 the credit is on the sixth day; with a 4-day window, from 03-02 it is the fifth.
    expect(findUnpairedBankCredit(checking, 200_000, "2087-03-01")).toBeNull();
    expect(findUnpairedBankCredit(checking, 200_000, "2087-03-02", 4)).toBeNull();
    expect(findUnpairedBankCredit(checking, 200_000, "2087-03-08")).toBeNull();
    credit("2087-03-14", 300_000);
    expect(findUnpairedBankCredit(checking, 300_000, "2087-03-08")).toBeNull();
  });

  it("refuses two candidates of the same amount, and pairs again once one of them is a transfer", () => {
    const a = credit("2087-03-03", 500_000);
    const b = credit("2087-03-05", 500_000);
    expect(findUnpairedBankCredit(checking, 500_000, "2087-03-02")).toBe("ambiguous");
    promoteBankCreditToTransfer(a, goalId, checking, `${PREFIX} retiro A`);
    expect(findUnpairedBankCredit(checking, 500_000, "2087-03-02")).toEqual({ id: b, occurred_on: "2087-03-05" });
  });

  it("ignores a dollar credit of the same figure", () => {
    credit("2087-03-03", 700_000, "usd");
    expect(findUnpairedBankCredit(checking, 700_000, "2087-03-02")).toBeNull();
  });

  it("promotes the credit in place: same id, goal → checking, with the cuotas", () => {
    const id = credit("2087-03-03", 900_000);
    promoteBankCreditToTransfer(id, goalId, checking, `${PREFIX} retiro`, "620.1234");
    const row = db.prepare(`SELECT account_id, from_account_id, to_account_id, amount, occurred_on, units_delta, note FROM movements WHERE id = ?`).get(id);
    expect(row).toEqual({
      account_id: null,
      from_account_id: goalId,
      to_account_id: checking,
      amount: 900_000,
      occurred_on: "2087-03-03",
      units_delta: 620.1234,
      note: `${PREFIX} retiro`,
    });
    expect(bankPostedOn(id, checking)).toBe("2087-03-03");
    expect(findUnpairedBankCredit(checking, 900_000, "2087-03-02")).toBeNull();
    // An already-paired row is never promoted twice.
    expect(() => promoteBankCreditToTransfer(id, goalId, checking, `${PREFIX} again`)).toThrow(/not an unpaired single-leg row/);
  });

  it("re-dates a month-straddling credit to the payment day, keeping the bank's day as its posting", () => {
    // Paid Friday 2087-02-28 after the cutoff, posted Monday 2087-03-03.
    const id = credit("2087-03-03", 1_000_000);
    expect(findUnpairedBankCredit(checking, 1_000_000, "2087-02-28")).toEqual({ id, occurred_on: "2087-03-03" });
    promoteBankCreditToTransfer(id, goalId, checking, `${PREFIX} retiro`, "700.5", "2087-02-28");
    expect(db.prepare(`SELECT occurred_on FROM movements WHERE id = ?`).get(id)).toEqual({ occurred_on: "2087-02-28" });
    expect(bankPostedOn(id, checking)).toBe("2087-03-03");
  });
});
