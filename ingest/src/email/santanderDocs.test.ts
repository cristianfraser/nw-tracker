import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mailKindOf, type MailDocument, type MailReader, type WantedMail } from "./mailFetcher.js";
import {
  SANTANDER_DOCS_SOURCE,
  SANTANDER_PDF_MAIL_KIND,
  SANTANDER_PDF_MAIL_MAX_ATTACHMENT_BYTES,
  SANTANDER_PDF_MAIL_MAX_ATTACHMENTS,
  attachmentDocuments,
  disambiguatedInboxName,
  santanderAttachmentLedgerKey,
  santanderMailKind,
} from "./santanderDocs.js";

describe("santanderMailKind", () => {
  it("recognises the titles in use since October 2026, whatever the accents, case or trailing dots", () => {
    for (const subject of [
      "Tarjetas Crédito Nacional Personas",
      "Tarjetas Crédito Internacional Personas",
      "TARJETAS CREDITO INTERNACIONAL PERSONAS.",
      "  tarjetas  credito nacional personas ",
    ]) {
      expect(santanderMailKind(subject), subject).toBe("email-cc-statement");
    }
    for (const subject of ["Cuenta Corriente Persona", "Cuentamática Persona", "CUENTAMATICA PERSONA.", "cuenta corriente persona ..."]) {
      expect(santanderMailKind(subject), subject).toBe("email-cartola");
    }
  });

  it("still recognises the titles mailed before", () => {
    expect(santanderMailKind("Estado de Cuenta Tarjeta de Crédito")).toBe("email-cc-statement");
    expect(santanderMailKind("Cartola Mensual de Cuentas.")).toBe("email-cartola");
    expect(santanderMailKind("Pago Deuda Nacional TCR")).toBe("email-cc-payment-receipt");
  });

  it("takes no other mail from the sender", () => {
    for (const subject of ["Tarjetas de crédito: conoce tus beneficios", "Tu cuenta corriente persona ya está lista", "Cuenta Corriente Empresas", "Novedades Santander"]) {
      expect(santanderMailKind(subject), subject).toBeNull();
    }
  });
});

const mail = (messageId: string, filenames: string[]): WantedMail => ({
  uid: 1,
  messageId,
  subject: "Tarjetas Crédito Nacional Personas",
  date: new Date("2026-10-28T12:00:00Z"),
  kind: "email-cc-statement",
  mailKey: `2026-10-28-${messageId}`,
  pdfs: filenames.map((filename, i) => ({ part: String(i + 2), filename })),
  bodyPart: null,
});

describe("santander attachment ledger keys", () => {
  it("keys an old self-describing name by the name alone", () => {
    expect(santanderAttachmentLedgerKey("2026-07-23-m1", "80_16448_000000000000_20260723.pdf")).toBe("80_16448_000000000000_20260723.pdf");
    expect(santanderAttachmentLedgerKey("2026-07-31-m2", "1_1054_000000012345_31072026_CC.pdf")).toBe("1_1054_000000012345_31072026_CC.pdf");
  });

  it("keys a name that carries no date by its mail, so a number the bank reuses next month is fetched again", () => {
    expect(santanderAttachmentLedgerKey("2026-10-28-m1", "TC_NAC-1111_222222.pdf")).toBe("2026-10-28-m1/TC_NAC-1111_222222.pdf");
    expect(santanderAttachmentLedgerKey("2026-11-27-m9", "TC_NAC-1111_222222.pdf")).not.toBe(
      santanderAttachmentLedgerKey("2026-10-28-m1", "TC_NAC-1111_222222.pdf")
    );
  });

  it("gives the two same-day statement mails a key each, and each attachment of a cartola mail its own", () => {
    const national = attachmentDocuments(mail("m1", ["TC_NAC-1111_222222.pdf"]));
    const international = attachmentDocuments(mail("m2", ["TC_INT-1113_333333.pdf"]));
    const cartolas = attachmentDocuments(mail("m3", ["LCA_CTA_CTE_CRONO-11_444444.pdf", "LCA_CTA_CTE_CARABO-12_555555.pdf"]));
    const keys = [...national, ...international, ...cartolas].map((d) => d.key);
    expect(new Set(keys).size).toBe(4);
    expect(cartolas.map((d) => ("file" in d ? d.file : null))).toEqual(["LCA_CTA_CTE_CRONO-11_444444.pdf", "LCA_CTA_CTE_CARABO-12_555555.pdf"]);
  });
});

