import { describe, expect, it } from "vitest";
import {
  AUTO_ADDITIONAL_CARD_NOTE_PREFIX,
  formatAutoAdditionalCardNote,
  isAdditionalCardExpenseLine,
  mergeAutoAdditionalCardNote,
} from "./ccAdditionalCardExpenseMatch.js";

describe("ccAdditionalCardExpenseMatch", () => {
  it("detects adicional lines when origin differs from statement card", () => {
    expect(isAdditionalCardExpenseLine("3670", "4242")).toBe(true);
    expect(isAdditionalCardExpenseLine("4242", "4242")).toBe(false);
    expect(isAdditionalCardExpenseLine(null, "4242")).toBe(false);
    expect(isAdditionalCardExpenseLine("3670", null)).toBe(false);
  });

  it("formats and merges auto additional-card notes", () => {
    const auto = formatAutoAdditionalCardNote({ originLast4: "3670", primaryLast4: "4242" });
    expect(auto).toBe(`${AUTO_ADDITIONAL_CARD_NOTE_PREFIX}|origin:3670|stmt:4242`);
    expect(mergeAutoAdditionalCardNote("", auto)).toBe(auto);
    expect(mergeAutoAdditionalCardNote("user note", auto)).toBe(`${auto}\n\nuser note`);
    expect(mergeAutoAdditionalCardNote(`${auto}\n\nkeep me`, auto)).toBe(`${auto}\n\nkeep me`);
  });
});
