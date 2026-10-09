# Tax return: art. 107 LIR instruments (the IPSA fund)

Status: plan written 2026-10-09. Phases 3–4 (client: types, `Art107Section`, i18n; docs: the
AGENTS.md «Tax return» bullet and this line) landed 2026-10-09. Phases 1–2 (server) were
implemented by a parallel agent the same day; the orchestrator verifies them. Personal figures
stay out of this file; the ledger facts it needs are in the DB.

## Goal

Carry the **Fondo de Inversión ETF Singular IPSA** (ticker `CFIETFIPSA.SN`, held through
Racional as the «IPSA» bucket: the fund account plus its caja) correctly on the local
Formulario 22 (`/tax-return`): its sale gains under **art. 107 LIR** (impuesto único 10%,
and ingreso no renta from 2027), its annual distributions as dividends afectos al IGC, and
the SII's own cross-checks (DJ 1891, DJ 1922). Today the draft ignores the fund entirely.

## The rules (what the SII says)

Sources, all read on 2026-10-08: SII Circular 39/2022 (instructions on Ley 21.420);
SII «corregir observación» guides B101/B102 AT2026; SII línea 66 instructions AT2025;
the F22 AT2026 form; DJ 1891 and DJ 1922 instructions 2026; Singular's reglamento interno
(vigente 2026-10-02) and folleto; Garrigues' note on the 2026 reform.

### The instrument

- A **fondo de inversión** under Ley 20.712 (rescatable, started 2025-05-12, fee 0,2%/yr),
  whose reglamento interno is built for art. 107 N°2: at least 90% of assets in IPSA
  shares with presencia bursátil, a market maker hired «para acogerse al beneficio
  tributario art. 107 N°2», and clause «Beneficio Tributario» obliging the manager to pass
  through every dividend and interest received (within the year or 180 days after,
  up to the beneficios netos). Reparto policy: at least 30% of beneficios netos, yearly,
  within 180 days of year end, in cash unless the aportante opts for cuotas liberadas.
- The folleto states it: «107 LIR: los aportantes podrán acogerse al beneficio… en la
  medida que las cuotas tengan presencia bursátil y se cumplan los demás requisitos».

### Sale gains (art. 107 as amended by Ley 21.420, sales from 2022-09-02)

- The **mayor valor** on a sale in bolsa pays a flat **10% impuesto único** (art. 107 N°1,
  extended to fondos de inversión by N°2). It is outside the IGC base (never in 158/170),
  and once declared and paid the amount is «tributación cumplida» (N°8).
- **Mayor valor = precio de enajenación − valor de adquisición reajustado.** Residents
  choose the cost, per instrument or operation, irrevocably once filed (Circular 2.2.1):
  - (a) the **precio de cierre oficial at 31 December of the purchase year**, reajustado
    by IPC from the month before that deemed acquisition date (November) to the month
    before the sale, oldest lots first; the SII may pre-fill it in the propuesta. Lots bought
    and sold in the same year are determined at year end (2.2.4), at that year's close.
  - (b) the **pesos actually paid**, reajustados by IPC from the month before the purchase
    to the month before the sale (art. 108/109 via art. 82 A LUF — the same rule as shares,
    art. 17 N°8 a); the taxpayer identifies the lots, else FIFO or LIFO.
  - (c) the 31-12-2021 close, only for holdings bought before 2022-09-02 (not our case).
- **Losses** (N°5): deductible only from other art. 107 gains, in the same year or carried
  forward, reajustadas by IPC from the month before the losing sale to the month before
  the close of the year they are deducted in. Never against salary, dividends, crypto, or
  code 169. Residents control the carry-forward on the return itself: code 1815 of a year
  is the previous year's negative 1816, reajustado.
- **No retention for residents** (2.4): the seller declares and pays in April's F22, even
  when the year's net result is a loss (2.6).
- **F22 (AT2026 layout):** recuadro N°4 «Enajenación o rescate de instrumentos según art.
  107 LIR» — 1809 acciones, **1813 cuotas de fondos mutuos y/o de inversión** (mayor o
  menor valor), **1814 resultado neto**, **1815 pérdida de arrastre actualizada**, **1816
  base imponible o pérdida**; línea 66 — **1829** base (= 1816 when positive) and **1830**
  = 10% of 1829, which adds to the liquidación (305) beside 304. Línea 95 code 833 holds
  retentions, which residents never have.
