# Deposits ↔ Checking Reconciliation — context handoff

> Paste this into a fresh session to resume the reconciliation work with full context.
> **Read `AGENTS.md` / `CLAUDE.md` first** — especially: **fail-fast / no runtime fallbacks**
> (invalid/inconsistent input should throw, never silently guess), **i18n** (Spanish UI copy in
> `client/src/i18n/locales/es.json`, English dotted keys), **desktop/mobile table sync**, and
> **tests: always `cd server && npm run test`** (sets `NW_TRACKER_TEST_DB=nw-tracker.test.db`;
> never run bare `vitest` — `db.ts` throws under Vitest without that env var to protect the real DB).

## What this feature is

A **bidirectional reconciliation** between the **checking bucket** (funding hub) and every other
net-worth bucket:

- **Positive deposits**: money into a non-checking net-worth account ← funded by a checking/CC **outflow**.
- **Negative deposits (redemptions)**: money leaving a non-checking account → returning to checking as an **inflow**.

The scoping rule (user-confirmed): **the checking bucket = {cuenta_corriente, cuenta_vista} is the
counterparty, never a reconciliation target.** Only flows *crossing* the checking-bucket boundary
count. Its own inflows (salary, internal corriente↔vista moves) are out of scope (future
liquidaciones/income tab).

The reconciliation view is at `GET /api/flows/deposits/reconciliation` →
`client/src/pages/DepositsReconciliationPage.tsx`. It reads `expense_deposit_links` (the durable
link table) plus a few exclusion/mirror mechanisms below. A deposit is "linked" if its movement id
has an `expense_deposit_links` row.

## Progress: **881 rows / 1,102.9M CLP unlinked → 28 rows / 43.4M** (≈96% linked or resolved)

Reconciliation statuses: `linked` (real checking/CC outflow), `linked_synthetic` (synthetic mirror),
`resolved_family_funded` (cuenta_ahorro pure-family split), `unlinked_no_checking_source` (missing
cartola month — now 0), `unlinked_checking_present` (has cartola, still unmatched — the remaining 28).
Redemptions have their own `linked / unlinked_*` set in the same payload.

## Architecture — what is built (all in the working tree, tested)

