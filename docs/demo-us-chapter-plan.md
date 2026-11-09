# Demo person: the US chapter, and more depth in every bucket

Plan (2026-11-09). Extends the demo person of `docs/demo-generator-plan.md` with a story turn —
after about a year and a half as a contractor, the same company brings him into the US on a
direct contract at a higher salary — with a first rental apartment bought as an investment in
2020, and with the complexity the retirement, brokerage, cash and real-estate buckets lack
today. Each phase says what the app already supports (the demo shows
off existing features) and what must be built first (the demo is the feature's first user).

## Story (decided 2026-11-09)

- **A first rental, bought as an investment in 2020-03:** a ~55 m² apartment in Santiago Centro,
  1.800 UF (≈ CLP 51 M then), 20 % pie saved over two years at the first contrato job while
  living with his parents, a 25-year mortgage on the rest (1.440 UF, ~2,5 %: a dividendo near
  6,5 UF a month). Rented out from day one through an agency (CLP 350–400k a month in 2020,
  indexed yearly), one vacancy month a year, the agency's fee, gastos comunes and contribuciones
  on the owner. He keeps living with his parents, then in the apt1 / apt2 rentals, as now.
- **One DFL-2 rental, one not.** The Centro apartment is a «vivienda económica» (≤ 140 m²
  built, certified at the building's reception; acquired in 2020, inside the pre-2023 regime):
  its rent is exempt from income tax for a natural person with up to two DFL-2 properties (art.
  15 of the decree: neither the global complementario nor the adicional), and its contribuciones
  are halved for 20 years (≤ 70 m²; 15 at 71–100, 10 at 101–140) from the building's reception.
  Value plays no part in DFL-2. **Vitacura is not DFL-2** (a tower above the economic-housing
  standard): its rent is taxable income — art. 20 N°1 b) LIR, renta efectiva por contrato, the
  contribuciones paid as a credit — so the F22 gets a taxable-rent line beside the exempt one
  (the Suplemento's line and codes to confirm). A `dfl2` flag per place drives both.
- **Move date 2024-04.** Contractor at Northwind Labs 2022-10 → 2024-03 (18 months), then an
  L-1B intracompany transfer: US W-2 employee of Northwind Labs Inc. from 2024-04, US$150.000
  a year, a raise every April. The Bluepeak contractor job (2024-10 →) goes.
- **Austin, Texas.** No state income tax, so the US tax module starts federal-only; a state
  table is a later addition behind the same jurisdiction model.
- **Vitacura (bought 2024-03, his home for two months) becomes the second rental from 2024-06**,
  through the same agency; both mortgages are paid from the rents, the shortfall by dollar
  transfers. Two loans at once is what the app does not support yet (phase 4a).
- **Stays in the US through today.** A return to Chile is a possible later chapter.
- **Chilean tax resident throughout.** With two properties, two mortgages and the APV in Chile
  his «asiento principal de negocios» stays there (art. 4 LIR), so he keeps declaring worldwide
  income in the F22, with the treaty credit for the US tax on his salary (treaty in force since
  2024). The DFL-2 rent enters exempt. No non-resident F22 mode is built (a non-resident would
  owe Impuesto Adicional only on non-exempt Chilean-source income — the art. 107 sales, DAP
  interest — a different chain; optional later, phase 8).
- **US tax resident from 2024** (he passes the substantial presence test in 2024; the
  dual-status first year is simplified to a full resident year — noted on the demo page).

## Payroll is per jurisdiction, not per currency

The Deel payslips are the proof: dollars, under Chilean rules (fee income, boletas, F29). The
axis is the **jurisdiction**, each with its own parameter set per period and its own rules:

| | Chile (exists) | US federal (new) | US state (later) |
|---|---|---|---|
| Parameters | `payroll_parameters` + `payroll_afp_rates` per month (Previred) | per tax year: brackets, standard deduction, Social Security wage base, Medicare rate, 401(k) and HSA limits, Roth IRA phase-out | per year: brackets or flat rate; none for TX |
| Line kinds | `PAYSLIP_HABER_KINDS` / `PAYSLIP_DESCUENTO_KINDS` | wages, bonus, RSU; federal withholding, Social Security, Medicare, 401(k) pre-tax, 401(k) Roth, HSA, health premium (pre-tax), dental/vision, employer match (memo) | state withholding, SDI |
| Checks (`payslipChecks.ts`) | AFP rate, health ≥ 7 %, AFC, IUSC by the monthly table | FICA to the cent against the wage base; federal withholding against the percentage method (Pub. 15-T) for a given W-4 | state withholding |
| Pay period | monthly | biweekly (26) or semi-monthly (24) | — |
| Return | F22 (`f22Draft.ts`) | 1040 (`f1040Draft.ts`, new) | state return |

Model: `payroll_work_earnings.jurisdiction` (`cl` | `us`; `cl` backfilled), a jurisdiction
on each parameter table (the US one its own table keyed by tax year; the dated US law — brackets,
standard deduction, wage base, limits — a sibling of `legalParameters.ts` with its rule: a year
the table does not list throws, refreshed each January like the Chilean one), line kinds namespaced
by jurisdiction (the kind classifier takes the jurisdiction; a US label in a Chilean payslip is
an error, as today's unknown labels are), and every reader that recomputes or files a payslip
dispatches on it. The payroll breakdown (`payrollBreakdown.ts`) already prices a dollar payslip at
its stored rate; its deduction groups gain the US kinds.

## Phases

### Phase 1 — Depth from existing features (generator only, no app code)

All of these the app supports today; the generator just never produced them. New accounts take
their import key from a builder in `accountIdentityKeys.ts` (the AFP builder still lives in the
demo; `kind=fund` has none) and their roles from `account_roles` (IBKR's cash is
`broker_cash` with param `ibkr|usd`); new rows go through the write funnels (`movementWrites.ts`,
the real importers), not more raw `INSERT`s in `generate.ts`.

- **The three 10 % AFP withdrawals** (2020-08, 2020-12, 2021-05; 10 % with the 35 UF floor /
  150 UF cap, the whole balance when under 35 UF), as `withdrawal` rows of the cuota ledger.
- **Fund A throughout** (decided 2026-11-09): the person never changes fund, only AFP (Modelo →
  UNO in 2020-02, as now). A fund switch would need a fund-E official series and a sync that reads
  more than Fondo A (`afpUnoOfficialSync.ts`); not worth it for the story.
- **APV régimen B monthly** in the contractor years (2022-10 → 2024-03), up to the 600 UF cap,
  so the fees box's 770 bites; régimen A with the state bonus in the earlier low years (as now).
- **Rolling 90-day peso DAPs** 2021-03 → 2023-12 (saving the Vitacura pie), interest to
  checking, the bank's DJ 1890 for each year (code 152 in the F22, unused today).
- **The Chilean ETF** (CFIETFIPSA.SN) bought with pesos at the Chilean broker 2025-06, part
  sold 2026-03: the art. 107 section (10 % flat tax, both cost options) fills in.
- **A losing sale beside a winning one** in 2024 (e.g. the ZM-style play closed at a loss the
  same year as the NVDA sale) for the loss-offset panels.
- **The NVDA 10:1 split (2024-06-10)** recorded on the 40 % he still holds (`recordEquitySplit`,
  Yahoo-adjusted prices are already what the market load stores).
- **Interactive Brokers** as a second US broker from 2024-05 (US resident: W-9, no withholding
  on dividends — his Chilean broker keeps the 15 %): «IBKR USD» cash under Cash savings, SGOV as
  his dollar reserve with monthly distributions, new SPY buys there; the stock page's «held at»
  split shows.
- **Sweep interest** on idle IBKR dollars, booked monthly (`savings_earnings`, like Fintual's).
- **Net-worth target**: the invariant's US$400k ± 25 % moves with the story (≈ US$600–700k by
  today at US$150k plus two apartments' equity); set after phase 2.

### Phase 2 — US payroll and the US checking account

- `person.ts`: job kind `us_w2` (employer, start, annual salary, raise month, pay frequency,
  401(k) rate and employer match, health premium, W-4 posture).
- `simulate.ts`: biweekly pay into a US checking account (new asset group under Checking
  accounts, USD, a fictional bank; `bank_account_numbers` for it); FICA, federal withholding by
  the percentage method, 401(k) and premium pre-tax; a dollar lifestyle (rent in Austin, groceries,
  car), the cash band kept in dollars; monthly transfers to Chile covering the mortgage shortfall.
- US payslips written as documents (`payroll_work_earnings` with `jurisdiction = 'us'`, lines
  with US kinds, `source_pdf` a fictional ADP stub), through a US branch of the payslip import,
  so the import validates the sums as it does for liquidaciones. W-2 per year as a document.
- Income page: the gross-vs-net chart handles the new deduction groups; the payslip checks
  recompute FICA and federal withholding.
- Expenses: debits of a dollar checking account as gastos lines (today the checking gastos
  loaders read the peso cartola; a dollar account's debits need the same treatment, priced
  at the day's rate in the peso views). Until phase 7 all US spending is debit.

### Phase 3 — US retirement accounts

- **401(k)**: a fund account valued in dollars, contributions and the employer match bought
  every payday; nav group `retirement_us_401k` under Retirement, colour, sync source none. The
  contributions are pre-tax deposits (`deposits_pre_tax`, like AFP / AFC) in the flows overview.
  **Two ways to value it, to decide first:** (a) USD `valuations` as book marks — any currency
  since migration 260, converted once at the account's side (`book_mark` quantity source) —
  generator only, no units; (b) units × a target-date fund's daily value, like the APV accounts
  in pesos — but `fund_unit_daily` has only `unit_value_clp` and `holdingPrices.ts`'s fund
  branch hardcodes `clp` although `Holding { kind: "fund", quote }` carries a quote currency, so
  (b) is app work: a currency on the series table and `fundPriceAt` honouring `quote`.
- **Roth IRA** (optional): US$7.000 a year from 2025, after-tax, invested in SPY at IBKR; the
  1040 shows nothing for it (that is the point), the MAGI check decides eligibility.
- **HSA** (optional): pre-tax, small.
- **Retirement splits by country on the demo:** two new sub-buckets under Retirement —
  **Chile** (`retirement_cl`, route `/inversiones/retiro/chile`), under which the whole existing
  subtree moves with its shape kept (AFP + AFC → AFP, AFC; APV → APV A, APV B), and **US**
  (`retirement_us`, `/inversiones/retiro/us`), where the new accounts live (401(k), Roth IRA, HSA
  as leaf groups). Mechanics, like the IPSA / SOXX units (`linkBucketSubtree`, `brokerage_soxx`):
  two `portfolio_groups` with `parent_slug: retirement` and their `asset_groups`, the Chilean
  leaf asset groups reparented under `retirement_cl`'s (leaf slugs, and so every account's kind
  slug, unchanged); `rebuildRetirementNav` links AFP + AFC and APV under `retirement_cl` when
  that group exists and straight under `retirement` otherwise, so the personal instance keeps
  its tree (`db.ts`'s asset-group seed and `chartColorRgb.ts`'s synthetic grouped ids gain the
  two groups; colours on the groups). The Retirement card's breakdown then reads Chile / US,
  the value map nests two frames, each country page shows its own children, and the
  Inversiones perf series (keyed on `retirement`) is untouched; the proxy/basket logic too (the
  401(k) fund is a plain unit series). Sidebar-nav and nav-snapshot caches bump a version.

### Phase 4a — Several loans and properties (app)

The storage is per loan already (`loan_payments.loan_account_id`), and since the untangle merge
the identity is data too: the property holds the `property` role and its mortgage `loan_of
<property id>` (`account_roles`, migration 271; `lender_pattern` rows on the loan name the
lender as the card prints it), seeded from the import keys by the `accountRoles271.ts` triggers.
What is still «the one pair»: `deptoLedgerFromMovements.ts` reads
`accountWithRoleOptional("property")` («exactly one property for now»), and
`mortgagePaymentCreate.ts` exports the singletons `deptoPropertyAccountId` /
`deptoMortgageAccountId`, read by `upcomingPayments.ts`, `mortgageSheetPaymentsApply.ts` and
`dailyReferenceLines.ts`; the quantity source `depto_loan { propertyAccountId }` is per property
already, `depto_property` is not; `seedLiabilitiesTree.ts` already links every `loan_of`
account. So: one depto ledger per `property` role holder, delete the two singletons, and the
dashboard card, the upcoming payments, the reference lines, the mortgage page, the prepayment
comparison and the real-estate expenses' mortgage rows loop over the pairs. The demo's 2020 and
2024 purchases are then two more role rows (a second property's import key needs its builder and
trigger rule, or the generator writes the roles). The personal app has one pair and must read
exactly as before (parity on a real-DB copy).

### Phase 4b — The rentals

- Housing: the Centro apartment as a rented investment from 2020-03 (`person.ts`: a property
  bought to rent, beside the lived-in kinds), Vitacura rented from 2024-06: rent credited monthly
  to checking net of the agency's 7 % (income kind `rent`, new in `CHECKING_INCOME_KINDS`), one
  vacancy month a year, the agency's invoice as a gasto, the tenant's deposit as a liability
  (optional).
- Gastos comunes and contribuciones land on each place (real-estate page per place; the DFL-2
  halving of contribuciones while the window lasts); each mortgage is paid from checking (rents +
  transfers after 2024-04).
- F22: a `dfl2` flag per place; the Centro rent is shown entering exempt; Vitacura's is a
  taxable-rent line the module gains (art. 20 N°1 b): the year's rent per contract, the
  contribuciones paid as a credit; the line and codes from the Suplemento), so from AT2025 the
  Chilean return has a rent line beside the salary credit. A code that enters 158 / 304 is added
  in `f22Identities.ts` (`assertF22Identities` must still hold), never in `f22Draft.ts` alone.
- The 1040 (phase 5) taxes both rents as foreign rental income, less expenses and depreciation —
  v2 of the module.

### Phase 5 — The US tax module (1040)

- `f1040Draft.ts`: per tax year, from the US payslips: wages (box 1 = gross − 401(k) − premiums),
  standard deduction, the brackets, FICA reported, withholding credited → refund or payment;
  Texas: no state return. Parameters per tax year in the US payroll parameters table.
- The generator's April loop (`taxDocuments.ts`) runs both modules: the F22 settlement in
  pesos and the 1040's in dollars (refund into US checking ~ late April). A filed 1040 is
  stored like the F22 (`sii_f22_filed`'s US twin, or one table with a jurisdiction column).
- The tax page gets a jurisdiction tab per year with a US return.
- **v2**: 1099-DIV / 1099-INT (IBKR dividends, SGOV interest, sweep interest), qualified
  dividends; foreign rent (Schedule E) and the Chilean broker's dividends with the foreign tax
  credit (Form 1116). FBAR / FATCA are realism notes, not modelled.

### Phase 6 — The F22 across the border

- Income 2024: fees Jan–Mar (the fees box, exists) + US salary Apr–Dec as foreign-source
  income with the treaty credit, and every later year the same — which line and credit cap the
  Suplemento gives a foreign salary (the module uses 1104 / 748 / 1018 for foreign dividends and
  share gains; a salary may share them or need its own), the exempt DFL-2 rent beside the taxable
  Vitacura rent (phase 4b), the IBKR dividends and interest as foreign income with credit.
- Validation: the April loop must still converge (the F22's credit reads the 1040's tax, so the
  1040 is drafted first).

### Phase 7 — A US credit card

- A third issuer in `CC_ISSUERS` (fictional, USD-only, monthly statement, pay-by rule), the
  statement rendered through the parsed-statement contract (USD side only), paid from US
  checking; US spending moves from debit to the card; «Próximos pagos» lists it in dollars.

### Phase 8 — Optional, app features first

- **A non-resident F22 mode** (Impuesto Adicional on non-exempt Chilean-source income) if the
  story ever makes him lose Chilean domicile.
- **UCITS ETFs** (CSPX / VWRA at IBKR, the estate-tax-safe choice a Chilean would make before
  becoming a US resident): a London market calendar and pricing in `equityQuote.ts`.
- **Options**: a new instrument kind (contract, expiry, premium), valuation, tax lots.
- **A return to Chile**: the reverse transition.

## Order and dependencies

1 is independent and cheap (a day; snapshot the demo DB before). 2 → 3 → 5 is the spine (the
1040 needs the payslips; the 401(k) changes box 1). 4a is app work that can start at once and
must land before 4b; 4b can run beside 3. 6 needs 5. 7 is independent of 3–6. Each phase re-runs the generator (the April loop converges in a few passes;
budget the Render build time) and updates the About page's copy, the tour and the invariants.

## Rules of the merged tree (every phase)

- A new table is listed in `markInputTriggers.ts` (write-logged, or declared unlogged), else
  `cacheRegistry.test.ts` fails; a table a historical mark reads also needs a trigger spec.
- A payload shape lives in `server/contracts/src/dto/*` and bumps `DTO_SCHEMA_VERSIONS`
  (`schemaVersions.ts`; `sidebar_nav` is the nav-tree version the retirement split bumps); client
  types are re-exports. A field on an ingest kind (`jurisdiction` on `employment.payslips`) bumps
  that kind's `schema_version`.
- Writes go through the funnels (`movementWrites.ts`, `applyEmploymentPayslips`, …); account
  identities through `accountIdentityKeys.ts` and `account_roles`.
- Migrations continue from 297.

## Out of scope

Real ingest of US documents (ADP, IBKR statements, 1099s): the demo writes them directly, as it
does the contractor payslips; the ingest kinds come when a real user needs them.

## Execution plan (2026-11-09)

### Where the work runs

- **Integration branch `claude/demo-us-chapter-plan-6a9e1a`** (worktree
  `.claude/worktrees/fervent-einstein-142b41`), cut from `main` at the commit that adds this file.
  Each stream works in its own worktree `.claude/worktrees/us-<stream>` on branch `us-<stream>`,
  branched from the integration branch, and is merged back once its checks pass. `main` moves only
  when the user says so (pushing `main` deploys to the home server; the demo deploys from `demo`
  through `npm run release:demo`, never unasked).
- **This laptop has no live database.** Unit tests run on the Vitest person; the generator is
  rehearsed on the synthetic market (`NW_TRACKER_TEST_DB=<fresh file> npx tsx
  scripts/generate-demo-data.ts`, from `server/`; `--real-market` needs the network and the Banco
  Central credentials and is the Render build's job). Phase 4a's «reads exactly as before» is shown
  on the Vitest person (one property, one loan) by comparing payloads before and after.
- **Checks every stream runs before merge:** `npm run typecheck` (root; includes
  `check:conventions` and `check-deps`), `cd server && npm run test`, `npm run test -w
  nw-tracker-client`, `npm run test -w nw-tracker-contracts`, and for a generator stream both
  people regenerate (`--test` and the demo person on the synthetic market) with the invariants
  passing. A worktree shares this checkout's `node_modules` by symlink (root, `server/`, `client/`;
  the Recharts patch is already applied there) and generates its own test DB on the first server
  test run.
- **Conflicts are avoided by file ownership:** each brief names the files it owns; a change
  another stream's files need is a note in the report, not an edit. Streams in one wave own
  disjoint files; `client/src/i18n/master.json` is the one shared file (each stream adds keys in
  its own section; the locale files are regenerated once at the merge).
- **Models:** the streams run on Opus unless the table says otherwise (plumbing and copy on
  Sonnet); the integration — briefs, merges, re-checks, the plan's status notes — on Fable.
- **The user's rule: one wave at a time.** When a wave is merged and green, the integrator reports
  and stops; the next wave starts on the user's «go».

### Decisions taken for the build

- **401(k) valuation: (b), units × a dollar fund series.** `fund_unit_daily` already carries
  `currency` (migration 257; every stored row `clp` — the 298 this plan first named was not needed); `fundPriceAt` prices a fund in the series' currency and
  `accountProfile` gives a fund holding its series' quote; every legacy reader of the column that
  assumes pesos asserts `clp` (fail fast), as the valuations readers do since migration 260. The
  401(k) is then a cuota ledger like the APV accounts, priced daily.
- **The US law lives in code**, `usLegalParameters.ts`, a sibling of `legalParameters.ts` keyed by
  tax year (brackets by filing status, standard deduction, Social Security wage base and rate,
  Medicare rate and the additional 0,9 %, the 401(k), HSA and IRA limits with the Roth phase-out,
  Pub. 15-T's percentage-method tables for the W-4 postures the demo uses); a year it does not list
  throws. No document imports these figures, so there is no table for them (the Chilean
  `payroll_parameters` exists because Previred's PDF does).
- **`retirement_cl` / `retirement_us` are created where the story needs them.** `db.ts` seeds the
  two asset groups under `retirement`; the portfolio-group rows (and the reparenting of the Chilean
  leaf asset groups under `retirement_cl`) are written by the demo generator, and
  `rebuildRetirementNav` links by what exists, so the personal instance keeps its tree untouched.
- **Migrations:** 297 `payroll_work_earnings.jurisdiction` (+ pay period, pay date, W-4 status, a
  `memo` line side), 298 the property / loan identity roles (`us-loans`, renumbered from 299 at the
  merge); later ones numbered by the stream that needs them in the order the waves merge (the
  integrator renumbers at merge when two streams took the same number).

### Waves

**Wave 1 — the app work the chapter needs, beside the cheap generator phase (4 streams, parallel).**

| Stream | Phase | Owns | Model |
|---|---|---|---|
| `us-depth` | 1 (generator only: the three 10 % AFP withdrawals, APV-B monthly in the contractor years, rolling peso DAPs 2021-03 → 2023-12 with DJ 1890, the Chilean ETF bought 2025-06 and part sold 2026-03, a losing 2024 sale, the NVDA 10:1 split, IBKR as a second broker with SGOV and sweep interest) | `server/src/demoData/**` and its tests, `server/scripts/generate-demo-data.ts`, `server/data/demo/**` | opus |
| `us-loans` | 4a (one depto ledger per `property` role holder; the two singletons deleted; every reader loops over the pairs; parity on the one-pair database) | `deptoLedgerFromMovements.ts`, `mortgagePaymentCreate.ts`, `mortgageSheetPaymentsApply.ts`, `upcomingPayments.ts` (mortgage part), `dailyReferenceLines.ts`, `liabilityTree.ts`, `mortgagePrepaymentComparison.ts`, `flowsRealEstateExpenses.ts` + `flows/loanPaymentParts.ts` (mortgage rows), the depto quantity sources in `accountMarkClpAtYmd.ts` / `accountProfile.ts`, `accountRoles.ts`, `accountIdentityKeys.ts`, `accountRoles271.ts`, the dashboard real-estate card builder, the mortgage routes and the client mortgage / Pasivos pages where they assume one loan | opus |
| `us-payroll-model` | 2, app side (jurisdiction on `payroll_work_earnings`, US line kinds, `usLegalParameters.ts`, the checks' US branch — FICA, percentage-method withholding —, the breakdown's US deduction groups, the US branch of `applyEmploymentPayslips` with the sums validated, the contract's `jurisdiction` field and version bump; Chilean readers — `payrollTaxYear`, `f22Draft` — leave US payslips out) | `payslip*.ts`, `payroll*.ts` (server), `usLegalParameters.ts` (new), `server/contracts/src/kinds/employmentPayslips.ts`, migration 297, the income page's gross-vs-net client code | opus |
| `us-retirement-nav` | 3, app side (the Chile / US split of the Retirement tree — seeds, `rebuildRetirementNav` by presence, synthetic colour ids, label keys, `sidebar_nav` + nav-snapshot version bumps — and the fund series currency: migration 298, `fundPriceAt` by quote, legacy readers assert `clp`) | `seedNavTree.ts`, `db.ts` (asset-group seed), `chartColorRgb.ts`, `navTreeRoles272.ts`, `client/src/sidebarNavFromApi.ts`, `client/src/dashboardNavSnapshotCache.ts`, `schemaVersions.ts`, `holdingPrices.ts`, `accountProfile.ts` (fund quote only — coordinate: `us-loans` owns its depto branch; both edit different functions), `fundUnitDaily.ts`, `cuotaLedgerAccounts.ts`, migration 298 | opus |

**Wave 2 — the chapter itself in the generator, beside the rentals' and the card's app work (3 streams).**

| Stream | Phase | Owns | Model |
|---|---|---|---|
| `us-chapter-gen` | 2 + 3, generator (the `us_w2` job, the US checking account and its gastos — a dollar checking account's debits as expense lines, priced at the day's rate in the peso views —, biweekly payslips through the US import branch, W-2 documents, the dollar lifestyle and the transfers to Chile, the 401(k) ledger on a USD fund series, Roth IRA and HSA, the `retirement_cl` / `retirement_us` groups written by the generator) | `server/src/demoData/**`, the checking-gastos loaders for a dollar account (`flowsCheckingGastos*.ts`, `checkingCartolaLoaders.ts` as needed) | opus |
| `us-rentals-app` | 4b, app (a `dfl2` flag per place, the `rent` income kind, the F22's taxable-rent line and contribuciones credit through `f22Identities.ts`, the exempt DFL-2 rent shown entering) | `f22*.ts`, `flowsCheckingIncomeOverrides.ts`, the real-estate places' schema and routes, the tax page's rent rows | opus |
| `us-card-issuer` | 7, app (a fictional USD-only issuer in `CC_ISSUERS` with its close and pay-by rules; the statement renders through the parsed-statement contract's USD side) | `ccIssuers.ts`, `ccInstallmentPayBy.ts`, `ccStatementLineRules.json` entries, their tests | sonnet |

**Wave 3 — the rentals in the generator, the 1040 (2 streams).**

| Stream | Phase | Owns | Model |
|---|---|---|---|
| `us-rentals-gen` | 4b, generator (the 2020 Centro apartment with its mortgage and rent from day one, Vitacura rented from 2024-06, agency fee, vacancy month, gastos comunes and contribuciones per place with the DFL-2 halving, both mortgages paid from checking; the US card's statements and payments, phase 7's generator part) | `server/src/demoData/**` | opus |
| `us-1040` | 5, app (`f1040Draft.ts` from the US payslips, the filed-1040 storage, the tax page's jurisdiction tab; v1: wages, standard deduction, brackets, FICA reported, withholding credited) | `f1040*.ts` (new), the filed-return table and its migration, `routes/taxReturn*`, the tax page client code | opus |

**Wave 4 — the border, and the finish (2 streams, the second after the first).**

| Stream | Phase | Owns | Model |
|---|---|---|---|
| `us-f22-border` | 6 (the F22's foreign salary with the treaty credit, IBKR dividends and interest as foreign income; the April loop drafts the 1040 first and settles both) | `f22*.ts`, `demoData/taxDocuments.ts`, `demoData/generate.ts` (the loop) | opus |
| `us-finish` | the net-worth target, the invariants, the About page's copy and the tour, both people regenerated, the Render build budget checked | `server/src/demoData/invariants.ts`, `person.ts` (target), the About / tour client code and `master.json` | sonnet |

Phase 8 is out of this plan.

### Agent briefs, in common

Every brief carries: the phase of this file it implements (read first, with GUIDELINES.md and the
AGENTS.md sections it names), the files it owns, the checks to run, the rule that a change outside
its files is a note not an edit, the GUIDELINES rules (fail fast, no fallbacks, free text is
provenance, server computes / client picks, tests on synthetic fixtures only, English identifiers,
i18n for copy), the commit convention (small commits on the stream branch, no co-author trailer),
and the report shape: what changed, what was left as a note for another stream, the check results
verbatim, the decisions it took.

### Wave 1 status (2026-11-09): merged into the integration branch, green

Four streams landed (us-retirement-nav 4db62848, us-payroll-model e9baa075, us-loans + the 299→298
renumber, us-depth), no merge conflicts. On the merged tree: `npm run typecheck` ok (conventions +
check-deps ok), server 483 files / 3197 tests on a fresh test DB, client 474, contracts 126, ingest
481; both people generate on the synthetic market with the invariants passing — the demo person
US$367.491 (337,9 M CLP; 2.083 movements; 3 tax passes; 30 s), the test person US$28.302 (3 s).
Not merged to `main`.

### Notes from wave 1 (for waves 2–4)

- **Environment:** a worktree must not symlink the whole `node_modules` of a sibling checkout —
  the store's `nw-tracker-*` workspace links then point at the SIBLING's sources (a stream
  type-checked against the old contracts), and the integration worktree's store was stale
  (Recharts 2 against the lock's 3.10.1). Now: a fresh `npm ci` lives in
  `.claude/worktrees/us-deps` (better-sqlite3 built by hand — npm 11 skips install scripts; the
  Recharts patch applied) and every worktree gets a `node_modules` DIRECTORY of links into it with
  the four workspace packages pointing at itself (`server/`, `ingest/` node_modules linked too);
  the script is the integrator's `link-deps.sh`. The streams' «client typecheck fails on
  recharts» / «imapflow missing» were this, nothing else.
- **For `us-chapter-gen` (phase 2 + 3 generator):**
  - A US pay stub payload: `jurisdiction: "us"`, `pay_period: "biweekly"`, `pay_date`,
    `period_start` / `period_end`, `employer {name, ein}`, `w4 {filing_status}`, `gross_pay`,
    `total_deductions`, `net_pay`, lines with sides `haber` / `descuento` / `memo` (the employer
    match is a `memo` line, outside the sums; an RSU vest is an earning plus an `RSU Offset`
    deduction). The worked example is the fixture in `server/src/usPayslips.test.ts`; the labels
    the classifier accepts are listed in `payslipLineKinds.ts`. FICA wages = gross − (medical +
    dental/vision + HSA); withholding = `usPercentageMethodWithholding(wages − pre-tax 401(k) −
    cafeteria, freq, status, year)` + `usSupplementalWithholding(bonus + RSU, prior, year)`;
    Social Security / Medicare through `usSocialSecurityTax` / `usMedicareTax` with the employer's
    year-to-date wages. A stub pairs with a single-leg USD credit of exactly `net_pay`, pay date
    −2 … +3 days — the US checking account's credits must reach the income lines
    (`buildFlowsCheckingIncomePayload`), else the invariants report the stubs unmatched. Chilean
    payloads now carry `jurisdiction: "cl"`, `pay_period: "monthly"` (`render.ts` already does).
  - The retirement split: create the US accounts first, then `ensureRetirementCountrySplit()`
    (`seedNavTree.ts`; idempotent — reparents the Chilean leaf asset groups, creates the five
    portfolio groups, reseeds); an empty US leaf is left out of the tree, so call `seedNavTree()`
    again after creating accounts if the split ran earlier. The 401(k): asset group
    `retirement_us_401k__us_401k` (kind `us_401k`, a cuota ledger), `fund_series_key` its own key,
    rows through `writeFundUnitSeriesRows({seriesKey, currency: "usd", rows})`, contributions as
    single-leg movements with `units_delta` and the dollars; HSA on `retirement_us_hsa__hsa`
    (kind `hsa`); the Roth IRA on `retirement_us_roth_ira__roth_ira` holds SPY shares
    (`equity_ticker`). 401(k) and HSA kinds are payroll-funded (pre-tax deposits); the pension rows
    in `flowsDeposits.ts` filter `amount_clp > 0`, so a dollar contribution may need the peso leg
    handled there (check). The position card prices a dollar fund at its price day's stored rate,
    today's value at the live rate.
  - `person.ts` gained `splits`, `afpWithdrawals`, `dap`, `ibkr`, `apv.monthly` and the play kind
    `buy_clp`; stock holdings are tracked per broker in `simulate.ts` (`buyStock` / `sellStock` /
    `depositBrokerUsd` take the cash account; `dollarBroker(month)` routes new dollars);
    `DIVIDEND_WITHHOLDING_RATE` is exported and `taxDocuments.ts` reads the IBKR role to withhold
    0 % there. Job 3 still runs to 2024-09 — phase 2 moves its end to 2024-03 and routes the US
    salary. Peso sweeps after 2024-05 still buy SPY at the Chilean broker; only dollars go to IBKR.
  - A second property and loan: `propertyAccountImportKey("centro")` under a `real_estate__property`
    leaf, `loanAccountImportKey("centro")` under `liabilities__mortgage` (any order; the triggers
    seed `property` / `loan_of`), the lender as an `account_roles` row (`lender_pattern`, the words
    as the card prints them), the appraisal through `upsertPropertyAppraisalUf`, payments through
    `commitMortgagePayment(<loan id>, …)`. Use a different key per property. (Wave 3's
    `us-rentals-gen`, but the US checking and the transfers to Chile of wave 2 feed them.)
  - The DAP account has no import key (no `import:dap` builder exists) and IBKR's `broker_cash`
    role is written as data by the generator — a builder for each would be the clean form.
- **For `us-rentals-app` (F22):** `f22Draft.ts:374` / `:102` — code 152 (DJ 1890 positive −
  negative) can come out NEGATIVE (the demo's DAP interest under 2022 inflation: AT2023 −93.321,
  AT2024 −211.470), and then `136 = 157 × 152 / 158` goes negative and raises 304. Check the
  Suplemento: a floor at 0, or the negative into 169. Also the APV regime rule changed in the
  generator: B when the IGC it saves beats A's 15 % bonus capped at 6 UTM (the old «marginal >
  15 %» picked A for 2023 at 13,5 %), so 2023 is B (770 = 13,2 M in AT2024).
- **Left global, deliberately (us-loans):** the scheduler's «is the mortgage sheet stale» query
  (MAX regular cuota over all loans), the UF-reminder toast route (any lender's newest line),
  `declareAccountsTrimmedTogether("depto_ledger")` over every property and mortgage, and the
  prepayment comparison's single `mortgage` benchmark — two loans at different rates would each
  need their own. The «Próximos pagos» item key is now `mortgage|<loan id>|<cuota>`.
- **Payroll decisions (us-payroll-model):** the W-4 posture is stored per payslip
  (`w4_filing_status`); a US payslip converts to pesos at the dollar mid of its pay date, at
  runtime; supplemental wages withhold at the flat 22 %; no catch-up in the 401(k) check (age
  unknown); the EIN is stored in `employer_rut`; 2025 withholding uses Pub. 15-T as published
  while the 1040 side uses the OBBBA deduction; the 2026 Pub. 15-T offset is `// provisional`
  (assumed = the 2026 standard deduction) — check it against the published tables; the other 2026
  figures (brackets, wage base 184.500, 401(k) 24.500 / catch-up 8.000, IRA 7.500, HSA 4.400 /
  8.750, Roth phase-out 153–168k) are from Rev. Proc. 2025-32 / Notice 2025-67 as recalled —
  worth one check too. The real-market generation (`--real-market`) was not rehearsed on the
  laptop (no Banco Central credentials); the ETF's pre-Yahoo closes come from the committed
  `server/data/demo/cfietfipsa-sn-2025-2026.csv`.

### Wave 2 status (2026-11-09): merged into the integration branch, green

Three streams landed on top of wave 1 — `us-card-issuer` (4cb75219, reworked in 5ec66161 after the
user flagged `accountStatementsAreUsdOnly`: a USD-only switch is not currency-agnostic and stood in
for two unrelated issuer facts), `us-rentals-app` (617615ff), `us-chapter-gen` (72f28b0c) — no merge
conflicts. On the merged tree: `npm run typecheck` ok (conventions + check-deps ok), server
487 files / 3233 tests on a fresh test DB, client 474, contracts 126, ingest 481, Python ok; both people
generate on the synthetic market with the invariants passing — the demo person US$397.292 (365,3 M
CLP; 3.907 movements; 67 US stubs, all paired and clean; 3 tax passes; ~45 s), the test person
US$28.302 (no US chapter; 7 s). Not merged to `main`. AGENTS.md gained the wave's conventions
(issuer data, dollar checking lines, DFL-2 + rent + the F22 rent codes, the US chapter).

### Notes from wave 2 (for waves 3–4)

- **Issuer data replaced the USD-only switch.** `CC_ISSUERS` rows carry `statement_currencies:
  {primary, secondary[]}`, `installments` and `unbilled_listing`; the close rule is
  `closedBillingMonthsFromStatements` (pure) over `requiredStatementCurrenciesForAccount`; the
  statement slot is a `Map<currency, statement>` and `primaryStatementOfSlot` picks the primary.
  No `"clp" | "usd"` union was added; the DTO fields that are peso / dollar by definition
  (`facturado_clp`, `facturado_usd`, `saldo_total_usd`) still read those two entries.
- **For `us-rentals-gen` (wave 3) — the US card (phase 7 generator):** master
  `credit_card_master|lonestar|<last4>` + a `credit_card_account_config` row (`issuer='lonestar'`,
  `card_last4`); statements as the demo's USD rows (`parser_layout "international_usd"`, `currency
  "usd"`, `card_group "A"`, only `amount_usd`, no CLP statement); headers:
  `statement_compras_cargos` = purchases, `statement_monto_facturado` = purchases + interest/fees
  (new charges, not the balance), `statement_deuda_total` = saldo + abono + monto_facturado,
  `pay_by` = close + 25, `next_period_*`; the previous payment a negative «PAYMENT - THANK YOU» /
  «AUTOPAY PAYMENT» line, interest/fees positive «INTEREST CHARGE …» / «LATE FEE» / «ANNUAL
  MEMBERSHIP FEE»; no open-cycle listing (do not render `renderOpenCycle` for it); the
  checking-side payment (US checking → card, a `pago_tarjeta` in dollars) is untested — check
  `convertCcPaymentMirrors` / the dollar payment path pairs it, and that «Próximos pagos» lists it in
  dollars (the fixture test asserts the card side only).
- **For `us-rentals-gen` — the rentals (phase 4b generator):** places through
  `createRealEstatePlace({slug, label, activeFrom, activeTo, propertyAccountId, dfl2: {dfl2: true,
  builtM2: 55, receptionYear}})` (Centro; Vitacura without `dfl2`); the halving window from
  `dfl2ContribucionesHalvedThroughYear` or the place's `dfl2_contribuciones_halved_through`; each
  rent credit on checking → `upsertCheckingIncomeMovementOverride(movementId, {income_kind: "rent",
  rent_place_slug})` (a single-leg peso credit on a checking-list account); contribuciones as bill
  rows (`expense_entries`, `category = 'contribuciones'`, `expense_account_id` = the place, by
  `spent_on` year — the real-estate assign path), so the taxable place's 1637 credit appears; the
  April loop picks 1849 / 955 / 1637 up by itself. The second property / loan keys are in the wave 1
  notes. **Fix the mortgage link while there:** the demo's mortgage card line (`MUTUARIA ANDES
  HIPOTECARIO`, every cuota) has no `funded_deposit` row in `flow_links` — the sync
  (`syncExpenseDepositLinksFromGastosLines`, or `syncMortgageExpenseDepositLinksFromSheet`) runs only
  from `expenseAssignmentWrites.ts`, which the generator never calls — so the whole cuota counts as a
  gasto while the dividendo deposit also counts, and the flows overview's «sin explicar» reads
  exactly one cuota (~1,3–1,5 M) every month from 2024-04. Pre-existing (the pre-plan tree shows
  it); call the sync after the card statements and the mortgage payments are written, for both
  loans, and make `invariants.ts` assert `cash_unexplained` within noise every month (the original
  generator plan's invariant, never enforced). Also from the generator stream: the wire sizing
  reads the Chilean trailing spend plus known needs — rents and the second mortgage move it; the US
  surplus is tight (net ≈ US$8,2k/month against ≈ US$4,2k of US spend; IBKR ends with ~US$2k cash
  plus the SGOV reserve); the Roth's SPY earns no dividends (the dividend loop pays broker cash
  accounts only) and two accounts now carry `equity_ticker` SPY, so `accountIdForEquityTicker("SPY")`
  throws (only the Fintual mail import calls it).
- **For `us-1040` (wave 3):** the stubs are `payroll_work_earnings` with `jurisdiction = 'us'`,
  `pay_period = 'biweekly'`, `pay_date`, `w4_filing_status = 'single'`, the EIN in `employer_rut`,
  lines in `payslip_lines` (US kinds; the employer match a `memo` side). W-2s are not stored: the
  generator derives them (`usW2sFromStubs`: boxes 1–6, 12D, 12W) and checks them against the stored
  lines — a filed-1040 table is the stream's to add, and a W-2 record beside it if the 1040 needs
  one. The US law is `usLegalParameters.ts` (2025 Pub. 15-T as published, 2026 figures
  `// provisional`). Roth contributions: US$7.000 each October from 2025 (MAGI check: the salary is
  under the phase-out).
- **For `us-f22-border` (wave 4):** the US salary is not in the F22 (`payrollTaxYear` keeps US
  stubs out). A listed single-leg `withdrawal_usd` debit is now a «used» dollar lot in
  `usdCashTaxLotEvents.ts` (realized under both oficios), so the US spending's fx results enter
  the F22's «Diferencias de cambio» from 2024 — decide whether a US resident's dollar spending
  belongs there at all. The flows overview counts `rent` through its `other` income bucket; the
  income chart has no `rent` bucket yet (small, `flowsOverview.ts` + the client chart).
- **Left as notes by the streams:** `ccExpensePurchaseNotes.ts`, `checkingExpenseRefunds.ts`,
  `flowsDepositsReconciliation.ts` and `movementMirrorPairs.ts` still read
  `listMovementBalanceCashAccountIds()` only, so notes and refund marking on US lines and the
  reconciliation of IBKR deposits from US checking are untested or refused; the DAP account has no
  import-key builder and IBKR's `broker_cash` role is written as data; `.pretax` files the generator
  leaves beside a DB are not covered by `server/data/*.db` in `.gitignore`.

### Wave 3 status (2026-11-09): merged into the integration branch, green

Two streams landed on top of wave 2 — `us-1040` (a8b54791) and `us-rentals-gen` (1628e704) — no merge
conflicts. On the merged tree: `npm run typecheck` ok (conventions + check-deps ok), server
488 files / 3243 tests on a fresh test DB, client 474, contracts 126, ingest 481; both people generate on
the synthetic market with the invariants passing — the demo person US$471.636 (433,6 M CLP; 2.903
movements; two properties with every cuota's card line linked; the US card's 28 statements and 28
autopays paired; `cash_unexplained` worst month 47.680 after the dollar-checking fx; 3 tax passes;
~55 s), the test person US$28.302 (7 s). Not merged to `main`. AGENTS.md gained the 1040 module and
the rentals / US card / link-fix facts. Both streams saw `merchantExpenseNotes.test.ts` fail once in
its `afterAll` restore (`flow_notes.flow_id` NOT NULL, `snapshotTables.ts` re-inserting rows another
file left behind) and pass on the next fresh run; it did not fail in the integrator's runs — an
order-dependent flake in a file no stream touched, worth a look by whoever owns the flow fixtures.

### Notes from wave 3 (for wave 4)

- **For `us-f22-border`:** the April loop (`taxDocuments.ts`, `generate.ts`) must now settle both
  returns: draft the 1040 first with `buildF1040Draft(y, today)` (`f1040Draft.ts`), book the IRS
  refund (late April) or the payment on US checking, then `recordFiledF1040({taxYear, filingStatus,
  filedOn, sourceFile, lines: draft.lines})` and `linkF1040Settlement({taxYear, movementId,
  description})` (`f1040Filed.ts`; the movement is a single-leg dollar row whose direction must match
  35a / 37; both writers are idempotent). The F22's treaty credit reads the 1040's total tax,
  `draft.lines["24"]`, converted at the rate the Suplemento prescribes (check: the US tax paid, the
  credit capped by the Chilean tax on the same income, art. 41 A / the treaty). The US salary itself
  is still out of the F22 (`payrollTaxYear` keeps US stubs out): decide the code for foreign
  employment income (línea 8 / 1035 or the one the AT2025 Suplemento names for rentas del art. 42
  N°1 obtained abroad) and add it through `f22Identities.ts`. Switch the generator's W-2 derivation
  (`demoData/usPayroll.ts` `usW2sFromStubs`) onto the server's `usW2.ts` (`usW2sFromStubLines`; the
  two agree box for box by test — convert stubs to `{ref, payDate, employer, ein, lines:[{side,
  kind, amount}]}`). The DJ 1898 sums both lenders' interest into one row — each lender should file
  its own (the art. 55 bis cap applies across both). IBKR dividends and the SGOV / sweep interest
  as foreign income (1104 / 748 / 1018 already exist for dividends; interest needs its code). After
  2024-07 most US spending is on the Lonestar card, so far fewer «used» dollar lots reach the F22's
  «Diferencias de cambio»; decide whether a US resident's dollar spending belongs there at all.
- **For `us-finish`:** net worth reads US$471k (+18 % on the target; wave 2 read 397k — the Centro
  rental, the car moved to 2020-11 and more sweep did it); the invariants allow ±25 %, so either tune
  the story (the plan's own sanity table said ~400k) or restate the target in `person.ts` with the
  reason. «Próximos pagos» lists the US card from its 15th close to its ~9th due date (empty on a
  due date itself, as today); the US card has no open-cycle listing, so the app never sees its open
  cycle (by design, phase 7). The test person has no houses, no US chapter and no US card. The
  About page and the tour must mention the US chapter, the two rentals (one DFL-2), the two returns
  and the dual-status simplification. The flows overview has no fx leg for dollars held in the
  checking accounts (and for the spread on each dollar sale between them), which is what the
  remaining «sin explicar» (≤ 50k a month) is — an app change beyond this plan, or a note on the
  demo page.
- **App notes from the streams (outside this plan unless wave 4 wants them):**
  `syncExpenseLinksNow()` inside a transaction takes ~46 s on the demo DB (`withoutChurn` bypasses
  `dbStateMemo`, so `listRealEstatePropertyAccountIds` rebuilds the nav model on every call) and
  every category write in the app runs that sync; the 2025 Form 1040 may renumber the deduction
  lines (the module uses the 2024 numbering for every year and says so on the page); the batch
  assign `assignPurchasesToRealEstateExpenses` is what a bulk tool should call.

### Wave 4 status (2026-11-09): merged into the integration branch, green — the plan is built

Two streams, one after the other — `us-f22-border` (af1d94d0) and `us-finish` (2e2616c6) — no merge
conflicts. On the merged tree: `npm run typecheck` ok (conventions + check-deps ok), server
489 files / 3248 tests on a fresh test DB, client 474, contracts 126, ingest 481, Python ok; both people
generate on the synthetic market with the invariants passing — the demo person US$445.296 (409,4 M
CLP; 2.908 movements; 4 tax passes; ~80 s; the 1040s of 2024 and 2025 filed and settled, the F22's
1030 from AT2025), the test person US$28.302 (7 s). Not merged to `main`; the demo not released.
AGENTS.md gained the F22 border facts and the finish's target / copy. `.gitignore` gained
`server/data/*.pretax` (the generator's checkpoint beside a DB).

What wave 4 landed: the US salary in the F22 as code 1030 with the treaty credit (748 / 1018, the
35 % cap, then the proportional IGC cap), IBKR's interest in 1104, DJ 1898 per lender, the April
loop filing the 1040 first and settling both returns (the IRS refund / payment on US checking,
written through `recordFiledF1040` + `linkF1040Settlement`), the generator's W-2 derivation switched
onto the server's `usW2.ts`; then the net-worth target restated to US$445k (`person.ts`, with the
reason — tuning the story down meant fighting it), two invariants (the retirement split's
membership; a filed 1040 for every US payroll year whose April has passed), the About page's two
US-chapter paragraphs and two tour steps (Retiro page: Chile / US; tax page: two returns each
April). The Render build's generation is estimated at 5–8 min on its CPU plus the market fetch,
acceptable since the old version serves during a build.

### Open after the plan (not scheduled)

- **Flows overview:** no fx leg for dollars held in the checking accounts (and the spread on each
  dollar sale between them) — the remaining «sin explicar», ≤ 50k a month on the demo.
- **F22:** the foreign dividends' credit sits in 1018 while the SII's G08 puts it in 746; the
  foreign salary's income base (gross less Social Security and Medicare) and the credit worksheet are
  the module's own reading (medium confidence); a Chilean resident's dollar spending abroad counts
  as dollar-lot disposals (286 on AT2025) — a posture question. 2025's Form 1040 may renumber lines.
- **Performance:** `syncExpenseLinksNow()` inside a transaction takes ~46 s on the demo DB (the
  nav model rebuilt per call while `dbStateMemo` is bypassed) and every category write runs it; the
  April loop could save a pass by feeding the US salary into the simulator's settlement estimate
  only (not `apvRegimeFor`).
- **Smaller:** a `rent` bucket for the income chart; `ccExpensePurchaseNotes.ts`,
  `checkingExpenseRefunds.ts`, `flowsDepositsReconciliation.ts`, `movementMirrorPairs.ts` still read
  the peso checking list only; the DAP account has no import-key builder and IBKR's `broker_cash`
  role is data; the Roth's SPY earns no dividends and `accountIdForEquityTicker("SPY")` throws
  (only the Fintual mail import calls it); DJ 1898's columns are named after the loan accounts, not
  the lenders; the About / tour copy was not viewed in a browser; `--real-market` was never
  rehearsed on the laptop (the Render build will be the first run); the order-dependent
  `merchantExpenseNotes.test.ts` flake. Phase 8 (non-resident F22, UCITS, options, a return) is out.
- **Housekeeping:** the ten `us-*` stream worktrees and `us-deps` under `.claude/worktrees/` are
  all merged and can be removed; a stale `node_modules` sits under `/private/tmp/claude-501/` too.
