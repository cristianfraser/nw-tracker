/**
 * One-shot live market quotes sync (same as the in-process scheduler tick),
 * including the watchlist equity-history depth ensure.
 *
 * Usage: npm run live-quotes:sync -w nw-tracker-server
 */
import "../src/db.js";
import { syncAllLiveMarketQuotes } from "../src/liveMarketQuotesSync.js";
import { ensureWatchlistEquityHistoryDepth } from "../src/watchlist.js";

const result = await syncAllLiveMarketQuotes();
const backfilled = await ensureWatchlistEquityHistoryDepth();
if (backfilled > 0) {
  console.log(`live-quotes:sync — watchlist history backfilled for ${backfilled} ticker(s)`);
}
const failed = result.equities.filter((r) => !r.ok);
process.exit(failed.length > 0 ? 1 : 0);