- **Cross-checks:** DJ 1891 (the corredor's compras/ventas of cuotas, tipo 8 or 10; its
  «valor de adquisición» column is filled for shares only) and DJ 1922 (the custodian
  reports the sale difference «que cumple requisitos art. 107, actualizada» in section
  B1, and distributions with their credits in B3/B4). Observations B101/B102 fire when
  1814/1815/1816 disagree with them.

### Distributions

Not art. 107. For a resident natural person a reparto is a **dividend afecto al IGC** with
the crédito IDPC the fund's register carries (Certificado 44, DJ 1922 B3/B4), declared in
línea 2 (code 105 plus its credit columns), or exenta / INR / tributación cumplida when
the certificate says so. A devolución de capital is a return of the aporte, not income.
The first distribution this holder can receive is the FY2026 dividend, due by 2027-06-29,
on AT2028.

### The 2026 reform

The Ley de Reconstrucción Nacional (Congress 2026-08-04, Tribunal Constitucional
2026-10-02, promulgation pending at the time of writing) eliminates the 10% impuesto único
and restores the pre-Ley 21.420 text **from 2027-01-01**: the mayor valor is **ingreso no
renta** again (no code, no tax, no bracket effect), and losses are deductible only from
other INR, i.e. worthless. The regime is decided by the **sale date**.

### What is not income

Sale proceeds split into the cost paid (return of capital, never income), the IPC
adjustment on that cost (never income: the law reajusts the cost before computing the
gain) and the mayor valor (10% único for a 2026 sale; INR from 2027). The caja's monthly
management fee (`cash_fee`) is not deductible on a personal return and is not part of the
cuotas' cost.

## What the module does today

- `foreignShareTaxGains.ts` keeps only accounts whose trade legs are in USD
  (`foreignEquityAccounts`), so the fund is excluded by accident (its buys are CLP).
- `f22Draft.ts` `loadDividends` reads USD `dividend_payout` rows only.
- DJ 1891 and 1922 are imported into `sii_informed_dj` but no code reads them.
- The 305 identity (`siiF22Compacto.assertF22Identities`, `buildF22Draft`) has no 1830
  term; the chain (`computeF22Tax`) has no 105 or 610.
- Nothing marks which instruments are art. 107 instruments.

## Settled decisions

1. **The regime is structured state, never a heuristic.** A table `art107_instruments`
   (ticker → `kind` `fund` | `share`) says which equity accounts are art. 107 instruments.
   The `.SN` suffix alone must not decide it: a Chilean S.A. share is art. 107 N°1 (code
   1809, with its own acquisition conditions), a fund N°2 (code 1813). Migration 230
   creates the table and seeds `CFIETFIPSA.SN` as `fund` (a public ticker, not personal
   data; the demo and test DBs get the row harmlessly).
2. **Lots and cost.** Lots through the existing `taxLots.ts` (FIFO default, the method a
   parameter). Both resident cost options are computed per disposal: `cost_paid` (option
   b) and `close_dec31` (option a, the Dec-31 close of the purchase year from
   `equity_daily`, flagged as a stand-in for the CMF's precio de cierre oficial; null when
   no close is stored or the lot was bought in an income year that has not closed). The
   draft's default is the option with the lower result, as `foreignShareTaxGains` does;
   both are reported, since the choice is irrevocable once filed.
3. **Reajuste** through `officialIpcVariationPctWithStandIn` (the SII's own index ratio;
   stand-in for unpublished months, so an open year is provisional): cost from the month
   before the purchase (option b) or November of the purchase year (option a) to the month
   before the sale; a loss from the month before its sale to November of the deduction
   year; a carried loss from November of the year it was declared in to November of the
   deduction year. Gains get no year-end reajuste (unlike art. 17 N°8 results).
4. **Regime by sale date** (`art107RegimeForSale`): `inr` before 2022-09-02, `tax_10pct`
   from 2022-09-02 through 2026-12-31, `inr` from `ART107_INR_FROM` = 2027-01-01 (the
   reform's vigencia; a constant with a comment, to be moved if publication slips past
   year end). An `inr` disposal is listed with its result but enters no code and carries
   no loss.
