import { vi } from "vitest";
import { chileWallClockAt } from "../chileDate.js";
import * as fxObservadoFrame from "../fxObservadoFrame.js";

/**
 * Stubs the dólar observado frame by the clock alone: a day has its own fx (an interbank window
 * estimate) from 09:00 Chile on that day, and only an earlier day's carry before. Lets the
 * Risky Norris valuation-day tests probe instants without seeding live USD/CLP prints.
 */
export function stubObservadoWindowFrom09(clpPerUsd = 950): void {
  vi.spyOn(fxObservadoFrame, "observadoFrameFxForDay").mockImplementation((ymd: string, now?: Date) => {
    const cl = chileWallClockAt(now ?? new Date());
    const beforeWindow = cl.ymd < ymd || (cl.ymd === ymd && cl.hour < 9);
    return beforeWindow
      ? { clp_per_usd: clpPerUsd, source: "carry", as_of: ymd }
      : { clp_per_usd: clpPerUsd, source: "interbank_window", as_of: ymd };
  });
}
