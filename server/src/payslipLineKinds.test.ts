import { describe, expect, it } from "vitest";
import { normalizePayslipLabel, payslipLineKind, splitPensionLine } from "./payslipLineKinds.js";

describe("payslip line kinds", () => {
  it("reads each layout's spelling of the same line", () => {
    expect(["Descuento AFP (LQ)", "A.F.P. PLANVITAL 10.41%", "Fondo De Pensiones Afp Modelo 10.77%", "Cotiz. Previ. Obligatoria"].map((l) => payslipLineKind("descuento", l))).toEqual([
      "pension",
      "pension",
      "pension",
      "pension",
    ]);
    expect(payslipLineKind("descuento", "Cotizacion Adicional Isapre")).toBe("health_additional");
    expect(payslipLineKind("descuento", "Isapre 7%")).toBe("health");
    expect(payslipLineKind("descuento", "SEGURO CESANTIA (Aporte trabajador) 0.60%")).toBe("unemployment");
    expect(payslipLineKind("haber", "Asig. Colación (LQ)")).toBe("allowance");
    expect(payslipLineKind("haber", "1 DiA(S) DE INASISTENCIA")).toBe("absence");
  });

  it("the same label is a benefit on one side and a deduction on the other", () => {
    expect(payslipLineKind("haber", "Seguro Vida Costo Empresa")).toBe("life_insurance_benefit");
    expect(payslipLineKind("descuento", "Seguro Vida Costo Empresa")).toBe("life_insurance");
  });

  it("reads a finiquito's lines", () => {
    expect(payslipLineKind("haber", "Indemnización por años de servicio")).toBe("indemnity_years_of_service");
    expect(payslipLineKind("haber", "Indemnización sustitutiva del aviso previo")).toBe("indemnity_notice");
    expect(payslipLineKind("descuento", "Cotizaciones de seguridad Social")).toBe("social_security");
    expect(payslipLineKind("haber", "Honorarios (contrato en USD)")).toBe("contractor_fee");
    expect(payslipLineKind("descuento", "Comisión de transferencia")).toBe("transfer_fee");
  });

  it("an unknown label fails", () => {
    expect(() => payslipLineKind("descuento", "Cuota sindical")).toThrow(/no kind for the descuento «Cuota sindical»/);
  });

  it("normalizes accents, spacing and Talana's (LQ)", () => {
    expect(normalizePayslipLabel("  Gratificación   Mensual (LQ) ")).toBe("gratificacion mensual");
  });

  it("splits the AFP line into the mandatory 10 % of the taxable base and the commission", () => {
    expect(splitPensionLine(311_571, 2_944_902)).toEqual({ mandatory: 294_490, commission: 17_081 });
  });
});
