/**
 * The moments the sources give the rows of «Últimos movimientos» (`latestMovementOrder.ts` says
 * how they combine). Read when the list is built, for the rows of the days it shows only:
 *
 * - stated, best first: the flow's own document (`flow_event_times`), the processor receipt paired
 *   with the line (`payment_receipt.paid_at_chile`, never a guessed one), the grocery receipt paired
 *   with the card line (its printed time; `groceryReceiptCardCharges.ts`);
 * - upper bounds: the write stamp (`flow_first_seen`), the transfer mail paired with the movement
 *   side (`movement_transfer_notices`), a broker mail's time (`movement_event_times`).
 *
 * Pairings decided at read (receipts) are read here the same way the lines read them, never stored.
 */
import { db } from "./db.js";
import { chileWallTimeToInstant } from "./chileDate.js";
import { flowWriteStampsByFlowId } from "./flows/flowFirstSeen.js";
import { flowEventTimeMsByFlowId } from "./flows/flowEventTimes.js";
import { movementEventTimesMs } from "./movementEventTimes.js";
import { groceryReceiptTimeByCardLine } from "./groceryReceiptCardCharges.js";
import type { LatestRowRef, LatestRowTimes } from "./latestMovementOrder.js";

/** A Chile wall time the sources print («YYYY-MM-DD HH:MM[:SS]»), in epoch ms; null for a bare day. */
function wallMs(wall: string | null | undefined): number | null {
  if (!wall || !/[ T]\d{2}:\d{2}/.test(wall)) return null;
  return chileWallTimeToInstant(wall).getTime();
}

export function latestRowTimes(refs: readonly LatestRowRef[]): LatestRowTimes[] {
  const stamps = flowWriteStampsByFlowId();
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
  const flowOfMovement = db.prepare(`SELECT flow_id FROM movements WHERE id = ?`);
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
    if (ref.kind === "none") return { stated: [], bounds: [], seq: null };
    const flowId =
      ref.kind === "line"
        ? ref.line.flow_id ?? null
        : ((flowOfMovement.get(ref.movementId) as { flow_id: number | null } | undefined)?.flow_id ?? null);
    const stated: number[] = [];
    const bounds: number[] = [];
    const stamp = flowId === null ? undefined : stamps.get(flowId);
    if (stamp) bounds.push(stamp.atMs);
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
    return { stated, bounds, seq: stamp?.seq ?? null };
  });
}
