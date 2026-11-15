/** One sender (or one layout of a shop platform) of receipt mails and its decoder. */
import type { ProcessorReceipt } from "nw-tracker-contracts";
import type { ArchivedMail } from "../email/mailFetcher.js";

export type PaymentProcessor = {
  slug: string;
  /** IMAP FROM match… */
  from?: string;
  /** …or a Gmail search query (a platform many shops mail from). */
  gmraw?: string;
  /** The subjects that may be a receipt (envelope filter). */
  wantSubject: (subject: string) => boolean;
  /** PDF attachments to stage with the mail (the receipt is in the PDF), by file name. */
  pdfAttachment?: (filename: string) => boolean;
  decode: (mail: ArchivedMail) => ProcessorReceipt | null;
};
