import { describe, expect, it } from "vitest";
import { brokerNotificationIsBookable, racionalFetchDecision } from "./brokerNotifications.js";
import { brokerNotification } from "./test/brokerNotificationFixtures.js";

const noComision = { due: false, reason: null };

function racionalDividend(at: string, gross: number | null) {
  return brokerNotification({
    kind: "dividend",
    subject: "Recibiste dividendos de VTDIV",
    occurred_at: at,
    ticker: "VTDIV",
    gross_amount: gross,
    currency: "usd",
  });
}

describe("brokerNotificationIsBookable", () => {
  it("books what states its amount, never a gross-only dividend", () => {
    expect(
      brokerNotificationIsBookable(
        brokerNotification({ kind: "deposit", subject: "d", occurred_at: "2097-01-02T12:00:00Z", amount: 1000, currency: "clp" })
      )
    ).toBe(true);
    expect(brokerNotificationIsBookable(racionalDividend("2097-01-02T12:00:00Z", 2.75))).toBe(false);
    // A buy needs the share count as well as the money.
    expect(
      brokerNotificationIsBookable(
        brokerNotification({ kind: "buy", subject: "b", occurred_at: "2097-01-02T12:00:00Z", amount: 10, currency: "usd" })
      )
    ).toBe(false);
  });
});

describe("racionalFetchDecision", () => {
  it("asks for a crawl only for nudges no clean crawl has answered", () => {
    // Notifications are re-sent every run, so without the coverage check one dividend mail kept
    // the Racional crawl running every night long after its dividend was booked.
    const first = racionalDividend("2097-09-18T11:57:16.000Z", 1.23);
    const second = racionalDividend("2097-09-22T10:40:49.000Z", null);
    const deposit = brokerNotification({
      kind: "deposit",
      subject: "Tu depósito",
      occurred_at: "2097-09-20T12:00:00Z",
      amount: 1000,
      currency: "clp",
    });

    expect(racionalFetchDecision([deposit], null, noComision).needed).toBe(false);
    expect(racionalFetchDecision([first], null, noComision)).toMatchObject({ needed: true, nudges: 1, answered: 0 });
    // A crawl from before the mail answers nothing.
    expect(racionalFetchDecision([first], "2097-09-18T01:00:00.000Z", noComision).needed).toBe(true);

    const covered = racionalFetchDecision([first, second, deposit], "2097-09-21T01:10:48.000Z", noComision);
    expect(covered).toMatchObject({ needed: true, nudges: 2, answered: 1 });
    expect(covered.reasons).toHaveLength(1); // the newer nudge still asks

    expect(racionalFetchDecision([first, second], "2097-09-24T01:11:30.000Z", noComision)).toMatchObject({
      needed: false,
      answered: 2,
    });
  });

  it("asks for the monthly comisión, which sends no mail", () => {
    const decision = racionalFetchDecision([], null, { due: true, reason: "no portafolio comisión recorded" });
    expect(decision).toMatchObject({ needed: true, reasons: ["no portafolio comisión recorded"] });
  });

  it("fails fast on a coverage stamp that is not a timestamp", () => {
    expect(() => racionalFetchDecision([], "x", noComision)).toThrow(/not a timestamp/);
  });
});
