import fs from "node:fs";

/** A shared case table under `server/contracts/data/` (asserted by every language that implements the rule). */
export function readCaseFile<T>(name: string): T {
  return JSON.parse(fs.readFileSync(new URL(`../../data/${name}`, import.meta.url), "utf8")) as T;
}
