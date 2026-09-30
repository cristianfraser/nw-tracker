/** Local Formulario 22 (/tax-return page). */
import express from "express";
import { availableF22TaxYears, buildF22Payload, filedTaxYears } from "../f22DraftPayload.js";

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
    res.json(buildF22Payload(taxYear));
  });
}
