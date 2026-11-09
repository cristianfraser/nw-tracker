# Flow model — F20 behaviour changes (untangle wave 4, stream `flow-model`)

Kept current by the stream. Each change is its own commit with a before/after on a fresh copy of
the real database; this file lists what moved, by how much (counts and shares only — never names or
personal amounts) and why that is the intended reading. Spec: `docs/untangle-plan.md` «Vocabulary»
and «F20».

## Rehearsal method

A dump script starts the server on a fresh copy of the real snapshot (`BACKGROUND_JOBS_ENABLED=0`)
and saves 57 payloads: the home bundle (CLP, USD), the flows overview (CLP, USD × both installment
modes), the P/L page, the deposits page and its reconciliation, the Expenses lines (both modes) and
gastos views (with and without pre-tax lines), income, the real-estate page, every card ledger
(both card groups), the account bundles of the checking accounts, the cuenta de ahorro, the cards,
MACH, the property and the mortgage, the mortgage group ledger, and the 90-day daily series of
net worth, Efectivo, Retiro and Brokerage. Two runs on unchanged code are identical (51 of 51 files
in the first version of the script), so every difference below comes from the change.

## Status

| # | Change | Status |
|---|--------|--------|
| 1 | Parts generalised | **landed for the loan payments (second pass, A2–A3 below)**: the mortgage dividendo's and the prepagos' split are parts on the property-leg flow, read by every reader; the splittable reserva pool stays a links rule |
| 2 | Links generalised | **mortgage pairing landed** (one stored link); the claim rule decided; card lines in the deposit pool, refund → purchase links not done |
| 3 | Cuenta de ahorro surgery | **decided otherwise and landed (second pass, B below)**: the mirrors and splits go; seven deposits get their real debit; the rest stay unlinked |
| 4 | Instrument events | not started — the share-count readers it must change sit outside this stream's files |
| 5–8 | Cost, pre-tax account, card-day capital flows, opening balances | not started (the stream stops where a change could not be rehearsed cleanly) |

## Second pass (wave 5, stream `flow-model-2`, 2026-11-08)

The user's data decisions of 2026-11-08 unblocked the first pass. Each item below was rehearsed on
a fresh copy of the real database with the dump of «Rehearsal method» taken before and after (50
payloads; the dump script was rewritten, it is not committed).

### A1 — the lender's dividend history against the ledger

`scripts/cross-check-loan-payment-history.ts` (pure logic in `loanPaymentHistoryCrossCheck.ts`,
tested on synthetic rows) reads the lender's history (SheetJS, Chilean amounts), compares every
regular cuota field by field (date, total, principal, extra principal, interest, the two
insurances) and applies the user's plan: the bank's figure (`set_field`), the bank's date
(`set_date`), the residual of a total above its printed parts stored as interest
(`set_interest_residual`), and the declared differences (`accept`). Report-first, one IMMEDIATE
transaction rolled back without `--apply`; inside it the balance chain is checked unchanged, Σ parts
= payment ± 1 on every row but the accepted ones, and the card pairing must still match every cuota
it matched before. Real copy: 29 cuotas compared, 24 agreeing on every field; 6 differences on 5
cuotas, all in the plan (four of one peso, one of eleven pesos, one date six days off); one cuota's
unprinted first-month interest written from the residual; three accepted differences (the first
dividendo's interest against the bank's printed 0, one cuota the card paid a few hundred pesos above
the lender's total, one lender row short of its own total). After the apply a re-run reports one
difference (the accepted interest) and writes nothing. The hardcoded exception for that card-paid
cuota in `expenseDepositLinks.ts` went: the check it bypassed holds without it.

### A2 — parts on the property-leg flow

Migration 293: `flow_parts` gains `kind` (every row on file a `piece`; a category only a piece
must carry) — `piece`, `principal`, `extra_principal`, `interest`, `insurance_fire`,
`insurance_life`, `prepayment_charge`, `bank_fee`, each with its flow class (`flows/flowParts.ts`).
`flows/loanPaymentParts.ts` writes every loan payment's parts from `loan_payments` on the property
leg's flow (the pie carries none) and is called by the sheet import, the payment form and the
cross-check script; Σ parts = payment ± 1, fail fast, unless the config's `accepted_differences`
names the row with field `parts_sum`. Readers: the real-estate page's `mortgage_parts` and the
deposit links' `amortization_clp` / `carrying_clp` (so the Expenses page, the carrying list, the
flows overview and the P/L page) read the parts; a stale part set against `loan_payments` is refused
on read. Payload differences on the real copy, all from A1's corrections: the real-estate slots of
the corrected cuotas (one to eleven pesos), the mortgage ledger rows (the interest cumulatives, the
amortization cumulatives, the two new `prepayment_charge_*` fields), the deposits page (one cuota's
day), and the carrying of two cuotas whose card payment exceeded the ledger's parts — the card paid
0.03 % above the lender's total on one, the lender's own row is 0.03 % short on the other. That
excess used to be counted as carrying (spending); it is now neither amortization nor carrying, so
the Expenses totals read 0.0006 % lower, the overview's deposits and expenses move by the same
pesos in those two months (`cash_unexplained` unchanged), and the two are declared differences.

