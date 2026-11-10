/** Local Formulario 22 and Form 1040 (/tax-return page). */
import express from "express";
import { availableF22TaxYears, buildF22Payload, filedTaxYears } from "../f22/payload.js";
import { availableUsTaxYears } from "../us1040/draft.js";
import { filedF1040TaxYears } from "../us1040/filed.js";
import { buildF1040Payload } from "../us1040/payload.js";

export function registerTaxReturnRoutes(app: express.Express): void {
  app.get("/api/tax-return", (req, res) => {
    const years = availableF22TaxYears();
    const raw = req.query.tax_year;
    // Default: the latest year with a filed form, else the current one.
    const filed = (years.filter((y) => filedTaxYears().includes(y)))[0] ?? years[0]!;
    const taxYear = raw == null || raw === "" ? filed : Number(raw);
    if (!years.includes(taxYear)) {
      res.status(400).json({ error: `tax_year must be one of ${years.join(", ")}` });
      return;
    }
    const payload = buildF22Payload(taxYear);
    // The año tributario declares the previous calendar year: the US tab is that year's 1040.
    const usTaxYear = availableUsTaxYears().includes(payload.income_year) ? payload.income_year : null;
    res.json({ ...payload, us_tax_year: usTaxYear });
  });

  app.get("/api/tax-return/us", (req, res) => {
    const years = availableUsTaxYears();
    if (years.length === 0) {
      res.status(404).json({ error: "no_us_tax_year" });
      return;
    }
    const raw = req.query.tax_year;
    // Default: the latest year with a filed return, else the latest year.
    const filed = filedF1040TaxYears();
    const fallback = years.find((y) => filed.includes(y)) ?? years[0]!;
    const taxYear = raw == null || raw === "" ? fallback : Number(raw);
    if (!years.includes(taxYear)) {
      res.status(400).json({ error: `tax_year must be one of ${years.join(", ")}` });
      return;
    }
    res.json(buildF1040Payload(taxYear));
  });
}
