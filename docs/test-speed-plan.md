# Faster local tests — plan

## Status (2026-11-20): done, branch `worktree-test-speed`

Before/after timings come from the home server (4 cores / 8 threads, otherwise idle), plus the
laptop (10 cores: 4 performance, 6 efficiency) once no other session was running tests. Every
run has the same 580 files and 3 893 tests.

| | Before | After |
|---|---|---|
| Server suite, home server | 1 220 / 1 214 s (serial) | 405 / 401 s (4 forks, the default there); 415 s at 6, 409 s at 8 |
| `npm run test` (server), home server | ~1 280 s (typecheck 64 s, then the serial suite) | 403 s |
| Server suite, laptop | ~900 s serial (sum of per-file times, measured under load) | 72 / 80 s (10 forks, the default); 95 s at 4 |
| `npm run test` (server), laptop | typecheck, then the serial suite | 90 s (both concurrently) |
| Typecheck, home server, serial (contracts / server / client / ingest) | 5,4 / 27,1 / 22,6 / 8,6 s (TS 5.9) | 4,0 / 6,5 / 4,5 / 3,3 s (TS 7.0.2, including npm) |
| Typecheck, laptop, warm | 1 / 6 / 5 / 1 s | 0,6 / 1,5 / 1,5 / 1,0 s |
| Pre-push hook, all four workspaces | (none) | 6,3 s, laptop under full load |

What the measurements showed:

- Serial time was mostly per-file overhead. The tests inside the files summed to only 224 s of
  the 1 220 s; the other ~1 000 s (about 1,7 s per file) went to starting a fresh process and
  loading modules and setup. Parallel forks spread that cost over the cores. `isolate: false`
  would remove it, and it is the next lever (see «Not doing»).
- Above the physical core count, forks only stretch single tests. At 6 or 8 forks on the
  server, three tests that take ~4 s serially there passed Vitest's 5 s limit. They were made
  fast (one of them was real waste in the deposits reconciliation), and the default is now one
  fork per physical core.
- Shuffled order found no file depending on another's leftovers (five seeds green). The one
  bug it surfaced was date-dependent: two card tests put both closes in one billing month
  whenever `TODAY − 50` is the 1st of a 31-day month.
- TypeScript 7.0.2 reports byte-identical diagnostics to 5.9.3 (clean tree, plus 8 seeded
  errors of 7 kinds). It is installed as the `typescript-7` alias and called only through
  `scripts/tsc.mjs`; 5.9 stays because typescript-eslint needs its classic API.

