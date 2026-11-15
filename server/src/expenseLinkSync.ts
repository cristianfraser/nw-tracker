/**
 * When the expense deposit links re-sync (docs/untangle-plan.md F11): after the writes that can
 * change them, never while the expense lines are read. A write asks for a sync; inside a
 * {@link withExpenseLinkSyncDeferred} scope (a feed of several cards, a statement corpus, an ingest
 * document) the asks fold into one, run when the outermost scope ends.
 *
 * A leaf on purpose: the movement and card importers ask for a sync, and the sync itself builds
 * the expense lines from what they import, so importing it here would close an import cycle;
 * `expenseAssignmentWrites.ts` registers it instead. Asking with none registered throws.
 */

let sync: (() => void) | null = null;
let deferDepth = 0;
let pending = false;

/** Called once, by `expenseAssignmentWrites.ts` at load. */
export function registerExpenseLinkSync(fn: () => void): void {
  sync = fn;
}

function runSync(): void {
  if (!sync) {
    throw new Error("expense link sync: not loaded — import expenseAssignmentWrites.ts in the process that writes");
  }
  sync();
}

/** A write that can change an expense deposit link asks for a sync: at once, or at the scope's end. */
export function requestExpenseLinkSync(): void {
  if (deferDepth > 0) {
    pending = true;
    return;
  }
  runSync();
}

/** Runs `body` with the syncs it asks for folded into one, run when the outermost scope ends. */
export function withExpenseLinkSyncDeferred<T>(body: () => T): T {
  deferDepth += 1;
  let result: T;
  try {
    result = body();
  } finally {
    deferDepth -= 1;
  }
  if (deferDepth === 0 && pending) {
    pending = false;
    runSync();
  }
  return result;
}