Server (`server/src/`):
- **`flowsDepositsReconciliation.ts`** — the builder. Excludes: checking bucket (`listMovementBalanceCashAccountIds`), AFP/AFC payroll, USD-cash, `savings_earnings` flow_kind, **crypto coin accounts funded by the Buda buffer** (`loadCryptoCoinAccountIdsFundedByBuda`), **state contributions** (`movementIsStateContribution`), and Buda-buffer non-`abono` inflows. Also builds the **redemptions** side by reusing the income filter's consumed-outflow keys.
- **`expenseDepositLinks.ts`** — composite PK `(purchase_key, deposit_movement_id)`, `link_source ∈ {auto, manual, synthetic}` (priority manual>auto>synthetic). `tryAutoLinkExpenseDepositLine` promotes `deposits`-category gastos lines w/ `auto:deposit-match` notes into links. `syncExpenseDepositLinksFromGastosLines` orchestrates: clear auto → mortgage sheet links → per-line auto-links → `assignBillsCategory` → `syncCuentaAhorroDepositSplitMirrors` → `syncBudaAbonoDepositMirrors` → `syncCheckingGapDepositMirrorLinks`.
- **`flowsCheckingGapDepositMirrors.ts`** + table `checking_gap_deposit_mirrors` — synthetic checking outflows for deposits in missing-cartola months. `link_source='synthetic'`, category `checking_internal_transfer` (cash→cash) or `deposits` (→investment), negative `statement_line_id` convention.
- **`cuentaAhorroDepositSplits.ts`** + table `cuenta_ahorro_deposit_splits` — per-deposit self/family split for cuenta_ahorro_vivienda (monthly aggregates). self_funded → partial mirror → `linked_synthetic`; pure-family (self=0) → `resolved_family_funded`.
- **`budaWallet.ts`** + account "Buda CLP" (`import:buda|key=buda_clp`, under crypto bucket asset_group 11 / portfolio_group 5) — a **buffer cash account**. Ledger imported from `cfraser/buda-history.csv` (parsed from `cfraser/buda history.rtf`) via `scripts/import-buda-history.ts` (`npm run import:buda`). Movements tagged `import:buda|{abono,buy,sell,retiro}`; balance = cumsum (~0), P/L = 0 (cuenta_ahorro pattern). Reconciliation: coin deposits excluded (funded by buffer, internal), **abonos** = targets → synthetic mirrors, sells/buys internal, **retiros** → redemptions.
- **`apvAporteEstatalBackfill.ts`** — reads `net worth-retiro.csv` col "aporte estado" (yearly APV-A state match), tags matching mega caca (account notes `import:fintual|cert|key=apv_a`) deposits with `flow_kind=aporte_estatal_clp` **by amount + year** (year guard essential: 295.050 is both a 2021 state match and a 2019 personal deposit). Wired into `import:excel`; standalone `npm run backfill:apv-aporte-estatal`.
- **`flowsCheckingGastos.ts`** (the ~2000-line matcher) — key recent edits:
  - `FINTUAL_TRANSFER_DESC_RE = /FINTUAL\s+ADMINISTRADORA/i` (narrow, exclusion only) vs `FINTUAL_INVESTMENT_TRANSFER_RE = /\bFINTUAL\b/i` (broad, auto-match gate). Test invariant: `"TRASPASO A FINTUAL"` must **not** be excluded (flows through the matcher).
  - `depositMatchesSplittableInternalTransferTiming` relaxed from exact-same-date to `≤ SPLITTABLE_INTERNAL_TRANSFER_MAX_DAY_GAP (8)` days.
  - **Unification (important):** excluded investment transfers (Fintual/reserva) now emit their deposit-portion line in the **main gastos loop** (the `isExcludedCheckingWithdrawal` branch, gated by `checkingWithdrawalFundsInvestmentCapital`) so they link through the same shared pool. The old parallel `syncCheckingInvestmentTransferDepositLinks` post-pass was **removed** — do not reintroduce a parallel matcher.
- **`flowsCheckingInflows.ts`** — `loadConsumedNetWorthCapitalReturnOutflowKeys()` exposes the income filter's matched net-worth-outflow keys; the redemptions view reuses them so income and reconciliation never disagree.
- **`accountDeposits.ts`** (`SAVINGS_EARNINGS_FLOW_KIND`, excluded from aportes) + **`accountPerformance.ts`** (cuenta_ahorro_vivienda now goes through the P/L path). Abonos/Intereses = bank yield (P/L), Depósitos = capital.

Migrations added by this feature: `141` (composite PK), `142` (gap mirrors), `143` (ahorro savings_earnings), `146` (ahorro splits), `147` (suecia pie/prepago manual links), `148` (reserva2 fintual manual links), `150` (apv aporte estatal). **`144`/`145` are concurrent facturado/brokerage-cash work — NOT this feature.** Migration `149` was assigned by the runner to a duplicate; next free file number is `151`.

Scripts / npm: `propose:synthetic-deposit-mirrors [--apply]`, `propose:cuenta-ahorro-splits [--apply --set id=self | --family-default 90]`, `import:buda`, `backfill:apv-aporte-estatal`.

Client: `DepositsReconciliationPage.tsx` (deposits + redemptions sections, desktop+mobile), `types.ts` (`DepositReconciliation*`, `DepositRedemption*`), `es.json` (`depositsReconciliation.*`), hook `useFlowsDepositsReconciliation`, route in `App.tsx`.

## Also fixed this session (unrelated to the 3 remaining tasks)
- **Único bug** on installment purchases: two same-day EXPRESS PLAZA buys (same merchant/date/cuotas, different amount) shared category/Único state. Fixed `findMatchingCuotaLine` in `ccInstallmentPurchaseTotalLines.ts` (disambiguate by `installment_total_clp`) + `sameInstallmentPurchaseGroup` in client `ccExpenseLineBuckets.ts` (purchase_key guard). NOTE: `ccInstallmentPurchaseTotalLines.ts` also has **concurrent edits** from the parallel installment work.

