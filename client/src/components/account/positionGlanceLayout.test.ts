import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDecimalSeparatorForFormatting } from "../../format";
import {
  directionArrow,
  formatSignedMoney,
  formatSignedPct,
  periodBarBox,
  priceTone,
  sparklinePoints,
  centredLabelLeft,
  fundSeriesLabel,
} from "./positionGlanceLayout";

beforeEach(() => setDecimalSeparatorForFormatting("comma"));
afterEach(() => setDecimalSeparatorForFormatting("comma"));

describe("glance figures with their sign", () => {
  it("puts the sign before the symbol, never accounting parentheses", () => {
    expect(formatSignedMoney({ value: 51200, currency: "clp" })).toBe("+$51.200");
    expect(formatSignedMoney({ value: -1200, currency: "clp" })).toBe("−$1.200");
  });

  it("prints a fraction as a signed percent", () => {
    expect(formatSignedPct(0.0207)).toBe("+2,07%");
    expect(formatSignedPct(-0.0531, 1)).toBe("−5,3%");
    expect(formatSignedPct(0)).toBe("0,00%");
  });

  it("draws an arrow only for a move", () => {
    expect(directionArrow("up")).toBe("▲");
    expect(directionArrow("down", true)).toBe("▾");
    expect(directionArrow("flat")).toBe("");
  });
});

describe("glance layout from the server's shares", () => {
  it("grows a period bar from the centre on its side, half the track at most", () => {
    expect(periodBarBox({ share: 1, direction: "down" })).toEqual({ left: "0%", width: "50%" });
    expect(periodBarBox({ share: 0.5, direction: "up" })).toEqual({ left: "50%", width: "25%" });
    expect(periodBarBox({ share: 0, direction: "flat" })).toBeNull();
  });

  it("centres a track label on its tick, inside the track", () => {
    expect(centredLabelLeft(0.5, 400, 60)).toBe(170);
    expect(centredLabelLeft(0.02, 400, 60)).toBe(0);
    expect(centredLabelLeft(0.98, 400, 60)).toBe(340);
    expect(centredLabelLeft(0.5, 40, 60)).toBe(0);
  });

  it("colours the price by the server's side of the cost", () => {
    expect(priceTone("above")).toBe("positive");
    expect(priceTone("below")).toBe("negative");
    expect(priceTone("equal")).toBe("neutral");
  });

  it("places the sparkline by the server's day and price positions, height 1 at the top", () => {
    expect(sparklinePoints([{ x: 0.4, y: 0 }, { x: 0.7, y: 0.5 }, { x: 1, y: 1 }], 100, 50)).toBe("40.0,50.0 70.0,25.0 100.0,0.0");
    expect(sparklinePoints([], 100, 50)).toBe("");
  });
});

describe("a fund series on the sub-line", () => {
  const t = (key: string, o?: Record<string, string>) => (o ? `${key}|${JSON.stringify(o)}` : key);

  it("words an AFP fund by its manager's name and letter", () => {
    expect(fundSeriesLabel({ kind: "afp", series_key: "afp_uno_cuota_a", manager: "uno", fund: "A" }, t)).toBe(
      'accountDetail.positionGlance.fundSeries.afp|{"fund":"A","manager":"accountDetail.positionGlance.fundSeries.afpManager.uno"}'
    );
  });

  it("throws on an AFP manager it has no name for", () => {
    expect(() => fundSeriesLabel({ kind: "afp", series_key: "afp_x_cuota_a", manager: "x", fund: "A" }, t)).toThrow(/x/);
  });

  it("keeps a Fintual fund's own name and an unknown series' key", () => {
    expect(fundSeriesLabel({ kind: "fintual", series_key: "k", name: "Risky Norris" }, t)).toBe("Risky Norris");
    expect(fundSeriesLabel({ kind: "other", series_key: "hsa_fund" }, t)).toBe("hsa_fund");
  });
});
