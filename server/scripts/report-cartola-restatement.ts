/**
 * Report only: what importing cartola months again in place would change in what the pages show,
 * on a snapshot copy. Each month of the payload is imported again as a forced re-import
 * (`importCartolaList` with `forceReimport`, the ingest kind's rule; with `--fuller`, by the
 * fuller-replaces rule instead) inside a transaction that is rolled back, and the month's rows are
 * read before and after through the expense, income and name pipelines
 * (`checkingRestatementIdentity.ts`). Per row whose printed text changes: the old and new text, each
 * expense line's category before and after with its source (`own`: the line's own category, which a
 * restatement never touches; `rule`: a rule or the deposit pairing; `none`), a credit's
 * classification, and the shown name before and after; what the import's carry did to keep them
 * (`checkingRestatementCarry.ts`: a rule for the new spelling, the row's own category, a catalog
 * spelling); and one summary line. A re-import repair is gated on that summary: categories changed
 * 0, rows losing a shown name 0. Never writes.
 *
 *   npx tsx scripts/report-cartola-restatement.ts --db=<snapshot copy> --account=checking|cuenta-vista \
 *     --payload=<bank_account.statements payload JSON> [--months=2026-09,2026-10] [--rebuild] [--migrate] [--quiet]
 *
 * `--rebuild`: the months go through the ledger rebuild (`rebuildCheckingLedgerFromCartolas`, the
 * repair of a ledger whose anchor moved; `scripts/rebuild-checking-ledger-from-cartolas.ts`) in one
 * run, and are compared together.
 *
 * `--payload` is what `import:checking-cartolas -- --dry-run` sends (the readers' output). `--db` is
 * required and must be a COPY (the checkout's `data/nw-tracker.db` is refused). A database with
 * pending migrations is refused unless `--migrate` is passed. `--quiet` prints only the changed rows
 * whose category, credit or name moved, and the summaries.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => process.argv.includes(`--${name}`);

const dbArg = arg("db");
const account = arg("account");
const payloadFile = arg("payload");
if (!dbArg || (account !== "checking" && account !== "cuenta-vista") || !payloadFile) {
  console.error("Usage: --db=<snapshot copy> --account=checking|cuenta-vista --payload=<json> [--months=YYYY-MM,…] [--migrate] [--quiet]");
  process.exit(2);
}
const file = path.resolve(dbArg);
if (!fs.existsSync(file)) throw new Error(`no database at ${file}`);
const live = path.join(serverDir, "data", "nw-tracker.db");
if (fs.existsSync(live) && fs.realpathSync(file) === fs.realpathSync(live)) throw new Error(`${file} is the live database: run on a snapshot copy`);
{
  const dbi = new Database(file, { readonly: true, fileMustExist: true });
  const files = fs.readdirSync(path.join(serverDir, "migrations")).filter((f) => f.endsWith(".sql"));
  const done = new Set((dbi.prepare(`SELECT id FROM schema_migrations`).all() as { id: string }[]).map((r) => r.id));
  const pending = files.filter((f) => !done.has(f)).sort();
  dbi.close();
  if (pending.length > 0 && !flag("migrate")) throw new Error(`${file} has ${pending.length} pending migration(s) (${pending.join(", ")}); pass --migrate to apply them here`);
}
process.env.NW_TRACKER_TEST_DB = file;
process.env.BACKGROUND_JOBS_ENABLED ??= "0";
const months = arg("months")?.split(",").map((m) => m.trim()).filter(Boolean) ?? null;
const quiet = flag("quiet");

await import("../src/expenseAssignmentWrites.js");
const { bankAccountStatementsKind } = await import("nw-tracker-contracts");
const { parsedCartolaFromStatement } = await import("../src/bankAccountStatementsApply.js");
const { checkingAccountId, CheckingLedgerRebuildRefused, importCartolaList, rebuildCheckingLedgerFromCartolas } = await import("../src/checkingCartolaImport.js");
const { splitCuentaVistaCartolaByCalendarMonth } = await import("../src/cuentaVistaCartolaSplit.js");
const { rolledBack } = await import("../src/ingestReceiver.js");
const { cuentaVistaAccountId } = await import("../src/movementBalanceCashAccounts.js");
const { movementWrite } = await import("../src/movementWrites.js");
const identity = await import("../src/checkingRestatementIdentity.js");
await import("../src/checkingRestatementCarry.js");
const { describeRestatementCarry } = await import("../src/checkingRestatementHook.js");

const accountId = account === "checking" ? checkingAccountId() : cuentaVistaAccountId();
const payload = bankAccountStatementsKind.payload.parse(JSON.parse(fs.readFileSync(payloadFile, "utf8")));
if ((payload.account.product === "checking") !== (account === "checking")) throw new Error(`the payload is for ${payload.account.product}, not ${account}`);
const cartolas = payload.statements
  .map(parsedCartolaFromStatement)
  .flatMap((c) => (account === "cuenta-vista" ? splitCuentaVistaCartolaByCalendarMonth(c) : [c]))
  .filter((c) => months == null || months.includes(c.period_month));
if (cartolas.length === 0) throw new Error("no cartola of the payload is in --months");

console.log(`database: ${file}`);
console.log(`account: ${accountId} (${account})`);
const totals = { changed: 0, categories: 0, credits: 0, lost: 0, names: 0, removed: 0, removedCategorized: 0, added: 0, refused: 0 };
type Diff = import("../src/checkingRestatementIdentity.js").RestatementDiff;
type Log = Parameters<typeof importCartolaList>[3][number];

function printDiff(d: Diff): void {
  for (const c of d.changed) {
    const moved =
      c.lines.some((l) => identity.filingText(l.before) !== identity.filingText(l.after)) || c.credit.before !== c.credit.after || c.name.before !== c.name.after;
    if (quiet && !moved) continue;
    for (const line of identity.describeRestatedRow(c)) console.log(line);
  }
  for (const c of d.categories_changed.filter((x) => !d.changed.some((r) => r.lines.some((l) => l.key === x.key)))) {
    console.log(`  another line's category moved: ${c.key}: ${identity.filingText(c.before)} → ${identity.filingText(c.after)}`);
  }
  console.log(`  ${identity.restatementSummaryLine(d)}`);
  totals.changed += d.changed.length;
  totals.categories += d.categories_changed.length;
  totals.credits += d.credits_changed.length;
  totals.lost += d.names_lost.length;
  totals.names += d.names_changed.length;
  totals.removed += d.removed.length;
  totals.removedCategorized += d.removed_with_category.length;
  totals.added += d.added.length;
}

function printLog(log: Log | undefined, label: string): void {
  console.log(`\n${label}: ${log?.status ?? "no log"}${log?.error ? ` — ${log.error}` : ""}`);
  for (const p of log?.problems ?? []) console.log(`  problem: ${p}`);
  if (log?.status === "refused" || log?.status === "parse_error") totals.refused++;
  if (log?.restatement_carry) for (const line of describeRestatementCarry(log.restatement_carry)) console.log(line);
}

if (flag("rebuild")) {
  const periodMonths = cartolas.map((c) => c.period_month);
  try {
    const result = rolledBack(() =>
      movementWrite(() => {
        const before = identity.snapshotExpenseIdentity(accountId, periodMonths);
        const r = rebuildCheckingLedgerFromCartolas(accountId, cartolas);
        const after = identity.snapshotExpenseIdentity(accountId, periodMonths);
        return { r, diff: identity.diffExpenseIdentity(before, after) };
      })
    );
    console.log(`\nrebuild of ${cartolas.length} month(s): anchor ${JSON.stringify(result.r.anchor_before)} → ${JSON.stringify(result.r.anchor_after)}`);
    for (const m of result.r.months) {
      console.log(`  ${m.period_month}: ${m.restated} restated or kept, ${m.inserted} written, ${m.cartola_rows_removed} no longer listed removed`);
      if (m.restatement_carry) for (const line of describeRestatementCarry(m.restatement_carry)) console.log(line);
    }
    printDiff(result.diff);
  } catch (e) {
    if (!(e instanceof CheckingLedgerRebuildRefused)) throw e;
    console.log(`REBUILD REFUSED: ${e.message}`);
    totals.refused++;
  }
} else {
  for (const cartola of cartolas) {
    const result = rolledBack(() =>
      movementWrite(() => {
        const before = identity.snapshotExpenseIdentity(accountId, [cartola.period_month]);
        const logs: Log[] = [];
        importCartolaList(accountId, [{ cartola, label: cartola.source_file }], { forceReimport: !flag("fuller") }, logs);
        const after = identity.snapshotExpenseIdentity(accountId, [cartola.period_month]);
        return { logs, diff: identity.diffExpenseIdentity(before, after) };
      })
    );
    printLog(result.logs[0], `${cartola.period_month} ${cartola.source_file}`);
    printDiff(result.diff);
  }
}
console.log(
  `\nSUMMARY ${cartolas.length} month(s): rows changed: ${totals.changed}; categories changed: ${totals.categories}; credits reclassified: ${totals.credits}; ` +
    `rows losing a shown name: ${totals.lost}; shown names changed: ${totals.names}; rows removed: ${totals.removed} (with a category: ${totals.removedCategorized}), added: ${totals.added}; months refused: ${totals.refused}`
);
// The repair's gate: nothing the user sees moves (categories, names, credits' classes), no categorized row goes, nothing refused.
process.exit(totals.categories === 0 && totals.lost === 0 && totals.credits === 0 && totals.removedCategorized === 0 && totals.refused === 0 ? 0 : 1);
