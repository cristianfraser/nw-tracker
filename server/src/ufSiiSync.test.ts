import { describe, expect, it } from "vitest";
import { parseSiiUfYearHtml } from "./ufSiiSync.js";

describe("parseSiiUfYearHtml", () => {
  it("parses day cells from SII month tables", () => {
    const html = `
<div class='meses' id='mes_junio'>
<table><tr><th><strong>9</strong></th><td>39.123,45</td></tr>
<tr><th><strong>10</strong></th><td>39.234,56</td></tr></table>
</div>`;
    const map = parseSiiUfYearHtml(html, 2026);
    expect(map.get("2026-06-09")).toBeCloseTo(39123.45, 2);
    expect(map.get("2026-06-10")).toBeCloseTo(39234.56, 2);
  });
});
