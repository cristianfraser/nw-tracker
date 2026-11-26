/**
 * The cartola plan against today's import (report only): plans the month, then runs today's
 * import (`importCheckingCartola`, with its daily-row reconcile) inside a transaction that is rolled
 * back, and compares the end states. As for cards (`cards/statementLinePlanCompare.ts`), every bare
 * flow of the account is first held by a probe row (`probeFlows`) inside that
 * transaction, so a deleted row's flow is retired instead of deleted and «gone» is told apart from
 * «merged into another». Writes nothing.
 */
import { db } from "./db.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { importCheckingCartola } from "./checkingCartolaImport.js";
import type { ParsedCheckingCartola } from "./checkingCartolaParse.js";
import { loadCheckingCartolaPlanInput } from "./checkingCartolaPlanLoad.js";
import { planCheckingCartola, type CheckingCartolaPlan } from "./checkingCartolaPlan.js";
import { probeFlows, trackWrites } from "./cards/statementLinePlanCompare.js";

export type CheckingPlanComparison = {
  plan: CheckingCartolaPlan;
  disagreements: string[];
  deviations: string[];
};

class RollBack extends Error {}

type Row = { id: number; note: string | null; occurred_on: string; flow_id: number | null };

function readRows(accountId: number): Map<number, Row> {
  const rows = db.prepare(`SELECT id, note, occurred_on, flow_id FROM movements WHERE account_id = ? ORDER BY id`).all(accountId) as Row[];
  return new Map(rows.map((r) => [r.id, r]));
}

/** Plans `cartola` for `accountId` and compares it with today's import, rolled back. */
export function compareCheckingCartolaImport(accountId: number, cartola: ParsedCheckingCartola): CheckingPlanComparison {
  const input = loadCheckingCartolaPlanInput(accountId, cartola);
  const plan = planCheckingCartola(input);
  const out: string[] = [];
  try {
    db.transaction(() => {
      probeFlows(`SELECT flow_id FROM movements WHERE account_id = ? AND flow_id IS NOT NULL`, [accountId]);
      const before = readRows(accountId);
      const writes = trackWrites(["movements", "flows"]);
      importCheckingCartola(accountId, cartola);
      const written = writes.read();
      const newRows = written.get("movements")!.inserted;
      const newFlows = written.get("flows")!.inserted;
      const after = readRows(accountId);
      const flowsAlive = new Set(
        (db.prepare(`SELECT id FROM flows`).all() as { id: number }[]).map((r) => r.id).filter((id) => !newFlows.has(id))
      );
      const ownerOfFlow = new Map<number, number>();
      for (const r of before.values()) if (r.flow_id != null) ownerOfFlow.set(r.flow_id, r.id);
      const newByNote = new Map<string, Row>();
      for (const r of after.values()) if (newRows.has(r.id) && r.note) newByNote.set(r.note, r);
      for (const m of plan.today.movements) {
        const mv = input.movements[m.movement]!;
        const row = newByNote.get(mv.document_key);
        newByNote.delete(mv.document_key);
        const o = m.outcome;
        if ("row_on_file" in o) {
          if (row) out.push(`movement #${mv.index} (${mv.occurred_on} ${mv.amount_clp}): today wrote row ${row.id}, the plan says row ${o.row_on_file} (${o.why})`);
          continue;
        }
        if (!row) {
          out.push(`movement #${mv.index} (${mv.occurred_on} ${mv.amount_clp}): the plan writes it, today wrote no row`);
          continue;
        }
        const owner = row.flow_id != null && !newFlows.has(row.flow_id) ? ownerOfFlow.get(row.flow_id) ?? null : null;
        const retired = row.flow_id != null && owner == null && o.flow_of != null && "retired_flow_id" in o.flow_of
          ? o.flow_of.retired_flow_id === row.flow_id
          : false;
        const want = o.flow_of == null ? null : "row_id" in o.flow_of ? o.flow_of.row_id : null;
        if (!retired && owner !== want) {
          out.push(`movement #${mv.index} (row ${row.id}): today ends on ${owner != null ? `the flow of row ${owner}` : "a new flow"}, the plan says ${want != null ? `the flow of row ${want}` : o.flow_of ? "a retired flow" : "a new flow"}`);
        }
        if (row.occurred_on !== o.occurred_on) out.push(`movement #${mv.index} (row ${row.id}): today dated ${row.occurred_on}, the plan ${o.occurred_on}`);
      }
      for (const r of newByNote.values()) out.push(`row ${r.id}: today wrote it, the plan writes no row for it`);
      const planned = new Map(plan.today.daily_rows.map((d) => [d.row_id, d.fate]));
      for (const r of before.values()) {
        if (after.has(r.id) && !newRows.has(r.id)) {
          if (planned.has(r.id)) out.push(`row ${r.id}: today keeps it, the plan says ${planned.get(r.id)}`);
          continue;
        }
        const alive = r.flow_id != null && flowsAlive.has(r.flow_id);
        const flowRow = alive ? [...after.values()].find((a) => a.flow_id === r.flow_id) : undefined;
        const real = flowRow ? "on_cartola_row" : alive ? "gone" : "merged";
        if (planned.get(r.id) !== real) out.push(`row ${r.id}: today ${real}, the plan says ${planned.get(r.id) ?? "untouched"}`);
      }
      throw new RollBack();
    })();
  } catch (e) {
    if (!(e instanceof RollBack)) throw e;
  } finally {
    clearAggregationCache();
  }
  const deviations = [
    ...plan.keep.filter((k) => k.today === "differs").map((k) => `keep row ${k.row_id} ↔ movement #${k.movement} (earliest seen): today the flow of another row survives`),
    ...plan.fold.filter((f) => f.today === "differs").map((f) => `fold row ${f.row_id} into row ${f.into_row_id}: today the flow of another row survives`),
  ];
  return { plan, disagreements: out, deviations };
}
