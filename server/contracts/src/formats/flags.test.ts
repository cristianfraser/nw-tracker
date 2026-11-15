import { describe, expect, it } from "vitest";
import { readCaseFile } from "./caseFile.js";
import { parseEnvFlag } from "./flags.js";

describe("parseEnvFlag (shared case table)", () => {
  const cases = readCaseFile<{ raw: string | null; expect: boolean | null | "throws" }[]>("envFlagCases.json");
  it.each(cases)("«$raw» → $expect", (c) => {
    const read = () => parseEnvFlag("SOME_FLAG", c.raw ?? undefined);
    if (c.expect === "throws") expect(read).toThrow(`SOME_FLAG=${JSON.stringify(c.raw)}: expected 1/true/yes or 0/false/no`);
    else expect(read()).toBe(c.expect);
  });
});
