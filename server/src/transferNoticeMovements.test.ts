import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TransferNotice } from "nw-tracker-contracts";
import { db } from "./db.js";
import {
  applyBankTransferNotices,
  landingAccountFor,
  mailMovementForNotice,
  TRANSFER_NOTICE_MOVEMENT_MAX_AGE_DAYS,
} from "./bankTransferNotices.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { listCheckingMovements } from "./checkingCartolaLoaders.js";
import { importCheckingPartialMovements } from "./checkingPartialMovementsImport.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import {
  findTransferNoticeMovementForBankRow,
  listOverdueTransferNoticeMovements,
  transferNoticeMovementDeadlineYmd,
} from "./transferNoticeMovements.js";

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

function outgoing(day: string, amount: number, to: Partial<TransferNotice["to"]> = {}): TransferNotice {
  const n = incoming(day, amount, "20:19");
  return {
    ...n,
    subject: "Comprobante Transferencia de fondos",
    kind: "outgoing",
    from: { name: "Ana Rojas", rut: "11.111.111-1", bank: "Banco Santander", account_type: "Cuenta Corriente", account_number: NUMBER, email: null },
    to: { name: "COMUNIDAD EDIFICIO VITEST", rut: "22.222.222-2", bank: "Banco Santander", account_type: "Cuenta Corriente", account_number: "777", email: null, ...to },
    comment: null,
  };
}

describe("mailMovementForNotice", () => {
  const tracked = new Map([["99999991", 22], ["555", 41]]);
  const counterparties = {
    byRut: new Map([["333333333", new Set([44, 100])]]),
    byNumber: new Map([["888", new Set([80])], ["999", new Set([32])]]),
  };
  const info = new Map([
    [44, { import_key: "import:fintual|cert|key=goal", is_card: false }],
    [100, { import_key: "import:panel|kind=clp|key=fintual_clp", is_card: false }],
    [80, { import_key: "import:excel|key=ahorro", is_card: false }],
    [32, { import_key: "credit_card_master|x|1", is_card: true }],
  ]);
  const landing = (a: ReadonlySet<number>) => landingAccountFor(a, info);
  const base = outgoing("2030-10-07", 1000, {});
  const from22 = { ...base, from: { ...base.from, account_number: "99999991" } };
  const plan = (n: TransferNotice) => mailMovementForNotice(n, tracked, counterparties, landing);

  it("writes a third-party payment as a debit and an incoming transfer as a credit", () => {
    expect(plan(from22)).toEqual({ kind: "single", account_id: 22, amount: -1000 });
    expect(plan({ ...incoming("2030-10-07", 1000), to: { ...base.to, account_number: "99999991" } })).toEqual({
      kind: "single",
      account_id: 22,
      amount: 1000,
    });
  });

  it("writes a transfer between two numbered accounts once, whichever kind the mail is", () => {
    const own = { ...from22, kind: "between_own_products" as const, to: { ...from22.to, account_number: "555" } };
    expect(plan(own)).toEqual({ kind: "transfer", from_account_id: 22, to_account_id: 41, amount: 1000, checking_account_id: 22 });
    expect(plan({ ...own, kind: "outgoing" })).toEqual(plan(own));
    // To an own product the app has no number for (the línea de crédito): left to the feed.
    expect(plan({ ...own, to: { ...own.to, account_number: "123" } })).toBeNull();
  });

  it("lands a payment to a known counterparty in its peso balance account, and leaves card payments to their receipts", () => {
    expect(plan({ ...from22, to: { ...from22.to, rut: "33.333.333-3" } })).toEqual({
      kind: "transfer",
      from_account_id: 22,
      to_account_id: 100,
      amount: 1000,
      checking_account_id: 22,
    });
    expect(plan({ ...from22, to: { ...from22.to, account_number: "888" } })).toMatchObject({ kind: "transfer", to_account_id: 80 });
    expect(plan({ ...from22, to: { ...from22.to, account_number: "999" } })).toBeNull();
    expect(landingAccountFor(new Set([44]), info)).toBe(44);
    expect(landingAccountFor(new Set([44, 32]), info)).toBeNull();
  });

  it("writes nothing for a scheduled-transfer notice or from an account the app does not number", () => {
    expect(plan({ ...from22, kind: "schedule_created" })).toBeNull();
    expect(plan(base)).toBeNull();
  });
});

