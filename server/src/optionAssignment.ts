/**
 * An option assignment (or exercise) as two linked rows (`option_assignments`, migration 304):
 * the `option_assign` units row that takes the contract account's position to zero, and the
 * share leg at the strike on the underlying's account — a `stock_sell` to USD cash when a short
 * call is assigned (or a long put exercised), a `stock_buy` from USD cash when a short put is
 * assigned (or a long call exercised). One service writes both in one transaction; neither row
 * is typed by hand (`movementUnitsPolicy.ts` refuses a bare `option_assign`).
 *
 * The share leg is an ordinary trade to every reader (units, capital, tax lots); the link is
 * what lets the tax lots (wave O2) carry the contract's premium into the sale's proceeds or the
 * purchase's basis.
 */
import { isForeignCashAccountIn } from "./foreignCashAccounts.js";
import { accountRowForId } from "./accountRowForMovement.js";
import { accountUsesBrokerageFlowKinds } from "./accountBrokerageFlows.js";
import { equityTickerForAccount } from "./accountEquityTicker.js";
import { brokerageShareUnitsThroughDate } from "./brokerageFlowMovement.js";
import { db } from "./db.js";

import { requireOptionContract, type OptionContractTerms } from "./optionContracts.js";
import { optionContractsThroughDate } from "./optionPosition.js";

export type OptionAssignmentInput = {
  contract_account_id: number;
  /** The account holding the underlying's shares (its `equity_ticker` is the contract's underlying). */
  stock_account_id: number;
  /** The USD cash account the strike settles against. */
  cash_account_id: number;
  occurred_on: string;
  /** Contracts assigned or exercised: a positive whole number, at most the position held. */
  contracts: number;
  note?: string | null;
};

export type OptionAssignmentResult = {
  assignment_id: number;
  option_movement_id: number;
  stock_movement_id: number;
  stock_flow_kind: "stock_sell" | "stock_buy";
  shares: number;
  amount_usd: number;
  /** The contracts' sign on the contract row: + closes a short, − closes a long. */
  contracts_units_delta: number;
};

function fail(status: number, error: string): never {
  const err = new Error(error) as Error & { status: number };
  err.status = status;
  throw err;
}

/** Which share leg settles the contracts: the side held and the right decide. */
export function assignmentShareLeg(terms: Pick<OptionContractTerms, "right">, heldContracts: number): "stock_sell" | "stock_buy" {
  if (heldContracts === 0) throw new Error("assignmentShareLeg: no contracts held");
  const short = heldContracts < 0;
  // Short call assigned → shares called away; short put assigned → shares put to us;
  // long call exercised → shares bought; long put exercised → shares sold.
  if (terms.right === "C") return short ? "stock_sell" : "stock_buy";
  return short ? "stock_buy" : "stock_sell";
}

export function assignOptionContract(input: OptionAssignmentInput): OptionAssignmentResult {
  const terms = requireOptionContract(input.contract_account_id);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.occurred_on)) fail(400, "occurred_on is required (YYYY-MM-DD).");
  if (!Number.isInteger(input.contracts) || !(input.contracts > 0)) fail(400, "contracts must be a positive whole number.");
  if (input.occurred_on > terms.expiry) {
    fail(400, `an assignment dated ${input.occurred_on} is after the expiry of ${terms.occ_symbol} (${terms.expiry}).`);
  }
  const stockRow = accountRowForId(input.stock_account_id);
  if (!stockRow || !accountUsesBrokerageFlowKinds(stockRow)) fail(400, "stock_account_id must be an equity brokerage account.");
  const stockTicker = equityTickerForAccount(input.stock_account_id);
  if (stockTicker !== terms.underlying_ticker.toUpperCase()) {
    fail(400, `stock_account_id holds ${stockTicker ?? "no ticker"}, not the contract's underlying ${terms.underlying_ticker}.`);
  }
  if (!isForeignCashAccountIn(input.cash_account_id, "usd")) fail(400, "cash_account_id must be a USD cash account.");

  const held = optionContractsThroughDate(input.contract_account_id, input.occurred_on);
  if (held === 0) fail(400, `no contracts of ${terms.occ_symbol} are held on ${input.occurred_on}.`);
  if (input.contracts > Math.abs(held)) {
    fail(400, `${input.contracts} contract(s) exceed the ${Math.abs(held)} held on ${input.occurred_on}.`);
  }
  const shareLeg = assignmentShareLeg(terms, held);
  const shares = input.contracts * terms.multiplier;
  const amountUsd = Math.round(terms.strike * shares * 100) / 100;
  if (shareLeg === "stock_sell") {
    const sharesHeld = brokerageShareUnitsThroughDate(input.stock_account_id, input.occurred_on);
    if (sharesHeld + 1e-9 < shares) {
      fail(400, `${shares} shares of ${terms.underlying_ticker} are called away but ${sharesHeld} are held on ${input.occurred_on}.`);
    }
  }
  // The contract row takes the position toward zero: + for a short, − for a long.
  const contractsUnits = held < 0 ? input.contracts : -input.contracts;
  const note = input.note?.trim() ? input.note.trim() : null;

  const tx = db.transaction((): OptionAssignmentResult => {
    const optionRow = db
      .prepare(
        `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta, flow_kind)
         VALUES (?, 0, 'usd', ?, ?, ?, 'option_assign')`
      )
      .run(input.contract_account_id, input.occurred_on, note, contractsUnits);
    const optionMovementId = Number(optionRow.lastInsertRowid);
    const [from, to] =
      shareLeg === "stock_sell"
        ? [input.stock_account_id, input.cash_account_id]
        : [input.cash_account_id, input.stock_account_id];
    const stockRowIns = db
      .prepare(
        `INSERT INTO movements (account_id, from_account_id, to_account_id, amount, currency, occurred_on, note, units_delta, flow_kind)
         VALUES (NULL, ?, ?, ?, 'usd', ?, ?, ?, ?)`
      )
      .run(from, to, amountUsd, input.occurred_on, note, shares, shareLeg);
    const stockMovementId = Number(stockRowIns.lastInsertRowid);
    const link = db
      .prepare(`INSERT INTO option_assignments (option_movement_id, stock_movement_id) VALUES (?, ?)`)
      .run(optionMovementId, stockMovementId);
    return {
      assignment_id: Number(link.lastInsertRowid),
      option_movement_id: optionMovementId,
      stock_movement_id: stockMovementId,
      stock_flow_kind: shareLeg,
      shares,
      amount_usd: amountUsd,
      contracts_units_delta: contractsUnits,
    };
  });
  return tx();
}

export type OptionAssignmentLink = { id: number; option_movement_id: number; stock_movement_id: number };

const stmtLinkByOption = db.prepare(
  `SELECT id, option_movement_id, stock_movement_id FROM option_assignments WHERE option_movement_id = ?`
);
const stmtLinkByStock = db.prepare(
  `SELECT id, option_movement_id, stock_movement_id FROM option_assignments WHERE stock_movement_id = ?`
);

/** The assignment an `option_assign` row belongs to (null for an unlinked row). */
export function optionAssignmentForOptionMovement(movementId: number): OptionAssignmentLink | null {
  return (stmtLinkByOption.get(movementId) as OptionAssignmentLink | undefined) ?? null;
}

/** The assignment a share leg settled (null for an ordinary trade). */
export function optionAssignmentForStockMovement(movementId: number): OptionAssignmentLink | null {
  return (stmtLinkByStock.get(movementId) as OptionAssignmentLink | undefined) ?? null;
}
