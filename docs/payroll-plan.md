# Payroll: every payslip line, gross vs net, and payroll costs as expenses

Status: phases 1–7 done (2026-10-07 → 08); see AGENTS.md «Ingest API» → `employment.payslips` for what was built. Personal figures and the month-by-month evidence live in
the untracked `cfraser/payroll-plan-data.md`; this file stays free of personal data.

## Goal

Track, per month and per year, **gross pay → every discount → net pay**, from the
payslips (liquidaciones) and finiquitos, and put the discounts where they belong:

- pension and unemployment contributions are **savings** (deposits into the AFP / AFC
  accounts, linked to the payslip that paid them);
- health, AFP commission, income tax and other payroll deductions are **expenses**;
- the net pay is the income line already linked to the salary deposit.

Everything the payslip prints is recorded as printed, even when it does not agree with
the law's arithmetic: what was paid is what was paid. Differences are recorded and shown
for the tax return to settle, never refused.

## Settled decisions

1. **Month.** A payslip's lines belong to the payslip's month (the month worked, paid on
   its last day), even when the payslip or the money arrives in the next month. Account
   movements keep the day the money arrived.
2. **Savings vs expenses.**
   - AFP mandatory contribution (10 %), AFC worker share (0,6 %), payroll APV → savings,
     linked to the deposit into that account.
   - AFP commission, health (7 % and the Isapre top-up), employer life-insurance
     deduction, income tax, other deductions → expenses.
3. **State and employer money (unchanged from today, single line each).**
   - APV state bonus: gain of the APV account (not a deposit, not income).
   - AFC employer share: a deposit into the AFC account, together with the worker share;
     not income.
4. **Categories.** Categories get an optional parent; today's categories are the parents.
   - «Cuentas y servicios» › «Impuestos», «Comisiones AFP».
   - Health contributions and insurance go to «Salud» itself (no subcategory for now).
5. **No failing on the law's arithmetic.** Caps (topes), AFP rate, AFC rate and income tax
   are recomputed and the difference is recorded. Only the payslip's own sums fail an
   import (its lines must add up to the totals it prints, and haberes − descuentos =
   líquido), since those mean the parser misread it.
6. **USD contract (2021, paid through Deel).** Gross = the contract's monthly USD amount
   (prorated by calendar days in the first and last month); the transfer fee is gross −
   received and is an expense («Comisiones»). No tax was withheld; the year's F22
   settles it.
