# Fund and basket pages: the stock page's design for every unit position

Status: plan, not started; open questions answered 2026-11-20 (see the end). Follows the stock page (`EquityAccountDetailPage`, `equityGlance.ts`,
commits b769fc9e and 56612c90): title line, valuation chart beside a rail (price sparkline with its
range row and held-stretch dimming, price track, composition bar, día/mes/año bars), P/L mensual |
Rentabilidad, Movimientos and Detalle at full width. One rule for held and sold-out positions: the
cost-based pieces are measured on the last day the position held units (today while it holds any).

## What gets the new design

**Fund accounts** — an account valued as units × a published unit value. In the code these are the
quantity sources `cuota_ledger` and `fintual_goal` (`accountProfile.ts`); in today's data:

| Account kind | Examples (test data) | Unit value | Today's value |
|---|---|---|---|
| Fintual goal (certificado) | Reserva, caca daca | `fund_unit_daily` (Fintual's own share count, checked against the official serie) | the day's published cuota |
| Fintual goal on the proxy basket | mega caca (APV-A), mega cbcb (APV-B) | same series | the Risky Norris proxy estimate in session (`riskyNorrisProxyMtm.ts`) |
| AFP fund (one account per manager) | UNO-A, Modelo-A and PlanVital-A (both sold out by switches) | `afp_*_cuota_a` (SP official, display lag 1) | latest published cuota |
| AFC (CIC) | AFC | `afc_cic` | latest published cuota |

**Baskets** — a portfolio group holding a few positions that are one investment: «IPSA»
(`brokerage_portafolio_ipsa`: CFIETFIPSA + Caja IPSA) and «SOXX» (`brokerage_soxx`: SOXX + SOXQ). Today
they render as group pages (`GroupInfoBase`: member cards strip, group charts, flows). They get the
same page shape with the breakdown of their members as a rail block (§3).

**Crypto accounts** — Bitcoin and Ether (quantity source `coin`: coin units × the coin's dollar close
in `equity_daily`, `BTC-USD` / `ETH-USD`, market `crypto24`, live quotes as for stocks). They get the
stock page as it is: same sub-line (coin name · US$ price · «en vivo · el mercado 24 h»), track,
composition (no dividends segment unless a coin pays any), sparkline and periods.

Out of scope here: cash, checking, cards, property, mortgage, option contracts.

## 1. One glance builder for every unit position

Generalize `equityGlance.ts` into a unit-position glance (rename `equity_glance` → `position_glance`
on the bundle, DTO `PositionGlanceDto`), with the instrument part as a tagged union so each kind
states its own facts and nothing is guessed on the client:

- `instrument: { kind: "market", ticker, name, market_kind, session }` (stocks and coins: a registry
  instrument with a live quote) `| { kind: "fund", series_label, manager | null, price_source:
  "official" | "proxy", published_on }`.
- Shared, computed the same way for every kind: `value`, `sparklines` (per range, x by day, `held`
  stretches), `track` (average cost, today's unit value, highest since first held), `price_vs_cost`,
  `composition` (as of the last day held), `periods`.
- Units and the held stretches come from the unit ledger the value already uses: shares
  (`BROKERAGE_SHARE_UNITS_FLOW_KINDS`) for stocks, coin units for crypto (the Buda rows' `units_delta`,
  `crypto_movement_kinds`; a round trip to another exchange stays held), the cuota ledger for funds (`units_delta` +
  transfer legs + `counter_units_delta` for AFP switches, as `cuotaLedger`/`sumUnitsThroughDate` read
  them). One `heldSpans(accountId)` over the account's own unit source, not one per kind.
- Unit prices: `holdingPriceAt` already prices all three (`stock`, `coin` and `fund` holdings); the
  sparkline reads the stored series (`equity_daily` for stocks and coins, `fund_unit_daily` and the AFP
  and AFC series for funds) through one `unitPriceSeries(holding, from, to)` next to it.
- Average cost: the FIFO open lots of each kind's existing lot walk — `equityTaxLotEvents.ts` for
  stocks, `cryptoTaxLotEvents.ts` for coins (lots paid in pesos convert to the coin's dollar quote on
  their purchase day at the stored mid, as stock lots in another currency do; commissions follow the
  walk's default treatment), the new fund walk of §2 for funds.

## 2. Average cost per cuota (new)

Funds have no tax-lot walk today (`equityTaxLotEvents.ts`, `cryptoTaxLotEvents.ts`, … — no fund one).
Add `fundTaxLotEvents.ts` feeding the same `realizeTaxLots(…, "fifo")`:

- acquire: a cuota inflow at the pesos it cost (aporte, cotización, a Fintual purchase, an AFP
  switch's ingress at the egress's pesos so a switch moves cost, not gain);
- dispose: a cuota outflow (retiro, the switch's egress, a liquidation);
- units-only rows (`cash_fee` commissions, `savings_earnings` catch-up cuotas): commissions dispose at
  0 proceeds, earnings acquire at 0 cost — the same treatment the AFC true-ups already document;
- APV state bonus (`aporte_estatal_clp`): acquires at 0 personal cost (it is not your money), so the
  cost per cuota is the personal cost — to confirm, see open question 2.

Fail fast as the stock builder does: open lots that disagree with the ledger's cuotas throw.

## 3. The basket page

New `BasketGroupPage` chosen for a basket group (rule: open question 1). Same layout as the stock page:

- **Title line:** group name, the group's value and day P/L (the card's figures).
- **Band:** the group valuation chart (existing, Rango/Período row) beside the rail.
- **Rail, top block = breakdown:** one line per member — name, value, share of the basket as a thin
  bar, units, and (for unit positions) its own price pill coloured by its own cost. Each line links to
  the member's page. The server serves the rows with their shares (`basket_glance.members`).
- **Rest of the rail:** the basket's composition bar (Σ members: deposited + price + dividends, as of
  the last day the basket held anything) and día/mes/año bars (the group card's metrics). No single
  price track: a basket has no one unit price.
- **Sparkline:** the basket's own value index (the chained daily return the group's Rentabilidad
  already computes, `perf_levels`), same range row and held dimming over the basket's held stretches.
- **Below:** P/L mensual | Rentabilidad, Movimientos (all members), Detalle — the group's existing data.

## 4. Fund page differences from the stock page

Same components; only what the data says differs:

- **Sub-line:** series name (e.g. «Fondo A», «Very Conservative Streep») · unit value · «al 2026-11-19»
  (the publication day) — or «estimado» while the proxy prices it (`price_source: proxy`). No market
  session.
- **Price track:** cost per cuota · today's cuota · highest cuota since first held (same rules).
- **Composition:** deposited + result; APV accounts add the state bonus as its own segment
  («aporte estatal»), since it is in the value but not in the personal deposits.
- **APV on the proxy basket:** the breakdown block of §3 shows the basket's ETF weights
  (`loadProxyBasketBreakdown`, the value map's «holding» tiles) under the track.
- **AFP switches:** the sold-out PlanVital-A and Modelo-A pages get the same treatment as a sold-out
  stock (measured on their last day held).

## 5. Phases

1. Server: unit-position glance (rename, instrument union, shared unit ledger + price series), stock
   behaviour unchanged — existing tests keep passing; crypto through the same builder (coin units,
   crypto lots); then the fund cost lots (§2) with synthetic fixtures per kind (Fintual goal, AFP with
   a switch, AFC with commission true-ups, APV with a bonus).
2. Client: the stock page component becomes the unit-position page; the fund sub-line and the APV
   breakdown block; crypto and fund accounts route to it.
3. Basket: server `basket_glance` on the group bundle; client `BasketGroupPage` and its breakdown block.
   Server built 2026-11-20: `basketGlance.ts`, served as `basket_glance` on `GET /api/dashboard/nav-context?root=<basket slug>`
   (null for every other root; DTO `BasketGlanceDto` in `server/contracts/src/dto/groups.ts`), so value and día/mes/año
   are the group card's own figures from the same payload and cache entry. The sparkline's `cost_y` is the index level
   on the composition day × deposited ÷ value that day.
4. Verify per kind in the preview (desktop + 375), the full server suite before/after, and the
   «Never hardcode personal values» scan before pushing.

## Decisions (2026-11-20)

1. **Baskets are declared:** a flag on the portfolio group (`portfolio_groups.basket`, migration; set
   from the panel's group editor), seeded on for «IPSA» and «SOXX». No shape rule.
2. **APV cost per cuota is personal cost:** the state bonus acquires at 0 cost, so the track and the
   price colour show the gain on your own money; the bonus is its own composition segment.
3. **Proxy-priced funds use the in-session estimate** for the price colour and the track (marked
   «estimado» on the sub-line), as a stock's live price does.
4. **Crypto is included** (Bitcoin, Ether): phase 1 on the server, phase 2 on the client.
