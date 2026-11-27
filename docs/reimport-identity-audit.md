# Re-import identity audit (2026-11-26)

What happens to a purchase's identity when the same purchase reaches the app a second time: a
listing then its statement, a receipt then the bank's row, a pending row then the settled one, a
daily bank row then the cartola, a re-import after a parser fix.

Identity is the row's **flow**: its arrival stamp (`flow_first_seen`, which orders «Últimos
movimientos» and decides the "new row" animation), category («Único»), note, big group, pieces and
links. A path is correct when one flow survives. It is a defect when a row is deleted and another
row stands for the same purchase with a new flow.

Method: four read-only code audits by area (card listings, card statements and plans, checking and
transfers, the shared flow plumbing), then spot checks. **Verified** = I read the deciding lines
myself or reproduced it; **reported** = an audit agent's reading, not yet re-checked.

## How a row can be replaced

| Mechanism | Flow | Arrival | Assignments |
|---|---|---|---|
| Restate in place (`restateCardLineRow`, `restateMovementFromCartola`) | kept | kept | kept |
| Carry (`CardLinePlan.carry` → `adoptReplacingCardLines`) | old flow moves to the new row | older kept | kept |
| Fold (`fold` → `foldCardLineFlowInto`, `mergeFlowInto`) | merged | older kept | earlier arrival's win |
| Arrival only (`copyFlowFirstSeen`) | new | kept | **lost** |
| Delete and insert | new | **lost** | **lost** |

Two facts about the plumbing make the last row costly:

- A flow with nothing filed on it and no stable key is **deleted** with its row, stamp included; a
  flow that holds something is **retired** and nothing reads it again unless a path names it.
- Only bank movements take a retired flow back on insert (`adoptRetiredMovementFlow`, by document
  key, called from `insertBankPesoMovement`). Card lines, cuota plans and manual expenses have no
  such step: every card path must name the old row itself.

## Defects

### Fixed in this change

