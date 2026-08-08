# Global engineering rules (nw-tracker)

Project-agnostic rules that apply to all work in this repo, regardless of feature area.
App-specific conventions and mechanics live in AGENTS.md; where a rule below has an
app-specific instantiation (file names, helpers, enforcement scripts), AGENTS.md carries it.

## Fail fast — no runtime fallbacks

- **Fix data, don't paper over it.** Missing links, mismatched totals, ambiguous parse
  fields, and inconsistent imports are data or pipeline problems. Repair the imports,
  migrations, or source files — do not add runtime fallbacks, `try/catch` swallowing, or
  "best guess" edge-case branches to keep the UI green.
- **Throw on mismatch.** When parsing, importing, or reconciling two sources, invalid or
  inconsistent input should **throw** (or return a hard error to the client). Do not
  return `null`, `0`, empty arrays, or alternate code paths as silent defaults.
- **No fallbacks for canonical fields.** No guesses (filename, date heuristics) when a
  canonical field is required; no alternate formulas when the primary calculation fails;
  no `catch { return fallback }`.
- **Legitimate exceptions:** user-facing validation messages, features that are truly
  optional by product design, and infrastructure retries (network, file locks) — never
  business-logic substitutes for bad stored state.

## Free text is provenance, not state

Note/description text is for humans. Machine-readable state lives in structured
columns/tables, written at import/create time — runtime never branches on note
substrings. When a runtime guard exists only to paper over a legacy data state: verify
the stored state once, fix rows if needed, then delete the guard (fail fast if the state
reappears).

## Runtime reads the database only

Import-input files are import inputs, full stop. Request paths, dashboards, valuation,
and sync read the database; missing data is an error (or a "run the import" message),
never a silent file fallback.

## The server computes display shapes; the client only picks

Aggregations, groupings, tail clips, card metrics, and other display-shaping rules
belong in server payload builders. The client selects precomputed blocks — it never
re-sums, re-groups, or re-derives, so two surfaces showing the same number cannot drift.

## Code in English

Identifiers, comments, commit messages, and source code are written in English.
User-facing copy goes through i18n.

## No hardcoded user-facing text or formats

- User-facing strings go through the i18n layer, never hardcoded in components.
- Numbers and dates are formatted through the shared formatting helpers — never with a
  hardcoded locale. Numeric dates render unambiguously (ISO `YYYY-MM-DD`), not
  locale-short styles.
- Derived display values (translations, formatted numbers, date labels) are computed at
  render time — never cached in memo/state without their inputs (language, separator
  preference) in the dependencies.

## Parallel renderings change together

When a component has two renderings of the same data (e.g. desktop table and mobile
card), a change to one — adding, removing, or reformatting a field — must be applied to
the other in the same edit.

## Testing

- **Test app features and implementations — not that libraries, the language, or the
  framework work as intended.** A test that would pass in an empty project (exercising
  only a dependency's documented behavior) adds no coverage; test the code this repo
  wrote on top.
- **Always run tests through the workspace test command against the dedicated test
  database, never against real data.** (In this repo: `cd server && npm run test` — see
  the warning in CLAUDE.md.)
- **Tests create their own synthetic fixtures** (prefixed, cleaned up) and never pick or
  pin live-DB rows; assertions must not depend on personal data.
- **Never hardcode real personal values** (account numbers, card digits, balances) in
  code or tests — use committed synthetic fixtures.

## Async route handlers must be wrapped

An unhandled async rejection in a route handler must become an error response, not a
process death. (In this repo: Express 4 does not forward async rejections — wrap
handlers in `asyncHandler` from `server/src/index.ts`; a terminal error middleware turns
route throws into JSON 500s.)

## Git commits

Do not append `Co-authored-by: …` or any other co-author trailer unless the user
explicitly asks for it.
