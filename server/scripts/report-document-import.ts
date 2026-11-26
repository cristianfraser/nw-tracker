/**
 * Report only: what importing a document would write, on a snapshot copy. Runs the production
 * import as its entry point does — card statements through `importStatementDocuments` with the
 * statements' replace keys (after printing their plan: `cards/statementLinePlan.ts`), a cartola
 * through `applyBankAccountStatements`, the ingest kind's apply (the cuenta vista's month split,
 * the pruning of months a document no longer covers, a forced re-import's rules) — inside a
 * transaction that is rolled back, and prints the rows restated / inserted / folded / removed, the
 * arrival stamps created, whether the card-line session finish ran and the rows changed in all.
 * The tool for validating a statement or cartola before deploying. Never writes.
 *
 *   npx tsx scripts/report-document-import.ts --db=<snapshot copy> --account=<id> --statements=<file.json> [--migrate]
 *   npx tsx scripts/report-document-import.ts --db=<snapshot copy> --account=<id> --cartola=<file.json> [--product=checking|demand_deposit] [--force] [--migrate]
 *   npx tsx scripts/report-document-import.ts --db=<snapshot copy> --preflight
 *
 * `--preflight`: read only, without migrating, lists what migrations 371–373 would trip on
 * (`bankRowFactsPreflight373`); every list empty = safe to deploy (exit 0, else 1).
 *
 * `--statements`: canonical card statements (an array of `CardCanonicalStatement`, or a
 * `card.statement` payload in its canonical format — `{ "format": "canonical", "statements": [...] }`,
 * what the ingest parser answers for a PDF; an issuer-format statement JSON is converted by its
 * importer first), imported replacing the stored copies of the same statements. `--cartola`: a
 * `bank_account.statements` payload, or one parsed cartola month (`ParsedCheckingCartola`) wrapped
 * as a statement of `--product` (`--force`: a forced re-import). `--db` is required: run it on a
 * COPY of a snapshot, never on the running primary — the import runs whole inside one write
 * transaction, which would hold the database past the server's busy timeout. The checkout's own
 * `data/nw-tracker.db` is refused unless `--allow-live` is passed. A database with pending
 * migrations is refused unless `--migrate` is passed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => process.argv.includes(`--${name}`);

const dbArg = arg("db");
if (!dbArg) throw new Error("--db=<a copy of a snapshot> is required (never the running primary)");
const file = path.resolve(dbArg);
if (!fs.existsSync(file)) throw new Error(`no database at ${file}`);
const live = path.join(serverDir, "data", "nw-tracker.db");
if (fs.existsSync(live) && fs.realpathSync(file) === fs.realpathSync(live) && !flag("allow-live")) {
  throw new Error(`${file} is the live database: run on a snapshot copy, or pass --allow-live with the server stopped`);
}
if (flag("preflight")) {
  // Read only, before any migration: what migrations 371–373 would trip on.
  const { bankRowFactsPreflight373 } = await import("../src/migrationHooks/bankRowFactsPreflight373.js");
  const dbi = new Database(file, { readonly: true, fileMustExist: true });
  const report = bankRowFactsPreflight373(dbi);
  dbi.close();
  console.log(`database: ${file}`);
  let total = 0;
  for (const [what, ids] of Object.entries(report)) {
    total += ids.length;
    console.log(`${what}: ${ids.length}${ids.length > 0 ? ` — ${ids.join(", ")}` : ""}`);
  }
  console.log(total === 0 ? "preflight: clean, safe to deploy" : "preflight: rows listed above");
  process.exit(total === 0 ? 0 : 1);
}
const accountId = Number(arg("account"));
if (!Number.isInteger(accountId) || accountId <= 0) throw new Error("--account=<account id> is required");
const statementsFile = arg("statements");
const cartolaFile = arg("cartola");
if ((statementsFile == null) === (cartolaFile == null)) throw new Error("pass exactly one of --statements=<file> or --cartola=<file>");
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

/**
 * A `bank_account.statements` payload as the ingest kind sends it, or one parsed cartola month
 * wrapped as a statement of `--product=checking|demand_deposit` (default checking).
 */