7. **Missing payslips are rebuilt, marked as rebuilt,** from what exists: the net
   deposit, the AFP and AFC contributions (and the certificates' taxable base), the UF /
   UTM of the month, the employer's DJ 1887 monthly figures where the SII has them. What
   the sources cannot explain becomes one «sin detalle» line so the rebuilt payslip adds
   up to the deposit.
8. **Finiquitos are payslips** (`kind: severance`): their PAGOS are haberes (indemnities
   included, as their own kinds) and their DESCUENTOS discounts.

## Model

### `payslip_lines`

One row per printed line: `payslip_id`, `position`, `side` (haber | descuento),
`section` (imponible | no_imponible | legal | other), `label` (as printed), `amount`,
`kind`. Every import checks Σ lines against each printed total and haberes − descuentos =
líquido (hard), then the law's arithmetic (recorded, see below).

Kinds (rules in a data file, like the card-statement line rules; an unknown label fails
the import so a new layout is noticed, never guessed):

| Side | Kind | Treatment |
|---|---|---|
| haber | base, gratificación, bonus, overtime, aguinaldo, allowance (colación, movilización, teletrabajo), employer life insurance, vacation pay, indemnity (notice, years of service, vacation, voluntary), other | gross pay |
| descuento | afp_mandatory, afp_commission | savings (AFP) / expense «Comisiones AFP» |
| descuento | health_mandatory, health_additional | expense «Salud» |
| descuento | afc_worker | savings (AFC) |
| descuento | apv | savings (APV) |
| descuento | income_tax | expense «Impuestos» |
| descuento | life_insurance | expense «Salud» |
| descuento | advance (anticipo de sueldo / aguinaldo) | nets an earlier advance, linked to its deposit |
| descuento | other | expense, by label |

The AFP line printed as one amount is split at import: mandatory = the legal rate of the
capped taxable base, commission = the rest. The link to the AFP deposit is a check, not
the source (some periods' AFP rows are netted reliquidaciones).

### Links

- `payslip_contributions(movement_id, payslip_id, fund)` — AFP / AFC / APV deposit ↔ the
  payslip(s) of the month(s) it pays (one AFP row can pay two months; one month can have
  several rows). Written by whichever import arrives second (payslip import, AFP
  certificate read, AFC certificate import); history filled once from the period the
  certificate rows name. Replaces the note as the home of the period.
- Net pay ↔ salary deposit: exists (`payroll_work_earnings.movement_id`); extended to
  finiquitos and to advances (anticipo ↔ the earlier deposit).

### Payroll parameters (`payroll_parameters`, one row per month)

UF / UTM (already stored), AFP-and-health cap (UF), AFC cap (UF), each AFP's commission,
SIS, AFC rates by contract type. Source: Previred's monthly «Indicadores previsionales»
(or the Superintendencia de Pensiones' yearly cap notices); fetched, never typed from
memory. The SII's monthly «Impuesto Único de Segunda Categoría» table (UTM brackets) and
the yearly Global Complementario table (already in `f22Draft.ts`) move to data tables
checked against the SII's published pages.

### Employer pension contribution (pension reform, from 2025-08)

Since August 2025 the employer pays a contribution of its own, part of it into the worker's AFP
account (0,1 % of the taxable base at the start), and the rate rises in steps over the coming
years. It is not on the payslip (the worker's 10 % and the commission are); it shows up only as
AFP credits above 10 % of the base. Handling:

- **Rate from the parameters, never hardcoded:** `payroll_parameters` gets the employer's
  individual-account rate per month, fetched with the rest (Previred's indicators publish it), so
  each step is picked up when it happens.
- **Treated like the AFC employer share:** a deposit into the AFP account together with the
  worker's 10 % (it is already inside the credited pesos), not income, not an expense.
- **Check:** the AFP credited for a month is expected to be 10 % + the employer rate of the capped
  base; the difference is recorded (phase 7), never refused. The commission is unaffected (it is
  the payslip's AFP line − 10 %).
- Any part of the employer contribution that goes to the social-insurance fund rather than the
  individual account is not the worker's money and is not tracked.

### Recorded differences (`payslip_checks`)

Per payslip: expected vs printed for taxable base (min(pay, cap × UF)), AFP mandatory,
AFC worker share, health ≥ 7 % of the capped base, income tax (from the monthly table).
Shown on the payslip and summed per year on /tax-return.

## Phases

1. **Parser: every line.** All layouts (Nuevo Chile, Unholster scans, Dealsyte,
   Overactive/Perficient, Axity, Buk, finiquitos — Dirección del Trabajo electronic form
   and the scanned one) emit `lines`; `employment.payslips` v2 carries them. Verify: all
   payslips re-parse with the fixed fields unchanged, and every gap between Σ named
   discounts and the total becomes named lines.
2. **Schema + classification.** Migration for `payslip_lines`, `payslip_contributions`,
   `payslip_checks`; the kind rules; history filled from the parse and the certificates.
3. **Category parents.** `parent_id` on expense categories, «Impuestos» and «Comisiones
   AFP» under «Cuentas y servicios»; the expenses payload offers both levels (server
   built).
4. **Rebuilt and missing documents.** Finiquitos imported; the missing months rebuilt
   (rule 7); the USD months get gross and fee (rule 6); the advances linked.
5. **Income breakdown.** Server payload per payslip / month / year: gross (taxable,
   non-taxable, indemnities), each discount kind, net; the income page shows gross vs net
   and the discounts, beside the deposits.
6. **Expenses.** Payslip-sourced expense lines (source «Liquidación») in their
   categories, dated to the payslip's month; check that no top-up or tax paid outside
   payroll is counted twice.
7. **Parameters and checks.** Fetch the monthly parameters and tax tables; compute and
   store `payslip_checks`; /tax-return shows the year's withheld tax against the table's
   and the F22 result (payment or refund, from the bank) as the year's settlement.

## Data fixes that ride along

- One APV row of 2019 tagged as a manager's compensation is listed by the fund manager as
  state benefit; relabel it (both count as gain, so no figure changes).
- A finiquito's «anticipo de sueldo» equal to the previous month's life-insurance
  deduction: record it as printed (kind advance), with no matching deposit.
