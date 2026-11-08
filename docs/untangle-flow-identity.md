# Flow identity — design for F9 steps 3–5 (untangle wave 3)

Author: the untangle coordinator. Implemented by two stream agents after F10 and F11 have merged: `flow-identity-2a`
(step 3: the tables and the assignment migration) and `flow-identity-2b` (steps 4–5: adoption on arrival, delete the
movers). Byte-identical payloads except bugs 2 and 8 and what each step names. Read `docs/untangle-plan.md`
«Vocabulary», F9, F20 (what will sit on these tables next wave), the audit, and the «Notes from wave 3».

## Step 3 — the flow is the identity; documents are evidence

### Decision: an identity table first, the physical merge later
`flows` is created as the ONE identity for every expense/income/movement row, and every existing row points at
it (`movements.flow_id`, `cc_statement_lines.flow_id`, `expense_entries.flow_id`, payslip lines through a
`(payslip_id, position)` evidence row, `income_entries.flow_id`). The physical fold of `movements`' columns into
`flows` (and the rename that retires the word «movement») is a separate mechanical step AFTER the readers are on
the F10 views (wave 4 or 5), so that this step changes identity only and every payload stays identical. Do not
insert card lines into `movements`.

### Tables (migration 279)
```sql
outside_parties(id, kind CHECK IN ('merchant','person','employer','state','bank','family','broker','other'),
                name, name_key (folded), rut, source CHECK IN ('vendor_catalog','counterparty','employer','payee','manual'),
                UNIQUE(kind, name_key, rut))
flows(id, kind TEXT NOT NULL,                       -- FLOW_KINDS (contracts/flowKinds.ts, F10)
      from_account_id, to_account_id,              -- an account on either end (nullable)
      from_party_id, to_party_id,                  -- an outside party on either end (nullable)
      occurred_on TEXT NOT NULL,                   -- the authoritative day (see authority)
      amount REAL NOT NULL, currency TEXT NOT NULL,-- the `from` side; the `to` side when it differs:
      counter_amount, counter_currency,
      description TEXT,                            -- the authoritative merchant / wording (display only)
      legacy_key TEXT UNIQUE,                      -- the stable expense key this flow was born from (step 3 only)
      CHECK (from_account_id IS NOT NULL OR from_party_id IS NOT NULL),
      CHECK (to_account_id IS NOT NULL OR to_party_id IS NOT NULL))
flow_evidence(id, flow_id REFERENCES flows ON DELETE CASCADE,
      source_kind TEXT NOT NULL,                   -- statement_pdf | statement_json | listing_open | listing_stale | cartola | daily_listing | mail_notice | mail_rebuilt | receipt | manual | payslip | plan
      source_table TEXT, source_row_id INTEGER,    -- the document row (cc_statement_lines.id, movements.id, …)
      document_key TEXT,                           -- the document's own identity (dedupe key, parser_row_id, cartola period+doc no, message id)
      stated_on TEXT, stated_amount REAL, stated_currency TEXT, stated_description TEXT,
      authority INTEGER NOT NULL,                  -- 3 statement, 2 bank listing, 1 manual (Vocabulary «evidence»)
      UNIQUE(source_kind, source_table, source_row_id))
```
Write-log triggers on all three (migration 270's `writeLogTriggerSql`); `flows` and `flow_evidence` are mark inputs
only if a reader of marks reads them (none in this step — declare them as dependencies of the expense-line
families in `cacheFamilies.ts`).

### Seeding (the hook, report-first, one transaction)
1. Parties: the vendor catalog's brands/people (by RUT where known), `transfer_counterparty_accounts`, payslip
   employers, receipt payees. A merchant with no catalog entry gets NO party (the flow keeps `description`; its
   party is `other/unknown` by absence). Counts per source in the report.
2. Flows, one per existing identity, `legacy_key` = the stable key `expenseKeys.ts` builds for that row today:
   - every `movements` row → one flow (`kind` from `flow_kind` + the checking marks: a `checking_expense_refunds`
     row → `refund`, an income override → its income kind or `excluded` as the kind the taxonomy gives it;
     F10's mapping table decides; a movement with none → the kind its `MovementFlowType` maps to); the account
     ends copied; the counter leg copied; `description` = the bank's text the row's source carries;
   - every card line with `kind` purchase | charge | refund | internal (F10's stored kind) → one flow from the card
     (`from_account_id`) to the merchant party (or none), `occurred_on` = the line's transaction date as the
     readers use it (`statementLineDateIso`), amount = the line's amount in its currency; **twin lines** (same
     identity, `#dupN`) are separate flows; a **cuota line** (`installment_flag = 1`) is NOT a flow — it is
     evidence of its plan's purchase flow (through `cc_installment_payments.parser_row_id`, the join F10 keeps
     private: ask `cards/purchases` for `lineForPayment`); a **payment line** (`kind` payment) is evidence of the
     checking→card transfer flow when the pairing (`ccPaymentMirrorEvidence`) knows it, else its own flow from an
     unknown party to the card (kind `card_payment`, to be adopted later); a planted payment line likewise;
   - every `cc_installment_purchases` row → one flow from the card to the merchant on `purchase_date` for
     `total_amount_clp` (the purchase at full principal), unless its one-shot line already made the flow (F11's
     `source_line_id`, or F10's superseded-line rule says the line belongs to the plan — then the plan is evidence of
     that flow); a statement-owned plan with no line is its own flow; twins by `twin_index`;
   - every `expense_entries` row without a place → a flow from checking? NO: a manual expense names no account today
     — `from_account_id` null, `from_party_id` null is forbidden by the CHECK, so manual expenses get
     `from_party_id` = a party of kind `other` named «unrecorded account» (one row), to the merchant party; the user
     decides the account in F20;
   - `expense_entries` with a place (real-estate bills) are NOT flows (the bill is a link target); payslip lines →
     one flow per line (the pre-tax model lands in F20; for now from the employer party to the `other` party, kind by
     line kind), `income_entries` → flows from the named source party to checking.
3. Evidence: one row per document row (the line, the movement's source row, the plan, the payslip line), with
   `authority` by source kind; a movement that today has both a cartola row and a superseded daily row has two.
4. Assignments re-keyed to `flow_id`, ONE TABLE AT A TIME, each with its own hook that proves `count(before) =
   count(after)` and that every old key resolved to exactly one flow (a key resolving to several flows — the shared
   `installment-h:` of twins — copies the assignment to each twin and reports the count; a key resolving to none is
   listed, never dropped: the hook fails): `cc_expense_unique_purchases` + `cc_expense_line_categories` →
   `flow_categories(flow_id PK, category_id NULL, unique_row INTEGER)` (the «Único with no category» row is
   `category_id NULL, unique_row 1`); `cc_expense_purchase_notes` → `flow_notes`; `cc_expense_purchase_big_groups`
   → `flow_big_groups`; `cc_expense_line_splits` → `flow_parts(flow_id, seq, kind?, amount, currency, category_id,
   note, spent_on)` (F20 generalises the kind); `expense_deposit_links` → `flow_links(flow_id, kind='funded_deposit',
   counterpart_flow_id, amount, source, …)` with the deposit's flow as counterpart and the old `depto_*` columns kept
   as link attributes; `real_estate_expense_links` + rejections → `flow_links(kind='bill', counterpart_entry_id)` /
   `flow_link_rejections`; `cc_facturado_financing_link_purchases` → `flow_links(kind='finances_facturado')`;
   `checking_expense_refunds` and `checking_income_movement_overrides` → `flows.kind` (+ an `excluded` / `force_include`
   flag column on flows if the taxonomy cannot express them — prefer kinds). The old tables are dropped by the SAME
   migration only when every reader is on the new one; else they stay read-only until step 5 (list which).
5. Readers: the key module (`expenseKeys.ts`) gains `flowIdForKey(key)` during the transition; every assignment
   reader/writer takes a `flow_id`. The Expenses lines carry `flow_id` (DTO field, optional). The client keeps
   sending `purchase_key` until wave 4 — the routes translate (`flowIdForKey`) — note it for `client`.

### Bugs 2 and 8 close here
- Bug 2: a refund mark, big group, pieces and manual deposit links hang off the flow; when the cartola replaces
  the daily row, the flow stays (step 4 adopts; until then the carry code moves the `flow_id`, which is one column
  instead of five tables).
- Bug 8: a claim is a flow id (`flow_links.counterpart_flow_id`), never account|day|pesos.

### Proof (real-DB copy)
Every assignment, listed by (old key → flow id → new row), 1:1; the Expenses lines in both modes with their category,
«Único», note, big group, pieces, deposit link, receipt and bill fields — identical before/after; the income payload,
the deposits reconciliation, the real-estate page, the card ledgers, the flows overview, the home bundle — identical.
Counts: flows per kind, evidence per source kind, parties per source.

## Step 4 — adoption on arrival

Every importer that today deletes and recreates (bucket line settled by its statement — `reconcileOpenWebPasteAfterPdfClose`;
manual plan replaced by its statement twin — `reconcileManualInstallmentPurchasesForStatements`; daily row replaced by the
cartola — `prunePartialMovementsSupersededByCartola`; mail-written movement replaced by the bank listing; a re-import
with a new `parser_row_id`; a planted payment replaced by the bank's line; a feed-created plan replaced by the statement's)
instead: finds the existing flow through F17's pairing helper with the SAME recogniser it uses today, attaches the new
evidence row, and updates the flow's authoritative fields (amount, date, description) when the new evidence outranks
the old (statement > listing > manual); the old document row is deleted or kept as the funnel decides, the flow and
every assignment stay. Ambiguity → reported, left unpaired (never a guess). An unmatched bucket line inside the closed
cycle retires its flow (soft: `flows.retired_on`, so its assignments survive a later re-listing); outside the cycle it
re-targets to the next facturación (the flow stays). The explicit carry cases («CONVENIO P.A.T.» → «SEG AUTO
SANTANDER») become match rules with a fallback (F17 table). Every non-trivial pairing is in the import result.
All through F11's funnels (`lineWrites`, `movementWrites`).

Proof: the nightly-shaped replay on the real copy (feed file, statement re-import, cartola, receipt): identical
tables AND the flow ids of every assigned flow unchanged (dump flow_id + assignments before and after the replay).

## Step 5 — delete the movers
`ccExpenseCategoryPersist`, `ccExpenseLineRekey`, `checkingGastosCategoryPersist`, `carryCcExpenseAssignments`,
`transferCheckingGastosCategoryFromMovementToNote`, `carryMovementKeyedIncomeState`, `flowIdForKey` and the
`legacy_key` column; the old assignment tables; `backfillCheckingAutoMatchCategories`. Guard test: no table outside
`flow_*` references a line key or a movement id for an assignment.

## Step 3 as built (flow-identity-2a, 2026-11-08)

What the code forced, and why (each change is also in its commit):

- **Identity is the expense key, one flow per key.** Migration 279 makes one flow for every key an
  assignment table stores (`flows.legacy_key`, UNIQUE) and points every row that key names at it
  (`flows/flowKeyResolve.ts`, the inverse of the key builders): a plan, its twins and the cuota lines
  paid against it share the purchase's flow; rows that carry the same key (cuota lines of one
  purchase with no plan, line-fallback twins) share one. Twin plans share one flow here, not one
  each: their key — and so every assignment — is shared today; they split when adoption (step 4)
  lets their assignments diverge. A checking movement's deposit-paired part is not a flow of its
  own: the keyed assignment tables carry `portion` (`gastos` | `deposit`) and `piece_seq` (-1 =
  the whole flow), and `expenseKeySql` rebuilds the key a row stands for.
- **Every other row gets a flow of its own with no key** (6.8k on the real copy), and the insert
  triggers give every row written later one (movements, card lines, plans, manual expenses, income
  entries, gap mirrors), with its evidence row; `ensureFlowForKey` stamps the key when an assignment
  first names it. A delete takes the row's evidence; its flow goes too when nothing holds it (no key,
  no other evidence, no pieces). Kinds come from `LEGACY_FLOW_KIND_MAP` (movements: the
  `MovementFlowType` member, kind-less rows by sign; card lines: the stored kind). Manual expenses
  get `card_purchase` for want of a non-card spending kind in `FLOW_KINDS`; payslip lines get no flow
  (no assignment names them; the pre-tax model is F20).
