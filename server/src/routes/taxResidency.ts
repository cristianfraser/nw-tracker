/** The declared tax residency (taxResidency.ts): list, declare, delete the latest. */
import express from "express";
import {
  declareTaxResidency,
  deleteTaxResidencyPeriod,
  listTaxResidencyPeriods,
  TaxResidencyInputError,
  type TaxResidencyPeriod,
} from "../taxResidency.js";
import { asyncHandler } from "./shared.js";

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
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        const period = declareTaxResidency({
          jurisdiction: String(body.jurisdiction ?? ""),
          fromDate: String(body.from ?? ""),
          note: typeof body.note === "string" ? body.note : null,
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
