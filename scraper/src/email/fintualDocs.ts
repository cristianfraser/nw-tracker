/**
 * Fetch Fintual's «Acciones» documents (the US brokerage account, custodied at Alpaca) out of
 * Gmail into `cfraser/fintual-acciones/`.
 *
 * Two documents matter, both PDF attachments from hola@fintual.com:
 *  - «Cartola mensual de Acciones» — Alpaca's monthly statement, mailed ~the 10th of the next
 *    month. Its Income section is the one automatic source of the gross dividend, the per-share
 *    rate, the record date and the US withholding («Div. Adj(NRA Withheld) … at 15% for tax
 *    country CHL»), which the dividend notification mails never carry (the «Recibiste un
 *    dividendo de LIN por US $10,75» figure is what was credited).
 *  - «Certificado de transacciones y eventos de capital en Acciones» — requested by hand in the
 *    app; prints every dividend as bruto / impuestos / neto since the account opened. The
 *    full-history backfill and the cross-check for the cartolas.
 * Trade confirmations and the holdings certificate are deliberately not fetched: the ledger
 * already has every trade from the notification mails and the certificado CSV.
 *
 * The ledger key is the mail date + message id (`mailDocumentLedgerKey`), NOT the attachment
 * filename: Fintual names the cartola after the month only (`cartola_mensual_agosto.pdf`), so a
 * filename key would skip every August after the first, and the certificado is always
 * `certificado.pdf`. The saved copy is date-prefixed for the same reason. Files stay where they
 * land — the importer (`import:fintual-acciones`) reads these folders directly and is
 * idempotent, so there is no inbox hand-off to archive.
 */
import fs from "node:fs";
import path from "node:path";
import { ImapFlow } from "imapflow";
import type { FetchMessageObject } from "imapflow";
import { readKeychainSecret } from "../keychain.js";
import { ensureDir, resolveCfraserDir } from "../paths.js";
import { log, logStep } from "../log.js";
import { hasDocument, recordDocument } from "../documentLedger.js";
import { loadBrokerEmailConfig } from "./fetch.js";
import {
  mailDocumentLedgerKey,
  normalizeMailSubject,
  pdfAttachmentsFromStructure,
  safeAttachmentName,
} from "./santanderDocs.js";

export const FINTUAL_MAIL_SENDER = "hola@fintual.com";

/** Covers one missed month plus mail lag; `--days` widens it for the history backfill. */
const DEFAULT_WINDOW_DAYS = 45;

export type FintualAccionesDoc = {
  /** Document-ledger kind; also what the run summary calls it. */
  kind: string;
  label: string;
  /** Folder under `cfraser/fintual-acciones/`. */
  subdir: string;
  fallbackName: string;
  matchesSubject: (normalizedSubject: string) => boolean;
};

export const FINTUAL_ACCIONES_DOCS: readonly FintualAccionesDoc[] = [
  {
    kind: "email-acciones-cartola",
    label: "cartola mensual de acciones",
    subdir: "cartolas",
    fallbackName: "cartola_mensual.pdf",
    matchesSubject: (s) => s.includes("cartola mensual de acciones"),
  },
  {
    kind: "email-acciones-certificado",
    label: "certificado de eventos de capital en acciones",
    subdir: "certificados",
    fallbackName: "certificado.pdf",
    matchesSubject: (s) => s.includes("certificado de transacciones y eventos de capital"),
  },
] as const;

export function classifyFintualAccionesSubject(subject: string): FintualAccionesDoc | null {
  const normalized = normalizeMailSubject(subject);
  return FINTUAL_ACCIONES_DOCS.find((doc) => doc.matchesSubject(normalized)) ?? null;
}

export function resolveFintualAccionesDir(): string {
  return path.join(resolveCfraserDir(), "fintual-acciones");
}

export type FintualAccionesFetchResult = {
  saved: { kind: string; key: string; file: string }[];
  skipped: { kind: string; key: string; reason: string }[];
  /** A wanted mail whose attachment shape is unmapped — the run must fail loudly. */
  errors: { kind: string; key: string; reason: string }[];
};