## Remaining work (in priority order)

1. **Fix the greedy deposit-selection allocation** (the surgical, high-value one). Two same-amount
   outflows can both claim the *earlier* of two same-amount deposits, orphaning the later one.
   Concrete case: Reserva2 (fondo_reserva) has two 3.000.000 deposits (mov **10720** @2024-11-19,
   **10721** @2024-11-22) and two 3M "Transf. Internet a otro Bancos" outflows (2024-11-19,
   2024-11-22). Both outflows link to 10720 → 10720 double-linked, **10721 orphaned**. The pairing
   should be 1:1 (prefer same-date). Trace `findExactInternalCashTransferDeposit` and
   `tryAllocateSplittableInternalTransferAmount` / `usedDepositKeys` consumption order in
   `flowsCheckingGastos.ts` — this is why several remaining Reserva2 deposits (part of the 30.6M) show
   unlinked despite having exact outflows. **Reuse the existing matcher; do not add parallel logic.**
2. **Brokerage CLP buffer for split withdrawals** (mirror of the Buda buffer). Some Fintual
   withdrawals are split: e.g. a 13M redemption leaves the Fintual account but arrives in checking as
   7M + 6M, so nothing matches 1:1. Model as: `caca daca → brokerage_cash CLP buffer (one 13M) →
   checking (7M + 6M)`. Makes the Fintual side clean 1:1 and the buffer→checking split plain
   redemptions. Analogous to `budaWallet.ts` (`brokerage_cash__clp` = asset_group 42 already exists,
   currently empty). User approved.
3. **Trust manually-marked "deposits" expenses.** The user manually categorizes some checking
   outflows as the `deposits` category because they *do* correspond to a real deposit ("they match
   *something*"). The reconciliation/promotion should treat a manual `deposits` categorization as a
   signal that a link should exist — err safe if unsure which deposit, but assume it matches one.

## Remaining unlinked breakdown (~43.4M, the 28 rows)
- **Reserva2 30.6M** — mostly the greedy-allocation orphans (task 1) + big deposits (10M/6.5M/1.1M) with no exact same-amount outflow (likely DAP-funded or split → task 2). Reserva2 is a new account, so the data *is* present.
- **mega caca 5.2M / mega cbcb 3.2M / caca daca 2.55M / pre-Fintual APV 1.9M** — smaller Fintual/APV deposits; some may be other-exchange or need per-deposit review. The Dec-2019 694.711 aporte estatal is untagged (fuzzy principal→Fintual batch transfer, no single matching deposit).

## Gotchas
- **The working tree is shared** with concurrent facturado / units-flow / installment work
  (`ccFacturadoFinancing*`, `manualUnitsFlow*`, `AccountUnitsFlowForm`, `FlowDirectionToggle`,
  migrations 144/145, edits to `ccExpenseCategories.ts` / `ccInstallment*` / `cryptoValuation.ts` /
  `afpUnoValuation.ts`). Pre-existing test failures in `ccExpenseCategories.test.ts` and
  `netWorthConsolidation.test.ts` are **from that concurrent work, not the reconciliation feature.**
- The **dev DB** (`server/data/nw-tracker.db`) has script-created state not reproducible by migration:
  the Buda CLP account + ledger (`npm run import:buda`), applied synthetic mirrors + cuenta_ahorro
  splits (from the propose scripts' `--apply`), and migration 150's aporte-estatal tags. Re-running
  `import:excel` regenerates Fintual notes as `deposit_clp` — the `import:excel`-wired backfills
  (savings_earnings, apv aporte estatal) re-apply them; the Buda ledger and mirrors/splits must be
  re-applied via their scripts.
- Reconciliation is `@heavy`; it runs the income filter once for the redemptions side.
