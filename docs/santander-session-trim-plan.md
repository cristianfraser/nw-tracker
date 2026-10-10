# Santander session trim (2026-10-10)

The nightly Santander web session (`npm run fetch:santander`) spends most of its time waiting
for `networkidle`, which never comes: the private site keeps analytics traffic flowing, so every
`settle()` runs to its timeout («network still busy — continuing») — about 58 s of a ~100 s
session on 2026-10-09 (run 268: eight timeouts in the login + card + checking steps alone).
Every wait below is replaced by waiting for the one API call that proves the view loaded, which
the recorder already sees.

## Facts the plan rests on

Verified by the user on the bank site on 2026-10-09:

- Changing cards in the carousel KEEPS the selected Pesos/Dólares tab.
- Changing between «Movimientos por facturar» and «Movimientos facturados» RESETS the tab to Pesos.
- The carousel's arrow no longer advances; a swipe does (`swipeToNextCard`, cards.ts, since
  commit 012acbfb).

Verified by an audit of the importers:

- `cardFeed.ts` groups slides by account and keys closes per currency — slide ORDER is irrelevant.
- The cupo and balance readers take `callsFor(cruceProductosOnline).at(-1)`.
- `statementJson.ts` needs one `estadoCuentaNacional` and one `estadoCuentaInternacional` per
  (account, extracto), named from the call's own INPUT (`Cuenta`, `NumExtracto`).
- `checkingMovements.ts` reads only the xlsx.
- The recorder keeps `openbanking.santander.cl` (the checking `transactions` call) since 2026-10-09.

Last night's timings (run 267, 2026-10-08 22:00, the last full carousel walk; run 268 only
reached the dormant card because the arrow had died):

| step | wall time | of which `settle` timeouts |
|---|---|---|
| login (public page + redirect) | 31 s | 2 × 8 s + a 20 s wait |
| card movements (4 slides) | 22 s | 4 × ~3–8 s (route settle, per-card restore settles, per-slide 4 s) |
| checking movements | 9 s | 8 s (route settle) |
| checking USD capture (run 268) | 9 s | 2 × 2 s |
| card statements (when due) | — | per view: route 8 s + 2 tab settles 4 s + slide settle 4 s |

## Pass A — the steps (this change)

1. **Card step alternates the currency tabs, never restores.** After opening the unbilled
   route the step waits for the first `consultaUltimosMovimientos` call instead of `networkidle`.
   Per card: the slide's call says which currency it is (`Entrada.Moneda`, never assumed), the
   step clicks the OTHER tab (`otherCurrencyTab`, pure, unit-tested) and waits up to 15 s for
   its call («no call — card may have no USD side» stays). No restore click, no settle. Because
   the carousel keeps the tab, the next card opens on the other currency and the order
   alternates (CLP, USD, USD, CLP, …). The (account, currency) dedupe map stays as a safety net;
   it should report «collapsed 0».
2. **Arrow with a 5 s wait, then swipe with the full wait.** The arrow has been dead since
   2026-10-09; when it comes back the short path wins. The `settle(page, 4_000)` after the
   advance is gone: `waitForNewApiCalls` already proves the view loaded.
3. **Checking step waits for the peso `transactions` call and the visible download button**
   (`isPesoTransactionsCall`, pure) instead of `networkidle`; the in-page xlsx capture is
   untouched. `checkingUsd.ts` keeps its navigation skip and its request-body identity check;
   the 2 s settle after each carousel move is dropped (the step already waits for the call).
   Going straight to a remembered slide index was left out: it would need a file across runs
   for one or two carousel moves.
4. **Statements step, same pattern.** Entering «facturados» resets to Pesos and the cards keep
   the tab, so the step reads the currency of the `estadoCuenta…` call that arrived (Nacional =
   Pesos, Internacional = Dólares; `statementCallCurrency`, pure), clicks the other tab once,
   waits for the next `estadoCuenta…` call through the predicate variant of
   `waitForNewApiCalls`, and never restores. Every `estadoCuenta…` call is saved once, named
   from its own INPUT; `readBillingMonth` keeps `allInnerTexts()` (two-`<body>` quirk). The
   page's own PDF request is logged, never waited for.
5. **`waitForNewApiCalls` takes `string | RegExp | predicate`** (`wait.ts`; `matchesApiCall`,
   `countApiCalls` are pure and unit-tested).

Route changes go through `openRoute` (`navigate.ts`): the same hash navigation as
`gotoRoute` without its `settle()`. `gotoRoute` itself stays in `login.ts` for the login path.

## Pass B — pending

The login's own settles (`login.ts`: the public page's 8 s, the post-redirect 8 s and the 20 s
wait at the end of `login`, plus `gotoRoute`'s settle) are a later pass. Run 267 spent ~36 s
of its 31 s login + first route in those waits.

## Verification

Bank sessions authorized by the user, `--force` bypassing the 30-minute guard, one at a time,
at most three:

