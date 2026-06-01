import { describe, expect, it } from "vitest";
import {
  normalizeCcImportCardLast4,
  resolveMasterAccountIdForImportCardLast4,
} from "./ccConsolidatedCards.js";
import { resolveMasterAccountIdForCardLast4 } from "./creditCardTree.js";

describe("ccConsolidatedCards", () => {
  it("redirects predecessor and consolidated cards to successor masters", () => {
    expect(normalizeCcImportCardLast4("4113")).toBe("4141");
    expect(normalizeCcImportCardLast4("4114")).toBe("4141");
    expect(normalizeCcImportCardLast4("4111")).toBe("4242");
    expect(normalizeCcImportCardLast4("4112")).toBe("4242");
    expect(normalizeCcImportCardLast4("4141")).toBe("4141");
    expect(normalizeCcImportCardLast4("4242")).toBe("4242");
  });

  it("resolves import account id to 4242 master for redirected last4", () => {
    const perCard = dbHasPerCardMasters();
    if (!perCard) return;
    const id4242 = resolveMasterAccountIdForCardLast4("4242");
    expect(resolveMasterAccountIdForImportCardLast4("4111")).toBe(id4242);
    expect(resolveMasterAccountIdForImportCardLast4("4112")).toBe(id4242);
  });
});

function dbHasPerCardMasters(): boolean {
  return resolveMasterAccountIdForCardLast4("4242") != null;
}
