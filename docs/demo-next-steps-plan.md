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
