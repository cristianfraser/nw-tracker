/**
 * Refused: a statement settles its open bucket when it is imported (`importStatementDocuments`,
 * `cards/statementLinePlanApply.ts`) — the bucket lines it bills are restated in place, the others
 * annulled or moved on. This repair settled a month after the fact by deleting the billed bucket
 * lines, which would now delete rows the statement keeps. To re-settle a bucket, send the statement
 * again (`import:cc-parsed -- --full`, or the statement JSON apply): a line the earlier import did
 * not settle is settled by the plan, and a statement already settled writes nothing.
 *
 *   npm run repair:cc-web-paste-pdf-reconcile -w nw-tracker-server -- …   (exits 1)
 */
console.error(
  "repair-cc-web-paste-pdf-reconcile: refused — a statement import settles its bucket in place; " +
    "re-send the statement (import:cc-parsed -- --full, or the statement JSON apply) instead."
);
process.exit(1);
