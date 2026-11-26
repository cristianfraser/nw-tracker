/**
 * The statement-line plan against today's import (report only): plans the import, then runs
 * today's import (`replaceStatementLines`, the statement path's funnel) inside a transaction that is
 * rolled back, and compares the end states. Every bare flow is first held by a probe row
 * (`flow_link_rejections` against a throwaway expense entry: a holding table no import matcher reads
 * and a merge never refuses) inside that transaction, so a
 * flow outlives its row and the pairing today's pipeline performs is observable as «this old row's
 * flow is now on that new row» — without it a line with nothing on its flow leaves no trace of the
 * pairing. Row and flow ids are handed out again once the higher ones are gone (a replaced
 * statement's lines come back under their old ids), so temporary triggers record which ids the
 * import wrote and deleted (`trackWrites`). Writes nothing.
 */
import type { CardCanonicalStatement } from "nw-tracker-contracts";
import { db } from "../db.js";
import { clearAggregationCache } from "../cacheRegistry.js";
import { replaceStatementLines } from "./lineWrites.js";
import { statementKeysOf } from "../ccInstallmentLedgerMerge.js";
import { loadCardStatementLinePlanInput } from "./statementLinePlanLoad.js";
import { planCardStatementLines, type CardStatementLinePlan, type DocLineRef, type FileRowRef } from "./statementLinePlan.js";

export type CardPlanComparison = {
  plan: CardStatementLinePlan;
  /** Where the planner's account of today's end state differs from what today's import did. */
  disagreements: string[];
  /** Plan entries that depart from today on purpose (`today: "differs"`), described. */
  deviations: string[];
};

const PROBE_NOTE = "probe:keep-rows-plan";

class RollBack extends Error {}

const rowLabel = (r: FileRowRef): string => (r.kind === "line" ? `line ${r.id}` : `annulled purchase ${r.id}`);
const docLabel = (d: DocLineRef): string => `${d.statement_key.replace(/\t/g, " | ")} #${d.index}`;

/** Plans the import of `statements` into `accountId` and compares it with today's import, rolled back. */
export function compareCardStatementImport(
  accountId: number,
  statements: readonly CardCanonicalStatement[]
): CardPlanComparison {
  const replaceStatementKeys = statementKeysOf(statements);
  const plan = planCardStatementLines(loadCardStatementLinePlanInput(accountId, statements, { replaceStatementKeys }));
  const disagreements: string[] = [];
  try {
    db.transaction(() => {
      probeBareFlows(accountId);
      const before = readLines(accountId);
      const annulmentsBefore = readAnnulments(accountId);
      const writes = trackWrites(["cc_statement_lines", "flows", "cc_annulled_purchases"]);
      replaceStatementLines(accountId, statements, { replaceStatementKeys });
      const written = writes.read();
      const after = readLines(accountId);
      const annulmentsAfter = readAnnulments(accountId);
      const newFlows = written.get("flows")!.inserted;
      const flowsAlive = new Set(
        (db.prepare(`SELECT id FROM flows`).all() as { id: number }[]).map((r) => r.id).filter((id) => !newFlows.has(id))
      );
      compareEndStates(
        plan,
        { before, after, annulmentsBefore, annulmentsAfter, flowsAlive, newLines: written.get("cc_statement_lines")!.inserted, newFlows, newAnnulments: written.get("cc_annulled_purchases")!.inserted },
        disagreements
      );
      throw new RollBack();
    })();
  } catch (e) {
    if (!(e instanceof RollBack)) throw e;
  } finally {
    clearAggregationCache();
  }
  const deviations = [
    ...plan.keep.filter((k) => k.today === "differs").map((k) => `keep ${rowLabel(k.row)} ↔ ${docLabel(k.doc)} (${k.why}): today ends otherwise`),
    ...plan.fold
      .filter((f) => f.today === "differs")
      .map((f) => `fold ${rowLabel(f.row)} into ${rowLabel(f.into)} (${f.why}): today ends otherwise`),
  ];
  return { plan, disagreements, deviations };
}

