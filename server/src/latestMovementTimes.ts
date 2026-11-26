/**
 * The arrival and moments of the rows of «Últimos movimientos» (`latestMovementOrder.ts` says how
 * they combine), from the database:
 *
 * - write stamps (`flow_first_seen`), by the row's flow;
 * - ingest runs (`ingest_runs`: start → finish; a run with no finish counts for 3 hours);
 * - stated times, best first: the flow's own document (`flow_event_times`), the processor receipt
 *   paired with the line (`payment_receipt.paid_at_chile`, never a guessed one), the grocery receipt
 *   paired with the card line (its printed time; `groceryReceiptCardCharges.ts`);
 * - upper bounds: the transfer mail paired with the movement side (`movement_transfer_notices`), a
 *   broker mail's time (`movement_event_times`).
 *
 * Receipt pairings are decided when read, the same way the lines read them, never stored. Times
 * are resolved only for the rows the list reaches.
 */
import { db } from "./db.js";
import { chileWallTimeToInstant } from "./chileDate.js";
import { flowWriteStampsByFlowId } from "./flows/flowFirstSeen.js";
import { flowEventTimeMsByFlowId } from "./flows/flowEventTimes.js";
import { movementEventTimesMs } from "./movementEventTimes.js";
import { groceryReceiptTimeByCardLine } from "./groceryReceiptCardCharges.js";
import type { ArrivalRun, LatestRowRef, LatestRowSources, LatestRowTimes, LatestWriteStamp } from "./latestMovementOrder.js";

const OPEN_RUN_MS = 3 * 60 * 60 * 1000;

/** A Chile wall time the sources print («YYYY-MM-DD HH:MM[:SS]»), in epoch ms; null for a bare day. */
function wallMs(wall: string | null | undefined): number | null {
  if (!wall || !/[ T]\d{2}:\d{2}/.test(wall)) return null;
  return chileWallTimeToInstant(wall).getTime();
}

function ingestRuns(): ArrivalRun[] {
  const rows = db
    .prepare(
      `SELECT started_at, finished_at FROM ingest_runs
       WHERE started_at IS NOT NULL AND COALESCE(dry_run, 0) = 0 ORDER BY started_at`
    )
    .all() as { started_at: string; finished_at: string | null }[];
  return rows.map((r) => {
    const startedMs = Date.parse(r.started_at);
    const finishedMs = r.finished_at === null ? NaN : Date.parse(r.finished_at);
    return { startedMs, endMs: Number.isFinite(finishedMs) ? finishedMs : startedMs + OPEN_RUN_MS };
  });
}

export function latestRowSources(): LatestRowSources {
  let flowOfMovement: Map<number, number> | null = null;
  const flowOf = (ref: LatestRowRef): number | null => {
    if (ref.kind === "none") return null;
    if (ref.kind === "line") return ref.line.flow_id ?? null;
    flowOfMovement ??= new Map(
      (db.prepare(`SELECT id, flow_id FROM movements WHERE flow_id IS NOT NULL`).all() as { id: number; flow_id: number }[]).map(
        (r) => [r.id, r.flow_id]
      )
    );
    return flowOfMovement.get(ref.movementId) ?? null;
  };
  const stampsByFlow = flowWriteStampsByFlowId();

  return {
    runs: ingestRuns(),
    flows: (refs) => refs.map(flowOf),
    stamps: (refs): (LatestWriteStamp | null)[] =>
      refs.map((ref) => {
        const flowId = flowOf(ref);
        return flowId === null ? null : (stampsByFlow.get(flowId) ?? null);
      }),
    times: (refs): LatestRowTimes[] => {
      const events = flowEventTimeMsByFlowId();
      const mailTimes = movementEventTimesMs();
      const noticeSent = new Map(
        (
          db
            .prepare(
              `SELECT t.movement_id, t.account_id, n.sent_at_chile FROM movement_transfer_notices t
               JOIN bank_transfer_notices n USING (message_id)`
            )
            .all() as { movement_id: number; account_id: number; sent_at_chile: string }[]
        ).map((r) => [`${r.movement_id}|${r.account_id}`, r.sent_at_chile])
      );
      const cardLines = refs.flatMap((r) => (r.kind === "line" && r.line.source === "cc" ? [r.line] : []));
      const receiptTimes = groceryReceiptTimeByCardLine(cardLines);
      const movementBounds = (movementId: number, accountId: number): number[] => {
        const out: number[] = [];
        const sent = wallMs(noticeSent.get(`${movementId}|${accountId}`));
        if (sent !== null) out.push(sent);
        const mail = mailTimes.get(movementId);
        if (mail !== undefined) out.push(mail);
        return out;
      };
      return refs.map((ref): LatestRowTimes => {
        if (ref.kind === "none") return { stated: [], bounds: [] };
        const stated: number[] = [];
        const bounds: number[] = [];
        const flowId = flowOf(ref);
        const event = flowId === null ? undefined : events.get(flowId);
        if (event !== undefined) stated.push(event);
        if (ref.kind === "line") {
          const line = ref.line;
          const receipt = line.payment_receipt;
          if (receipt && !receipt.guess) {
            const paid = wallMs(receipt.paid_at_chile);
            if (paid !== null) stated.push(paid);
          }
          if (line.source === "cc") {
            const printed = wallMs(receiptTimes.get(line.statement_line_id));
            if (printed !== null) stated.push(printed);
          } else if (line.source === "checking") {
            // A checking line is its movement (`statement_line_id`) on its account.
            bounds.push(...movementBounds(line.statement_line_id, line.account_id));
          }
        } else {
          bounds.push(...movementBounds(ref.movementId, ref.accountId));
        }
        return { stated, bounds };
      });
    },
  };
}
