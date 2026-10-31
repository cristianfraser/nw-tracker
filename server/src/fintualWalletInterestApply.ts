/**
 * Fintual's dollar wallet pays cash interest («Ganancia dólares», Alpaca's sweep profit sharing)
 * once a month, and no mail announces it: the monthly Alpaca cartola prints it ~10 days later,
 * the activity feed the same evening. Ingest reads the feed (`broker.movements`, broker
 * `fintual`) and this books each credit the ledger lacks as a single-leg `savings_earnings` on
 * Fintual USD, dated on Fintual's own day, so the money is P/L of the account, never capital.
 *
 * Identity is the ledger's shape, not the feed's id: a `savings_earnings` row on Fintual USD on
 * that day for the same dollars (to the cent) is the credit, however it was entered. A different
 * amount on that day is a disagreement to look at, never overwritten.
 */
import type { BrokerMovementsApplyDetails, BrokerMovementsPayload } from "nw-tracker-contracts";
import { db } from "./db.js";
import { SAVINGS_EARNINGS_FLOW_KIND } from "./cashAccountInterest.js";
import { MOVEMENT_USD_LEG_SQL } from "./movementAmounts.js";

const FINTUAL_USD_IMPORT_KEY = "import:panel|kind=usd|key=fintual_usd";

function fintualUsdAccountId(): number {
  const row = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(FINTUAL_USD_IMPORT_KEY) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`No account with import_key "${FINTUAL_USD_IMPORT_KEY}"`);
  return row.id;
}

const cents = (usd: number): number => Math.round(usd * 100);

export function applyFintualWalletRead(payload: BrokerMovementsPayload): BrokerMovementsApplyDetails {
  if (payload.broker !== "fintual") throw new Error(`applyFintualWalletRead: broker ${payload.broker}`);
  const problems: string[] = [];
  const out: BrokerMovementsApplyDetails = {
    applied: payload.apply,
    movements: [],
    movements_blocked: false,
    inserted: 0,
    duplicates: 0,
    dividends: [],
    breakdowns_written: 0,
    problems,
    clean: false,
    clean_through: null,
  };
  const accountId = fintualUsdAccountId();
  const sameDay = db.prepare(
    `SELECT id, ${MOVEMENT_USD_LEG_SQL} AS usd FROM movements
     WHERE account_id = ? AND flow_kind = ? AND occurred_on = ? AND currency = 'usd'`
  );
  const insert = db.prepare(
    `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind)
     VALUES (?, ?, 'usd', ?, ?, ?)`
  );

  const toWrite: { occurred_on: string; amount: number; note: string }[] = [];
  for (const m of payload.movements ?? []) {
    if (m.kind !== "interest" || m.currency !== "usd" || !(m.amount > 0)) {
      throw new Error(`Fintual wallet movement ${m.movement_id}: expected positive usd interest, got ${m.kind} ${m.amount} ${m.currency}`);
    }
    const rows = sameDay.all(accountId, SAVINGS_EARNINGS_FLOW_KIND, m.occurred_on) as { id: number; usd: number }[];
    const legs = `→ ${accountId}`;
    const row = { occurred_on: m.occurred_on, kind: m.kind, amount: m.amount, currency: m.currency, legs, units: null };
    const match = rows.find((r) => cents(Math.abs(r.usd)) === cents(m.amount));
    if (match) {
      out.duplicates += 1;
      out.movements.push({ ...row, state: "duplicate", detail: `movement ${match.id}` });
    } else if (rows.length > 0) {
      const detail = `the ledger has interest of ${rows.map((r) => Math.abs(r.usd).toFixed(2)).join(", ")} usd that day (movement ${rows.map((r) => r.id).join(", ")})`;
      out.movements.push({ ...row, state: "conflict", detail });
      problems.push(`${m.occurred_on} interest ${m.amount.toFixed(2)} usd — ${detail}`);
    } else {
      out.movements.push({ ...row, state: "new", detail: null });
      toWrite.push({ occurred_on: m.occurred_on, amount: m.amount, note: `${m.title} — import:fintual-wallet|${m.movement_id}` });
    }
  }

  if (payload.apply && toWrite.length > 0) {
    db.transaction(() => {
      for (const w of toWrite) insert.run(accountId, w.amount, w.occurred_on, w.note, SAVINGS_EARNINGS_FLOW_KIND);
    })();
    out.inserted = toWrite.length;
  }
  out.clean = problems.length === 0;
  return out;
}
