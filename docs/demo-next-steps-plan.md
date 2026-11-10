# Demo person: after the cash follow-up — the US-chapter leftovers and phase 8

Plan (2026-11-10). `docs/demo-us-chapter-plan.md` built phases 1–7 and left phase 8 and an
«Open after the plan» list; `docs/demo-cash-savings-plan.md` added the cash follow-up. This plan
triages what is left into three waves of agent work and says what is dropped. Facts checked
2026-11-10 on the merged tree and the local demo pair.

## Triage

| Item | Verdict | Why |
|---|---|---|
| Roth IRA's SPY earns no dividends; `accountIdForEquityTicker("SPY")` throws with two holders | **Wave A** | A story gap on the demo (a Roth holding SPY gets quarterly dividends) and a lookup that assumes one account per ticker — the Fintual mail import calls it; the personal instance has one SPY account today, so the throw is latent there. |
| A `rent` bucket for the income chart | **Wave A** | The two rentals' income is counted through the `other` bucket; the chart should name it. Small server + i18n change. |
| Four modules read the peso checking list only (`ccExpensePurchaseNotes`, `checkingExpenseRefunds`, `flowsDepositsReconciliation`, `movementMirrorPairs`) | **Wave A** | The dollar checking account's rows cannot be refunds, deposit-reconciled or mirror-paired. Same shape as the 2026-11-09 change that gave the expense and income lines the dollar list (`listDollarCheckingMovements`). |
| DJ 1898 columns named after the loan accounts, not the lenders | **Wave A** | A label on the tax page; the informed DJ carries the lender. |
| The DAP account has no import-key builder | **Wave A** | Identity written as a literal in the generator; one builder in `accountIdentityKeys.ts`. |
| The order-dependent `merchantExpenseNotes.test.ts` flake (its `afterAll` restore hits `flow_notes.flow_id NOT NULL`) | **Wave A** | A fixture problem; fix the restore. |
| The About page and the tour copy, never read in a browser after the US chapter | **Wave A** | Read every step of the tour and the About text on the local demo pair and fix wording that no longer matches the data (the retirement split, the two rentals, the US card, cash in savings). |
| IBKR USD receives little abroad (US$2,1k) | **Wave A, story tuning** | The car, the Roth, the Chilean April F22 (~US$13k) and the Chilean deficit take the US surplus. Decide: raise the US salary's yearly step, or let it be. Proposed: a US$10k raise at the 2025 review and the 2026 bonus up, so IBKR sees ~US$1k a month; re-check the net-worth target. |
| Flows overview: no fx leg for dollars held in the checking accounts | **Wave B** | The remaining «sin explicar» (≤ 37k a month on the demo); on the personal instance the Santander USD account has the same gap. A `cash_fx` leg per month = Σ over the dollar checking accounts of (dollars held at the previous month-end × the rate change) — the same rule the card revaluation uses (`ccRevaluationCostByDate`) — shown in the overview as its own row and taken out of `cash_unexplained`; the daily rows likewise. |
| `syncExpenseLinksNow()` ~46 s inside a transaction | **Wave B, generator only** | Measured 2026-11-10: a category write on the demo answers in ~0,5 s (the route runs outside a transaction, the memo holds). Only the generator pays it, on the real-estate assignment pass. Worth a `dbStateMemo` that survives a transaction's reads of tables the transaction did not write — or skip: the build is ~2 min. Proposed: skip unless the build grows. |
| F22: the foreign dividends' credit in 1018 vs the SII's 746 (observation G08 of AT2026) | **Wave C** | Check the AT2026 Suplemento for línea 43 / código 746 vs 1018 and move the dividends' credit where the SII files it, keeping the salary's; a filed return that carries 1018 must still reproduce. |
| F22: the foreign salary's base (gross less Social Security and Medicare) and the credit worksheet | **Wave C** | Re-read the Suplemento's instructions for 1030 and the art. 41 A credit; keep or correct, with the source named in the module comment. |
| Dollar spending abroad as dollar-lot disposals (286 on AT2025) | **Wave C, a decision** | Posture: a Chilean resident spending dollars abroad under Oficio 2573 «utilizarlos». The user decides the demo's posture (the module already supports three); the plan does not. |
| 2025's Form 1040 may renumber lines | **Wave C** | Check the final 2025 form (OBBBA changes land on Schedule 1-A; the 1040's own lines may shift) against `usLegalParameters.ts` and `f1040Identities.ts`. |
| Phase 8: UCITS ETFs at IBKR (CSPX / VWRA) | **Later, its own plan** | A London market calendar and session in `equityQuote.ts` / `equityEodSync.ts` (Yahoo `CSPX.L`, USD-quoted), the live-quote and held-print rules for a third market, the estate-tax story line. Medium feature; real value for a Chilean investor, but nothing on the personal instance needs it. |
| Phase 8: options | **Later, its own plan** | A new instrument kind (contract, expiry, premium, assignment), valuation with no price source for expired contracts, tax lots (equity options short-term). Large; only if the demo is meant to show it. |
| Phase 8: non-resident F22 mode; a return to Chile | **Dropped for now** | The story keeps him a Chilean resident in the US; neither is needed until the story turns. |
| Housekeeping: the merged `us-*` worktrees and `us-deps`; a stale `node_modules` under `/private/tmp/claude-501/` | **Now** | All merged; remove before wave A (new stream worktrees get a fresh deps store). |

