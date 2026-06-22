import { describe, expect, it } from "vitest";
import {
  buildPanelAccountCreatePreview,
  defaultPanelAccountFormDraft,
} from "./panelAccountFormTypes";

describe("panelAccountFormTypes", () => {
  it("builds stock preview for stocks_nyse", () => {
    const draft = {
      ...defaultPanelAccountFormDraft("stocks_nyse"),
      displayName: "QQQ",
      tickerSymbol: "QQQ",
    };
    const preview = buildPanelAccountCreatePreview(draft);
    expect(preview).not.toBeNull();
    expect(preview && "account" in preview && "ticker" in preview.account).toBe(true);
    if (!preview || !("ticker" in preview.account)) return;
    expect(preview.account.ticker).toBe("QQQ");
    expect(preview.account.price_source).toBe("stocks_nyse");
    expect(preview.account.bucket_slug).toBe("brokerage_acciones");
  });

  it("builds stock preview for crypto_eod", () => {
    const draft = {
      ...defaultPanelAccountFormDraft("crypto_eod"),
      displayName: "Bitcoin",
      tickerSymbol: "BTC-USD",
    };
    const preview = buildPanelAccountCreatePreview(draft);
    expect(preview).not.toBeNull();
    if (!preview || !("ticker" in preview.account)) return;
    expect(preview.account.ticker).toBe("BTC-USD");
    expect(preview.account.price_source).toBe("crypto_eod");
    expect(preview.account.bucket_slug).toBe("brokerage_crypto");
  });

  it("builds USD cash preview with kind discriminator", () => {
    const draft = defaultPanelAccountFormDraft("usd_cash");
    const preview = buildPanelAccountCreatePreview(draft);
    expect(preview).not.toBeNull();
    if (!preview) return;
    expect("kind" in preview.account && preview.account.kind).toBe("usd_cash");
    expect(preview.account.bucket_slug).toBe("cash_savings");
  });

  it("returns null when equity ticker is missing", () => {
    const draft = {
      ...defaultPanelAccountFormDraft("stocks_nyse"),
      displayName: "QQQ",
      tickerSymbol: "",
    };
    expect(buildPanelAccountCreatePreview(draft)).toBeNull();
  });

  it("returns null when USD cash name is missing", () => {
    const draft = {
      ...defaultPanelAccountFormDraft("usd_cash"),
      displayName: "",
    };
    expect(buildPanelAccountCreatePreview(draft)).toBeNull();
  });
});
