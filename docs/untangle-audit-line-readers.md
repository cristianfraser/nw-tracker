# Audit: readers of card lines, installment plans, and checking/income rows

Read-only audit of `server/src` (tests and `server/scripts` excluded), 2026-11-07, against docs/untangle-plan.md «Vocabulary», F9, F10.
Method: grep of the three tables (`cc_statement_lines` 43 non-test files, `cc_installment_purchases` 20, `cc_installment_payments` 10) by enclosing function, plus callers of the shared loaders, plus the checking/deposit loaders. Where the table is read only through a loader, the row names the loader and says «via».

Legend. **Src** = filters by statement source kind (WP = web paste / bucket, PDF/JSON = real statement, none = all sources). **Shape** = flow (date, amount, currency, merchant, kind, account) or raw (ids, parser_row_id, dedupe keys, statement ids). **W** = writes. «Cuota lines» = `installment_flag = 1` lines.

## A. Card statement lines: direct readers

| # | Reader | Table / loader | Needs | Src | Shape | W |
|---|---|---|---|---|---|---|
| 1 | ccBillingBalances:normalizedPostCloseLines | lines (flag=0) + header payments + traspaso links | debt events (owed walk), payment evidence, financing cost, month-end anchors | none (USD query excludes WP in one sub-select) | raw (id, dedupe_key for traspaso and superseded) | no (cached) |
| 2 | ccBillingBalances:listRevolvingLineRowsForStatementDate | lines flag=0 by statement_date | billed estimate (open-month USD/CLP, credits) | none; the caller picks statement dates | flow + id (for superseded set) | no |
| 3 | ccBillingBalances:openMonthUsdFacturado / openFacturacionCredits / sumRevolvingLinesForAccountStatementDateClp | #2 | billed estimate, upcoming-payments credits | WP excluded at `:882`, else none | flow | no |
| 4 | ccBillingBalances:installmentCuotaDueForAccountStatementDateClp | lines, all flags, by statement_date | cuota a pagar, cupo | none | flow (installment fields) | no |
| 5 | ccBillingBalances:normalizedInstallmentPurchaseEvents | `cc_installment_purchases` | debt events (+total on purchase date) | none (all plan sources) | flow (date, total) + plan id | no |
| 6 | ccBillingBalances:postCloseLiveBalanceAdjustmentsClp / postCloseNativeAdjustment / unbilledAtMonthEndAdjustmentsClp / installmentPurchasesClpAfter / incrementalChargesClpForBillingMonth | #1 + #5 | debt events, month-end anchors | none | flow | no |
| 7 | ccBillingBalances (`:818,:882`, facturado for a statement) | statements; WP test on `source_pdf` | billed estimate | WP vs not (inline `startsWith("import:web-paste")`) | flow | no |
| 8 | ccBillingViews:facturadoTotalClpForStatementSlot | lines of one statement | billed (facturado total) | per statement | flow | no |
| 9 | ccBillingViews:facturadoClpFromOpenMonthStatementLines | lines joined to statements | billed estimate of the open month (únicos, cuota purchases excluded) | **WP open bucket only** (`LIKE 'import:web-paste|open|%'`) | flow + line id (cuota_purchase_kind) | no |
| 10 | ccBillingViews:pendingCuotaPurchaseLines / cuotaPurchaseLinesClpByBucketMonth | lines with `cuota_purchase_kind` | debt events (installment debt), billed estimate, cupo, pending list on card page | **WP open bucket only** | flow + statement_line_id (UI deep link) | no |
| 11 | ccBillingViews:cupo/facturaciones via `ccCupoFrame`, `buildBillingDetailByMonth`, `buildFacturaciones` | plans (via ledger) + #9/#10 + statements | cupo, schedule/pay-by, facturación rows | mixed | flow + plan aggregates | no |
| 12 | ccCuotaRetirement:listClpCcPaymentEventsForAccount | lines (flag=0, amount<0, CLP) + header payments | payment evidence, cuota retirement | none | flow (date, amount, merchant) | no (cached) |
| 13 | ccOwedByCurrency:linesForAccount | all lines by account | cupo/owed per currency (bank cupo check) | none | flow (amounts by currency, flag, cuota) | no |
| 14 | ccInvestmentProxy:aggregateProxyByFacturacion (+ `selNormalPurchases`) | lines flag=0 amount>0 + plans (`installmentPurchaseToLot`) | facturación proxy | none (WP and statement) | flow + line id (superseded set) | no |
| 15 | ccFacturacionUsdRate:facturacionUsdRates | `cc_traspaso_deuda_links` JOIN lines | payment evidence (rate paid), fx | n/a | flow (date of USD leg) | no |
| 16 | ccPaymentMirrorEvidence:ccPaymentEvidenceKey / listCcPaymentEvidenceRows | lines + statement headers (`:70,:109`) | payment evidence for `pago_tarjeta` pairing, upcoming payments | **PDF only** at `:96` (statement_id lookup), lines all sources | raw (line id → key; statement id) | no |
| 17 | ccPaymentMirrors (candidate listing, converter) | via #16 | payment evidence | via #16 | raw | **yes** (writes transfer + merge row) |
| 18 | dashboardCcUpcomingPayments / upcomingPayments | via #16 and billing-detail facturaciones | payment evidence (what is still owed) | via #16 | flow | no |
| 19 | ccTraspasoDeudaLinks (relink + `:45`) | lines of a close | payment/traspaso pairing | **PDF/JSON only** (`NOT LIKE 'import:web-paste%'`) | raw (line ids stored in link table) | **yes** |
| 20 | ccUsdStatementBilled:isCcUsdPaymentLine / usdBilledFromStatementLines | lines of one statement | billed (USD net), payment classification | per statement | flow (+ id) | no |
| 21 | ccFacturadoFinancingAuto:cuotaPayments / paymentOnFile | tagged lines + plans + payment lines | financing-link matching (cuota purchases on another card) | PDF test via `isPdfStatementSource` (`:85`) for months; tagged lines all | flow + line id | **yes** (upserts link, plants PAGO) |
| 22 | ccFeedCuotaPurchases (`:47` bucket lookup, `:116` first_due, `:176` tag) | lines + plans | dedupe/import identity, schedule (first_due_month), plan creation from feed | WP bucket lines | raw (line ids, plan ids) | **yes** (creates plans, tags lines, deletes one-shot) |
| 23 | ccInstallmentInterest:ccInstallmentInterestForAccount / ccInstallmentInterestBillingEvents | plans JOIN payments JOIN lines on `parser_row_id` | debt events (interest), financing cost, gastos Total (receipt amounts) | statement lines only (join on parser_row_id) | raw (parser_row_id join) | no (cached) |
| 24 | ccInstallmentLedgerDb:loadLedgerPurchasesAndPayments | plans + payments + `LEFT JOIN lines` on parser_row_id, statements for `period_to` | schedule/pay-by, cupo, cuota counts; feeds #36–#43 | none (all plan sources) | raw (parser_row_id, canonical_row_id, twin_index) | no |
| 25 | ccInstallmentLedgerDb:loadCancelledInstallmentPurchaseIds | NOTA DE CREDITO lines + plans | schedule (exclude nota-cancelled plans) | none; matches by statement month | flow (nota lines) + plan ids | no |
| 26 | ccExpenseCategories:loadCcStatementLineExpenseCtx / installmentLedgerTotalForStatementLine / installmentLedgerTotalViaPaymentRow / ...ForIdentity | line + payments + plans (`:680–:810`) | gastos Total (plan total for a cuota line, purchase key), dedupe/import identity | none | raw (parser_row_id → plan; throws on ambiguity) | no |
| 27 | ccExpenseCategories:resolveInstallmentPurchaseIdsFromKey / listInstallmentSiblingIdsViaLedger / ...ViaHeuristic / listInstallmentHHeuristicStatementLineIds / listStatementLineIdsForPurchaseKey / statementLineIdsForManualInstallmentHPurchaseKey | lines + payments + plans | category/«Único»/note/big-group assignment by purchase key (key → line ids) | none | raw (ids, keys) | no (callers write) |
| 28 | ccExpenseCategories:ccStatementLineBelongsToCreditCardGroup; loadCcExpenseCategoryMaps (`:245`) | lines JOIN line categories | category assignment, display | none | raw (line id) | no |
| 29 | ccExpenseCategories:assignCcExpenseCategoryForManualLedgerInstallmentPurchase | plans, lines | category assignment on a manual plan | n/a | raw | **yes** |
| 30 | ccExpenseCategoryPersist:snapshot / restore / migrateStoredPurchaseKeyToStable | lines + payments, line-keyed assignment tables | dedupe/import identity (re-key mover) | none | raw | **yes** |
| 31 | ccExpenseLineRekey:ccLineRefFromRow + movers | lines | dedupe/import identity (re-key mover) | none | raw | **yes** |
| 32 | ccExpenseLineDedupe (`:24,:35,:43,:50,:58`) | lines JOIN statements | dedupe/import identity (exact + fuzzy twin, origin_card_last4 backfill) | **excludes WP** for PDF/JSON imports (`NOT LIKE`) | raw | **yes** (`:58` sets origin) |
| 33 | ccCrossImportDedupe:listOneShotLinesForAccountUncached / dbOneShotCandidates / shouldSkipOneShotStatementImport / oneShotLineFuzzyMatchExists / earliestTransactionDateForLineIds / removeOneShotLinesForInstallmentPurchase | lines + plans | dedupe/import identity, the rule «a line that has a plan counts once» (`oneShotStatementLineIdsSupersededByInstallmentPurchases`, called by 5 readers) | WP excluded variant for PDF imports | raw | **yes** (deletes lines) |
| 34 | ccTruncatedMerchantDedupe:plan / removeTruncatedMerchantDuplicateLines | lines of WP sources | dedupe/import identity (pending vs settled) | **WP only** | raw | **yes** (deletes) |
| 35 | ccRecurringPendingLines:replaceRecurringPendingLines | lines in WP bucket | dedupe/import identity (pending listing under another name) | WP buckets | raw | **yes** (deletes) |
| 36 | ccPlantedPayments (`:124,:170,:282`) | lines | payment evidence (planted PAGO replaced by bank line) | WP | raw | **yes** (deletes, records) |
| 37 | ccStatementLineDelete:deleteCcWebPasteStatementLine | line | UI delete of a bucket line | WP only | raw | **yes** |
| 38 | ccStatementsImport:importCcStatementsMerge | lines | import write (delete + insert per statement) | PDF/JSON/WP | raw | **yes** |
| 39 | ccOpenWebPastePdfReconcile (`:185,:256` via listCcStatementLinesForStatement; reconcile) | lines of buckets and statements | dedupe/import identity (bucket line settled by statement) | WP vs PDF by statement | raw | **yes** (delete, move) |
| 40 | ccOpenWebPasteRepair (`:49,:119,:167`) | lines | import repair (move lines between buckets) | WP | raw | **yes** (`UPDATE statement_id`) |
| 41 | ccStatementImportReconcile (`:765` + dbLineToReconcileRow) | lines of stored statements | import gate (parsed vs printed totals), dedupe keys | PDF only (WP skipped when `pdfReconcileOnly`) | raw (dedupe keys) | no (throws) |
| 42 | ccManualInstallmentStatementReconcile (`:28–:92`) | plans + lines | dedupe/import identity (manual plan replaced by statement twin) | manual plans vs PDF lines | raw | **yes** |
| 43 | cardStatementCrossCheck:loadImportedLines | lines of one statement | import verification (JSON vs ledger) | JSON | flow (merchant, amounts) | no |
| 44 | santanderStatementImport (`:56` plan lookup, `:323` stale echo) | plans, lines | dedupe/import identity (stale echo, plan merge) | JSON | raw (canonical_row_id) | no (caller writes) |
| 45 | creditCardPerformancePl:statementSection3ChargesClpForBillingMonth | lines per statement | financing cost per billing month | statement dates of the facturación (all sources) | flow | no |
| 46 | flowsExpenses:buildCcExpenseLines (`:476`) | lines JOIN statements | gastos Total / Por cuota (line list), display, dedupe with plan lines | all; sets `web_paste` flag from `source_pdf` | raw (statement_line_id, parser_row_id) + flow | no |
| 47 | flowsExpenses:expenseLineDraftForPieces (`:1013`) | line → account | pieces/splits | n/a | raw | no |
| 48 | ccInstallmentPaymentGastosLines:buildInstallmentPaymentGastosLines | payments JOIN plans | gastos Por cuota (cuota lines when statement lines are missing) | none | flow + plan id | no |
| 49 | ccInstallmentPlanGastosLines (`installmentPlanBreakdownByMonth`, `loadPurchaseMetaByCanonicalId`) | plans via ledger | gastos Por cuota (plan-derived cuotas, future months) | none | flow + plan id | no |
| 50 | ccInstallmentPurchaseTotalLines:loadInstallmentPurchases / findMatchingCuotaLine | plans | gastos Total (one total line per plan, twin slots) | none | flow + plan id, twin_index | no |
| 51 | ccPurchaseExpenseLinks:withPurchaseExpenseLinks | plan row + cached expense lines | display (link a plan to its expense line) | n/a | plan id | no |
| 52 | ccFacturadoFinancingProjectionLines (via expense lines) | expense line drafts | gastos Total vs Por cuota (financing projection) | n/a | flow | no |
| 53 | ccAdditionalCardExpenseMatch:activeAdditionalCardLast4ForAccount | lines of latest statement | additional-card tagging (origin_card_last4) | **PDF only** | flow (origin) | no |
| 54 | backfillAdditionalCardNoCuenta | lines JOIN statements | additional-card backfill | none | raw | **yes** (script-like, in src) |
| 55 | ccExpenseGenericTransferBackfill | lines | category backfill | none | raw | **yes** |
| 56 | expenseDepositLinks:assignBillsCategoryToMortgageLinkedLines (`:606`) | `edl.purchase_key` parsed by `substr(…,9)` → lines by parser_row_id | deposit matching (mortgage link → category) | none | raw (parser_row_id from key) | **yes** (writes categories by volatile line id) |
| 57 | mortgagePaymentCardMatch:loadMortgageCardLines | lines merchant LIKE METLIFE/MUTUARIA/TOKU | other: mortgage cuota ↔ card line pairing | none | flow + line id | no |
| 58 | mortgageUfReminder:resolveMortgageCcMasterId | same LIKE, newest 25 | other: find which card pays the mortgage | none | flow (merchant, account) | no |
| 59 | merchantExpenseNotes:loadCharges | lines merchant LIKE APPLE.COM/ITUNES | other: App Store receipt ↔ charge matching | none | flow (+ line id for link) | no |
| 60 | storeReceiptApply:selectCardLinesByAmount | lines by amount | other: grocery receipt ↔ card line (Jumbo) | none | flow | no |
| 61 | groceryBranchLearning:bankMerchantForBranchMap | lines on card | other: learn branch → bank merchant | none (excludes lines the importer wrote itself by `raw_line` prefix) | raw (reads `raw_line` prefix) | no |
| 62 | liderCardLines:liderMasterAccountId / same-day-same-amount guard | lines flag=0 | dedupe (grocery receipt line vs feed/statement) | none | flow | no |
| 63 | f22Settlements:f22Settlement | line by account/day/pesos | other: tax settlement evidence re-found | none | flow | no |

