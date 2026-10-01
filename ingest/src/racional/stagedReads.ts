import fs from "node:fs";
import path from "node:path";
import type { BrokerDividend, BrokerMovement } from "nw-tracker-contracts";
import { resolveMovementsDir } from "../paths.js";
import { racionalApiDividendsFromResponse, racionalListRowKey, racionalRowToMovement, type RacionalScrapedRow } from "./movements.js";

/**
 * The reads a Racional crawl staged in `cfraser/racional-movements/`, one per crawl stamp:
 * `movements-<stamp>.json` (the list rows) and `dividends-<stamp>.json` (the dividends API
 * response, verbatim), either of which can be missing. A read stays staged until the server
 * applies it with nothing to fix, then moves to `imported/` with the crawl's other files.
 */
export type StagedRacionalRead = {
  stamp: string;
  /** The crawl's own UTC instant, from its stamp. */
  read_at: string;
  movements_file: string | null;
  dividends_file: string | null;
};

const RE_READ_FILE = /^(movements|dividends)-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.json$/;

export function listStagedRacionalReads(dir = resolveMovementsDir("racional")): StagedRacionalRead[] {
  if (!fs.existsSync(dir)) return [];
  const byStamp = new Map<string, StagedRacionalRead>();
  for (const name of fs.readdirSync(dir).sort()) {
    const m = RE_READ_FILE.exec(name);
    if (!m) continue;
    const stamp = `${m[2]}T${m[3]}-${m[4]}-${m[5]}`;
    const read = byStamp.get(stamp) ?? {
      stamp,
      read_at: `${m[2]}T${m[3]}:${m[4]}:${m[5]}.000Z`,
      movements_file: null,
      dividends_file: null,
    };
    if (m[1] === "movements") read.movements_file = path.join(dir, name);
    else read.dividends_file = path.join(dir, name);
    byStamp.set(stamp, read);
  }
  return [...byStamp.values()].sort((a, b) => a.stamp.localeCompare(b.stamp));
}

export type DecodedRacionalRead = {
  movements: BrokerMovement[] | null;
  dividends: BrokerDividend[] | null;
  /** The list key of the read's first row (the cursor it sets once applied); null for an empty list. */
  first_row_key: string | null;
};

/** Decodes a staged read; throws on a row or record it cannot read (an unmapped kind, a changed shape). */
export function decodeStagedRacionalRead(read: StagedRacionalRead): DecodedRacionalRead {
  let movements: BrokerMovement[] | null = null;
  let firstRowKey: string | null = null;
  if (read.movements_file) {
    const rows = JSON.parse(fs.readFileSync(read.movements_file, "utf8")) as RacionalScrapedRow[];
    if (!Array.isArray(rows)) throw new Error(`${path.basename(read.movements_file)} is not a list of movement rows`);
    movements = rows.map(racionalRowToMovement);
    firstRowKey = rows[0] ? racionalListRowKey(rows[0]) : null;
  }
  const dividends = read.dividends_file
    ? racionalApiDividendsFromResponse(JSON.parse(fs.readFileSync(read.dividends_file, "utf8")) as unknown)
    : null;
  return { movements, dividends, first_row_key: firstRowKey };
}

/** Moves every file of the crawl (`*-<stamp>.json`: list, dividends, API calls, summary) to `imported/`. */
export function archiveRacionalRead(read: StagedRacionalRead, dir = resolveMovementsDir("racional")): string[] {
  const out = path.join(dir, "imported");
  fs.mkdirSync(out, { recursive: true });
  const moved: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(`-${read.stamp}.json`)) continue;
    fs.renameSync(path.join(dir, name), path.join(out, name));
    moved.push(name);
  }
  return moved;
}
