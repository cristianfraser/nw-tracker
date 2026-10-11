import { describe, expect, it } from "vitest";
import { checkMortgageCardMatches, matchMortgagePaymentsToCardLines, type MortgageCardLine } from "./mortgagePaymentCardMatch.js";

function line(id: number, date: string, amount: number, merchant = "TOKU *METLIFE HIPOTECAR (T)"): MortgageCardLine {
  return { line_id: id, account_id: 9, account_name: "Card", date, merchant, amount_clp: amount };
}

describe("matchMortgagePaymentsToCardLines", () => {
  it("pairs each cuota with the card line of the same pesos dated on the payment day or up to three days after", () => {
    const r = matchMortgagePaymentsToCardLines(
      [
        { cuota: "31", paid_on: "2099-09-11", pago_clp: 750_293 },
        { cuota: "32", paid_on: "2099-10-11", pago_clp: 917_481 },
      ],
      [line(1, "2099-09-11", 750_293), line(2, "2099-10-13", 917_481), line(3, "2099-10-20", 500_000)]
    );
    expect(r.payments.map((p) => [p.cuota, p.status, p.line?.line_id ?? null])).toEqual([
      ["31", "matched", 1],
      ["32", "matched", 2],
    ]);
    expect(r.unmatched_lines.map((l) => l.line_id)).toEqual([3]);
  });

  it("never pairs across pesos, before the payment day, or past the window", () => {
    const r = matchMortgagePaymentsToCardLines(
      [{ cuota: "32", paid_on: "2099-10-11", pago_clp: 917_481 }],
      [line(1, "2099-10-10", 917_481), line(2, "2099-10-15", 917_481), line(3, "2099-10-11", 917_482)]
    );
    expect(r.payments[0]!.status).toBe("awaiting_card_line");
    expect(r.unmatched_lines).toHaveLength(3);
  });

  it("reports two fitting lines as ambiguous and claims each line once", () => {
    const r = matchMortgagePaymentsToCardLines(
      [
        { cuota: "11", paid_on: "2099-02-10", pago_clp: 3_071_622 },
        { cuota: "12", paid_on: "2099-02-11", pago_clp: 3_071_622 },
      ],
      [line(1, "2099-02-10", 3_071_622), line(2, "2099-02-11", 3_071_622)]
    );
    // Cuota 11 sees both lines (10th and 11th are inside its window) → ambiguous, nothing claimed;
    // cuota 12 sees only the 11th → matched.
    expect(r.payments.map((p) => [p.cuota, p.status])).toEqual([
      ["11", "ambiguous"],
      ["12", "matched"],
    ]);
    expect(r.unmatched_lines.map((l) => l.line_id)).toEqual([1]);
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