function readBankPayload(f: string): import("nw-tracker-contracts").BankAccountStatementsPayload {
  const raw = readJson(f) as Record<string, unknown>;
  if (raw && typeof raw === "object" && "account" in raw && Array.isArray(raw.statements)) {
    return raw as unknown as import("nw-tracker-contracts").BankAccountStatementsPayload;
  }
  const c = readCartola(f);
  const product = (arg("product") ?? "checking") as "checking" | "demand_deposit";
  return {
    account: { issuer: "santander", product },
    force_reimport: flag("force"),
    unreadable: [],
    statements: [
      {
        document: c.source_file,
        period_month: c.period_month,
        period_from: c.period_from,
        period_to: c.period_to,
        opening_balance: c.saldo_inicial_clp,
        closing_balance: c.saldo_final_clp,
        month_closing_balances: c.month_saldo_final_clp ?? null,
        movements: c.movements.map((m) => ({ date: m.occurred_on, branch: m.branch, description: m.description, document_no: m.document_no, amount: m.amount_clp })),
        skipped_rows: c.skipped,
        notes: c.notes,
      },
    ],
  } as import("nw-tracker-contracts").BankAccountStatementsPayload;
}

function readCartola(f: string): import("../src/checkingCartolaParse.js").ParsedCheckingCartola {
  const cartola = readJson(f) as import("../src/checkingCartolaParse.js").ParsedCheckingCartola;
  if (!cartola || typeof cartola.period_month !== "string" || !Array.isArray(cartola.movements)) {
    throw new Error(`${f}: expected a parsed cartola month ({ period_month, movements: [...], … })`);
  }
  return cartola;
}