5. **Codes.** 1813 (funds) and 1809 (shares) = Σ results of the year's `tax_10pct`
   disposals under the default option; 1814 = 1813 + 1809; 1815 = the previous AT's
   negative 1816 (the filed form's when filed, else the app's own prior-year result)
   reajustado; 1816 = 1814 + 1815; 1829 = max(0, 1816); 1830 = round(0,10 × 1829).
   305 = 304 + 1830 − 198 + 900 in both the draft and `assertF22Identities`. 304, 158, 170
   and 169 never see these codes.
6. **Distributions.** A CLP `dividend_payout` out of an art. 107 fund account is a línea 2
   dividend: the draft estimates code 105 from the cash credited (flagged `estimated`),
   and reads the informed figure from DJ 1922 B3 («…afectas a Impuesto Global
   Complementario…») and the credit from B4 into 105 / 610 when the DJ is on file.
   `computeF22Tax` adds v(105) to 158 and subtracts v(610) in 304 (no filed form carries
   either, so the reproduction guard holds); 105 joins `CAPITAL_LOSS_POOL_CODES` (F22
   line 17 names it).
7. **DJ reads.** DJ 1891 «Monto Total Ventas» is shown beside the app's proceeds as the
   informed cross-check (like `cryptoInformedSalesClp`); DJ 1922 B1 «…que cumplen
   requisitos art. 107 LIR (actualizada)» becomes the informed 1813 when non-zero.
8. **Fee.** The caja's `cash_fee` rows stay out of the return.

## Design

### Server

- **Migration `230_art107_instruments.sql`:** `art107_instruments (ticker TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('fund','share')), note TEXT)`; seed
  `('CFIETFIPSA.SN','fund','Fondo de Inversión ETF Singular IPSA')`. Also add to
  `schemaBaseline.ts`? No — post-baseline migrations apply everywhere; nothing else.
- **`art107Instruments.ts`:** `art107InstrumentKind(ticker): 'fund' | 'share' | null`,
  `listArt107Accounts(): { id, name, ticker, kind }[]` (accounts whose `equity_ticker` is
  in the table).
