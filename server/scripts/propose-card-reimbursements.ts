/**
 * Proposes which checking credits are an additional cardholder paying back his card charges, and
 * classifies them `income_kind = 'card_reimbursement'` (never income; set against the charges in
 * the expenses payload's «Tarjetas adicionales» summary).
 *
 * The payer is named by the caller, never guessed: `--payer-note-token=<token>` picks checking
 * credits whose bank description carries it (the payer's RUT as the bank prints it — this
 * one-off tool may read bank notes; runtime never does), or `--movement-ids=` lists them
 * outright. Credits already classified salary / severance / parent_gift, excluded from income, or
 * above `--max-amount` (gifts are large round wires) are reported and left alone.
 *
 * Charges are the expenses payload's own additional-card lines (`isAdditionalCardChargeLine`: the
 * cardholder's plastics, left in `no_cuenta`). Each credit is matched to the charges it paid —
 * the oldest unpaid ones summing to it exactly, else any set from the preceding `--window-days`,
 * else FIFO (partially) — and the running balance (charges − reimbursements) is printed by month.
 *
 * Runs inside one transaction; without --apply it is rolled back, so the report IS the plan.
 *
 *   npx tsx scripts/propose-card-reimbursements.ts --payer-note-token=<token>
 *   npx tsx scripts/propose-card-reimbursements.ts --payer-note-token=<token> --apply
 *   options: --from=YYYY-MM-DD (default 2024-01-01) --max-amount=<clp> (default 1000000)
 *            --exclude-ids=1,2 --movement-ids=1,2 --window-days=<n> (default 21)
 */
