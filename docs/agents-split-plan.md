# Splitting AGENTS.md into topic rules

## Goal

`AGENTS.md` is imported by `CLAUDE.md`, so all of it (~498 KB, ~125K tokens) loads into every
session, and `PARSERS.md` adds ~119 KB more. Most of it is detail a session needs only when it
touches one area. Keep the rules that apply everywhere in `AGENTS.md` and move each area into a
file that loads only when a session works in that area. No rule is dropped or reworded in the
move; only cross-references change.

## Mechanism

Claude Code path-scoped rules: `.claude/rules/<topic>.md` with a `paths:` frontmatter list of
globs. A rule file without `paths:` loads every session; one with `paths:` loads when Claude
reads a file that matches. `.claude/` is already tracked (`skills/`, `launch.json`).

Two gaps follow from that, and the index covers both:

- A session that only runs scripts, queries the database or reads `docs/` reads no matching
  file, so no topic loads by itself.
- A change in one area can break a rule kept in another (the card owed walk feeds the cash
  netting and Pasivos).

So `AGENTS.md` keeps a short index: one line per topic file saying what it covers and when to
read it, plus the rule "before changing code in an area, read its topic file".

Step 1 pilots the mechanism on one topic before anything else moves.

## What stays in AGENTS.md (~45 KB)

The index, then the sections that apply in any area:

