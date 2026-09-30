import type { BankName } from "./config.js";

/**
 * Named steps, so a run can be narrowed to just the one being worked on.
 *
 * Every request costs reputation with these banks, so re-testing a single failing path should not
 * re-fetch everything that already works.
 */
export const STEP_NAMES: Record<BankName, readonly string[]> = {
  // The monthly cartola PDF and the statement PDF both come from Gmail now
  // (`fetch:santander-docs`); the web session is scoped to daily movements plus the facturación
  // JSON that `card-statements` reads.
  santander: ["card-movements", "checking-movements", "card-statements"],
  racional: ["movements", "positions"],
} as const;

/** Empty selection means "run everything". */
export function shouldRunStep(only: string[], name: string): boolean {
  return only.length === 0 || only.includes(name);
}

/** Reject unknown step names loudly — a typo would otherwise silently run nothing. */
export function assertValidSteps(bank: BankName, only: string[]): void {
  const valid = STEP_NAMES[bank];
  const unknown = only.filter((name) => !valid.includes(name));
  if (unknown.length > 0) {
    throw new Error(`Unknown step${unknown.length > 1 ? "s" : ""} for ${bank}: ${unknown.join(", ")}. Valid: ${valid.join(", ")}.`);
  }
}
