import { z } from "zod";

/**
 * Raw documents the user uploads in the app (docs/ingest-split-plan.md, Phase 3): the server never
 * reads a bank's own format, so it forwards the file to the feeder, which answers with the
 * payload of an ingest kind; the server then applies it like any other.
 *
 *   server → feeder  POST <feeder>/parse/<format>   FeederParseRequest → FeederParseResult | 422
 */
export const FEEDER_PARSE_PATH = "/parse";

/**
 * The upload formats the feeder reads. `santander.checking_xlsx`: the «últimos movimientos»
 * workbook; `card_statement.pdf`: a credit-card statement PDF (any issuer the parser reads), read
 * as `card.parsed_statements`.
 */
export const FEEDER_PARSE_FORMATS = ["santander.checking_xlsx", "card_statement.pdf"] as const;
export type FeederParseFormat = (typeof FEEDER_PARSE_FORMATS)[number];

export const feederParseRequestSchema = z
  .object({
    filename: z.string().min(1).max(512),
    content_base64: z.string().min(1),
  })
  .strict();

export type FeederParseRequest = z.infer<typeof feederParseRequestSchema>;

/** The payload of `kind` (checked by the server against that kind's schema before applying). */
export const feederParseResultSchema = z
  .object({ kind: z.string().min(1), schema_version: z.number().int().positive(), payload: z.unknown() })
  .strict();

export type FeederParseResult = z.infer<typeof feederParseResultSchema>;

/**
 * 422 body. `not_this_format`: the file is not what the format reads (the server may try
 * another path it owns); `unreadable`: it is, but it does not decode.
 */
export const feederParseErrorSchema = z
  .object({ error: z.enum(["not_this_format", "unreadable"]), message: z.string() })
  .strict();

export type FeederParseError = z.infer<typeof feederParseErrorSchema>;
