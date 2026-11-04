import { describe, expect, it } from "vitest";
import { decodeYahooPricingData, decodeYahooStreamFrame } from "./yahooPricingData.js";

/** Minimal protobuf writer for synthetic frames in the stream's wire layout. */
function varint(v: bigint): number[] {
  const out: number[] = [];
  let x = v;
  do {
    let b = Number(x & 0x7fn);
    x >>= 7n;
    if (x > 0n) b |= 0x80;
    out.push(b);
  } while (x > 0n);
  return out;
}
const zz = (v: bigint) => (v << 1n) ^ (v >> 63n);
const key = (field: number, wire: number) => varint(BigInt((field << 3) | wire));
const str = (field: number, s: string) => {
  const b = Buffer.from(s, "utf8");
  return [...key(field, 2), ...varint(BigInt(b.length)), ...b];
};
const f32 = (field: number, v: number) => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(v);
  return [...key(field, 5), ...b];
};
const f64 = (field: number, v: number) => {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(v);
  return [...key(field, 1), ...b];
};
const sint = (field: number, v: bigint) => [...key(field, 0), ...varint(zz(v))];
const enumField = (field: number, v: number) => [...key(field, 0), ...varint(BigInt(v))];

const T = 1_793_810_819_000n; // 2026-11-04T16:46:59Z

function frame(bytes: number[]): string {
  return JSON.stringify({ type: "pricing", message: Buffer.from(bytes).toString("base64") });
}

describe("decodeYahooPricingData", () => {
  it("reads an equity in its regular session, rounded to its price hint", () => {
    const tick = decodeYahooPricingData(
      Buffer.from([
        ...str(1, "SPY"),
        ...f32(2, 767.49),
        ...sint(3, T),
        ...str(5, "PCX"),
        ...enumField(6, 20),
        ...enumField(7, 1),
        ...f32(8, 1.7419),
        ...sint(9, 26_026_483n),
        ...f32(12, 13.14),
        ...sint(27, 2n),
      ])
    );
    expect(tick).toEqual({
      symbol: "SPY",
      price: 767.49,
      timeMs: Number(T),
      marketHours: "regular",
      previousClose: 754.35,
    });
  });

  it("keeps four decimals for fx and a negative change", () => {
    const tick = decodeYahooPricingData(
      Buffer.from([...str(1, "CLP=X"), ...f32(2, 967.32), ...sint(3, T), ...enumField(7, 1), ...f32(12, -13.27), ...sint(27, 4n)])
    );
    expect(tick.price).toBe(967.32);
    expect(tick.previousClose).toBe(980.59);
  });

  it("reads a missing market-hours field as pre-market (the protobuf default)", () => {
    const tick = decodeYahooPricingData(Buffer.from([...str(1, "vea"), ...f32(2, 70.73), ...sint(3, T)]));
    expect(tick.symbol).toBe("VEA");
    expect(tick.marketHours).toBe("pre");
    expect(tick.previousClose).toBeNull();
  });

  it("reads post-market frames as such", () => {
    const tick = decodeYahooPricingData(
      Buffer.from([...str(1, "SPY"), ...f32(2, 767), ...sint(3, T), ...enumField(7, 2), ...sint(27, 2n)])
    );
    expect(tick.marketHours).toBe("post");
  });

  it("skips unknown fields of every wire type", () => {
    const tick = decodeYahooPricingData(
      Buffer.from([
        ...str(30, "BTC"),
        ...f64(32, 122_189_136),
        ...sint(28, 15_663_305_728n),
        ...f32(46, 139.93),
        ...str(1, "BTC-USD"),
        ...f32(2, 80_563.12),
        ...sint(3, T),
        ...enumField(7, 1),
        ...sint(27, 2n),
      ])
    );
    expect(tick.symbol).toBe("BTC-USD");
    expect(tick.price).toBe(80_563.12);
  });

  it("throws on a frame without symbol, price or time", () => {
    expect(() => decodeYahooPricingData(Buffer.from([...f32(2, 1), ...sint(3, T)]))).toThrow(/symbol/);
    expect(() => decodeYahooPricingData(Buffer.from([...str(1, "SPY"), ...sint(3, T)]))).toThrow(/price/);
    expect(() => decodeYahooPricingData(Buffer.from([...str(1, "SPY"), ...f32(2, 1)]))).toThrow(/time/);
  });

  it("throws on a truncated frame", () => {
    const bytes = [...str(1, "SPY"), ...f32(2, 767.49)];
    expect(() => decodeYahooPricingData(Buffer.from(bytes.slice(0, -2)))).toThrow(/past the end/);
  });
});

describe("decodeYahooStreamFrame", () => {
  it("decodes pricing frames and ignores frames without prices", () => {
    expect(decodeYahooStreamFrame(frame([...str(1, "SPY"), ...f32(2, 1), ...sint(3, T)]))?.symbol).toBe("SPY");
    expect(decodeYahooStreamFrame(JSON.stringify({ type: "heartbeat" }))).toBeNull();
  });
});
