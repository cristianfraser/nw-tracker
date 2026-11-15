/**
 * Leaf signal between writers that may make a sync source due (a new watchlist ticker, a forced-stale
 * mark) and the global sync scheduler. The scheduler registers its handler when its module loads;
 * a process that never loads the scheduler (a script) has nothing to wake, so the call does nothing.
 */

let notifier: (() => void) | null = null;

/** Called once by `globalSyncScheduler.ts`. */
export function registerGlobalSyncSchedulerNotifier(fn: () => void): void {
  notifier = fn;
}

/** Call after force-stale or other events that may require immediate polling. */
export function notifyGlobalSyncScheduler(): void {
  notifier?.();
}
