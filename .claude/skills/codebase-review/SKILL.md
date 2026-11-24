---
name: codebase-review
description: Read-only architecture, code-quality, and feature-opportunity review of the nw-tracker repo. Use this whenever the user asks for a codebase review, an audit, code smells, tech debt, refactor targets, improvement opportunities, or new feature ideas for this project — even phrased casually ("go over the codebase", "anything smelly in here?", "what should we build next?").
---

# Codebase review (read-only)

Produce a single markdown report reviewing this repo for code smells, improvement opportunities, and new feature ideas. This is analysis only:

- Do **not** modify project files, run imports, or touch the databases.
- Never run `npx vitest` from the repo root. If tests are needed at all, use `cd server && npm run test`.

## Context to load first

- **AGENTS.md and the topic files under `.claude/rules/` are the source of truth for conventions** (AGENTS.md lists them; read the topic file of every area you review, since they load only when a matching file is read): fail-fast / no runtime fallbacks, UI copy via `client/src/i18n/master.json` (the locale files are generated), `cfraser/` files are import-time inputs only, number formatting via `client/src/format.ts` (never hardcoded-locale `Intl.NumberFormat`/`toLocaleString` for numbers), desktop/mobile table parity, `DataOrigin` provenance, `asyncHandler` on async Express routes.
- **Check memory and prior reports before starting.** Findings already delivered in earlier audits (e.g. the 2026-07-03 read-only audit: formatting/i18n breaches, cfraser-read-on-request-path, route import bloat) must not be re-reported — only note whether they regressed or grew.
- The CLP/USD-fixed storage still listed under «Remaining work» in `docs/any-currency-plan.md` is known, deliberately-parked debt. Don't re-propose it unless you found something that changes its priority.

## Part 1 — Code smells (server/src and client/src)

Report concrete, cited issues only — each with `file:line` and 1–3 sentences on why it matters *here*. No vague "consider improving X" items. Categories to sweep:

**Violations of the repo's own rules** (the highest-signal smells in this codebase):
- Runtime fallbacks or silent defaults where AGENTS.md says throw (`catch { return null/0/[] }`, "best guess" branches).
- Hardcoded UI strings outside `master.json`; `Intl.NumberFormat` / `toLocaleString` with hardcoded locales for numbers.
- Formatted strings cached in `useMemo`/state without `decimalSeparator` in deps.
- Desktop/mobile table drift (columns present in one rendering but not the other).
- `fs` reads of `cfraser/` outside `server/scripts/` and import helpers.
- Async Express handlers not wrapped in `asyncHandler`.

**General smells:**
- Functions/files that have outgrown their responsibility — `flowsCheckingGastos.ts` and `routes/dashboard.ts` are known heavyweights; measure whether anything else is in that class.
- Copy-pasted logic that should share a helper; dead code / unused exports.
- SQL built by string concatenation with interpolated values; N+1 query patterns on request paths.
- Cache keys or families inconsistent with `cacheRegistry.ts` / `cacheFamilies.ts` (see `.claude/rules/market-data.md` «Cache invalidation»).

**Test gaps:** server modules with meaningful business logic (money math, reconciliation, parsers) and no corresponding test file.

## Part 2 — Improvement opportunities

Rank 5–10 improvements by impact/effort. For each: what, where, why now, rough size (S/M/L). Consider performance (the `@heavy` dashboard aggregation paths), maintainability (module boundaries, route-file size), type safety (`any` casts, unchecked JSON parses), and operational robustness (scheduler failure modes, backup/restore drills, migration hygiene given the naive `;` splitting).

## Part 3 — Feature ideas

Propose 5–8 features that fit the product: a single-user personal net-worth tracker for Chilean + US assets (CLP/USD/UF) with CC statement parsing, brokerage/AFP/Fintual/crypto tracking, projections, XLSX export, and a hosted recruiter demo. Check memory for what the roadmap already delivered (as of 2026-07: mirror pairs + movement search, export, projections) and build beyond it. For each idea: the user problem, a sketch of data model / API / UI touchpoints in this codebase's terms, and an effort estimate. Prefer ideas that exploit data already in SQLite over new external integrations.

## Output

One markdown report with the three sections above, findings ordered most-important-first within each section. Cite `file:line` for every Part 1 claim. End with a shortlist of the 3 things you'd do first and why.