import { db } from "../src/db.js";
import {
  buildAdditionalCardsSummary,
  isAdditionalCardChargeLine,
  matchCardReimbursements,
  type ReimbursementChargeInput,
  type ReimbursementCreditInput,
} from "../src/additionalCardReimbursements.js";
import { buildFlowsExpensesPayload } from "../src/flowsExpenses.js";
import {
  loadCardReimbursementCredits,
  upsertCheckingIncomeMovementOverride,
} from "../src/flowsCheckingIncomeOverrides.js";
import { listCheckingMovements } from "../src/checkingCartolaLoaders.js";
import { listMovementBalanceCashAccountIds } from "../src/movementBalanceCashAccounts.js";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function idList(name: string): number[] {
  const raw = arg(name);
  if (raw == null || raw === "") return [];
  return raw.split(",").map((s) => {
    const n = Number(s.trim());
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name}: invalid id ${s}`);
    return n;
  });
}

const apply = process.argv.includes("--apply");
const token = arg("payer-note-token");
const explicitIds = idList("movement-ids");
const excludeIds = new Set(idList("exclude-ids"));
const from = arg("from") ?? "2024-01-01";
const maxAmount = Number(arg("max-amount") ?? "1000000");
const windowDays = Number(arg("window-days") ?? "21");
if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error(`--from must be YYYY-MM-DD: ${from}`);
if (!(maxAmount > 0)) throw new Error("--max-amount must be positive");
if (!(windowDays > 0)) throw new Error("--window-days must be positive");
if ((token == null || token === "") === (explicitIds.length === 0)) {
  throw new Error("pass exactly one of --payer-note-token=<token> or --movement-ids=<ids>");
}

type CreditRow = {
  id: number;
  occurred_on: string;
  amount_clp: number;
  note: string;
  income_kind: string | null;
  is_excluded: number | null;
};


/** The checking accounts' credits (whatever bank document listed them), with their classification. */
function loadCredits(): CreditRow[] {
  const overrides = db.prepare(
    `SELECT income_kind, is_excluded FROM checking_income_movement_overrides WHERE movement_id = ?`
  );
  const all: CreditRow[] = listMovementBalanceCashAccountIds()
    .flatMap((accountId) => listCheckingMovements(accountId, "in"))
    .map((m) => {
      const o = overrides.get(m.id) as { income_kind: string | null; is_excluded: number | null } | undefined;
      return { id: m.id, occurred_on: m.occurred_on, amount_clp: m.amount_clp, note: String(m.note ?? ""), income_kind: o?.income_kind ?? null, is_excluded: o?.is_excluded ?? null };
    });
  if (explicitIds.length > 0) {
    const byId = new Map(all.map((r) => [r.id, r]));
    const missing = explicitIds.filter((id) => !byId.has(id));
    if (missing.length > 0) throw new Error(`not checking credits: ${missing.join(", ")}`);
    return explicitIds.map((id) => byId.get(id)!).sort((a, b) => a.occurred_on.localeCompare(b.occurred_on) || a.id - b.id);
  }
  return all
    .filter((r) => r.occurred_on >= from && r.note.includes(token!))
    .sort((a, b) => a.occurred_on.localeCompare(b.occurred_on) || a.id - b.id);
}

const fmt = (n: number) => Math.round(n).toLocaleString("es-CL"); // convention-ok: script console output

class RollBack extends Error {}

try {
  db.transaction(() => {
    const credits = loadCredits();
    const proposed: CreditRow[] = [];
    const skipped: { row: CreditRow; why: string }[] = [];
    for (const r of credits) {
      if (excludeIds.has(r.id)) skipped.push({ row: r, why: "--exclude-ids" });
      else if (r.is_excluded === 1) skipped.push({ row: r, why: "excluded from income" });
      else if (r.income_kind != null && r.income_kind !== "other" && r.income_kind !== "card_reimbursement") {
        skipped.push({ row: r, why: `classified ${r.income_kind}` });
      } else if (r.amount_clp > maxAmount) skipped.push({ row: r, why: `above --max-amount` });
      else proposed.push(r);
    }

    const payload = buildFlowsExpensesPayload();
    const chargeLines = payload.lines.filter(isAdditionalCardChargeLine);
    const charges: ReimbursementChargeInput[] = chargeLines.map((l) => {
      const date = l.purchase_on ?? l.occurred_on;
      return { id: l.statement_line_id, date, amount_clp: l.amount_clp, merchant: l.merchant };
    });
    const notas = charges.filter((c) => c.amount_clp < 0);

    // Reimbursements already classified by hand take part in the matching too.
    const already = loadCardReimbursementCredits().filter(
      (c) => !proposed.some((p) => p.id === c.movement_id)
    );
    const matchCredits: ReimbursementCreditInput[] = [
      ...proposed.map((r) => ({ movement_id: r.id, date: r.occurred_on, amount_clp: Math.round(r.amount_clp) })),
      ...already.map((c) => ({ movement_id: c.movement_id, date: c.received_on, amount_clp: c.amount_clp })),
    ];
    const { matches, unpaid } = matchCardReimbursements(charges, matchCredits, {
      windowDays,
      maxWindowCharges: 30,
    });

    console.log(
      `Additional-card charges (no_cuenta): ${charges.length} lines, ${fmt(
        charges.reduce((s, c) => s + c.amount_clp, 0)
      )} CLP` + (notas.length ? ` (incl. ${notas.length} credit notes ${fmt(notas.reduce((s, c) => s + c.amount_clp, 0))})` : "")
    );
    console.log(
      `Payer credits found: ${credits.length}; proposed: ${proposed.length} (${fmt(
        proposed.reduce((s, r) => s + r.amount_clp, 0)
      )} CLP); already card_reimbursement elsewhere: ${already.length}; skipped: ${skipped.length}\n`
    );

    console.log("Per credit (date  movement  amount  match  charges  outstanding-before  note):");
    const byKind = new Map<string, { n: number; clp: number }>();
    for (const m of matches) {
      const k = byKind.get(m.kind) ?? { n: 0, clp: 0 };
      k.n += 1;
      k.clp += m.credit.amount_clp;
      byKind.set(m.kind, k);
      const extra =
        m.kind === "unmatched"
          ? `closest FIFO prefix off by ${fmt(m.closest_fifo_delta_clp ?? 0)}`
          : "";
      console.log(
        `  ${m.credit.date}  ${String(m.credit.movement_id).padStart(6)}  ${fmt(m.credit.amount_clp).padStart(10)}  ` +
          `${m.kind.padEnd(12)}  ${String(m.charge_ids.length).padStart(3)}  ${fmt(m.outstanding_before_clp).padStart(10)}  ${extra}`
      );
    }
    console.log("\nMatch summary:");
    for (const [kind, v] of byKind) console.log(`  ${kind.padEnd(12)} ${String(v.n).padStart(4)} credits  ${fmt(v.clp)} CLP`);
    const unpaidTotal = [...unpaid.values()].reduce((s, v) => s + v, 0);
    console.log(`  charges left unpaid: ${unpaid.size} lines, ${fmt(unpaidTotal)} CLP`);

    if (skipped.length) {
      console.log("\nSkipped credits:");
      for (const { row, why } of skipped) {
        console.log(`  ${row.occurred_on}  ${String(row.id).padStart(6)}  ${fmt(row.amount_clp).padStart(10)}  ${why}`);
      }
    }
    let written = 0;
    for (const r of proposed) {
      if (r.income_kind === "card_reimbursement") continue;
      upsertCheckingIncomeMovementOverride(r.id, { income_kind: "card_reimbursement" });
      written += 1;
    }

    const summary = buildAdditionalCardsSummary(payload.lines, loadCardReimbursementCredits());
    console.log("\nBy month after classification (charges  reimbursements  net  balance):");
    for (const row of summary.by_month) {
      console.log(
        `  ${row.period_month}  ${fmt(row.charges_clp).padStart(10)}  ${fmt(row.reimbursements_clp).padStart(10)}  ` +
          `${fmt(row.net_clp).padStart(10)}  ${fmt(row.balance_clp).padStart(10)}`
      );
    }
    console.log(
      `  total     ${fmt(summary.totals.charges_clp).padStart(10)}  ${fmt(summary.totals.reimbursements_clp).padStart(10)}  ` +
        `balance ${fmt(summary.totals.balance_clp)}`
    );
    console.log(`\nOverrides to write: ${written}`);
    if (!apply) throw new RollBack();
    console.log(`Applied (${written} override(s) written).`);
  })();
} catch (e) {
  if (!(e instanceof RollBack)) throw e;
  console.log("Report only (rolled back). Re-run with --apply to write.");
}
