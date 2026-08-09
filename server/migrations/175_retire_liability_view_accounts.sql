-- Retire `liability_view` alias accounts (mortgage 89, CC 93/94/95 on the real DB).
-- They were data-less display identities for the Pasivos tree from before CC/mortgage
-- surfaces listed the master accounts directly; every reader now resolves masters, so the
-- rows only kept the alias-mapping layer alive (and their NULL color_rgb shadowed the
-- master's configured color on Pasivos chart lines). All four rows were verified to carry
-- zero movements and zero valuations. `seedLiabilitiesTree` re-points the Pasivos mortgage
-- leaf at the master on next boot (it rewrites `liability_group_items` every run); the
-- explicit delete below keeps non-rebooted readers consistent in the meantime.
DELETE FROM liability_group_items
WHERE account_id IN (SELECT id FROM accounts WHERE account_kind = 'liability_view');

DELETE FROM accounts WHERE account_kind = 'liability_view';
