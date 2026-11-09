import { describe, expect, it } from "vitest";
import { normalizePayslipLabel, payslipLineKind, payslipLineKindJurisdiction, splitPensionLine } from "./payslipLineKinds.js";

describe("payslip line kinds", () => {
  it("reads each layout's spelling of the same line", () => {
    expect(["Descuento AFP (LQ)", "A.F.P. PLANVITAL 10.41%", "Fondo De Pensiones Afp Modelo 10.77%", "Cotiz. Previ. Obligatoria"].map((l) => payslipLineKind("descuento", l, "cl"))).toEqual([
      "pension",
      "pension",
      "pension",
      "pension",
    ]);
    expect(payslipLineKind("descuento", "Cotizacion Adicional Isapre", "cl")).toBe("health_additional");
    expect(payslipLineKind("descuento", "Isapre 7%", "cl")).toBe("health");
    expect(payslipLineKind("descuento", "SEGURO CESANTIA (Aporte trabajador) 0.60%", "cl")).toBe("unemployment");
    expect(payslipLineKind("haber", "Asig. Colación (LQ)", "cl")).toBe("allowance");
    expect(payslipLineKind("haber", "1 DiA(S) DE INASISTENCIA", "cl")).toBe("absence");
  });

  it("the same label is a benefit on one side and a deduction on the other", () => {
    expect(payslipLineKind("haber", "Seguro Vida Costo Empresa", "cl")).toBe("life_insurance_benefit");
    expect(payslipLineKind("descuento", "Seguro Vida Costo Empresa", "cl")).toBe("life_insurance");
  });

  it("reads a finiquito's lines", () => {
    expect(payslipLineKind("haber", "Indemnización por años de servicio", "cl")).toBe("indemnity_years_of_service");
    expect(payslipLineKind("haber", "Indemnización sustitutiva del aviso previo", "cl")).toBe("indemnity_notice");
    expect(payslipLineKind("descuento", "Cotizaciones de seguridad Social", "cl")).toBe("social_security");
    expect(payslipLineKind("haber", "Honorarios (contrato en USD)", "cl")).toBe("contractor_fee");
    expect(payslipLineKind("descuento", "Comisión de transferencia", "cl")).toBe("transfer_fee");
  });

  it("an unknown label fails", () => {
    expect(() => payslipLineKind("descuento", "Cuota sindical", "cl")).toThrow(/no cl kind for the descuento «Cuota sindical»/);
  });

  it("reads US pay-stub labels only on a US payslip", () => {
    expect(payslipLineKind("haber", "Regular Pay", "us")).toBe("wages");
    expect(payslipLineKind("haber", "Annual Bonus", "us")).toBe("supplemental_bonus");
    expect(payslipLineKind("haber", "RSU Vest", "us")).toBe("rsu");
    expect(payslipLineKind("descuento", "Federal Income Tax", "us")).toBe("federal_income_tax");
    expect(payslipLineKind("descuento", "Social Security", "us")).toBe("social_security_tax");
    expect(payslipLineKind("descuento", "Medicare", "us")).toBe("medicare_tax");
    expect(payslipLineKind("descuento", "401(k)", "us")).toBe("retirement_401k_pretax");
    expect(payslipLineKind("descuento", "Roth 401(k)", "us")).toBe("retirement_401k_roth");
    expect(payslipLineKind("descuento", "HSA", "us")).toBe("hsa");
    expect(payslipLineKind("descuento", "Medical", "us")).toBe("health_premium");
    expect(payslipLineKind("descuento", "Dental", "us")).toBe("dental_vision");
    expect(payslipLineKind("descuento", "Vision", "us")).toBe("dental_vision");
    expect(payslipLineKind("descuento", "RSU Offset", "us")).toBe("rsu_offset");
    expect(payslipLineKind("memo", "401(k) Employer Match", "us")).toBe("employer_401k_match");
    expect(payslipLineKindJurisdiction("wages")).toBe("us");
    expect(payslipLineKindJurisdiction("pension")).toBe("cl");
  });

  it("a label of the other jurisdiction fails", () => {
    expect(() => payslipLineKind("descuento", "Federal Income Tax", "cl")).toThrow(/no cl kind/);
    expect(() => payslipLineKind("descuento", "Impuesto Unico", "us")).toThrow(/no us kind/);
    expect(() => payslipLineKind("haber", "Sueldo Base", "us")).toThrow(/no us kind/);
    expect(() => payslipLineKind("memo", "401(k) Employer Match", "cl")).toThrow(/memo line/);
    expect(() => payslipLineKind("haber", "401(k) Employer Match", "us")).toThrow(/no us kind/);
  });

  it("normalizes accents, spacing and Talana's (LQ)", () => {
    expect(normalizePayslipLabel("  Gratificación   Mensual (LQ) ")).toBe("gratificacion mensual");
  });

  it("splits the AFP line into the mandatory 10 % of the taxable base and the commission", () => {
    expect(splitPensionLine(311_571, 2_944_902)).toEqual({ mandatory: 294_490, commission: 17_081 });
  });
});
