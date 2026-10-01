import fs from "node:fs";
import path from "node:path";
import { resolveBrokerEmailDir } from "../email/fetch.js";
import { scanBrokerEmails, type BrokerEmailInput, type BrokerEmailScan } from "./brokerEmail.js";

/**
 * Every broker e-mail `fetch:emails` staged (`cfraser/broker-emails/scan-*.json`), classified.
 * Scans accumulate and overlap — a mail can sit in several — and are all re-read every run; the
 * classifier collapses copies by Message-ID.
 */
export function readStagedBrokerEmails(dir = resolveBrokerEmailDir()): { files: string[]; scan: BrokerEmailScan } {
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((n) => /^scan-.*\.json$/.test(n)).sort().map((n) => path.join(dir, n))
    : [];
  const inputs = files.flatMap((f) => JSON.parse(fs.readFileSync(f, "utf8")) as BrokerEmailInput[]);
  return { files, scan: scanBrokerEmails(inputs) };
}