type LineRow = { id: number; statement_id: number; flow_id: number | null; dedupe_key: string | null };
type AnnulmentRow = { id: number; flow_id: number | null; bank_credit: number };

function readLines(accountId: number): Map<number, LineRow> {
  const rows = db
    .prepare(
      `SELECT l.id, l.statement_id, l.flow_id, l.dedupe_key FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ? ORDER BY l.id`
    )
    .all(accountId) as LineRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

function readAnnulments(accountId: number): Map<number, AnnulmentRow> {
  const rows = db.prepare(`SELECT id, flow_id, bank_credit FROM cc_annulled_purchases WHERE account_id = ?`).all(accountId) as AnnulmentRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Temporary triggers recording the ids each table gets inserted and deleted from here on (inside the
 * caller's transaction, so they go with its rollback).
 */
export function trackWrites(tables: readonly string[]): { read: () => Map<string, { inserted: Set<number>; deleted: Set<number> }> } {
  for (const t of tables) {
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS kr_ins_${t} (id INTEGER); CREATE TEMP TABLE IF NOT EXISTS kr_del_${t} (id INTEGER);`);
    db.exec(`DELETE FROM kr_ins_${t}; DELETE FROM kr_del_${t};`);
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS kr_ai_${t} AFTER INSERT ON main.${t} BEGIN INSERT INTO kr_ins_${t} VALUES (NEW.id); END;`);
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS kr_ad_${t} AFTER DELETE ON main.${t} BEGIN INSERT INTO kr_del_${t} VALUES (OLD.id); END;`);
  }
  return {
    read: () => {
      const out = new Map<string, { inserted: Set<number>; deleted: Set<number> }>();
      for (const t of tables) {
        const ids = (q: string) => new Set((db.prepare(q).all() as { id: number }[]).map((r) => r.id));
        out.set(t, { inserted: ids(`SELECT id FROM kr_ins_${t}`), deleted: ids(`SELECT id FROM kr_del_${t}`) });
        db.exec(`DROP TRIGGER kr_ai_${t}; DROP TRIGGER kr_ad_${t};`);
      }
      return out;
    },
  };
}

/** Holds every flow of the account's lines and annulments (see the module doc). */
function probeBareFlows(accountId: number): void {
  probeFlows(
    `SELECT l.flow_id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
     WHERE s.account_id = ? AND l.flow_id IS NOT NULL
     UNION SELECT a.flow_id FROM cc_annulled_purchases a WHERE a.account_id = ? AND a.flow_id IS NOT NULL`,
    [accountId, accountId]
  );
}

/**
 * Holds the flows `flowIdsSql` selects with a probe row each (a bill-link refusal against one
 * throwaway expense entry), so they outlive their rows. Inside the caller's rolled-back transaction.
 */
export function probeFlows(flowIdsSql: string, params: unknown[]): void {
  const entry = Number(
    db.prepare(`INSERT INTO expense_entries (amount, currency, spent_on, note) VALUES (0, 'clp', '1800-01-01', ?)`).run(PROBE_NOTE)
      .lastInsertRowid
  );
  db.prepare(
    `INSERT OR IGNORE INTO flow_link_rejections (flow_id, kind, counterpart_entry_id) SELECT f.flow_id, 'bill', ? FROM (${flowIdsSql}) f`
  ).run(entry, ...params);
}

function compareEndStates(
  plan: CardStatementLinePlan,
  s: {
    before: Map<number, LineRow>;
    after: Map<number, LineRow>;
    annulmentsBefore: Map<number, AnnulmentRow>;
    annulmentsAfter: Map<number, AnnulmentRow>;
    /** Before flows still on file (a reused id is a new flow). */
    flowsAlive: Set<number>;
    newLines: Set<number>;
    newFlows: Set<number>;
    newAnnulments: Set<number>;
  },
  out: string[]
): void {
  // Who held each flow before the import.
  const ownerOfFlow = new Map<number, FileRowRef>();
  for (const l of s.before.values()) if (l.flow_id != null) ownerOfFlow.set(l.flow_id, { kind: "line", id: l.id });
  for (const a of s.annulmentsBefore.values()) {
    if (a.flow_id != null && !ownerOfFlow.has(a.flow_id)) ownerOfFlow.set(a.flow_id, { kind: "annulled_purchase", id: a.id });
  }
  const sameRow = (a: FileRowRef | null, b: FileRowRef | null): boolean =>
    a == null ? b == null : b != null && a.kind === b.kind && a.id === b.id;

  // Document lines written: the new rows of each statement, matched by dedupe key, else in order.
  const newRows = [...s.after.values()].filter((l) => s.newLines.has(l.id));
  const written = plan.today.docs.filter((d) => "row" in d.outcome);
  const byStatement = new Map<number, LineRow[]>();
  for (const r of newRows) byStatement.set(r.statement_id, [...(byStatement.get(r.statement_id) ?? []), r]);
  const claimed = new Set<number>();
  const rowOfDoc = new Map<(typeof written)[number], LineRow>();
  for (const d of written) {
    const pool = byStatement.get(d.statement_id!) ?? [];
    const hit = pool.find((r) => !claimed.has(r.id) && d.dedupe_key != null && r.dedupe_key === d.dedupe_key);
    if (hit) {
      claimed.add(hit.id);
      rowOfDoc.set(d, hit);
    }
  }
  for (const d of written) {
    if (rowOfDoc.has(d)) continue;
    const hit = (byStatement.get(d.statement_id!) ?? []).find((r) => !claimed.has(r.id));
    if (!hit) {
      out.push(`${docLabel(d.doc)}: the plan writes it, today wrote no row for it`);
      continue;
    }
    claimed.add(hit.id);
    rowOfDoc.set(d, hit);
  }
  for (const r of newRows) {
    if (!claimed.has(r.id)) out.push(`new line ${r.id} (statement ${r.statement_id}, key ${r.dedupe_key}): today wrote it, the plan skips every line it could be`);
  }
  for (const [d, r] of rowOfDoc) {
    const expected = d.outcome as { row: "new" | FileRowRef };
    const owner = r.flow_id != null && !s.newFlows.has(r.flow_id) ? ownerOfFlow.get(r.flow_id) ?? null : null;
    const want = expected.row === "new" ? null : expected.row;
    if (!sameRow(owner, want)) {
      out.push(
        `${docLabel(d.doc)} (line ${r.id}): today ends on ${owner ? `the flow of ${rowLabel(owner)}` : "a new flow"}, ` +
          `the plan says ${want ? `the flow of ${rowLabel(want)}` : "a new flow"}`
      );
    }
  }

  // Rows on file.
  const flowOnRow = new Map<number, number>();
  for (const l of s.after.values()) if (l.flow_id != null && s.flowsAlive.has(l.flow_id)) flowOnRow.set(l.flow_id, l.id);
  const flowOnAnnulment = new Set(
    [...s.annulmentsAfter.values()].map((a) => a.flow_id).filter((f): f is number => f != null && s.flowsAlive.has(f))
  );
  for (const { row, fate } of plan.today.rows) {
    const flowBefore = row.kind === "line" ? s.before.get(row.id)?.flow_id ?? null : s.annulmentsBefore.get(row.id)?.flow_id ?? null;
    let real: typeof fate;
    if (row.kind === "line" && s.after.has(row.id) && !s.newLines.has(row.id)) {
      real = s.after.get(row.id)!.statement_id === s.before.get(row.id)!.statement_id ? "untouched" : "moved";
    } else if (row.kind === "annulled_purchase" && s.annulmentsAfter.has(row.id) && !s.newAnnulments.has(row.id)) {
      real = "untouched";
    } else if (flowBefore == null || !s.flowsAlive.has(flowBefore)) {
      real = "merged";
    } else if (flowOnRow.has(flowBefore)) {
      real = s.newLines.has(flowOnRow.get(flowBefore)!) ? "on_doc_line" : "merged";
    } else if (flowOnAnnulment.has(flowBefore)) {
      real = "annulled";
    } else {
      real = "retired";
    }
    if (real !== fate) out.push(`${rowLabel(row)}: today ${real}, the plan says ${fate}`);
  }
}
