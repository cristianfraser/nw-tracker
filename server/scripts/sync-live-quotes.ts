/**
 * One-shot live market quotes sync (same as the in-process scheduler tick).
 *
 * Usage: npm run live-quotes:sync -w nw-tracker-server
 */
import "../src/db.js";
import { syncAllLiveMarketQuotes } from "../src/liveMarketQuotesSync.js";

const result = await syncAllLiveMarketQuotes();
const failed = result.equities.filter((r) => !r.ok);
process.exit(failed.length > 0 ? 1 : 0);
