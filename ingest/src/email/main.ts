/**
 * Fetch broker notification e-mails into `cfraser/broker-emails/`.
 *
 *   npm run fetch:emails                 # since the watermark (or last 7 days on first run)
 *   npm run fetch:emails -- --since=30   # widen the first-run window
 *   npm run fetch:emails -- --no-mark    # do not advance the watermark (safe re-read)
 *
 * Classification lives on the nw-tracker side (`npm run check:broker-emails`), so this only
 * puts metadata on disk.
 */
import { fetchBrokerEmails } from "./fetch.js";
import { log } from "../log.js";

const argv = process.argv.slice(2);
const sinceRaw = argv.find((a) => a.startsWith("--since="))?.split("=")[1];
const sinceDays = Number(sinceRaw);

fetchBrokerEmails({
  sinceDays: Number.isFinite(sinceDays) && sinceDays > 0 ? sinceDays : undefined,
  markSeen: !argv.includes("--no-mark"),
})
  .then((r) => {
    if (r.emails.length === 0) log("no new broker e-mail");
    process.exitCode = 0;
  })
  .catch((err: unknown) => {
    log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
