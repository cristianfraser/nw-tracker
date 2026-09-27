/**
 * One-off repair of the evidence row ids recorded on converted card payments
 * (`movement_mirror_merges.in_statement_line_id` / `in_statement_id`).
 *
 * A converted payment finds its card evidence by the payment's card, date and amount
 * (`ccPaymentMirrorEvidence.ts`); the row id the conversion recorded is provenance only, and
 * statement re-imports left most of them pointing at deleted rows — or at a row that later took the
 * same id. This re-points each stale id at the one current row carrying the same payment: same card,
 * date and amount (dollars for a divisas payment, pesos otherwise) and the same kind (a payment line
 * for a line id, the statement header for a statement id). Anything else is listed, never guessed:
 *   - ambiguous: several rows of that kind carry the payment;
 *   - kind change: no row of that kind does, one row of the other kind does (a pasted PAGO line
 *     whose statement prints the payment in its header only) — re-pointed only with
 *     `--allow-kind-change`;
 *   - missing: no row carries the payment at all. The pairing has lost its evidence and
 *     `listCcPaymentMirrorCandidates` refuses to run until it is resolved (undo the pairing, or
 *     restore the statement's payment).
 *
 * Report-first: nothing is written without --apply.
 *
 *   npx tsx server/scripts/repair-cc-payment-mirror-evidence-refs.ts [--account-id=NN] [--allow-kind-change] [--apply]
 */
import {
  describeCcPaymentPairing,
  listCcPaymentEvidenceRows,
  listCcPaymentPairings,
  type CcPaymentEvidenceRow,
  type CcPaymentPairing,
} from "../src/ccPaymentMirrorEvidence.js";
import { db } from "../src/db.js";

const APPLY = process.argv.includes("--apply");
const ALLOW_KIND_CHANGE = process.argv.includes("--allow-kind-change");
const accountArg = process.argv.find((a) => a.startsWith("--account-id="))?.slice("--account-id=".length);
const accountId = accountArg == null ? undefined : Number(accountArg);
if (accountId != null && !(Number.isInteger(accountId) && accountId > 0)) {
  throw new Error(`--account-id must be a positive integer, got ${JSON.stringify(accountArg)}`);
}

type Status = "current" | "repoint" | "kind_change" | "ambiguous" | "missing";

type Plan = {
  pairing: CcPaymentPairing;
  recorded: { kind: "line" | "header"; id: number };
  /** Whether the recorded row still exists (carrying something else, when not current). */
  recordedExists: boolean;
  status: Status;
  target: CcPaymentEvidenceRow | null;
  /** Every row carrying the payment. */
  rows: CcPaymentEvidenceRow[];
};

const lineExists = db.prepare(`SELECT 1 FROM cc_statement_lines WHERE id = ?`);
const statementExists = db.prepare(`SELECT 1 FROM cc_statements WHERE id = ?`);

function plan(): Plan[] {
  const rowsByKey = new Map<string, CcPaymentEvidenceRow[]>();
  for (const r of listCcPaymentEvidenceRows(accountId)) {
    rowsByKey.set(r.key, [...(rowsByKey.get(r.key) ?? []), r]);
  }
  return listCcPaymentPairings(accountId).map((pairing): Plan => {
    const recorded =
      pairing.recorded_statement_line_id != null
        ? { kind: "line" as const, id: pairing.recorded_statement_line_id }
        : { kind: "header" as const, id: pairing.recorded_statement_id! };
    const recordedExists =
      (recorded.kind === "line" ? lineExists : statementExists).get(recorded.id) != null;
    const rows = rowsByKey.get(pairing.key) ?? [];
    const base = { pairing, recorded, recordedExists, rows };
    if (rows.some((r) => r.kind === recorded.kind && r.id === recorded.id)) {
      return { ...base, status: "current", target: null };
    }
    if (rows.length === 0) return { ...base, status: "missing", target: null };
    const sameKind = rows.filter((r) => r.kind === recorded.kind);
    if (sameKind.length === 1) return { ...base, status: "repoint", target: sameKind[0]! };
    if (sameKind.length === 0 && rows.length === 1) return { ...base, status: "kind_change", target: rows[0]! };
    return { ...base, status: "ambiguous", target: null };
  });
}

const describeRow = (r: CcPaymentEvidenceRow) =>
  `${r.kind === "line" ? "line" : "header of statement"} ${r.id} (${r.source_pdf})`;
const describeRecorded = (p: Plan) =>
  `${p.recorded.kind === "line" ? "line" : "header of statement"} ${p.recorded.id} ` +
  `(${p.recordedExists ? "now carries another payment" : "deleted"})`;

function summarize(label: string, plans: Plan[]): void {
  const counts = new Map<Status, number>();
  for (const p of plans) counts.set(p.status, (counts.get(p.status) ?? 0) + 1);
  const stale = plans.filter((p) => p.status !== "current");
  console.log(
    `${label}: ${plans.length} converted card payment(s); ` +
      ["current", "repoint", "kind_change", "ambiguous", "missing"]
        .map((s) => `${s} ${counts.get(s as Status) ?? 0}`)
        .join(", ") +
      `; stale recorded ids ${stale.length} (${stale.filter((p) => !p.recordedExists).length} deleted, ` +
      `${stale.filter((p) => p.recordedExists).length} reused)`
  );
}

const plans = plan();
summarize("before", plans);
for (const p of plans) {
  if (p.status === "current") continue;
  const head = `  ${describeCcPaymentPairing(p.pairing)} recorded ${describeRecorded(p)}`;
  if (p.status === "repoint") {
    console.log(`${head}\n    ${APPLY ? "→" : "would re-point →"} ${describeRow(p.target!)}`);
  } else if (p.status === "kind_change") {
    const verb = APPLY && ALLOW_KIND_CHANGE ? "→" : "KIND CHANGE (needs --allow-kind-change) →";
    console.log(`${head}\n    ${verb} ${describeRow(p.target!)}`);
  } else if (p.status === "ambiguous") {
    console.log(`${head}\n    AMBIGUOUS: ${p.rows.map(describeRow).join("; ")}`);
  } else {
    console.log(`${head}\n    MISSING: no statement row carries this payment`);
  }
}

if (APPLY) {
  const setRef = db.prepare(
    `UPDATE movement_mirror_merges SET in_statement_line_id = ?, in_statement_id = ?
     WHERE transfer_movement_id = ? AND in_movement_id IS NULL`
  );
  const written = db.transaction(() => {
    let n = 0;
    for (const p of plans) {
      if (!(p.status === "repoint" || (p.status === "kind_change" && ALLOW_KIND_CHANGE))) continue;
      const t = p.target!;
      n += setRef.run(t.kind === "line" ? t.id : null, t.kind === "header" ? t.id : null, p.pairing.transfer_movement_id)
        .changes;
    }
    return n;
  })();
  console.log(`re-pointed ${written} recorded evidence id(s)`);
  summarize("after", plan());
} else {
  console.log("report only — re-run with --apply to re-point the ids above");
}