- **A key that names no row is archived, not a failure.** On the real copy ~2k stored keys name
  nothing (deleted daily rows' `checking-mv:` keys, re-parsed `line-pr:` ids, identity-only plan keys
  the line builder no longer produces — exactly what migration 273 reported unread). Each table's
  migration moves them to `flow_orphan_assignments` (table, key, the row as JSON) and proves
  old = moved + archived. A malformed key still fails. (An orphan `checking-mv:<id>` would otherwise
  attach to whatever movement reuses the id: `movements` has no AUTOINCREMENT.)
- **Refund marks and income classifications are flow-keyed tables, not kinds** (`flow_refunds`,
  `flow_income_overrides`): `FLOW_KINDS` has no refund-of-spending or excluded-income kind, and the
  refund carries a category. They join the movement through `movements.flow_id`; a flow carrying one
  must be one movement's (the migration checks).
- **Bug 2:** the cartola row takes over the daily row's flow (`adoptMovementFlow`): the official
  row's own flow merges into it, and it answers to the official row's key — refund mark, income
  classification, big group and pieces follow; the old-table movers still move categories and notes
  until their tables move.
- **Bug 8:** an outflow's claim is its flow on its account (`DepositMatchCandidate.flow_id`,
  `outflowFlowClaimKey`); the Buda retiro and internal-transfer key sets are built the same way.
