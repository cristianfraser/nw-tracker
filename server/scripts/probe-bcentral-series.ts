/**
 * Sample GetSeries for default BCentral FX/UF/UTM/IPC codes.
 * Usage: npm run probe:bcentral-series -w nw-tracker-server
 */
import "../src/db.js";
import { loadRootDotenv } from "../src/rootDotenv.js";
import { fetchBcentralSeries, loadBcentralCredentials } from "../src/bcentralApi.js";
import { BCENTRAL_SERIES } from "../src/bcentralSeries.js";

async function main(): Promise<void> {
  loadRootDotenv();
  const creds = loadBcentralCredentials();
  if (!creds) {
    console.error("Set BCENTRAL_EMAIL and BCENTRAL_PASSWORD in .env");
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 8 * 864e5).toISOString().slice(0, 10);
  let failed = 0;
  for (const [label, id] of Object.entries(BCENTRAL_SERIES)) {
    try {
      const rows = await fetchBcentralSeries(creds, id, weekAgo, today);
      console.log(`${label} (${id}): ${rows.length} obs, last=`, rows.slice(-2));
    } catch (e) {
      failed++;
      console.error(`${label} (${id}): FAIL`, (e as Error).message);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

main();
