/**
 * Apple's App Store receipts and subscription notices out of Gmail into `cfraser/apple-mail/`.
 *
 * Each wanted mail is staged as `{message_id, subject, date, html}` (the decoded HTML body; the
 * decoder needs its layout and artwork links) under a message-id-keyed ledger: every receipt is
 * its own mail, so the message id is the document's identity. `import:apple-mail` decodes and
 * sends them. The search runs over All Mail, since these mails are often archived unread.
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../paths.js";
import { APPLE_MAIL_SENDER, appleMailKind, appleMailStagingDir, type StagedAppleMail } from "../apple/appStoreMail.js";
import type { MailSource } from "./mailFetcher.js";

export const APPLE_MAIL_SOURCE: MailSource = {
  label: "Apple receipts and subscription notices",
  ledger: "apple",
  query: { from: APPLE_MAIL_SENDER },
  kindOf: (subject) => (appleMailKind(subject) == null ? null : "email-app-store"),
  documents(mail) {
    const bodyPart = mail.bodyPart;
    if (!bodyPart) return [{ key: mail.mailKey, error: `Apple mail without a body part: ${mail.subject}` }];
    return [
      {
        key: mail.mailKey,
        file: `${mail.mailKey}.json`,
        async write(read) {
          const { bytes, charset } = await read.part(bodyPart === "TEXT" ? undefined : bodyPart);
          const html = new TextDecoder(charset === "us-ascii" ? "utf-8" : charset).decode(bytes);
          const staged: StagedAppleMail = { message_id: mail.messageId, subject: mail.subject, date: mail.date.toISOString(), html };
          fs.writeFileSync(path.join(ensureDir(appleMailStagingDir()), `${mail.mailKey}.json`), JSON.stringify(staged));
          return { written: true };
        },
      },
    ];
  },
};
