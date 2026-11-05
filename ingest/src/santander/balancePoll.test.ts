import { describe, expect, it } from "vitest";
import { formatBalancePollResult, parseBalancePollResult, santanderProductSummaryPayload } from "./balancePoll.js";

const cents = (amount: number) => String(Math.round(amount * 100)).padStart(18, "0");
const OBSERVED = "2026-11-05T18:30:12.000Z";

describe("santanderProductSummaryPayload", () => {
  it("states the card cupos and the deposit balances of one login", () => {
    const payload = santanderProductSummaryPayload({
      cupos: {
        observedAt: OBSERVED,
        rows: [
          {
            NUMEROCONTRATO: "800099990033",
            NUMEROPAN: "0000000000009933",
            CODIGOMONEDA: "CLP",
            CUPO: cents(5_000_000),
            MONTOUTILIZADO: cents(1_000_000),
            MONTODISPONIBLE: cents(4_000_000),
          },
        ],
      },
      accounts: {
        observedAt: OBSERVED,
        rows: [{ NUMEROCONTRATO: "005199990001", AGRUPACIONCOMERCIAL: "CCC", CODIGOMONEDA: "CLP", MONTODISPONIBLE: cents(413_441) }],
      },
    });
    expect(payload).toMatchObject({
      issuer: "santander",
      observed_at: OBSERVED,
      cards: { status: "observed", rows: [{ card_last4: "9933", currency: "clp", used: 1_000_000 }] },
      accounts: [{ number: "005199990001", product: "checking", currency: "clp", balance: 413_441 }],
    });
  });

  it("keeps the deposit balances when the card rows are missing, and throws on a login that stated nothing", () => {
    const accountsOnly = santanderProductSummaryPayload({
      cupos: null,
      cuposError: "no TCR rows",
      accounts: {
        observedAt: OBSERVED,
        rows: [{ NUMEROCONTRATO: "005199990001", AGRUPACIONCOMERCIAL: "CCC", CODIGOMONEDA: "CLP", MONTODISPONIBLE: cents(1) }],
      },
    });
    expect(accountsOnly.cards).toEqual({ status: "unavailable", reason: "no TCR rows" });
    expect(() =>
      santanderProductSummaryPayload({ cupos: null, cuposError: "no call", accounts: null, accountsError: "no call" })
    ).toThrow(/stated no product/);
  });
});

describe("balance poll result line", () => {
  it("round-trips through the step's output, the last line winning", () => {
    expect(parseBalancePollResult(`[18:30:13] ${formatBalancePollResult([])}`)).toEqual([]);
    const out = `x\n[18:30:13] ${formatBalancePollResult(["card-movements", "checking-usd-movements"])}\n`;
    expect(parseBalancePollResult(out)).toEqual(["card-movements", "checking-usd-movements"]);
    expect(parseBalancePollResult("login failed")).toBeNull();
    expect(() => parseBalancePollResult("balance poll fetch: statements")).toThrow(/unknown balance poll step/);
  });
});
