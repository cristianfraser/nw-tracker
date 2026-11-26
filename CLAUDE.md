# CLAUDE.md

> ⚠️ **Tests: never run `npx vitest` from the repo root.** Always `cd server && npm run test`
> (or `npm test`), which sets `NW_TRACKER_TEST_DB` so Vitest uses
> `server/data/nw-tracker.test.db` (as the base each fork clones). Running vitest without that env var opens the **real**
> `server/data/nw-tracker.db`, and destructive test setup will wipe live data. `db.ts` now
> throws under Vitest when `NW_TRACKER_TEST_DB` is unset — do not work around it. See the
> "Server Vitest (SQLite)" section in AGENTS.md.

Project guidance is imported below: GUIDELINES.md (global, project-agnostic engineering
rules), AGENTS.md (app-specific conventions; with the topic files under `.claude/rules/`
that its index lists, the single source of truth for those — a topic file loads when a
session reads a file its `paths:` match, so read the topic file of an area before changing
code in it), and PARSERS.md — the **untracked** current-state personal data-pipeline notes (main checkout only; absent
on clones/worktrees, restore from `~/Documents/backups/nw-tracker/`); its dated incident history is the
untracked `cfraser/PARSERS-history.md`, read on demand, not imported.

@GUIDELINES.md
@AGENTS.md
@PARSERS.md
