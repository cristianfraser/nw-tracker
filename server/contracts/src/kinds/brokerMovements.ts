import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";

/**
 * One dividend as the broker's own record states it: gross, the tax withheld at source, and the
 * net the account was credited (gross − withholding = net, to the cent).
 */
export const brokerDividendSchema = z
  .object({
    /** The broker's id for the dividend event. */
    id: z.string().min(1).max(256),
    /** The paying instrument's symbol. */
    asset_id: z.string().regex(/^[A-Z][A-Z0-9.]{0,9}$/),
    gross: z.number().nonnegative(),
    /** Positive: what was withheld. */
    withholding: z.number().nonnegative(),
    net: z.number(),
    /** When the net was credited. */
    execution_date: z.iso.datetime({ offset: true }),
    /** Interest and rebate entries share the record; they are not dividends. */
    is_interest: z.boolean(),
  })
  .strict()
  .refine((d) => Math.abs(d.gross - d.withholding - d.net) <= 0.015, {
    message: "gross − withholding must be the net",
  });

export type BrokerDividend = z.infer<typeof brokerDividendSchema>;

/** One movement as the broker's movement list shows it. */
export const brokerMovementSchema = z
  .object({
    /** The broker's id for the movement, or a stand-in (`<day>|<kind>|<amount>`) for a row whose id was never read. Provenance only. */
    movement_id: z.string().min(1).max(256),
    kind: z.enum(["deposit", "withdrawal", "buy", "sell", "dividend", "interest", "fee", "corporate_action"]),
    /** The instrument, for trades and dividends; null for cash, or when the list never named it. */
    ticker: z.string().regex(/^[A-Z][A-Z0-9.]{0,9}$/).nullable(),
    occurred_on: z.iso.date(),
    /** With the time when the broker's id carries one, else midnight of `occurred_on`. */
    occurred_at: z.iso.datetime({ offset: true }),
    /** As listed; the server signs single-leg rows by kind. */
    amount: z.number(),
    currency: z.enum(["clp", "usd"]),
    /** Shares, as a decimal string (counts run to 8 decimals). */
    units: z.string().regex(/^\d+(?:\.\d+)?$/).nullable(),
    price: z.number().positive().nullable(),
    commission: z.number().nonnegative().nullable(),
    order_id: z.string().min(1).max(64).nullable(),
    /** The list's own label («Compra SLV», «Dividendo»), kept as the movement's note. */
    title: z.string().min(1).max(200),
    /** The broker's dividend record for this row, when the feeder matched one. */
    dividend: brokerDividendSchema.nullable(),
    /**
     * Why the movement cannot be written as listed (a trade whose share count or instrument was
     * never read, a dividend without its paying instrument), or null. The server first looks for
     * it in the ledger: only one it would have to write blocks the read.
     */
    incomplete: z.string().min(1).max(500).nullable(),
  })
  .strict();

export type BrokerMovement = z.infer<typeof brokerMovementSchema>;

/**
 * One read of a broker's movement list (newest first, as the broker lists them) and of its
 * dividends record, as of `read_at`. `movements: null` when the list was not read this time (only
 * the dividends record was); `dividends: null` when the record was not. A read the server applies
 * with nothing left to fix covers the broker's notifications sent before it.
 */
export const brokerMovementsKind = defineIngestKind({
  kind: "broker.movements",
  schema_version: 1,
  description: "One read of a broker's movement list and dividends record.",
  payload: z
    .object({
      broker: z.enum(["racional"]),
      apply: z.boolean(),
      read_at: z.iso.datetime({ offset: true }),
      movements: z.array(brokerMovementSchema).nullable(),
      dividends: z.array(brokerDividendSchema).nullable(),
    })
    .strict()
    .refine((p) => p.movements != null || p.dividends != null, { message: "a read carries movements, dividends or both" }),
});

export type BrokerMovementsPayload = z.infer<typeof brokerMovementsKind.payload>;

/** `details` of an applied `broker.movements`. */
export type BrokerMovementsApplyDetails = {
  applied: boolean;
  movements: {
    occurred_on: string;
    kind: BrokerMovement["kind"];
    amount: number;
    currency: "clp" | "usd";
    legs: string;
    units: string | null;
    /** new | duplicate | manual | conflict | blocked */
    state: string;
    detail: string | null;
  }[];
  /** True when a listed movement that must be written cannot be: nothing from the list was written. */
  movements_blocked: boolean;
  inserted: number;
  duplicates: number;
  dividends: {
    chile_ymd: string;
    asset_id: string;
    gross: number;
    withholding: number;
    net: number;
    /** recorded | new | skipped | conflict */
    state: string;
    movement_id: number | null;
    detail: string | null;
  }[];
  /** Dividend breakdowns written or changed. */
  breakdowns_written: number;
  /** Data errors that fail the step: blocked rows, ledger disagreements, an unmapped movement. */
  problems: string[];
  /** The read applied with nothing to fix (no problem, and the list was read). */
  clean: boolean;
  /** Notifications sent before this instant are answered by a read (the server's coverage after this one). */
  clean_through: string | null;
};
