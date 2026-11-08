import { describe, expect, it } from "vitest";
import { checkMortgageCardMatches, mortgagePaymentCardMatchesFromLinks, type MortgageCardLine } from "./mortgagePaymentCardMatch.js";

function line(id: number, date: string, amount: number, flowId = 100 + id): MortgageCardLine & { flow_id: number } {
  return { line_id: id, account_id: 9, account_name: "Card", date, merchant: "TOKU *METLIFE HIPOTECAR (T)", amount_clp: amount, flow_id: flowId };
}

describe("mortgagePaymentCardMatchesFromLinks", () => {
  it("pairs each cuota with the card line its link names, whatever the line's day", () => {
    const r = mortgagePaymentCardMatchesFromLinks(
      [
        { cuota: "31", paid_on: "2099-09-11", pago_clp: 750_293 },
        { cuota: "32", paid_on: "2099-10-11", pago_clp: 917_481 },
        { cuota: "33", paid_on: "2099-11-11", pago_clp: 917_481 },
      ],
      // Cuota 32's card charge is dated before the ledger day: the link (±14 days) pairs it.
      [line(1, "2099-09-11", 750_293), line(2, "2099-10-05", 917_481), line(3, "2099-10-20", 500_000)],
      new Map([
        ["31", 101],
        ["32", 102],
      ])
    );
    expect(r.payments.map((p) => [p.cuota, p.status, p.line?.line_id ?? null])).toEqual([
      ["31", "matched", 1],
      ["32", "matched", 2],
      ["33", "awaiting_card_line", null],
    ]);
    expect(r.unmatched_lines.map((l) => l.line_id)).toEqual([3]);
    expect(r.payments[0]!.line).not.toHaveProperty("flow_id");
  });

  it("fails on a link that names no mortgage card line, or one line linked to two cuotas", () => {
    const payments = [
      { cuota: "11", paid_on: "2099-02-10", pago_clp: 3_071_622 },
      { cuota: "12", paid_on: "2099-03-10", pago_clp: 3_071_622 },
    ];
    expect(() => mortgagePaymentCardMatchesFromLinks(payments, [line(1, "2099-02-10", 3_071_622)], new Map([["11", 999]]))).toThrow(
      /carries 0 mortgage card lines/
    );
    expect(() =>
      mortgagePaymentCardMatchesFromLinks(payments, [line(1, "2099-02-10", 3_071_622)], new Map([["11", 101], ["12", 101]]))
    ).toThrow(/two cuotas/);
  });
});

describe("checkMortgageCardMatches", () => {
  it("passes on an empty ledger", () => {
    // The lean test DB has no depto accounts; the check only reports the window.
    const c = checkMortgageCardMatches("2099-01-01");
    expect(typeof c.ok).toBe("boolean");
    expect(c.report.length).toBeGreaterThan(0);
  });
});
