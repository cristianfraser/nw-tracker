# Plan: split data ingestion out of `server/` into `ingest/`

Status (2026-09-30): **Phase 0 done** (server LaunchAgent installed, `scraper/` → `ingest/`,
`server/contracts`, the `/api/ingest/*` route). **Phase 1 done**: the Santander card feed goes
through `card.unbilled_movements`; decoding lives in `ingest/src/santander/cardFeed.ts`.
**Phase 2 built** (2a: the server's run scheduler, the ingest service, the run protocol; 2b: the
runners in TypeScript, the Santander catch-up / payday decisions and the run recording in the
server), switched on 2026-09-30 22:06 (`ingest/switch-schedule.sh to-server`; `to-launchd`
reverts). **Phase 3 in
progress**: 1. checking «últimos movimientos» xlsx done (`bank_account.movements`, uploads via the
service's `/parse`); 2. Santander payment receipts done (`card.payment_receipt`); 3. broker
e-mails done (`broker.notifications`); 4. Racional crawl done (`broker.movements`).

## Goal

`server/` serves the client, and it also fetches, parses and writes every outside
document. This plan gives those two jobs two packages:

- **`server/`** serves the client and **applies** incoming data to the ledger. It is the
  only process that writes the database.
- **`ingest/`** (today's `scraper/`, renamed) **reads the outside world**: bank web
  sessions, IMAP, PDFs, OCR, spreadsheets. It turns each document into a validated,
  canonical payload and hands it to the server. It never opens the database.

Long term, another user of the app should be able to feed their own data without our
ingest package: they produce payloads in the shape the server defines and post them.

## Where we are today

- `scraper/` already holds the Santander and Racional browser sessions, the IMAP
  fetchers (`src/email/`), the document ledger, `daily-run.sh` / `email-run.sh` and the
  two LaunchAgents (22:00 daily, :30 hourly). It is not an npm workspace (driven with
  `npm --prefix scraper`).
- The parsing lives in `server/`: TS parsers (`ccWebPasteParse`, `brokerEmailParse`,
  `checkingCartolaParse`, `checkingUltimosMovimientosParse`, `santanderStatementParse`,
  `santanderCardMovements`, …) and the Python parsers in `server/scripts/*.py`
  (CC statements, cartolas, payroll, grocery receipts + OCR, the inbox organizer).
- The importers mix parsing with applying. `santanderMovementsImport.ts` pulls in
  billing closes, the feed mirror, cuota-purchase plans, valuation stamps, the bank cupo
  snapshot and cache invalidation; `mergeCcAccountFromParsedRows` is the choke point for
  dedupe, reconcile, source ownership and stamp purging. Those are domain rules that
  need the database — they stay in the server.
- Several processes write the same SQLite file: the running server and every nightly
  `tsx` import script. That is why the server watches `data_version`, why the cache
  warmer exists, and where "database is locked" comes from.
- The primary server runs by hand in a terminal (`npm run dev` = `tsx src/index.ts`, no
  watch). The 22:00 schedule, the wake catch-up, the payday fetch and the repeat-skip
  live in launchd + shell + small check scripts.

## Target architecture

```
                    run request {sources, last applied per source}
   ┌──────────┐  ──────────────────────────────────────────────▶  ┌──────────┐
   │  server  │                    202 {run_id} | busy             │  ingest  │
   │ (only DB │  ◀──────────────────────────────────────────────   │ (no DB)  │
   │  writer) │     POST /api/ingest/<kind>   payload, one per doc │          │
   │          │  ◀──────────────────────────────────────────────   │ browser  │
   │ schedule │     POST /api/ingest/runs/<id>/complete  results   │ IMAP     │
   │ contracts│  ◀──────────────────────────────────────────────   │ PDF/OCR  │
   └──────────┘                                                    └──────────┘
        ▲  imports server/contracts (types, validators, client) ────────┘
```

### Dependency direction

- `ingest` depends on **`server/contracts`** only: payload types, runtime validators,
  a typed API client, and a JSON Schema export so a non-TypeScript feeder can target it.
- `ingest` never imports the rest of `server` (that would pull in better-sqlite3 and the
  domain code, and nothing would stop it writing the DB directly).
- `server` never imports `ingest`. Bank formats are parsed only in `ingest`.
- UI uploads (web paste, checking xlsx, receipt photos): the server forwards the raw
  input to ingest `POST /parse/<kind>`, gets a payload back and applies it. A user
  without our ingest uploads canonical payloads instead.

### Canonical payloads, not bank-shaped ones

A payload says what something **means**, not which bank printed it. Bank decoding moves
into ingest; the server's apply logic keys on generic fields. First sketches (Phase 1
settles the real shapes):

| Today (Santander-specific)            | Canonical payload field                                     |
|---------------------------------------|-------------------------------------------------------------|
| feed rows of the open cycle           | card open-cycle listing: lines `{date, merchant, amount, currency, pending?}` |
| SALDO INICIAL row                     | `observed_close: {date, billed_total per currency}`         |
| «CUOTA COMERCIO» / «PRECIO CONTADO»   | `cuota_purchase: {first_bills: "next_cycle" \| "this_cycle", count?}` |
| stamp-tax row → cuota count           | decoded in ingest into `cuota_purchase.count`               |
| `cruceProductosOnline` cupo rows      | `issuer_stated_balance: {limit, used, available, currency}` |
| statement PDF / statement JSON        | card statement: header totals, close, pay-by, next period, lines |
| checking xlsx / cartola               | account statement or partial listing: rows + printed balances |
| broker mails / crawl                  | brokerage events: trade, dividend `{gross?, withholding?, net}`, cash in/out |

Every payload carries `schema_version`, `feeder_id`, `source` (provenance: which
document, e.g. message id or file sha256) and the account reference in the server's
terms (`import_key` or card last4 routed through the server's registry).

Shared rule data that both sides read today (e.g. `ccStatementLineRules.json` and its
test cases, read by the TS import gate and the Python parser) moves to
`server/contracts`, since the server's gates are the authority and ingest conforms.

### Run protocol (server-owned schedule)

The server's scheduler (the one that already handles due/stale/missed-while-asleep)
owns every ingest trigger: 22:00, a wake after a missed slot, the payday morning fetch,
the hourly mail poll.

1. Server → ingest `POST /runs` with the sources to run and, per source, the last date
   it applied. This replaces `.santander-catchup.json`, `check:santander-catchup`,
   `check:santander-payday-fetch`, `check:daily-run-recent` and the `--scheduled` guard.
2. Ingest answers **202 `{run_id}`** at once (a bank session takes minutes), or
   **`busy`** if a run is in flight (the existing run guard stays).
3. Ingest posts each payload to `POST /api/ingest/<kind>` as it is ready; each response
   is that step's result (applied / duplicate / conflict + message).
4. Ingest posts `POST /api/ingest/runs/<run_id>/complete` with every step's outcome and
   duration. The server records the run (replaces `record:daily-run` /
   `record:email-run`, same `app_messages` titles and notification rules).
5. The server tracks runs it started; a run with no `complete` after a timeout is
   recorded as failed.

"Last applied" is a hint. Ingest keeps its own idempotency ledger (message ids, file
hashes, crawl watermarks) and the server's apply stays idempotent.

Follow-up steps that only exist because of the old script shape run inside the server
after the relevant apply: CC payment-mirror conversion after a card feed, the bank cupo
check after a cupo capture, the Racional nudge retirement.

Manual CLI commands stay in ingest (`npm run fetch:santander -w nw-tracker-ingest`, …)
and post through the same API.

### Access control

Localhost binding is enough for now, with scaffolding to grow:

- Server: `ingestAuth` middleware on `/api/ingest/*`. Today it accepts local
  connections only; it has a place for a bearer token / per-feeder key check.
  Blocked in `DEMO_MODE`. Handlers wrapped in `asyncHandler`.
- Ingest: the same middleware shape on `/runs` and `/parse/*`.
- `.env`: `INGEST_URL`, `SERVER_URL`, optional `INGEST_TOKEN` (unused until a token is
  required). `feeder_id` on every payload from day one.

### Processes

- **Server LaunchAgent** `com.user.nw-tracker-server`: `npm run serve` (tsx, no watch),
  KeepAlive, repo root as working directory (so `.env` loads), absolute Node path
  (launchd does not load nvm), log to `cfraser/server.log`. The busy port stops a second
  copy started by hand, which also keeps a second scheduler off the DB. Restart:
  `nw-server-restart` (alias for `launchctl kickstart -k gui/$(id -u)/com.user.nw-tracker-server`).
  The client keeps running under Vite in a terminal while developing; `SERVE_CLIENT_DIST=1`
  is available to serve the built client from the same process.
- **Ingest LaunchAgent**: one KeepAlive service in the GUI session (Santander blocks
  headless Chrome; the fetcher needs a window server). Replaces the two timed agents
  once Phase 2 lands. Works unchanged if the server later moves to a VPS: the server
  calls the Mac, not a local child process.

## Phases

Each source moves in its own commit. The acceptance check for every move: import the
same staged files through the old path and through the new one, starting from the same
DB snapshot, and compare the resulting databases (byte-parity on the affected tables).

### Phase 0 — plumbing

1. Server LaunchAgent + template plist in the repo + `nw-server-restart` alias.
2. Rename `scraper/` → `ingest/` (package `nw-tracker-ingest`), make it a root workspace.
   Update the LaunchAgent plists, root `package.json` `--prefix` calls, `run-lib.sh`,
   AGENTS.md / PARSERS.md mentions. `cfraser/` paths are unchanged.
3. `server/contracts`: payload envelope (`schema_version`, `feeder_id`, `source`),
   validator, API client, JSON Schema export.
4. `/api/ingest/*` router with `ingestAuth`, fail-fast on unknown kind or version.

### Phase 1 — pilot: Santander card feed

- To ingest: `santanderMovementsByAccount`, cuota-purchase typing and stamp-tax count,
  SALDO INICIAL extraction, cupo-row validation → canonical open-cycle listing +
  observed close + cuota-purchase hints + issuer-stated balance.
- Stays in server: close checks, feed routing, the feed mirror, plan creation, branch
  learning, snapshot writes, valuation re-sync; mirror conversion and cupo check run
  after the apply.
- `daily-run.sh` calls the ingest command instead of `import:santander-movements`.
- Parity check against archived `card-movements-*.json` files.

Left for later phases, noted during Phase 1:
- The payment-mirror conversion and the bank cupo check still run as their own nightly steps
  (`convert:cc-payment-mirrors`, `check:cc-bank-cupo`) rather than inside the server after the
  apply.
- The server still maps a Santander account number to its card through
  `cfraser/organize-identifiers.json`, now on the ingest request path; that mapping belongs in the
  database.

### Phase 2 — server-owned schedule and run protocol

Split in two, both built. **2a:** the server's scheduler decides when (22:00 nightly, missed slots on
wake, the < 60 min repeat skip, the :30 poll), asks the ingest service, which runs the existing
`daily-run.sh` / `email-run.sh` and reports back; `ingest/switch-schedule.sh` swaps it in for the
timed LaunchAgents. **2b:** the two runners in TypeScript (`ingest/src/runner/`, identical command
sequences to the shell scripts), the per-hour Santander decisions (catch-up after a failed nightly
fetch, the payday morning fetch) and the run recording in the server; the feeder reports its bank
facts with every run. The shell runners stay as the `to-launchd` fallback until the switch has run
for a while (Phase 4 deletes them). The original outline:

- Ingest service (HTTP listener, `/runs`, `/parse/*`) as a KeepAlive LaunchAgent.
- Server scheduler triggers runs; run recording moves into the server.
- Retire the timed LaunchAgents, `daily-run.sh` / `email-run.sh` scheduling logic,
  the catch-up / payday / repeat-skip check scripts.

### Phase 3 — remaining sources

In rough order (simplest separation first):

1. Checking «ultimos movimientos» xlsx (`checkingUltimosMovimientosParse`). **Done** —
   `bank_account.movements`; the upload box forwards to the service's `/parse` (the mechanism the
   other upload formats reuse).
