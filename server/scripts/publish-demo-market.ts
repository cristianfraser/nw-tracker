/**
 * Build the hosted demo's market artifact from the real sources and (with `--upload`) publish it
 * as the GitHub Release asset the Render build reads (docs/demo-market-publish-plan.md). The home
 * server's nightly job (`src/demoMarketPublishJob.ts`) runs this in a child process; by hand:
 *
 *   npm run demo:publish-market -w nw-tracker-server                 # build into server/data/demo-market/
 *   npm run demo:publish-market -w nw-tracker-server -- --upload     # and upload (DEMO_MARKET_PUBLISH_TOKEN)
 *
 * The npm script points NW_TRACKER_TEST_DB at a scratch file it deletes first. Needs the network,
 * BCENTRAL_EMAIL / BCENTRAL_PASSWORD, and a machine that reaches the Bolsa de Santiago
 * (`--santiago=snapshot` reads the committed snapshot instead). Prints one line
 * `demo-market-publish: result {json}` the job reads.
 *
 * SAFETY: refuses a DB that holds accounts or market rows, and the real nw-tracker.db by name.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { db } from "../src/db.js";
import {
  assertOnlyMarketTablesChanged,
  countAllTables,
  DEMO_MARKET_PUBLISH_RESULT_PREFIX,
  decodeDemoMarketArtifact,
  demoMarketArtifactMeta,
  encodeDemoMarketArtifact,
  exportDemoMarketArtifact,
} from "../src/demoData/demoMarketArtifact.js";
import { loadDemoRealMarket, type DemoSantiagoSource } from "../src/demoData/demoRealMarket.js";
import { demoMarketSpec } from "../src/demoData/market.js";
import { DEMO_MARKET_ASSET_NAME, DEMO_MARKET_META_ASSET_NAME, publishDemoMarketRelease } from "../src/demoMarketRelease.js";
import { loadRootDotenv } from "../src/rootDotenv.js";
import { fileURLToPath } from "node:url";



async function main(): Promise<void> {
  loadRootDotenv();
  const target = process.env.NW_TRACKER_TEST_DB?.trim();
  if (!target) throw new Error("set NW_TRACKER_TEST_DB to a scratch DB file");
  if (path.basename(target) === "nw-tracker.db") throw new Error("refusing to build the demo market in nw-tracker.db");
  const args = process.argv.slice(2);
  const value = (name: string): string | null => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
  const upload = args.includes("--upload");
  const outDir = path.resolve(value("out-dir") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "demo-market"));
  const santiago = value("santiago") ?? "bolsa";
  if (santiago !== "bolsa" && santiago !== "snapshot") throw new Error(`--santiago=${santiago}: expected bolsa or snapshot`);
  const token = process.env.DEMO_MARKET_PUBLISH_TOKEN?.trim() ?? "";
  if (upload && !token) throw new Error("--upload needs DEMO_MARKET_PUBLISH_TOKEN");

  const accounts = (db.prepare(`SELECT COUNT(*) AS c FROM accounts`).get() as { c: number }).c;
  if (accounts > 0) throw new Error(`${target} holds ${accounts} accounts — point NW_TRACKER_TEST_DB at a scratch file`);

  const now = new Date();
  const spec = demoMarketSpec();
  const before = countAllTables(db);
  const summary = await loadDemoRealMarket(spec, now, { santiago: santiago as DemoSantiagoSource });
  assertOnlyMarketTablesChanged(before, countAllTables(db));

  const artifact = exportDemoMarketArtifact(db, {
    generated_at: now.toISOString(),
    complete_through: summary.through,
    spec: { fromMonth: spec.fromMonth, tickers: [...spec.tickers], withAfp: spec.withAfp },
  });
  const bytes = encodeDemoMarketArtifact(artifact);
  // What the build will read, read back before it leaves.
  decodeDemoMarketArtifact(bytes);
  const meta = demoMarketArtifactMeta(artifact);
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, DEMO_MARKET_ASSET_NAME);
  writeFileSync(file, bytes);
  writeFileSync(path.join(outDir, DEMO_MARKET_META_ASSET_NAME), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(
    `demo market: ${summary.from} → ${summary.through}, ${(bytes.length / 1024 / 1024).toFixed(2)} MiB — ` +
      Object.entries(meta.rows).map(([t, n]) => `${t} ${n}`).join(", ")
  );
  console.log(`wrote ${file}`);

  const published = upload ? await publishDemoMarketRelease({ token, artifact: bytes, meta }) : null;
  if (published) console.log(`uploaded to ${published.url}`);
  console.log(
    DEMO_MARKET_PUBLISH_RESULT_PREFIX +
      JSON.stringify({
        complete_through: artifact.complete_through,
        generated_at: artifact.generated_at,
        bytes: bytes.length,
        file,
        uploaded: published != null,
        url: published?.url ?? null,
      })
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
