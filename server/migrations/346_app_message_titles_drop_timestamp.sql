-- Sync-log titles written until 2026-05 ended in the run's time (« 2026-05-19 23:44:19 UTC»),
-- which `created_at` already holds. The messages table stripped it at render; the stored titles
-- lose it here, once, and the client shows a title as stored (docs/untangle-plan.md, wave 8b).
-- The suffix is 24 characters: a space, the day, a space, the time, a space, UTC.
UPDATE app_messages
SET title = substr(title, 1, length(title) - 24)
WHERE title GLOB '* [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9] UTC';
