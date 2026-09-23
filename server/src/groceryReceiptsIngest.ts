/**
 * Grocery receipt inbox → staging: photos of paper receipts (and hand-saved receipt PDFs)
 * dropped in `cfraser/grocery-receipts/inbox/` become staged dirs the parser
 * (`parse-grocery-receipts.py`) and the importer (`groceryReceiptsImport.ts`) understand.
 *
 * One staged dir per DOCUMENT, keyed by the file's sha256 — the document's identity, whatever
 * its name: `staged/<date>-<source>-<sha12>/` holding the original as `receipt.<ext>` plus
 * meta.json `{source, source_key, original_file, original_name, ingested_at}`. `<date>` is the
 * file's modification date (the capture date when AirDrop preserved it) — ordering only; the
 * receipt's own printed datetime is the truth and is parsed later. Source: images → `photo`,
 * PDFs → `manual_pdf` (a boleta PDF saved by hand; the Lider e-mail fetcher has its own root).
 *
 * Fail-closed: any other file in the inbox is an ERROR and nothing is moved — a stray document
 * must never vanish into staging half-processed. An exact duplicate of an already-staged
 * document is parked in `duplicates/` and reported (the sha index covers this batch too).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveCfraserCsvDir } from "./cfraserPaths.js";
import { groceryReceiptsStagedDir, type GenericStagedMeta, type GroceryReceiptSource } from "./groceryReceiptsImport.js";

export const RECEIPT_IMAGE_SUFFIXES: ReadonlySet<string> = new Set([
  ".jpg", ".jpeg", ".png", ".heic", ".heif", ".tif", ".tiff", ".webp",
]);
export const RECEIPT_PDF_SUFFIXES: ReadonlySet<string> = new Set([".pdf"]);

export function groceryReceiptsInboxDir(cfraserDir = resolveCfraserCsvDir()): string {
  return path.join(cfraserDir, "grocery-receipts", "inbox");
}

export function groceryReceiptsDuplicatesDir(cfraserDir = resolveCfraserCsvDir()): string {
  return path.join(cfraserDir, "grocery-receipts", "duplicates");
}

/** Regular, non-dot files in the inbox (`.DS_Store` and friends are not documents). */
export function listGroceryReceiptInboxFiles(inboxDir = groceryReceiptsInboxDir()): string[] {
  if (!fs.existsSync(inboxDir)) return [];
  return fs
    .readdirSync(inboxDir)
    .filter((name) => !name.startsWith(".") && fs.statSync(path.join(inboxDir, name)).isFile())
    .sort();
}

function sourceForFile(name: string): GroceryReceiptSource | null {
  const ext = path.extname(name).toLowerCase();
  if (RECEIPT_IMAGE_SUFFIXES.has(ext)) return "photo";
  if (RECEIPT_PDF_SUFFIXES.has(ext)) return "manual_pdf";
  return null;
}

function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function localYmd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** sha256 → staged dir name, over every generic-root dir that has a meta.json. */
function stagedSourceKeys(stagedDir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(stagedDir)) return out;
  for (const name of fs.readdirSync(stagedDir)) {
    const metaFile = path.join(stagedDir, name, "meta.json");
    if (!fs.existsSync(metaFile)) continue;
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as Partial<GenericStagedMeta>;
    if (meta.source_key) out.set(meta.source_key, name);
  }
  return out;
}

export type IngestResult =
  | { file: string; status: "staged"; source: GroceryReceiptSource; dir: string }
  | { file: string; status: "duplicate"; of: string; parked: string };

export function ingestGroceryReceiptInbox(opts?: {
  inboxDir?: string;
  stagedDir?: string;
  duplicatesDir?: string;
  dryRun?: boolean;
  now?: Date;
}): IngestResult[] {
  const inboxDir = opts?.inboxDir ?? groceryReceiptsInboxDir();
  const stagedDir = opts?.stagedDir ?? groceryReceiptsStagedDir();
  const duplicatesDir = opts?.duplicatesDir ?? groceryReceiptsDuplicatesDir();
  const files = listGroceryReceiptInboxFiles(inboxDir);
  if (files.length === 0) return [];

  // Validate the whole batch before moving anything.
  const unsupported = files.filter((f) => sourceForFile(f) === null);
  if (unsupported.length > 0) {
    throw new Error(
      `grocery receipt inbox: unsupported file(s) ${unsupported.join(", ")} — only receipt photos ` +
        `(${[...RECEIPT_IMAGE_SUFFIXES].join(" ")}) and PDFs belong in ${inboxDir}; remove them and re-run`
    );
  }

  const known = stagedSourceKeys(stagedDir);
  const ingestedAt = (opts?.now ?? new Date()).toISOString();
  const results: IngestResult[] = [];
  for (const name of files) {
    const file = path.join(inboxDir, name);
    const source = sourceForFile(name)!;
    const sha = sha256File(file);
    const existing = known.get(sha);
    if (existing) {
      const parked = path.join(duplicatesDir, `${sha.slice(0, 12)}-${name}`);
      if (!opts?.dryRun) {
        fs.mkdirSync(duplicatesDir, { recursive: true });
        fs.renameSync(file, parked);
      }
      results.push({ file: name, status: "duplicate", of: existing, parked });
      continue;
    }
    const dirName = `${localYmd(fs.statSync(file).mtime)}-${source}-${sha.slice(0, 12)}`;
    const dir = path.join(stagedDir, dirName);
    const originalFile = `receipt${path.extname(name).toLowerCase()}`;
    if (!opts?.dryRun) {
      if (fs.existsSync(dir)) {
        throw new Error(`grocery receipt inbox: staged dir ${dir} already exists without a meta.json — inspect it by hand`);
      }
      fs.mkdirSync(dir, { recursive: true });
      const meta: GenericStagedMeta = {
        source,
        source_key: sha,
        original_file: originalFile,
        original_name: name,
        ingested_at: ingestedAt,
      };
      // meta first, then the document: a crash in between leaves a dir the parser reports
      // ("original_file absent on disk"), never a document without provenance.
      fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 1) + "\n");
      fs.renameSync(file, path.join(dir, originalFile));
    }
    known.set(sha, dirName);
    results.push({ file: name, status: "staged", source, dir: dirName });
  }
  return results;
}
