import { describe, expect, it } from "vitest";
import {
  BASE_DOCUMENT_TITLE,
  documentTitleFromH1Text,
  pageHeadingSelectors,
} from "./useDocumentTitleFromH1";

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

describe("pageHeadingSelectors", () => {
  it("reads the h1 on ordinary pages", () => {
    expect(pageHeadingSelectors("/")).toEqual(["h1"]);
    expect(pageHeadingSelectors("/account/92")).toEqual(["h1"]);
  });

  it("prefers the section title on flows subpages, which share one h1", () => {
    expect(pageHeadingSelectors("/flows/income")).toEqual(["h2.flow-section-title", "h1"]);
    expect(pageHeadingSelectors("/flows/expenses/real_estate/suecia")).toEqual([
      "h2.flow-section-title",
      "h1",
    ]);
  });

  it("keeps the layout h1 on the flows index, trailing slash included", () => {
    expect(pageHeadingSelectors("/flows")).toEqual(["h1"]);
    expect(pageHeadingSelectors("/flows/")).toEqual(["h1"]);
  });

  it("reads the active subnav tab on panel subpages, whose h2s are section titles", () => {
    expect(pageHeadingSelectors("/panel/accounts")).toEqual(["nav.flow-subnav a.active", "h1"]);
    expect(pageHeadingSelectors("/panel/import-sync")).toEqual(["nav.flow-subnav a.active", "h1"]);
    expect(pageHeadingSelectors("/panel")).toEqual(["h1"]);
  });
});
