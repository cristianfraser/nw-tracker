import { describe, expect, it } from "vitest";
import { merchantPurchaseDocumentKind } from "nw-tracker-contracts";
import {
  appleMailKind,
  appleMailPayload,
  decodeAppleReceipt,
  decodeAppleSubscriptionNotice,
  htmlToLines,
  parseMailDate,
  parseMoney,
} from "./appStoreMail.js";

/** Every block element breaks a line, as in Apple's table markup. */
const block = (lines: string[]): string => lines.map((l) => `<div>${l}</div>`).join("");
/** The templates render the content twice (desktop, then mobile), each closed by a footer. */
const twice = (lines: string[]): string => `<html><head><style>.x{}</style></head><body>${block(lines)}<p>Copyright &copy; 2030 Apple Inc.</p>${block(lines)}</body></html>`;
const icon = (id: string): string => `<img src="https://is1-ssl.mzstatic.com/image/thumb/Purple1/v4/${id}/AppIcon.png/128x128bb.png">`;

const NEW_LAYOUT_RECEIPT = twice([
  "Invoice",
  "4 July 2030",
  "Order ID:",
  "MTEST0001",
  "Document:",
  "100000000001",
  "Apple Account:",
  "test@example.com",
  `${icon("aa/bb/cc/app-one")}Example Chat: Meet People`,
  "Premium (Monthly)",
  "Renews 4 August 2030",
  "$7.990",
  `${icon("aa/bb/cc/app-two")}Some Game`,
  "Gem Pack",
  "In-App Purchase",
  "Test User&#39;s iPhone",
  "Report a Problem",
  "$1.000",
  "Billing and Payment",
  "Test User",
  "Subtotal",
  "$7.554",
  "VAT charged at 19 %",
  "$1.436",
  "Visa &bull;&bull;&bull;&bull; 0001",
  "$8.990",
]);

const OLD_LAYOUT_RECEIPT = twice([
  "Invoice",
  "APPLE ID",
  "test@example.com",
  "BILLED TO",
  "Visa .... 0002",
  "INVOICE DATE",
  "27 Jun 2030",
  "ORDER ID",
  "MTEST0002",
  "DOCUMENT NO.",
  "100000000002",
  "App Store",
  `${icon("dd/ee/ff/boost")}1 Boost`,
  "In-App Purchase",
  "Test User's iPhone",
  "Report a Problem",
  "$7,190",
  "Subtotal",
  "$6,042",
  "TOTAL",
  "$7,190",
]);

describe("appleMailKind", () => {
  it("takes receipts and subscription mails, nothing else", () => {
    expect(appleMailKind("Your receipt from Apple.")).toBe("receipt");
    expect(appleMailKind("Your invoice from Apple.")).toBe("receipt");
    expect(appleMailKind("Your Subscription Price Increase")).toBe("subscription_notice");
    expect(appleMailKind("Subscription Confirmation")).toBe("subscription_notice");
    expect(appleMailKind("Your Apple ID was used to sign in to iCloud via a web browser.")).toBeNull();
    expect(appleMailKind("Your recent download with your Apple ID")).toBeNull();
  });
});

describe("values", () => {
  it("reads pesos with either grouping mark and dollars with cents, and refuses a peso price with cents", () => {
    expect(parseMoney("$4,990")).toEqual({ amount: 4990, currency: "clp" });
    expect(parseMoney("$8.900")).toEqual({ amount: 8900, currency: "clp" });
    expect(parseMoney("$650")).toEqual({ amount: 650, currency: "clp" });
    expect(parseMoney("USD 4.99")).toEqual({ amount: 4.99, currency: "usd" });
    expect(parseMoney("Some Game")).toBeNull();
    expect(() => parseMoney("$4.99")).toThrow(/peso/);
  });

  it("reads every date layout, a missing year from the mail", () => {
    expect(parseMailDate("24 Jan 2030", null)).toBe("2030-01-24");
    expect(parseMailDate("17 July 2030", null)).toBe("2030-07-17");
    expect(parseMailDate("Sep 9, 2030", null)).toBe("2030-09-09");
    expect(parseMailDate("September 9", "2030-09-01")).toBe("2030-09-09");
    expect(parseMailDate("3 January", "2030-12-20")).toBe("2031-01-03");
  });

  it("breaks lines on blocks and decodes entities", () => {
    expect(htmlToLines("<td>A&nbsp;&amp;&nbsp;B</td><td>C&#8217;s</td>")).toEqual(["A & B", "C’s"]);
  });
});

