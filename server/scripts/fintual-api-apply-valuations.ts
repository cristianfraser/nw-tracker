/**
 * Upserts `valuations` from `server/data/.fintual-goals-latest.json`.
 *
 * `--refresh`: re-fetch goals (same auth as `fintual:fetch-goals`: token + optional `FINTUAL_COOKIE`) then apply.
 *
 * Usage (repo root):
 *   npm run fintual:apply-valuations -w nw-tracker-server
 *   npm run fintual:apply-valuations -w nw-tracker-server -- --dry-run
 *   npm run fintual:apply-valuations -w nw-tracker-server -- --refresh
 */
import {
  buildGoalsSnapshot,
  fetchFintualGoalsRaw,
  getValidFintualSession,
  loadGoalIdOverrides,
  parseGoalsFromResponse,
  readGoalsSnapshot,
  writeGoalsSnapshot,
} from "./fintualApiLib.js";
import { applyFintualGoalsSnapshotToDb } from "./fintualApplyShared.js";

const REFRESH = process.argv.includes("--refresh");
const DRY = process.argv.includes("--dry-run");

async function loadSnapshot() {
  if (!REFRESH) return readGoalsSnapshot();
  const { email, token } = await getValidFintualSession();
  const raw = await fetchFintualGoalsRaw(email, token);
  const rows = parseGoalsFromResponse(raw);
  const snap = buildGoalsSnapshot(rows, loadGoalIdOverrides());
  writeGoalsSnapshot(snap);
  return snap;
}

async function main(): Promise<void> {
  const snap = await loadSnapshot();
  const { applied, skipped } = applyFintualGoalsSnapshotToDb(snap, DRY);

  console.log(
    `${DRY ? "[dry-run] " : ""}Valuations for ${snap.asOfDate}: applied ${applied}, skipped ${skipped} (unmapped or missing account).`
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
