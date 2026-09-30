/** Local Formulario 22 (/tax-return page). */
import express from "express";
import { availableF22TaxYears, buildF22Payload } from "../f22DraftPayload.js";

export function registerTaxReturnRoutes(app: express.Express): void {
  app.get("/api/tax-return", (req, res) => {
    const years = availableF22TaxYears();
    const raw = req.query.tax_year;
    const taxYear = raw == null || raw === "" ? years[0] : Number(raw);
    if (taxYear == null) {
      res.status(404).json({ error: "no_filed_return" });
      return;
    }
    if (!years.includes(taxYear)) {
      res.status(400).json({ error: `tax_year must be one of ${years.join(", ")}` });
      return;
    }
    res.json(buildF22Payload(taxYear));
  });
}
