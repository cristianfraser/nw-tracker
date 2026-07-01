import { describe, expect, it } from "vitest";
import {
  buildPanelAccountCreatePreview,
  defaultPanelAccountFormDraft,
} from "./panelAccountFormTypes";

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