- Run 1: `fetch:santander --force --background --capture
  --only=card-movements,checking-movements,checking-usd-movements`. Expected: exactly four
  `consultaUltimosMovimientos` calls (CLP/USD × the dormant …2286 and the active …2556, in
  alternating order), «collapsed 0 duplicate currency re-fetches», four slides with the
  accounts/currencies/row counts of
  `cfraser/santander-movements/imported/card-movements-2026-10-10T01-34-27.json` (dormant 0/0,
  active CLP 24 / USD 6, give or take new rows), the xlsx saved (~8.5 KB), the USD capture
  produced. Timings compared with run 267/268.
- Run 2: `fetch:santander --force --background --capture --only=card-statements`. Expected: per
  card one national + one international `estadoCuenta…` pair, no repeated national trio,
  extractos matching the staged `cfraser/santander-statement-json/` names; capture mode writes
  the JSON into the capture dir, never the staging dir.
- Run 3 only if a fix needs re-verification.
- `cd ingest && npm run test`, root `npm run typecheck`.

Results are recorded below once the runs are done.

## Results (2026-10-10, three capture runs)

**Run 1** (`2026-10-10T02-44-38`, card + checking + USD): exactly four
`consultaUltimosMovimientos` calls — …2286 CLP, …2286 USD, …2556 USD, …2556 CLP (the tabs
alternated as planned), no «collapsed» line (0 duplicates), slides dormant 0/0, active USD 6 /
CLP 24 = the 01:34 reference file; cupo rows 4, deposit rows 4; xlsx 8528 bytes; USD capture
written. Timings: card step 40 s (run 267: 22 s with a working arrow; run 268: 37 s for one
card) — 5 s page load, 1 s other tab, arrow 5 s + swipe 2 s, 1 s other tab, then **26 s**
finding out there was no next card (arrow 5 s + full 20 s swipe wait: the swiper no longer
marks its arrow disabled); checking 6 s (was 9 s); USD capture 2 s (was 9 s).

That 26 s led to a sixth change: **the carousel stops once every card the product summary
lists has been visited** (`cardContractsInSummary` / `everyCardVisited`: `Entrada.Cuenta` is the
summary's `NUMEROCONTRATO`, verified on run 1's capture; without a summary the stuck detection
decides). Expected card step after it: ~14 s.

**Run 2** (`2026-10-10T02-47-35`, card + statements): the stop rule fired («every card in the
product summary visited (2) — carousel done», card step 12 s to that point), but the fourth
movements call (…2556 CLP, 0,7 s after the swipe's USD call) answered the gateway's
**STATUS 101 «Error al validar token Oauth 2.0»** — a token issued at that login and valid until
02:57 — and the bank then dropped the session (the statements step found the public site). First
STATUS 101 in every capture on disk; the same 0,7 s sequence had succeeded in run 1, and the
runs were 2 min apart. Treated as a bank-side transient, not reproduced. The error message
quoted the whole bearer token into the log and diagnostics; `assertApiOk` now cuts the
description at 60 characters.

**Run 3** (`2026-10-10T02-53-47`, statements only, 6 min later): national statements for both
cards (extractos 105 and 023, byte-identical to the staged files; written to the capture dir,
nothing to the staging dir), the stop rule ended the carousel, step 13 s — **but no
international statement and no billing month**: the Dólares tab and «Pagar hasta» were looked
for 0 s after the national call, and the screenshots show the view still a skeleton then (it
renders about a second later, after the page's own PDF request answers). Fixed after the run:
`visibleCurrencyTab` waits up to 15 s for the tab bar before any tab lookup or pay-by read.
**Unverified** — the three authorized sessions were used; the next nightly with a statement due
(…2556 closes 2026-10-26, or a `--only=card-statements --capture` run) will show it.

**Savings per step** (clean path, vs run 267): checking 9 → 6 s, USD capture 9 → 2 s, card
step 22 → ~14 s expected with a dead arrow (the arrow's 5 s wait per card is the price of
keeping the fast path when it comes back), statements per card: route 8 s + 2 × 4 s tab settles
+ 4 s slide settle → one tab click plus the calls themselves. The login's ~36 s of settles (Pass B)
dominate what is left.

## Pass B — done (2026-10-10 03:04, capture `2026-10-10T03-03-54`)

The homepage waits for the login button instead of networkidle (30 s cap, diagnostics on timeout); after the redirect the session waits for `isLoggedIn` plus a new `cruceProductosOnline` (20 s cap; the «session still valid» branch waits the same way); `gotoRoute` was deleted (no callers, every step uses `openRoute`); the runner judges the pre-step login state only on a URL that held still for 300 ms. Timings launch → logged in / launch → summary: run 268 (card + checking + USD) 48 s / 106 s; 02:57 capture (card + statements) ≈38 s / 74 s; Pass B card-only 14 s / 31 s. No «network still busy» line left in the session.
