import type { IncomingWireNotice } from "nw-tracker-contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { applyBrokerNotifications } from "./brokerNotificationsApply.js";
import { db } from "./db.js";
import { applyIncomingWires, bookIncomingWires } from "./incomingWires.js";
import { brokerNotification } from "./test/brokerNotificationFixtures.js";

const PREFIX = "<vitest-wire-";
const DEST_NUMBER = "009988776655";
const createdAccounts: number[] = [];
let fintualUsd = 0;
let santanderUsd = 0;
let seq = 0;

function account(name: string, importKey: string | null): number {
  if (importKey) {
    const existing = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(importKey) as { id: number } | undefined;
    if (existing) return existing.id;
  }
  const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as { id: number };
  db.prepare(
    `INSERT INTO accounts (asset_group_id, name, exclude_from_group_totals, created_at, import_key) VALUES (?, ?, 0, datetime('now'), ?)`
  ).run(group.id, name, importKey);
  const id = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
  createdAccounts.push(id);
  return id;
}

const id = (tag: string) => `${PREFIX}${tag}-${++seq}@test>`;

/** Fintual's «Retiro en dólares confirmado», as ingest reads it. */
function request(o: { at: string; net: number; gross: number; due: string; message_id?: string }) {
  return brokerNotification({
    kind: "withdrawal_requested",
    subject: "Retiro en dólares confirmado",
    occurred_at: o.at,
    amount: o.net,
    gross_amount: o.gross,
    currency: "usd",
    destination_account: DEST_NUMBER.replace(/^0+/, ""),
    due_on: o.due,
    message_id: o.message_id ?? id("req"),
  });
}

function securityNotice(o: { date: string; amount: number; ordering?: string; message_id?: string }): IncomingWireNotice {
  return {
    message_id: o.message_id ?? id("sec"),
    sent_at_chile: `${o.date} 12:30`,
    subject: "Envío de Transferencia",
    bank: "security",
    reported_by: "sending_bank",
    value_date: o.date,
    currency: "usd",
    amount: o.amount,
    beneficiary: { bank: "santander", account: DEST_NUMBER.replace(/^0+/, ""), name: "VITEST CLIENT" },
    ordering: { name: o.ordering ?? "FINTUAL ADM. GENERAL DE FONDOS S. A.", account: "100000001", bank: "security" },
    reference: "OPS0000001",
    remittance: "/RFB/RETIRO USD",
  };
}

function santanderNotice(o: { date: string; amount: number }): IncomingWireNotice {
  return {
    message_id: id("san"),
    sent_at_chile: `${o.date} 13:10`,
    subject: "AVISO DE LIQUIDACION DE ORDEN DE PAGO RECIBIDA",
    bank: "santander",
    reported_by: "receiving_bank",
    value_date: o.date,
    currency: "usd",
    amount: o.amount,
    beneficiary: { bank: "santander", account: null, name: null },
    ordering: { name: null, account: null, bank: null },
    reference: "200000000001",
    remittance: null,
  };
}

function cleanupRows(): void {
  db.prepare(`DELETE FROM incoming_wire_booking_notices WHERE notice_message_id LIKE ?`).run(`${PREFIX}%`);
  const movements = db
    .prepare(
      `SELECT transfer_movement_id AS t, fee_movement_id AS f FROM incoming_wire_bookings WHERE request_message_id LIKE ?`
    )
    .all(`${PREFIX}%`) as { t: number | null; f: number | null }[];
  db.prepare(`DELETE FROM incoming_wire_bookings WHERE request_message_id LIKE ?`).run(`${PREFIX}%`);
  for (const m of movements) for (const mid of [m.t, m.f]) if (mid != null) db.prepare(`DELETE FROM movements WHERE id = ?`).run(mid);
  db.prepare(`DELETE FROM movements WHERE note LIKE 'vitest-wire%'`).run();
  db.prepare(`DELETE FROM broker_withdrawal_requests WHERE message_id LIKE ?`).run(`${PREFIX}%`);
  db.prepare(`DELETE FROM incoming_wire_notices WHERE message_id LIKE ?`).run(`${PREFIX}%`);
}

