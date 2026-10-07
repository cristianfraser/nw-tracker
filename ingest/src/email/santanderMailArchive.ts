/**
 * Stage Santander's transactional mails for a date range: what the bank mails for each card payment,
 * transfer, scheduled transfer, bill payment and dollar purchase, plus the monthly «Paga tu estado
 * de cuenta nacional» notice that states the card's monto facturado.
 *
 * A record of last resort: a month whose cartola or card statement is lost (the bank no longer
 * serves it, and the mail of the day carried only a «see Mis Documentos» notice) can be rebuilt
 * from these, one movement per mail. Nothing is decoded here: each mail is staged as its sending
 * time on the Chile clock (the bank day ends at 14:00 — the posting day is derived from it), its
 * subject and its text, and the script that rebuilds the gap reads them.
 *
 * Read-only on the mailbox (All Mail, so archived mail counts too).
 */
import fs from "node:fs";
import path from "node:path";
import { ImapFlow } from "imapflow";
import { readKeychainSecret } from "../keychain.js";
import { ensureDir, resolveCfraserDir } from "../paths.js";
import { log, logStep } from "../log.js";
import { loadBrokerEmailConfig, mimeBodyToText } from "./fetch.js";

export type SantanderArchivedMail = {
  message_id: string;
  /** Sending time on the Chile clock, `YYYY-MM-DD HH:MM`. */
  sent_at_chile: string;
  from: string;
  subject: string;
  text: string;
};

/** The subjects that state a movement; marketing and notices are left out. */
const TRANSACTIONAL_SUBJECT =
  /^(Comprobante|Aviso de transferencia|Aviso de Transferencias?|Transferencia|Compra de divisas|Paga tu estado de cuenta)/i;

/** The card's monthly facturado notice, sent under several marketing subjects. */
const FACTURADO_TEXT = /monto total facturado/i;

const chileClock = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "America/Santiago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** One MIME entity's text: its own body decoded, or its text parts' when it is multipart. */
function entityText(raw: string): string {
  const cut = raw.search(/\r?\n\r?\n/);
  if (cut < 0) throw new Error("mail part without a header/body separator");
  const head = raw.slice(0, cut);
  const body = raw.slice(cut).replace(/^\s+/, "");
  const boundary = head.match(/boundary="?([^";\r\n]+)"?/i)?.[1];
  if (/Content-Type:\s*multipart\//i.test(head)) {
    if (!boundary) throw new Error("multipart mail without a boundary");
    const parts = body
      .split(`--${boundary}`)
      .slice(1)
      .filter((p) => !p.startsWith("--"));
    const texts = parts.map((p) => ({ html: /Content-Type:\s*text\/html/i.test(p), text: entityText(p.replace(/^\r?\n/, "")) }));
    const pick = texts.find((t) => t.html && t.text) ?? texts.find((t) => t.text);
    return pick?.text ?? "";
  }
  if (/Content-Type:/i.test(head) && !/Content-Type:\s*text\//i.test(head)) return "";
  return /Content-Transfer-Encoding:\s*base64/i.test(head)
    ? Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8")
    : body;
}

function decodedBodyText(source: Buffer): string {
  return mimeBodyToText(entityText(source.toString("latin1")), 8000).replace(/\s+/g, " ").trim();
}

export async function archiveSantanderMails(opts: {
  fromYmd: string;
  toYmd: string;
}): Promise<{ file: string; count: number }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.fromYmd) || !/^\d{4}-\d{2}-\d{2}$/.test(opts.toYmd)) {
    throw new Error(`--from / --to must be YYYY-MM-DD (got ${opts.fromYmd} / ${opts.toYmd})`);
  }
  const config = loadBrokerEmailConfig();
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.address, pass: readKeychainSecret(config.keychain_service, config.address) },
    logger: false,
  });
  logStep(`e-mail — Santander transactional mails ${opts.fromYmd} → ${opts.toYmd}`);
  await client.connect();
  const mails: SantanderArchivedMail[] = [];
  try {
    const allMail = (await client.list()).find((b) => b.specialUse === "\\All");
    if (!allMail) throw new Error("No All Mail folder on this account");
    const lock = await client.getMailboxLock(allMail.path, { readOnly: true });
    try {
      // A day either side: SINCE / BEFORE are evaluated on the account's own clock.
      const since = new Date(`${opts.fromYmd}T00:00:00Z`);
      since.setUTCDate(since.getUTCDate() - 1);
      const before = new Date(`${opts.toYmd}T00:00:00Z`);
      before.setUTCDate(before.getUTCDate() + 2);
      const uids = (await client.search({ from: "santander.cl", since, before })) || [];
      for await (const msg of client.fetch(uids as number[], { envelope: true, source: true, uid: true })) {
        const subject = String(msg.envelope?.subject ?? "").trim();
        const date = msg.envelope?.date;
        if (!date) throw new Error(`mail ${msg.uid} «${subject}» has no date`);
        const sent = chileClock.format(date).replace(",", "");
        if (sent.slice(0, 10) < opts.fromYmd || sent.slice(0, 10) > opts.toYmd) continue;
        if (!msg.source) throw new Error(`mail ${msg.uid} «${subject}» came without its source`);
        const text = decodedBodyText(msg.source);
        if (!TRANSACTIONAL_SUBJECT.test(subject) && !FACTURADO_TEXT.test(text)) continue;
        mails.push({
          message_id: String(msg.envelope?.messageId ?? `uid-${msg.uid}`),
          sent_at_chile: sent,
          from: String(msg.envelope?.from?.[0]?.address ?? ""),
          subject,
          text,
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
  mails.sort((a, b) => a.sent_at_chile.localeCompare(b.sent_at_chile));
  const dir = ensureDir(path.join(resolveCfraserDir(), "santander-mail-archive"));
  const file = path.join(dir, `${opts.fromYmd}_${opts.toYmd}.json`);
  fs.writeFileSync(file, `${JSON.stringify(mails, null, 2)}\n`);
  log(`e-mail: ${mails.length} transactional mail(s) → ${file}`);
  return { file, count: mails.length };
}
