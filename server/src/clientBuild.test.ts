import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clientBuildIdFromAssetUrls, clientBuildIdFromIndexHtml } from "./clientBuild.js";

type ClientBuildIdCase = { note: string; urls: string[]; id: string | null };
const cases = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("./test/clientBuildIdCases.json", import.meta.url)), "utf-8")
) as ClientBuildIdCase[];

describe("clientBuildIdFromAssetUrls (shared case table with the client)", () => {
  it.each(cases)("$note", (c) => {
    expect(clientBuildIdFromAssetUrls(c.urls)).toBe(c.id);
  });
});

describe("clientBuildIdFromIndexHtml", () => {
  it("reads the entry script and stylesheet a Vite build writes", () => {
    const html = `<!doctype html><html><head>
      <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans" rel="stylesheet" />
      <script>(function () {})();</script>
      <script type="module" crossorigin src="/assets/index-CR_o_f3B.js"></script>
      <link rel="stylesheet" crossorigin href="/assets/index-BpjlLTSx.css">
    </head><body><div id="root"></div></body></html>`;
    expect(clientBuildIdFromIndexHtml(html)).toBe("/assets/index-BpjlLTSx.css /assets/index-CR_o_f3B.js");
  });

  it("finds no build in the dev index.html", () => {
    expect(clientBuildIdFromIndexHtml(`<script type="module" src="/src/main.tsx"></script>`)).toBeNull();
  });
});