describe("decodeAppleReceipt", () => {
  it("reads the current layout: date, card, total, each item's app and product, one rendering", () => {
    const r = decodeAppleReceipt(NEW_LAYOUT_RECEIPT);
    expect(r).toMatchObject({ issued_on: "2030-07-04", order_id: "MTEST0001", card_last4: "0001", total: { amount: 8990, currency: "clp" } });
    expect(r.items).toEqual([
      {
        app: "Example Chat: Meet People",
        product: "Premium (Monthly)",
        amount: 7990,
        renews: true,
        period: "month",
        icon_url: "https://is1-ssl.mzstatic.com/image/thumb/Purple1/v4/aa/bb/cc/app-one/AppIcon.png/128x128bb.png",
      },
      expect.objectContaining({ app: "Some Game", product: "Gem Pack", amount: 1000, renews: false, period: null }),
    ]);
  });

  it("leaves the app empty when an in-app item prints only its product", () => {
    const r = decodeAppleReceipt(OLD_LAYOUT_RECEIPT);
    expect(r).toMatchObject({ issued_on: "2030-06-27", card_last4: "0002", total: { amount: 7190, currency: "clp" } });
    expect(r.items).toEqual([expect.objectContaining({ app: null, product: "1 Boost", amount: 7190, renews: false })]);
  });

  it("throws when the items do not add up to the total", () => {
    expect(() => decodeAppleReceipt(NEW_LAYOUT_RECEIPT.replace("$8.990", "$9.990"))).toThrow(/add up/);
  });
});

describe("decodeAppleSubscriptionNotice", () => {
  it("reads a price increase: the new price and the day it starts", () => {
    const html = twice([
      "Subscription Price Increase",
      "Example Music",
      "Individual (1 month)",
      "New $4.990 — Old $4.490",
      "Starting 24 August 2030",
      "Dear Test,",
    ]);
    expect(decodeAppleSubscriptionNotice(html, "Your Subscription Price Increase", "2030-07-28")).toEqual([
      {
        type: "subscription_notice",
        notice: "price_increase",
        mailed_on: "2030-07-28",
        app: "Example Music",
        plan: "Individual (1 month)",
        price: { amount: 4990, currency: "clp" },
        period: "month",
        purchased_on: null,
        next_charge_on: "2030-08-24",
        expires_on: null,
        card_last4: null,
      },
    ]);
  });

  it("reads a confirmation: purchase day, card, and no purchase day for a free trial", () => {
    const lines = [
      "Subscription Confirmation",
      "Example Chat",
      "Dear Test,",
      "App",
      "Example Chat - Meet People",
      "Subscription",
      "Plus",
      "Date of Purchase",
      "06 May 2030",
      "Subscription Price",
      "$6.500/month",
      "Payment Method",
      "MasterCard .... 0003",
      "Your subscription will renew at $6.500 unless you cancel by 05 June 2030.",
    ];
    const [paid] = decodeAppleSubscriptionNotice(twice(lines), "Your Subscription Confirmation", "2030-05-07");
    expect(paid).toMatchObject({ notice: "confirmed", app: "Example Chat - Meet People", plan: "Plus", purchased_on: "2030-05-06", next_charge_on: "2030-06-06", card_last4: "0003" });
    const trial = lines.map((l) => (l.startsWith("Your subscription") ? "You will not be charged for your free trial. Once it ends, your subscription will renew at $6.500 unless you cancel by 13 May 2030." : l));
    const [free] = decodeAppleSubscriptionNotice(twice(trial), "Your Subscription Confirmation", "2030-05-07");
    expect(free).toMatchObject({ purchased_on: null, next_charge_on: "2030-05-14" });
  });

  it("splits a digest of renewals into one notice per plan", () => {
    const html = twice([
      "Subscription Renewals",
      "Dear Test,",
      "Example LLC - XTRA (3 months) - $16.500/3 months starting 25 January 2031",
      "Other Inc. - Premium (1 year) - $24.500/year starting 16 December 2030",
    ]);
    const notices = decodeAppleSubscriptionNotice(html, "Your Subscription Renewals", "2030-12-16");
    expect(notices.map((n) => [n.app, n.price.amount, n.period, n.next_charge_on])).toEqual([
      ["Example LLC", 16500, "quarter", "2031-01-25"],
      ["Other Inc.", 24500, "year", "2030-12-16"],
    ]);
  });
});

describe("appleMailPayload", () => {
  it("builds a payload the contract accepts", () => {
    const payload = appleMailPayload({ message_id: "<m1@test>", subject: "Your receipt from Apple.", date: "2030-07-05T01:00:00.000Z", html: NEW_LAYOUT_RECEIPT });
    expect(merchantPurchaseDocumentKind.payload.parse(payload)).toEqual(payload);
    expect(payload.merchant).toBe("apple_app_store");
  });
});
