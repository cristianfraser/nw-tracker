/**
 * Moves card-line expense assignments (category «Único» rows, big groups, notes, category splits)
 * that re-imports left on keys no line carries onto the line that is the same purchase today.
 *
 * Report-first; `--apply` writes (IMMEDIATE transaction). An orphan is a `line-pr:<parser_row_id>`
 * row whose parser_row_id no line of its account carries, or a card split whose line id is gone.
 * Each is looked up in the newest snapshot under `server/data/snapshots/` that still has the line,
 * and paired with today's lines by `planCcLineMoves` (`src/ccExpenseLineRekey.ts`, the rule the
 * import itself now runs) against every line of that account that changed since the snapshot.
 * A target that already holds a different value keeps it unless the stored key is named in
 * `--prefer-stored=<key>,<key>`; a target claimed from two snapshots is skipped. A line named in
 * `--keep-current-category-lines=<id>,<id>` keeps the category it shows today (its merchant rule)
 * instead of getting the stored one back; its big group and note still move.
 *
 *   npx tsx scripts/repair-cc-expense-orphaned-line-keys.ts [--prefer-stored=line-pr:…] [--apply]
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { db } from "../src/db.js";
import {
  applyCcLineMoves,
  CC_LINE_REF_SELECT,
  ccLineRefFromRow,
  listCcLineRefsForAccount,
  planCcLineMoves,
  type CcLineIdentitySource,
  type CcLineMove,
  type CcLineRef,
} from "../src/ccExpenseLineRekey.js";

const apply = process.argv.includes("--apply");
const preferArg = process.argv.find((a) => a.startsWith("--prefer-stored="));
const preferStoredKeys = new Set(
  (preferArg?.slice("--prefer-stored=".length) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const keepArg = process.argv.find((a) => a.startsWith("--keep-current-category-lines="));
const keepCurrentLineIds = new Set(
  (keepArg?.slice("--keep-current-category-lines=".length) ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
);

type Orphan = { kind: "key"; accountId: number; parserRowId: string } | { kind: "split"; lineId: number };

const liveByAccount = new Map<number, CcLineRef[]>();
function liveLines(accountId: number): CcLineRef[] {
  let v = liveByAccount.get(accountId);
  if (!v) {
    v = listCcLineRefsForAccount(accountId);
    liveByAccount.set(accountId, v);
  }
  return v;
}

const keyedRows = db
  .prepare(
    `SELECT account_id, purchase_key FROM cc_expense_unique_purchases WHERE purchase_key LIKE 'line-pr:%'
     -- Big groups carry no account (migration 235): one sharing its key with a category or note
     -- row is found through that row; one alone is not reported here.
     UNION SELECT account_id, purchase_key FROM cc_expense_purchase_notes WHERE purchase_key LIKE 'line-pr:%'`
  )
  .all() as { account_id: number; purchase_key: string }[];
const orphans: Orphan[] = [];
for (const r of keyedRows) {
  const prid = r.purchase_key.slice("line-pr:".length);
  if (!liveLines(r.account_id).some((l) => l.parserRowId === prid)) {
    orphans.push({ kind: "key", accountId: r.account_id, parserRowId: prid });
  }
}
const splitLineIds = db
  .prepare(
    `SELECT DISTINCT sp.line_id FROM cc_expense_line_splits sp
     WHERE sp.source = 'cc' AND NOT EXISTS (SELECT 1 FROM cc_statement_lines l WHERE l.id = sp.line_id)`
  )
  .all() as { line_id: number }[];
for (const r of splitLineIds) orphans.push({ kind: "split", lineId: r.line_id });

console.log(
  `orphans: ${orphans.filter((o) => o.kind === "key").length} line-pr keys, ` +
    `${orphans.filter((o) => o.kind === "split").length} split line ids`
);

const snapshotDir = path.resolve(import.meta.dirname, "../data/snapshots");
const snapshots = fs
  .readdirSync(snapshotDir)
  .filter((f) => f.endsWith(".db"))
  .sort()
  .reverse();

type RefRow = CcLineIdentitySource & { id: number; parser_row_id: string | null };
const orphanTag = (o: Orphan) => (o.kind === "key" ? `key|${o.accountId}|${o.parserRowId}` : `split|${o.lineId}`);
const pending = new Map(orphans.map((o) => [orphanTag(o), o]));
/** Per snapshot: the orphan lines it is the newest holder of. */
const foundIn = new Map<string, { snapDb: Database.Database; lines: Map<number, CcLineRef> }>();

for (const file of snapshots) {
  if (pending.size === 0) break;
  let snapDb: Database.Database;
  try {
    snapDb = new Database(path.join(snapshotDir, file), { readonly: true, fileMustExist: true });
    snapDb.prepare(`SELECT 1 FROM cc_statement_lines LIMIT 1`).get();
  } catch {
    continue;
  }
  const byPrid = snapDb.prepare(`${CC_LINE_REF_SELECT} WHERE s.account_id = ? AND l.parser_row_id = ?`);
  const hasSplits = snapDb
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cc_expense_line_splits'`)
    .get();
  const bySplitLine = hasSplits
    ? snapDb.prepare(
        `${CC_LINE_REF_SELECT} WHERE l.id = ?
           AND EXISTS (SELECT 1 FROM cc_expense_line_splits sp WHERE sp.source = 'cc' AND sp.line_id = l.id)`
      )
    : null;
  const hits = new Map<number, CcLineRef>();
  for (const [tag, o] of pending) {
    const row = (
      o.kind === "key" ? byPrid.get(o.accountId, o.parserRowId) : bySplitLine?.get(o.lineId)
    ) as RefRow | undefined;
    if (!row) continue;
    hits.set(row.id, ccLineRefFromRow(row));
    pending.delete(tag);
  }
  if (hits.size > 0) foundIn.set(file, { snapDb, lines: hits });
  else snapDb.close();
}

