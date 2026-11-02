-- The mortgage's stored peso valuations (month-end figures of the spreadsheet era) are gone, like
-- the property's in 260: the depto ledger values the mortgage on every date (balance in UF × the
-- UF of the day) and nothing reads these rows as its value. A stored row is a quantity of what the
-- account holds, and the mortgage holds UF, so a peso row no longer fits. The chart's month-end
-- dates come from the ledger (`augmentChartDatesForDeptoAccounts`).
DELETE FROM valuations WHERE account_id IN (
  SELECT a.id FROM accounts a
  JOIN asset_groups g ON g.id = a.asset_group_id
  WHERE g.slug LIKE '%\_\_mortgage' ESCAPE '\'
)
