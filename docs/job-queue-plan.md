# Job queue plan

Status: proposed (2026-10-30). Replaces the fixed time windows in `scripts/server-deploy.sh` and
the slot bookkeeping in `ingest_runs` with one durable queue that every long-running job goes
through.

## Why

The primary instance runs on an always-on home server, deployed from GitHub `main`
(AGENTS.md, «The primary runs on a home server…»). Three kinds of work now compete for it, and
each coordinates with the others by a different trick:

| Work | Started by | Today's coordination |
| --- | --- | --- |
| Nightly / hourly ingest runs | `ingestRunScheduler.ts` (30 s tick) | `ingest_runs` row per slot; `decideIngestRun` waits while one is `requested`; the ingest service answers 409 busy |
| Manual «Run now» | import sync page | refused while a run is in flight |
| Deploys | `com.user.nw-tracker-deploy` (every 3 min) | clock windows (21:40–22:30, :25–:36) plus a poll of the run status |
| Lost-run cleanup | the scheduler tick | fixed timeouts (3 h nightly, 90 min hourly) |

What goes wrong with that:

- A deploy waits on a clock, not on the work: it sits idle through a window in which nothing runs,
  and the windows are guesses about how long a run takes.
- A slot the service could not take is dropped (the hourly is «given up»), so a deploy or a
  restart at :30 loses that hour's poll.
- Each new kind of exclusive work (a database repair, a re-import, a long backfill) would need
  its own trick.
- There is no single place that says what is running, what is waiting and why.

## Goal

One SQLite-backed queue in the primary server. Every job is a row; producers enqueue, a single
executor in the server decides what may start, and workers (the ingest service, the deploy agent,
the server itself) claim, heartbeat and complete jobs. Exclusion is declared per job as the
resources it needs, not as time windows. A job that cannot start yet waits and runs late; it is
never silently dropped.

Non-goals: moving the in-process market syncs (global sync, live quotes, backups, cache warm)
into the queue in the first phases — they are short, idempotent and already self-scheduling.
They join only where they conflict (see «Resources»).

## Model

### Table `jobs`

| Column | Meaning |
| --- | --- |
| `id` | primary key |
| `kind` | `ingest.nightly`, `ingest.hourly`, `deploy`, `maintenance.script`, … |
| `dedupe_key` | unique while not finished: `ingest.hourly|<slot>`, `deploy` (one pending deploy at a time) |
| `payload_json` | kind-specific request (an ingest run's `IngestRunRequest` extras, a deploy's target sha) |
| `status` | `queued` → `running` → `done` / `failed`; also `cancelled`, `superseded`, `lost` |
| `priority` | integer; higher first (deploy > nightly > hourly > maintenance) |
| `not_before` | earliest start (a slot time, a retry backoff) |
| `stale_after` | after this the job is superseded instead of run (an hourly older than the next slot) |
| `resources_json` | what it holds while running (see below) |
| `worker` | who claimed it (`ingest-service`, `deploy-agent`, `server`) |
| `claimed_at`, `heartbeat_at`, `lease_ms` | a running job whose heartbeat is older than its lease is `lost` |
| `attempt`, `max_attempts` | retry policy per kind |
| `enqueued_by`, `reason` | `scheduler: 22:00 slot`, `manual: import sync page`, `deploy-agent: origin/main a1b2c3d4` |
| `result_json`, `error` | the completion report (an ingest run's steps, a deploy's from/to sha) |
| `created_at`, `started_at`, `finished_at` | instants, ISO UTC |

`ingest_runs` keeps its kind-specific columns (Santander request/outcome/state, steps) as a detail
table keyed by `job_id`, so the Santander catch-up and payday rules, `lastDailyRunAt` and the
import sync page keep reading what they read today.

### Resources

A job lists the resources it needs; the executor starts it only when none is held by a running
job. Initial set:

- `ingest-service` — the service runs one run at a time (today's 409 busy).
- `bank:santander`, `bank:afp-uno`, `bank:afc`, … — one login session per institution; lets a
  future manual «fetch Santander only» job run next to an e-mail-only job.
- `server-restart` — exclusive: a job holding it needs every other job idle (a deploy). The
  executor starts nothing else while it is held and grants it only when nothing else runs.
- `db-maintenance` — a repair script that rewrites history; conflicts with ingest jobs and
  deploys, not with reads.

### Coalescing

Enqueuing a job whose `dedupe_key` is already queued updates that row instead of adding one: a
second push while a deploy waits moves its target sha (only the newest commit deploys); an hourly
poll queued behind a deploy absorbs the next slot (`stale_after` = the next slot, then it is
`superseded` by the newer one). A running job is never modified.

## Who does what

- **Producers** enqueue only:
  - the ingest scheduler (`decideIngestRun` keeps deciding *which slot is due*; instead of calling
    the service it enqueues `ingest.<kind>` with `not_before` = the slot and the request extras
    computed at start time, not at enqueue time — the Santander rules read the state when the job
    starts);
  - «Run now» on the import sync page (`enqueued_by = manual`, `not_before = now`);
  - the deploy agent (`POST /api/jobs` `{kind: deploy, sha}` when `origin/main` moved);
  - `npm run job -- <kind> …` for maintenance scripts that must not overlap ingest runs.
- **Executor** (in the server, replaces `ingestSchedulerTick`'s dispatch): every tick and on every
  enqueue/complete, `pickNextJobs(queue, running, now)` — a pure function, unit-tested like
  `decideIngestRun` — returns the jobs that may start; the executor marks them `running` and
  dispatches. Expired leases become `lost` (and retry when the kind allows).
- **Workers**:
  - *ingest service* — receives the job as today (`POST /runs`, same contract plus `job_id`),
    heartbeats `POST /api/jobs/<id>/heartbeat` every minute, completes with today's report;
  - *deploy agent* — no longer decides when: it enqueues, then long-polls
    `POST /api/jobs/claim?kind=deploy`; the claim is granted when `server-restart` can be held.
    It deploys, restarts the server, and completes the job after `/api/health` reports the new
    commit. The executor that comes back after the restart finds the deploy `running` with a
    live lease and keeps everything else waiting until the agent completes it (or the lease
    expires — then the job is `lost`, a notification is raised, and the queue resumes);
  - *server* — maintenance jobs that are server code (a repair task) run in-process.

## Restart and crash safety

- Everything is in SQLite, so a restart loses nothing: queued jobs wait, running jobs keep their
  lease. Workers that outlive a server restart (the ingest service, the deploy agent) keep
  heartbeating against the new process; the existing report retry (`reportWithRetry`) covers the
  gap.
- A job is started at most once per attempt: claim is a single `UPDATE … WHERE status = 'queued'`
  in an IMMEDIATE transaction; the ingest service keeps its `ran` set (run ids it already ran).
- Lost-run detection becomes «no heartbeat for `lease_ms`» (a few minutes) instead of 3 h / 90 min,
  so a killed run frees the queue quickly.

## Visibility

The import sync page's «Corridas de banco y correo» becomes the queue: running (with its
resources and last heartbeat), queued (with why it waits: «waiting for ingest-service, held by
nightly run 812»), recent history; actions «Run now», «Cancel» (queued only) and «Retry» (failed).
`GET /api/jobs` serves it; the client only renders (the server computes the «waiting for» text).

## Phases

1. **Table and executor beside the current scheduler.** Migration: `jobs`, `ingest_runs.job_id`.
   `pickNextJobs` with tests (resources, priority, `not_before`, `stale_after`, coalescing,
   leases). The executor runs in shadow mode: the scheduler still dispatches; the executor logs
   what it would have done. Verify on a copy of the real database replaying a day of slots.
2. **Ingest runs through the queue.** The scheduler enqueues; the executor dispatches to the
   service; heartbeats added to the service; manual runs enqueue. A slot that cannot start waits
   instead of being dropped. `ingest_runs` rows are written by the executor. Retire
   `sweepLostIngestRuns`' fixed timeouts.
3. **Deploys through the queue.** `scripts/server-deploy.sh` enqueues and claims instead of
   checking clock windows and run status; `server-restart` resource; the deploy outcome lands in
   `jobs` (and the app messages, as now). Remove the 21:40–22:30 / :25–:36 windows.
4. **Queue page** on the import sync page.
5. **Maintenance jobs.** `npm run job -- maintenance <script> …` for repair/backfill scripts that
   write history, holding `db-maintenance`; document in AGENTS.md which scripts must go through it.
6. (Optional) **Per-institution resources** so a bank-only retry can run beside an e-mail poll,
   and the in-process syncs take `db-maintenance` when they would conflict.

Each phase ships on its own and keeps the previous behaviour reachable until verified, as the
ingest split did (`docs/ingest-split-plan.md`).

## Open questions

- Should the hourly poll still exist as a clock slot, or become «enqueue when a mail notification
  could have arrived» (an IMAP IDLE watcher)? Out of scope here, but the queue makes it easy.
- How long may a deploy hold `server-restart` before the nightly is late enough to matter? Proposed:
  a deploy claimed less than 10 minutes before 22:00 is deferred until the nightly ends — a
  priority rule in `pickNextJobs`, not a clock window in the script.
- Cancelling a running job: only the ingest service could stop a run safely (between steps);
  phase 4 offers cancel for queued jobs only.