{
  const { db } = await import("../src/db.js");
  await import("../src/cards/lineWrites.js");
  await import("../src/expenseAssignmentWrites.js");
  const { importStatementDocuments } = await import("../src/cards/statementLinePlanApply.js");
  const { loadCardStatementLinePlanInput } = await import("../src/cards/statementLinePlanLoad.js");
  const { planCardStatementLines } = await import("../src/cards/statementLinePlan.js");
  const { statementKeysOf } = await import("../src/ccInstallmentLedgerMerge.js");
  const { applyBankAccountStatements, bankStatementAccountId } = await import("../src/bankAccountStatementsApply.js");
  const statements = statementsFile ? await readStatements(statementsFile) : null;
  const bankPayload = cartolaFile ? readBankPayload(cartolaFile) : null;
  if (bankPayload && bankStatementAccountId(bankPayload.account) !== accountId) {
    throw new Error(`--account=${accountId} is not the account the payload names (${bankStatementAccountId(bankPayload.account)})`);
  }
  const accountRows = () =>
    new Map(
      (db.prepare(`SELECT id, note, flow_id FROM movements WHERE account_id = ?`).all(accountId) as { id: number; note: string; flow_id: number }[]).map(
        (r) => [r.id, r]
      )
    );
  class RollBack extends Error {}
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const totalChanges = () => count(`SELECT total_changes() AS n`);
  const stamps = () => count(`SELECT COUNT(*) AS n FROM flow_first_seen`);
  try {
    db.transaction(() => {
      const changes0 = totalChanges();
      const stamps0 = stamps();
      if (statements) {
        printCardPlan(planCardStatementLines(loadCardStatementLinePlanInput(accountId, statements, { replaceStatementKeys: statementKeysOf(statements) })));
        const r = importStatementDocuments(accountId, statements, { replaceStatementKeys: statementKeysOf(statements) });
        const k = r.keep_rows;
        console.log(`statements: ${statements.map((s) => `${s.document} ${s.close} ${s.currency} (${s.lines.length} lines)`).join("; ")}`);
        console.log(
          `the import would write: restated ${k.restated.length} · inserted ${k.inserted.length} · folded ${k.folded.length} · removed ${k.removed.length} · ` +
            `annulled ${k.annulled.length} · moved ${k.moved.length} · annulments billed ${k.annulments_billed.length} · credited ${k.annulments_credited.length} · unpaired ${k.unpaired.length}`
        );
        for (const [what, ids] of Object.entries({ restated: k.restated, inserted: k.inserted, folded: k.folded, removed: k.removed, annulled: k.annulled, moved: k.moved, unpaired: k.unpaired })) {
          if (ids.length > 0) console.log(`  ${what}: lines ${ids.join(", ")}`);
        }
        console.log(`session finish (balances, valuations, financing links): ${k.wrote ? "yes" : "no — nothing changed"}`);
      } else {
        // The ingest kind's own apply (`applyBankAccountStatements`): the cuenta vista's month
        // split, the pruning of months a document no longer covers, the forced re-import's rules.
        const before = accountRows();
        const flows = { inserted: [] as { description: string }[], skipped: [] as { reason: string }[] };
        const result = applyBankAccountStatements(bankPayload!, flows as never);
        for (const f of result.files) console.log(`  ${f.file} ${f.period_month}: ${f.status}${f.error ? ` — ${f.error}` : ""}`);
        const after = accountRows();
        const restatedRows = [...after].filter(([id, n]) => before.has(id) && before.get(id)!.note !== n.note);
        const insertedRows = [...after].filter(([id]) => !before.has(id));
        const goneRows = [...before].filter(([id]) => !after.has(id));
        const liveFlows = new Set([...after.values()].map((r) => r.flow_id));
        const folded = goneRows.filter(([, r]) => liveFlows.has(r.flow_id));
        const removed = goneRows.filter(([, r]) => !liveFlows.has(r.flow_id));
        console.log(
          `the import would write: restated ${restatedRows.length} · inserted ${insertedRows.length} · folded ${folded.length} · removed ${removed.length}`
        );
        for (const [id, r] of restatedRows) console.log(`  restate row ${id}: «${before.get(id)!.note}» → «${r.note}»`);
        for (const [id, r] of insertedRows) console.log(`  insert  row ${id}: «${r.note}»`);
        for (const [id, r] of folded) console.log(`  fold    row ${id} (flow ${r.flow_id}): «${r.note}»`);
        for (const [id, r] of removed) console.log(`  remove  row ${id}: «${r.note}»`);
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

function printCardPlan(p: import("../src/cards/statementLinePlan.js").CardStatementLinePlan): void {
  const doc = (d: { statement_key: string; index: number } | null) => (d ? `${d.statement_key.split("\t")[1]} #${d.index}` : "—");
  const row = (x: { kind: string; id: number }) => (x.kind === "line" ? `line ${x.id}` : `annulled purchase ${x.id}`);
  console.log(
    `plan: keep ${p.keep.length} · fold ${p.fold.length} · insert ${p.insert.length} · remove ${p.remove.length} · skip ${p.skip.length} · ` +
      `annul ${p.annul.length} · move ${p.move_to_open.length} · kept prepayment ${p.kept_plan_prepayment.length} · ` +
      `annulments credited ${p.annulments_credited.length} · ambiguous ${p.ambiguous.length}`
  );
  for (const k of p.keep) console.log(`  keep   ${row(k.row)} ↔ ${doc(k.doc)}  (${k.why})`);
  for (const f of p.fold) console.log(`  fold   ${row(f.row)} → ${row(f.into)} on ${doc(f.doc)}  (${f.why})`);
  for (const i of p.insert) console.log(`  insert ${doc(i.doc)}  (arrival ${i.arrival}${i.copies_classification_from != null ? `; copies classification of line ${i.copies_classification_from}` : ""})`);
  for (const x of p.remove) console.log(`  remove ${row(x.row)}  (${x.why}${x.plan_id != null ? ` → plan ${x.plan_id}` : ""})`);
  for (const s of p.skip) console.log(`  skip   ${doc(s.doc)}  (${s.why}${s.same_as ? ` = ${doc(s.same_as)}` : ""}${s.plan_id != null ? ` → plan ${s.plan_id}` : ""})`);
  for (const a of p.annul) console.log(`  annul  line ${a.line_id}  (${a.billing_month}, annulled ${a.annulled_on})`);
  for (const m of p.move_to_open) console.log(`  move   line ${m.line_id} → open ${m.billing_month}`);
  for (const id of p.kept_plan_prepayment) console.log(`  keep   line ${id}  (plan prepayment, stays in its bucket)`);
  for (const c of p.annulments_credited) console.log(`  credit ${c.annulled_purchase_id != null ? `annulled purchase ${c.annulled_purchase_id}` : `line ${c.bucket_line_id} (annulled now)`} by ${doc(c.doc)}`);
  for (const a of p.ambiguous) console.log(`  AMBIGUOUS ${a.what}: ${a.rows.map(row).join(", ")} ${a.docs.map(doc).join(", ")}`);
}
