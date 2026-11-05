import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clientBuildIdFromAssetUrls } from "./clientBuild";

type ClientBuildIdCase = { note: string; urls: string[]; id: string | null };
const cases = JSON.parse(
  fs.readFileSync(
    fileURLToPath(new URL("../../server/src/test/clientBuildIdCases.json", import.meta.url)),
    "utf-8"
  )
) as ClientBuildIdCase[];

describe("clientBuildIdFromAssetUrls (shared case table with the server)", () => {
  it.each(cases)("$note", (c) => {
    expect(clientBuildIdFromAssetUrls(c.urls)).toBe(c.id);
  });
});
