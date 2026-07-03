/** Mirror-pair admin: candidates, batch conversion, rejection, undo (/panel/mirror-pairs). */
import express from "express";
import {
  convertMirrorPairs,
  MirrorConvertStaleError,
  rejectMirrorPairs,
  undoMirrorConversion,
  unrejectMirrorPairs,
  type MirrorPairRef,
} from "../movementMirrorConvert.js";
import { listMirrorPairCandidates, listRejectedMirrorPairs } from "../movementMirrorPairs.js";

function parsePairRefs(body: unknown): MirrorPairRef[] | null {
  const pairs = (body as { pairs?: unknown } | null)?.pairs;
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  const out: MirrorPairRef[] = [];
  for (const p of pairs) {
    const outId = Number((p as { out_movement_id?: unknown })?.out_movement_id);
    const inId = Number((p as { in_movement_id?: unknown })?.in_movement_id);
    if (!Number.isInteger(outId) || outId <= 0 || !Number.isInteger(inId) || inId <= 0) return null;
    out.push({ out_movement_id: outId, in_movement_id: inId });
  }
  return out;
}

export function registerMovementMirrorsRoutes(app: express.Express): void {
  app.get("/api/movement-mirrors/candidates", (_req, res) => {
    res.json({
      pairs: listMirrorPairCandidates(),
      rejected: listRejectedMirrorPairs(),
    });
  });

  app.post("/api/movement-mirrors/convert", (req, res) => {
    const pairs = parsePairRefs(req.body);
    if (!pairs) {
      res.status(400).json({ error: "pairs must be a non-empty array of {out_movement_id, in_movement_id}" });
      return;
    }
    try {
      res.json(convertMirrorPairs(pairs));
    } catch (e) {
      if (e instanceof MirrorConvertStaleError) {
        res.status(409).json({ error: e.message, pair: e.pair });
        return;
      }
      throw e;
    }
  });

  app.post("/api/movement-mirrors/reject", (req, res) => {
    const pairs = parsePairRefs(req.body);
    if (!pairs) {
      res.status(400).json({ error: "pairs must be a non-empty array of {out_movement_id, in_movement_id}" });
      return;
    }
    res.json(rejectMirrorPairs(pairs));
  });

  app.post("/api/movement-mirrors/unreject", (req, res) => {
    const pairs = parsePairRefs(req.body);
    if (!pairs) {
      res.status(400).json({ error: "pairs must be a non-empty array of {out_movement_id, in_movement_id}" });
      return;
    }
    res.json(unrejectMirrorPairs(pairs));
  });

  app.post("/api/movement-mirrors/undo", (req, res) => {
    const movementId = Number((req.body as { movement_id?: unknown } | null)?.movement_id);
    if (!Number.isInteger(movementId) || movementId <= 0) {
      res.status(400).json({ error: "movement_id required" });
      return;
    }
    res.json(undoMirrorConversion(movementId));
  });
}
