/**
 * Re-route a split net-worth redemption through a CLP cash buffer account (e.g. "Fintual CLP").
 *
 * Scenario: one redemption leaves a fund (e.g. caca daca −13M) but arrives in checking as
 * several wires (7M + 6M), so nothing matches 1:1. The approved model inserts a plain panel
 * CLP-cash buffer in the middle — same code path as "Racional CLP", no special-casing:
 *
 *   fund −13M → buffer +13M        (internal net-worth transfer, resolved by amount/date pairing)
 *   buffer −7M → checking +7M      (plain redemption, exact-amount match per wire)
 *   buffer −6M → checking +6M
 *
 * This script only INSERTS the buffer legs; it never touches the fund's certificado movements
 * or the checking cartola rows. It is idempotent (machine notes key each leg) and dry-run by
 * default.
 *
 *   npm run reroute:clp-buffer -w nw-tracker-server -- \
 *     --buffer "Fintual CLP" --fund-movement 12345 --wire 23456 --wire 23457          # dry run
 *   npm run reroute:clp-buffer -w nw-tracker-server -- ... --apply                    # write
 */
import { db } from "../src/db.js";
import { isClpCashAccount } from "../src/clpCashAccounts.js";
import { listMovementBalanceCashAccountIds } from "../src/movementBalanceCashAccounts.js";

type MovementRow = {
  id: number;
  account_id: number | null;
  occurred_on: string;
  amount_clp: number;
  note: string | null;
};

function parseArgs(argv: string[]): {
  buffer: string;
  fundMovementId: number;
  wireMovementIds: number[];
  apply: boolean;
} {
  let buffer = "";
  let fundMovementId = 0;
  const wireMovementIds: number[] = [];
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--buffer") {
      buffer = String(argv[++i] ?? "").trim();
    } else if (arg === "--fund-movement") {
      fundMovementId = Number(argv[++i]);
    } else if (arg === "--wire") {
      wireMovementIds.push(Number(argv[++i]));
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (!buffer) throw new Error("--buffer <account id or name> is required");
  if (!Number.isInteger(fundMovementId) || fundMovementId <= 0) {
    throw new Error("--fund-movement <movement id> is required");
  }
  if (wireMovementIds.length === 0 || wireMovementIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error("at least one valid --wire <checking movement id> is required");
  }
  return { buffer, fundMovementId, wireMovementIds, apply };
}

function resolveBufferAccountId(ref: string): number {
  const byId = /^\d+$/.test(ref)
    ? (db.prepare(`SELECT id FROM accounts WHERE id = ?`).get(Number(ref)) as { id: number } | undefined)
    : undefined;
  const byName = byId
    ? undefined
    : (db.prepare(`SELECT id FROM accounts WHERE name = ?`).all(ref) as { id: number }[]);
  if (!byId && (byName == null || byName.length === 0)) {
    throw new Error(`buffer account not found: ${ref}`);
  }
  if (byName != null && byName.length > 1) {
    throw new Error(`buffer account name is ambiguous: ${ref}`);
  }
  const accountId = byId ? byId.id : byName![0]!.id;
  if (!isClpCashAccount(accountId)) {
    throw new Error(
      `account ${accountId} (${ref}) is not a CLP cash account — create it via panel clp_cash first`
    );
  }
  return accountId;
}

function loadMovement(id: number): MovementRow {
  const row = db
    .prepare(`SELECT id, account_id, occurred_on, amount_clp, note FROM movements WHERE id = ?`)
    .get(id) as MovementRow | undefined;
  if (!row) throw new Error(`movement ${id} not found`);
  return row;
}

function main(): void {
  const { buffer, fundMovementId, wireMovementIds, apply } = parseArgs(process.argv.slice(2));
  const bufferId = resolveBufferAccountId(buffer);
  const checkingIds = new Set(listMovementBalanceCashAccountIds());

  const fund = loadMovement(fundMovementId);
  if (fund.account_id == null) {
    throw new Error(`movement ${fund.id} is a transfer row — pass the fund's ledger movement`);
  }
  if (checkingIds.has(fund.account_id)) {
    throw new Error(`movement ${fund.id} is on a checking account — expected the fund redemption`);
  }
  if (fund.account_id === bufferId) {
    throw new Error(`movement ${fund.id} already lives on the buffer account`);
  }
  if (Math.round(fund.amount_clp) >= 0) {
    throw new Error(`movement ${fund.id} is not a redemption (amount_clp ${fund.amount_clp})`);
  }

  const wires = wireMovementIds.map(loadMovement);
  for (const w of wires) {
    if (w.account_id == null || !checkingIds.has(w.account_id)) {
      throw new Error(`wire movement ${w.id} is not on a checking-bucket account`);
    }
    if (Math.round(w.amount_clp) <= 0) {
      throw new Error(`wire movement ${w.id} is not a credit (amount_clp ${w.amount_clp})`);
    }
    if (!String(w.note ?? "").startsWith("import:cartola|")) {
      throw new Error(`wire movement ${w.id} is not a cartola credit`);
    }
  }

  const fundAbs = Math.round(Math.abs(fund.amount_clp));
  const wiresSum = wires.reduce((s, w) => s + Math.round(w.amount_clp), 0);
  if (wiresSum !== fundAbs) {
    throw new Error(
      `wires sum ${wiresSum} != fund redemption ${fundAbs} — the split must account for the full amount`
    );
  }

  type Leg = { occurred_on: string; amount_clp: number; flow_kind: string; note: string };
  const legs: Leg[] = [
    {
      occurred_on: fund.occurred_on,
      amount_clp: fundAbs,
      flow_kind: "deposit_clp",
      note: `reroute:clp-buffer|src=m${fund.id}`,
    },
    ...wires.map((w) => ({
      occurred_on: w.occurred_on,
      amount_clp: -Math.round(w.amount_clp),
      flow_kind: "withdrawal_clp",
      note: `reroute:clp-buffer|src=m${fund.id}|wire=m${w.id}`,
    })),
  ];

  const existsStmt = db.prepare(`SELECT id FROM movements WHERE account_id = ? AND note = ?`);
  const insStmt = db.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note, flow_kind, units_delta)
     VALUES (?, ?, ?, ?, ?, NULL)`
  );

  let inserted = 0;
  let skipped = 0;
  const tx = db.transaction(() => {
    for (const leg of legs) {
      const existing = existsStmt.get(bufferId, leg.note) as { id: number } | undefined;
      if (existing) {
        skipped += 1;
        console.log(`  skip (exists m${existing.id}): ${leg.occurred_on} ${leg.amount_clp} ${leg.note}`);
        continue;
      }
      if (apply) {
        insStmt.run(bufferId, leg.amount_clp, leg.occurred_on, leg.note, leg.flow_kind);
      }
      inserted += 1;
      console.log(
        `  ${apply ? "insert" : "would insert"}: buffer ${bufferId} ${leg.occurred_on} ${leg.amount_clp} (${leg.flow_kind}) ${leg.note}`
      );
    }
  });
  tx();

  console.log(
    `reroute:clp-buffer ${apply ? "APPLIED" : "DRY RUN"} — fund m${fund.id} (−${fundAbs}) via buffer ${bufferId}: ` +
      `${inserted} leg(s) ${apply ? "inserted" : "to insert"}, ${skipped} already present.`
  );
  if (!apply) {
    console.log("re-run with --apply to write.");
  }
}

main();