describe("which Santander mails are fetched, and under which ledger kind", () => {
  const pdf = [{ part: "2", filename: "NUEVO_DOC-1_2.pdf" }];

  it("fetches a PDF under a subject no kind names, under the generic kind", () => {
    expect(mailKindOf(SANTANDER_DOCS_SOURCE, "Tarjetas Crédito Personas Premium", pdf)).toBe(SANTANDER_PDF_MAIL_KIND);
    expect(mailKindOf(SANTANDER_DOCS_SOURCE, "Novedades Santander", pdf)).toBe(SANTANDER_PDF_MAIL_KIND);
  });

  it("keeps the known subjects' kinds, so nothing recorded under them is fetched again", () => {
    expect(mailKindOf(SANTANDER_DOCS_SOURCE, "Cuenta Corriente Persona", pdf)).toBe("email-cartola");
    expect(mailKindOf(SANTANDER_DOCS_SOURCE, "Tarjetas Crédito Nacional Personas", pdf)).toBe("email-cc-statement");
    expect(mailKindOf(SANTANDER_DOCS_SOURCE, "Estado de Cuenta Tarjeta de Crédito", pdf)).toBe("email-cc-statement");
  });

  it("takes a payment receipt by its subject alone: its body is the document", () => {
    expect(mailKindOf(SANTANDER_DOCS_SOURCE, "Pago Deuda Nacional TCR", [])).toBe("email-cc-payment-receipt");
  });

  it("leaves alone a mail of another subject without a PDF, and a known document subject without one keeps its kind", () => {
    expect(mailKindOf(SANTANDER_DOCS_SOURCE, "Novedades Santander", [])).toBeNull();
    expect(mailKindOf(SANTANDER_DOCS_SOURCE, "Cuenta Corriente Persona", [])).toBe("email-cartola");
    expect(attachmentDocuments({ ...mail("m9", []), kind: "email-cartola" })).toEqual([{ key: "2026-10-28-m9", skip: "no pdf attachment" }]);
  });

  it("takes nothing by PDF from a source that does not declare a kind for it", () => {
    expect(mailKindOf({ kindOf: () => null }, "Novedades", pdf)).toBeNull();
  });

  it("bounds a generic mail: too many PDFs refuses the mail, an oversized PDF refuses that attachment", () => {
    const generic = (filenames: string[], size?: number) => ({
      ...mail("m8", filenames),
      kind: SANTANDER_PDF_MAIL_KIND,
      pdfs: filenames.map((filename, i) => ({ part: String(i + 2), filename, ...(size != null ? { size } : {}) })),
    });
    const many = Array.from({ length: SANTANDER_PDF_MAIL_MAX_ATTACHMENTS + 1 }, (_, i) => `D-${i}.pdf`);
    const tooMany = attachmentDocuments(generic(many));
    expect(tooMany).toHaveLength(1);
    expect(tooMany[0]).toMatchObject({ key: "2026-10-28-m8" });
    expect("refuse" in tooMany[0]! && tooMany[0].refuse).toContain("11 PDF attachments");
    expect(attachmentDocuments(generic(many.slice(0, SANTANDER_PDF_MAIL_MAX_ATTACHMENTS))).every((d) => "write" in d)).toBe(true);

    const [big] = attachmentDocuments(generic(["BIG-1_2.pdf"], SANTANDER_PDF_MAIL_MAX_ATTACHMENT_BYTES + 1));
    expect(big).toMatchObject({ key: "2026-10-28-m8/BIG-1_2.pdf" });
    expect("refuse" in big!).toBe(true);
    expect("write" in attachmentDocuments(generic(["OK-1_2.pdf"], SANTANDER_PDF_MAIL_MAX_ATTACHMENT_BYTES))[0]!).toBe(true);
  });

  it("leaves a known subject's mail unbounded", () => {
    const many = Array.from({ length: SANTANDER_PDF_MAIL_MAX_ATTACHMENTS + 1 }, (_, i) => `D-${i}.pdf`);
    const docs = attachmentDocuments({
      ...mail("m6", many),
      pdfs: many.map((filename, i) => ({ part: String(i + 2), filename, size: SANTANDER_PDF_MAIL_MAX_ATTACHMENT_BYTES * 2 })),
    });
    expect(docs.every((d) => "write" in d)).toBe(true);
  });

  it("keys a generic mail's attachments like any other mail's", () => {
    const docs = attachmentDocuments({ ...mail("m7", ["NUEVO_DOC-1_2.pdf"]), kind: SANTANDER_PDF_MAIL_KIND, subject: "Novedades" });
    expect(docs.map((d) => d.key)).toEqual(["2026-10-28-m7/NUEVO_DOC-1_2.pdf"]);
  });
});

describe("attachment write into the inbox", () => {
  let inbox: string;
  const previous = process.env.CFRASER_INBOX_DIR;
  beforeEach(() => {
    inbox = fs.mkdtempSync(path.join(os.tmpdir(), "santander-docs-"));
    process.env.CFRASER_INBOX_DIR = inbox;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.CFRASER_INBOX_DIR;
    else process.env.CFRASER_INBOX_DIR = previous;
    fs.rmSync(inbox, { recursive: true, force: true });
  });
  const reader = (bytes: string): MailReader => ({
    part: async () => ({ bytes: Buffer.from(bytes), charset: "utf-8" }),
    bodyText: async () => "",
  });
  const writeOf = (doc: MailDocument) => {
    if (!("write" in doc)) throw new Error("expected a writable document");
    return doc.write;
  };

  it("skips the same bytes already in the inbox", async () => {
    fs.writeFileSync(path.join(inbox, "TC_NAC-1_2.pdf"), "same");
    const [doc] = attachmentDocuments(mail("m1", ["TC_NAC-1_2.pdf"]));
    expect(await writeOf(doc!)(reader("same"))).toEqual({ already: "TC_NAC-1_2.pdf already in inbox" });
  });

  it("saves another document under a reused bank name beside it, under a name taken from the mail", async () => {
    fs.writeFileSync(path.join(inbox, "TC_NAC-1_2.pdf"), "first");
    const m = mail("m2", ["TC_NAC-1_2.pdf"]);
    const [doc] = attachmentDocuments(m);
    expect(await writeOf(doc!)(reader("second"))).toEqual({ written: true });
    const other = disambiguatedInboxName(m, "TC_NAC-1_2.pdf");
    expect(other).toMatch(/^2026-10-28_[0-9a-f]{8}_TC_NAC-1_2\.pdf$/);
    expect(fs.readFileSync(path.join(inbox, other), "utf8")).toBe("second");
    expect(fs.readFileSync(path.join(inbox, "TC_NAC-1_2.pdf"), "utf8")).toBe("first");
  });
});
