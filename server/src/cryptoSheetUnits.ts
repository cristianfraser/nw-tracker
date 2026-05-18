/**
 * Numbers “cripto” ledger: column **Depositado** coin often alternates between
 * **cumulative** BTC/ETH purchased (early rows) and **monthly flow**, and occasional rows show an
 * **ending balance** (≈ current holdings) rather than an increment. Import used to treat every coin cell
 * as `units_delta`, which double-counts cumulative columns and mis-reads balance snapshots.
 */

export type CryptoSheetDepLegRow = { coin: number };
export type CryptoSheetWdwLegRow = { coin: number };

export type CryptoSheetMonthMovement =
  | { kind: "dep"; coin: number }
  | { kind: "wdw"; coin: number };

/**
 * Ordered legs within a month (deposit first, then withdrawal), as emitted by the import walk.
 */
export type CryptoLedgerImportState = { depCum: number; held: number; wdwCum: number };

export function cryptoDepositCoinUnitsDelta(coin: number, state: CryptoLedgerImportState): number {
  const c = coin;
  if (!(c > 0) || !Number.isFinite(c)) return 0;

  if (state.held < -1e-9) {
    const ud = c - state.held;
    state.depCum = Math.max(state.depCum, c);
    state.held = c;
    return ud;
  }

  if (c >= state.depCum - 1e-12) {
    const ud = c - state.depCum;
    state.depCum = c;
    state.held += ud;
    return ud;
  }

  /** Ending-balance style row: coin ≈ holdings after prior legs (small correction vs adding full coin as flow). */
  const balTol = Math.max(1e-10, Math.abs(c) * 0.2);
  if (Math.abs(c - state.held) < balTol) {
    const ud = c - state.held;
    state.depCum = Math.max(state.depCum, c);
    state.held += ud;
    return ud;
  }

  const ud = c;
  state.depCum += ud;
  state.held += ud;
  return ud;
}

/**
 * Withdrawal leg: coin in the sheet is usually **cumulative** units sold (same pattern as deposits),
 * but sometimes a **monthly** amount; mirror {@link cryptoDepositCoinUnitsDelta} with sign flipped.
 */
export function cryptoWdwCoinUnitsDelta(coin: number, state: CryptoLedgerImportState): number {
  const c = Math.abs(coin);
  if (!(c > 0) || !Number.isFinite(c)) return 0;

  if (c >= state.wdwCum - 1e-12) {
    const soldDelta = c - state.wdwCum;
    state.wdwCum = c;
    const ud = -soldDelta;
    state.held += ud;
    return ud;
  }

  const ud = -c;
  state.wdwCum += c;
  state.held += ud;
  return ud;
}

/** Recompute `units_delta` for a month-ordered list of legs (for DB repair / tests). */
export function cryptoSheetMovementDeltas(movements: CryptoSheetMonthMovement[]): number[] {
  const state = { depCum: 0, held: 0, wdwCum: 0 };
  const out: number[] = [];
  for (const m of movements) {
    if (m.kind === "dep") {
      out.push(cryptoDepositCoinUnitsDelta(m.coin, state));
    } else {
      out.push(cryptoWdwCoinUnitsDelta(m.coin, state));
    }
  }
  return out;
}
