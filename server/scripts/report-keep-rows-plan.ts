/**
 * Report only: what the keep-rows planners say an import does, against the import the plan replaced
 * (`mergeCardStatements` / `importCheckingCartolaInsertThenPrune`, kept until keep-rows phase 4 as
 * the reference). Plans the documents, runs the old import inside a transaction that is rolled
 * back, and prints the plan (counts per outcome, then each row) and every disagreement between the
 * planner's account of the old end state and the real one. Exits 1 on any disagreement. Never writes.
 *
 * `--apply-new`: instead, runs the production import (`importStatementDocuments` /
 * `importCheckingCartola`, the month imported again in place when it is on file) inside a rolled-back
 * transaction and prints what it would write: rows restated / inserted / folded / removed, arrival
 * stamps created, whether the card-line session finish ran, the rows changed in all. The tool for
 * validating a statement or cartola on a snapshot copy before deploying.
 *
 *   npx tsx scripts/report-keep-rows-plan.ts --db=<snapshot copy> --account=<id> --statements=<file.json> [--apply-new] [--migrate]
 *   npx tsx scripts/report-keep-rows-plan.ts --db=<snapshot copy> --account=<id> --cartola=<file.json> [--apply-new] [--migrate]
 *
 * `--statements`: the canonical statements the import hands `mergeCardStatements` (an array of
 * `CardCanonicalStatement`, or a `card.statement` payload in its canonical format —
 * `{ "format": "canonical", "statements": [...] }`, what the ingest parser answers for a PDF; an
 * issuer-format statement JSON is converted by its importer first). They are imported as the statement paths do,
 * replacing the stored copies of the same statements. `--cartola`: one parsed cartola month
 * (`ParsedCheckingCartola`). `--db` is required: run it on a COPY of a snapshot, never on the
 * running primary — today's import runs whole (with the card-line write's recompute) inside one
 * write transaction, which would hold the database past the server's busy timeout. The checkout's
 * own `data/nw-tracker.db` is refused unless `--allow-live` is passed. A database with pending
 * migrations is refused unless `--migrate` is passed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => process.argv.includes(`--${name}`);

const accountId = Number(arg("account"));
if (!Number.isInteger(accountId) || accountId <= 0) throw new Error("--account=<account id> is required");
const statementsFile = arg("statements");
const cartolaFile = arg("cartola");
if ((statementsFile == null) === (cartolaFile == null)) throw new Error("pass exactly one of --statements=<file> or --cartola=<file>");

const dbArg = arg("db");
if (!dbArg) throw new Error("--db=<a copy of a snapshot> is required (never the running primary)");
const file = path.resolve(dbArg);
if (!fs.existsSync(file)) throw new Error(`no database at ${file}`);
const live = path.join(serverDir, "data", "nw-tracker.db");
if (fs.existsSync(live) && fs.realpathSync(file) === fs.realpathSync(live) && !flag("allow-live")) {
  throw new Error(`${file} is the live database: run on a snapshot copy, or pass --allow-live with the server stopped`);
}
process.env.NW_TRACKER_TEST_DB = file;
{
  const dbi = new Database(file, { readonly: true, fileMustExist: true });
  const files = fs.readdirSync(path.join(serverDir, "migrations")).filter((f) => f.endsWith(".sql"));
  const done = new Set((dbi.prepare(`SELECT id FROM schema_migrations`).all() as { id: string }[]).map((r) => r.id));
  const pending = files.filter((f) => !done.has(f)).sort();
  dbi.close();
  if (pending.length > 0 && !flag("migrate")) {
    throw new Error(
      `${file} has ${pending.length} pending migration(s) (${pending.join(", ")}): the planners read the current schema. ` +
        `Boot the server on it, or pass --migrate to apply them here.`
    );
  }
}
// Background work stays off: this process only reads (and rolls back).
process.env.BACKGROUND_JOBS_ENABLED ??= "0";

const readJson = (f: string): unknown => JSON.parse(fs.readFileSync(f, "utf8"));
console.log(`database: ${file}`);
console.log(`account: ${accountId}`);
let disagreements: string[];
let deviations: string[];

async function readStatements(f: string) {
  const { cardCanonicalStatementSchema } = await import("nw-tracker-contracts");
  const raw = readJson(f);
  const list = Array.isArray(raw) ? raw : (raw as { statements?: unknown }).statements;
  if (!Array.isArray(list)) throw new Error(`${f}: expected an array of statements or { statements: [...] }`);
  return list.map((s, i) => {
    const parsed = cardCanonicalStatementSchema.safeParse(s);
    if (!parsed.success) throw new Error(`${f}: statement ${i}: ${parsed.error.message}`);
    return parsed.data;
  });
}

function readCartola(f: string): import("../src/checkingCartolaParse.js").ParsedCheckingCartola {
  const cartola = readJson(f) as import("../src/checkingCartolaParse.js").ParsedCheckingCartola;
  if (!cartola || typeof cartola.period_month !== "string" || !Array.isArray(cartola.movements)) {
    throw new Error(`${f}: expected a parsed cartola month ({ period_month, movements: [...], … })`);
  }
  return cartola;
}

if (flag("apply-new")) {
  const { db } = await import("../src/db.js");
  await import("../src/cards/lineWrites.js");
  await import("../src/expenseAssignmentWrites.js");
  const { importStatementDocuments } = await import("../src/cards/statementLinePlanApply.js");
  const { statementKeysOf } = await import("../src/ccInstallmentLedgerMerge.js");
  const { importCheckingCartola, isCheckingCartolaMonthImported } = await import("../src/checkingCartolaImport.js");
  const statements = statementsFile ? await readStatements(statementsFile) : null;
  const cartola = cartolaFile ? readCartola(cartolaFile) : null;
  class RollBack extends Error {}
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const totalChanges = () => count(`SELECT total_changes() AS n`);
  const stamps = () => count(`SELECT COUNT(*) AS n FROM flow_first_seen`);
  try {
    db.transaction(() => {
      const changes0 = totalChanges();
      const stamps0 = stamps();
      if (statements) {
        const r = importStatementDocuments(accountId, statements, { replaceStatementKeys: statementKeysOf(statements) });
        const k = r.keep_rows;
        console.log(`statements: ${statements.map((s) => `${s.document} ${s.close} ${s.currency} (${s.lines.length} lines)`).join("; ")}`);
        console.log(
          `the new import would write: restated ${k.restated.length} · inserted ${k.inserted.length} · folded ${k.folded.length} · removed ${k.removed.length} · ` +
            `annulled ${k.annulled.length} · moved ${k.moved.length} · annulments billed ${k.annulments_billed.length} · credited ${k.annulments_credited.length} · unpaired ${k.unpaired.length}`
        );
        for (const [what, ids] of Object.entries({ restated: k.restated, inserted: k.inserted, folded: k.folded, removed: k.removed, annulled: k.annulled, moved: k.moved, unpaired: k.unpaired })) {
          if (ids.length > 0) console.log(`  ${what}: lines ${ids.join(", ")}`);
        }
        console.log(`session finish (balances, valuations, financing links): ${k.wrote ? "yes" : "no — nothing changed"}`);
      } else {
        const c = cartola!;
        const replaceMonth = isCheckingCartolaMonthImported(accountId, c.period_month);
        const r = importCheckingCartola(accountId, c, db, { replaceMonth });
        console.log(`cartola: ${c.source_file} ${c.period_month} (${c.movements.length} movements${replaceMonth ? "; the month is on file: imported again in place" : ""})`);
        console.log(
          `the new import would write: daily rows restated ${r.partialsRestated} · folded ${r.partialsFolded} · removed ${r.partialsRemoved} · ` +
            `movements inserted ${r.movementsInserted} · kept ${r.movementsSkipped} · cartola rows no longer listed removed ${r.cartolaRowsRemoved}`
        );
        console.log(`wrote anything: ${r.wrote ? "yes" : "no"}`);
      }
      console.log(`arrival stamps created: ${stamps() - stamps0}`);
      console.log(`rows changed in all (total_changes): ${totalChanges() - changes0}`);
      throw new RollBack();
    })();
  } catch (e) {
    if (!(e instanceof RollBack)) throw e;
  }
  process.exit(0);
}

if (statementsFile) {
  const statements = await readStatements(statementsFile);
  const { compareCardStatementImport } = await import("../src/cards/statementLinePlanCompare.js");
  const r = compareCardStatementImport(accountId, statements);
  const p = r.plan;
  const doc = (d: { statement_key: string; index: number } | null) => (d ? `${d.statement_key.split("\t")[1]} #${d.index}` : "—");
  const row = (x: { kind: string; id: number }) => (x.kind === "line" ? `line ${x.id}` : `annulled purchase ${x.id}`);
  console.log(`statements: ${statements.map((s) => `${s.document} ${s.close} ${s.currency} (${s.lines.length} lines)`).join("; ")}`);
  console.log(
    `plan: keep ${p.keep.length} · fold ${p.fold.length} · insert ${p.insert.length} · remove ${p.remove.length} · skip ${p.skip.length} · ` +
      `annul ${p.annul.length} · move ${p.move_to_open.length} · kept prepayment ${p.kept_plan_prepayment.length} · ` +
      `annulments credited ${p.annulments_credited.length} · ambiguous ${p.ambiguous.length}`
  );
  for (const k of p.keep) console.log(`  keep   ${row(k.row)} ↔ ${doc(k.doc)}  (${k.why}${k.today === "differs" ? "; today differs" : ""})`);
  for (const f of p.fold) console.log(`  fold   ${row(f.row)} → ${row(f.into)} on ${doc(f.doc)}  (${f.why}${f.today === "differs" ? "; today differs" : ""})`);
  for (const i of p.insert) console.log(`  insert ${doc(i.doc)}  (arrival ${i.arrival}${i.copies_classification_from != null ? `; copies classification of line ${i.copies_classification_from}` : ""})`);
  for (const x of p.remove) console.log(`  remove ${row(x.row)}  (${x.why}${x.plan_id != null ? ` → plan ${x.plan_id}` : ""})`);
  for (const s of p.skip) console.log(`  skip   ${doc(s.doc)}  (${s.why}${s.same_as ? ` = ${doc(s.same_as)}` : ""}${s.plan_id != null ? ` → plan ${s.plan_id}` : ""})`);
  for (const a of p.annul) console.log(`  annul  line ${a.line_id}  (${a.billing_month}, annulled ${a.annulled_on})`);
  for (const m of p.move_to_open) console.log(`  move   line ${m.line_id} → open ${m.billing_month}`);
  for (const id of p.kept_plan_prepayment) console.log(`  keep   line ${id}  (plan prepayment, stays in its bucket)`);
  for (const c of p.annulments_credited) console.log(`  credit ${c.annulled_purchase_id != null ? `annulled purchase ${c.annulled_purchase_id}` : `line ${c.bucket_line_id} (annulled now)`} by ${doc(c.doc)}`);
  for (const a of p.ambiguous) console.log(`  AMBIGUOUS ${a.what}: ${a.rows.map(row).join(", ")} ${a.docs.map(doc).join(", ")}`);
  disagreements = r.disagreements;
  deviations = r.deviations;
} else {
  const cartola = readCartola(cartolaFile!);
  const { compareCheckingCartolaImport } = await import("../src/checkingCartolaPlanCompare.js");
  const r = compareCheckingCartolaImport(accountId, cartola);
  const p = r.plan;
  const mv = (i: number) => {
    if (i < 0) return "no movement";
    const m = cartola.movements[i]!;
    return `#${i} ${m.occurred_on} ${m.amount_clp} «${m.description}»`;
  };
  console.log(`cartola: ${cartola.source_file} ${cartola.period_month} (${cartola.movements.length} movements)`);
  console.log(
    `plan: keep ${p.keep.length} · confirm ${p.confirm.length} · insert ${p.insert.length} · fold ${p.fold.length} · remove ${p.remove.length} · ambiguous ${p.ambiguous.length}`
  );
  for (const k of p.keep) {
    const redate = k.redate ? `; re-dated ${k.redate.occurred_on}, bank day ${k.redate.bank_day}` : "";
    console.log(`  keep    row ${k.row_id} ↔ ${mv(k.movement)}  (${k.why}${redate}${k.today === "differs" ? "; today differs" : ""})`);
  }
  for (const c of p.confirm) console.log(`  confirm row ${c.row_id} ↔ ${mv(c.movement)}  (${c.why})`);
  for (const i of p.insert) console.log(`  insert  ${mv(i.movement)}${i.retired_flow_id != null ? `  (takes retired flow ${i.retired_flow_id})` : ""}${i.today === "differs" ? "  (today differs)" : ""}`);
  for (const f of p.fold) console.log(`  fold    row ${f.row_id} → row ${f.into_row_id} on ${mv(f.movement)}${f.today === "differs" ? "  (today differs)" : ""}`);
  for (const x of p.remove) console.log(`  remove  row ${x.row_id}  (${x.why}; ${mv(x.movement)})`);
  for (const a of p.ambiguous) console.log(`  AMBIGUOUS ${a.what}: ${mv(a.movement)} flows ${a.flow_ids.join(", ")}`);
  disagreements = r.disagreements;
  deviations = r.deviations;
}

console.log(`\ndeclared deviations from today (${deviations.length}):`);
for (const d of deviations) console.log(`  ${d}`);
console.log(`\ndisagreements with today's import (${disagreements.length}):`);
for (const d of disagreements) console.log(`  ${d}`);
process.exit(disagreements.length > 0 ? 1 : 0);