- **Parties** gained source `system` (the `unknown` party and the `unrecorded account` a manual
  expense comes from).
- **`flowIdForKey` lives in `flows/flowIdentity.ts`**: `expenseKeys.ts` is a leaf with no `db`
  (`expenseKeySql` was added there instead).
- The schema baseline now builds a fresh database only: on a migrated one it brought back, empty,
  every baseline table a later migration dropped.
  On the real copy the reconciliation moves 7 redemptions to `resolved_internal_transfer`: they are
  from-legs of mirror-merge transfers out of a month-precision account (the cuenta de ahorro) whose
  outflow event keeps its month-end date while the transfer is dated the checking day, so the old
  account|day|pesos key never matched the «internal by construction» rule it was built for.

## Step 3 as built, part 2 (flow-identity-2a2, 2026-11-08)

- **Deposit links (migration 285)** are `funded_deposit` rows of `flow_links`: the purchase's flow
  (portion, piece) → the deposit's flow (`counterpart_flow_id`; the claim is the deposit's flow,
  bug 8), with `payment_clp`, `amortization_clp`, `depto_cuota`, `depto_occurred_on` and
  `link_source` as link attributes. `flow_links` was rebuilt for the kinds still to come and lost
  its explicit `id`: the rowid keeps insertion order (the order the old tables were read in) and a
  re-derivation that rewrites the same links is no change to `withoutChurn`, which compares
  columns. A deposit link to a movement that is deleted goes with it (a movement-delete trigger:
  the deposit's flow may outlive its row when a key names it); a merged flow's links point at the
  survivor. Readers see the old shape through `EXPENSE_DEPOSIT_LINKS_SQL` (`flows/flowLinks.ts`).
- **Bill links (migration 286)** are `bill` rows of `flow_links` (the purchase's flow, portion,
  piece → the bill, `counterpart_entry_id`, with `link_source`); a refused pairing is a
  `flow_link_rejections` row. One bill per purchase and one purchase per bill (two partial unique
  indexes). Readers see the old shape through `BILL_LINKS_SQL` / `BILL_LINK_REJECTIONS_SQL`
  (`flows/flowLinks.ts`), ordered as the old tables were read (by bill). **The one bill-move
  policy** (`moveBillLink`, used by the card-line re-key mover and the cartola mover alike, and by
  `mergeFlowInto`): the link and its refusals follow the purchase; a target already linked to
  another bill **throws** — two bills claiming one payment is a conflict a human resolves, never
  one dropped silently. The card-line mover used to report that conflict and leave both links
  where they were; the cartola mover already threw. A refusal the target already carries stays.
  `mergeFlowInto` now moves the merged flow's own `flow_links` and refusals onto the survivor (by
  row, so the rowid read order stays): before, a link a mover had put on the cartola row's flow was
  deleted with it when the adoption folded that flow into the daily row's.
