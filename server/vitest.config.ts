import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { BASE_TEST_DB, TEST_RUN_ID_ENV, testForkCount } from "./src/test/workerTestDb.js";

const configDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * The default run (`npm run test`, NW_TRACKER_TEST_DB = the base file) gives every fork its own
 * clone of the base DB (`src/test/workerTestDb.ts`) and runs files in parallel. Any other
 * NW_TRACKER_TEST_DB set in the shell (a dev-DB copy, `:memory:`) is one database, so the run
 * falls back to a single fork.
 */
const requestedTestDb = process.env.NW_TRACKER_TEST_DB?.trim() || BASE_TEST_DB;
const perWorkerDb = requestedTestDb === BASE_TEST_DB;
const forks = perWorkerDb ? testForkCount() : 1;

/**
 * Two projects: most files share one module graph per fork (`isolate: false`), so the ~1,7 s of
 * process start and module load each file used to pay is paid once per fork. A file that calls
 * `vi.mock` / `vi.doMock` replaces modules in that graph — a later file in the same fork would get
 * the mock — so those files run in the `isolated` project, a fresh module graph each. Found by
 * scanning the source, so a new mocking file lands there without a list to keep. What a shared
 * file must leave behind (env, timers, spies, registries) is reset by `vitest.setup.ts`.
 */
const TEST_ROOT = path.join(configDir, "src");
const MOCK_CALL = /\bvi\.(?:mock|doMock)\(/;
function testFilesThatMock(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFilesThatMock(full));
    else if (entry.name.endsWith(".test.ts") && MOCK_CALL.test(fs.readFileSync(full, "utf8"))) {
      out.push(path.relative(configDir, full).split(path.sep).join("/"));
    }
  }
  return out.sort();
}
const isolatedFiles = testFilesThatMock(TEST_ROOT);

export default defineConfig({
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: { name: "shared", include: ["src/**/*.test.ts"], exclude: isolatedFiles, poolOptions: { forks: { isolate: false } } },
      },
      // Vitest 3: the root `poolOptions.forks.isolate` (below) decides whether a fork process is
      // reused; a project's own setting decides whether the reused process drops its module graph
      // and mocks before each file. So these files get a fresh graph without a fresh process.
      { extends: true, test: { name: "isolated", include: isolatedFiles, poolOptions: { forks: { isolate: true } } } },
    ],
    /**
     * Forks (process isolation): better-sqlite3 in vitest worker threads segfaults
     * nondeterministically at thread teardown (native bindings + worker_threads).
     * Parallel forks are safe only because each opens its own DB file (see above).
     */
    pool: "forks",
    fileParallelism: forks > 1,
    /**
     * Files run in a random order (tests inside a file keep theirs), so a file that depends on
     * another's leftovers fails fast instead of passing by accident. The seed is printed at the
     * top of the run; reproduce an order with `--sequence.seed=<seed>`.
     */
    sequence: { shuffle: { files: true, tests: false } },
    poolOptions: {
      forks: {
        isolate: false,
        maxForks: forks,
        minForks: forks,
      },
    },
    /**
     * Must be set before `db.ts` loads so Vitest never opens `nw-tracker.db`.
     * `test.env` overrides the process env inside workers, so honor an explicit
     * shell-provided NW_TRACKER_TEST_DB (e.g. running the suite against a dev-DB
     * copy) instead of silently clobbering it. On a per-worker run `vitest.workerDb.ts`
     * then points each fork at its clone.
     */
    env: {
      NW_TRACKER_TEST_DB: requestedTestDb,
      // The config is evaluated in the Vitest host process: its pid names this run's clones.
      ...(perWorkerDb ? { [TEST_RUN_ID_ENV]: String(process.pid) } : {}),
      // Synthetic card registry — tests must never read the personal cfraser/cc-cards.json
      // (ccCardRegistry is read at module eval by ccConsolidatedCards, so set it here).
      NW_TRACKER_CC_CARDS: path.join(configDir, "src", "test", "ccCardsFixture.json"),
    },
    globalSetup: ["src/vitest.globalSetup.ts"],
    /** `vitest.workerDb.ts` picks the fork's DB and must run before anything imports `db.ts`. */
    setupFiles: ["src/vitest.workerDb.ts", "src/vitest.setup.ts"],
  },
});
