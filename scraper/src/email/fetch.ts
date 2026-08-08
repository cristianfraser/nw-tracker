/**
 * Fetch broker notification e-mails over IMAP.
 *
 * This is the cheap change detector the rest of the pipeline hangs off: reading mail costs no
 * bank session, no 2FA and no reputation, so it runs first and decides whether any browser
 * needs to open at all.
 *
 * It deliberately only fetches ENVELOPES plus the short text preview — never attachments, and
 * never the full HTML body (~30KB of table markup per message carrying nothing the subject
 * lacks). Classification happens on the nw-tracker side (`brokerEmailParse.ts`), so this file
 * has one job: get the metadata out of Gmail and onto disk.
 *
 * Auth is an app password in the macOS Keychain, same as the bank logins. It is read at use and
 * never logged or written to disk.
 */
import fs from "node:fs";
import path from "node:path";
import { ImapFlow } from "imapflow";
import { readKeychainSecret } from "../keychain.js";
import { ensureDir, resolveCfraserDir } from "../paths.js";
import { log, logStep } from "../log.js";

export const BROKER_EMAIL_KEYCHAIN_SERVICE = "nw-tracker-gmail";

/** Senders worth fetching. Newsletters are excluded here so they never reach the classifier. */
export const BROKER_EMAIL_SENDERS = [
  "hola@fintual.com",
  "notificaciones@acciones.fintual.com",
  "racional@racional.cl",
  "notificaciones@notificaciones.racional.cl",
] as const;

export type BrokerEmailConfig = {
  /** Gmail address; also the Keychain account for the app password. */
  address: string;
  keychain_service: string;
  host: string;
  port: number;
};

export function resolveBrokerEmailConfigPath(): string {
  return path.join(resolveCfraserDir(), "email-fetch.json");
}

