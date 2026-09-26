/**
 * Exit 0 (and record the attempt) when the hourly poll should retry the Santander fetch, 1 when
 * not — see `santander/catchUp.ts`. The shell needs an exit code; the reason is printed either way.
 */
import { recordCatchUpAttempt, santanderCatchUpDecision } from "./santander/catchUp.js";

const decision = santanderCatchUpDecision();
if (decision.due) {
  // Recorded before the fetch runs: a catch-up that fails still used the slot's one retry.
  recordCatchUpAttempt();
  console.log(`catch-up due — ${decision.reason}`);
  process.exit(0);
}
console.log(`no catch-up — ${decision.reason}`);
process.exit(1);
