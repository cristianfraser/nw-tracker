# nw-tracker

An automated net-worth and expense tracker for the Chilean market. It connects to banks, card
issuers, brokers, pension funds and mailboxes, imports each statement as it arrives, checks it
against the source's own totals, and values every account daily: brokerage, retirement (AFP/AFC),
crypto, real estate, cash, credit cards and the mortgage, consolidated into one dashboard with
daily history, returns, cash flow and long-range projections.

**Live demo:** [nw-tracker-demo.onrender.com](https://nw-tracker-demo.onrender.com/?src=github)

> The demo shows a fictional person's finances, generated as documents and imported the same way
> real ones are, at real market prices. It is open to anyone; a few edits are allowed and are
> undone after a while.

## What it does

- **Multi-asset consolidation** across CLP / USD / UF, with per-account and per-group history.
- **Market data sync** — equities and crypto (Yahoo / CoinGecko), UF and USD/CLP FX,
  intraday live quotes for current-day mark-to-market.
- **Credit cards** — statement parsing, installment tracking, and "owed on date" liability
  curves.
- **Projections** — real (today's-money) accumulation to retirement plus drawdown strategies.
- **Expenses and income** — every card and bank line categorized, refunds netted, receipts
  and transfer notices matched to the charges they explain.

## How data arrives

```
Sources  →  Ingest service  →  Server  →  Client
```

- **Sources:** bank statements and daily movements, card statements and unbilled listings,
  broker and pension-fund documents, mail (payment receipts, transfer notices, payslips,
  utility bills) and market data (prices, exchange rates, UF).
- **Ingest service** (`ingest/`): signs in to each source, fetches, reads PDFs and spreadsheets
  (TypeScript plus Python PDF parsers) and decodes everything into canonical, bank-agnostic
  payloads. It never opens the database.
- **Contracts** (`server/contracts/`): the one package both sides share — a typed envelope and a
  registry of versioned kinds (`card.statement`, `bank_account.movements`, `broker.notifications`,
  …), validated before any handler runs.
- **Server** (`server/`): the only database writer. `POST /api/ingest/<kind>` applies a payload
  idempotently (a repeat is a `duplicate`, a disagreement a `conflict`); a scheduler queues the
  nightly run and hourly polls as jobs that wait for one another instead of overlapping; every
  import is reconciled against the source's own totals and balances, and a mismatch fails loudly
  or raises a notification rather than being papered over.
- **Client** (`client/`): shows what the server computed; it never re-sums or re-derives a figure.

## Stack

- **Monorepo** — npm workspaces (`server`, `client`, `ingest`, `server/contracts`), Node 24,
  TypeScript throughout; Python for the PDF parsers.
- **Server** — Express + better-sqlite3 (SQLite), synchronous migrations.
- **Client** — React + Vite, TanStack Query, Recharts, react-aria-components, i18next
  (English and Spanish).
- **Ingest** — Playwright (bank sessions), IMAP (mail), poppler / qpdf (PDFs).

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