const moves: { snapshot: string; move: CcLineMove }[] = [];
const unpaired: { snapshot: string; ref: CcLineRef; reason: string }[] = [];
for (const [file, { snapDb, lines }] of foundIn) {
  const accounts = new Set([...lines.values()].map((r) => r.accountId));
  for (const accountId of accounts) {
    const snapLines = (snapDb.prepare(`${CC_LINE_REF_SELECT} WHERE s.account_id = ?`).all(accountId) as RefRow[]).map(
      ccLineRefFromRow
    );
    const now = liveLines(accountId);
    const sig = (r: CcLineRef) => `${r.lineId}|${r.parserRowId ?? ""}`;
    const snapSigs = new Set(snapLines.map(sig));
    const nowSigs = new Set(now.map(sig));
    const plan = planCcLineMoves(
      snapLines.filter((r) => !nowSigs.has(sig(r))),
      now.filter((r) => !snapSigs.has(sig(r))),
      now.filter((r) => snapSigs.has(sig(r)))
    );
    for (const m of plan.moves) if (lines.has(m.from.lineId)) moves.push({ snapshot: file, move: m });
    for (const r of plan.ambiguous) if (lines.has(r.lineId)) unpaired.push({ snapshot: file, ref: r, reason: "ambiguous" });
    for (const r of plan.gone) if (lines.has(r.lineId)) unpaired.push({ snapshot: file, ref: r, reason: "gone" });
  }
  snapDb.close();
}

// A line claimed from two snapshots is not the same purchase twice — skip every claim on it
// (several duplicate copies from one snapshot landing on their surviving copy is fine).
const claimSnapshots = new Map<number, Set<string>>();
for (const { snapshot, move } of moves) {
  const set = claimSnapshots.get(move.to.lineId) ?? new Set<string>();
  set.add(snapshot);
  claimSnapshots.set(move.to.lineId, set);
}
const singleClaim = (m: { move: CcLineMove }) => (claimSnapshots.get(m.move.to.lineId)?.size ?? 0) === 1;
const doubleClaimed = moves.filter((m) => !singleClaim(m));
const finalMoves = moves.filter(singleClaim);

const describe = db.prepare(
  `SELECT l.merchant, l.transaction_date, l.amount_clp, l.amount_usd FROM cc_statement_lines l WHERE l.id = ?`
);
const byReason = new Map<string, number>();
for (const u of unpaired) byReason.set(u.reason, (byReason.get(u.reason) ?? 0) + 1);
console.log(
  `located in snapshots: ${orphans.length - pending.size}; not in any snapshot: ${pending.size}; ` +
    `paired: ${finalMoves.length} (${finalMoves.filter((m) => m.move.by === "identity").length} by identity, ${finalMoves.filter((m) => m.move.by === "survivor").length} onto a surviving copy); ` +
    `double-claimed: ${doubleClaimed.length}; unpaired: ${JSON.stringify(Object.fromEntries(byReason))}`
);
for (const u of unpaired.filter((x) => x.reason === "ambiguous")) {
  console.log(`  ambiguous: account ${u.ref.accountId} ${u.ref.identity} (${u.snapshot})`);
}

const keepCurrentCategoryKeys = new Set(
  finalMoves
    .filter((m) => keepCurrentLineIds.has(m.move.to.lineId) && m.move.from.parserRowId)
    .map((m) => `line-pr:${m.move.from.parserRowId}`)
);
const unknownKeep = [...keepCurrentLineIds].filter((id) => !finalMoves.some((m) => m.move.to.lineId === id));
if (unknownKeep.length > 0) throw new Error(`--keep-current-category-lines: no move targets line(s) ${unknownKeep.join(", ")}`);
const run = () =>
  applyCcLineMoves(
    finalMoves.map((m) => m.move),
    { preferStoredKeys, skipCategorylessUnique: true, keepCurrentCategoryKeys }
  );
const result = db.transaction(() => {
  const r = run();
  if (!apply) throw Object.assign(new Error("dry-run rollback"), { dryRunResult: r });
  return r;
});
let applied;
try {
  applied = result.immediate();
} catch (e) {
  const r = (e as { dryRunResult?: ReturnType<typeof run> }).dryRunResult;
  if (!r) throw e;
  applied = r;
}
console.log(`${apply ? "APPLIED" : "DRY RUN (rolled back)"}: moved ${JSON.stringify(applied.moved)}`);
console.log(`  duplicates removed ${applied.duplicates_removed}, overridden ${applied.overridden}, «Único» without category left ${applied.categoryless_unique_skipped}, kept current category ${applied.kept_current}, conflicts ${applied.conflicts.length}`);
for (const c of applied.conflicts) {
  const to = finalMoves.find((m) => `line-pr:${m.move.to.parserRowId}` === c.to || `line:${m.move.to.lineId}` === c.to);
  const d = to ? (describe.get(to.move.to.lineId) as Record<string, unknown> | undefined) : undefined;
  console.log(
    `  conflict ${c.table} ${c.from} → ${c.to}: stored ${String(c.stored)} vs current ${String(c.current)}` +
      (d ? `  [${d.merchant} ${d.transaction_date} ${d.amount_clp ?? ""} ${d.amount_usd ?? ""}]` : "")
  );
}
