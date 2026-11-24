import { describe, expect, it } from "vitest";
import type { CcGlance } from "./ccGlance.js";
import { ccGroupLanesFromInputs, type CcGroupLaneCardInput } from "./ccGroupLanes.js";

const TODAY = "2026-11-24";
const USD_CLP = 1000;

/** A synthetic card glance: only the fields the lanes read. */
function glance(over: Partial<CcGlance> & Pick<CcGlance, "open" | "previous" | "sides">): CcGlance {
  return { billing_currency: "clp", total_owed: null, ...over };
}

function card(accountId: number, g: CcGlance, payBy: Record<string, string>): CcGroupLaneCardInput {
  return {
    accountId,
    name: `test card ${accountId}`,
    colorRgb: "10,20,30",
    glance: g,
    payByIso: (m) => {
      const iso = payBy[m];
      if (!iso) throw new Error(`no pay-by for ${m}`);
      return iso;
    },
    openPayByIso: payBy[g.open.billing_month]!,
    toBillingCurrency: (qty, currency) => (currency === "usd" ? qty * USD_CLP : qty),
  };
}

// Card 1: the November bill still owes pesos and dollars; the open December bill; no cuotas.
const owing = card(
  1,
  glance({
    open: { billing_month: "2026-12", total: 50_000, amounts: [], close_iso: "2026-12-22", days_to_close: 28 },
    previous: {
      billing_month: "2026-11",
      total: 400_000,
      paid: false,
      owed: [
        { currency: "clp", amount: 300_000 },
        { currency: "usd", amount: 100 },
      ],
      pay_by_iso: "2026-12-10",
      days_to_pay_by: 16,
      is_provisional_close: false,
    },
    sides: [
      { currency: "clp", used: 350_000, total: 1_000_000, free: 650_000, used_share: 0.35, segments: [
        { kind: "previous", billing_month: "2026-11", amount: 300_000, share: 0.3 },
        { kind: "purchases", billing_month: "2026-12", amount: 50_000, share: 0.05 },
      ], bracket: null },
      { currency: "usd", used: 100, total: 1_000, free: 900, used_share: 0.1, segments: null, bracket: null },
    ],
    total_owed: 450_000,
  }),
  { "2026-11": "2026-12-10", "2026-12": "2027-01-11" }
);

// Card 2: last bill paid; open bill with its own cuota, and two later months of cuotas.
const paid = card(
  2,
  glance({
    open: { billing_month: "2026-11", total: 80_000, amounts: [], close_iso: "2026-11-25", days_to_close: 1 },
    previous: {
      billing_month: "2026-10",
      total: 200_000,
      paid: true,
      owed: [],
      pay_by_iso: "2026-11-10",
      days_to_pay_by: -14,
      is_provisional_close: false,
    },
    sides: [
      { currency: "clp", used: 140_000, total: null, free: null, used_share: 1, segments: [
        { kind: "purchases", billing_month: "2026-11", amount: 60_000, share: 0.4 },
        { kind: "cuotas", billing_month: "2026-11", amount: 20_000, share: 0.15 },
        { kind: "cuotas", billing_month: "2026-12", amount: 20_000, share: 0.15 },
        { kind: "cuotas", billing_month: "2027-01", amount: 40_000, share: 0.3 },
      ], bracket: null },
    ],
  }),
  { "2026-11": "2026-12-09", "2026-12": "2027-01-11", "2027-01": "2027-02-10" }
);

describe("ccGroupLanesFromInputs", () => {
  const out = ccGroupLanesFromInputs([paid, owing], "clp", TODAY);

  it("orders cards by their next payment and picks it from the bill still owing, else the open bill", () => {
    expect(out.cards.map((c) => c.account_id)).toEqual([2, 1]);
    expect(out.cards[0]!.next_payment).toMatchObject({ billing_month: "2026-11", pay_by_iso: "2026-12-09", amount: 80_000, estimate: true });
    // 300 000 pesos + US$100 at the debt rate.
    expect(out.cards[1]!.next_payment).toMatchObject({ billing_month: "2026-11", pay_by_iso: "2026-12-10", amount: 400_000, estimate: false });
    expect(out.total.next_payment?.account_id).toBe(2);
  });

  it("totals owed per currency and in the billing currency; cupo only when every card has one", () => {
    expect(out.total.owed).toEqual([
      { currency: "clp", amount: 490_000 },
      { currency: "usd", amount: 100 },
    ]);
    expect(out.total.owed_total).toBe(590_000);
    expect(out.total.cuotas_ahead).toBe(80_000);
    expect(out.total.cupo).toBeNull();
    expect(out.cards.find((c) => c.account_id === 1)!.cupo).toEqual({ used: 350_000, total: 1_000_000, used_share: 0.35 });
  });

  it("places events on one axis that reaches the latest open pay-by, leaving out what falls beyond", () => {
    expect(out.axis.end_iso).toBe("2027-01-12");
    const ev = out.cards.find((c) => c.account_id === 1)!.events;
    expect(ev.map((e) => [e.kind, e.iso])).toEqual([
      ["pay_by", "2026-12-10"],
      ["close", "2026-12-22"],
      ["pay_by", "2027-01-11"],
    ]);
    const span = out.axis.days;
    expect(ev[0]!.share).toBeCloseTo((16 + 3) / span);
    expect(out.axis.today_share).toBeCloseTo(3 / span);
  });

  it("puts each payment and each later facturación's cuotas on its pay month; the open month's cuota is in its bill", () => {
    expect(out.upcoming_months).toEqual([
      {
        month: "2026-12",
        total: 480_000,
        parts: [
          { account_id: 2, kind: "open", amount: 80_000 },
          { account_id: 1, kind: "billed", amount: 400_000 },
        ],
      },
      {
        month: "2027-01",
        total: 70_000,
        parts: [
          { account_id: 2, kind: "cuotas", amount: 20_000 },
          { account_id: 1, kind: "open", amount: 50_000 },
        ],
      },
      { month: "2027-02", total: 40_000, parts: [{ account_id: 2, kind: "cuotas", amount: 40_000 }] },
    ]);
  });

  it("throws when a card bills in another currency than the group", () => {
    const usdCard = { ...owing, glance: { ...owing.glance, billing_currency: "usd" } };
    expect(() => ccGroupLanesFromInputs([usdCard], "clp", TODAY)).toThrow(/bills in usd/);
  });
});
