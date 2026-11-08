# Demo: About page, ingest story, writable demo

Plan agreed 2026-11-07; built the same day (AGENTS.md «Hosted demo» describes what shipped). The hosted demo becomes a front door for the project: an About page that
explains what the app is and how its data arrives, a generated ingest history so the panels that
show the pipeline have something in them, and a demo a visitor can change a little. Personal
instances are unaffected except for one new route (`/dashboard`).

Already done before this plan: meta description, robots.txt, the Open Graph image
(`scripts/render-og-image.mjs`), the demo tour (`DemoTour.tsx`), the demo privacy page.

## Wording, everywhere

The app is described as an **automated** net-worth and expense tracker **connected to its
sources**, and the demo person as **fictional** (never "made-up").

- Tour welcome (`demo.tour.steps.welcome.body`): «An automated net-worth and expense tracker. It
  connects to banks, card issuers, brokers, pension funds and mailboxes, imports each statement
  as it arrives, and values every account daily. Shown here with a fictional person's finances,
  generated as documents and imported the way real ones are, at real market prices.» Spanish to
  match.
- Cards step: balances update by themselves as the sources report.
- `index.html` meta description and `og:description`, the OG image headline/subline, the About
  page, the README.

## 1. Routing

- `/dashboard` renders the dashboard in every build. Personal instances keep `/` as the dashboard
  too (two addresses, one page).
- Demo build only (`VITE_DEMO_MODE`): `/` is the About page; the sidebar gets «About» above
  «Dashboard», and «Dashboard» links to `/dashboard`.
- The tour's steps use a `DASHBOARD_PATH` constant (`/dashboard` on the demo) instead of `/`.
  «Start tour» goes there; the tour never opens on About (it waits until the visitor reaches the
  dashboard, then shows the welcome with the same first-visit rule).
- `og:url` stays the demo root (the About page is what a shared link should open).
- Everything that matches the dashboard by path (favicon, document title, nav highlight,
  prefetch, usage route names) must accept both addresses.

## 2. About page with the live dashboard

**One dashboard instance for both routes.** On the demo, `/` and `/dashboard` render the same
host component outside the route switch, with the dashboard always mounted inside it. The route
only sets the host's mode:

- `about`: the dashboard frame is the content region's full width (so the grid lays out exactly as
  on `/dashboard`; the layout follows the viewport, so it must never be rendered narrower), drawn
  smaller and tilted with a CSS transform (perspective + rotateY/rotateX + scale + translate),
  `pointer-events: none`, `inert`, `aria-hidden`. The About content sits beside it.
- `dashboard`: no transform, About content hidden; the frame is the page.
- The change between modes is a CSS transition on `transform` (about 600 ms, eased). Because the
  component never remounts, numbers, scroll and query state carry over: no reload, no rolling
  digits. No View Transitions needed, so every browser animates the same.
- Leaving to another route unmounts it as today; only About ↔ Dashboard is seamless.
- `prefers-reduced-motion`: switch without the transition.
- Phone width: no tilt (a tilted 375 px dashboard is unreadable); About content first, then a flat
  scaled preview of the dashboard (same frame, `transform: scale()` only).
- Scroll memory (`useScrollMemory`) keeps working per URL; going to `/dashboard` from About starts
  at the top.

**About content** (i18n, both languages):

- Title, a two-line description (the wording above), «Open the dashboard» (primary), links to
  GitHub, Privacy and the contact address.
- **How it works**, a diagram (inline SVG or HTML boxes, themed with the CSS tokens):

  `Sources → Ingest service → Server → This page («you are here»)`

  | Box | Says | Links to |
  | --- | --- | --- |
  | Sources | banks (statements, daily movements), card issuers, brokers, pension and unemployment funds, mailboxes (receipts, transfer notices, payslips), market data (prices, exchange rates, UF) | «Import sync» |
  | Ingest service | signs in, fetches, reads PDFs and spreadsheets, sends typed payloads; nightly at 22:00 and hourly polls | «Import sync» run history |
  | Server | the only database writer; checks each import against the bank's own totals and balances, values every account daily, notifies on disagreement | «Notifications», «Exchange rates» |
  | This page | the client: shows what the server computed | «Open the dashboard» |

  Under it: on the demo the ingest service and bank sessions do not run; the history shown is
  generated from the same fictional documents.
- Stays general: kinds of sources, not the author's banks, card endings or accounts.

**OG image:** `render-og-image.mjs` screenshots `/dashboard`; the release-time staleness note
stays.

