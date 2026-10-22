# AFP: one account per fund manager and fund (2026-10-22)

## Why

The AFP money is one account today (`accounts` 78, `import:excel|key=afp`, name «AFP») whose
cuotas are all expressed in UNO Fondo A cuotas. The PlanVital A years (2017-06 → 2018-08-03)
and the Modelo A years (2018-08-13 → 2020-01-06) are not accounts: the certificate rebuild
converts their rows with the transfer ratios (40,80 PlanVital → 38,41 Modelo; 115,66 Modelo →
111,37 UNO) and prices them through a synthetic series, `afp_prior_funds_a` (each earlier fund's
official valor cuota ÷ its ratio, frozen while in transit), declared on `accounts.fund_series_key`
and read through the day before UNO's transfer-in shows (`cuotaLedgerSeriesKeyForAccount`).
The transfers themselves are deliberately not ledger rows (`pensionLedgerShape.ts` throws on
`TRANSFER_CODES`).

On 2027-04-01 the multifondos are replaced by generational funds, so the UNO Fondo A account ends
and a fourth fund starts. Stacking a third ratio on the same trick would hide a third switch.

The model this plan builds: **one account per (AFP, fund)**, each holding the cuotas its own
certificates print, priced by the Superintendencia's official valor cuota of that fund in the
display frame, and a **fund switch is a transfer** between two fund accounts carrying both cuota
counts. The 2018 and 2020 switches and the 2027 one become the same shape.

## Decisions (stated assumptions — overturn in the plan, not in code)

1. **Account layout.** Account 78 stays and becomes «UNO-A» (keeps its id, payslip links,
   contribution periods, nightly reads). Two new accounts, «PlanVital-A» and «Modelo-A»
   (named like the position tickers), receive the 2017–2020 rows. All three sit in asset group
   `retirement_afp_afc__afp` (id 24, kind `afp`) under the «AFP + AFC» nav node — the nav tree
   links accounts by asset group (`linkAccountsByAssetGroup` in `seedNavTree.ts`), so sold-out
   accounts clip and hide the way every wound-down account does.
   Identity: `accounts.import_key` = `import:afp|afp=<afp>|fund=<fund>` on all three
   (`import:afp|afp=uno|fund=A` replaces `import:excel|key=afp` on 78). Every reader that found
   «the AFP account» by import key resolves it by series instead (decision 6).
2. **Transit.** A fund switch is dated the day the **receiving** fund's credit price shows
   (the certificate's «Traspaso Ingreso» row, dated like every other row: the day its valor cuota
   first shows in the receiving fund's display series). The **sending** fund's display series
   **ends on the day its sale price shows** (the «Traspaso Egreso» row's day), so between sale
   and credit the sending account still holds its cuotas and the on-or-before price read keeps
   them at exactly the pesos that left — no phantom P/L couplet, no synthetic series. A fund
   series is written only over the days an account of this ledger held it.
3. **Scope.** History only: the three-account chain, the generic machinery (any AFP, any fund)
   and the script that builds it. April 2027 adds one account, one display series and one switch
   transfer with the same pieces; the UNO official sync stays Fondo A until then.
4. **The fund-switch transfer.** One `movements` row: `from_account_id` = the sending fund,
   `to_account_id` = the receiving fund, `amount` = the pesos the sender's sale produced (the
   egreso row's printed pesos), `currency = 'clp'`, `units_delta` = the cuotas SOLD (the
   from-leg), a **new column `counter_units_delta`** = the cuotas BOUGHT (the to-leg),
   `flow_kind = 'afp_fund_switch'`. The certificate prints what each fund booked, and the two
   figures differ: 2018 by 546 pesos, 2020 by 120.501 (2 %) — the receiving fund credited more
   than the sender sent. That gap is reported, kept in the note, and shows as the receiver's P/L
   on its first day (its cuotas × its price exceed the pesos that arrived); it is not an error.
   `counter_units_delta` is allowed only on a transfer (`account_id IS NULL`), enforced by the
   writers and the create validation (SQLite cannot add a CHECK through ALTER).
   `transferLegUnitsThroughDate` reads the to-leg as `counter_units_delta ?? units_delta`, the
   from-leg as `units_delta` — every existing transfer (null counter) is unchanged.
5. **Series.** One display series per (AFP, fund) in the display frame, keyed
   `afp_<afp>_cuota_<fund>`: `afp_uno_cuota_a` (unchanged), `afp_planvital_cuota_a`,
   `afp_modelo_cuota_a`; helper `afpDisplaySeriesKey(afp, fund)` beside
   `AFP_UNO_CUOTA_SERIES_KEY`. Every AFP account declares its series on `fund_series_key`
   (78 gets `afp_uno_cuota_a` explicitly); `cuotaLedgerSeriesKeyForAccount` for kind `afp` returns
   the column, with `afp_uno_cuota_a` as the kind's default when the column is null (test fixtures
   and demo DBs) — the «earlier funds through their last day, then UNO» rule is gone, and so is
   `afp_prior_funds_a` (its rows deleted by the script).
