import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDdMmYyToIso } from "./ddMmYy.js";

/** The server's copy reads the same table (`server/src/ddMmYyToIsoCases.test.ts`): the two cannot drift. */
const cases = JSON.parse(
  fs.readFileSync(new URL("../../../server/src/test/ddMmYyToIsoCases.json", import.meta.url), "utf8")
) as { raw: string; expect: string | null }[];

describe("parseDdMmYyToIso (the server's case table)", () => {
  it.each(cases)("«$raw» → $expect", (c) => {
    expect(parseDdMmYyToIso(c.raw)).toBe(c.expect);
  });
});
