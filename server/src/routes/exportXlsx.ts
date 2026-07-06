/** XLSX downloads for account and group pages (Export button → modal → workbook). */
import express from "express";
import {
  buildAccountExportWorkbook,
  buildGroupExportWorkbook,
  EXPORT_SECTIONS,
  isExportSection,
  type ExportOptions,
  type ExportSection,
} from "../exportWorkbook.js";
import { isKnownClassTabGroup, operationalAccountIdFromReq } from "./shared.js";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function parseExportOptions(
  q: Record<string, unknown>
): { ok: true; opts: ExportOptions } | { ok: false; error: string } {
  const opts: ExportOptions = { sections: [], unit: q.unit === "usd" ? "usd" : "clp" };
  for (const key of ["from", "to"] as const) {
    const v = q[key];
    if (v == null || v === "") continue;
    if (typeof v !== "string" || !MONTH_RE.test(v)) {
      return { ok: false, error: `${key} must be YYYY-MM` };
    }
    opts[key] = v;
  }
  if (opts.from && opts.to && opts.from > opts.to) {
    return { ok: false, error: "from must be ≤ to" };
  }
  const raw = typeof q.sections === "string" ? q.sections : "";
  const sections: ExportSection[] = [];
  for (const s of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!isExportSection(s)) {
      return { ok: false, error: `unknown section "${s}" (valid: ${EXPORT_SECTIONS.join(", ")})` };
    }
    if (!sections.includes(s)) sections.push(s);
  }
  if (sections.length === 0) return { ok: false, error: "sections is required" };
  return { ok: true, opts: { ...opts, sections } };
}

function sendWorkbook(
  res: express.Response,
  result: { filename: string; buffer: Buffer } | null
): void {
  if (!result) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
  res.send(result.buffer);
}

export function registerExportXlsxRoutes(app: express.Express): void {
  app.get("/api/accounts/:id/export.xlsx", (req, res) => {
    const id = operationalAccountIdFromReq(req);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "invalid account id" });
      return;
    }
    const parsed = parseExportOptions(req.query as Record<string, unknown>);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    sendWorkbook(res, buildAccountExportWorkbook(id, parsed.opts));
  });

  app.get("/api/groups/:slug/export.xlsx", (req, res) => {
    const slug = typeof req.params.slug === "string" ? req.params.slug.trim() : "";
    if (!slug || !isKnownClassTabGroup(slug)) {
      res.status(400).json({ error: "unknown group slug" });
      return;
    }
    const parsed = parseExportOptions(req.query as Record<string, unknown>);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    sendWorkbook(res, buildGroupExportWorkbook(slug, parsed.opts));
  });
}