| # | Path | What happened | Status |
|---|---|---|---|
| 1 | Cupo-gap removal of a restated line (`cardUnbilledMovementsApply.ts`, `planCupoGap`) | A receipt's card line the bank listed under its acquirer's name was deleted with `carry: []`; the bank's line was a new flow. This is the 2026-11-26 incident: the purchase jumped to the top of «Últimos movimientos» two and a half hours after it was first seen. It is the only path a listing with no stated close (BCI) takes. | Verified by replaying the listing on a snapshot copy; fixed (`carryOnto`), test added |
| 2 | Feed mirror restatement (`planOpenBucketMirror`) | Same defect on listings that state a close (Santander). | Fixed (carry when exactly one row restates the line), tests added |
| 3 | One-shot line replaced by its cuota plan (`planOneShotLinesSupersededByInstallmentPurchases`, `planOneShotLinesForInstallmentPurchase`) | Only the arrival reached the plan; the line's «Único» category, note, big group were stranded (the per-line override only on the statement path). | Fixed: the line's flow folds into the plan key's flow (`foldLineFlowOntoPlan`, via `ensureFlowForKey`), earlier arrival's assignments win, override on every path; an import drops pieces and reports them (`pieces_dropped`, a notification), the hand paths refuse; conversion copies them. Tests through the expense lines |
| 5 | Bucket settlement, `covered_by_plan` | A bucket line a plan covers that the supersede step did not take was deleted with nothing carried. | Fixed: deleted after the ledger merge, folding into the one plan that covers it (two plans: nothing carried). Test added |
| 10 | Plan matching took every look-alike (`findOneShotLinesOfPlan`, `oneShotLinesSupersededAmong`) | A genuine twin (same shop, day, pesos) already on file beside the plan's purchase was deleted. | Fixed for lines on file: a plan takes one line per exact merchant and pesos, counting the lines it took before (history evidence on its flow); a different rendering still goes. Tests added. A twin listed after the plan exists: still open (10b below) |
| 12 | Card-to-card payment transfers (`syncCardToCardPaymentTransfers`) | Deleted and written again on every card write or boot whenever a part's line id, plan id, amount or day changed: a new flow stamped now, so the payment re-entered «Últimos movimientos» as new and lost its note or big group. | Fixed: a part re-keyed with the same transfer keeps its movement; a changed transfer folds the old flow into the new one. Tests added |
| 13 | Mirror conversion by hand (`convertMirrorPairs`) | The transfer was stamped now; neither leg's arrival, note or category was carried. | Fixed: both legs' flows fold into the transfer's (older arrival, earliest event time, assignments); a pair whose legs' assignments conflict is blocked in the list and skipped by a batch. Tests added |
| 14 | Mirror undo (`undoMirrorConversion`) | Restored legs were stamped now; their retired flows were not taken back. | Fixed: restored legs take back a retired flow of their document, then the transfer's arrival, event time and assignments (inflow-account categories and notes to the inflow leg, the rest to the outflow leg). Test added |
| 16 | Automatic card-payment conversion (`convertCcPaymentMirrors`) | Arrival was copied; the debit's note, big group or refund mark was not. | Fixed: the debit's flow folds into the transfer's; its undo hands it back. Test extended |
| 11 | Ledger rebuild (`import:cc-parsed --replace-ledger`) | Deleted every statement plan and wrote it again: new ids and flows. What broke: the plan's arrival and flow assignments, a bank prepayment (`cc_plan_prepayments`) and the feed's provenance row (`cc_feed_installment_plans`), both FK-cascaded away, and the card-to-card part's `part_ref`. | Fixed: a plan the statements still state stays the row it is; a stale plan is deleted after folding into a same-identity kept plan, and the rebuild refuses (nothing written) when a stale plan is named by a prepayment, feed provenance or card-to-card part. Test added |
| 8 | Re-listed annulment (`removeRelistedAnnulments`) | The annulment was deleted and the listing row imported under a new key and flow when re-listed a day later or under another rendering. | Fixed: the row that stands for the purchase — the new listing line, else the plan or statement line the row was skipped for — takes the annulment's flow before the annulment goes (`settleRelistedAnnulments`); with no single such row the annulment stays standing and is reported. A standing annulment's flow is never folded into another line by document key. Tests added |
| 9 | Annulment of a line with nothing filed on it | The delete trigger deleted the bare flow, so the annulment lost its flow and arrival. | Fixed: migration 380 makes the annulment hold its flow (retired, not deleted; indexed); a billed line takes the older arrival of the flows folded in, its own unstamped flow left out. Tests added |
| 15 | Cartola removes a daily row a transfer leg or a mail row already lists | The daily row's category, note, income classification and arrival were not folded into the kept row. | Fixed: folded first into the transfer leg or mail row (`foldListedRowIntoConfirmed`, earliest arrival's assignments win); a fold the flows cannot make is refused and reported (`listed_row_folds`); a row a tax settlement names is left alone and reported (`left_alone`) — before, its delete failed the import. Tests added |
| 17 | Fuller cartola replaces a month (`replaced_cartola_row`) | A reworded row the three passes miss was deleted and written again on a new flow. | Fixed: a fourth pass restates the one left-over row and the one new movement of a bank day and signed pesos (`same_day_amount`); two or more of either are left as before. Test added |

### Open — card side

| # | Path | Trigger | Lost | Status |
|---|---|---|---|---|
| 4 | Bucket settlement, unmatched in-cycle line that cannot be annulled (a credit, a payment, a cuota-tagged line) | Statement close, when the statement prints it under another merchant or day | Everything; the statement's line is stamped new | Reported |
| 6 | Statement re-import, vanished line with no pair (`gone`) | A parser fix that changes a line's amount or merchant | Arrival, note, big group, flow category; not reported anywhere | Reported |
| 7 | Statement re-import, identity group with differing counts (`unpaired`) | A re-parse that splits or merges lines | Everything on the old lines; reported only in the `import:cc-parsed` text and `report-document-import.ts`, dropped from the statement JSON write and the PDF upload results | Reported |
| 9b | Annulments recorded before migration 380 whose bare flow was already deleted (`flow_id` NULL) | Billed or re-listed later | The arrival: nothing to take back | Open (data, not code) |
| 10b | A twin listed after its plan is on file (`plan_on_file` in `statementLinePlan.ts`, `shouldSkipOneShotStatementImport` in the listing merge, `findPlanAmong` / `findPlanForOneShotLine`) | A genuine twin purchase listed or printed once the plan exists | The twin is skipped as the plan's purchase. The slot rule cannot apply here: the plan's own row re-listed the next night (its line deleted, so its dedupe key is gone) reads exactly like a twin, and taking it would double-count every feed cuota purchase. Needs a stored identity of the row a plan took (its listing key) | Open |

### Open — checking and transfers

