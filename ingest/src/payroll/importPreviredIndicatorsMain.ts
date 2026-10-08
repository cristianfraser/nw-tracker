/**
 * Previred's monthly «Indicadores Previsionales» → `payroll.parameters`.
 *
 *   npm run import:previred-indicators [-- --from=YYYY-MM] [--no-fetch] [--dry-run]
 *
 * Fetches the archive page, downloads every month from `--from` (default 2017-05) not staged yet
 * into cfraser/previred-indicadores/<YYYY-MM>.pdf, reads every staged month and sends them all.
 * A document that does not read, or that names another month than its archive link, fails the run.
 */
import fs from "node:fs";
import path from "node:path";
import { payrollParametersKind, type PayrollParametersApplyDetails } from "nw-tracker-contracts";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import {
  parsePreviredIndicators,
  pdfText,
  PREVIRED_ARCHIVE_URL,
  previredArchiveLinks,
  previredIndicatorsDir,
  stagedPreviredFiles,
} from "./previredIndicators.js";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const from = arg("from") ?? "2017-05";
const dryRun = process.argv.includes("--dry-run");
const noFetch = process.argv.includes("--no-fetch");

async function fetchMissing(dir: string): Promise<string[]> {
  const res = await fetch(PREVIRED_ARCHIVE_URL, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`previred archive: HTTP ${res.status}`);
  const links = previredArchiveLinks(await res.text());
  const fetched: string[] = [];
  for (const [month, url] of [...links].sort(([a], [b]) => a.localeCompare(b))) {
    if (month < from) continue;
    const file = path.join(dir, `${month}.pdf`);
    if (fs.existsSync(file)) continue;
    const pdf = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!pdf.ok) throw new Error(`previred ${month}: HTTP ${pdf.status} for ${url}`);
    const bytes = Buffer.from(await pdf.arrayBuffer());
    if (bytes.subarray(0, 4).toString() !== "%PDF") throw new Error(`previred ${month}: not a PDF at ${url}`);
    fs.writeFileSync(file, bytes);
    fetched.push(month);
  }
  return fetched;
}

async function main(): Promise<number> {
  const dir = previredIndicatorsDir();
  fs.mkdirSync(dir, { recursive: true });
  if (!noFetch) {
    const fetched = await fetchMissing(dir);
    console.log(fetched.length ? `fetched ${fetched.join(", ")}` : "no new month in the archive");
  }
  const months = stagedPreviredFiles(dir)
    .filter((f) => f.month >= from)
    .map(({ month, file }) => {
      const p = parsePreviredIndicators(pdfText(file));
      if (p.period_month !== month) throw new Error(`${path.basename(file)} is the indicators of ${p.period_month}`);
      return { ...p, document: path.basename(file) };
    });
  if (months.length === 0) {
    console.log("nothing staged");
    return 0;
  }
  if (dryRun) {
    for (const m of months) console.log(`${m.period_month} cap ${m.pension_cap_uf} UF / ${m.unemployment_cap_uf} UF, employer ${m.afp_employer_rate} %`);
    console.log(`# dry-run: ${months.length} month(s) read, nothing sent`);
    return 0;
  }
  try {
    const result = await ingestClient().send(payrollParametersKind, { months }, { channel: "file", ref: "previred-indicadores" });
    const d = result.details as PayrollParametersApplyDetails;
    for (const c of d.changed) console.log(`  changed ${c}`);
    console.log(`${d.months} month(s) sent: ${d.added.length} new, ${d.changed.length} change(s)`);
    return 0;
  } catch (err) {
    console.error(`FAILED — ${describeIngestFailure(err)}`);
    return 1;
  }
}

process.exitCode = await main();
