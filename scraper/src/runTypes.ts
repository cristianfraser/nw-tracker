export type RunOptions = {
  /** Save every API request/response and a screenshot per step; keep downloads out of the inbox. */
  capture: boolean;
  /** Run off-screen instead of in a visible window. Headless is blocked by Santander — see browser.ts. */
  background: boolean;
  /** Skip statement/cartola downloads (movements only). */
  movementsOnly: boolean;
  /** Minimum minutes since the previous run against this bank. */
  minIntervalMinutes: number;
  /** Run even if the previous run was more recent than the minimum gap, and re-fetch known documents. */
  force: boolean;
  /** Restrict the run to these named steps; empty runs all of them. */
  only: string[];
};

export type StepResult = { name: string; ok: boolean; detail: string; stack?: string };