## 3. Generated ingest history (demo generator)

The generator already dates every document. From those dates it writes what the scheduler and
ingest service would have recorded, so «Import sync» and «Notifications» show the pipeline:

- `ingest_runs` + `jobs`: a nightly run at 22:00 Chile every day, an hourly poll on each hour a
  mail-borne document arrived (statement, cartola, receipt, payslip); steps with their labels and
  plausible durations, the same step lists the real runners record.
- `app_messages`: the run logs and notifications exactly as `recordDailyRun` /
  `recordHourlyEmailRun` write them (one notification per failure, the «Recovered» one after).
- A few realistic failures, seeded and rare: a bank login refused one night and recovered the
  next, a mail step that lost its connection, a statement that waited a night for its twin.
- The nightly checks: bank cupo captures + verdicts and deposit-account balance snapshots that
  agree with the ledger (the invariants already guarantee the ledger).
- Deterministic per month (the generator's per-month streams), so adding a month never moves a
  past run.
- The scheduler stays off on the demo, so nothing appends after build; history ends the night
  before the build. Fine: the demo regenerates on every deploy.
- On the demo, «Run now», «Retry» and «Cancel» are hidden (they are writes to a queue nobody
  runs).

## 4. Writable demo (shared database, reset when idle)

All visitors share the demo database. A narrow set of edits is open; everything else stays
read-only.

**Open** (exact routes confirmed when built; candidates from `server/src`):

- Expense categories and «Único»: `PATCH /api/flows/expenses/credit-card/lines/:lineId/category`
  and the per-purchase category route.
- Big groups on lines: `PUT /api/flows/expenses/credit-card/purchase-big-group` (assigning an
  existing group only).
- Marking a credit as a refund: `POST|DELETE /api/income/movements/:movement_id/refund`.
- Cuotas count on a purchase: `POST /api/accounts/:id/cc-statement-lines/:lineId/make-installment`.
- Line pieces: `PUT /api/flows/expenses/line-pieces`.
- Manual expenses: `POST|PATCH|DELETE /api/flows/expenses/manual…`, with the description chosen
  from a fixed list on the demo (amount, date and category free). The list, stored as written
  (a description is expense text, like a bank's merchant, not UI copy): «Coffee», «Lunch»,
  «Groceries», «Taxi», «Parking», «Pharmacy», «Haircut», «Books», «Cinema», «Gift». **Why
  fixed:** the database is shared, so a description one visitor types shows in every other
  visitor's expense lists until the next reset; free text invites slurs and spam links on a page
  that represents the author, and a word filter only catches the obvious. Per-visitor free text
  would need the isolation the shared database avoids.
- Display preferences are already per browser.

**Closed:** free text of any kind (notes, names, new categories or big groups, places), deletes of
imported data, imports and uploads, the control panel, account and group settings, the ingest
endpoints. The client hides note editors and other closed controls on the demo rather than letting
them fail.

**Mechanics:**

- `demoReadOnlyMiddleware` gets an allowlist (method + route pattern); anything else keeps the
  `demo_read_only` 403.
- Server-side validation for the demo: the manual-expense description must be one of the list.
- Quota: a fixed number of writes per daily visitor id (the analytics hash), in memory; over it,
  a localized «demo edit limit reached» message.
- **Reset when idle:** at build, after generation, keep a pristine copy (`VACUUM INTO`). When the
  demo goes idle (the existing 30-minute idle that stops the syncs) and any write happened since
  the last reset, restore every table from the pristine copy in one transaction (attach it,
  delete + insert per table, foreign keys off), clear `mark_input_changes`, then
  `clearAggregationCache()`. A visitor arriving later sees the generated state.
- **Also nightly**, at 04:00 Chile, whatever the activity: steady traffic would otherwise keep
  the demo from ever going idle, and edits would pile up. Skipped when nothing was written.
- The tour/About mention that a few edits are allowed and reset after a while.
- Writes go through the existing funnels, so caches drop and recompute exactly as on a personal
  instance.

## 5. README

A section on the ingest side: the two packages (`ingest/`, `server/`), the contracts and kinds,
the scheduler and job queue, the kinds of sources, the reconciliation checks. Same generality rule
as the About page.

## Order

1. Wording (quick, independent).
2. Routing + `/dashboard` alias.
3. About page with the shared dashboard frame and the diagram.
4. Generated ingest history.
5. Writable demo.
6. README, OG image re-render, release.

Each step is testable on the local demo (`server-demo` / `client-demo` launch configs; the
generator step needs `npm run demo:generate`).
