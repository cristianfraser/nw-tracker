-- The crypto exchange's peso wallet (leaf `<bucket>__buda_clp`) is a peso cash ledger: its value on
-- any day is the sum of its peso movements (`cashCurrency.ts`, `isPesoCashKindSlug`). The marks
-- stored while it was book-valued are no longer read by anything; they go, like the stored rows of
-- every other cash ledger.
DELETE FROM valuations
 WHERE account_id IN (
   SELECT a.id FROM accounts a
     JOIN asset_groups g ON g.id = a.asset_group_id
    WHERE g.slug = 'buda_clp' OR substr(g.slug, -10) = '__buda_clp'
 );
