/**
 * Yahoo's price stream frames (`wss://streamer.finance.yahoo.com/?version=2`, 2026-11-04).
 *
 * Each frame is `{"type":"pricing","message":"<base64 protobuf PricingData>"}`; the schema is
 * not published, so only the fields the app reads are decoded and every other field is skipped
 * by its wire type (frames carried fields up to 47 in the first probe). Checked against the
 * stream that day: SPY, VEA, SLV, BTC-USD, ETH-USD, CLP=X and CFIETFIPSA.SN.
 *
 * | field | meaning       | encoding                                                   |
 * |-------|---------------|------------------------------------------------------------|
 * | 1     | id (symbol)   | string                                                     |
 * | 2     | price         | float32                                                    |
 * | 3     | time          | sint64, epoch ms (zigzag)                                  |
 * | 7     | marketHours   | enum, plain varint: 0 pre, 1 regular, 2 post, 3 extended   |
 * | 12    | change        | float32, vs the previous close                             |
 * | 27    | priceHint     | sint64 (zigzag), decimals the price is quoted in           |
 *
 * The enums (6 quote type, 7 market hours) are plain varints — read as zigzag they come out
 * negative. The price is a float32 (SPY 767.49 arrives as 767.48999…), so it is rounded to its
 * `priceHint`; the stream sends no previous close for equities, so it is `price − change`.
 */

export type YahooMarketHours = "pre" | "regular" | "post" | "extended";

export type YahooPricingTick = {
  symbol: string;
  price: number;
  timeMs: number;
  marketHours: YahooMarketHours;
  /** `price − change`, rounded like the price; null when the frame carries no change. */
  previousClose: number | null;
};

const MARKET_HOURS: Record<number, YahooMarketHours> = {
  0: "pre",
  1: "regular",
  2: "post",
  3: "extended",
};

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

type RawFields = {
  id?: string;
  price?: number;
  time?: bigint;
  marketHours?: number;
  change?: number;
  priceHint?: bigint;
};

function zigzag(v: bigint): bigint {
  return (v >> 1n) ^ -(v & 1n);
}

function readFields(buf: Buffer): RawFields {
  let i = 0;
  const readVarint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (i >= buf.length) throw new Error("PricingData: varint runs past the end");
      const b = buf[i++]!;
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 63n) throw new Error("PricingData: varint longer than 64 bits");
    }
  };
  const need = (n: number) => {
    if (i + n > buf.length) throw new Error("PricingData: field runs past the end");
  };
  const out: RawFields = {};
  while (i < buf.length) {
    const key = Number(readVarint());
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === WIRE_VARINT) {
      const v = readVarint();
      if (field === 3) out.time = zigzag(v);
      else if (field === 7) out.marketHours = Number(v);
      else if (field === 27) out.priceHint = zigzag(v);
    } else if (wire === WIRE_FIXED32) {
      need(4);
      const v = buf.readFloatLE(i);
      i += 4;
      if (field === 2) out.price = v;
      else if (field === 12) out.change = v;
    } else if (wire === WIRE_FIXED64) {
      need(8);
      i += 8;
    } else if (wire === WIRE_LENGTH_DELIMITED) {
      const len = Number(readVarint());
      need(len);
      if (field === 1) out.id = buf.toString("utf8", i, i + len);
      i += len;
    } else {
      throw new Error(`PricingData: unsupported wire type ${wire} (field ${field})`);
    }
  }
  return out;
}

function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/** Decodes the protobuf payload of one frame. Throws when id, price or time is missing. */
export function decodeYahooPricingData(buf: Buffer): YahooPricingTick {
  const f = readFields(buf);
  if (!f.id) throw new Error("PricingData: frame without a symbol");
  if (f.price == null || !Number.isFinite(f.price) || f.price <= 0) {
    throw new Error(`PricingData: ${f.id} has no price`);
  }
  if (f.time == null) throw new Error(`PricingData: ${f.id} has no time`);
  // Yahoo quotes stocks in 2 decimals and fx in 4 (`priceHint`); without one, 6 keeps a float32's
  // significant digits for any price the app holds.
  const hint = f.priceHint != null ? Number(f.priceHint) : 6;
  if (!Number.isInteger(hint) || hint < 0 || hint > 8) {
    throw new Error(`PricingData: ${f.id} has priceHint ${f.priceHint}`);
  }
  const price = roundTo(f.price, hint);
  const previousClose =
    f.change != null && Number.isFinite(f.change) ? roundTo(f.price - f.change, hint) : null;
  return {
    symbol: f.id.toUpperCase(),
    price,
    timeMs: Number(f.time),
    marketHours: MARKET_HOURS[f.marketHours ?? 0] ?? "extended",
    previousClose: previousClose != null && previousClose > 0 ? previousClose : null,
  };
}

/**
 * Decodes one text frame of the stream. Returns null for a frame that carries no prices (the
 * stream's own messages); throws on a pricing frame the app cannot read.
 */
export function decodeYahooStreamFrame(text: string): YahooPricingTick | null {
  const parsed = JSON.parse(text) as { type?: unknown; message?: unknown };
  if (typeof parsed.message !== "string") return null;
  if (parsed.type != null && parsed.type !== "pricing") return null;
  return decodeYahooPricingData(Buffer.from(parsed.message, "base64"));
}
