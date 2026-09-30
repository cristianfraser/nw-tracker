/**
 * Loads the INE's official monthly IPC variation from the SII's yearly tables into
 * `ipc_official_monthly`, each month checked against the UF (`siiOfficialIpc.ts`).
 *
 * Usage (from server/):
 *   npx tsx scripts/backfill-sii-official-ipc.ts [--from=2016] [--dry-run]
 *
 * 2016 is the default because every month must be checked against the UF, and `uf_daily`
 * starts mid-2015; nothing reajustado here predates 2017.
 */
import "../src/db.js";
import { chileWallClockNow } from "../src/chileDate.js";
import { fetchSiiOfficialIpcYear, writeOfficialIpcMonths } from "../src/siiOfficialIpc.js";

const DRY = process.argv.includes("--dry-run");
const fromArg = process.argv.find((a) => a.startsWith("--from="));
const fromYear = fromArg ? Number(fromArg.slice("--from=".length)) : 2016;
if (!Number.isInteger(fromYear) || fromYear < 2000) throw new Error(`--from must be a year, got ${fromArg}`);

async function main(): Promise<void> {
  const months = [];
  for (let y = fromYear; y <= chileWallClockNow().year; y++) months.push(...(await fetchSiiOfficialIpcYear(y)));
  const { added, ufUnchecked } = writeOfficialIpcMonths(months, DRY);
  console.log(
    `${DRY ? "[dry-run] " : ""}${months.length} month(s) ${months[0]?.month} → ${months[months.length - 1]?.month}, ` +
      `${added} new; checked against the UF except ${ufUnchecked.length ? ufUnchecked.join(", ") : "none"}.`
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
