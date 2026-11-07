# Expenses: one purchases module, lossless cuotas, one identity per expense (2026-11-07)

## Why

Three things surfaced from one request («the cuotas input should still appear on the expense»):

- **Converting a one-shot card line to cuotas deletes it.** `convertStatementLineToInstallmentPurchase`
  deletes the statement line and creates a manual plan (`cc_installment_purchases`), because every
  reader of installment debt works from the plan and the owed walk adds a plan's whole total on its
  purchase date (the line would count twice). Removing a wrongly converted plan
  (`deleteManualCcInstallmentPurchase`) restores nothing, so the expense vanishes from the ledger
  and from gastos. A wrong count is editable (`PATCH /cc-purchases/:id`), a wrong conversion is not
  reversible. Both only work on `source = 'manual'` plans.
- **Readers filter the same lists separately.** 44 server files read `cc_statement_lines`, 21 read
  `cc_installment_purchases`, and the one place that already is «the list every reader uses»
  (`pendingCuotaPurchaseLines`, `schedulePurchases`; 28 references) covers only part of it.
- **An expense has no identity of its own.** Its identity is whatever its source document calls it:
  `line-pr:<parser_row_id>`, `installment-h:…`, `checking-mv:<movement>`,
  `checking-cartola:<account>:…`, `manual:<id>`, a piece's `<key>#split:<seq>`. 39 server files
  touch `purchase_key`; ~10 assignment tables hang off it (categories, «Único» rows, notes, big
  groups, line splits, real-estate links and rejections, deposit links, checking refunds,
  financing links). Every change of source — a bucket line settled by its statement
  (`reconcileOpenWebPasteAfterPdfClose`), a manual plan replaced by its statement twin
  (`reconcileManualInstallmentPurchasesForStatements`), a daily checking row replaced by its
  cartola row (`prunePartialMovementsSupersededByCartola`), a mail-written movement replaced by
  the bank's listing (`superseded_by_mail`), a re-import with a new `parser_row_id` — deletes and
  recreates the row and needs carry code afterwards (`ccExpenseLineRekey`,
  `carryCcExpenseAssignments`, `transferCheckingGastosCategoryFromMovementToNote`,
  `carryMovementKeyedIncomeState`).

The model this plan builds: **an expense is one entity with a stable id; documents (a pasted line,
a feed row, a statement line, a cartola row, a bank mail, a manual entry) are evidence attached
to it; a plan is a schedule overlay on a card expense; links to other things (a deposit it funded,
the mortgage it paid, the purchase a refund annuls) hang off the expense, not off a source.**

## Scope

Card lines, checking movements (debits, refunds, the deposit-paired portion, internal transfers)
and manual expenses. Cuotas are card-only. Income shares the lifecycle (payslip pairing and
income overrides are keyed by movement id and carried by `carryMovementKeyedIncomeState`); it
follows the checking work but is not an expense.

