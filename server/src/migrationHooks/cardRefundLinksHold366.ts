import type { Database as DatabaseType } from "better-sqlite3";
import { installFlowRetireDeleteTriggers } from "./flowRetirement290.js";

/**
 * Migration 366 hook: the flow delete triggers count a card refund link (either end) as holding its
 * flow. Pure (no `db` import — the module graph is still initializing).
 */
export function runCardRefundLinksHold366(dbi: DatabaseType): void {
  installFlowRetireDeleteTriggers(dbi, { refundLinks: true });
}
