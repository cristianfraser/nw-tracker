# Demo data generator v2 — plan

Status: plan (2026-10-31). Replaces the `demo` preset of `server/src/demoData/` from the
bottom up; the lean `test` preset keeps the current engine until v2 is done, then moves.

## Goal

A synthetic person whose money is told ONLY through the documents a real person
receives — cartolas, card statements, liquidaciones, contractor payslips, fund and pension
certificates, broker records — imported through the same ingest handlers the personal
instance uses. Everything else (balances, gastos, income, P/L, net worth) is derived by
the app. End state: net worth ≈ US$400k today (close is fine, not exact).

## Architecture

1. **Life ledger** (`demoData/v2/ledger*.ts`): a seeded, deterministic list of real-world
   events — paycheck, boleta, purchase, transfer, divisas, card payment, contribution,
   gift, trade. Pure, no DB. Random draws come from a per-month stream
   (`rng(seed, month, stream)`), so appending a new month never changes history.
2. **Document renderers** (`demoData/v2/render*.ts`): ledger → canonical ingest payloads
   (`server/contracts`):
   - CLP checking + cuenta vista cartolas → `bank_account.statements`
   - checking USD → `bank_account.statements` with a currency (contract extension), or a
     direct write as the one exception — decide in phase 1
   - card facturaciones, CLP + USD twins → `card.statement`
   - liquidaciones (jobs 1–2) → `employment.payslips` v2 (lines add up)
   - contractor payslips (jobs 3–4) → `employment.payslips` (contractor_fee / transfer_fee)
   - APV-A / APV-B → `fund_account.transactions`
   - AFP → `pension_account.certificates`; AFC → `unemployment_fund.documents`
   - broker → `broker.movements` (generic broker, see below)
   - F22 per año tributario → `sii_f22_filed` (tax page)
3. **Import**: payloads applied through `INGEST_HANDLERS` in date order. If the demo cannot
   import its own documents, that is an importer bug.
4. **Invariants** asserted at the end of the build (fail the build, never the live demo):
   cartola saldo identities; every statement's billed total = its lines; cupo check passes;
   payslip totals reconcile; flows-overview «sin explicar» ≈ 0 every month; checking stays
   inside its cash band; net worth within ±10% of target.

Market data stays as today (`demoRealMarket.ts`: real Yahoo / Banco Central / AFP), so the
only levers are amounts and dates. Previred parameters (UF, UTM, caps, AFP rates) ship as
a committed snapshot, like the AFP Modelo CSV — Render cannot reach Previred.

## Person

Born 1995-04. Data from 2016-01.

| Period | Chapter | Money in | Housing |
|---|---|---|---|
| 2016-01 → 2018-03 | University (dummy engineering, 2013–2018) | Dad's allowance ~250k/month into a cuenta vista | Parents |
| 2017-01 → 02 | Internship 1 | Boleta ~550k gross/month, retention 10% | Parents |
| 2018-01 → 02 | Internship 2 | Boleta ~650k gross/month, retention 10% | Parents |
| 2018-04 → 2020-06 | Job 1 (contrato) | ~1,1M → ~1,25M líquido; allowance stops ~2019-03 | Parents |
| 2020-07 | Gap | Finiquito (vacaciones proporcionales) | Parents |
| 2020-08 → 2022-09 | Job 2 (contrato) | ~2,0M → ~2,3M líquido + yearly bonus | **First apt** from 2020-08, 550k reajustado by IPC |
| 2022-10 → 2024-09 | Job 3 (foreign contractor) | US$6.000/month | First apt → **expensive apt** 2023-02 → 2024-02, ~800k |
| 2024-03 | Purchase | Dad's gift + stock sale | **Own apt** from 2024-03 |
| 2024-10 → today | Job 4 (foreign contractor) | US$8.000/month | Own apt |

Banking: cuenta vista as a student; cuenta corriente CLP + checking USD + first card at
Job 1; a second card around Job 3 (dollar side for travel and subscriptions).

### Contrato jobs (1–2)

Liquidaciones with gratificación, aguinaldos (Fiestas Patrias, Navidad), annual raises
around IPC, Job 2 bonus. AFP + AFC + salud deducted; AFP / AFC certificates follow.

### Contractor jobs (3–4), done properly

- Employer pays through a Deel-style platform; the USD wire lands in checking USD;
  the platform's contractor payslip is rendered as `employment.payslips`.
- Monthly boleta de honorarios electrónica with «retención por el contribuyente» (a foreign
  payer cannot withhold); the retention is paid by F29 by the 12th, a debit from CLP
  checking. Rate per law 21.133: 12,25% 2022 · 13% 2023 · 13,75% 2024 · 14,5% 2025 ·
  15,25% 2026.