2. Santander payment receipts. **Done** — `card.payment_receipt`; the overdue alarm stays a
   server command (`check:synthetic-cc-payments`).
3. Broker e-mails (`brokerEmailParse`) — Fintual and Racional. **Done** — `broker.notifications`;
   the classifier lives in `ingest/src/brokers/`, bookability and the Racional crawl decision in
   the server.
4. Racional crawl + dividends file. **Done** — `broker.movements`; ingest decodes the read and keeps
   its crawl cursor, the server keeps its read coverage (`broker_read_coverage`).
5. Santander statement JSON (`santanderStatementParse`).
6. CC statement PDFs: Python parser, parse cache, per-PDF JSON, organizer, qpdf/OCR →
   ingest; merge import, reconcile gates, traspaso relink stay.
7. Checking and cuenta vista cartolas (Python + TS).
8. Grocery receipts: ingest/OCR/parse → ingest; import + branch learning stay.
9. Payroll liquidaciones.
10. Fintual certificado, Fintual Acciones documents, AFC certificate/cartola.
11. Lider BCI CSV (if still used), web paste (`ccWebPasteParse`, via `/parse`).

### Phase 4 — cleanup

- `import:cfraser-inbox` becomes an ingest command that parses and posts.
- Delete the `server/scripts` entry points that became endpoints; Python parsers and
  `.pdf_deps` live under `ingest/`.
