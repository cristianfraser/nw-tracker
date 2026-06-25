import { describe, expect, it } from "vitest";
import {
  basenamesFromCfraserOrganizePaths,
  emptyCfraserOrganizeManifest,
} from "./cfraserOrganizeManifest.js";

describe("cfraserOrganizeManifest", () => {
  it("extracts pdf basenames from manifest paths", () => {
    const manifest = emptyCfraserOrganizeManifest();
    manifest.cuenta_vista_pdfs = [
      "cartolas-cuenta-vista/2026-05-31 cartola cuenta vista.pdf",
    ];
    expect(basenamesFromCfraserOrganizePaths(manifest.cuenta_vista_pdfs)).toEqual([
      "2026-05-31 cartola cuenta vista.pdf",
    ]);
  });
});