- April operación renta (F22): taxable base = 80% of gross (20% gastos presuntos, cap 15
  UTA); retentions first pay the independent contributions (AFP, SIS, accidentes, ley
  Sanna, salud — AFP credited ~July), the rest against IGC → refund or payment.
- No AFC as an independent: AFC freezes after Job 2.
- Dollars converted to CLP as needed (divisas in both cartolas); broker deposits in USD.

### APV

- APV-A: 40 UTM each December 2019–2022 (full 6 UTM / 15% state bonus, credited the
  following year after the operación renta, as a state bonus, not a personal deposit).
- APV-B from 2023: contractor income puts the IGC marginal rate at 23% (70–90 UTA), above
  the 15% bonus. Same 40 UTM each December.
- Rule in code, not dates: regime B when the year's projected marginal rate > 15%.

## Broker

One generic «Broker» (CLP cash, USD cash, one account per ticker) plus a dummy
«Crypto exchange» for BTC — or BTC at the broker, whichever imports cleaner.

- Cash rule: checking holds 3–6× trailing-months expenses; above 6× the excess goes to the
  broker; below 3× investing pauses (sells only for big events).
- DCA: fixed monthly deposit + fixed SPY buy. Lump sum: when broker cash passes a
  threshold, the excess goes into the current play.
- Plays:
  - BTC: DCA 2018–2019, held through 2020 and 2022, still held.
  - SPY: anchor, bought throughout.
  - NVDA: lump sum 2021 — the stock that exploded; most of the pie comes from selling part
    of it in 2024-02 (plus some SPY).
  - Winners: AAPL (2019), MSFT (2020), AMD (2019).
  - Losers: ZM bought high 2020-10 and sold; INTC bought 2021 and held down.
  - OILK bought high and sold low, LNG held — same dates as the personal ledger (OILK
    bought 2026-05, sold 2026-06; LNG bought in the same window, held).
- Dividends booked net with their withholding detail.

## Expenses

Hand-tuned, no personal data. Category levels from Numbeo-style prices at a mid-high
single-person level (US/EU comparable): housing, utilities, groceries, restaurants,
delivery, transport (car costs included: permiso de circulación in March, SOAP, mantención,
bencina, TAG), health, subscriptions, clothing, tech, travel, gifts, hobbies, personal care.

- Real terms, indexed by the real IPC; rents reajustadas yearly.
- Ratchet: each category level `L_t = max(L_{t-1}, L_{t-1} + α·(target(smoothed income) −
  L_{t-1}))`, small α — climbs slowly, never comes back down.
- Windfalls (job change, bonus, finiquito) trigger one-off spends, never move `L`.
- Big items: a trip in January or September every 1–2 years (flights in cuotas, USD
  charges abroad); MacBook 2018, 2022, 2025 in 12 cuotas sin interés; December gifts,
  Fiestas Patrias.
- Cars: used car ~2019-03 (~6,5M, cash + a few cuotas); trade-in for a newer one
  ~2023-01 (~17M) after the Job 3 windfall.
- Purchase: ~5.500 UF apt; pie 20% (~1.100 UF) = dad's gift (incoming transfer) + NVDA
  (mostly) + SPY sale; ~150 UF gastos operacionales (notaría, CBR, tasación); mortgage
  ~4.400 UF / 25 years, cuota paid by card; then contribuciones, gastos comunes and a
  one-off furniture spend.

## Net worth sanity check (≈ US$)

| | |
|---|---|
| Savings jobs 1–2 | 40k |
| Savings jobs 3–4 | 185k |
| Market gains | +90k |
| Stock sold for the pie | −18k |
| Brokerage + cash | ~295k |
| Apartment equity | ~65k |
| AFP | ~15k |
| APV | ~25k |
| **Total** | **~400k** |

## Phases

1. Ledger core: timeline, income, cash band, cartola CLP + USD rendering, import, saldo
   invariants. Decide the USD cartola contract.
2. Cards: purchases, cuotas, USD twins, payments (CLP and divisas), statement import, cupo.
3. Payroll: liquidaciones, contractor payslips, AFP / AFC, boletas, F29, F22.
4. Broker + crypto, APV-A / APV-B with the state bonus.
5. Housing and cars: rentals, purchase, mortgage, contribuciones, gastos comunes.
6. Expense model tuning (ratchet, windfalls, seasonality) to the net-worth target.
7. Swap the `demo` preset to v2, delete v1 writers; then port the `test` preset.