## B. Installment plans and payments (direct)

| # | Reader | Table | Needs | Src | Shape | W |
|---|---|---|---|---|---|---|
| 64 | ccInstallmentLedgerDb:ccInstallmentsDbApiPayload | plans via #24 | schedule/pay-by, cupo, «compras activas», facturaciones months | all plan sources (`source` column read, no filter) | raw plan objects + aggregates | no |
| 65 | ccInstallmentLedgerDb:listSchedulePurchaseEvents | plans via #24 + interest | debt events (plan debt walk) | none | flow (iso, clp) | no |
| 66 | ccInstallmentLedgerDb:installmentRemainingClpByCalendarMonth / installmentRemainderAfterFacturacionClp / liveCreditCardOutstandingClp / ledgerFacturadoClpForBillingMonth / creditCardInstallmentPaymentsByBillingMonth | plans via #24 | cupo, schedule, billed estimate, pasivos | none | aggregates | no |
| 67 | ccInstallmentLedgerDb:cancelledInstallmentPurchaseIdsForAccount | via #25 | schedule exclusion (callers: ccExpenseCategories `:450`, ccBilledCuotasIdentity) | none | ids | no |
| 68 | ccInstallmentLedgerMerge:mergeInstallmentLedgerFromParsedRows / assertTwinPlansStartTogether | plans + payments | import write (plan upsert by canonical_row_id + twin_index; manual plans preserved) | PDF/JSON writes, manual rows kept | raw | **yes** |
| 69 | ccInstallmentManual:create / update / delete / convertStatementLineToInstallmentPurchase | plans, lines | manual plan CRUD, line → plan conversion | manual | raw | **yes** |
| 70 | ccInstallmentPaymentBackfill:backfillMissingInstallmentPaymentsForAccount | plans + payments | repair (synthetic payment rows for manual/feed plans) | n/a | raw | **yes** |
| 71 | ccWebPasteInstallmentNudge (`:23–:43`) | plan + payment count | schedule (first_due_month pin) | manual/web-paste plans | raw | **yes** |
| 72 | ccStatementPdfUpload:persistUploadedCcStatementPdfs | plans `source_pdf_sample`, payments `source_pdf` | import (rename source on upload) | n/a | raw | **yes** |
| 73 | ccBilledCuotasIdentity:ccBilledCuotasIdentity | cuota lines of PDF statements + payments of cancelled plans | other: acceptance check billed cuotas = ledger cuota_a_pagar | PDF | flow | no |
| 74 | ccBillingDetailCache:billingDetailCacheForAccount | calls #64 + builders | facturaciones/detalle for every consumer (see C) | n/a | aggregates | no |
| 75 | ccCreditCardValuations / ccBillingInactive | `liveCreditCardOutstandingClp` | cupo (inactive-card rule, month-end valuation) | none | aggregate | **yes** (valuations in ccCreditCardValuations) |
| 76 | ccExpenseCategories:cancelledInstallmentPurchaseIdsForAccount use (`:450`) | via #25 | gastos Total (plan excluded when nota-cancelled) | none | ids | no |

