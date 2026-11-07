import { deploymentProfile } from "./config.js";

/**
 * Hosted recruiter-demo mode (`DEMO_MODE=1`), read from the deployment profile (`config.ts`).
 * Prefer the profile's own fields (`disabledSyncSources`, `afpUnoOfficialSource`,
 * `marketAwakeGate`, …) where a module only needs one of them.
 */
export function demoModeEnabled(): boolean {
  return deploymentProfile().demo;
}
