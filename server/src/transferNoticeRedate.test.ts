import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TransferNotice } from "nw-tracker-contracts";
import { db } from "./db.js";
import { applyBankTransferNotices } from "./bankTransferNotices.js";
import { nonAnchorClpFlowTotals } from "./checkingCartolaBalances.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { importCheckingPartialMovements } from "./checkingPartialMovementsImport.js";
import { rolledBack } from "./ingestReceiver.js";
import { bankPostedOn, occurredOnBasis } from "./movementBankPostings.js";
import { READ_AFTER_ROWS, readOnChileDay } from "./test/listingFetch.js";

/** A bank row of the bank listed after the transfer's mail: dated the mail's day, bank day kept as posting. */

const NUMBER = "00-999-99999-92";
const NOTE_TAG = "VITEST RD";

let seq = 0;
function outgoing(sent: string, amount: number, to: Partial<TransferNotice["to"]> = {}): TransferNotice {
  seq += 1;
  const day = sent.slice(0, 10);
  return {
    message_id: `<vitest-rd-${seq}-${Date.now()}@test>`,
    sent_at_chile: sent,
    subject: "Comprobante Transferencia de fondos",
    kind: "outgoing",
    date: day,
    amount,
    from: { name: "Ana Rojas", rut: "11.111.111-1", bank: "Banco Santander", account_type: "Cuenta Corriente", account_number: NUMBER, email: null },
    to: { name: "COMUNIDAD VITEST RD", rut: "22.222.222-2", bank: "Banco Santander", account_type: "Cuenta Corriente", account_number: "777", email: null, ...to },
    comment: null,
    scheduled: false,
  };
}

