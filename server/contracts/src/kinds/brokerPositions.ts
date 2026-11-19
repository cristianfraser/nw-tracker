import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";

/**
 * What a broker states the account holds right now: each line's symbol, the name the broker gives
 * it and the shares. The server keeps the broker's name → symbol pairs (`broker_instruments`), so a
 * notification that names only the company («… acciones de Anthropic PBC») resolves to the symbol
 * the broker itself uses, and registers a symbol the app has never priced before the buy books.
 * Broker-neutral: a feeder for any broker sends the same shape.
 */
export const brokerPositionsKind = defineIngestKind({
  kind: "broker.positions",
  schema_version: 1,
  description: "A broker's current positions: symbol, the broker's name for it, shares.",
  ref: "read",
  payload: z
    .object({
      broker: z.enum(["fintual", "racional"]),
      read_at: z.iso.datetime({ offset: true }),
      positions: z
        .array(
          z
            .object({
              /** The symbol as the broker prints it (a US line's ticker). */
              symbol: z.string().regex(/^[A-Z0-9][A-Z0-9.\-]{0,14}$/),
              name: z.string().min(1).max(200),
              /** Decimal string, as the broker states it. */
              shares: z.string().regex(/^\d+(\.\d+)?$/),
            })
            .strict()
        )
        .max(500)
        .refine((ps) => new Set(ps.map((p) => p.symbol)).size === ps.length, { message: "a symbol is listed twice" }),
    })
    .strict(),
});

export type BrokerPositionsPayload = z.infer<typeof brokerPositionsKind.payload>;

/** `details` of an applied `broker.positions`. */
export type BrokerPositionsApplyDetails = {
  broker: "fintual" | "racional";
  positions: number;
  /** Symbols this broker had never stated before this read. */
  new_symbols: string[];
  /** Symbols registered in the instrument registry before the write (none on a dry run). */
  registered: string[];
  /** Symbols the price provider could not describe: a buy of them stays for a person. */
  unregistered: { symbol: string; error: string }[];
};