6. **Who is «the AFP account».** `afpAccounts.ts`: `liveAfpUnoAccountId()` = the single `afp`-kind
   account whose `fund_series_key` is `afp_uno_cuota_a` (none or several throws). It replaces the
   `import:excel|key=afp` lookups in `pensionAccountCertificatesApply.ts` (both applies),
   `globalSyncAll.ts` (`runAfpUno`), `globalSyncStale.ts` and the rebuild script;
   `accountSyncSources.ts` infers `afp_uno` from `fund_series_key === afp_uno_cuota_a`, not the
   import key.
7. **Stored `valuations`.** Account 78's rows dated before the UNO credit day are deleted (those
   days belong to the earlier funds, whose accounts are valued from ledger × series with no
   stored rows at all). The chart-date grid of an AFP account without `valuations` rows must come
   from its cuota history, like Fintual's (`augmentChartDatesForFintualCertAccounts`): month-ends
   from the first units movement or transfer leg through the last, plus the switch days.
8. **Display ticker.** `cuotaLedgerDisplayTicker` takes the series key: `PLANVITAL-A`, `MODELO-A`,
   `UNO-A` (AFC unchanged).
9. **Contribution periods.** The moved rows get new ids; `pension_contribution_periods` is
   re-recorded from the certificate for them. `payslipChecks.ts` already sums every `afp`-kind
   account by period.

## Pieces

### A. Movements: `counter_units_delta` + `afp_fund_switch` (schema + readers)

- Migration `242_movements_counter_units_delta.sql`: `ALTER TABLE movements ADD COLUMN
  counter_units_delta REAL`. Mark-input triggers (`markInputChangeTriggers211.ts`): check that an
  UPDATE of `counter_units_delta` on a transfer logs both legs' accounts; extend the trigger
  column list if it names columns.
- `movementTransfer.ts` `transferLegUnitsThroughDate`: to-leg units = `counter_units_delta ??
  units_delta`.
- `movementFlowType.ts`: `FLOW_KIND_AFP_FUND_SWITCH = "afp_fund_switch"`, its display type and
  i18n label (es «Traspaso AFP», en «AFP fund switch») in `client/src/i18n/master.json` +
  `npm run i18n:generate -w nw-tracker-client`.
- `accountDeposits.ts`: a fund switch's legs are ordinary transfer legs (withdrawal from the
  sender, deposit into the receiver; inside the AFP group they cancel). Confirm, do not special-case.
- Create/update API and `movementUnitsPolicy.ts`: accept `counter_units_delta` on a transfer whose
  both endpoints are units accounts; refuse it on a single-leg row or where `units_delta` is null.
- Tests: `movementTransfer` units for a transfer with a counter (from −a, to +b); the policy
  refusals; a flow-type label test if one exists.

### B. Series and resolvers

- `afpUnoSeries.ts`: `afpDisplaySeriesKey(afp, fund)`; `AFP_UNO_CUOTA_SERIES_KEY` =
  `afpDisplaySeriesKey("uno", "A")`.
