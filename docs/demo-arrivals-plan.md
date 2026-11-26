# Demo arrivals: new expenses land while a visitor watches

Goal: when a visitor wakes the hosted demo, 1–3 new card expenses arrive over the next couple of
minutes, so the dashboard shows what a bank feed delivering movements looks like. Demo only; the
personal instance never loads it.

## What was checked (2026-11-26)

1. **«Read-only» is an HTTP rule.** `demoReadOnlyMiddleware` refuses visitor writes; the server
   writes the demo DB itself already (generated ingest history, the pristine restore). A server-side
   insert needs no change to the write policy.
2. **An open tab does not notice a data change today.** The only push-like channel is the 5 s stamp
   poll (`GET /api/live-quotes/stamp`, `useLiveQuotesStampInvalidation`), published only on live
   price moves. A move `{ all: true }` makes every query refetch (`queryReadsMovedPrice`), which is
   what an arrival needs: `noteLiveQuotesChanged(at, { all: true })` after the write. No client
   change. The home «latest movements» table already animates rows it has not seen
   (`LatestMovementsTable`, `animateArrivals`, `arrival_key`).
3. **A one-line listing is safe.** The feed mirror (which treats a listing as complete) lives in the
   feed apply, not in `insertLines`. Receipts and manual payments already plant single lines with
   `importCcListingLines(cardId, { lines: [line], errors: [] }, kind)`; the generator writes the open
   cycle the same way (`cc_web_paste`). The card-line funnel does the rest: dedupe, valuations and
   today's stamp, billing recompute, change log (caches drop on the next read).
4. **The cupo check is not disturbed.** A capture is judged once, when recorded; the generated ones
   end last night. Arrivals write no capture, so no «bank differs from the app» verdict appears.
5. **Duplicates.** A one-shot's key is merchant | amount | date; the draw never repeats a merchant
   the card already has today.
6. **Cleanup exists.** `demoWritable.ts` restores the DB from the pristine copy once idle 30 min or
   after 04:00 Chile, when something was written. Arrivals mark the DB written, so they never
   accumulate past a visit and the generated story stays intact.
7. **The trigger exists.** `onDemoMarketWake` (`demoMarketActivity.ts`) fires on a real visitor's
   first request after 30 idle minutes (bots never), which covers a cold start too.

## Design

New module `server/src/demoArrivals.ts`, started from `index.ts` beside `startDemoResetScheduler()`.

- **Trigger:** `onDemoMarketWake`. One batch per wake; none while a batch is pending; at most
  `DEMO_ARRIVAL_BATCHES_PER_DAY` (6) per Chile day (in-memory counter, like the write quota).
- **Batch:** 1–3 arrivals; the first 20–40 s after the wake, the next ones 30–60 s apart (unref'd
  timers). Drawn from `rng.ts` seeded by Chile day + batch number of the day.
- **Which card and what:** read from the database, not from the simulator, so it follows whatever
  story is generated:
  - card = the credit-card master that still bills with the most one-shot purchase lines in the
    last 60 days, whatever its issuer (for `DEMO_PERSON` the US card, whose issuer has no unbilled
    listing: the line is what a hand paste of the bank's page adds, and opens its next facturación);
  - candidates = its one-shot purchases of the last 120 days (stored kind = purchase, positive, no
    cuotas, read through `cards/purchases.ts`), grouped by merchant; left out: merchants that bill
    the same amount in two or more months (subscriptions), merchants that bill exactly once a month
    in three or more months (bills whose amount moves: a phone plan, a dividendo), merchants a
    declared recurring payment matches, merchants already on the card today;
  - amount = one of that merchant's past amounts × a factor in 0,8–1,2, rounded to the currency's
    coin; currency = the line's own; date = the Chile day.
  Category, vendor name and payment name follow from the existing merchant rules.
- **Write:** wait for `whenNoApiRequestsInFlight()` (requests go first), then one
  `importCcListingLines` call per arrival (`cc_web_paste`), `markDemoWritten()` (new export of
  `demoWritable.ts`, replacing the test-only marker) and `noteLiveQuotesChanged(now, { all: true })`.
- **Failure:** this is an optional show, so an arrival that finds no candidate, is skipped as a
  duplicate or throws is logged and dropped; it never takes the process down and never retries.
- **Shared database:** every visitor sees the same arrivals until the restore, as with visitor edits.

Pure parts (the schedule decision, the candidate filter, the draw) are separate functions with
tests; one integration test runs an arrival on the Vitest person and checks the line is in the open
bucket, shows in the expense lines, marks the DB written and publishes the stamp.

## Not in this change

- An `ingest_runs` / notification record for the arrival (the import-sync page would show a poll
  that brought it). The generated history is Santander/BCI-shaped and the card the story spends on
  today is the US one, which has no feed; it needs its own design.
- Checking-account arrivals (debits), an About/tour mention.
- A deploy older than a card's close: an arrival dated after an unstatemented close files into the
  next cycle with a provisional close, as the real app does. Accepted.

## Open: the write blocks the event loop

Measured 2026-11-26 on a laptop with the demo person: one arrival's write takes 0,4–0,5 s (one
outlier of 2,3 s while pages were loading), about 80 % of it the expense-link sync every card write
runs (`requestExpenseLinkSync` → `syncExpenseLinksNow`, which rebuilds the expense lines). By the
demo's ~9× factor that is 3–5 s on Render, close to the 5 s health check, up to three times per
wake. A visitor's card edit costs the same today. Each arrival logs its ms: read them on Render
after the first release; if they are too long, deliver one arrival per wake or make the sync
cheaper for a write that cannot change a deposit link.

## Rehearsal

`server-demo` / `client-demo` (`.claude/launch.json`): open the dashboard, wait ~30 s, see a row
animate into «latest movements» and the card's owed move; 30 idle minutes later the DB is back to
the generated state.