### A3 — prepagos

A prepago's pesos above its principal were stored whole as interest. `loan_payments` gains
`prepayment_charge` (the lender's COMISIÓN DE PREPAGO + INTERÉS PENAL: a cost, never art. 55 bis
interest; a `prepayment_charge` part on the flow). The split comes from the liquidation the prepago
paid, read from the lender's mails (`parsePrepagoLiquidation`, either digit grouping): the one whose
TOTAL A PAGAR equals the payment, every line as printed (one of three on the real copy); when a
round figure was paid instead, the liquidation calculated closest before the payment, with the
principal the ledger's balance drop × its parity, the accrued interest the printed one scaled to the
principal actually prepaid, and the charge the remainder (two of three). The 2025 certificate
confirms the scaled interest to the peso. On the third prepago the remainder is 13 % above the
scaled printed comisión (0.08 % of the payment); the ledger's principal moved by 0.04 % to the
liquidation's. Each prepago's cash leg (the checking debit that bought the vale vista) was already
linked by hand; the script checks the link's amount and writes the debit's excess over the prepago
(the bank's document fee) as a `bank_fee` part on the debit's flow — no reader shows cost parts yet
(D5). `f22AppEstimates.ts` (code 751) reads `loan_payments.interest`, which now excludes the charge
on the loan leg too: its 2025 figure moves by the three prepagos' charges without a code change.

### A4 — the 2025 certificate

With `--certificate`, the script reads the art. 55 bis certificate (`pdftotext -layout`) and compares
Σ interest by payment month over the loan leg (cuotas + prepagos' accrued interest). Real copy: 12 of
12 months agree after A1 and A3 (the February figure is what fixed the scaling rule above).

### B — the cuenta de ahorro: mirrors and splits retired, seven deposits linked

User decision (2026-11-08): history is not recreated. Migration 294 drops
`checking_gap_deposit_mirrors` (the fabricated checking debit a cartola-less month got for every
deposit no debit explained) and `cuenta_ahorro_deposit_splits` (how much of a month's deposit was
the family's), with the mirror flows, their evidence and their `synthetic` links; the mirror line
drafts, the mirror link sync, the Buda-abono mirror writer and the splits module are gone, and the
reconciliation lost `linked_synthetic` and `resolved_family_funded` (a deposit no debit explains is
`unlinked_checking_present` / `unlinked_no_checking_source`, whoever funded it — the DTO and the
page follow). `scripts/retire-cuenta-ahorro-mirrors.ts` (report-first, IMMEDIATE) writes the
coordinator's plan: a `manual` `funded_deposit` link from each named checking debit (its deposit
portion) to the ahorro deposit of the month that covers it — the debit a month or so before the
month-end-dated deposit — and categorises the debit as the matcher categorises a linked debit;
inside the transaction the movements table must be untouched (so every balance on every date is)
and the reconciliation may move only the linked deposits, to `linked`. Real copy: 33 mirrors and 45
splits retired; 8 plan items, 7 links written (two debits funding one deposit, one partial), 1
already made by the matcher; linked deposits 57 → 63, nothing else moved, movements untouched; a
re-run writes nothing. Payloads: the reconciliation (38 rows re-classified: 33 synthetic → 6 linked
+ 27 unlinked, 5 family → unlinked), the Expenses lines (the 33 mirror lines gone), the gastos
cumulatives (the mirror lines never counted; the shift is the linked debits' category), and one
overview month whose `cash_unexplained` now reads the linked debit's pesos: the debit left checking
in the month after the deposit's month-end date, so the two months no longer cancel — the honest
reading of a sheet that recorded the month the money was credited. Not done: the `gap_mirror` key
kind in `expenseKeys.ts` (no row produces it; `flowKeyResolve` answers «names nothing»).

## Change 1 — parts (first pass, not landed)

`flow_parts` (migration 283) already holds a user's pieces of a line. The other two mechanisms:

- **The mortgage dividendo's split.** The natural home is the cuota's property-leg flow, whose amount
  is the cuota paid (amount = Σ parts on 26 of the 29 regular cuotas). The rule «Σ parts ≤ flow,
  fail fast» fails on the real copy: one regular cuota's stated parts (amortización, extra, interés,
  seguros) exceed its stated payment by less than 0.1 % of the cuota (a formula-era sheet row whose
  mínimo/máximo still carry model formulas, AGENTS.md «Mortgage sheet»); two more are below it
  (one known: the sheet's own rounding). Storing the parts would either need that
  row fixed (which figure is the bank's is the user's call) or a tolerance, which the rule forbids.
  A second reader splits the same dividendo differently: the Expenses page and the carrying list
  (`flowsMortgageCarrying.ts`) split the *card line* by the `funded_deposit` link's
  `payment_clp` / `amortization_clp` (carrying = payment − amortization, consistent by construction),
  while the real-estate page splits the *ledger row* (`mortgage_parts` from `loan_payments`). Folding
  both into one set of parts requires choosing which flow carries them (the card line, the
  property leg, or both) — a design decision the plan does not make.
- **The splittable reserva pool** is a read-time allocator inside the deposit matcher
  (`flowsCheckingGastos.ts`, a running `Map` of what each lump deposit has left). Its result is
  already stored as `funded_deposit` link amounts; the generalisation the plan describes («a flow's
  links never add up to more than it») is a *links* rule on the deposit's flow, not parts. Moving
  the allocator to stored parts would freeze an allocation that today is re-derived on every build.

Proposal for the next pass: parts carry the mortgage split on the **property-leg flow** (the
ledger's statement of what the cuota was), once the one inconsistent cuota is settled by the user;
the Expenses page reads the card line's share through its link to that flow. The reserva pool becomes
the links rule: remaining = deposit flow − Σ links already on it.

## Change 2 — links

### The mortgage cuota ↔ card line pairing (landed)

Before: two pairings of the same fact. The stored one (`syncMortgageExpenseDepositLinksFromSheet`:
a `funded_deposit` link from the card line's flow to the cuota's property deposit, ±14 days, equal
pesos, the lender's merchant preferred among several, a hand-made link kept) drives the Expenses
page's split; the read-time one (`mortgagePaymentCardMatch.ts`: equal pesos, the payment day
through 3 days after) drove the mortgage page's «Tarjeta» column and the nightly
`mortgage_card_match_check`.

After: the mortgage page and the nightly check read the stored link. `mortgageCardMatches()` builds
the expense lines first (cached, dropped by any write) so the link is current with the card lines
and the ledger.

Real copy: 29 regular cuotas. **27 agree**; 2 differ, both now matched:
- one cuota whose link was made by hand: the card charged a different amount from the ledger's
  stated payment (by well under 0.1 %), so the read-time rule never matched it;
- one cuota whose card charge is dated six days *before* the ledger day: outside the read-time
  window, inside the stored ±14.

Payload differences (and nothing else): the property and mortgage account bundles and the mortgage
group ledger (CLP and USD) show those 2 cuotas `matched` with their line, and
`card_lines_without_payment` loses the same 2 lines. The nightly check judges the last 45 days
only, so its verdict is unchanged. A link that names a flow with several card lines (the cuotas of
one plan share their purchase's flow) or one line linked to two cuotas now fails fast; the
`ambiguous` status is no longer produced (the stored pairing throws on ambiguity when it is built).

`MATCH_WINDOWS.mortgage_cuota_card_line` (`matching/windows.ts`, not this stream's file) is now
read by nothing but its test.

### The claim rule for a card line beside a same-pesos checking debit (decided)

Measured on the real copy (615 inflow deposits into non-checking, non-card accounts, ±3 days, equal
pesos): 60 have a same-pesos checking debit, 54 have a same-pesos card line, **0 have both**. The
54 card-funded ones are all the mortgage (27 cuotas, each seen on the property and the loan leg),
already linked by the pairing above. No brokerage, savings or fund deposit on file was paid by card
(the MACH top-ups are `carga_tarjeta` transfers, not deposits).

Decision: **the checking debit claims first; a card line claims only a deposit no checking debit
claimed.** A checking debit is the money leaving the bank on the day the deposit records; a card line
is a purchase whose cash leaves when the card is paid, so when both fit, the debit is the stronger
evidence. When two card lines (or two debits) fit one deposit, it stays unpaired and is reported
(F17's `unique` strategy). On today's data the rule changes nothing; it decides future cases.

### Not done
- Card lines in the general deposit pool (the matcher in `flowsCheckingGastos.ts` /
  `expenseDepositLinks.ts`): on the real copy there is no card-funded deposit outside the mortgage,
  so the change would move no payload; deferred to keep the matcher untouched.
- Refund → purchase links: the nota de crédito pairing is read-time (`nota_credito_role`); storing it
  as a link is the same shape of change as the mortgage one and was not reached.
- «Written on arrival»: the stored mortgage link is still re-derived when the expense lines are
  built, not written by the importers.

## Change 3 — the cuenta de ahorro surgery (not landed)

Real copy: 45 split months. 5 pure-family (one flow from family, nothing to re-point); 6 with a real
cartola debit linked (5 whole, 1 partial); 1 self-funded with neither a link nor a mirror (a tax
refund the Tesorería paid in, which by design gets no mirror); **33 with a synthetic mirror**.
Of those 33, **28 fall in months the cuenta corriente has a cartola for** — the mirror exists
because no debit of those pesos is on that cartola — and 5 are in months before the cartola history.

The plan keeps a mirror «as a real flow» only for a month with no cartola, and requires the checking
balance on every date unchanged. A real checking → ahorro flow in a cartola month would put a debit
the cartola does not print into the checking walk (its saldo final would stop reconciling), and a
real flow before the cartola history moves the derived opening anchor. So 28 months need someone to
say where the self-funded pesos came from (several debits, the cuenta vista, cash) or to re-classify
them as family; the remaining 5 need the anchor rule decided. A report-first script that guesses
would violate the fail-fast rule, so none was written.

## Change 4 — instrument events (not started)

`equity_splits` has 1 row and one per-holder `stock_split` movement on the real copy. Deriving unit
changes from the event means every share-count reader multiplies by the later splits instead of
summing a `stock_split` row: `holdings.ts` / `accountMarkClpAtYmd.ts` (quantities), the daily
quantity cache, `equityBrokerHoldings.ts`, the transfer-leg unit walks, and the tax lots. Only the
last (and `equitySplits.ts`, `brokerSplitNotifications.ts`) are this stream's files.

## Changes 5–8 (not started)

Stopped by the stream rule (a change that cannot be rehearsed cleanly ends the sequence). Notes for
the next pass, from reading the code:
- 5 (cost): the kind classes are in `contracts/flowKinds.ts`; `perfKernel.ts` takes flows as one
  number, so the cost rule needs the kernel to receive capital and cost separately.
- 6 (pre-tax account): payslip lines have no flows yet (step 3 left them out), so this change also
  creates their flows.
- 7–8: depend on 5 for the class split in the deposit readers (`accountDeposits.ts`,
  `flowsDeposits.ts`, `cashEqsBucketNet.ts`).