- `cuotaLedgerAccounts.ts`: decision 5; `cuotaLedgerDisplayTicker(kind, seriesKey)` (decision 8;
  update the callers — `accountPosition.ts` and whoever else).
- New `afpAccounts.ts`: `liveAfpUnoAccountId()` (decision 6) + `listAfpFundAccounts()`.
- Re-point `pensionAccountCertificatesApply.ts`, `globalSyncAll.ts`, `globalSyncStale.ts`,
  `accountSyncSources.ts` (and its test), the rebuild script's constant.
- `afpUnoOfficialSync.ts`: unchanged behaviour (UNO Fondo A only); `upsertAfpUnoDisplayRows`
  takes the series key so the split script can write any fund's display rows with the same
  note format (`sp:official|afp=<afp>|official=<day>|lag=1`).
- `valuationTimeseries.ts`: chart-date augmentation for cuota-ledger accounts without stored
  valuations (decision 7); the daily series needs nothing (marks are ledger × series).
- `accountPosition.ts` AFP branch: with 0 cuotas it already emits an explicit 0 mark — keep.
- Tests: series-key resolution by column; the live-account resolver (none / one / two);
  `accountSyncSources.test.ts` on the series-based inference; chart dates for an AFP account
  with movements and no valuations.

### C. The split script (after A and B)

`server/scripts/split-afp-ledger-into-fund-accounts.ts --cert=<rows.json> [--apply]`,
report-first, one IMMEDIATE transaction rolled back without `--apply`:

1. Input: the full-history movements certificate parsed by
   `npm run parse:afp-uno-certificate -w nw-tracker-ingest -- --pdf=cfraser/afp-uno-certs/Certificado_UNO-7.pdf --out=<rows.json>`
   (01/2013 → 07/2026). Only rows up to and including UNO's «Traspaso Ingreso» are used; UNO's
   own rows on 78 are never rewritten (the nightly reads own them).
2. Date every row as the rebuild does (`certificateRowPriceWindow` + `firstVisibleDayOfValue`
   over the official series of every AFP, display lag 1); pair the transfers out → in.
3. For each earlier fund: create the account (name, import key, asset group 24,
   `fund_series_key`), write its display series from `pension_fund_unit_official` from its first
   ledger day through the visible day of its sale, write its rows in ITS OWN cuotas through
   `shapePensionLedgerRows` with `factor = 1` (netted per day, periods recorded), and check
   that its rows + the transfer in (counter units) net to exactly the cuotas it sold.
4. Write each switch as the decision-4 transfer, dated the visible day of the ingreso row.
5. On 78: delete the rows dated before UNO's credit day (the converted earlier-fund rows and the
   rounding-residue row), delete `valuations` before that day, set `import_key`,
   `fund_series_key = afp_uno_cuota_a`, name «UNO-A»; delete `afp_prior_funds_a`.
   Check Σ cuotas on 78 after = 111,37 (the UNO ingreso, now carried by the switch's counter
   units) + the untouched UNO rows = the certificate's UNO net, to 4 decimals.
6. Report: per account the rows and cuotas; the Σ-of-the-three mark at every month-end before
   and after (expected equal to the peso except the transit days, which are now exact) and
   today's value before/after (must be equal).
7. Idempotent: a second run finds the accounts by import key and reports «already applied».
8. Re-seed the nav tree (or call the link step) so the new accounts join `retirement_afp_afc`.

Rehearsal: on a copy (`cp server/data/nw-tracker.db server/data/afp-split-rehearsal.db`,
`NW_TRACKER_TEST_DB=<abs path>`), never on the live DB — a tsx script that imports `db.js`
applies pending migrations to whatever DB it opens. The live apply is the user's.

### D. Docs

AGENTS.md: replace the «Cuotas are UNO cuotas from the first contribution» passage and the
`cuotaLedgerSeriesKeyForAccount` mentions; PARSERS.md «AFP ledger rebuilt…» gets the applied
figures. Memory note.

## Not in scope

The 2027 generational account (its series key, the UNO sync switching funds, the cohort name);
the UNO official sync generalised to other AFPs (the historical series are static); a UI to enter
a fund switch by hand (the script and the 2027 script write it).