- Language and i18n (the convention guard reads this section's rules)
- Fail fast + provenance — app specifics; Personal data pipeline pointer; Data provenance
- An account's value: what it holds, converted once
- Deferred: value + currency refactor
- Import sources vs runtime (cut to its cross-cutting bullets; the per-source ones move to
  `ingest-sources.md`)
- Server runtime modes; Schema baseline; Server verbose logging; Server Vitest (SQLite)

## Topic files

Sizes are the current sections' (after the 2026-11-12 condensing). Globs are a first draft,
to be checked against `git ls-files` in step 2 so each topic matches the files it governs and
nothing much else.

| File | Sections | Size | `paths:` (draft) |
|---|---|---|---|
| `cards.md` | CC chart / Pasivos convention; Open-month CC bucket; CMR Falabella card; Refunds inside gastos / additional cards | ~53 KB | `server/src/cc*`, `server/src/cards/**`, `server/src/creditCard*`, `client/src/components/credit-card/**`, `client/src/components/liabilities/**`, `ingest/src/cards/**`, `ingest/python/*cc*` |
| `ingest-protocol.md` | Ingest API: the envelope, receiver, access, client retries, run protocol, job queue, server tasks | ~30 KB | `ingest/src/service/**`, `ingest/src/runner/**`, `server/src/ingest*`, `server/src/jobQueue*`, `server/src/jobClaims.ts`, `server/src/routes/ingest.ts`, `server/contracts/src/**` |
| `ingest-sources.md` | Ingest API: one bullet per kind; Unattended daily bank run; per-source bullets of Import sources vs runtime | ~95 KB | `ingest/src/**`, `ingest/python/**`, `server/src/*Apply.ts`, `server/src/santander*`, `server/src/fintual*`, `server/src/racional*`, `server/src/broker*`, `server/src/bank*` |
| `market-data.md` | Global sync scheduler; Live market quotes | ~48 KB | `server/src/globalSync*`, `server/src/live*`, `server/src/schedulerKernel.ts`, `server/src/syncSource*`, `server/src/fx*`, `server/src/rates.ts`, `server/src/yahoo*`, `server/src/afpUno*`, `server/src/afcCic*` |
| `instruments.md` | Equity / crypto tickers; Instrument registry; Options; Quote currency / `.SN`; London market | ~26 KB | `server/src/equity*`, `server/src/crypto*`, `server/src/option*`, `server/src/marketSymbols.ts`, `server/src/priceProviders/**`, `server/src/london*`, `server/src/accountEquityTicker.ts` |
| `valuation-series.md` | Daily series; Nav card metrics; Net-worth portfolio tree; Agrupado bucketing; Rentabilidad benchmark row; Pasivos coverage | ~70 KB | `server/src/daily*`, `server/src/valuation*`, `server/src/account*`, `server/src/dashboard*`, `server/src/group*`, `server/src/nav*`, `server/src/portfolio*`, `server/src/benchmark*`, `server/src/periodReturns*`, `server/src/cache*` |
| `client-ui.md` | Page grid and tiles; Per-surface display controls; Loading states; UI headings; UI tables | ~55 KB | `client/src/**` |
| `expenses.md` | Real-estate expenses; Expense subcategories; Manual expenses / pieces / big groups; Home dashboard tables; MACH; Lider boletas; Checking ledger anchor; Mirror pairs; XLSX export | ~45 KB | `server/src/flows*`, `server/src/flows/**`, `server/src/expense*`, `server/src/checking*`, `server/src/movement*`, `server/src/realEstate*`, `server/src/grocery*`, `server/src/matching/**`, `server/src/export*` |
| `tax.md` | Tax return; Projections; Wealth percentile | ~23 KB | `server/src/f22/**`, `server/src/us1040/**`, `server/src/taxFacts/**`, `server/src/tax*`, `server/src/legalParameters.ts`, `server/src/projections.ts`, `server/src/wealth*`, `client/src/components/tax/**` |
| `demo-ops.md` | Hosted demo (Render); Usage and performance log; Dashboard performance profiling | ~29 KB | `server/src/demo*`, `server/src/demoData/**`, `server/src/usage*`, `render.yaml`, `scripts/server-deploy.sh`, `scripts/release-demo.sh` |

The globs overlap on purpose where an area spans layers (`client-ui.md` loads on any client file);
a session touching cards and the client gets both, ~110 KB, still well under today's load.

`PARSERS.md` (untracked, personal) gets the same treatment as `.claude/rules/parsers.local.md`
scoped to `ingest/python/**`, `ingest/src/**` and `cfraser/**`, with that file added to
`.gitignore`; until then it stays imported by `CLAUDE.md`.

## Cross-references

Sections cite each other by name («Card dollars in pesos», «Bank posting day»). After the move a
reference to a section in another file names the file: `cards.md` «Card dollars in pesos». Step 3
finds them with a grep of `«[^»]+»` against the section and bullet titles of each file. Code
comments and docs that point at `AGENTS.md "<section>"` (`render.yaml`, `scripts/check-conventions.mjs`,
`server/scripts/regenerate-schema-baseline.ts`, `server/src/appVersion.ts`, `server/src/ccInvestmentProxy.ts`,
`server/src/groupDailySeries.ts`, `client/src/components/ui/useTableFit.ts`,
`client/src/languagePreference.ts`, `ingest/README.md`, `README.md`, the `docs/*-plan.md` files)
are repointed the same way. `docs/history/` is left alone.

`CLAUDE.md`, `GUIDELINES.md` and the codebase-review skill say "AGENTS.md is the single source of
truth for app conventions": they become "AGENTS.md and `.claude/rules/`". The skill also tells a
reviewer to read the topic files of the areas it reviews.

## Steps

1. **Pilot `tax.md`** (self-contained, ~23 KB, clear paths). Move the three sections, add the
   index line, then check in a fresh session that the rule does not load on an unrelated file
   and does load after reading `server/src/f22/draft.ts`. If path-scoped loading does not behave
   as described, stop and revisit the mechanism (fallback: plain topic docs under `docs/agents/`
   read on demand from the index).
2. **Check the globs** for each remaining topic with `git ls-files` (what matches, what is
   missed) and adjust.
3. **Move the remaining topics** one commit each, sections verbatim, then fix cross-references.
4. **Repoint the comments and docs** listed above, and the three instruction files.
5. **Verify:** every `## ` section of today's `AGENTS.md` appears exactly once across
   `AGENTS.md` + `.claude/rules/*.md` (a script diffing the section bodies byte for byte, so the
   move provably changes nothing but references); no `«…»` reference left without a file where
   the section moved; `AGENTS.md` under ~50 KB.
6. **PARSERS.md**, last and separately (untracked; back it up first).

## Risks

- **A topic that does not load when it should.** A session fixing a dashboard number may never
  open a `cc*` file and miss a card rule that shapes it. The index line and the "read the topic
  file before changing code in an area" rule are the mitigation; watch for it in the first weeks.
- **Other sessions edit `AGENTS.md` all the time.** Each move is a short commit made from a fresh
  read of the file, and a section edited mid-move is moved again from its new text.
- **Non-Claude agents** read `AGENTS.md` only and would lose the topics; nothing in the repo
  shows one in use.
