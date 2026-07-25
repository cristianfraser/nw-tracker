import { describe, expect, it } from "vitest";
import { BASE_DOCUMENT_TITLE, documentTitleFromH1Text } from "./useDocumentTitleFromH1";

describe("documentTitleFromH1Text", () => {
  it("suffixes the heading text with the app name", () => {
    expect(documentTitleFromH1Text("Watchlist")).toBe("Watchlist · NW Tracker");
  });

  it("collapses the whitespace a wrapped heading carries", () => {
    expect(documentTitleFromH1Text("\n  Cuenta corriente\n  Santander\n")).toBe(
      "Cuenta corriente Santander · NW Tracker"
    );
  });

  it("falls back to the app name when the page has no heading", () => {
    expect(documentTitleFromH1Text(null)).toBe(BASE_DOCUMENT_TITLE);
    expect(documentTitleFromH1Text("   ")).toBe(BASE_DOCUMENT_TITLE);
  });
});
