import { describe, expect, it } from "vitest";
import { isTruncatedMerchantOf, WEB_PASTE_MERCHANT_TRUNCATION_WIDTH } from "./ccTruncatedMerchantDedupe.js";

describe("isTruncatedMerchantOf", () => {
  it("matches the real Santander web-table truncations", () => {
    // Both observed 2026-08-06 in the open bucket alongside their full twins.
    expect(isTruncatedMerchantOf("MERPAGO*PLANOUT", "MERPAGO*PLANOUTCANALDEVEN")).toBe(true);
    expect(isTruncatedMerchantOf("ANTHROPIC* CLAU", "ANTHROPIC* CLAUDE SUB")).toBe(true);
    expect("MERPAGO*PLANOUT".length).toBe(WEB_PASTE_MERCHANT_TRUNCATION_WIDTH);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(isTruncatedMerchantOf("anthropic* clau", "ANTHROPIC*  CLAUDE SUB")).toBe(true);
  });

  it("does not match identical merchants", () => {
    // Two genuine charges of the same amount on nearby days must survive — the one-shot key
    // already handles true duplicates, and deleting here would destroy real spending.
    expect(isTruncatedMerchantOf("APPLE.COM/BILL", "APPLE.COM/BILL")).toBe(false);
    expect(isTruncatedMerchantOf("MERPAGO*PLANOUT", "MERPAGO*PLANOUT")).toBe(false);
  });

  it("requires the shorter string to be exactly at the truncation width", () => {
    // A merchant that is genuinely short and happens to prefix another one is NOT a truncation.
    expect(isTruncatedMerchantOf("APPLE.COM", "APPLE.COM/BILL")).toBe(false);
    expect(isTruncatedMerchantOf("RENDER.COM", "RENDER.COM SERVICES")).toBe(false);
    // 16 chars — past the web table's cut, so it was never truncated.
    expect(isTruncatedMerchantOf("ALMACENES BILBAO", "ALMACENES BILBAO SUR")).toBe(false);
  });

  it("requires a strict prefix, not merely a shared start", () => {
    expect(isTruncatedMerchantOf("ANTHROPIC* CLAU", "ANTHROPIC* XLAUDE SUB")).toBe(false);
    // The full string must actually be longer.
    expect(isTruncatedMerchantOf("ANTHROPIC* CLAU", "ANTHROPIC* CLA")).toBe(false);
  });

  it("tolerates blank merchants without matching", () => {
    expect(isTruncatedMerchantOf("", "ANYTHING AT ALL")).toBe(false);
    expect(isTruncatedMerchantOf("ANTHROPIC* CLAU", "")).toBe(false);
  });
});