export async function fetchFintualAccionesDocuments(opts?: {
  windowDays?: number;
  /** List what would be downloaded without writing anything or touching the ledger. */
  dryRun?: boolean;
}): Promise<FintualAccionesFetchResult> {
  const config = loadBrokerEmailConfig();
  const password = readKeychainSecret(config.keychain_service, config.address);
  const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
  const since = new Date(Date.now() - windowDays * 86_400_000);
  const dryRun = opts?.dryRun === true;

  logStep(`e-mail — Fintual Acciones documents since ${since.toISOString().slice(0, 10)}${dryRun ? " (dry run)" : ""}`);

  const result: FintualAccionesFetchResult = { saved: [], skipped: [], errors: [] };
  const root = dryRun ? null : ensureDir(resolveFintualAccionesDir());

  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.address, pass: password },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      // `subject` narrows server-side to the Acciones mails; the notification mails share the
      // sender and would otherwise all be fetched with their body structures.
      const uids = await client.search({ from: FINTUAL_MAIL_SENDER, since, subject: "Acciones" });
      if (!uids || uids.length === 0) {
        log("e-mail: no Fintual Acciones mail in window");
        return result;
      }

      // Collect first, download after: imapflow cannot serve a download while a fetch stream
      // is still being iterated.
      const candidates: { uid: number; doc: FintualAccionesDoc; msg: FetchMessageObject }[] = [];
      for await (const msg of client.fetch(uids, { envelope: true, bodyStructure: true, uid: true })) {
        const doc = classifyFintualAccionesSubject(String(msg.envelope?.subject ?? ""));
        if (!doc) continue;
        candidates.push({ uid: msg.uid, doc, msg });
      }

      for (const { uid, doc, msg } of candidates) {
        const messageId = String(msg.envelope?.messageId ?? `uid-${uid}`);
        const mailDate = msg.envelope?.date ?? new Date();
        const key = mailDocumentLedgerKey(mailDate, messageId);
        if (hasDocument("fintual", doc.kind, key)) {
          result.skipped.push({ kind: doc.kind, key, reason: "already fetched" });
          continue;
        }

        const attachments = pdfAttachmentsFromStructure(msg.bodyStructure);
        if (attachments.length !== 1) {
          result.errors.push({
            kind: doc.kind,
            key,
            reason: `expected exactly one pdf attachment, got [${attachments.map((a) => a.filename).join(", ") || "none"}]`,
          });
          continue;
        }

        const ymd = mailDate.toISOString().slice(0, 10);
        const name = `${ymd} ${safeAttachmentName(attachments[0]!.filename, doc.fallbackName)}`;
        const relative = path.join(doc.subdir, name);
        if (dryRun) {
          result.saved.push({ kind: doc.kind, key, file: relative });
          continue;
        }

        const download = await client.download(String(uid), attachments[0]!.part, { uid: true });
        const chunks: Buffer[] = [];
        for await (const chunk of download.content) chunks.push(Buffer.from(chunk));
        const target = path.join(ensureDir(path.join(root!, doc.subdir)), name);
        if (fs.existsSync(target)) {
          result.skipped.push({ kind: doc.kind, key, reason: `${relative} already on disk` });
        } else {
          fs.writeFileSync(target, Buffer.concat(chunks));
          result.saved.push({ kind: doc.kind, key, file: relative });
        }
        // Recorded whether it was written or already on disk: either way we have it.
        recordDocument("fintual", doc.kind, key);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  for (const s of result.saved) log(`e-mail: fintual ${s.kind} ${s.key} → ${s.file}`);
  const alreadyCount = result.skipped.filter((s) => s.reason === "already fetched").length;
  for (const s of result.skipped) {
    if (s.reason !== "already fetched") log(`e-mail: fintual ${s.kind} ${s.key} skipped (${s.reason})`);
  }
  if (alreadyCount > 0) log(`e-mail: ${alreadyCount} Fintual Acciones mail(s) already fetched`);
  for (const e of result.errors) log(`e-mail: fintual ${e.kind} ${e.key} ERROR (${e.reason})`);
  if (result.saved.length === 0 && result.errors.length === 0) log("e-mail: no new Fintual Acciones document");
  return result;
}
