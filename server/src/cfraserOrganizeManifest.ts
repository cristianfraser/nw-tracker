import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

export type CfraserOrganizeManifest = {
  cuenta_vista_pdfs: string[];
  checking_pdfs: string[];
  credit_card_pdfs: string[];
};

export function resolveCfraserOrganizeManifestPath(): string {
  return path.join(REPO_ROOT, "cfraser", "inbox-organize-manifest.json");
}

export function emptyCfraserOrganizeManifest(): CfraserOrganizeManifest {
  return { cuenta_vista_pdfs: [], checking_pdfs: [], credit_card_pdfs: [] };
}

export function loadCfraserOrganizeManifest(
  manifestPath = resolveCfraserOrganizeManifestPath()
): CfraserOrganizeManifest {
  if (!fs.existsSync(manifestPath)) return emptyCfraserOrganizeManifest();
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Partial<CfraserOrganizeManifest>;
  return {
    cuenta_vista_pdfs: [...(raw.cuenta_vista_pdfs ?? [])],
    checking_pdfs: [...(raw.checking_pdfs ?? [])],
    credit_card_pdfs: [...(raw.credit_card_pdfs ?? [])],
  };
}

/** `cartolas-cuenta-vista/foo.pdf` → `foo.pdf` */
export function basenameFromCfraserOrganizePath(relPath: string): string {
  return path.basename(relPath);
}

export function basenamesFromCfraserOrganizePaths(relPaths: string[]): string[] {
  return relPaths.map(basenameFromCfraserOrganizePath);
}
