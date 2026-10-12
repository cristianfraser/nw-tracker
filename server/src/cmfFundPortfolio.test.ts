import { describe, expect, it } from "vitest";
import { cmfBasketForFund, cmfPeriodEndIso, parseCmfForeignPortfolio } from "./cmfFundPortfolio.js";

const HEADER =
  "Run Fondo;Nombre Fondo;FFM_6020100;FFM_6020200;FFM_6020300;FFM_6020400;FFM_6020500;FFM_6020600;FFM_6020700;FFM_6020800;FFM_6020900;FFM_6021000;FFM_tir_6021111;FFM_par_6021111;FFM_rel_6021111;FFM_6021112;FFM_6021113;FFM_6021114;FFM_6021200;FFM_6021300;FFM_6021400;FFM_6021511;FFM_6021512;FFM_6021513";
const ROWS = [
  "1234;FIXTUREFUND;FTEC US;Fidelity;US;ETFA;;1;NA;NA;421200;PROM;;;200170.11;3;0;NA;84311650;PROM;US;.581;.572;17.638",
  "1234;FIXTUREFUND;SPXS LN;Invesco;IE;ETFA;;1;NA;NA;2000;PROM;;;15000;3;0;NA;30000;PROM;US;.1;.1;7.419",
  "1234;FIXTUREFUND;SPXS US;Invesco;US;ETFA;;1;NA;NA;NA;PROM;;;15000;3;0;NA;30000;PROM;US;.1;.1;0.581",
  "5678;OTHERFUND;EIMI LN;Ishares Core Msci Em Imi Ucits;IE;ETFA;;1;NA;NA;13140;PROM;;;39306.2;3;0;NA;516483;PROM;US;.002;.002;8.479",
];
const FILE = [HEADER, ...ROWS, ""].join("\r\n");

describe("parseCmfForeignPortfolio", () => {
  it("reads ticker, market, issuer, quantity and the share of assets; narrows to one fund", () => {
    const all = parseCmfForeignPortfolio(FILE);
    expect(all).toHaveLength(4);
    const fund = parseCmfForeignPortfolio(FILE, 1234);
    expect(fund.map((h) => [h.ticker, h.market, h.issuer, h.quantity])).toEqual([
      ["FTEC", "US", "Fidelity", 421200],
      ["SPXS", "LN", "Invesco", 2000],
      ["SPXS", "US", "Invesco", null],
    ]);
    expect(fund.map((h) => h.share_of_assets)).toEqual([
      expect.closeTo(0.17638, 10),
      expect.closeTo(0.07419, 10),
      expect.closeTo(0.00581, 10),
    ]);
    expect(fund[0].fund_name).toBe("FIXTUREFUND");
  });

  it("throws on a foreign header or a short row", () => {
    expect(() => parseCmfForeignPortfolio("Fondo;Algo\n1;2")).toThrow(/unexpected header/);
    expect(() => parseCmfForeignPortfolio([HEADER, "1234;X;FTEC US;Fidelity"].join("\n"))).toThrow(/4 columns/);
    expect(() => parseCmfForeignPortfolio([HEADER, ROWS[0].replace(/17\.638$/, "abc")].join("\n"))).toThrow(
      /share of assets/
    );
  });
});

describe("cmfBasketForFund", () => {
  it("normalizes the fund's foreign sleeve to 1 and merges one ticker's rows", () => {
    const basket = cmfBasketForFund(parseCmfForeignPortfolio(FILE), 1234);
    expect(basket.etf_weight_sum).toBeCloseTo(0.25638, 10);
    expect(basket.holdings.map((h) => h.ticker)).toEqual(["FTEC", "SPXS"]);
    expect(basket.holdings[0].weight).toBeCloseTo(0.17638 / 0.25638, 10);
    expect(basket.holdings[1].weight).toBeCloseTo(0.08 / 0.25638, 10);
    expect(basket.holdings.reduce((a, h) => a + h.weight, 0)).toBeCloseTo(1, 10);
    expect(() => cmfBasketForFund(parseCmfForeignPortfolio(FILE), 9999)).toThrow(/no foreign holdings/);
  });
});

describe("cmfPeriodEndIso", () => {
  it("gives the month's last day", () => {
    expect(cmfPeriodEndIso("202602")).toBe("2026-02-28");
    expect(cmfPeriodEndIso("202402")).toBe("2024-02-29");
    expect(cmfPeriodEndIso("202512")).toBe("2025-12-31");
    expect(() => cmfPeriodEndIso("2025-12")).toThrow(/YYYYMM/);
    expect(() => cmfPeriodEndIso("202513")).toThrow(/month 13/);
  });
});
