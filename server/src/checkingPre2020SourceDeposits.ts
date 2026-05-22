import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import { movementCountsAsPersonalDeposit, movementIsStateContribution } from "./depositFlowKind.js";
import {
  PRE2020_SYNTHETIC_FIRST_MONTH,
  PRE2020_SYNTHETIC_LAST_MONTH,
} from "./checkingPre2020ExcelBalances.js";
import { monthEndUtcYmd } from "./calendarMonth.js";

export type Pre2020SourceDeposit = {
  movement_id: number;
  account_id: number;
  category_slug: string;
  occurred_on: string;
  amount_clp: number;
  note: string | null;
};

const RANGE_START = `${PRE2020_SYNTHETIC_FIRST_MONTH}-01`;
const RANGE_END = monthEndUtcYmd(PRE2020_SYNTHETIC_LAST_MONTH);

const SOURCE_SLUGS = [
  "bitcoin",
  "eth",
  "fintual_risky_norris",
  "cuenta_ahorro_vivienda",
  "apv_a",
  "apv_b",
  "apv_a_principal",
  "fondo_reserva",
] as const;

function isAhorroPropiosDeposit(note: string | null): boolean {
  return note != null && note.includes("ahorro-vivienda|Depósitos");
}

function isCryptoDeposit(slug: string, note: string | null, amount_clp: number): boolean {
  if (amount_clp <= 0) return false;
  if (slug !== "bitcoin" && slug !== "eth") return false;
  if (note?.includes("cripto-coin-only-wdw")) return false;
  return true;
}

function countsAsSourceDeposit(row: {
  category_slug: string;
  amount_clp: number;
  note: string | null;
  flow_kind: string | null;
}): boolean {
  const slug = row.category_slug;
  if (slug === "cuenta_corriente") return false;
  if (row.flow_kind === "compra_usd" || row.flow_kind === "dividend_usd") return false;

  if (slug === "cuenta_ahorro_vivienda") {
    return isAhorroPropiosDeposit(row.note);
  }
  if (slug === "bitcoin" || slug === "eth") {
    return isCryptoDeposit(slug, row.note, row.amount_clp);
  }
  if (
    slug === "fintual_risky_norris" ||
    slug === "apv_a" ||
    slug === "apv_b" ||
    slug === "apv_a_principal" ||
    slug === "fondo_reserva"
  ) {
    if (row.amount_clp <= 0) return false;
    if (movementIsStateContribution(row.note)) return false;
    return movementCountsAsPersonalDeposit(row.note);
  }
  return false;
}

export function listPre2020SourceDeposits(dbHandle: Database = db): Pre2020SourceDeposit[] {
  const ph = SOURCE_SLUGS.map(() => "?").join(",");
  const rows = dbHandle
    .prepare(
      `SELECT m.id AS movement_id, m.account_id, c.slug AS category_slug,
              m.occurred_on, m.amount_clp, m.note, m.flow_kind
       FROM movements m
       JOIN accounts a ON a.id = m.account_id
       JOIN categories c ON c.id = a.category_id
       WHERE c.slug IN (${ph})
         AND m.occurred_on >= ?
         AND m.occurred_on <= ?
       ORDER BY m.occurred_on, m.id`
    )
    .all(...SOURCE_SLUGS, RANGE_START, RANGE_END) as Pre2020SourceDeposit & {
    flow_kind: string | null;
  }[];

  const out: Pre2020SourceDeposit[] = [];
  for (const r of rows) {
    if (!countsAsSourceDeposit(r)) continue;
    out.push({
      movement_id: r.movement_id,
      account_id: r.account_id,
      category_slug: r.category_slug,
      occurred_on: r.occurred_on,
      amount_clp: r.amount_clp,
      note: r.note,
    });
  }
  return out;
}
