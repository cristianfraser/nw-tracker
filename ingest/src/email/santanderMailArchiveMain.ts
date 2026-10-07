/**
 * Stage Santander's transactional mails for a date range into `cfraser/santander-mail-archive/`.
 *
 *   npm run fetch:santander-mail-archive -- --from=2019-06-25 --to=2020-01-05
 */
import { archiveSantanderMails } from "./santanderMailArchive.js";
import { log } from "../log.js";

const argv = process.argv.slice(2);
const arg = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? "";

archiveSantanderMails({ fromYmd: arg("from"), toYmd: arg("to") })
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err: unknown) => {
    log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
