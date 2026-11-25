import { describe, expect, it } from "vitest";
import type { CcGlance } from "./ccGlance.js";
import { ccGroupLanesFromInputs, type CcGroupLaneCardInput } from "./ccGroupLanes.js";

const TODAY = "2026-11-24";

/** A synthetic card glance: only the fields the lanes read. */
function glance(over: Partial<CcGlance> & Pick<CcGlance, "open" | "previous" | "sides">): CcGlance {
  return { billing_currency: "clp", total_owed: null, ...over };
}

type Pay = CcGroupLaneCardInput["payments"][number];
const pay = (billing_month: string, pay_by_iso: string, amount_clp: number, is_open_month: boolean, overdue = false): Pay => ({
  billing_month,
  pay_by_iso,
  amount_clp,
  is_open_month,
  overdue,
});

function card(
  accountId: number,
  g: CcGlance,
  payments: Pay[],
  payBy: Record<string, string>,
  cuotaMonths: CcGroupLaneCardInput["cuotaMonths"] = []
): CcGroupLaneCardInput {
  return {
    accountId,
    name: `test card ${accountId}`,
    colorRgb: "10,20,30",
    glance: g,
    payments,
    openPayByIso: payBy[g.open.billing_month]!,
    payByIso: (m) => {
      const iso = payBy[m];
      if (!iso) throw new Error(`no pay-by for ${m}`);
      return iso;
    },
    cuotaMonths,
  };
}

const side = (currency: string, used: number, total: number | null, segments: CcGlance["sides"][number]["segments"] = null) => ({
  currency,
  used,
  total,
  free: total == null ? null : total - used,
  used_share: 0,
  segments,
  bracket: null,
});

// Card 1: the November bill still owes 400 000 (pesos and dollars, as «Próximos pagos» values them);
// the open December bill is 50 000 gross but owes 30 000 after a refund the closed bill used.
const owing = card(
  1,
  glance({
    open: { billing_month: "2026-12", total: 50_000, amounts: [], close_iso: "2026-12-22", days_to_close: 28 },
    previous: { billing_month: "2026-11", total: 420_000, paid: false, owed: [], pay_by_iso: "2026-12-10", days_to_pay_by: 16, is_provisional_close: false },
    sides: [
      side("clp", 350_000, 1_000_000, [
        { kind: "previous", billing_month: "2026-11", amount: 300_000, share: 0 },
        { kind: "purchases", billing_month: "2026-12", amount: 50_000, share: 0 },
      ]),
      side("usd", 100, 1_000),
    ],
    total_owed: 450_000,
  }),
  [pay("2026-11", "2026-12-10", 400_000, false), pay("2026-12", "2027-01-11", 30_000, true)],
  { "2026-11": "2026-12-10", "2026-12": "2027-01-11" }
);

// Card 2: last bill paid; the open bill with its own cuota; two later facturaciones of cuotas whose
// billed amounts (interest included) differ from the principal segments.
const paid = card(
  2,
  glance({
    open: { billing_month: "2026-11", total: 80_000, amounts: [], close_iso: "2026-11-25", days_to_close: 1 },
    previous: { billing_month: "2026-10", total: 200_000, paid: true, owed: [], pay_by_iso: "2026-11-10", days_to_pay_by: -14, is_provisional_close: false },
    sides: [
      side("clp", 140_000, null, [
        { kind: "purchases", billing_month: "2026-11", amount: 60_000, share: 0 },
        { kind: "cuotas", billing_month: "2026-11", amount: 20_000, share: 0 },
        { kind: "cuotas", billing_month: "2026-12", amount: 20_000, share: 0 },
        { kind: "cuotas", billing_month: "2027-01", amount: 40_000, share: 0 },
      ]),
    ],
  }),
  [pay("2026-11", "2026-12-09", 80_000, true)],
  { "2026-11": "2026-12-09", "2026-12": "2027-01-11", "2027-01": "2027-02-10" },
  [
    { month: "2026-11", total: 22_000, pay_by_date: "2026-12-09" },
    { month: "2026-12", total: 22_000, pay_by_date: "2027-01-11" },
    { month: "2027-01", total: 43_000, pay_by_date: "2027-02-10" },
  ]
);

// Card 3: owes nothing anywhere (an empty open cycle, last bill paid).
const idle = card(
  3,
  glance({
    open: { billing_month: "2026-12", total: 0, amounts: [], close_iso: "2026-12-05", days_to_close: 11 },
    previous: { billing_month: "2026-11", total: 10_000, paid: true, owed: [], pay_by_iso: "2026-11-20", days_to_pay_by: -4, is_provisional_close: false },
    sides: [side("clp", 0, 500_000, [])],
  }),
  [],
  { "2026-12": "2026-12-21" }
);