## Waves

- **Wave A — small correctness and story items (two agents in parallel):**
  - *A1, app:* the two-holder ticker lookup (`accountIdForEquityTicker` takes the broker's cash
    account, as `equityBrokerHoldings.ts` already groups shares by cash leg; the Fintual import
    passes its own), the `rent` income bucket (server builder + `master.json` + the chart's
    colour plan), the four peso-only readers taking the dollar checking list, DJ 1898's columns by
    lender, the DAP import-key builder, the test flake.
  - *A2, generator + copy:* Roth SPY dividends (`DIVIDEND_PER_SHARE_USD` applied on `rothIra`
    like `ibkrUsd`, no withholding, reinvested), the US salary tuning for IBKR, then the About
    and tour copy read on the local pair and corrected; both generations, the sanity target.
- **Wave B — the flows overview's cash fx leg (one agent):** server builder, the overview and
  dashboard rows (`flowsOverviewRows.ts` only picks), i18n, tests on a synthetic month; the demo
  invariant's `cash_unexplained` tolerance tightened to what is left.
- **Wave C — tax readings (one agent, research first):** 746 vs 1018, the 1030 base, the 2025
  1040 lines; each with the source quoted in the module comment and a test on a filed return.
- Each wave: `cd server && npm run test`, both generations, the local demo pair; merge to `main`
  on the user's word; one demo release after the last wave.

## Wave A status (2026-11-10): built, merged into the integration branch, green

- **A1 (app, `us-a1-app`):** `accountIdForEquityTicker(ticker, {brokerCashAccountId})` tells two
  holders apart by the cash leg their shares trade against (the Fintual import passes its USD
  account); the income aggregates and chart carry a `rent` bucket; the dollar checking account's
  rows reach the purchase notes, the refunds (dollars, pesos at the day's rate) and the deposits
  reconciliation (dollar deposits priced like their deposit event; the dollar checking excluded
  from the capital-return and deposit-target pools) — mirror pairs stay peso-only by nature
  (stated in the module); DJ 1898 columns are headed by the lender (`lenderNames.ts`, the role
  through the vendor catalog); the DAP account carries `import:dap|key=dap`
  (`TERM_DEPOSIT_ACCOUNT_IMPORT_KEY`; it had no key at all); the `merchantExpenseNotes` flake was
  the test snapshot restore stripping `flow_id` from a flow-keyed table (`snapshotTables.ts`).
- **A2 (generator + copy, `us-a2-gen`):** the Roth IRA has a cash sweep («Roth IRA cash», always
  0 at day end, out of the nav) so its SPY dividends are a `dividend_payout` + same-day
  `stock_buy` pair, no withholding, and `usRetirementAccountIds("roth_ira")` keeps them out of the
  F22's dividends and the generator's detail rows; the US salary gets a US$10k step at the 2025
  review and a 12 % bonus in 2026 (`raiseExtraUsd`, `bonus.fractionByYear`), IBKR deposits
  US$34,8k → 46,4k over the US months, `netWorthTargetUsd` 445k → 460k (US$460.994 today); the
  About story and the tour's sidebar and retirement steps name the two rentals, the cash
  vehicles, the two cards and the Roth's dividends (every tour target verified).
- Checks on the merged tree: typecheck, client 85 files / 475 tests, server 499 files / 3296
  tests, both generations (invariants unchanged: unexplained cash worst 37.040, 17 months of the
  fund above the band during the pie years), the local demo pair: the income chart's Rent series
  and all seven tour steps read on the dashboard, Retiro and tax pages.
- Noted, not done: the Roth sweep's dollars pass through `usdCashTaxLotEvents` as zero-gain
  same-day disposals (listed, never taxed); a Roth-aware skip there is a tidy follow-up.

## Wave B status (2026-11-10): built, merged into the integration branch, green

- `cash_fx` on every overview row (month and day; `checkingCashByDay` in `flowsOverviewCash.ts`):
  for each checking account whose currency is not the unit, the quantity held at the end of the
  previous day × the day's change of its asset-side rate (dollars at the sell rate in CLP; pesos
  at 1/ask in USD; today live through `fxForLiveMtm`, past days from the stored rows) — the
  card revaluation's shape on the asset side; days sum to months by construction. Identities:
  `cash_unexplained = cash_change − (savings − deposits + card_spent − card_paid + cash_fx)`,
  `net_worth_change = savings + deposits_pre_tax + pl + cash_fx`; `cash_fx` is a base leg, so
  yearly rows and «en el rango» stay a field-by-field Σ. `flows_overview` DTO v2.
