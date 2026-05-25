import { describe, expect, it } from "vitest";
import {
  isInstallmentContractSummaryMerchant,
  isUnindexedInstallmentResumenLine,
  merchantStemForInstallmentDedupe,
  redundantInstallmentSummaryLineIds,
} from "./ccInstallmentLineDedupe.js";

describe("isInstallmentContractSummaryMerchant", () => {
  it("detects N/CUOTAS PRECIO and TRES CUOTAS PREC rows", () => {
    expect(
      isInstallmentContractSummaryMerchant(
        "VISTA LIBRE N/CUOTAS PRECIO 0,00 % $ 1.654.183"
      )
    ).toBe(true);
    expect(
      isInstallmentContractSummaryMerchant("8 BITS TRES CUOTAS PREC 0,00 %")
    ).toBe(true);
    expect(isInstallmentContractSummaryMerchant("VISTA LIBRE")).toBe(false);
    expect(
      isInstallmentContractSummaryMerchant(
        "PARIS INTERNET TCOM 2 03 CUOTAS, TASA 3,01 %"
      )
    ).toBe(true);
  });
});

describe("isUnindexedInstallmentResumenLine", () => {
  it("detects TCOM resumen rows without cuota index", () => {
    expect(
      isUnindexedInstallmentResumenLine({
        installment_flag: 1,
        nro_cuota_current: null,
        nro_cuota_total: 3,
      })
    ).toBe(true);
    expect(
      isUnindexedInstallmentResumenLine({
        installment_flag: 1,
        nro_cuota_current: 1,
        nro_cuota_total: 3,
      })
    ).toBe(false);
  });
});

describe("redundantInstallmentSummaryLineIds", () => {
  it("drops summary when CUOTA COMERCIO line exists on same statement", () => {
    const redundant = redundantInstallmentSummaryLineIds([
      {
        statement_line_id: 1,
        account_id: 32,
        statement_date: "22/04/2025",
        merchant: "VISTA LIBRE",
        installment_flag: 1,
        amount_clp: 1_654_183,
        valor_cuota_mensual_clp: 275_697,
      },
      {
        statement_line_id: 2,
        account_id: 32,
        statement_date: "22/04/2025",
        merchant: "VISTA LIBRE N/CUOTAS PRECIO 0,00 % $ 1.654.183 04/06",
        installment_flag: 0,
        amount_clp: 275_697,
        valor_cuota_mensual_clp: null,
      },
    ]);
    expect(redundant.has(2)).toBe(true);
    expect(redundant.has(1)).toBe(false);
  });

  it("keeps summary-only months when no indexed cuota line exists", () => {
    const redundant = redundantInstallmentSummaryLineIds([
      {
        statement_line_id: 3,
        account_id: 32,
        statement_date: "22/01/2025",
        merchant: "VISTA LIBRE N/CUOTAS PRECIO 0,00 % 01/06",
        installment_flag: 0,
        amount_clp: 275_697,
        valor_cuota_mensual_clp: null,
      },
    ]);
    expect(redundant.size).toBe(0);
  });

  it("drops TCOM resumen when indexed cuota exists on a later statement", () => {
    const redundant = redundantInstallmentSummaryLineIds([
      {
        statement_line_id: 10,
        account_id: 35,
        statement_date: "22/03/2023",
        merchant: "PARIS INTERNET TCOM 2",
        installment_flag: 1,
        amount_clp: 233_980,
        valor_cuota_mensual_clp: 86_497,
        nro_cuota_current: null,
        nro_cuota_total: 3,
      },
      {
        statement_line_id: 11,
        account_id: 35,
        statement_date: "24/04/2023",
        merchant: "PARIS INTERNET TCOM 2",
        installment_flag: 1,
        amount_clp: 233_980,
        valor_cuota_mensual_clp: 86_497,
        nro_cuota_current: 1,
        nro_cuota_total: 3,
      },
    ]);
    expect(redundant.has(10)).toBe(true);
    expect(redundant.has(11)).toBe(false);
  });
});

describe("merchantStemForInstallmentDedupe", () => {
  it("strips trailing installment descriptors", () => {
    expect(
      merchantStemForInstallmentDedupe(
        "LATAM.COM XP INTER TRES CUOTAS PREC 0,00 %"
      )
    ).toBe("LATAM.COM XP INTER");
  });
});
