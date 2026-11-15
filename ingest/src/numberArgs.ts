/**
 * Numbers read from the command line and the environment: a value that is not the number asked
 * for throws, naming where it came from — it is never read as the default.
 */

/** A number ≥ 0 from an environment variable or a `--flag=`; anything else throws, naming it. */
export function parseNonNegativeNumber(name: string, raw: string): number {
  const value = raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name}=${JSON.stringify(raw)}: expected a number ≥ 0`);
  return value;
}

/** A TCP port from an environment variable: unset or empty is `fallback`; anything but 1–65535 throws. */
export function parsePort(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name}=${JSON.stringify(raw)}: expected a port (1–65535)`);
  return value;
}
