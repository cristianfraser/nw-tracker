-- fx_daily holds one CLP=X row per weekday, the rate at the fx day end (17:05 New York — see
-- forexDay.ts); weekends read Friday's close. Yahoo's chart labels its Monday week-open bar by
-- the New York date of the bar start, i.e. Sunday, so the sync had been storing the
-- Sunday-evening reopen as a Sunday row (607 weekend rows since 2015-05-03), which put weekend
-- news moves into Sunday's daily P/L and month-end conversions that fall on a Sunday, and
-- which the Risky Norris composite anchor already had to skip. Delete them; the ingest no
-- longer writes weekend-dated bars.
DELETE FROM fx_daily WHERE strftime('%w', date) IN ('0', '6')