export function loadBrokerEmailConfig(): BrokerEmailConfig {
  const file = resolveBrokerEmailConfigPath();
  if (!fs.existsSync(file)) {
    throw new Error(
      `Missing ${file}. Create it with:\n` +
        `{\n  "address": "you@gmail.com",\n  "keychain_service": "${BROKER_EMAIL_KEYCHAIN_SERVICE}"\n}\n\n` +
        `Then store a Gmail APP PASSWORD (not the account password — needs 2FA enabled on the\n` +
        `Google account, https://myaccount.google.com/apppasswords):\n` +
        `  security add-generic-password -s ${BROKER_EMAIL_KEYCHAIN_SERVICE} -a "you@gmail.com" -w`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<BrokerEmailConfig>;
  const address = String(raw.address ?? "").trim();
  if (!address) throw new Error(`${file} is missing "address".`);
  return {
    address,
    keychain_service: String(raw.keychain_service ?? BROKER_EMAIL_KEYCHAIN_SERVICE).trim(),
    host: String(raw.host ?? "imap.gmail.com").trim(),
    port: Number(raw.port ?? 993),
  };
}

/** Where scans are staged for the nw-tracker side to classify. */
export function resolveBrokerEmailDir(): string {
  return path.join(resolveCfraserDir(), "broker-emails");
}

export function resolveBrokerEmailStatePath(): string {
  return path.join(resolveCfraserDir(), ".broker-email-state.json");
}

export type BrokerEmailState = {
  /** Highest INTERNALDATE already scanned, ISO. Only newer mail is fetched next time. */
  last_seen_at: string | null;
  updated_at: string;
};

export function readBrokerEmailState(): BrokerEmailState | null {
  const file = resolveBrokerEmailStatePath();
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as BrokerEmailState;
  } catch {
    return null;
  }
}

export function writeBrokerEmailState(lastSeenAt: string, nowIso: string): void {
  fs.writeFileSync(
    resolveBrokerEmailStatePath(),
    `${JSON.stringify({ last_seen_at: lastSeenAt, updated_at: nowIso }, null, 2)}\n`,
  );
}

export type FetchedEmail = {
  message_id: string;
  sender: string;
  subject: string;
  /** First ~400 chars of the text body — where Racional prints units and price. */
  snippet: string;
  date: string;
};

/**
 * Raw MIME body → the visible text the classifier reads.
 *
 * IMAP hands back the part verbatim, which for these senders is quoted-printable HTML
 * (`=3D` for `=`, soft line breaks as a trailing `=`), not the tidy preview Gmail's web API
 * shows. Without decoding, every body-derived field — Racional's «Acciones compradas …» line,
 * Fintual's withdrawal amount — silently fails to match.
 *
 * `<style>`/`<head>` are dropped before tags are stripped: these templates carry ~20KB of CSS
 * that would otherwise become the entire "preview".
 */
export function mimeBodyToText(raw: string, maxChars = 600): string {
  let text = String(raw ?? "");

  // Quoted-printable: soft line breaks first, then escapes.
  if (/=[0-9A-F]{2}/i.test(text) || /=\r?\n/.test(text)) {
    text = text
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-F]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }

  text = text
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");

  const entities: Record<string, string> = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&oacute;": "ó",
    "&aacute;": "á",
    "&eacute;": "é",
    "&iacute;": "í",
    "&uacute;": "ú",
    "&ntilde;": "ñ",
  };
  for (const [entity, char] of Object.entries(entities)) {
    text = text.replaceAll(entity, char);
  }
  // Whatever is left is preheader padding: these templates pad the preview with hundreds of
  // `&#847;&zwnj;` pairs (invisible spacers), which would otherwise BE the preview.
  text = text.replace(/&#\d+;/g, " ").replace(/&[a-zA-Z]+;/g, " ");
  // UTF-8 arriving as latin-1 after QP decoding (Ã³ → ó and friends).
  try {
    if (/Ã[-¿]/.test(text)) {
      text = Buffer.from(text, "latin1").toString("utf8");
    }
  } catch {
    /* leave as-is */
  }

  return text.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

/**
 * Fetch broker mail newer than the watermark.
 *
 * `sinceDays` is a floor for the very first run (no watermark yet) so it does not walk years of
 * archive; afterwards the watermark is what bounds it.
 */
export async function fetchBrokerEmails(opts?: {
  sinceDays?: number;
  markSeen?: boolean;
}): Promise<{ emails: FetchedEmail[]; file: string | null; newestAt: string | null }> {
  const config = loadBrokerEmailConfig();
  const password = readKeychainSecret(config.keychain_service, config.address);
  const state = readBrokerEmailState();

  // An explicit --since overrides the watermark: it is how you re-read a window after changing
  // the parser, which is otherwise impossible once the watermark has moved past it.
  const explicitSince = opts?.sinceDays != null;
  const sinceDays = opts?.sinceDays ?? 7;
  const floor = new Date(Date.now() - sinceDays * 86_400_000);
  const since = !explicitSince && state?.last_seen_at ? new Date(state.last_seen_at) : floor;

  logStep(`e-mail — fetching broker mail since ${since.toISOString()}`);
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.address, pass: password },
    logger: false,
  });

  const emails: FetchedEmail[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      // One search per sender: Gmail's IMAP OR syntax is awkward and this is a handful of
      // round trips on a mailbox we have already narrowed by date.
      for (const sender of BROKER_EMAIL_SENDERS) {
        const uids = await client.search({ from: sender, since });
        if (!uids || uids.length === 0) continue;
        for await (const msg of client.fetch(uids, { envelope: true, bodyParts: ["text"] })) {
          const envelope = msg.envelope;
          if (!envelope) continue;
          const from = envelope.from?.[0];
          const bodyPart = msg.bodyParts?.get("text");
          emails.push({
            message_id: String(envelope.messageId ?? msg.uid),
            sender: from ? `${from.address ?? ""}` : sender,
            subject: String(envelope.subject ?? ""),
            snippet: mimeBodyToText(bodyPart ? bodyPart.toString("utf8") : ""),
            date: (envelope.date ?? new Date()).toISOString(),
          });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  emails.sort((a, b) => a.date.localeCompare(b.date));
  const newestAt = emails.length > 0 ? emails[emails.length - 1]!.date : null;
  log(`e-mail: ${emails.length} broker message(s)`);

  if (emails.length === 0) return { emails, file: null, newestAt: null };

  const dir = ensureDir(resolveBrokerEmailDir());
  const stamp = newestAt!.replace(/[:.]/g, "-");
  const file = path.join(dir, `scan-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(emails, null, 2));
  log(`e-mail: → ${file}`);

  // The watermark advances only once the scan is safely on disk.
  if (opts?.markSeen !== false) writeBrokerEmailState(newestAt!, new Date().toISOString());

  return { emails, file, newestAt };
}