| # | Path | Trigger | Lost | Status |
|---|---|---|---|---|
| 15b | Records naming a removed daily row by id other than the payslip (`movementRecordsNaming`: loan payments, payslip advances, pension periods, transfer notices, event times, wire bookings, tax settlements) | Cartola removal or fold | They cascade with the row (tax settlements block the delete); now reported, not moved | Open |

### Scripts (manual runs)

Fixed, each with a test of the function the script calls: `backfill-cc-duplicate-expense-lines.ts`
folds each duplicate into its kept twin; `list-missing-cc-statement-pdfs.ts --prune` deletes through
the card-line write funnel, reports lines carrying filed work per statement and refuses them without
`--allow-assignment-loss`; `repair-cc-installment-duplicate-purchases.ts` folds each removed sibling
plan's flow into the kept plan's; `remove-cc-duplicate-download-statements.ts` hands each copy line's
flow to the real statement's line (and refuses flows that conflict); `repair-mirror-merge-legs.ts`
undoes and swaps through the app's code (`undoMirrorConversion` with the original ids,
`swapMirrorConversionLeg`), so flows follow the legs.

Still open: a swap hands the replaced leg back only its arrival, event time and the category and
note rows filed under its account; a big group, pieces or link filed on the absorbed leg stay on
the transfer (they carry no account to tell the legs apart). None of the scripts was run against a
real database; the tests use synthetic fixtures.

## Paths that keep identity

Listing merge (never deletes; every skip writes nothing, and a skipped duplicate never updates the
line on file beyond the origin card), truncated and pending merchant dedupe (carry), planted
payments replaced by the bank's line (carry), recurring pending lines (carry), bucket moves
(in-place update), statement restate, folds and source takeover, the JSON close a PDF takes over,
annulments (flow kept on the annulment), grocery and lender receipts (insert only; they skip when
the bank's line is already on file), the daily checking listing (skips, or restates in place), the
cartola restate and fold, mail-written and synthesized rows later confirmed by the bank, the
Fintual promotion in place, ledger anchors and AFC true-ups, and the broker imports (insert only).

## «Últimos movimientos»: what can move a row besides its stamp

- A stated time appearing later for one row of a day (a receipt paired at read time, a payment
  receipt, a mail) reorders it against rows that only have an estimate.
- An ingest run still open counts for three hours; a write made by hand during it joins the run's
  batch and leaves it when the run finishes.
- The grocery-receipt pairing is computed over the rows the list currently reaches, so which line
  takes a receipt's time can depend on what else is in the list.

**Not pursued:** on 2026-11-26 one row was reported above a same-day neighbour for a while, between two
states the database snapshots explain. None of the inputs above changed for those two rows in the
snapshots, and the observation may have been a misreading.

## Test coverage

Stamp preservation is tested for the statement line re-import and the cartola restate. No test
covered the mirror or the cupo gap before this change. Nothing tests: mirror conversion and undo,
bucket settlement of a credit, or the ordering inputs listed above.

## Plan (branch `claude/reimport-identity`)

Each wave: implementers work in their own worktree off the branch tip, an independent review of
each diff follows, findings are fixed, the full server suite runs, then the wave merges into the
branch. A pause after every wave.

| Wave | Items | What changes |
|---|---|---|
| 1a | 3, 5, 10 | A one-shot line its cuota plan replaces hands the plan its whole flow (category, note, big group, pieces), not only its arrival; `covered_by_plan` does the same; a real twin beside the plan's purchase is not deleted |
| 1b | 13, 14, 16 | Mirror conversion by hand, its undo and the automatic card-payment conversion keep the legs' arrival and assignments |
| 2a | 4, 6, 7 | Bucket settlement of a credit, payment or cuota-tagged line printed under another name; re-import lines with no pair; `unpaired` and `gone` reported in every import result |
| 2b | 8, 9, 15, 17 | Re-listed and bare annulments; the cartola folding a daily row a transfer or mail row already lists; a fuller cartola's re-rendered row |
| 3 | 11, scripts, general step | The ledger rebuild, the four manual scripts, and whether card lines get a general "take the retired flow back by key on insert" step once waves 1–2 show what is left |

## Suggested order of work

1. **3** — the most common way filed work is lost: every purchase paid in cuotas goes through it.
2. **13–15** — fold or adopt before deleting, as the sibling paths already do.
3. **4–7** — settlement and re-import leftovers; make 6 and 7 visible in every import result first.
4. A general step for card lines like the one movements have (take a retired flow back by key on
   insert) would close the remaining gaps in one place rather than path by path.
