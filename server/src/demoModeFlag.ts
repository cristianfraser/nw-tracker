/**
 * Hosted recruiter-demo mode (`DEMO_MODE=1`). A leaf module (no imports) so low-level modules —
 * the sync status, the schedulers — can ask without importing the demo bootstrap (`demoMode.ts`).
 */
export function demoModeEnabled(): boolean {
  return process.env.DEMO_MODE === "1";
}
