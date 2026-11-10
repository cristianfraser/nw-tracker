/**
 * Schedule D (Capital Gains and Losses) from the year's Form 8949 rows and the carryover from the
 * year before, and the Capital Loss Carryover Worksheet of its instructions. Pure; whole dollars.
 *
 *   Part I    1b / 2 / 3   Σ column (h) of the box A (2025 on: A or G) / B (or H) / C (or I) rows
 *             6            last year's short-term loss carryover (negative)
 *             7            net short-term = 1b + 2 + 3 + 6
 *   Part II   8b / 9 / 10  boxes D (or J) / E (or K) / F (or L)
 *             13           capital gain distributions (0: none on file)
 *             14           last year's long-term loss carryover (negative)
 *             15           net long-term = 8b + 9 + 10 + 13 + 14
 *   Part III  16 = 7 + 15; a gain is Form 1040 line 7; a loss is limited by line 21 to the smaller of
 *             the loss and the year's limit (US$3.000, §1211(b)), and line 21 is line 7.
 *
 * Carryover to next year (the instructions' worksheet): 1 the 1040's taxable income before its
 * zero floor (line 11 − line 14); 2 the line-21 loss; 3 = max(0, 1 + 2); 4 = min(2, 3); short-term
 * 5–8: 5 the line-7 loss, 6 any line-15 gain, 7 = 4 + 6, 8 = max(0, 5 − 7); long-term 9–13: 9 the
 * line-15 loss, 10 any line-7 gain, 11 = max(0, 4 − 5), 12 = 10 + 11, 13 = max(0, 9 − 12).
 */
import type { Form8949Box, Form8949Row } from "./form8949.js";

export type ScheduleDLine = "1b" | "2" | "3" | "6" | "7" | "8b" | "9" | "10" | "13" | "14" | "15" | "16" | "21";
export type ScheduleDLines = Record<ScheduleDLine, number>;

const BOX_LINE: Record<Form8949Box, "1b" | "2" | "3" | "8b" | "9" | "10"> = {
  A: "1b", G: "1b", B: "2", H: "2", C: "3", I: "3",
  D: "8b", J: "8b", E: "9", K: "9", F: "10", L: "10",
};

/** A loss carried from the year before, as positive amounts (0 without one). */
export type CapitalLossCarryover = { shortTerm: number; longTerm: number };

export type ScheduleD = {
  lines: ScheduleDLines;
  /** Form 1040 line 7. */
  form1040Line7: number;
};

export function scheduleD(rows: readonly Form8949Row[], carryIn: CapitalLossCarryover, lossLimit: number): ScheduleD {
  if (carryIn.shortTerm < 0 || carryIn.longTerm < 0) throw new Error("Schedule D: a carryover is entered as a positive loss");
  const l: ScheduleDLines = { "1b": 0, "2": 0, "3": 0, "6": -carryIn.shortTerm, "7": 0, "8b": 0, "9": 0, "10": 0, "13": 0, "14": -carryIn.longTerm, "15": 0, "16": 0, "21": 0 };
  for (const r of rows) {
    const line = BOX_LINE[r.box];
    const long = line === "8b" || line === "9" || line === "10";
    if (long !== (r.term === "long_term")) throw new Error(`Schedule D: ${r.description} is ${r.term} in box ${r.box}`);
    l[line] += r.gain;
  }
  l["7"] = l["1b"] + l["2"] + l["3"] + l["6"];
  l["15"] = l["8b"] + l["9"] + l["10"] + l["13"] + l["14"];
  l["16"] = l["7"] + l["15"];
  l["21"] = l["16"] < 0 ? -Math.min(-l["16"], lossLimit) : 0;
  return { lines: l, form1040Line7: l["16"] < 0 ? l["21"] : l["16"] };
}

/** The Capital Loss Carryover Worksheet: what this year's Schedule D carries into next year. */
export function capitalLossCarryoverOut(d: ScheduleD, taxableIncomeBeforeFloor: number): CapitalLossCarryover {
  const l = d.lines;
  if (l["21"] === 0) return { shortTerm: 0, longTerm: 0 };
  const w2 = -l["21"];
  const w3 = Math.max(0, taxableIncomeBeforeFloor + w2);
  const w4 = Math.min(w2, w3);
  const w5 = l["7"] < 0 ? -l["7"] : 0;
  const shortTerm = l["7"] < 0 ? Math.max(0, w5 - (w4 + Math.max(0, l["15"]))) : 0;
  const longTerm = l["15"] < 0 ? Math.max(0, -l["15"] - (Math.max(0, l["7"]) + Math.max(0, w4 - w5))) : 0;
  return { shortTerm, longTerm };
}

/** The worksheet input the Qualified Dividends and Capital Gain Tax Worksheet's line 3 reads: min(15, 16), never below 0. */
export function scheduleDNetCapitalGainForWorksheet(d: ScheduleD): number {
  return Math.max(0, Math.min(d.lines["15"], d.lines["16"]));
}