- **`art107TaxGains.ts`** (sibling of `foreignShareTaxGains.ts`):
  - `export type Art107CostOption = 'cost_paid' | 'close_dec31'`;
    `export type Art107Regime = 'tax_10pct' | 'inr'`;
    `export const ART107_TAX_FROM = '2022-09-02'`, `ART107_INR_FROM = '2027-01-01'`,
    `ART107_RATE = 0.10`; `art107RegimeForSale(ymd)`.
  - Pure `art107DisposalClp(d: TaxLotDisposal, ipcBetween, closeDec31: (ticker, year) =>
    number | null, ticker, incomeYearClosed: boolean)` → `{ cost_paid: number;
    close_dec31: number | null; costPaidReajustadoClp; costCloseDec31Clp | null }`.
  - `art107GainsForYear(year, lotMethod, todayYmd)` → disposals (account, ticker, kind,
    date, movementId, units, proceedsClp, costClp, costReajustadoClp,
    costCloseDec31Clp | null, resultClp per option, regime), `defaultOption`, totals per
    option for `tax_10pct` disposals only, per-kind sums (1809 / 1813), `provisional`,
    `inrDisposals` listed apart. Throws when an art. 107 account trades in anything but
    CLP (`loadEquityTaxLotEvents(...).currency`).
  - `art107LossCarry(taxYear, incomeYear, filedPrev, ipcBetween)`: the previous AT's 1816
    when negative (filed first, else the app's own result for the previous income year),
    × (1 + IPC(Nov prev → Nov current)/100). Returns `{ clp, source: 'filed' | 'app' |
    null }`.
  - Distributions: `art107DistributionsForYear(year)` — CLP `dividend_payout` rows whose
    `from_account_id` is an art. 107 fund account.
- **`f22Draft.ts`:** add the art. 107 block to `F22Draft` and `buildF22Draft`: codes
  1809/1813/1814/1815/1816/1829/1830 (zeros omitted on a `none` base like the other app
  codes); `draft[305]` gains `+ (draft[1830] ?? 0)`; `computeF22Tax` adds v(105) to 158
  and − v(610) to 304; `CAPITAL_LOSS_POOL_CODES` gains 105; `informedCodes` reads DJ 1922
  B1 → 1813 and B3/B4 → 105/610 when non-zero; `loadDividends` stays USD (foreign) and the
  CLP fund distributions go through the new loader. `foreignShareTaxGains.ts` must skip
  art. 107 accounts explicitly (not only by currency).
- **`siiF22Compacto.assertF22Identities`:** `305 = 304 + 1830 − 198 + 900`.
- **`f22DraftPayload.ts`:** `ROW_LAYOUT` gains 105 (income, after 110), 610 (credit, after
  1018), 1813/1814/1815/1816 (`memo`, after 169), 1829/1830 (`tax`, after 157); new payload
  block:

  ```
  art107: {
    lot_method: "fifo",
    provisional: boolean,
    inr_from: "2027-01-01",
    default_option: "cost_paid" | "close_dec31",
    sales: [{ date, account_name, ticker, kind: "fund" | "share", units, proceeds_clp,
              cost_clp, cost_reajustado_clp, cost_close_dec31_clp: number | null,
              result_clp: { cost_paid: number, close_dec31: number | null },
              regime: "tax_10pct" | "inr" }],
    totals_clp: { cost_paid: number, close_dec31: number | null },   // tax_10pct sales only
    result_clp: number,            // 1814
    carried_loss_clp: number,      // 1815 (≤ 0)
    carried_loss_source: "filed" | "app" | null,
    base_clp: number,              // 1816
    tax_clp: number,               // 1830
    informed_sales_clp: number | null,          // DJ 1891 «Monto Total Ventas»
    informed_result_clp: number | null,         // DJ 1922 B1 art. 107 difference
    distributions: [{ date, account_name, amount_clp }],
    distributions_clp: number,     // the estimate behind 105
  }
  ```

### Client

- `client/src/types/taxReturn.ts`: the `art107` block above.
- `TaxReturnPage.tsx`: an «Art. 107» section after the foreign-shares one, with the same
  desktop-table + `TableMobileCard` pattern: sales table (date, instrument, units, proceeds,
  cost paid, cost reajustado, Dec-31 option, result, regime badge), a line for the carried
  loss, the base and the 10%, the informed cross-checks when present, the distributions
  table, and a note when `provisional`. An `inr` sale row says so (no tax).
- `master.json`: labels for codes 105, 610, 1809, 1813, 1814, 1815, 1816, 1829, 1830 under
  `taxReturn.codes`, the new section's copy under `taxReturn.art107`; then
  `npm run i18n:generate -w nw-tracker-client`.

### Tests

- `art107TaxGains.test.ts`: the pure disposal function (both options, IPC injected, a lot
  bought in an open year has no Dec-31 option, the default picks the lower result);
  `art107RegimeForSale` at the boundaries; the loss carry reajuste.
- `f22Draft.test.ts`: `computeF22Tax` with 105/610; `capCapitalLosses` with 105 in the pool.
- `siiF22Compacto.test.ts` (or the existing test file): the 305 identity with 1830.
- A DB-backed test in the server suite (`cd server && npm run test -- <file>`), with
  prefixed synthetic fixtures cleaned up: an `art107_instruments` row for a synthetic
  `.SN` ticker, a CLP stock account, buys and a sale in a closed year → the account is out
  of `foreignShareGainsForYear`, in `art107GainsForYear`, and the draft shows 1813 → 1816 →
  1829/1830 with 305 carrying 1830; a CLP `dividend_payout` → the 105 estimate.

### Docs

- AGENTS.md «Tax return»: one bullet for the art. 107 block (regime table, codes, the
  305 term, DJ reads, the 2027 switch).
- This file: status line updated when the phases land.

## Phases

1. Server: migration, `art107Instruments.ts`, `art107TaxGains.ts`, unit tests.
2. Server: `f22Draft.ts` / `f22DraftPayload.ts` / `siiF22Compacto.ts` integration, DJ
   reads, DB-backed test, `foreignShareTaxGains.ts` exclusion.
3. Client: types, section, i18n.
4. Docs: AGENTS.md bullet, status here.

Verification: `cd server && npm run test`, root `npm run typecheck` (runs
`check:conventions`), the page on the dev server for the AT with the fund (AT2027).