- Shown as «Cash fx» / «Fx de caja» beside the cash change on /flows (muted, like «Sin
  explicar»); not on the home flows card — its nine lines are pitched to the strip's divider on
  the big desktop, and the leg reaches the card through «Variación patrimonio».
- The demo's «sin explicar» after the leg is the story's own conversion costs (the bank's spread
  on each conversion between the checking accounts, and the half spread on every dollar flow
  priced at the mid); the invariant subtracts both and holds `|residual| ≤ 1.000`: 3 pesos on
  the demo, 1 on the Vitest person (was a 150k tolerance against an estimate).
- Checks on the merged tree: typecheck, client 85 / 475, server 499 / 3298, the demo generation
  (US$460.994), the row on the local demo's overview.

## Wave C status (2026-11-10): built, checked, not merged

Sources read, not remembered: the SII's AT2026 form (`f22_at2026.pdf`) and per-line instructions
(`sii.cl/servicios_online/renta/2026/archivos/l<N>_instruccion.pdf`), Circular 31/2021, observation
G08, the Chile–US convention, the IRS's final 2025 Form 1040, its instructions and the 2025 Form
8959 instructions; each quoted where the reading lives (`f22ForeignIncome.ts`, `f22Identities.ts`,
`f1040Identities.ts`, `usLegalParameters.ts`).

- **746 vs 1018: the module was right, the plan's premise was not.** Línea 45 (1018, «arts. 41 A
  N°4 letra B) o N° 5») is a natural person's own foreign incomes — 1104 (instructions 12.3 and
  45.1 a), 1030 (45.1 c), 110 —; línea 49 (746, «art. 41 A N°4 letra A) letra b)») is the credit
  a Chilean company passes through with its dividends (49.1: Certificados 43 / 44 / 70 / 71). G08
  names both because it covers both. The dividends' credit stays in 1018; `f22Code304` subtracts a
  filed 746 too (never drafted), so a form carrying either reproduces; `taxReturn.codes.746`.
- **The 1030 base and the credit, two readings corrected.** (1) Nothing but Chilean-law pension and
  health contributions comes off an art. 42 N°1 income (Circular 31 §1.2.2.2.2 a) i)): Social
  Security and Medicare stay in — 1030 = gross less the US income tax. (2) The salary and its tax
  convert at the year-end observado, no IPC reajuste (art. 41 A N°7 letra a) for a person without
  books, Circular 31 §1.3.2.2 and annex 3; the dividends already did). Confirmed: tope individual
  only (min of the tax and 35 % of the gross; FICA no creditable tax, convention art. 2), 748 →
  1018, no refund; the IGC cap now uses Circular 31's one-decimal proportion (annex 3's
  «22,0 %»). Kept as assumptions, stated in the header: line 24 as the salary's whole tax.
- **The 2025 Form 1040 renumbered the deduction lines** (11 → 11a / 11b, 12 → 12e, 13 → 13a, new
  13b from Schedule 1-A; 14 = 12e + 13a + 13b; 16–37 unchanged): `F1040_LINES` are roles in the
  2024 numbering (plus «13b», which a 2024 return may not carry), `f1040PrintedLine` /
  `f1040RoleOfPrintedLine` map a year's numbers, the payload carries `printed_line` and the page
  prints it. $15.750 / $31.500, the 2025 brackets and the $200.000 / $250.000 Medicare thresholds
  are the final ones; Pub. 15-T's 2025 withholding deduction was not re-read.
- **Demo (synthetic market, 3 April passes before and after):** AT2025 1030 84.112.575 →
  95.946.982, 748 = 1018 13.248.958 → 13.832.141, 304 = 305 12.040.984 → 15.803.957; AT2026 1030
  131.480.824 → 137.288.247, 748 = 1018 26.924.159 → 25.602.246, 304 = 305 13.546.018 →
  16.448.761; 1040 2024 refund US$2.444 unchanged, 2025 owed US$235 → 207 (line 2b follows the
  wires the bigger F22 payments resize); net worth US$460.994 → 453.582, invariants green.
- Not touched: the dollar-lot posture on spending abroad (the user's decision).
- Merged into the integration branch 2026-11-10 and checked there: typecheck, client 85 / 475,
  server 499 / 3300, the demo generation (US$453.582; AT2026 1030 137,3 M, 1018 25,6 M, 304
  16,4 M; 1040 2025 owed US$207; 3 April passes), both tax tabs read on the local demo. Two copy
  defects fixed on the merge (886af2a3): a doubled «US$» prefix on the foreign-income figures, and
  the 1040 intro naming the 2024 form while the rows print the 2025 numbers.
