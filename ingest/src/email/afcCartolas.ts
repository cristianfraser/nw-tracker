/**
 * Fetch the AFC's cartolas (estado cuatrimestral and the annual one) out of Gmail.
 *
 * AFC Chile mails each cartola as a PDF attachment from cartolasafc@afc.cl («Cartola cuatrimestral
 * Seguro de Cesantía.» in June and October, «Cartola Anual Seguro de Cesantía» in February). The
 * attachment is named after a document number plus the send date, so — as for the Lider statement
 * — the ledger key is the mail date + message id, and the saved name is date-prefixed. The files
 * land in `cfraser/afc-certs/cartolas/`, where the nightly AFC read picks every one of them up and
 * sends them with the certificate of paid contributions (`unemployment_fund.documents`): the
 * cartola's printed balances are what book the fund's commission.
 *
 * The PDF is encrypted with the affiliate's RUT digits (no verifier digit) — read from
 * `cfraser/afc-fetch.json`, never written here — and decrypted in place with qpdf on download, so
 * the staged file is the plain document the nightly read parses. A PDF the password does not open
 * is removed and reported as an ERROR, as is any attachment shape other than exactly one PDF.
 */
import fs from "node:fs";
import path from "node:path";
import { ImapFlow } from "imapflow";
import type { FetchMessageObject } from "imapflow";
import { execFileSync } from "node:child_process";
import { loadBankConfig } from "../config.js";
import { readKeychainSecret } from "../keychain.js";
import { ensureDir, resolveCfraserDir } from "../paths.js";
import { log, logStep } from "../log.js";
import { hasDocument, recordDocument } from "../documentLedger.js";
import { loadBrokerEmailConfig } from "./fetch.js";
import { mailDocumentLedgerKey, normalizeMailSubject, pdfAttachmentsFromStructure, safeAttachmentName } from "./santanderDocs.js";

export const AFC_CARTOLA_SENDER = "cartolasafc@afc.cl";
/** Three a year; 45 days covers one missed cartola plus mail lag. */
const DEFAULT_WINDOW_DAYS = 45;

export function isAfcCartolaSubject(subject: string): boolean {
  const s = normalizeMailSubject(subject);
  return s.includes("cartola") && s.includes("cesant");
}

/** The cartola PDFs' password: the RUT's digits without the verifier (2026-10-17). */
export function afcCartolaPassword(rut: string): string {
  const digits = rut.replace(/\./g, "").split("-")[0]!.replace(/\D/g, "");
  if (digits.length < 7) throw new Error(`AFC: RUT «${rut}» has no digits to make the cartola password from`);
  return digits;
}

/** Decrypt a cartola in place; throws when the password does not open it. */
export function decryptAfcCartola(file: string, password: string): void {
  const tmp = `${file}.decrypted.tmp`;
  try {
    execFileSync("qpdf", ["--decrypt", `--password=${password}`, file, tmp], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`qpdf could not decrypt ${path.basename(file)}: ${err instanceof Error ? err.message.split("\n").pop() : String(err)}`);
  }
  fs.renameSync(tmp, file);
}

export function resolveAfcCartolasDir(): string {
  return path.join(resolveCfraserDir(), "afc-certs", "cartolas");
}

export type AfcCartolaFetchResult = {
  saved: { key: string; file: string }[];
  skipped: { key: string; reason: string }[];
  errors: { key: string; reason: string }[];
};

export async function fetchAfcCartolaEmails(opts?: { windowDays?: number; dryRun?: boolean }): Promise<AfcCartolaFetchResult> {
  const config = loadBrokerEmailConfig();
  const password = readKeychainSecret(config.keychain_service, config.address);
  const pdfPassword = afcCartolaPassword(loadBankConfig("afc").rut);
  const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
  const since = new Date(Date.now() - windowDays * 86_400_000);
  const dryRun = opts?.dryRun === true;
  logStep(`e-mail — AFC cartolas since ${since.toISOString().slice(0, 10)}${dryRun ? " (dry run)" : ""}`);

  const result: AfcCartolaFetchResult = { saved: [], skipped: [], errors: [] };
  const dir = dryRun ? null : ensureDir(resolveAfcCartolasDir());
  const client = new ImapFlow({ host: config.host, port: config.port, secure: true, auth: { user: config.address, pass: password }, logger: false });
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ from: AFC_CARTOLA_SENDER, since });
      if (!uids || uids.length === 0) {
        log("e-mail: no AFC cartola mail in window");
        return result;
      }
      const candidates: { uid: number; msg: FetchMessageObject }[] = [];
      for await (const msg of client.fetch(uids, { envelope: true, bodyStructure: true, uid: true })) {
        if (!isAfcCartolaSubject(String(msg.envelope?.subject ?? ""))) continue;
        candidates.push({ uid: msg.uid, msg });
      }
      for (const candidate of candidates) {
        const messageId = String(candidate.msg.envelope?.messageId ?? `uid-${candidate.uid}`);
        const mailDate = candidate.msg.envelope?.date ?? new Date();
        const key = mailDocumentLedgerKey(mailDate, messageId);
        if (hasDocument("afc", "email-cartola", key)) {
          result.skipped.push({ key, reason: "already fetched" });
          continue;
        }
        const attachments = pdfAttachmentsFromStructure(candidate.msg.bodyStructure);
        if (attachments.length !== 1) {
          result.errors.push({ key, reason: `expected exactly one pdf attachment, got [${attachments.map((a) => a.filename).join(", ") || "none"}]` });
          continue;
        }
        const ymd = mailDate.toISOString().slice(0, 10);
        const name = `${ymd} ${safeAttachmentName(attachments[0]!.filename, "afc-cartola.pdf")}`;
        if (dryRun) {
          result.saved.push({ key, file: name });
          continue;
        }
        const download = await client.download(String(candidate.uid), attachments[0]!.part, { uid: true });
        const chunks: Buffer[] = [];
        for await (const chunk of download.content) chunks.push(Buffer.from(chunk));
        const target = path.join(dir!, name);
        if (fs.existsSync(target)) result.skipped.push({ key, reason: `${name} already staged` });
        else {
          fs.writeFileSync(target, Buffer.concat(chunks));
          try {
            decryptAfcCartola(target, pdfPassword);
          } catch (err) {
            fs.rmSync(target, { force: true });
            result.errors.push({ key, reason: err instanceof Error ? err.message : String(err) });
            continue;
          }
          result.saved.push({ key, file: name });
        }
        recordDocument("afc", "email-cartola", key);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  for (const s of result.saved) log(`e-mail: AFC cartola ${s.key} → ${s.file}`);
  const already = result.skipped.filter((s) => s.reason === "already fetched").length;
  for (const s of result.skipped) if (s.reason !== "already fetched") log(`e-mail: AFC cartola ${s.key} skipped (${s.reason})`);
  if (already > 0) log(`e-mail: ${already} cartola mail(s) already fetched`);
  for (const e of result.errors) log(`e-mail: AFC cartola ${e.key} ERROR (${e.reason})`);
  if (result.saved.length === 0 && result.errors.length === 0) log("e-mail: no new AFC cartola");
  return result;
}
