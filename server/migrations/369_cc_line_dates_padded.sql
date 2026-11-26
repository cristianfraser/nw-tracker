-- Card line days stored in one shape, padded dd/mm/yyyy (`storedCardLineDate`, nw-tracker-contracts):
-- the statement JSON and the listings stored the day unpadded (d/m/yyyy), the parsed PDFs as printed
-- (dd/mm/yy or dd/mm/yyyy), and the flow trigger reads only the 8-character dd/mm/yy and the
-- 10-character dd/mm/yyyy: an unpadded 8-character day became a malformed flow day, a 9-character
-- one fell through to the posting or statement day. Pads the day, then the month, then writes a
-- two-digit year in full (70 and above read 19xx, the shared `parseDdMmYyToIso` rule). The hook
-- checks every stored day, re-dates the line evidence and repairs the flows dated from it.
UPDATE cc_statement_lines SET transaction_date = '0' || transaction_date WHERE transaction_date GLOB '[0-9]/*';
UPDATE cc_statement_lines SET transaction_date = substr(transaction_date, 1, 3) || '0' || substr(transaction_date, 4)
  WHERE transaction_date GLOB '[0-9][0-9]/[0-9]/*';
UPDATE cc_statement_lines SET transaction_date = substr(transaction_date, 1, 6)
    || (CASE WHEN CAST(substr(transaction_date, 7, 2) AS INTEGER) >= 70 THEN '19' ELSE '20' END) || substr(transaction_date, 7, 2)
  WHERE transaction_date GLOB '[0-9][0-9]/[0-9][0-9]/[0-9][0-9]';
UPDATE cc_statement_lines SET posting_date = '0' || posting_date WHERE posting_date GLOB '[0-9]/*';
UPDATE cc_statement_lines SET posting_date = substr(posting_date, 1, 3) || '0' || substr(posting_date, 4)
  WHERE posting_date GLOB '[0-9][0-9]/[0-9]/*';
UPDATE cc_statement_lines SET posting_date = substr(posting_date, 1, 6)
    || (CASE WHEN CAST(substr(posting_date, 7, 2) AS INTEGER) >= 70 THEN '19' ELSE '20' END) || substr(posting_date, 7, 2)
  WHERE posting_date GLOB '[0-9][0-9]/[0-9][0-9]/[0-9][0-9]';
UPDATE cc_statement_lines SET transaction_date = NULL WHERE trim(transaction_date) = '';
UPDATE cc_statement_lines SET posting_date = NULL WHERE trim(posting_date) = '';
