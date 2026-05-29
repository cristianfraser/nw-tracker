/**
 * Reconcile Σ AFP cuotas movements to the official AFP UNO website total (default 296.46).
 * Removes prior synthetic-trim / website-reconcile rows and inserts one adjustment.
 *
 *   npm run afp:uno:reconcile-cuotas -w nw-tracker-server -- --account-id=NN --dry-run
 *   npm run afp:uno:reconcile-cuotas -w nw-tracker-server -- --account-id=NN --apply
 *   npm run afp:uno:reconcile-cuotas -w nw-tracker-server -- --account-id=NN --undo-only --apply
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AFP_UNO_WEBSITE_CUOTAS_TARGET,
  computeAfpCuotasWebsiteReconciliationDelta,
  readOptionalAfpUnoWebsiteCuotasTarget,
} from "../src/afpModeloPriorCuotasBackfill.js";
import { afpCuotasCumulativeThroughDate } from "../src/afpUnoValuation.js";
import { chileCalendarTodayYmd } from "../src/chileDate.js";
import { db } from "../src/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfraserDir = path.resolve(__dirname, "..", "..", "cfraser");

function parseArgs(argv: string[]) {
  let accountId: number | null = null;
  let dryRun = true;
  let target: number | null = null;
  let undoOnly = false;
  for (const a of argv) {
    if (a.startsWith("--account-id=")) accountId = Number(a.slice("--account-id=".length));
    else if (a === "--apply") dryRun = false;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--undo-only") undoOnly = true;
    else if (a.startsWith("--target=")) target = Number(a.slice("--target=".length));
  }
  return { accountId, dryRun, target, undoOnly };
}

function main() {
  const { accountId, dryRun, target: targetArg, undoOnly } = parseArgs(process.argv.slice(2));
  if (accountId == null || !Number.isFinite(accountId) || accountId <= 0) {
    console.error("Usage: --account-id=NN [--apply] [--target=296.46]");
    process.exit(1);
  }
  const slug = db
    .prepare(
      `SELECT g.slug AS bucket_slug FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE a.id = ?`
    )
    .get(accountId) as { bucket_slug: string } | undefined;
  const kind = slug?.bucket_slug?.includes("__")
    ? slug.bucket_slug.slice(slug.bucket_slug.lastIndexOf("__") + 2)
    : slug?.bucket_slug;
  if (kind !== "afp") {
    console.error(`Account ${accountId} is not category afp`);
    process.exit(1);
  }

  const asOf = chileCalendarTodayYmd();
  const target =
    targetArg != null && Number.isFinite(targetArg) && targetArg > 0
      ? targetArg
      : (readOptionalAfpUnoWebsiteCuotasTarget(cfraserDir) ?? AFP_UNO_WEBSITE_CUOTAS_TARGET);

  const del = db.prepare(
    `DELETE FROM movements WHERE account_id = ? AND (
      note LIKE 'import:excel|afp-cuotas-synthetic-trim%'
      OR note LIKE 'import:excel|afp-cuotas-website-reconcile%'
    )`
  );
  const sumBeforeDeletes = afpCuotasCumulativeThroughDate(accountId, asOf);
  if (!dryRun) del.run(accountId);
  const sumAfterDeletes = dryRun
    ? sumBeforeDeletes -
      (
        db
          .prepare(
            `SELECT COALESCE(SUM(units_delta), 0) AS u FROM movements WHERE account_id = ? AND (
              note LIKE 'import:excel|afp-cuotas-synthetic-trim%'
              OR note LIKE 'import:excel|afp-cuotas-website-reconcile%'
            )`
          )
          .get(accountId) as { u: number }
      ).u
    : afpCuotasCumulativeThroughDate(accountId, asOf);

  console.log(`As-of ${asOf}: Σ cuotas=${sumAfterDeletes.toFixed(2)}${undoOnly ? " (undo-only)" : ` target=${target}`}`);

  if (undoOnly) {
    console.log(dryRun ? "[dry-run] Would leave synthetic rows removed; no new reconcile row." : "Removed synthetic reconcile rows.");
    return;
  }

  const delta = computeAfpCuotasWebsiteReconciliationDelta(sumAfterDeletes, target);
  console.log(`delta=${delta ?? 0}`);

  if (delta == null) {
    console.log("No reconciliation needed.");
    return;
  }

  const reconDay = "2017-06-30";
  const note = `import:excel|afp-cuotas-website-reconcile|delta=${delta}|target=${target}|sum_before=${sumAfterDeletes}|amount_clp_placeholder=1|script=afp-uno-reconcile-cuotas`;
  if (dryRun) {
    console.log(`Would insert units_delta=${delta} on ${reconDay} → Σ=${(sumAfterDeletes + delta).toFixed(2)}`);
    return;
  }
  db.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta) VALUES (?,?,?,?,?)`
  ).run(accountId, 1, reconDay, note, delta);
  const final = afpCuotasCumulativeThroughDate(accountId, asOf);
  console.log(`Inserted reconcile movement. Σ cuotas now ${final.toFixed(2)}`);
}

main();
