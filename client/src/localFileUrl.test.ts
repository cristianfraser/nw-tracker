import { describe, expect, it } from "vitest";
import { absolutePathToFileUrl } from "./localFileUrl";

describe("absolutePathToFileUrl", () => {
  it("encodes spaces and builds file:/// on Unix paths", () => {
    expect(
      absolutePathToFileUrl(
        "/Users/crfrsr/Projects/nw-tracker/cfraser/excels/cuenta corriente/2026-04-30 Cartola.xlsx"
      )
    ).toBe(
      "file:///Users/crfrsr/Projects/nw-tracker/cfraser/excels/cuenta%20corriente/2026-04-30%20Cartola.xlsx"
    );
  });
});
