/**
 * The IPC index and the monthly variation the Banco Central publishes beside it. Only the index
 * is stored (`ipc_daily`); the variation is what the index says month over month, and every
 * fetch proves that against the published variation series before anything is written.
 */

/** Largest gap, in percentage points, between the variation derived from the index and the published one. */
export const IPC_VARIATION_TOLERANCE_PP = 1e-5;

/** A stored index that differs from a fresh fetch by more than this (relative) is a revision or a rebase. */
export const IPC_STORED_INDEX_TOLERANCE_REL = 1e-9;

export type IpcObservation = { date: string; value: number };
export type IpcIndexRow = { date: string; ipcIndex: number };

const MONTH_START = /^(\d{4})-(\d{2})-01$/;

/** First of the month after `ymd` (a first-of-month date). */
export function nextIpcMonth(ymd: string): string {
  const m = MONTH_START.exec(ymd);
  if (!m) throw new Error(`IPC month must be a first-of-month date, got "${ymd}"`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, "0")}-01`;
}

/** Monthly variation in percent from two consecutive index levels. */
export function ipcVariationPct(previousIndex: number, index: number): number {
  return (index / previousIndex - 1) * 100;
}

/**
 * Index rows, checked against the published variation series. `index` starts one month before
 * `variation` (the month each variation is measured from) and both are contiguous monthly
 * series over the same months; each derived variation must match the published one within
 * {@link IPC_VARIATION_TOLERANCE_PP}. Returns every index row, the leading one included.
 */
export function verifyIpcIndexAgainstVariation(
  index: readonly IpcObservation[],
  variation: readonly IpcObservation[]
): IpcIndexRow[] {
  if (index.length === 0) throw new Error("IPC: the index series returned no months");
  for (let i = 1; i < index.length; i++) {
    const expected = nextIpcMonth(index[i - 1]!.date);
    if (index[i]!.date !== expected) {
      throw new Error(`IPC index: expected ${expected} after ${index[i - 1]!.date}, got ${index[i]!.date}`);
    }
  }
  if (index.length === 1) {
    if (variation.length > 0) {
      throw new Error(`IPC: variation published for ${variation[0]!.date} without its index month`);
    }
    return [{ date: index[0]!.date, ipcIndex: index[0]!.value }];
  }
  if (variation.length !== index.length - 1) {
    throw new Error(
      `IPC: ${index.length - 1} index month(s) from ${index[1]!.date} but ${variation.length} published variation(s)`
    );
  }
  for (let i = 1; i < index.length; i++) {
    const month = index[i]!.date;
    const published = variation[i - 1]!;
    if (published.date !== month) {
      throw new Error(`IPC: variation for ${published.date} where the index has ${month}`);
    }
    const derived = ipcVariationPct(index[i - 1]!.value, index[i]!.value);
    if (Math.abs(derived - published.value) > IPC_VARIATION_TOLERANCE_PP) {
      throw new Error(
        `IPC ${month}: the index gives ${derived}% but the published variation is ${published.value}%`
      );
    }
  }
  return index.map((r) => ({ date: r.date, ipcIndex: r.value }));
}

/**
 * Throws when a stored month's index differs from the fresh fetch — the series was revised or
 * rebased, and appending to it would splice two different series. Reload it whole instead.
 */
export function assertStoredIpcMatchesFetch(
  stored: ReadonlyMap<string, number>,
  fetched: readonly IpcIndexRow[]
): void {
  for (const r of fetched) {
    const s = stored.get(r.date);
    if (s == null) continue;
    if (Math.abs(s / r.ipcIndex - 1) > IPC_STORED_INDEX_TOLERANCE_REL) {
      throw new Error(
        `IPC ${r.date}: stored index ${s} differs from the Banco Central's ${r.ipcIndex} — the series was ` +
          `revised or rebased; reload it with \`npm run backfill:sbif-utm-ipc -w nw-tracker-server -- --replace-ipc\``
      );
    }
  }
}
