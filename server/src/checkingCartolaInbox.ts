import fs from "node:fs";
import path from "node:path";
import {
  canonicalCheckingCartolaXlsxFileName,
  isCheckingCartolaXlsxFileName,
} from "./checkingCartolaParse.js";
import {
  resolveCfraserCheckingCartolasDir,
  resolveCfraserInboxDir,
} from "./cfraserPaths.js";

export type OrganizeCheckingCartolaXlsxResult = {
  moved: { from: string; to: string }[];
  skipped: { file: string; reason: string }[];
  errors: { file: string; error: string }[];
};

/** Move Santander checking cartola `.xlsx` from inbox → `excels/cuenta corriente/`. */
export function organizeCheckingCartolaXlsxFromInbox(opts?: {
  inboxDir?: string;
  destDir?: string;
  dryRun?: boolean;
}): OrganizeCheckingCartolaXlsxResult {
  const inboxDir = opts?.inboxDir ?? resolveCfraserInboxDir();
  const destDir = opts?.destDir ?? resolveCfraserCheckingCartolasDir();
  const dryRun = opts?.dryRun ?? false;
  const moved: OrganizeCheckingCartolaXlsxResult["moved"] = [];
  const skipped: OrganizeCheckingCartolaXlsxResult["skipped"] = [];
  const errors: OrganizeCheckingCartolaXlsxResult["errors"] = [];

  if (!fs.existsSync(inboxDir)) {
    return { moved, skipped, errors };
  }

  fs.mkdirSync(destDir, { recursive: true });

  for (const name of fs.readdirSync(inboxDir).sort()) {
    if (!isCheckingCartolaXlsxFileName(name)) continue;

    const canonical = canonicalCheckingCartolaXlsxFileName(name);
    if (!canonical) {
      errors.push({ file: name, error: "could not derive canonical cartola xlsx name" });
      continue;
    }

    const src = path.join(inboxDir, name);
    const dest = path.join(destDir, canonical);

    if (fs.existsSync(dest) && path.resolve(src) !== path.resolve(dest)) {
      skipped.push({ file: name, reason: `already archived as ${canonical}` });
      if (!dryRun) {
        fs.unlinkSync(src);
      }
      continue;
    }

    if (path.resolve(src) === path.resolve(dest)) {
      skipped.push({ file: name, reason: "already at destination" });
      continue;
    }

    if (!dryRun) {
      fs.renameSync(src, dest);
    }
    moved.push({ from: name, to: canonical });
  }

  return { moved, skipped, errors };
}
