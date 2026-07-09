# nw-tracker

A personal net-worth tracker for the Chilean market — brokerage, retirement (AFP/AFC),
crypto, real estate, cash, credit cards and more — consolidated into one dashboard with
historical valuations, monthly P&L, aportes (contributions), and long-range projections.

**Live demo:** https://nw-tracker-demo.onrender.com/

> Log in with your email and password: `frasertest26`
>
> The demo runs on synthetic data — nothing here is real financial information.

## What it does

- **Multi-asset consolidation** across CLP / USD / UF, with per-account and per-group history.
- **Market data sync** — equities and crypto (Yahoo / CoinGecko), UF and USD/CLP FX,
  intraday live quotes for current-day mark-to-market.
- **Credit cards** — statement parsing, installment tracking, and "owed on date" liability
  curves.
- **Projections** — real (today's-money) accumulation to retirement plus drawdown strategies.
- **Data pipeline** — imports from spreadsheets, bank cartolas, and PDF statements; the app
  itself always reads from SQLite.

## Stack

- **Monorepo** — npm workspaces (`server`, `client`), Node 24, TypeScript throughout.
- **Server** — Express + better-sqlite3 (SQLite), synchronous migrations.
- **Client** — React + Vite, TanStack Query, Recharts, react-aria-components, i18next
  (Spanish UI).

## Running locally

```bash
npm install
npm run dev:server   # API on :3001
npm run dev:client   # Vite dev server on :5173
```

Tests run per-workspace:

```bash
cd server && npm run test
```

See `AGENTS.md` for architecture and conventions.
