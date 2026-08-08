# CLAUDE.md

> ⚠️ **Tests: never run `npx vitest` from the repo root.** Always `cd server && npm run test`
> (or `npm test`), which sets `NW_TRACKER_TEST_DB` so Vitest uses
> `server/data/nw-tracker.test.db`. Running vitest without that env var opens the **real**
> `server/data/nw-tracker.db`, and destructive test setup will wipe live data. `db.ts` now
> throws under Vitest when `NW_TRACKER_TEST_DB` is unset — do not work around it. See the
> "Server Vitest (SQLite)" section in AGENTS.md.

Project guidance is imported below: GUIDELINES.md (global, project-agnostic engineering
rules), AGENTS.md (app-specific conventions — single source of truth for those), and
PARSERS.md — the **untracked** personal data-pipeline notes (main checkout only; absent
on clones/worktrees, restore from `~/Documents/backups/nw-tracker/`).

@GUIDELINES.md
@AGENTS.md
@PARSERS.md
