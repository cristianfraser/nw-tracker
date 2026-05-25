import { describe, expect, it } from "vitest";
import { formatMonthLabelFromYm } from "./formatMonthLabel";

describe("formatMonthLabelFromYm", () => {
  it("does not shift month backward in Chile-local rendering", () => {
    expect(formatMonthLabelFromYm("2026-05")).toMatch(/may/i);
    expect(formatMonthLabelFromYm("2026-05")).not.toMatch(/abr/i);
    expect(formatMonthLabelFromYm("2026-04")).toMatch(/abr/i);
  });
});
