import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { brokerMovementsKind } from "nw-tracker-contracts";
import { advanceRacionalCrawlCursor, readRacionalCrawlCursor } from "./crawlCursor.js";
import { archiveRacionalRead, decodeStagedRacionalRead, listStagedRacionalReads } from "./stagedReads.js";

describe("staged Racional reads", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function tmp(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "racional-reads-"));
    dirs.push(d);
    return d;
  }
  const write = (dir: string, name: string, content: unknown) => fs.writeFileSync(path.join(dir, name), JSON.stringify(content));

  /** Rows exactly as the crawl stages them. */
  const buyRow = {
    title: "Compra VTSYN",
    amount: "US$797,01",
    day: "22/09",
    occurred_on: "2097-09-22",
    kind_class: "buy",
    movement_id: "uid_2097-09-22T16:17:43.885Z_797.01",
    detail: "Recibiste 1,40465606 acciones de Vitest Synth (VTSYN), a un valor de US$567,40 por acción.",
    detail_status: "opened",
  };
  const interestRow = { title: "Intereses", amount: "US$0,05", day: "21/09", occurred_on: "2097-09-21", kind_class: null };

  it("groups a crawl's files by stamp, oldest first, and decodes them into a valid payload", () => {
    const dir = tmp();
    write(dir, "movements-2097-09-23T01-02-38.json", [buyRow, interestRow]);
    write(dir, "dividends-2097-09-23T01-02-38.json", {
      dividends: [
        {
          id: "div_NI.x_VTSYN_2097-09-18T12:00:00.000Z",
          assetId: "VTSYN",
          DIV: 2.75,
          DIVTAX: -0.41,
          amount: 2.34,
          executionDate: "2097-09-18T12:00:00.000Z",
          isUSDDividend: true,
        },
      ],
    });
    write(dir, "dividends-2097-09-22T01-00-00.json", { dividends: [] }); // the list step failed that night
    write(dir, "api-calls-2097-09-23T01-02-38.json", []);

    const reads = listStagedRacionalReads(dir);
    expect(reads.map((r) => [r.stamp, r.read_at, r.movements_file != null, r.dividends_file != null])).toEqual([
      ["2097-09-22T01-00-00", "2097-09-22T01:00:00.000Z", false, true],
      ["2097-09-23T01-02-38", "2097-09-23T01:02:38.000Z", true, true],
    ]);
    const decoded = decodeStagedRacionalRead(reads[1]!);
    expect(decoded.first_row_key).toBe("2097-09-22|buy|US$797,01");
    expect(decoded.movements?.[0]).toMatchObject({ kind: "buy", ticker: "VTSYN", units: "1.40465606", amount: 797.01 });
    expect(decoded.dividends?.[0]).toMatchObject({ gross: 2.75, withholding: 0.41, net: 2.34 });
    // The decoded read is exactly what the contract accepts.
    const parsed = brokerMovementsKind.payload.safeParse({
      broker: "racional",
      apply: true,
      read_at: reads[1]!.read_at,
      movements: decoded.movements,
      dividends: decoded.dividends,
    });
    expect(parsed.error).toBeUndefined();

    expect(archiveRacionalRead(reads[1]!, dir).sort()).toEqual([
      "api-calls-2097-09-23T01-02-38.json",
      "dividends-2097-09-23T01-02-38.json",
      "movements-2097-09-23T01-02-38.json",
    ]);
    expect(listStagedRacionalReads(dir).map((r) => r.stamp)).toEqual(["2097-09-22T01-00-00"]);
  });

  it("refuses an unmapped row instead of sending it", () => {
    const dir = tmp();
    write(dir, "movements-2097-09-24T01-00-00.json", [{ title: "Algo Nuevo", amount: "US$1,00", day: "24/09", occurred_on: "2097-09-24" }]);
    expect(() => decodeStagedRacionalRead(listStagedRacionalReads(dir)[0]!)).toThrow(/Unmapped Racional movement kind "Algo Nuevo"/);
  });

  it("moves the crawl cursor forward only", () => {
    const file = path.join(tmp(), "cursor.json");
    expect(readRacionalCrawlCursor(file)).toBeNull();
    expect(advanceRacionalCrawlCursor({ last_row_key: "k2", read_file: "movements-2097-09-23T01-02-38.json" }, "t1", file)).toBe(true);
    expect(advanceRacionalCrawlCursor({ last_row_key: "k1", read_file: "movements-2097-09-22T01-00-00.json" }, "t2", file)).toBe(false);
    expect(advanceRacionalCrawlCursor({ last_row_key: "k2", read_file: "movements-2097-09-23T01-02-38.json" }, "t3", file)).toBe(false);
    expect(readRacionalCrawlCursor(file)).toEqual({ last_row_key: "k2", read_file: "movements-2097-09-23T01-02-38.json", updated_at: "t1" });
  });
});
