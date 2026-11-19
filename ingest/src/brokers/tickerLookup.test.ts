import { describe, expect, it } from "vitest";
import { companyNameKey, describeTickerHint, tickerHintFromSearch } from "./tickerLookup.js";

/** Yahoo's answer for «Anthropic PBC» on 2026-11-19 (symbol, type, exchange, name only). */
const ANTHROPIC = [
  { symbol: "ANT", quoteType: "EQUITY", exchange: "NMS", longname: "Anthropic, PBC" },
  { symbol: "ANT.SW", quoteType: "EQUITY", exchange: "EBS", longname: "Anthropic, PBC" },
  { symbol: "ANT42868-USD", quoteType: "CRYPTOCURRENCY", exchange: "CCC", longname: "Anthropic PBC (Derivatives) USD" },
];

describe("tickerHintFromSearch", () => {
  it("names the one US listing whose name is the mail's", () => {
    expect(tickerHintFromSearch("Anthropic PBC", ANTHROPIC)).toEqual({
      kind: "match",
      symbol: "ANT",
      name: "Anthropic, PBC",
      exchange: "NMS",
    });
  });

  it("gives no match when only a similar name is listed, or two US lines share it", () => {
    const similar = tickerHintFromSearch("Anthropic Holdings", ANTHROPIC);
    expect(similar.kind).toBe("none");
    const twice = tickerHintFromSearch("Anthropic PBC", [
      ...ANTHROPIC,
      { symbol: "ANTB", quoteType: "EQUITY", exchange: "NYQ", longname: "Anthropic PBC" },
    ]);
    expect(twice).toEqual({ kind: "none", candidates: ["ANT (Anthropic, PBC, NMS)", "ANTB (Anthropic PBC, NYQ)"] });
  });

  it("compares names without punctuation, accents or legal suffixes", () => {
    expect(companyNameKey("Linde plc")).toBe(companyNameKey("LINDE"));
    expect(companyNameKey("Cameco Corporation")).toBe("cameco");
  });

  it("words the hint with the mail's price", () => {
    expect(describeTickerHint("Anthropic PBC", 100.5, tickerHintFromSearch("Anthropic PBC", ANTHROPIC))).toBe(
      'Yahoo lists "Anthropic, PBC" as ANT on NMS (the mail\'s price US$100.5) — if that is it, map /Anthropic PBC/ → ANT in FUND_NAME_TICKERS'
    );
  });
});