## C. Consumers of the above through loaders (no table access, but they fix the API)

| # | Reader | Loader used | Needs | Src | Shape | W |
|---|---|---|---|---|---|---|
| 77 | ccOwedWalk:buildRevaluation / ccFinancingCostClpBetween / owed walk | `normalizedPostCloseLines` + `normalizedInstallmentPurchaseEvents` | debt events (owed walk), P/L | none | raw entries (id, key, currency, statement_date) | no |
| 78 | ccFinancingCostDaily:ccSection3FinancingClpByDate / ccChargesByDateInUnit | `normalizedPostCloseLines` + `ccInstallmentInterestForAccount` | cost flows (section 3 charges, interest) | none | flow (date, amount, currency, merchant) | no |
| 79 | ccInstallmentDebtDaily:ccInstallmentDebtEvents / closedFacturacionAheadOfPayBy | `listSchedulePurchaseEvents`, `pendingCuotaPurchaseLines`, `listClpCcPaymentEventsForAccount`, `facturadoClpFromOpenMonthStatementLines` | debt events (plan-debt walk), cuota retirement | WP bucket (pending, open lines) + all | flow | no |
| 80 | creditCardInstallments:buildCreditCardInstallmentsResponse / ccCupoSnapshotForAccount / ccInstallmentPlanTailClp | `pendingCuotaPurchaseLines`, ledger payload | cupo, pending-purchases notice, plan tail | WP + plans | flow + line id | no |
| 81 | ccDailyHistorialBlock / ccHistorialLinesAtMonthEnds (card page, group page) | walks above | display (historial lines, facturación bars) | n/a | aggregates | no |
| 82 | ccBillingViews:buildFacturaciones, ccBillingStatementSlots, ccBillingCloses, ccManualBillingMonth | `listCcStatementsForAccount` (statements, not lines) | facturaciones rows, close evidence, open month | PDF/JSON/WP by `source_pdf` predicates (≈40 sites, F9 step 2) | statement rows | no |
| 83 | liabilityTree / dashboard liabilities | `liveCreditCardOutstandingClp`, valuations | pasivos | none | aggregate | no |
| 84 | flowsExpensesGastos:buildFlowsExpensesGastosPayload | `buildFlowsExpenseLines` (via `cachedFlowsExpenseLines`) | gastos Total and Por cuota | via #46 (`web_paste` flag) | flow lines | no |
| 85 | flowsOverview, flowsMortgageCarrying, latestExpenses, paymentProcessorReceipts, additionalCardReimbursements, ccPurchaseExpenseLinks | `cachedFlowsExpenseLines` | gastos (spending, mortgage carrying, receipts matching, additional cards) | via #46 | flow lines | no |

