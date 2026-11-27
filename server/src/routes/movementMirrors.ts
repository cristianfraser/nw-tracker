/** Mirror-pair admin: candidates, batch conversion, rejection (/panel/mirror-pairs). */
import express from "express";
import { writeHandler } from "../inputError.js";
import {
  convertMirrorPairs,
  MirrorConvertStaleError,
  MirrorPairConflictError,
  rejectMirrorPairs,
  unrejectMirrorPairs,
} from "../movementMirrorConvert.js";
import { ccPaymentMirrorsRequestSchema, mirrorPairsRequestSchema } from "nw-tracker-contracts/requests/mirrors";
import { parseBody } from "./shared.js";
import { listMirrorPairCandidates, listRejectedMirrorPairs } from "../movementMirrorPairs.js";
import { buildMirrorPairsPanel } from "../movementMirrorPanel.js";
import {
  convertCcPaymentMirrors,
  listCcPaymentMirrorCandidates,
} from "../ccPaymentMirrors.js";

export function registerMovementMirrorsRoutes(app: express.Express): void {
  app.get("/api/movement-mirrors/candidates", (_req, res) => {
    res.json(
      buildMirrorPairsPanel(
        listMirrorPairCandidates(),
        listCcPaymentMirrorCandidates(),
        listRejectedMirrorPairs()
      )
    );
  });

  app.post("/api/movement-mirrors/convert", writeHandler((req, res) => {
    const { pairs } = parseBody(mirrorPairsRequestSchema, req);
    try {
      res.json(convertMirrorPairs(pairs));
    } catch (e) {
      if (e instanceof MirrorConvertStaleError) {
        res.status(409).json({ error: e.message, pair: e.pair });
        return;
      }
      if (e instanceof MirrorPairConflictError) {
        res.status(409).json({ error: e.message, refused: e.refused });
        return;
      }
      throw e;
    }
  }));

  app.post("/api/movement-mirrors/convert-cc-payments", writeHandler((req, res) => {
    const refs = parseBody(ccPaymentMirrorsRequestSchema, req).pairs.map((p) => ({
      out_movement_id: p.out_movement_id,
      statement_line_id: p.statement_line_id ?? null,
      statement_id: p.statement_id ?? null,
    }));
    // A pair that is no longer a candidate (or is blocked) is an `InputError` → 409; a failing
    // conversion is a 500.
    res.json(convertCcPaymentMirrors(refs));
  }));

  app.post("/api/movement-mirrors/reject", writeHandler((req, res) => {
    res.json(rejectMirrorPairs(parseBody(mirrorPairsRequestSchema, req).pairs));
  }));

  app.post("/api/movement-mirrors/unreject", writeHandler((req, res) => {
    res.json(unrejectMirrorPairs(parseBody(mirrorPairsRequestSchema, req).pairs));
  }));

}
