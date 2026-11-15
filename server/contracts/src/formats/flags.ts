/**
 * One truthiness rule for every on/off setting read from text — an environment variable of the
 * server or the ingest service, a query parameter: on for `1` / `true` / `yes`, off for `0` /
 * `false` / `no` (case and surrounding space ignored), null when unset or empty; anything else
 * throws, naming the setting. A mistyped gate stops the process (or the request) instead of
 * silently reading as off. Case table: `server/contracts/data/envFlagCases.json`.
 */
export function parseEnvFlag(name: string, raw: string | undefined): boolean | null {
  const v = raw?.trim().toLowerCase();
  if (v === undefined || v === "") return null;
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  throw new Error(`${name}=${JSON.stringify(raw)}: expected 1/true/yes or 0/false/no`);
}
