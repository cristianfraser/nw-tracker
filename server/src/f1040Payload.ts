/**
 * The /tax-return page's US tab: the local Form 1040 for one tax year as ordered rows (the client
 * only labels and formats them), the W-2s behind line 1a, FICA reported beside the return, the
 * filed return and its settlement. Server: f1040Draft.ts, f1040Filed.ts.
 */
import type { UsTaxReturnResponse, UsTaxReturnRow, UsTaxReturnRowSection } from "nw-tracker-contracts/dto/taxReturn";
import { chileWallClockNow } from "./chileDate.js";
import { availableUsTaxYears, buildF1040Draft } from "./f1040Draft.js";
import { f1040Settlement } from "./f1040Filed.js";
import { F1040_LINES, type F1040Line } from "./f1040Identities.js";

const ROW_SECTION: Record<F1040Line, UsTaxReturnRowSection> = {
  "1a": "income",
  "1z": "subtotal",
  "9": "subtotal",
  "10": "deduction",
  "11": "subtotal",
  "12": "deduction",
  "13": "deduction",
  "14": "deduction",
  "15": "subtotal",
  "16": "tax",
  "17": "tax",
  "18": "tax",
  "21": "credit",
  "22": "tax",
  "23": "tax",
  "24": "result",
  "25a": "payment",
  "25b": "payment",
  "25c": "payment",
  "25d": "payment",
  "26": "payment",
  "27": "payment",
  "28": "payment",
  "29": "payment",
  "31": "payment",
  "32": "payment",
  "33": "payment",
  "34": "result",
  "35a": "result",
  "36": "result",
  "37": "result",
};

/** Lines shown even at zero: the chain from wages to what is owed or refunded. */
const ALWAYS_SHOWN = new Set<F1040Line>(["1a", "11", "12", "15", "16", "24", "25a", "25d", "33"]);

export function buildF1040Payload(taxYear: number, todayYmd: string = chileWallClockNow().ymd): UsTaxReturnResponse {
  const d = buildF1040Draft(taxYear, todayYmd);
  const filedLines = d.filed?.lines ?? null;
  const rows: UsTaxReturnRow[] = F1040_LINES.filter(
    (l) => filedLines?.[l] != null || (d.lines[l] ?? 0) !== 0 || ALWAYS_SHOWN.has(l)
  ).map((line) => {
    const filed = filedLines ? (filedLines[line] ?? 0) : null;
    const draft = d.lines[line] ?? 0;
    return { line, section: ROW_SECTION[line], filed, draft, changed: filed != null && filed !== draft };
  });
  return {
    jurisdiction: "us",
    tax_year: d.taxYear,
    available_tax_years: availableUsTaxYears(todayYmd),
    provisional: d.provisional,
    law_year: d.lawYear,
    filing_status: d.filingStatus,
    stubs: d.stubs,
    notes: d.notes,
    w2s: d.w2s.map((w) => ({
      employer: w.employer,
      ein: w.ein,
      stubs: w.stubs,
      box1_wages: w.wages,
      box2_federal_withheld: w.federalWithheld,
      box3_social_security_wages: w.socialSecurityWages,
      box4_social_security_tax: w.socialSecurityTax,
      box5_medicare_wages: w.medicareWages,
      box6_medicare_tax: w.medicareTax,
      box12_d: w.box12D,
      box12_aa: w.box12AA,
      box12_w: w.box12W,
    })),
    fica: {
      social_security: d.fica.socialSecurity,
      medicare: d.fica.medicare,
      total: Math.round((d.fica.socialSecurity + d.fica.medicare) * 100) / 100,
      additional_medicare_tax: d.additionalMedicareTax,
    },
    rows,
    tax_filed: filedLines ? (filedLines["24"] ?? 0) : null,
    tax_draft: d.lines["24"] ?? 0,
    refund_draft: d.lines["35a"] ?? 0,
    owed_draft: d.lines["37"] ?? 0,
    filed: d.filed ? { filed_on: d.filed.filedOn, filing_status: d.filed.filingStatus, source_file: d.filed.sourceFile } : null,
    settlement: f1040Settlement(taxYear),
  };
}