Goal: cut the wall time of `cd server && npm run test` (and the other workspaces' test runs)
without hiding a single failure. No retries, no wider timeouts, no skipped tests: a test that
needs a retry has a bug, and that bug gets fixed.

## Where the time goes today (2026-11-20)

- **Server Vitest runs 579 files strictly one at a time** (`server/vitest.config.ts`:
  `pool: "forks"`, `maxForks: 1`, `fileParallelism: false`) on a 10-core machine. The reason
  is real: every fork opens the same SQLite file, and parallel forks race the migrations and
  each other's fixtures. ~346 files touch the database.
- **The test DB keeps growing.** `server/data/nw-tracker.test.db` is reused run after run and
  now weighs 330 MB; a freshly generated one is ~3,4 MB. `globalSetup` already empties the
  change log for that reason.
- **`npm run test` typechecks first, serially.** `tsc --noEmit` (measured, warm): contracts 1 s,
  server 6 s, client 5 s, ingest 1 s; `check:conventions` 1 s. Small next to the suite, but it
  delays the first test on every run.
- **No git hooks** exist; typecheck + conventions before a push rely on agents following
  AGENTS.md.

Nothing above has been measured for the suite itself yet — step 0 does that.

## Step 0 — baseline (no code change)

- Run the server suite three times with the JSON reporter
  (`npm run test -- --reporter=json --outputFile=…` into the scratchpad) and record wall time
  plus per-file duration. Keep the ten slowest files and the per-file distribution.
- Same for client, ingest and contracts (`npm run test -w …`), which already run in parallel.
- Make sure no other session is running the server suite meanwhile (one shared test DB).
- These numbers are the "before" column of every later commit.

## Step 1 — shuffle to flush order dependencies (prerequisite for step 2)

Parallel workers change which files share a DB and in what order, so any hidden
file-to-file dependency turns into flakiness. Find them while the run is still serial.

- Add a `test:shuffle` script: `vitest run --sequence.shuffle.files --sequence.seed=<n>`
  (files only; tests inside a file keep their order). The seed is printed so a failure is
  reproducible.
- Run it ~5 times with different seeds. Collect:
  - failures that pass in the default order → order dependencies;
  - the `[vitest.setup] … changed … of accounts it did not create` and `… left card lines or
    movements …` warnings → files leaking state into the shared DB.
- Fix each at the source (the file creates and removes its own fixtures; GUIDELINES.md
  «Tests create their own synthetic fixtures»). One commit per root cause.
- Done when 5 shuffled runs in a row are green with no leak warnings. Then make shuffled
  order the default (`sequence.shuffle: { files: true }`) so new dependencies surface at once.

## Step 2 — one database per worker, then parallel forks (the big one)

Keep forks (worker threads crash better-sqlite3); give each fork its own DB file so they no
longer share anything.

1. **Pristine base, cloned per run.** `vitest.globalSetup.ts` keeps generating
   `nw-tracker.test.db` when missing, but the base is no longer written by tests: each run
   clones it to `nw-tracker.test.w<N>.db` for N = 1…maxForks (+ deletes stale `-wal`/`-shm`).
   Use `fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE)` — APFS clones are instant
   and copy-on-write, so N copies cost nothing up front. Checkpoint the base's WAL first.
   Side effect: every run starts from the generated state, so the 330 MB growth and the
   change-log trimming go away (regenerate the base once when this lands).
2. **Point each fork at its copy before `db.ts` loads.** A new first entry in `setupFiles`
   (e.g. `src/vitest.workerDb.ts`) sets
   `process.env.NW_TRACKER_TEST_DB = \`nw-tracker.test.w${process.env.VITEST_POOL_ID}.db\``
   and throws if `VITEST_POOL_ID` is missing. It must stay ahead of `vitest.setup.ts`, which
   imports `db.js`. Child processes a test spawns inherit the worker's copy.
   `db.ts`'s refusal to open the real DB under Vitest is unchanged.
3. **Turn parallelism on:** `fileParallelism: true`, `maxForks` from a measured sweep
   (try 4, 6, 8 on 10 cores — SQLite work is CPU and I/O bound, so the best value is below
   the core count). `minForks` = `maxForks`.
4. **Escape hatch stays:** `NW_TRACKER_TEST_DB` set in the shell (e.g. a dev-DB copy with
   `NW_TRACKER_TEST_FROM_DEV=1`, or `:memory:`) still wins and forces one fork, since one file
   cannot be shared.
5. Update the comment in `vitest.config.ts`, CLAUDE.md's warning and AGENTS.md «Server Vitest
   (SQLite)» (worker copies, the base is read-only to tests, how to rebuild it).

Known parallel hazards checked: HTTP tests already `listen(0)` (no port clash); tests that
mutate `process.env` are per-fork; fixed-path file writes in tests — none found outside
`mkdtemp`/`tmpdir`. Re-check the three tests that mention `cfraser/` paths.

Expected result: roughly the suite time divided by the fork count, minus the slowest single
file (which becomes the floor). The step 0 per-file list says whether one file needs splitting.

## Step 3 — typecheck beside the tests, not before them

- `server`/`client` `test` scripts: run `tsc --noEmit` and `vitest run` concurrently and fail
  if either fails (a small `scripts/run-parallel.mjs`, or two background jobs + `wait` in the
  script). `npm run test` stays the single full gate CLAUDE.md names.
- Add `test:vitest` (Vitest only, same env) for the inner loop.
- **TypeScript 7 native (`tsgo`) — measure, don't assume.** Warm `tsc` totals ~13 s serial,
  ~6 s when the four workspaces run in parallel, so the gain is small. Run `tsgo --noEmit` beside
  `tsc` on each workspace; adopt only if it is faster *and* reports exactly the same
  diagnostics on the tree (seed a few deliberate type errors to compare). List anything it
  misses in the commit.

## Step 4 — run only what the edit reaches, while iterating

- Add `test:related` (server and client): `vitest related <files…> --run`, and document
  `vitest --changed` (against the working tree / `origin/main`).
- **This narrows feedback only, never replaces the full run.** The import graph does not see
  migrations (`.sql` loaded by `db.ts`), the schema baseline, the demo-data generator or JSON
  fixtures; a change there reaches every DB test. AGENTS.md says so, and the full
  `npm run test` stays the rule before committing.
- Prove it: make a real change in a module only reached through a migration or fixture,
  confirm `test:related` misses it and the full run goes red — that is the documented limit.

## Step 5 — a pre-push hook (a hook, because agents skip steps)

- Tracked `.githooks/pre-push`, enabled with `git config core.hooksPath .githooks`
  (worktrees share it). Set it from the root `prepare` script so a fresh clone gets it;
  harmless on the home server's `npm ci` (it never pushes).
- Contents, on the files changed vs the push's remote ref:
  - typecheck only the affected workspaces (a `server/contracts` change → all four), in
    parallel;
  - `npm run check:conventions` (1 s, whole repo — keeps the deps baseline honest).
  - No format or lint step: the repo has neither (no Prettier, no lint script).
- Budget: under 9 s warm; the hook fails if a step exceeds it, so it stays cheap.
  It does not run the test suite.
- AGENTS.md: `--no-verify` is not allowed for agents.

## Not doing

- `isolate: false` (reuse loaded modules across files): the server keeps module-level state
  (`ccCardRegistry` read on import, `initServerConfig` once, the cache registry). Revisit only
  if step 2's numbers leave module loading as the main cost, and only with written reset rules.
  **Measured afterwards:** they do. About 1,7 s of each file's time is process start plus module
  load, against 0,4 s of tests, so this is the next lever. It is its own change.
- bun, oxlint, oxfmt, Blacksmith, CI caches, merge queue, cross-machine shards: no hosted CI,
  native better-sqlite3, deploy built on `npm ci`.

## Order and commits

0 → 1 → 2 must go in that order. 3, 4 and 5 are independent of each other and of 2.
One small commit per change, each with before/after numbers from step 0's method.