What card and checking share, corrected from the first draft: **refunds** (a card credit is
spending coming back — `markCardRefunds`, `isGastosRefundLine`; a paired nota de crédito nets with
its purchase), **pieces** (`canEditPieces` allows both) and **internal transfers** (card-to-card
debt moves, the peso leg of a traspaso de deuda). What differs: how a refund is recognised (on a
card the sign decides it, derived; on checking a credit may be income, a refund or a transfer, so
the user's mark is stored in `checking_expense_refunds`), and the deposit-paired portion, which
today exists only for checking but is not checking-specific (see «Links»).

## Relation to `docs/untangle-plan.md` (read, not modified)

This plan overlaps the app-wide untangle plan in five places and conflicts with it in one. The
two should be consolidated into one sequence; this section is the mapping.

| This plan | Untangle item | Relation |
|---|---|---|
| Phase 0 audit | F9, F10 audits | same audit, do once |
| Phase 1 purchases module | F10 (one line classifier, one facturación module), F11 (pure read pipeline) | this is the read side of F10/F11; build it in F1's target folder, not in `ccExpenseCategories.ts` (1352 lines, 37 importers, imports the installment ledger) |
| Phase 2 conversion keeps the line | F11 (write funnel per aggregate; `ccInstallmentManual.ts:195-243` runs the delete sequence in two orders; bug 3) | needs F11's card-line write funnel, or it rewrites a path F11 owns |
| Phase 3 row controls | F12 (server sends per-line flags; bug 13), F19 | `canDelete` / `canMakeInstallment` should become server-provided capability flags; bug 13 (manual expense save/delete and pieces skip `latestExpensesAll`) is in the mutations desglosar touches |
| Phase 4 stable identity | **F9** | same problem, different answer — see below |
| `kind` column | F10 (line classifier stamps payment / section 3 / refund / internal / spending and its counts per mode), F19 (retires `loadCheckingExpenseRefundMovementIds`, wrappers) | one column, one classifier; coordinate the deletions |
| Matching rules | F17 (one pairing helper: nearest day, twins in order, ambiguity reported; one window table; the mortgage cuota ↔ card line is paired twice, ±14 days stored vs 0–3 days at read time) | adoption matching is F17's helper; the mortgage link is the same pairing |
| Links, card-funded capital flow | F4 (cash ↔ card netting declared as data, ~10 slug decisions), F5, F6 (card flow identity and mortgage flows each written twice) | implement after F4–F6, or the rule becomes a third copy |
| Everything above | F1 (folders, one dependency direction), F2 (cache registry; new reads register their dependencies) | new modules are created in the final layout |

### The conflict: F9 vs the stable expense entity

F9 stamps each line at import with a key **derived from the document** (card, currency, date,
amount, merchant, twin index; cartola period and index; mail id), builds one typed key module
for the ~12 key families, moves provenance from notes and `source_pdf` prefixes into columns,
and collapses the three re-key mechanisms (`ccExpenseCategoryPersist`, `ccExpenseLineRekey`,
`checkingGastosCategoryPersist`). Bugs 2 and 8 (refund marks, big groups and pieces lost when a
cartola replaces a daily row; twin outflows collapsing into one claim) are its checking-side
failures.

A content-derived key is the same across a bucket line and its statement line only while date,
amount and merchant agree. A restated pending line changes the key, so F9 alone shrinks the
carry code without removing it, and every new line-keyed table must still be added to each
mover. A stable entity handles restatements. But adopting evidence into an expense reliably
needs F9's structured pieces (one typed key module, provenance in columns), or the matching
would still parse strings in ~40 places.

**Resolution: the entity is F9's end state; F9's pieces are the steps that reach it.**

## Phase 0 — audit (read-only)

List every reader of lines and plans and classify what each needs: debt events (owed walk), billed
estimate, cupo, gastos (Total and Por cuota), the facturación proxy, schedules, checking gastos,
income, deposit matching. Output: a table in this file. Decides the phase 1 API and shows which
readers genuinely need a raw table. Include the checking and income readers, not just the card
ones: a checking row never has a plan, and the interface must fit both.

## Phase 1 — one purchases module

- `effectiveCardPurchases(accountId)` (name open): each purchase comes back as a plain one-shot
  line, a line with a plan overlay, or a plan with no line (statement-owned plans, plans converted
  before phase 2). Each reader asks for its own view — debt events, expenses, billed — and the
  «a line that has a plan counts once» rule lives only here.
- The interface is generic (an expense with attached evidence); the card version adds the plan
  overlay, checking adds none. Cards first, but the shape must fit checking or phase 4 is a rewrite.
- Migrate readers one at a time with no behaviour change, byte-checking payloads on a real-DB
  copy (the method of the earlier refactors).
- A guard test fails when a reader sums `cc_statement_lines` / `cc_installment_purchases`
  directly instead of asking the module, as the parity tests do elsewhere.
- Done when no reader filters the two tables itself.

## Phase 2 — conversion keeps the line

- The plan links to its line (`source_line_id`, or `converted_plan_id` on the line); conversion
  creates the plan and no longer deletes the line. Precedent: a bucket line tagged with
  `cuota_purchase_kind` already stays on file, leaves the billed estimate and counts as
  installment debt until its plan arrives.
- The phase 1 module resolves line + plan to one expense: debt counted once, gastos «Total» shows
  the line once at full price, the «N cuotas» detail comes from the plan.
- Undo = delete the plan; the link goes with it and the line is live again, with its category,
  note and big group untouched (they never moved). Count edit = the existing PATCH.
- Expense lines carry `installment_purchase_id` and `installment_source`, so a row knows whether
  its plan is editable (`manual`) or frozen (statement-owned).
- Plans converted before this have no line to link; they stay as they are (undone by deleting the
  plan, as today).
- A closed facturación still replaces a bucket line and a manual plan with the statement's own
  (the existing reconcile, unchanged) until phase 4.
- Done when convert, change count and remove are lossless on a copy of the real DB.

## Phase 3 — row controls

- The cuotas control moves to the row for plain lines and manual plans: convert, edit the count,
  remove. Statement-owned plans and facturado lines show nothing (only the note stays editable).
  Already done in the first pass: inline count input next to the «¿cuántas?» prompt (modal
  removed), Delete and convert owned by the row (`DeleteLineButton`, `CuotasInline`; the table
  takes no deletable props, the row reads `ln.web_paste`).
- Drop the «Compra en cuotas · N cuotas» superscript on the full-price row; «N cuotas» goes in the
  ⓘ card (reuse `installmentPurchaseTotalLabel`, shortened to «{{count}} cuotas»). The per-cuota
  rows keep `3/6 · $270.000`.
- «Desglosar» (pieces) moves into the row so every surface has it, the dashboard included; the
  row mounts the existing pieces dialog (only the expenses month modal passes `onEditPieces`
  today). Pieces stay off installment lines.

## Phase 4 — stable expense identity (= F9 steps 1–5)

Order, which is also F9's:

1. **Typed key module.** Pure refactor: one module builds and parses all ~12 key families
   (`installment-h:`, `installment-pr:`, `installment:`, `line-pr:`, `line:`, `line-fallback:`,
   `checking-mv:`, `checking-cartola:`, mirror, `manual:`, `payslip:`, `#split:`); the legacy-key
   runtime fallbacks (`ccExpenseCategories.ts:297-370,413,996-1060`) are resolved at migration
   and then fail loudly instead of guessing.
2. **Structured provenance columns.** A statement `source_kind` replaces the five `source_pdf`
   predicates (~40 prefix tests); the cartola identity, the deposit-match result
   (`auto:deposit-match|…` is written into the user's note today) and the mail / feed provenance
   move out of notes into columns.
3. **Expense and evidence tables.** Each existing assignment key becomes an expense whose first
   evidence is that legacy key, so every current assignment maps 1:1 with nothing lost. Migrate
   the assignment tables one at a time (migration 235 did this for big groups), starting with the
   checking ones hit by bugs 2 and 8: refunds, big groups, pieces, deposit links.
4. **Adoption on arrival.** A statement, cartola or bank mail attaches its evidence to the
   existing expense (matching rules below, F17's pairing helper, ambiguity loud).
5. **Delete the three re-key movers** and the checking / income carry code once no table
   references a line key.

Details:

- A single `expenses` table (id assigned at first sight) for card, checking and manual. The
  assignment tables already key on a bare `purchase_key` across sources (migration 235 did that
  for big groups), so one id fits them. Sources attach as evidence rows.
- Move the assignment tables to the expense id; retire `ccExpenseLineRekey` and the checking and
  income carry code once nothing needs them.
- A closing facturación, a cartola, a bank mail adopts the expense in place instead of deleting
  and recreating it. Precedent: the manual-to-pdf plan conversion when it is the contract's only
  row. The status (manual, feed, statement) is derived from the attached evidence
  (`isPdfStatementSource` and its checking equivalents), never stored text.
- **`kind` column** (purchase, refund, internal transfer, excluded): for cards derived at import
  from the sign and wording (structured state written once, not parsed later); for checking it
  holds the user's mark and replaces `checking_expense_refunds`. `markCardRefunds` and the checking
  refund table collapse into it. A refund may link to the purchase it annuls (a paired nota).

### Matching: same recognisers, different outcome

Candidate rules stay: the bucket-to-statement reconcile (`webPasteLineMatchesStatementLine`:
merchant, amount, date within a day), the rekey ladder (`parser_row_id`, then identity — account,
currency, date, amounts, cuota numbers, merchant letters — then twins in id order), and checking's
windows (signed amount, bank posting day via `bankDateMatchesTransferDate`, the daily row's note
key, a mail-written movement by exact signed pesos from the mail's day to six days after). What
changes:

1. **The match is stored.** Today it is thrown away (bucket line deleted, statement line
   inserted, a later pass re-guesses the pairing to carry assignments). With adoption the pairing
   is recorded once as «this evidence belongs to expense X», re-found through that record on every
   re-import; the identity ladder runs once per piece of evidence arriving, and again only when
   the parser changes a row's identity.
2. **Ambiguity fails loudly.** Twins pair in id order today and a wrong guess costs a category
   you can fix. After adoption a wrong guess merges two distinct expenses for good, so an
   ambiguous match is reported and left unpaired (GUIDELINES: throw on mismatch) until resolved.
   Identical twins, where order cannot matter, are the one exception.
3. **Each field has a declared authority.** Amount, date and merchant: statement over feed over
   paste over manual. The user's category, note, big group and pieces never move.
4. **Unmatched evidence has a defined outcome** (today: a bucket line inside the closed cycle
   that matches nothing is deleted as a pre-auth the statement settled differently; one outside
   the cycle moves forward; a later cycle's line is kept; `carryCcExpenseAssignments` pairs
   explicit restatements such as «CONVENIO P.A.T.» → «SEG AUTO SANTANDER»). In place these become
   states: the first retires the expense unless a fuzzier rule pairs it with the statement's
   differently worded line; the second re-targets the expense to the next facturación; the third
   needs nothing. The explicit carry cases become match rules with a fallback.
5. **Every non-trivial pairing is reported** (fuzzy, restated, ambiguous) in the import result.

## Links (part of phase 4)

Deposit funding is a property of any expense, not of checking. Today there are three one-off
mechanisms plus the matcher: a mortgage dividendo paid by card (still an expense; the overview
counts its amortización in `card_spent`, `mortgage_parts`), MACH top-ups (card lines set to
internal transfer by hand, the card leg of the transfer emits no deposit event), financing links
(`cc_facturado_financing_links`) — and `expense_deposit_links`, which only looks for deposit pairs
among checking outflows.

- One link table: `(expense_id, kind, counterpart, amount)` with kinds funding (the part that
  moved into another account), mortgage, financing and refund-of.
- The deposit matcher's candidate pool includes card lines as well as checking debits. The
  one-claim-per-deposit rule stays; the claim key stays the deposit event's, not the expense's.
- The expense's `kind` and the links drive gastos: the funded portion is not spending, the rest is.
- **Amount is stored on each link from the start**, default the whole line, with a check that a
  line's links never add up to more than its amount (fail fast). Partials already exist: the
  mortgage dividendo (amortización is capital, interest and insurance are spending) and the
  ahorro splits / the matcher's splittable reserva pool. New cases use the full amount; moving
  the mortgage and the ahorro splits onto the link model is a later step.
- **When does a card-funded capital flow count?** The cash bucket is checking and savings minus
  the linked cards' owed (`cashNetOfLinkedCreditCards`), so a card purchase leaves it on the
  purchase day, when owed rises; paying the card is internal. So the capital flow is dated on the
  **card line's day**, not the day the card is paid: the receiving account's deposit and the cash
  bucket's drop happen together and neither reads a phantom P/L. The flows overview (checking
  frame: `cash_change`, `card_spent − card_paid`) picks it up in `card_spent`, as it does the
  mortgage amortización, and again in `card_paid`.
- **One rule for top-ups:** a card-funded transfer is a capital flow only when its destination
  sits outside the bucket where the card nets. Into MACH (both ends in the cash bucket) the bucket
  does not change and nothing counts as capital; into brokerage it is a deposit from the cash
  bucket on that day. The hand-categorising of top-up lines goes away.
- Not yet verified: card flows are kept out of `/flows/deposits` and the deposits reconciliation
  today, and the principle above is derived from the bucket frame, not from every reader. Rehearse
  on a real-DB copy: the cash bucket's daily P/L must stay 0 on the purchase day and the
  overview's `cash_unexplained` must stay 0.

## Rehearsal and checks (every phase)

Each phase is proven on a copy of the real DB with before/after payloads (bundles, flows
overview, expenses, card ledgers, group and daily series), as the earlier refactors were. Phase 4
additionally compares every assignment (category, «Único», note, big group, split, link) one by
one against what the current carry code produces; each difference is either a bug or an intended
improvement, listed explicitly. Tests use synthetic fixtures only; `cd server && npm run test`.

## Order and open items

**Safe now, independent of the untangle sequence:** the label change («N cuotas» in the ⓘ card,
no superscript on the full-price row), the inline cuotas input and row-owned delete (done), desglosar
in the row, the bug 3 fix (`ccStatementLineDelete.ts` skips the valuation re-sync and the stamp
purge; Delete is now reachable from the dashboard row, but fix order does not matter) and the
bug 13 invalidations. None of them changes identity or the write paths.

**Merge into the untangle sequence** (its step 5: F9, then F10, then F11, then F17): phase 0 with
F9/F10's audit, phase 1 as the read side of F10/F11, phase 2 once F11's card-line write funnel
exists, phase 4 as F9's steps 3–5. The links and the card-funded capital flow rule come after
F4–F6. Dependency check (F1) first, as untangle says.

Open: the exact name and API of the phase 1 module (phase 0 decides it); whether manual expenses
and income move in the first or a second pass of phase 4; the claim rule for a deposit funded by a
card line when a checking debit of the same pesos also exists; coordination of the F19 deletions
with the `kind` column.
