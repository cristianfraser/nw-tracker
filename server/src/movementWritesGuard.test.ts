import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `movementWrites.ts` is the one writer of the `movements` table (docs/untangle-plan.md F11): an
 * INSERT, UPDATE or DELETE on it anywhere else in runtime code fails here. Migration hooks keep
 * their frozen SQL and test fixtures write their own rows.
 */
const SRC = path.dirname(fileURLToPath(import.meta.url));
const WRITES = /\b(INSERT\s+(OR\s+[A-Z]+\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+movements\b/;
const FUNNEL = "movementWrites.ts";

function* runtimeFiles(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "test" && e.name !== "migrationHooks") yield* runtimeFiles(p);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
      yield p;
    }
  }
}

describe("movements are written through the funnel", () => {
  const writers = [...runtimeFiles(SRC)]
    .filter((f) => WRITES.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
    .sort();

  it("no runtime file but the funnel writes the table", () => {
    expect(writers.filter((f) => f !== FUNNEL)).toEqual([]);
  });

  it("the funnel still does (the pattern finds its statements)", () => {
    expect(writers).toContain(FUNNEL);
  });
});
