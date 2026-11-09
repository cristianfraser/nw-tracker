import { describe, expect, it } from "vitest";
import { absolutePathToFileUrl } from "./localFileUrl";

describe("absolutePathToFileUrl", () => {
  it("encodes spaces and builds file:/// on Unix paths", () => {
    expect(
      absolutePathToFileUrl(
        "/Users/someone/data/statements/bank account/2026-04-30 Statement.xlsx"
      )
    ).toBe(
      "file:///Users/someone/data/statements/bank%20account/2026-04-30%20Statement.xlsx"
    );
  });
});
