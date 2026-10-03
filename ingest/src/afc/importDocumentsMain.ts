/**
 * Rebuild / reconcile the AFC cuota ledger from the AFC documents: read the certificate and the
 * cartolas and send them to the server as one `unemployment_fund.documents`.
 *
 *   npm run import:afc-cert -- --cert=<certificado de cotizaciones.pdf> \
 *       [--cartola=<estado cuatrimestral.pdf> …] [--replace-excel-rows] [--drop-ids=1,2] [--account-id=NN] [--apply]
 *
 * Without --apply the server rolls the whole rebuild back after its report, so the report shows
 * the exact post-import ledger and writes nothing. Exit status: non-zero when a document does not
 * parse, or the server refuses it or is down.
 */
import { unemploymentFundDocumentsKind, type UnemploymentFundDocumentsApplyDetails } from "nw-tracker-contracts";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import { parseAfcCartola, parseAfcCotizacionesCertificate, pdfTextLayout, unemploymentFundDocumentsPayload } from "./documents.js";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const args = (name: string) => process.argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));

async function main(): Promise<number> {
  const certPath = arg("cert");
  if (!certPath) {
    console.error("--cert=<pdf> is required");
    return 2;
  }
  const payload = unemploymentFundDocumentsPayload(
    parseAfcCotizacionesCertificate(pdfTextLayout(certPath)),
    args("cartola").map((p) => parseAfcCartola(pdfTextLayout(p))),
    {
      apply: process.argv.includes("--apply"),
      accountId: arg("account-id") != null ? Number(arg("account-id")) : null,
      replaceExcelRows: process.argv.includes("--replace-excel-rows"),
      dropMovementIds: (arg("drop-ids") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number),
    }
  );
  try {
    const result = await ingestClient().send(unemploymentFundDocumentsKind, payload, { channel: "file", ref: certPath.split("/").pop()! });
    for (const line of (result.details as UnemploymentFundDocumentsApplyDetails).report) console.log(line);
    return 0;
  } catch (err) {
    console.error(`FAILED — ${describeIngestFailure(err)}`);
    return 1;
  }
}

process.exitCode = await main();
