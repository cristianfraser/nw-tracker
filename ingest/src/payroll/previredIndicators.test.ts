import { describe, expect, it } from "vitest";
import { parsePreviredIndicators, previredArchiveLinks } from "./previredIndicators.js";

// Layouts as pdftotext -layout prints them (synthetic values).
const OLD = `
            Para Cotizaciones a Pagar en Junio 2030 (Remuneraciones Mayo 2030)
Al 31 de Mayo 2030:                                  $     30.000,50                              Tasa AFP Trabajadores
Al 30 de Abril 2030:                                 $     29.900,00
Valor                        UTM                            UTA
                                                                       Capital                11,44%               1,41%                12,85%
Mayo 2030                   $ 50.000                 $     600.000     Cuprum                 11,48%               1,41%                12,89%
                                                                       Habitat                11,27%               1,41%                12,68%
Para afiliados a una AFP (75,7 UF):                  $     2.015.965   PlanVital              10,41%               1,41%                 11,82%
Para Seguro de Cesantía (113,5 UF):                  $     3.022.616   Modelo                 10,77%               1,41%                12,18%
Contrato Plazo Indefinido                    2,4% R.I.    0,6% R.I.
Contrato Plazo Indefinido 11 años o más (**) 0,8% R.I.        -
`;

const NEW = `
                Para Cotizaciones a Pagar en Octubre 2030 (Remuneraciones Septiembre 2030)
  Al 30 de Septiembre del 2030:                                            $ 41.000,20            Septiembre 2030                 $ 71.000               $ 852.000
  Para afiliados a una AFP (90 UF):                                        $ 3.695.148
  Para Seguro de Cesantía(135,2 UF):                                       $ 5.550.933
                       Cargo del Trabajador (*)   Cargo del Empleador    Total a Pagar(**)
  Capital                    11,44%                     0,1%                11,54%
  Cuprum                     11,44%                     0,1%                11,54%
  Habitat                    11,27%                     0,1%                11,37%
  PlanVital                  11,16%                     0,1%                11,26%
  Modelo                     10,58%                     0,1%                10,68%
  Uno                        10,46%                     0,1%                10,56%
  Plazo Indefinido                                   2,4% R.I.            0,6% R.I.
`;

describe("Previred indicators", () => {
  it("reads the pre-reform layout: the second column is the SIS, not an employer share", () => {
    expect(parsePreviredIndicators(OLD)).toEqual({
      period_month: "2030-05",
      uf: 30000.5,
      utm: 50000,
      pension_cap_uf: 75.7,
      unemployment_cap_uf: 113.5,
      afp_worker_rates: { capital: 11.44, cuprum: 11.48, habitat: 11.27, planvital: 10.41, modelo: 10.77 },
      afp_employer_rate: 0,
      afc_worker_rate: 0.6,
      afc_employer_rate: 2.4,
    });
  });

  it("reads the reform layout's employer share", () => {
    const p = parsePreviredIndicators(NEW);
    expect([p.period_month, p.uf, p.utm, p.pension_cap_uf, p.unemployment_cap_uf, p.afp_employer_rate, p.afp_worker_rates.uno]).toEqual([
      "2030-09", 41000.2, 71000, 90, 135.2, 0.1, 10.46,
    ]);
  });

  it("a commission change announced above the table fills an AFP the table leaves out", () => {
    const p = parsePreviredIndicators(OLD.replace("Para Cotizaciones", "Cambio de Comisión AFP UNO, para las Remuneraciones de Mayo: 0,62%\nPara Cotizaciones"));
    expect(p.afp_worker_rates.uno).toBeCloseTo(10.62);
  });

  it("fails on a document without the caps", () => {
    expect(() => parsePreviredIndicators(OLD.replace("Para afiliados a una AFP (75,7 UF)", ""))).toThrow(/no taxable caps/);
  });

  it("maps the archive's links to their payroll months", () => {
    const html = `<li><a href="/x/Indicadores+Enero+2018.pdf" target="_blank">Enero 2018</a></li><li><a href="/y/b.pdf">Septiembre 2026</a></li>`;
    expect([...previredArchiveLinks(html)]).toEqual([
      ["2018-01", "https://www.previred.com/x/Indicadores+Enero+2018.pdf"],
      ["2026-09", "https://www.previred.com/y/b.pdf"],
    ]);
  });
});
