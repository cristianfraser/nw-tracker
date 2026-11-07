/**
 * Mail bodies and attachments as the fetchers read them: decoding a MIME body to its text,
 * finding the body and PDF parts in a message's structure, naming what is saved.
 */
import path from "node:path";
import type { MessageStructureObject } from "imapflow";

/**
 * Lowercase, unaccented, whitespace-collapsed.
 *
 * Subjects arrive MIME-encoded and the accents are exactly where a naive `includes` breaks
 * («Crédito»); matching on the unaccented form means a change in the bank's encoding cannot
 * silently stop the whole step.
 */
export function normalizeMailSubject(subject: string): string {
  return String(subject ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** First text/html (or text/plain) body part of a message, for receipt mails. */
export function htmlBodyPartFromStructure(node: MessageStructureObject | undefined): string | null {
  if (!node) return null;
  let plain: string | null = null;
  let html: string | null = null;
  const walk = (n: MessageStructureObject): void => {
    const type = String(n.type ?? "").toLowerCase();
    if (n.part) {
      if (type === "text/html" && html == null) html = String(n.part);
      if (type === "text/plain" && plain == null) plain = String(n.part);
    }
    for (const child of n.childNodes ?? []) walk(child);
  };
  walk(node);
  // Single-part messages have no explicit part number; "TEXT" addresses the whole body.
  if (html == null && plain == null && String(node.type ?? "").toLowerCase().startsWith("text/")) {
    return "TEXT";
  }
  return html ?? plain;
}

/**
 * `2026-08-28-<msgid slug>` — a per-MAIL ledger key, for senders whose attachment names repeat
 * (BCI reuses `155028273.pdf` every month; Fintual's `cartola_mensual_agosto.pdf` comes back
 * every August). Each such document is its own mail, so the message id is the stable identity;
 * the date prefix keeps the ledger readable.
 */
export function mailDocumentLedgerKey(date: Date, messageId: string): string {
  const idSlug = String(messageId ?? "")
    .replace(/[^A-Za-z0-9@._-]/g, "_")
    .slice(0, 80);
  return `${date.toISOString().slice(0, 10)}-${idSlug}`;
}

/** Ledger period for a message: the Chile calendar month it was sent in. */
export function mailPeriodKey(date: Date): string {
  const chile = new Date(date.toLocaleString("en-US", { timeZone: "America/Santiago" }));
  return `${chile.getFullYear()}-${String(chile.getMonth() + 1).padStart(2, "0")}`;
}

export type AttachmentNode = { part: string; filename: string };

/**
 * Every PDF attachment in a message body structure.
 *
 * These templates carry inline logos and a multipart alternative body; only nodes that actually
 * name a `.pdf` file are documents.
 */
export function pdfAttachmentsFromStructure(node: MessageStructureObject | undefined): AttachmentNode[] {
  if (!node) return [];
  const found: AttachmentNode[] = [];
  const walk = (n: MessageStructureObject): void => {
    const filename = String(n.dispositionParameters?.filename ?? n.parameters?.name ?? "").trim();
    if (filename.toLowerCase().endsWith(".pdf") && n.part) {
      found.push({ part: String(n.part), filename });
    }
    for (const child of n.childNodes ?? []) walk(child);
  };
  walk(node);
  return found;
}

/**
 * A filename that cannot escape the inbox.
 *
 * The name comes from an e-mail, so it is attacker-controllable in principle; anything with a path
 * separator is reduced to its basename and the rest is whitelisted.
 */
export function safeAttachmentName(filename: string, fallback: string): string {
  const base = path.basename(String(filename ?? "").replace(/\\/g, "/")).trim();
  const cleaned = base.replace(/[^A-Za-z0-9 ._-]/g, "_");
  if (!cleaned || cleaned.startsWith(".") || !cleaned.toLowerCase().endsWith(".pdf")) return fallback;
  return cleaned;
}

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
export function mimeBodyToText(raw: string, maxChars = 2400): string {
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

export function decodedBodyText(source: Buffer): string {
  return mimeBodyToText(entityText(source.toString("latin1")), 8000).replace(/\s+/g, " ").trim();
}

