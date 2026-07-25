-- The hosted demo no longer has a login (recruiters bounced off the gate), so the
-- recruiter-login log has no writer. Anonymous visit analytics replace it and live in
-- their own SQLite file (DEMO_ANALYTICS_DB, server/src/demoAnalytics.ts), never here.
-- The hosted demo's historical logins survive untouched in /var/data/demo-auth-logins.db.
DROP TABLE IF EXISTS demo_auth_logins;
