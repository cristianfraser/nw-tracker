-- A line split into pieces (a cash withdrawal spent on several things) dates each piece on the day
-- it was spent; null = the line's own day. The pieces need not cover the whole line: what they
-- leave is the line's own expense, on its own day (expandLineSplitsInDrafts).
ALTER TABLE cc_expense_line_splits ADD COLUMN spent_on TEXT CHECK (spent_on IS NULL OR spent_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
