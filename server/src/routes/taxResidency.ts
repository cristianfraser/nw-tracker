/** The declared tax residency (taxResidency.ts): list, declare, delete the latest. */
import express from "express";
import {
  declareTaxResidency,
  deleteTaxResidencyPeriod,
  listTaxResidencyPeriods,
  TaxResidencyInputError,
  type TaxResidencyPeriod,
} from "../taxResidency.js";
import { asyncHandler, parseBody } from "./shared.js";
import { writeHandler } from "../inputError.js";
import { taxResidencyDeclareSchema } from "nw-tracker-contracts/requests/dashboard";

function periodDto(p: TaxResidencyPeriod) {
  return { id: p.id, jurisdiction: p.jurisdiction, from: p.fromDate, to: p.toDate, note: p.note };
}

export function registerTaxResidencyRoutes(app: express.Express): void {
  app.get(
    "/api/tax-residency",
    asyncHandler(async (_req, res) => {
      res.json({ periods: listTaxResidencyPeriods().map(periodDto) });
    })
  );

  app.post(
    "/api/tax-residency",
    writeHandler((req, res) => {
      const body = parseBody(taxResidencyDeclareSchema, req);
      try {
        const period = declareTaxResidency({
          jurisdiction: body.jurisdiction,
          fromDate: body.from,
          note: body.note ?? null,
        });
        res.status(201).json(periodDto(period));
      } catch (e) {
        if (e instanceof TaxResidencyInputError) {
          res.status(400).json({ error: e.message });
          return;
        }
        throw e;
      }
    })
  );

  app.delete(
    "/api/tax-residency/:id",
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: "invalid id" });
        return;
      }
      if (!deleteTaxResidencyPeriod(id)) {
        res.status(404).json({ error: "not the latest declared period" });
        return;
      }
      res.status(204).end();
    })
  );
}
