/**
 * Fetch Lider «Boleta Digital» e-mails out of Gmail into `cfraser/lider-boletas/staged/`.
 *
 * Every in-store purchase mails a receipt from contacto@info.lider.cl («Boleta Digital Lider» /
 * «Boleta Digital Lider Express»). The receipt itself is the `Boleta.pdf` ATTACHMENT — the HTML
 * body only carries the sucursal line and Mi Club points — so each staged document is a
 * directory holding the PDF plus a `meta.json` with the envelope and the flattened body text
 * (the server-side importer reads the sucursal from it and parses the PDF for items).
 *
 * The mail date is UTC and a Chilean evening purchase crosses midnight UTC — the movement date
 * therefore comes from the PDF's printed local datetime downstream, never from the mail date;
 * the mail date here is only used for the staging directory name and the search window.
 *
 * Ledger: one entry per message id (`lider` / `email-boleta`), so each boleta is fetched once
 * and a widened window (`--days`, or `--all` for the full-history backfill) never re-downloads.
 * A mail without exactly one `Boleta.pdf` is skipped and not recorded.
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDir, resolveCfraserDir } from "../paths.js";
import type { MailSource } from "./mailFetcher.js";
import { normalizeMailSubject } from "./mime.js";

export const LIDER_BOLETA_SENDER = "contacto@info.lider.cl";

export function liderBoletasStagingDir(): string {
  return path.join(resolveCfraserDir(), "lider-boletas", "staged");
}

export const LIDER_BOLETAS_SOURCE: MailSource = {
  label: "Lider boletas",
  ledger: "lider",
  query: { from: LIDER_BOLETA_SENDER },
  kindOf: (subject) => (normalizeMailSubject(subject).includes("boleta") ? "email-boleta" : null),
  // Full-history backfill bound; the mailbox is younger than this.
  allHistoryDays: 3650,
  documents(mail) {
    // The receipt is the attachment named Boleta.pdf; «Ticket de promoción.pdf» is noise.
    const boletas = mail.pdfs.filter((a) => /^boleta/i.test(a.filename.trim()));
    if (boletas.length !== 1) {
      return [{ key: mail.mailKey, skip: `expected exactly one Boleta.pdf attachment, found ${boletas.length}` }];
    }
    return [
      {
        key: mail.mailKey,
        file: "Boleta.pdf",
        async write(read) {
          const bodyText = await read.bodyText(1500);
          const pdf = (await read.part(boletas[0]!.part)).bytes;
          const dir = ensureDir(path.join(liderBoletasStagingDir(), mail.mailKey));
          fs.writeFileSync(path.join(dir, "Boleta.pdf"), pdf);
          fs.writeFileSync(
            path.join(dir, "meta.json"),
            JSON.stringify({ message_id: mail.messageId, subject: mail.subject, date: mail.date.toISOString(), body_text: bodyText }, null, 2)
          );
          return { written: true };
        },
      },
    ];
  },
};