describe("incoming dollar wires", () => {
  beforeAll(() => {
    fintualUsd = account("vitest Fintual USD", "import:panel|kind=usd|key=fintual_usd");
    santanderUsd = account("vitest Santander USD", null);
    // The receiving bank's own notice names no account: it is the bank's one dollar account.
    db.prepare(`DELETE FROM bank_account_numbers WHERE issuer = 'santander' AND currency = 'usd' AND number = ?`).run(DEST_NUMBER);
    if (db.prepare(`SELECT 1 FROM bank_account_numbers WHERE issuer = 'santander' AND currency = 'usd'`).get() != null) {
      throw new Error("test DB already declares a Santander dollar account");
    }
    db.prepare(`INSERT INTO bank_account_numbers (account_id, issuer, number, currency) VALUES (?, 'santander', ?, 'usd')`).run(
      santanderUsd,
      DEST_NUMBER
    );
  });

  afterEach(cleanupRows);

  afterAll(() => {
    db.prepare(`DELETE FROM bank_account_numbers WHERE number = ?`).run(DEST_NUMBER);
    for (const a of createdAccounts) {
      db.prepare(`DELETE FROM movements WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?`).run(a, a, a);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(a);
    }
  });

  it("keeps a confirmed request until a wire pays it, then books the transfer and the fee once", () => {
    const req = request({ at: "2097-10-05T22:22:33Z", net: 1138.53, gross: 1148.53, due: "2097-10-08" });
    const first = applyBrokerNotifications({ broker: "fintual", apply: true, notifications: [req] });
    expect(first.planned).toEqual([]);
    expect(first.usd_withdrawals?.waiting).toEqual([
      { request_message_id: req.message_id, due_on: "2097-10-08", net_amount: 1138.53, overdue: false },
    ]);

    const sec = securityNotice({ date: "2097-10-08", amount: 1138.53 });
    const san = santanderNotice({ date: "2097-10-08", amount: 1138.53 });
    const res = applyIncomingWires({ apply: true, notices: [sec, san] });
    expect(res.new_notices).toBe(2);
    expect(res.bookings.booked).toHaveLength(1);
    const b = res.bookings.booked[0]!;
    expect(b).toMatchObject({
      value_date: "2097-10-08",
      net_amount: 1138.53,
      fee_amount: 10,
      from_account_id: fintualUsd,
      to_account_id: santanderUsd,
      already_in_ledger: false,
    });
    expect(new Set(b.notices)).toEqual(new Set([sec.message_id, san.message_id]));
    const transfer = db.prepare(`SELECT * FROM movements WHERE id = ?`).get(b.transfer_movement_id) as Record<string, unknown>;
    expect(transfer).toMatchObject({ from_account_id: fintualUsd, to_account_id: santanderUsd, amount: 1138.53, currency: "usd", occurred_on: "2097-10-08" });
    const fee = db.prepare(`SELECT * FROM movements WHERE id = ?`).get(b.fee_movement_id) as Record<string, unknown>;
    expect(fee).toMatchObject({ account_id: fintualUsd, amount: 10, currency: "usd", flow_kind: "cash_fee", occurred_on: "2097-10-08" });

    // Resending everything books nothing more.
    const again = applyIncomingWires({ apply: true, notices: [sec, san] });
    expect(again.new_notices).toBe(0);
    expect(again.bookings.booked).toEqual([]);
    expect(applyBrokerNotifications({ broker: "fintual", apply: true, notifications: [req] }).usd_withdrawals?.waiting).toEqual([]);
  });

  it("books from the receiving bank's notice alone, and from a request that arrives after the wire", () => {
    const san = santanderNotice({ date: "2097-11-09", amount: 500 });
    expect(applyIncomingWires({ apply: true, notices: [san] }).bookings.unmatched).toEqual([
      { value_date: "2097-11-09", amount: 500, account_id: santanderUsd, notices: [san.message_id] },
    ]);
    const req = request({ at: "2097-11-06T15:00:00Z", net: 500, gross: 510, due: "2097-11-09" });
    const res = applyBrokerNotifications({ broker: "fintual", apply: true, notifications: [req] });
    expect(res.usd_withdrawals?.booked).toMatchObject([{ value_date: "2097-11-09", net_amount: 500, fee_amount: 10 }]);
  });

  it("writes nothing without apply", () => {
    const req = request({ at: "2097-12-01T15:00:00Z", net: 200, gross: 210, due: "2097-12-03" });
    const plan = applyBrokerNotifications({ broker: "fintual", apply: false, notifications: [req] });
    expect(plan.usd_withdrawals?.waiting).toHaveLength(1);
    expect(db.prepare(`SELECT 1 FROM broker_withdrawal_requests WHERE message_id = ?`).get(req.message_id)).toBeUndefined();
    const dry = bookIncomingWires({
      apply: false,
      extraRequests: [
        {
          message_id: req.message_id,
          broker: "fintual",
          requested_at: req.occurred_at,
          subject: req.subject,
          currency: "usd",
          gross_amount: 210,
          net_amount: 200,
          destination_account: DEST_NUMBER,
          due_on: "2097-12-03",
        },
      ],
      extraNotices: [securityNotice({ date: "2097-12-03", amount: 200 })],
    });
    expect(dry.booked).toMatchObject([{ net_amount: 200, transfer_movement_id: null, fee_movement_id: null }]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM incoming_wire_bookings WHERE request_message_id = ?`).get(req.message_id)).toEqual({ n: 0 });
  });

  it("leaves a wire from another sender, or for another amount, unpaired", () => {
    const req = request({ at: "2098-01-05T15:00:00Z", net: 300, gross: 310, due: "2098-01-08" });
    applyBrokerNotifications({ broker: "fintual", apply: true, notifications: [req] });
    const res = applyIncomingWires({
      apply: true,
      notices: [
        securityNotice({ date: "2098-01-08", amount: 300, ordering: "SOMEONE ELSE S.A." }),
        securityNotice({ date: "2098-01-08", amount: 299.99 }),
      ],
    });
    expect(res.bookings.booked).toEqual([]);
    expect(res.bookings.unmatched).toHaveLength(2);
    expect(res.bookings.waiting.map((w) => w.request_message_id)).toContain(req.message_id);
  });

  it("reports a request past its pay day as overdue", () => {
    const req = request({ at: "2001-03-01T15:00:00Z", net: 100, gross: 110, due: "2001-03-05" });
    const res = applyBrokerNotifications({ broker: "fintual", apply: true, notifications: [req] });
    expect(res.usd_withdrawals?.waiting.find((w) => w.request_message_id === req.message_id)?.overdue).toBe(true);
  });

  it("takes a transfer entered by hand as the booked one", () => {
    db.prepare(
      `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note) VALUES (?, ?, 700, 'usd', '2098-02-10', 'vitest-wire hand')`
    ).run(fintualUsd, santanderUsd);
    const handId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    applyBrokerNotifications({
      broker: "fintual",
      apply: true,
      notifications: [request({ at: "2098-02-06T15:00:00Z", net: 700, gross: 710, due: "2098-02-10" })],
    });
    const res = applyIncomingWires({ apply: true, notices: [securityNotice({ date: "2098-02-10", amount: 700 })] });
    expect(res.bookings.booked).toMatchObject([{ transfer_movement_id: handId, already_in_ledger: true, fee_amount: 10 }]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM movements WHERE from_account_id = ? AND occurred_on = '2098-02-10'`).get(fintualUsd)).toEqual({ n: 1 });
  });

  it("refuses a resent notice that states something else", () => {
    const sec = securityNotice({ date: "2098-03-10", amount: 50 });
    applyIncomingWires({ apply: true, notices: [sec] });
    expect(() => applyIncomingWires({ apply: true, notices: [{ ...sec, amount: 51 }] })).toThrow(/other content/);
  });
});