describe("ccGroupLanesFromInputs", () => {
  const out = ccGroupLanesFromInputs([idle, paid, owing], "clp", TODAY);

  it("takes each payment from «Próximos pagos»' rows, not the open bill's gross total", () => {
    const c1 = out.cards.find((c) => c.account_id === 1)!;
    expect(c1.events.map((e) => [e.kind, e.iso, e.amount])).toEqual([
      ["pay_by", "2026-12-10", 400_000],
      ["close", "2026-12-22", 50_000],
      ["pay_by", "2027-01-11", 30_000],
    ]);
    expect(c1.next_payment).toMatchObject({ billing_month: "2026-11", amount: 400_000, estimate: false });
  });

  it("orders cards by next payment, an idle card last with none and no pay-by on its lane", () => {
    expect(out.cards.map((c) => c.account_id)).toEqual([2, 1, 3]);
    const c3 = out.cards[2]!;
    expect(c3.next_payment).toBeNull();
    expect(c3.events.map((e) => e.kind)).toEqual(["close"]);
    expect(out.total.next_payment).toMatchObject({ account_id: 2, pay_by_iso: "2026-12-09", amount: 80_000, estimate: true });
  });

  it("totals owed per currency and in the billing currency; cupo only when every card has one", () => {
    expect(out.total.owed).toEqual([
      { currency: "clp", amount: 490_000 },
      { currency: "usd", amount: 100 },
    ]);
    expect(out.total.owed_total).toBe(590_000);
    expect(out.total.cuotas_ahead).toBe(80_000);
    expect(out.total.cupo).toBeNull();
  });

  it("puts payments and the later facturaciones' billed cuotas on their pay months", () => {
    expect(out.upcoming_months).toEqual([
      {
        month: "2026-12",
        total: 480_000,
        parts: [
          { account_id: 2, kind: "open", amount: 80_000 },
          { account_id: 1, kind: "billed", amount: 400_000 },
        ],
        by_card: [
          { account_id: 2, amount: 80_000, estimate: true },
          { account_id: 1, amount: 400_000, estimate: false },
        ],
      },
      {
        month: "2027-01",
        total: 52_000,
        parts: [
          { account_id: 2, kind: "cuotas", amount: 22_000 },
          { account_id: 1, kind: "open", amount: 30_000 },
        ],
        by_card: [
          { account_id: 2, amount: 22_000, estimate: false },
          { account_id: 1, amount: 30_000, estimate: true },
        ],
      },
      {
        month: "2027-02",
        total: 43_000,
        parts: [{ account_id: 2, kind: "cuotas", amount: 43_000 }],
        by_card: [{ account_id: 2, amount: 43_000, estimate: false }],
      },
    ]);
  });

  it("counts an overdue bill in the current month", () => {
    const late = card(
      4,
      glance({
        open: { billing_month: "2026-12", total: 0, amounts: [], close_iso: "2026-12-15", days_to_close: 21 },
        previous: { billing_month: "2026-10", total: 90_000, paid: false, owed: [], pay_by_iso: "2026-10-30", days_to_pay_by: -25, is_provisional_close: false },
        sides: [side("clp", 90_000, 500_000, [{ kind: "previous", billing_month: "2026-10", amount: 90_000, share: 0 }])],
      }),
      [pay("2026-10", "2026-10-30", 90_000, false, true)],
      { "2026-12": "2027-01-05" }
    );
    const r = ccGroupLanesFromInputs([late], "clp", TODAY);
    expect(r.upcoming_months).toEqual([
      {
        month: "2026-11",
        total: 90_000,
        parts: [{ account_id: 4, kind: "billed", amount: 90_000 }],
        by_card: [{ account_id: 4, amount: 90_000, estimate: false }],
      },
    ]);
    expect(r.cards[0]!.next_payment).toMatchObject({ days: -25 });
  });

  it("a group with no billing card is an empty payload", () => {
    const r = ccGroupLanesFromInputs([], "clp", TODAY);
    expect(r.cards).toEqual([]);
    expect(r.upcoming_months).toEqual([]);
    expect(r.total.next_payment).toBeNull();
  });

  it("throws when a card bills in another currency than the group", () => {
    const usdCard = { ...owing, glance: { ...owing.glance, billing_currency: "usd" } };
    expect(() => ccGroupLanesFromInputs([usdCard], "clp", TODAY)).toThrow(/bills in usd/);
  });
});
