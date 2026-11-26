import { afterEach, describe, expect, it } from "vitest";
import { setDecimalSeparatorForFormatting } from "../format";
import {
  buildPanelAccountCreatePreview,
  defaultPanelAccountFormDraft,
  parseOptionStrike,
} from "./panelAccountFormTypes";

describe("parseOptionStrike", () => {
  afterEach(() => setDecimalSeparatorForFormatting("comma"));

  it("reads the strike in either decimal convention", () => {
    expect(parseOptionStrike("600")).toBe(600);
    expect(parseOptionStrike("600,5")).toBe(600.5);
    expect(parseOptionStrike("600.5")).toBe(600.5);
    setDecimalSeparatorForFormatting("period");
    expect(parseOptionStrike("1,250.5")).toBe(1250.5);
  });

  it("rejects an empty, malformed, non-positive or over-precise strike", () => {
    for (const raw of ["", "abc", "0", "-5", "1,2345"]) {
      expect(parseOptionStrike(raw)).toBeNull();
    }
  });

  it("goes into the option contract's create body", () => {
    const body = buildPanelAccountCreatePreview({
      ...defaultPanelAccountFormDraft("option"),
      optionUnderlying: "spy",
      optionStrike: "612,5",
      optionExpiry: "2027-06-18",
    });
    expect(body?.account.option).toEqual({
      underlying: "SPY",
      right: "C",
      strike: 612.5,
      expiry: "2027-06-18",
    });
  });
});

describe("panelAccountFormTypes", () => {
  it("builds an equity body with ticker, in the chosen bucket", () => {
    const draft = {
      ...defaultPanelAccountFormDraft("equity"),
      displayName: "QQQ",
      tickerSymbol: "QQQ",
    };
    const body = buildPanelAccountCreatePreview(draft);
    expect(body).not.toBeNull();
    expect(body?.account.account_type).toBe("equity");
    expect(body?.account.ticker).toBe("QQQ");
    expect(body?.account.category_slug).toBe("qqq");
    expect(body?.account.bucket_slug).toBe("brokerage_acciones");
  });

  it("builds a crypto body", () => {
    const draft = {
      ...defaultPanelAccountFormDraft("crypto"),
      displayName: "Bitcoin",
      tickerSymbol: "BTC-USD",
    };
    const body = buildPanelAccountCreatePreview(draft);
    expect(body?.account.account_type).toBe("crypto");
    expect(body?.account.ticker).toBe("BTC-USD");
    expect(body?.account.bucket_slug).toBe("brokerage_crypto");
  });

  it("builds a CLP cash body (no ticker) and lets the bucket be overridden", () => {
    const draft = {
      ...defaultPanelAccountFormDraft("clp_cash"),
      displayName: "Efectivo CLP",
      bucketSlug: "real_estate",
    };
    const body = buildPanelAccountCreatePreview(draft);
    expect(body?.account.account_type).toBe("clp_cash");
    expect("ticker" in (body?.account ?? {})).toBe(false);
    expect(body?.account.bucket_slug).toBe("real_estate");
  });

  it("builds a USD cash body", () => {
    const body = buildPanelAccountCreatePreview(defaultPanelAccountFormDraft("usd_cash"));
    expect(body?.account.account_type).toBe("usd_cash");
    expect(body?.account.bucket_slug).toBe("cash_savings");
  });

  it("returns null when an equity ticker is missing", () => {
    const draft = {
      ...defaultPanelAccountFormDraft("equity"),
      displayName: "QQQ",
      tickerSymbol: "",
    };
    expect(buildPanelAccountCreatePreview(draft)).toBeNull();
  });

  it("returns null when the name is missing", () => {
    const draft = { ...defaultPanelAccountFormDraft("usd_cash"), displayName: "" };
    expect(buildPanelAccountCreatePreview(draft)).toBeNull();
  });
});
