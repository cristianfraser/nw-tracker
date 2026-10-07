import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TransferNotice } from "nw-tracker-contracts";
import { db } from "./db.js";
import { applyBankTransferNotices, TRANSFER_NOTICE_CREDIT_MAX_AGE_DAYS } from "./bankTransferNotices.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { listCheckingMovements } from "./checkingCartolaLoaders.js";
import { importCheckingPartialMovements } from "./checkingPartialMovementsImport.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import {
  findTransferNoticeCreditForBankRow,
  listOverdueTransferNoticeCredits,
  transferNoticeCreditDeadlineYmd,
} from "./transferNoticeCredits.js";

const NUMBER = "00-999-99999-91";

let seq = 0;
function incoming(day: string, amount: number, time = "11:02"): TransferNotice {
  seq += 1;
  return {
    message_id: `<vitest-tn-${seq}-${Date.now()}@test>`,
    sent_at_chile: `${day} ${time}`,
    subject: "Transferencias de Fondos de Juan Perez",
    kind: "incoming",
    date: day,
    amount,
    from: { name: "Juan Perez", rut: null, bank: "Banco de Chile", account_type: null, account_number: null, email: null },
    to: { name: "Ana Rojas", rut: "11.111.111-1", bank: "Banco Santander", account_type: null, account_number: NUMBER, email: null },
    comment: "almuerzo",
    scheduled: false,
  };
}

