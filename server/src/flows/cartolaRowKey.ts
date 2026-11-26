import type { Database as DatabaseType } from "better-sqlite3";
import { isHomeCurrency } from "nw-tracker-contracts/dto/apiConstants";

/**
 * A cartola row's identity, as its purchase key (`checking-cartola:<account>:<month>:<day>:<amount>:<position>`)
 * spells it, from the row's evidence (migrations 371, 373) — never its note: the cartola month
 * (`stated_period`), the day the cartola listed it (`stated_on`), its position in the cartola
 * (`stated_position`) and the bank's signed amount in minor units of the row's currency (a peso row
 * stores it signed; a foreign row unsigned, its direction in its flow kind). Read by the key builder
 * (`bankRowFacts.ts`) and the key resolver (`flowKeyResolve.ts`) alike, so a row's key and the key
 * its flow answers to are one. Pure but for the currencies table (the handle is given: the resolver
 * runs inside migration hooks).
 */
export type CartolaKeyRow = {
  account_id: number | null;
  amount: number;
  currency: string;
  flow_kind: string | null;
  stated_period: string | null;
  stated_on: string | null;
  stated_position: number | null;
};

export type CartolaKeyParts = { accountId: number; periodMonth: string; occurredOn: string; amountMinor: number; cartolaIndex: number };

/** The row's key parts; null when its evidence states no cartola identity (it is keyed by its id). */
export function cartolaKeyParts(row: CartolaKeyRow, minorDigits: (currency: string) => number): CartolaKeyParts | null {
  if (row.account_id == null || row.stated_period == null || row.stated_on == null || row.stated_position == null) return null;
  const outgoing = !isHomeCurrency(row.currency) && (row.flow_kind === "withdrawal" || row.flow_kind === "cash_fee");
  const signed = outgoing ? -Math.abs(row.amount) : row.amount;
  return {
    accountId: row.account_id,
    periodMonth: row.stated_period,
    occurredOn: row.stated_on,
    amountMinor: Math.round(signed * 10 ** minorDigits(row.currency)),
    cartolaIndex: row.stated_position,
  };
}

/** `minorDigits` read from the currencies table through `dbi`. */
export function minorDigitsReader(dbi: DatabaseType): (currency: string) => number {
  const cache = new Map<string, number>();
  const sel = dbi.prepare(`SELECT minor_digits FROM currencies WHERE code = ?`);
  return (currency) => {
    let d = cache.get(currency);
    if (d == null) {
      const r = sel.get(currency) as { minor_digits: number } | undefined;
      if (!r) throw new Error(`cartola key: ${JSON.stringify(currency)} is not in currencies`);
      d = r.minor_digits;
      cache.set(currency, d);
    }
    return d;
  };
}

/** The SQL selecting a movement's {@link CartolaKeyRow} (movement alias `m`, its evidence `e`). */
export const CARTOLA_KEY_COLUMNS_SQL = `m.account_id, m.amount, m.currency, m.flow_kind, e.stated_period, e.stated_on, e.stated_position`;