describe("movements written from transfer mails", () => {
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
      db.prepare(`SELECT movement_id FROM transfer_notice_movements WHERE message_id LIKE '<vitest-tn-%' AND movement_id IS NOT NULL`).all() as { movement_id: number }[]
    ).map((r) => r.movement_id);
    db.prepare(`DELETE FROM movement_transfer_notices WHERE message_id LIKE '<vitest-tn-%'`).run();
    db.prepare(`DELETE FROM transfer_notice_movements WHERE message_id LIKE '<vitest-tn-%'`).run();
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
      .prepare(`SELECT confirmed_on, confirmed_source, bank_description FROM transfer_notice_movements WHERE message_id = ?`)
      .get(notice.message_id);
    expect(confirmed).toEqual({ confirmed_on: bankDay, confirmed_source: "ultimos_xlsx", bank_description: feed[0]!.description });
    expect(db.prepare(`SELECT posted_on FROM movement_bank_postings WHERE movement_id = ?`).get(credit.movement_id)).toEqual({
      posted_on: bankDay,
    });
    // The feed re-lists the row the next night, and the cartola lists it once more: still one row.
    expect(importCheckingPartialMovements(account, feed)).toMatchObject({ inserted: 0, skipped_superseded_by_mail: 1 });
    expect(findTransferNoticeMovementForBankRow(account, bankDay, 41_237, new Set())).toBe(credit.movement_id);
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
    const old = incoming(chileCalendarAddDays(today, -(TRANSFER_NOTICE_MOVEMENT_MAX_AGE_DAYS + 1)), 33_333);
    expect(applyBankTransferNotices({ issuer: "bancochile", notices: [old] }).synthesized).toEqual([]);
    const fresh = incoming(today, 44_444);
    const [credit] = applyBankTransferNotices({ issuer: "bancochile", notices: [fresh] }).synthesized;
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(credit!.movement_id);
    expect(applyBankTransferNotices({ issuer: "bancochile", notices: [fresh] }).synthesized).toEqual([]);
    expect(db.prepare(`SELECT movement_id FROM transfer_notice_movements WHERE message_id = ?`).get(fresh.message_id)).toEqual({ movement_id: null });
  });

  it("writes a payment to a third party as a debit, which the nightly feed then confirms", () => {
    const notice = outgoing(today, 76_282);
    const [debit] = applyBankTransferNotices({ issuer: "santander", notices: [notice] }).synthesized;
    expect(debit).toMatchObject({ account_id: account, amount: -76_282, date: today });
    const row = db.prepare(`SELECT amount, note FROM movements WHERE id = ?`).get(debit!.movement_id) as { amount: number; note: string };
    expect(row).toEqual({ amount: -76_282, note: `import:santander-mail|${today} 20:19|Transf a COMUNIDAD EDIFICIO VITEST (Banco Santander)` });
    expect(listCheckingMovements(account, "out").some((m) => m.id === debit!.movement_id)).toBe(true);
    const bankDay = chileCalendarAddDays(today, 1);
    expect(
      importCheckingPartialMovements(account, [
        { occurred_on: bankDay, description: "VITEST TN Transf a COMUNIDAD EDIFICIO", amount_clp: -76_282, document_no: "" },
      ])
    ).toMatchObject({ inserted: 0, skipped_superseded_by_mail: 1 });
  });

  it("writes a payment to the fund manager as a transfer into its balance account, confirmed by the feed's transfer-leg rule", () => {
    const fund = db
      .prepare(`SELECT id FROM accounts WHERE id <> ? AND id NOT IN (SELECT account_id FROM credit_card_account_config) ORDER BY id LIMIT 1`)
      .get(account) as { id: number };
    db.prepare(`INSERT INTO transfer_counterparty_accounts (rut, account_id) VALUES ('33.333.333-3', ?)`).run(fund.id);
    try {
      const notice = outgoing(today, 700_000, { name: "FONDO VITEST", rut: "33.333.333-3" });
      const [written] = applyBankTransferNotices({ issuer: "santander", notices: [notice] }).synthesized;
      expect(written).toMatchObject({ account_id: account, amount: -700_000 });
      expect(db.prepare(`SELECT account_id, from_account_id, to_account_id, amount FROM movements WHERE id = ?`).get(written!.movement_id)).toEqual({
        account_id: null,
        from_account_id: account,
        to_account_id: fund.id,
        amount: 700_000,
      });
      // Re-sent: the transfer is the bank row that notice describes.
      expect(applyBankTransferNotices({ issuer: "santander", notices: [notice] }).synthesized).toEqual([]);
      const bankDay = chileCalendarAddDays(today, 1);
      expect(
        importCheckingPartialMovements(account, [
          { occurred_on: bankDay, description: "VITEST TN Transf a FONDO", amount_clp: -700_000, document_no: "" },
        ])
      ).toMatchObject({ inserted: 0, skipped_superseded_by_transfer: 1 });
      expect(db.prepare(`SELECT confirmed_on, confirmed_source FROM transfer_notice_movements WHERE message_id = ?`).get(notice.message_id)).toEqual({
        confirmed_on: bankDay,
        confirmed_source: "ultimos_xlsx",
      });
      expect(listOverdueTransferNoticeMovements(chileCalendarAddDays(today, 30)).some((o) => o.movement_id === written!.movement_id)).toBe(false);
    } finally {
      db.prepare(`DELETE FROM transfer_counterparty_accounts WHERE rut = '33.333.333-3'`).run();
    }
  });

  it("reports a credit no feed listed within two business days", () => {
    const notice = incoming(today, 55_555);
    const [credit] = applyBankTransferNotices({ issuer: "bancochile", notices: [notice] }).synthesized;
    const deadline = transferNoticeMovementDeadlineYmd(today)!;
    expect(listOverdueTransferNoticeMovements(deadline).some((o) => o.movement_id === credit!.movement_id)).toBe(false);
    expect(listOverdueTransferNoticeMovements(chileCalendarAddDays(deadline, 1))).toContainEqual(
      expect.objectContaining({ movement_id: credit!.movement_id, amount: 55_555, deadline })
    );
  });
});
