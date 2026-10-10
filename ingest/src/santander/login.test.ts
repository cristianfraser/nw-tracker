import { describe, expect, it } from "vitest";
import { isPrivateAppUrl, landingPageReady } from "./login.js";

describe("isPrivateAppUrl", () => {
  it("is a private-app hash route", () => {
    expect(isPrivateAppUrl("https://mibanco.santander.cl/UI.Web.HB/Private_new/frame/#/private/Saldos_TC/main/bill")).toBe(true);
  });

  it("is neither the public homepage nor the login frame", () => {
    expect(isPrivateAppUrl("https://banco.santander.cl/")).toBe(false);
    expect(isPrivateAppUrl("https://mibanco.santander.cl/UI.Web.HB/Private_new/frame/#/public/login-frame/ing/0010")).toBe(false);
  });
});

describe("landingPageReady", () => {
  it("needs a private route AND a product-summary call newer than the baseline", () => {
    expect(landingPageReady({ loggedIn: true, productSummaryCalls: 1, baselineCount: 0 })).toBe(true);
  });

  it("is not ready while the landing page has not asked for the product summary yet", () => {
    expect(landingPageReady({ loggedIn: true, productSummaryCalls: 0, baselineCount: 0 })).toBe(false);
  });

  it("does not count a call from an earlier landing (a re-login mid-run)", () => {
    expect(landingPageReady({ loggedIn: true, productSummaryCalls: 1, baselineCount: 1 })).toBe(false);
    expect(landingPageReady({ loggedIn: true, productSummaryCalls: 2, baselineCount: 1 })).toBe(true);
  });

  it("is not ready off the private app even with the call on record", () => {
    expect(landingPageReady({ loggedIn: false, productSummaryCalls: 1, baselineCount: 0 })).toBe(false);
  });
});
