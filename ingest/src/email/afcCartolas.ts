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
import { execFileSync } from "node:child_process";
import { loadBankConfig } from "../config.js";
import { resolveCfraserDir } from "../paths.js";
import { singlePdfDocument, type MailSource } from "./mailFetcher.js";
import { normalizeMailSubject } from "./mime.js";

export const AFC_CARTOLA_SENDER = "cartolasafc@afc.cl";

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

/** The AFC cartola mails; the password is read when the first document is written. */
export const AFC_CARTOLAS_SOURCE: MailSource = {
  label: "AFC cartolas",
  ledger: "afc",
  query: { from: AFC_CARTOLA_SENDER },
  kindOf: (subject) => (isAfcCartolaSubject(subject) ? "email-cartola" : null),
  documents: (mail) => [
    singlePdfDocument(mail, {
      dir: resolveAfcCartolasDir,
      fallbackName: "afc-cartola.pdf",
      shape: "pdf attachment",
      afterWrite: (file) => decryptAfcCartola(file, afcCartolaPassword(loadBankConfig("afc").rut)),
    }),
  ],
};