- Parser tests move with the parsers (no DB needed); apply tests stay in the server.
- AGENTS.md / PARSERS.md updated per source as each moves, not at the end.

## Stays in the server

- Market-data syncs (Yahoo quotes and EOD, BCentral, Fintual valor cuota, AFC SP,
  SII IPC): they feed live marks and run on the server's scheduler. Candidate for a later
  phase once the protocol is proven.
- Repair, backfill and one-off scripts: they fix the server's own data.

## Decisions taken (2026-09-30)

1. The server triggers ingest runs (at 22:00, on wake, etc.) with its last-applied
   dates; ingest answers 202 and posts back.
2. Ingest depends on the server's **contracts**, not the whole server package; payloads
   are canonical so other users can feed their own data.
3. Localhost-only access now, with auth scaffolding (`ingestAuth`, `feeder_id`, optional
   token).
4. `scraper/` is renamed `ingest/`.
5. The primary server runs as a LaunchAgent; `nw-server-restart` restarts it.

## Open questions

- Payload transport for large documents (a CC statement's lines, a receipt photo for
  `/parse`): JSON body limits (`express.json` is 2 MB today) vs a staged-file reference
  the server may read. Leaning: JSON for payloads, multipart for raw `/parse` inputs.
- Where a failed apply leaves the document: ingest keeps it staged and retries next run
  (today's behavior), or a server-side quarantine list.
- Whether the web-paste box needs a preview step (parse → show → apply) now that parsing
  is a round trip to ingest.