describe("credits written from incoming transfer mails", () => {
  let account: number;
  let hadNumber: boolean;
  const today = chileCalendarTodayYmd();

  beforeEach(() => {
    account = checkingAccountId();
    hadNumber = db.prepare(`SELECT 1 FROM bank_account_numbers WHERE account_id = ?`).get(account) != null;
    if (!hadNumber) {
      db.prepare(`INSERT INTO bank_account_numbers (account_id, issuer, number, currency) VALUES (?, 'santander', ?, 'clp')`).run(account, NUMBER);
    }
  });

  afterEach(() => {
    const ids = (
      db.prepare(`SELECT movement_id FROM transfer_notice_credits WHERE message_id LIKE '<vitest-tn-%' AND movement_id IS NOT NULL`).all() as { movement_id: number }[]
    ).map((r) => r.movement_id);
    db.prepare(`DELETE FROM movement_transfer_notices WHERE message_id LIKE '<vitest-tn-%'`).run();
    db.prepare(`DELETE FROM transfer_notice_credits WHERE message_id LIKE '<vitest-tn-%'`).run();
    db.prepare(`DELETE FROM bank_transfer_notices WHERE message_id LIKE '<vitest-tn-%'`).run();
    for (const id of ids) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM movements WHERE note LIKE 'import:cartola-partial|%|VITEST TN%'`).run();
    if (!hadNumber) db.prepare(`DELETE FROM bank_account_numbers WHERE account_id = ? AND number = ?`).run(account, NUMBER);
  });

  it("writes the credit from the mail, pairs it, and lets the nightly feed confirm it instead of adding a row", () => {
    const notice = incoming(today, 41_237);
    const first = applyBankTransferNotices({ issuer: "bancochile", notices: [notice] });
    expect(first.synthesized).toHaveLength(1);
    const credit = first.synthesized[0]!;
    expect(credit).toMatchObject({ account_id: account, date: today, amount: 41_237 });
    const row = db.prepare(`SELECT account_id, amount, occurred_on, note FROM movements WHERE id = ?`).get(credit.movement_id) as {
      account_id: number;
      amount: number;
      occurred_on: string;
      note: string;
    };
    expect(row).toMatchObject({ account_id: account, amount: 41_237, occurred_on: today });
    expect(row.note).toBe(`import:bancochile-mail|${today} 11:02|Transf. de Juan Perez — almuerzo`);
    expect(db.prepare(`SELECT movement_id FROM movement_transfer_notices WHERE message_id = ?`).get(notice.message_id)).toEqual({
      movement_id: credit.movement_id,
    });
    // Income, deposit matching and payslip pairing see it like a bank row.
    expect(listCheckingMovements(account, "in").some((m) => m.id === credit.movement_id)).toBe(true);
    // Re-sending the mail writes nothing more.
    expect(applyBankTransferNotices({ issuer: "bancochile", notices: [notice] }).synthesized).toEqual([]);

    // The bank's feed lists it the next business day: the mail's row stays, the bank's day is its posting.
    const bankDay = chileCalendarAddDays(today, 1);
    const feed = [{ occurred_on: bankDay, description: "0099999 TRANSF. JUAN PEREZ VITEST TN", amount_clp: 41_237, document_no: "" }];
    const imported = importCheckingPartialMovements(account, feed);
    expect(imported).toMatchObject({ inserted: 0, skipped_superseded_by_mail: 1 });
    const confirmed = db
      .prepare(`SELECT confirmed_on, confirmed_source, bank_description FROM transfer_notice_credits WHERE message_id = ?`)
      .get(notice.message_id);
    expect(confirmed).toEqual({ confirmed_on: bankDay, confirmed_source: "ultimos_xlsx", bank_description: feed[0]!.description });
    expect(db.prepare(`SELECT posted_on FROM movement_bank_postings WHERE movement_id = ?`).get(credit.movement_id)).toEqual({
      posted_on: bankDay,
    });
    // The feed re-lists the row the next night, and the cartola lists it once more: still one row.
    expect(importCheckingPartialMovements(account, feed)).toMatchObject({ inserted: 0, skipped_superseded_by_mail: 1 });
    expect(findTransferNoticeCreditForBankRow(account, bankDay, 41_237, new Set())).toBe(credit.movement_id);
    // Another credit of the same pesos on another day is someone else's money.
    const later = chileCalendarAddDays(today, 6);
    expect(
      importCheckingPartialMovements(account, [{ occurred_on: later, description: "VITEST TN OTHER", amount_clp: 41_237, document_no: "" }])
    ).toMatchObject({ inserted: 1, skipped_superseded_by_mail: 0 });
  });

  it("gives each of two same-day wires of the same pesos its own bank row", () => {
    const a = incoming(today, 20_000, "10:00");
    const b = incoming(today, 20_000, "10:05");
    const written = applyBankTransferNotices({ issuer: "bancochile", notices: [a, b] }).synthesized;
    expect(written).toHaveLength(2);
    const row = (desc: string) => ({ occurred_on: today, description: desc, amount_clp: 20_000, document_no: "" });
    expect(importCheckingPartialMovements(account, [row("VITEST TN A"), row("VITEST TN B")])).toMatchObject({
      inserted: 0,
      skipped_superseded_by_mail: 2,
    });
    // A third, unmailed wire of the same pesos is the bank's own row.
    expect(importCheckingPartialMovements(account, [row("VITEST TN A"), row("VITEST TN B"), row("VITEST TN C")])).toMatchObject({
      inserted: 1,
      skipped_superseded_by_mail: 2,
    });
  });

  it("never writes a credit for an old mail, and never again for one whose credit was deleted", () => {
    const old = incoming(chileCalendarAddDays(today, -(TRANSFER_NOTICE_CREDIT_MAX_AGE_DAYS + 1)), 33_333);
    expect(applyBankTransferNotices({ issuer: "bancochile", notices: [old] }).synthesized).toEqual([]);
    const fresh = incoming(today, 44_444);
    const [credit] = applyBankTransferNotices({ issuer: "bancochile", notices: [fresh] }).synthesized;
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(credit!.movement_id);
    expect(applyBankTransferNotices({ issuer: "bancochile", notices: [fresh] }).synthesized).toEqual([]);
    expect(db.prepare(`SELECT movement_id FROM transfer_notice_credits WHERE message_id = ?`).get(fresh.message_id)).toEqual({ movement_id: null });
  });

  it("reports a credit no feed listed within two business days", () => {
    const notice = incoming(today, 55_555);
    const [credit] = applyBankTransferNotices({ issuer: "bancochile", notices: [notice] }).synthesized;
    const deadline = transferNoticeCreditDeadlineYmd(today)!;
    expect(listOverdueTransferNoticeCredits(deadline).some((o) => o.movement_id === credit!.movement_id)).toBe(false);
    expect(listOverdueTransferNoticeCredits(chileCalendarAddDays(deadline, 1))).toContainEqual(
      expect.objectContaining({ movement_id: credit!.movement_id, amount: 55_555, deadline })
    );
  });
});