describe("transfer notices re-date bank rows the bank listed after the mail", () => {
  let account: number;
  let setAside: { number: string; issuer: string; currency: string }[] = [];
  const written: number[] = [];

  beforeEach(() => {
    account = checkingAccountId();
    setAside = db.prepare(`SELECT number, issuer, currency FROM bank_account_numbers WHERE account_id = ?`).all(account) as typeof setAside;
    db.prepare(`DELETE FROM bank_account_numbers WHERE account_id = ?`).run(account);
    db.prepare(`INSERT INTO bank_account_numbers (account_id, issuer, number, currency) VALUES (?, 'santander', ?, 'clp')`).run(account, NUMBER);
  });

  afterEach(() => {
    db.prepare(`DELETE FROM movement_transfer_notices WHERE message_id LIKE '<vitest-rd-%'`).run();
    db.prepare(`DELETE FROM transfer_notice_movements WHERE message_id LIKE '<vitest-rd-%'`).run();
    db.prepare(`DELETE FROM bank_transfer_notices WHERE message_id LIKE '<vitest-rd-%'`).run();
    const ids = [
      ...written.splice(0),
      ...(db.prepare(`SELECT id FROM movements WHERE note LIKE ?`).all(`%${NOTE_TAG}%`) as { id: number }[]).map((r) => r.id),
    ];
    for (const id of ids) {
      db.prepare(`DELETE FROM movement_bank_postings WHERE movement_id = ?`).run(id);
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
    }
    db.prepare(`DELETE FROM bank_account_numbers WHERE account_id = ? AND number = ?`).run(account, NUMBER);
    const restore = db.prepare(`INSERT INTO bank_account_numbers (account_id, issuer, number, currency) VALUES (?, ?, ?, ?)`);
    for (const r of setAside) restore.run(account, r.issuer, r.number, r.currency);
  });

  /** The daily listing's row for `day`; returns its movement id. */
  function bankRow(day: string, amount: number, desc: string, fetch = READ_AFTER_ROWS): number {
    const description = `${NOTE_TAG} ${desc}`;
    expect(importCheckingPartialMovements(account, [{ occurred_on: day, description, amount_clp: amount, document_no: "" }], fetch)).toMatchObject({
      inserted: 1,
    });
    return (db.prepare(`SELECT id FROM movements WHERE account_id = ? AND note LIKE ?`).get(account, `%|${description}%`) as { id: number }).id;
  }

  const occurredOn = (id: number) => (db.prepare(`SELECT occurred_on FROM movements WHERE id = ?`).get(id) as { occurred_on: string }).occurred_on;
  const pairedWith = (messageId: string) => db.prepare(`SELECT movement_id, account_id FROM movement_transfer_notices WHERE message_id = ?`).all(messageId);

  it("moves a Friday row of a Thursday 15:02 transfer to Thursday, keeps Friday as posting, and holds on re-apply", () => {
    const id = bankRow("2026-10-09", -41_239, "Transf a COMUNIDAD");
    const notice = outgoing("2026-10-08 15:02", 41_239);
    const first = applyBankTransferNotices({ issuer: "santander", notices: [notice] });
    expect(first.synthesized).toEqual([]);
    expect(first.redated).toEqual([
      { message_id: notice.message_id, movement_id: id, from: "2026-10-09", to: "2026-10-08", postings: [{ account_id: account, posted_on: "2026-10-09" }] },
    ]);
    expect(first.redate_conflicts).toEqual([]);
    expect(occurredOn(id)).toBe("2026-10-08");
    expect(bankPostedOn(id, account)).toBe("2026-10-09");
    expect(pairedWith(notice.message_id)).toEqual([{ movement_id: id, account_id: account }]);

    // Every apply re-pairs: the same row pairs again and nothing moves.
    const again = applyBankTransferNotices({ issuer: "santander", notices: [notice] });
    expect(again.redated).toEqual([]);
    expect(again.redate_conflicts).toEqual([]);
    expect(pairedWith(notice.message_id)).toEqual([{ movement_id: id, account_id: account }]);
    expect(occurredOn(id)).toBe("2026-10-08");
    // The feed re-lists the row the next night: its note is the identity, still one row.
    expect(
      importCheckingPartialMovements(account, [{ occurred_on: "2026-10-09", description: `${NOTE_TAG} Transf a COMUNIDAD`, amount_clp: -41_239, document_no: "" }], READ_AFTER_ROWS)
    ).toMatchObject({ inserted: 0, skipped_duplicate: 1 });
  });

  it("moves a listing's fetch day to the earlier day its mail states", () => {
    // Friday 23:50 transfer, first listed by a Saturday 00:30 fetch with Monday's bank date.
    const id = bankRow("2026-10-12", -41_245, "Transf a COMUNIDAD fetch", readOnChileDay("2026-10-10", 0));
    expect(occurredOn(id)).toBe("2026-10-10");
    expect(occurredOnBasis(id, account)).toBe("fetch");
    const notice = outgoing("2026-10-09 23:50", 41_245);
    const res = applyBankTransferNotices({ issuer: "santander", notices: [notice] });
    expect(res.redate_conflicts).toEqual([]);
    expect(res.redated).toMatchObject([{ movement_id: id, from: "2026-10-10", to: "2026-10-09" }]);
    expect(bankPostedOn(id, account)).toBe("2026-10-12");
    expect(occurredOnBasis(id, account)).toBe("evidence");
  });

  it("lets a mail confirm a listing's fetch day", () => {
    const id = bankRow("2026-10-09", -41_247, "Transf a COMUNIDAD same", readOnChileDay("2026-10-08"));
    expect(occurredOnBasis(id, account)).toBe("fetch");
    const res = applyBankTransferNotices({ issuer: "santander", notices: [outgoing("2026-10-08 15:10", 41_247)] });
    expect(res.redated).toEqual([]);
    expect(res.redate_conflicts).toEqual([]);
    expect(occurredOn(id)).toBe("2026-10-08");
    expect(bankPostedOn(id, account)).toBe("2026-10-09");
    expect(occurredOnBasis(id, account)).toBe("evidence");
  });

  it("shows the re-date in a dry run without writing it", () => {
    const id = bankRow("2026-10-09", -41_241, "Transf a COMUNIDAD dry");
    const notice = outgoing("2026-10-08 15:30", 41_241);
    const details = rolledBack(() => applyBankTransferNotices({ issuer: "santander", notices: [notice] }));
    expect(details.redated).toMatchObject([{ movement_id: id, from: "2026-10-09", to: "2026-10-08" }]);
    expect(occurredOn(id)).toBe("2026-10-09");
    expect(db.prepare(`SELECT 1 FROM movement_bank_postings WHERE movement_id = ?`).get(id)).toBeUndefined();
  });

  it("leaves a row the bank listed days after the mail on its own date", () => {
    // Monday's mail, Thursday's row: inside the pairing window, but not a cutoff case.
    const id = bankRow("2026-10-08", -41_243, "Transf a COMUNIDAD later");
    const notice = outgoing("2026-10-05 16:00", 41_243);
    const res = applyBankTransferNotices({ issuer: "santander", notices: [notice] });
    expect(pairedWith(notice.message_id)).toEqual([{ movement_id: id, account_id: account }]);
    expect(res.redated).toEqual([]);
    expect(occurredOn(id)).toBe("2026-10-08");
  });

  it("dates a transfer mailed on the month's last day in that month, while the bank's month still counts it", () => {
    const august = { fromYmd: "2026-08-01", toYmd: "2026-08-31" };
    const july = { fromYmd: "2026-07-01", toYmd: "2026-07-31" };
    const id = bankRow("2026-08-03", -41_245, "Transf a COMUNIDAD month");
    const before = { july: nonAnchorClpFlowTotals(account, july), august: nonAnchorClpFlowTotals(account, august) };
    const notice = outgoing("2026-07-31 16:10", 41_245);
    expect(applyBankTransferNotices({ issuer: "santander", notices: [notice] }).redated).toMatchObject([{ movement_id: id, to: "2026-07-31" }]);
    expect(occurredOn(id)).toBe("2026-07-31");
    expect(bankPostedOn(id, account)).toBe("2026-08-03");
    // The cartola month table reads the bank's day: August still holds it, July does not.
    expect(nonAnchorClpFlowTotals(account, july)).toEqual(before.july);
    expect(nonAnchorClpFlowTotals(account, august)).toEqual(before.august);
  });

  it("reports a row another document already dated to another day, and writes nothing", () => {
    const id = Number(
      db
        .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, ?, 'clp', '2026-10-07', ?)`)
        .run(account, -41_247, `${NOTE_TAG} receipt-dated`).lastInsertRowid
    );
    db.prepare(`INSERT INTO movement_bank_postings (movement_id, account_id, posted_on) VALUES (?, ?, '2026-10-09')`).run(id, account);
    const notice = outgoing("2026-10-08 15:05", 41_247);
    const res = applyBankTransferNotices({ issuer: "santander", notices: [notice] });
    expect(res.redated).toEqual([]);
    expect(res.redate_conflicts).toEqual([{ message_id: notice.message_id, movement_id: id, occurred_on: "2026-10-07", mail_day: "2026-10-08" }]);
    expect(occurredOn(id)).toBe("2026-10-07");
    expect(bankPostedOn(id, account)).toBe("2026-10-09");
  });

  it("moves a transfer into an account with no evidence of its own, and leaves one into a card", () => {
    const fund = db
      .prepare(
        `SELECT id FROM accounts WHERE id <> ? AND id NOT IN (SELECT account_id FROM credit_card_account_config)
           AND id NOT IN (SELECT account_id FROM bank_account_numbers) ORDER BY id LIMIT 1`
      )
      .get(account) as { id: number };
    const card = db.prepare(`SELECT account_id AS id FROM credit_card_account_config ORDER BY account_id LIMIT 1`).get() as { id: number };
    const transfer = (to: number, amount: number) => {
      const id = Number(
        db
          .prepare(`INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note) VALUES (?, ?, ?, 'clp', '2026-10-09', ?)`)
          .run(account, to, amount, `${NOTE_TAG} transfer`).lastInsertRowid
      );
      written.push(id);
      return id;
    };
    const toFund = transfer(fund.id, 41_249);
    const toCard = transfer(card.id, 41_251);
    const a = outgoing("2026-10-08 15:10", 41_249);
    const b = outgoing("2026-10-08 15:20", 41_251);
    const res = applyBankTransferNotices({ issuer: "santander", notices: [a, b] });
    expect(res.redated).toMatchObject([{ movement_id: toFund, from: "2026-10-09", to: "2026-10-08" }]);
    expect(occurredOn(toFund)).toBe("2026-10-08");
    expect(bankPostedOn(toFund, account)).toBe("2026-10-09");
    expect(bankPostedOn(toFund, fund.id)).toBe("2026-10-08");
    expect(res.redate_skipped).toMatchObject([{ movement_id: toCard, occurred_on: "2026-10-09", mail_day: "2026-10-08" }]);
    expect(occurredOn(toCard)).toBe("2026-10-09");
  });
});