- **Notes (migration 287)** are `flow_notes` rows (flow, portion, piece) that keep the account they
  were written under (`account_id`): readers still ask by (account, key), and the cleanups of a
  test or a wiped card delete by account. One module reads and writes them (`flows/flowNotes.ts`:
  `FLOW_NOTES_SQL` for the old shape, `getFlowNote` / `setFlowNote` / `updateFlowNote` /
  `deleteFlowNote`); a write names its row by key, so a note can no longer be written on a key that
  names nothing (it threw nothing before and was never read). The movers move them with
  `moveKeyedRows` (the card-line mover through its `flowTable`, the manual-plan reconcile with
  `keep-target`, as before). `mergeFlowInto` now carries the merged flow's notes and big groups
  (the preferred flow's row wins), for the reason given for links above.
  `scripts/repair-cc-expense-orphaned-line-keys.ts` read the dropped table: archived (deliverable
  6), since the moving migrations archive what it looked for.
- **Kinds (migration 288, deliverable 7):** `FLOW_KINDS` gained `purchase` (spending with no card
  line: a manual expense) and `refund` (spending that came back off a card). Manual expenses' flows
  are re-kinded `purchase` and the insert trigger writes it (a database that runs migration 279 after this commit seeds them `purchase` at once, so its 288 report reads 0). No flow takes `refund` yet: the refund
  mark stays the flow-keyed `flow_refunds` row (it carries the category), and keeping a kind in step
  with the mark would be a second write for nothing a reader uses; step 4 or F20 can fold it.
- **Categories (migration 289)** are `flow_categories` rows (flow, portion, piece, the account
  they were written under, `category_id` — null is «Único» with no category). No `unique_row`
  flag: the per-line category (`cc_expense_line_categories`) stays a row of the statement line,
  because it names one line, not a key — four of the copy's 33 sit on cuota lines, whose flow is
  their plan's, so folding them into the flow would put one cuota's category on every cuota. It is
  not key-based (it references the line by id with a cascade), so it is not on the «still
  key-based» list. One module (`flows/flowCategories.ts`: `FLOW_CATEGORIES_SQL`,
  `getFlowCategory`, `putFlowCategory` with `replace` / `keep` / `coalesce` for the three upserts
  the callers used, `updateFlowCategory`, `deleteFlowCategory`). Writes on the gastos read path
  (the generic-transfer and deposit-match «Único» rows) name their row by the line's own key, so
  they stamp keys and change no payload. Two behaviours moved: the statement re-import's restore
  skips a snapshot key that no row carries any more (it wrote an orphan nothing read), and
  converting a line to cuotas writes the plan's category after the plan exists (the key must name
  it). `migrateCheckingGastosCategoryToStableKey` / `preserveCheckingGastosCategoriesForCartolaNotes`
  now always find nothing: a cartola row's movement-id key resolves to no row, so no legacy row can
  sit under it (the category is on the flow its cartola key keeps); the cartola import still calls
  the latter (not this stream's file).
- **Ids are reused, keyed flows are not:** `movements` has no AUTOINCREMENT, and a keyed flow
  outlives its row, so a new movement that takes a deleted row's id answers to the old flow under
  `checking-mv:<id>` (seen in the test DB, where fixtures reuse ids). Step 4's adoption, or a
  delete trigger that drops `checking-mv:` keys with their row, must close it.

## Step 4 as built (flow-identity-2b, 2026-11-08)

- **Retirement (migration 290).** A flow outlives its rows: when its last evidence row goes and
  something hangs off it (`FLOW_HOLDING_TABLES` + its own `flow_links`) or a key names it, the delete
  trigger sets `retired_on` and remembers the document its evidence named (`retired_source_table`,
  `retired_document_key`); a bare flow still goes with its row. A key that names its row by id
  (`checking-mv:`, `line:`, `installment:`, `manual:`, a gap mirror's) is detached into
  `retired_key` on delete, so a reused id (no AUTOINCREMENT on `movements`, `cc_statement_lines`,
  `flows`) never answers to the old flow; the hook detaches what the data already held. Readers of
  the keyed tables skip keyless rows (`keyedRowsSql`). An unmatched bucket line inside the closed
  cycle is deleted as before and its flow retires with whatever the user put on it.
- **Adoption** (`flows/flowAdoption.ts`, `adoptFlow`): the arriving row's flow folds into the one on
  file (`mergeFlowInto`, which now also carries pieces as one set per flow); the survivor answers to
  the arriving row's key when it answered to one before, a flow still answering to the replaced
  row's key folds in too (`previousKey` — an older flow of the same purchase, e.g. left by a
  re-import before this step), and a card flow's amount, day, currency and merchant follow its most
  trusted line evidence (statement 3 > listing 2 > manual 1; movements keep theirs — their evidence
  states the signed bank figure and provenance text). Nothing reads the flow's own fields yet.
- **Per importer** (the recognisers are unchanged; only the outcome moved):
  - re-imported card lines (`adoptReimportedCardLines`, ex-`ccExpenseLineRekey`): same parser row,
    then identity, twins in id order, the surviving copy; a split re-parse and a new twin still get
    copies (they are other flows). The capture remembers only flows that outlive their row (a bare
    one's id may be reused by the new line's flow). The import report lists pairings by identity /
    survivor / fan-out, conflicts (the new line's row kept) and unpaired lines;
  - a bucket line settled by its statement, a cut/pending re-listing dropped for its fuller twin, a
    planted payment replaced by the bank's line, a pending listing replaced by the posted one
    (`CardLinePlan.carry` → `replaceCardLines` in the funnel's delete step → `adoptReplacingCardLines`);
    the per-line category and the merchant rule under the statement's name stay carry rules there;
  - the statement plan replacing its hand-entered or feed-created twin
    (`ccManualInstallmentStatementReconcile`, result `flows_adopted`): the statement plan's flow and
    the flows of the manual plan's older keys fold into the manual plan's flow, the statement side's
    row winning a conflict; the category still lands on the statement's lines;
  - the cartola row replacing a daily row (`adoptPartialIntoCartolaRow`; the payslip link, which
    names a movement, moves with `repointMovementReferences` in the movement funnel);
  - a cartola month re-imported or a daily row listed again: the movement funnel
    (`insertBankPesoMovement`) adopts the flow retired with the same document on the same account
    (`adoptRetiredMovementFlow`; several → reported, left alone);
  - a hand-entered transfer superseding an imported bank row (`supersedeImportedCheckingRowsForTransfer`);
  - already adoptive, untouched: the mail-written movement and the Fintual synthesized retiro (the bank
    listing is skipped and confirms the row, its day recorded as the posting day), the promoted
    checking credit (rewritten in place), the converted manual plan (the precedent).
- **Bug fixed on the replay:** a forced cartola month re-import dropped the refund marks on its rows
  (their keyless flows went with the rows); they now return with the re-imported rows.
- **Pairing strategies:** no recogniser changed strategy. The replay shows no ties to decide on (113
  card pairs by parser row / identity with 0 ambiguous, 8 cartola rows by exact document); the manual
  plan's first-matching line and the feed mirror's `first` stay `first` (not exercised by the replay).
- **Provenance in columns (migration 291):** a movement's document kind is its evidence row's
  `source_kind` (cartola, its opening anchor — `import:cartola|opening|` rows included —, daily
  listing, mail notice / rebuilt, broker document, legacy import, manual), with `document_key` the
  identity a bank row is re-found by; a trigger keeps them in step when an importer rewrites a note.
  `flows/flowEvidence.ts` holds the readers' SQL; `listCheckingMovements`, the cartola balance walks,
  the partial prune, the transfer-leg supersede, the mirror pairs and the transfer-notice pool read
  it; `provenanceGuard.test.ts` fails on a new note-prefix test.

## Step 5 as built (flow-identity-2b, 2026-11-08)

Deleted: `ccExpenseLineRekey` (→ `flows/cardLineAdoption.ts`), `carryCcExpenseAssignments`,
`ccExpenseCategoryPersist` (only a line's own category override, keyed by line id, is snapshotted
and put back: `snapshotLineCategories` / `restoreLineCategories`), `checkingGastosCategoryPersist`
with `transferCheckingGastosCategoryFromMovementToNote` and the cartola import's
`preserveCheckingGastosCategoriesForCartolaNotes` call, `carryMovementKeyedIncomeState` (its payslip
re-point is `repointMovementReferences`), `backfillCheckingAutoMatchCategories` (the mirror-pair
finder names a cartola row by the flow its key answers to). Guard test
`flows/assignmentGuard.test.ts`: no table outside `flow_*` stores an expense key, and every table
naming a movement or card line by id is listed as a document's record.

**Not done, and why:** `flowIdForKey` and `flows.legacy_key` stay — every keyed reader
(`keyedRowsSql`, the link views, the Expenses lines' `purchase_key`) joins on the key, and the client
sends `purchase_key` until wave 4; removing them needs the readers to join on the row's `flow_id`
(the identity is now consistent for that: after the replay every line's and cartola row's flow is the
flow its key names). Still note-derived: the cartola identity and the daily-feed grammar used for
matching (`cartolaNoteContent`, `parsePartialMovementNote`), the month replace by
`note LIKE 'import:cartola|<period>|%'` (`deleteCheckingCartolaMonthImport`, `accountImports`), the
mail prefixes in the evidence trigger, and the note-identified rows in `budaWallet`,
`afcCertImport`, `fintualCertImport`, `groceryBranchLearning`; the 27 test files' note inserts.
