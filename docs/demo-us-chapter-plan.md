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
