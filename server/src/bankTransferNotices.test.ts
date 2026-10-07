import { describe, expect, it } from "vitest";
import type { TransferNotice } from "nw-tracker-contracts";
import { matchTransferNotices, type TransferCandidateLeg } from "./bankTransferNotices.js";

const CORRIENTE = 1;
const VISTA = 2;
const FUND = 9;
const tracked = new Map([
  ["11111", CORRIENTE],
  ["22222", VISTA],
]);
const party = (account_number: string | null, name: string | null = null) => ({
  name, rut: null, bank: null, account_type: null, account_number, email: null,
});
let seq = 0;
function notice(kind: TransferNotice["kind"], sent: string, amount: number, from: string | null, to: string | null, name?: string): TransferNotice {
  return {
    message_id: `m${++seq}`, sent_at_chile: sent, subject: "Transferencia", kind, date: sent.slice(0, 10), amount,
    from: party(from), to: party(to, name ?? null), comment: null, scheduled: false,
  };
}
const leg = (movement_id: number, account_id: number, day: string, amount: number, other: number | null = null): TransferCandidateLeg => ({
  movement_id, account_id, other_account_id: other, day, amount,
});

describe("matchTransferNotices", () => {
  it("pairs an outgoing mail with the debit posted within the window, not a transfer between own accounts", () => {
    const legs = [leg(1, VISTA, "2036-07-01", -700000, CORRIENTE), leg(1, CORRIENTE, "2036-07-01", 700000, VISTA), leg(2, VISTA, "2036-07-01", -700000, FUND)];
    const out = notice("outgoing", "2036-06-30 23:20", 700000, "22222", "917", "FONDO");
    const own = notice("between_own_products", "2036-07-01 14:14", 700000, "22222", "11111");
    const r = matchTransferNotices([own, out], tracked, legs);
    expect(r.pairs).toEqual([
      { message_id: out.message_id, movement_id: 2, account_id: VISTA },
      { message_id: own.message_id, movement_id: 1, account_id: VISTA },
      { message_id: own.message_id, movement_id: 1, account_id: CORRIENTE },
    ]);
  });

  it("pairs each bank row once: the second mail of one transfer and the schedule notice find nothing", () => {
    const legs = [leg(5, CORRIENTE, "2036-03-02", -600000)];
    const scheduled = notice("schedule_created", "2036-03-01 20:00", 600000, "11111", "333");
    const ran = notice("outgoing", "2036-03-02 10:00", 600000, "11111", "333");
    const echo = notice("incoming", "2036-03-02 10:00", 600000, null, "444");
    const r = matchTransferNotices([scheduled, ran, echo], tracked, legs);
    expect(r.pairs).toEqual([{ message_id: ran.message_id, movement_id: 5, account_id: CORRIENTE }]);
    expect(Object.values(r.unpaired).reduce((a, b) => a + b, 0)).toBe(2);
  });

  it("pairs same-day twins in order and reports a tie between different rows", () => {
    const twins = [leg(10, CORRIENTE, "2036-05-04", -60000), leg(11, CORRIENTE, "2036-05-04", -60000)];
    const a = notice("outgoing", "2036-05-04 10:00", 60000, "11111", "555");
    const b = notice("outgoing", "2036-05-04 11:00", 60000, "11111", "555");
    expect(matchTransferNotices([a, b], tracked, twins).pairs.map((p) => p.movement_id)).toEqual([10, 11]);

    const different = [leg(20, CORRIENTE, "2036-05-04", -60000, 10), leg(21, CORRIENTE, "2036-05-04", -60000, FUND)];
    const r = matchTransferNotices([notice("outgoing", "2036-05-04 10:00", 60000, "11111", "555")], tracked, different);
    expect(r.pairs).toEqual([]);
    expect(r.ambiguous).toHaveLength(1);
  });

  it("leaves a mail from before the account's first bank row unpaired as history, not as a missing row", () => {
    const r = matchTransferNotices([notice("incoming", "2030-01-01 10:00", 5000, null, "11111")], tracked, [leg(1, CORRIENTE, "2036-01-01", 1)]);
    expect(r.unpaired).toEqual({ "before the account's bank history": 1 });
  });
});

describe("matchTransferNotices with known counterparties", () => {
  it("pairs a mail to the fund manager with the transfer into the fund, and a third-party payment with the plain debit", () => {
    const legs = [leg(30, CORRIENTE, "2036-04-01", -600000, FUND), leg(31, CORRIENTE, "2036-04-01", -600000)];
    const fund = notice("outgoing", "2036-03-31 21:34", 600000, "11111", "777", "FONDO");
    fund.to.rut = "76.000.000-1";
    const rent = notice("outgoing", "2036-03-31 22:00", 600000, "11111", "888", "ARRIENDO");
    const counterparties = { byRut: new Map([["760000001", new Set([FUND])]]), byNumber: new Map() };
    const r = matchTransferNotices([rent, fund], tracked, legs, counterparties);
    expect(Object.fromEntries(r.pairs.map((p) => [p.message_id, p.movement_id]))).toEqual({ [fund.message_id]: 30, [rent.message_id]: 31 });
  });
});
