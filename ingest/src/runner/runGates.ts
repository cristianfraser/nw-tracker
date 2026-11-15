import { parseEnvFlag } from "nw-tracker-contracts";

/**
 * The switches the service's environment sets for every run (the installed LaunchAgent plist):
 * a dry run, and which steps may write. Read by the one flag rule (`parseEnvFlag`: `1/true/yes`
 * on, `0/false/no` off, unset off; anything else throws naming the variable), once, when the
 * service starts — a mistyped gate stops the service instead of making every run report-only.
 */
export const RUN_GATE_VARS = {
  dryRun: "INGEST_RUN_DRY",
  fintualApply: "NW_TRACKER_FINTUAL_APPLY",
  racionalApply: "NW_TRACKER_RACIONAL_APPLY",
  statementJsonApply: "NW_TRACKER_STATEMENT_JSON_APPLY",
  fullReimport: "NW_TRACKER_FULL_REIMPORT",
  afpUnoApply: "NW_TRACKER_AFP_UNO_APPLY",
  afcApply: "NW_TRACKER_AFC_APPLY",
} as const;

export type RunGates = Record<keyof typeof RUN_GATE_VARS, boolean>;

export function readRunGates(env: NodeJS.ProcessEnv = process.env): RunGates {
  const gates = {} as RunGates;
  for (const [gate, name] of Object.entries(RUN_GATE_VARS) as [keyof RunGates, string][]) {
    gates[gate] = parseEnvFlag(name, env[name]) ?? false;
  }
  return gates;
}