## D. Checking / income / deposit rows (`movements`)

| # | Reader | Loader / table | Needs | Src | Shape | W |
|---|---|---|---|---|---|---|
| 86 | checkingCartolaLoaders:listCheckingMovements | `movements` WHERE note LIKE cartola / cartola-partial / santander-mail / mach-mail / bancochile-mail, anchor excluded, daily rows not yet replaced removed | the one checking source: gastos, income, deposit matching | **by note prefix** (cartola vs daily vs mail-rebuilt) | raw (id, note parsed for daily feed) + flow | no |
| 87 | checkingCartolaLoaders:loadCheckingCredits / loadCheckingWithdrawals / loadAllCheckingWithdrawals / loadMovementBalanceCashCredits | #86 | income, checking gastos, deposit matching | note prefixes | flow (date, amount, note) | no |
| 88 | checkingCartolaLoaders:loadDepositMatchCandidates / loadNetWorthCapitalOutflowCandidates / loadCuentaVistaInternalTransferCredits / loadAfpRetiroOutflowCandidates | `loadMergedDepositInflowEventsBankDatedWithTransferCounter` | deposit matching (claim_key, bank-dated, transfer counter, `checking_own_traspaso`) | n/a | flow + claim_key + movement_id | no |
| 89 | accountDeposits:buildMergedDepositMap and its five loaders (`loadMergedDepositInflowEvents[BankDated[WithTransferCounter]]`, `loadMergedDisplayDepositInflowEvents`, `get…ForAccount`) | `movements` (single-leg, transfer legs, mirror merges, mirror-pair re-dating) | deposit events: capital in/out per account, bank vs display dating | n/a (personalOnly flag drops state bonus) | flow (date, amount_clp/usd, kind, account) + claim key | no (cached) |
| 90 | flowsCheckingGastos:createCheckingGastosLineBuilder / buildCheckingGastosLinesForAccounts / splitCheckingWithdrawalAgainstDeposits / matchWithdrawalToDeposit | `listCheckingMovements(…,"out")` + deposit candidates | checking gastos (and deposit matching of each debit) | note prefixes | raw (movement id, `auto:deposit-match` note segments) | no |
| 91 | flowsCheckingGastos:assignCheckingGastosMovementCategory / checkingGastosMovementPurchaseKey | movement + `checking-mv:` / `checking-cartola:` keys | category assignment, key identity | n/a | raw (note-derived key) | **yes** |
| 92 | flowsCheckingInflows:buildFlowsCheckingIncomePayload (+ `loadCheckingCreditsWithId`, `loadConsumedNetWorthCapitalReturnOutflowKeys`) | `listCheckingMovements(…,"in")` + overrides + refunds + payslip links | income (kinds, overrides, internal-return exclusion) | note prefixes | raw (movement id) | no |
| 93 | flowsCheckingIncomeOverrides (load*, upsert, delete, restore, `isCheckingCredit`) | `checking_income_movement_overrides`, #86 | income (user kind mark) | n/a | raw (movement id) | **yes** |
| 94 | checkingExpenseRefunds (load*, mark, unmark, set category) and `checkingExpenseRefundLineDrafts` (flowsExpenses `:874`) | `checking_expense_refunds` | income vs refund-of-spending; negative gastos line | n/a | raw (movement id) | **yes** (mark/unmark) |
| 95 | checkingSpendingMovements:checkingSpendingMovementKeys | `loadFinalizedCheckingGastosLinesReadOnly` | checking gastos (which movements are spending, for wealth-flows table) | n/a | movement key | no |
| 96 | flowsExpenses:loadCheckingGastosLinesForExpenses | checking builder + refunds + manual + gap mirrors + payslip lines | gastos Total/Por cuota (checking side) | n/a | flow drafts | no |
| 97 | flowsManualExpenses:loadManualExpenseGastosLineDrafts / create / update / delete | `expense_entries` without place | gastos (manual) | n/a | flow + `manual:` key | **yes** (CRUD) |
| 98 | flowsCheckingGapDepositMirrors:loadCheckingGapDepositMirrorGastosLineDrafts | gap mirror table | gastos (synthetic lines for lost cartola months) | n/a | flow | no |
| 99 | flowsDepositsReconciliation:buildDepositsReconciliationPayload / resolveInternalNetWorthTransfers | `loadFinalizedCheckingGastosLinesReadOnly`, deposit events | deposit matching, reconciliation | n/a | flow + keys | no |
| 100 | expenseDepositLinks (load, sync, computeManualDepositAssertions, tryAutoLinkExpenseDepositLine, mortgage sheet sync) | candidates from #88, gastos lines, links table | deposit matching (links, manual assertions) | n/a | raw (purchase_key, `auto:deposit-match` note) | **yes** |
| 101 | backfillCheckingAutoMatchCategories | `loadDepositMatchCandidates`, notes | deposit matching → category backfill | n/a | raw | **yes** |
| 102 | flowsDeposits:buildFlowsDepositsPayload / flowsDepositsNetTotalsByAccount / netDepositFlowWindows | `loadMergedDisplayDepositInflowEvents` | deposits (capital flows), P/L denominators | n/a | flow | no |
| 103 | valuationTimeseries:buildPointsForAccounts; dailySeries:gridFlows / accountDepositCumsOnGrid; benchmarkComparison; projections:defaultMonthlyAporteClp; accountDetailBundle; exportWorkbook; fxBidAskGaps; fxConversionWarningScan | `loadMergedDepositInflowEvents` / `…Display…` | deposits (capital flows) for charts, P/L, benchmark, export, fx audits | n/a | flow | no |
| 104 | flowsOverview (income, expenses, deposits, cash change; uses #92 payload and cached expense lines) | #92, #96, #89 | income, gastos Total, deposits, cash | n/a | flow | no |
| 105 | flowsApi:buildGroupFlows (`:313`) | `checkingSpendingMovementKeys` | checking gastos (hide spending from wealth-flows table) | n/a | movement key | no |
| 106 | payrollWorkEarningsLinking:listPayrollLinkCandidates / findPayrollAutoLinkMovement (used by payslipsApply, flows route) | `buildFlowsCheckingIncomePayload` credits | income (payslip ↔ deposit pairing) | note prefixes | raw (movement id, note employer token) | no (payslipsApply writes) |
| 107 | movementMirrorPairs / ccPaymentMirrors candidate lists | `movements` single-leg debits and credits | payment evidence / internal transfer pairing | n/a | raw (ids, notes) | **yes** (conversion) |
| 108 | checkingCartolaImport / checkingPartialMovementsImport / checkingCartolaPartialReconcile / checkingTransferLegReconcile | `movements` by note key (`LIKE`, daily-feed grammar) | dedupe/import identity | note | raw | **yes** |
| 109 | payslipExpenseLines (via expenses payload) | payslip tables | gastos (payroll deductions, `pre_tax`) | n/a | flow | no |

## Views the module must offer

Counting the table above, every reader needs one of these. The first four cover about 55 of the 63 line readers.

1. **Debt events** `debtEvents(account, {from, to})` → `{date, currency, amount (signed), kind, source_key}`. Combines one-shot lines (flag 0), plan purchase events (principal on the purchase day, interest as its own cost event), header payments, traspaso legs and nota cancellation, with «a line that has a plan counts once» and the backdated-line rule applied inside. Consumers: #1, #5, #6, #12, #65, #77, #78, #79, #45. This is the view the owed walk, financing cost, month-end anchors and cuota retirement all read; today they build it from `normalizedPostCloseLines` + `normalizedInstallmentPurchaseEvents` + `listSchedulePurchaseEvents` + `ccInstallmentInterest*`.
2. **Billed / open-cycle view** `openCycleLines(account)` and `billedFor(account, billingMonth)`: únicos, credits, payments per currency, pending cuota purchases, with a `source_kind` stamp (bucket vs statement) rather than each reader testing `source_pdf`. Consumers: #2, #3, #4, #8, #9, #10, #20, #21, #79, #80. The pending-cuota list and the bucket-only filter (#9, #10) exist only here.
3. **Expense lines** `expenseLines(accounts, mode)`: the existing `buildCcExpenseLines` + plan lines (#46, #48–#50), for gastos Total and Por cuota, with `statement_line_id`/plan id, `parser_row_id`, source kind, and the classifier stamp. Consumers: #84, #85, #46. It must be generic enough that checking lines (#96) have the same shape, with the plan overlay absent.
4. **Plan schedule** `plans(account)` → one object per plan: principal, count, first_due_month, source, twin_index, payments (cuota, billing month, pay-by), cancelled flag, interest. Consumers: #11, #24, #25, #49, #50, #64–#67. Pay-by and cupo derive from it; the module owns `purchaseFirstDueYm`.
5. **Payment evidence** `paymentEvidence(account)` → payment lines, header payments, planted payments, with stable key (card, currency, date, amount). Consumers: #12, #16–#19, #36, #15.
6. **Financing and proxy inputs**: charges by day (section 3), plan interest, normal purchases for the proxy (#14, #23, #45). A filter on view 1/3 by `kind`, not a separate view.
7. **Merchant search over lines** `findLines(account?, {merchantLike, amount, dateRange})` → flow + `line_id`, for the matchers of other domains (#53, #57–#63). A read-only pairing helper; F17 can own it.
8. **Checking: one `bankMovements(account, direction)` and one `capitalEvents(accounts, dating)`** (#86–#89), then `checkingGastos` / `checkingIncome` derived from them with the user's kind (refund, income override) as a stored column, per F9/F10. Gastos and income readers (#90–#96, #102–#106) need flow plus `movement_id`, `claim_key` and bank posting day only; none needs the note once identity and provenance are columns.
9. **Write funnels, not views**: line import (#38), reconcile/adoption (#39, #40, #42), dedupe (#32–#35), planted payments (#36), plan CRUD (#68–#72), feed plan creation (#22). They stay inside the module, behind F11's per-aggregate funnels.

## Readers that genuinely need the raw table

| Reader | Reason |
|---|---|
| ccStatementsImport:importCcStatementsMerge (#38) | Writes lines and owns `dedupe_key`, `parser_row_id`, fingerprints. |
| ccExpenseLineDedupe, ccCrossImportDedupe, ccTruncatedMerchantDedupe, ccRecurringPendingLines (#32–#35) | Decide identity between arriving evidence and stored lines; need ids, keys and source kind. Candidates for F17's matching kit. |
| ccOpenWebPastePdfReconcile, ccOpenWebPasteRepair, ccManualInstallmentStatementReconcile (#39, #40, #42) | Move, delete and replace evidence; becomes «attach evidence» after F9 step 4. |
| ccPlantedPayments, ccStatementLineDelete (#36, #37) | Mutate specific lines by id. |
| ccExpenseCategoryPersist, ccExpenseLineRekey (#30, #31) | Re-key movers; disappear after F9 step 5. |
| ccExpenseCategories key resolvers (#26, #27) | Map purchase keys to line ids through `parser_row_id`; the key module (F9 step 1) replaces them. |
| expenseDepositLinks `:606` (#56) | Parses the key by length in SQL; same fix. |
| ccInstallmentLedgerMerge, ccInstallmentManual, ccInstallmentPaymentBackfill, ccWebPasteInstallmentNudge, ccFeedCuotaPurchases, ccStatementPdfUpload (#22, #68–#72) | Plan writers; own `canonical_row_id`, `twin_index`, `first_due_month`, `source`. |
| ccInstallmentLedgerDb:loadLedgerPurchasesAndPayments (#24) | Joins payments to lines by `parser_row_id` for the statement period; the only place plan ↔ line is linked. Should become the module's own internal join. |
| ccInstallmentInterest (#23) | Same `parser_row_id` join to read the printed principal and rate. |
| ccTraspasoDeudaLinks, ccPaymentMirrorEvidence (#16, #19) | Persist line ids / pair by statement id and need PDF-only lines. |
| ccStatementImportReconcile, cardStatementCrossCheck (#41, #43) | Compare parsed rows with stored ones by `dedupe_key`. |
| checkingCartola* imports and `listCheckingMovements` (#86, #108) | Identity lives in the note today (cartola, daily-feed grammar, mail prefixes); needs columns first (F9 step 2). |
| flowsCheckingGastos / flowsCheckingIncomeOverrides / checkingExpenseRefunds (#90–#94) | Key assignment by movement id and note-derived keys. |

Everything else (≈ 40 of 63 line readers, and every plan reader outside the writers) needs only a flow view plus an id for linking.

## Observations for the API decision

- **Source-kind tests are the main non-flow dependency.** Readers filter by WP/PDF in #1 (USD sub-select), #3, #7, #9, #10, #16, #19, #21, #32, #33, #34, #35, #36, #41, #46 (flag), #53, and ≈ 40 statement-level sites via `listCcStatementsForAccount`. With a stored `source_kind` and a per-line `evidence` stamp, only #9, #10 and the writers need to ask.
- **«A line that has a plan counts once»** is applied in at least 8 places by calling `oneShotStatementLineIdsSupersededByInstallmentPurchases` (#2, #3, #6, #9, #10, #14, #46) or re-implementing it (#33). It is the first thing view 1 and view 3 must own.
- **Only three plan readers want a plan without a line** (#5 purchase events, #48 payment gastos lines, #49 plan breakdown): statement-owned and manual plans the statement does not list. Those are the «plan with no line» case in F10.
- **Direct plan ↔ line joins by `parser_row_id`** exist in #23, #24, #26, #27, #30. Every one wants «the line behind this cuota», so the module can expose `lineForPayment` and keep the join private.
- **Mortgage and receipt matchers (#57–#62) scan all lines by merchant LIKE or amount**: they need the cheap `findLines` search, not a view of the whole purchases set.
- Not covered: statement-level readers that never touch lines (`cc_statements` only: ccBillingCloses, ccManualBillingMonth, ccBillingStatementSlots, ccBillingInactive, cardUnbilledMovementsApply) other than as a source-kind consumer; routes, which call the modules above; `server/scripts` and tests.
