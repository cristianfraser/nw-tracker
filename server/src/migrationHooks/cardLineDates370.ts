import type { Database as DatabaseType } from "better-sqlite3";

/** A stored `dd/mm/yyyy` day → ISO, in SQL. */
const isoOf = (col: string) => `(substr(${col}, 7, 4) || '-' || substr(${col}, 4, 2) || '-' || substr(${col}, 1, 2))`;
/** The day a card line states (its transaction day, else its posting day), ISO, in SQL. */
const lineDayIso = (a: string) =>
  `COALESCE(CASE WHEN ${a}.transaction_date IS NOT NULL THEN ${isoOf(`${a}.transaction_date`)} END,
            CASE WHEN ${a}.posting_date IS NOT NULL THEN ${isoOf(`${a}.posting_date`)} END)`;
const PADDED = `'[0-9][0-9]/[0-9][0-9]/[0-9][0-9][0-9][0-9]'`;

/**
 * Migration 370 hook, after its SQL padded the stored card line days:
 *
 * 1. every stored day is a padded `dd/mm/yyyy` of a real calendar day, or the migration throws
 *    (a day nothing can read is a data problem to fix, not to carry);
 * 2. each card line's evidence states the line's day (`flow_evidence.stated_on`: the insert trigger
 *    could not read an unpadded day and stated a malformed one, or none);
 * 3. a flow dated from those lines follows its most trusted dated line (`refreshFlowFromEvidence`'s
 *    rule): every flow whose day is not ISO, and every flow whose most trusted line's evidence this
 *    hook re-dated.
 * 4. a malformed flow day with no line left to follow (a retired flow, kept by its assignments
 *    after its line went; a key's holder copied from such a flow) is the trigger's misreading of an
 *    8-character `d/m/yyyy` — `20yy-/y-d/`: the year and the one-digit day survive, the month does
 *    not. Its day comes from the document keys it still names (`retired_document_key`,
 *    `retired_key`, `legacy_key` embed the line's ISO day) when exactly one ISO day of that year and
 *    day is among them; else it is dated the 1st of January of its year, logged with its id. Any
 *    other malformed day is not this migration's to read: it throws.
 *
 * Pure (no `db` import).
 */
export function runCardLineDates370(dbi: DatabaseType): void {
  const bad = dbi
    .prepare(
      `SELECT id, transaction_date, posting_date FROM cc_statement_lines
       WHERE (transaction_date IS NOT NULL AND (transaction_date NOT GLOB ${PADDED}
                OR date(${isoOf("transaction_date")}) IS NOT ${isoOf("transaction_date")}))
          OR (posting_date IS NOT NULL AND (posting_date NOT GLOB ${PADDED}
                OR date(${isoOf("posting_date")}) IS NOT ${isoOf("posting_date")}))
       ORDER BY id LIMIT 20`
    )
    .all() as { id: number; transaction_date: string | null; posting_date: string | null }[];
  if (bad.length > 0) {
    throw new Error(
      `migration 370: card line days that are not dd/mm/yyyy days: ` +
        bad.map((b) => `line ${b.id} (${b.transaction_date ?? "—"} / ${b.posting_date ?? "—"})`).join(", ")
    );
  }

  const redated = dbi
    .prepare(
      `SELECT e.id, e.flow_id, ${lineDayIso("l")} AS day FROM flow_evidence e
       JOIN cc_statement_lines l ON l.id = e.source_row_id
       WHERE e.source_table = 'cc_statement_lines' AND e.stated_on IS NOT ${lineDayIso("l")}`
    )
    .all() as { id: number; flow_id: number; day: string | null }[];
  const setStated = dbi.prepare(`UPDATE flow_evidence SET stated_on = ? WHERE id = ?`);
  for (const r of redated) setStated.run(r.day, r.id);

  const best = dbi.prepare(
    `SELECT id, stated_on FROM flow_evidence
     WHERE flow_id = ? AND source_table = 'cc_statement_lines' AND stated_on IS NOT NULL AND stated_amount IS NOT NULL
     ORDER BY authority DESC, id DESC LIMIT 1`
  );
  const malformed = (
    dbi.prepare(`SELECT id FROM flows WHERE occurred_on IS NULL OR occurred_on NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`).all() as {
      id: number;
    }[]
  ).map((r) => r.id);
  const redatedEvidence = new Set(redated.map((r) => r.id));
  const setDay = dbi.prepare(`UPDATE flows SET occurred_on = ? WHERE id = ? AND occurred_on IS NOT ?`);
  const flowFacts = dbi.prepare(`SELECT occurred_on, retired_document_key, retired_key, legacy_key FROM flows WHERE id = ?`);
  const unreadable: string[] = [];
  let flowsRepaired = 0;
  for (const flowId of new Set(malformed)) {
    const b = best.get(flowId) as { id: number; stated_on: string } | undefined;
    if (b) {
      flowsRepaired += setDay.run(b.stated_on, flowId, b.stated_on).changes;
      continue;
    }
    const f = flowFacts.get(flowId) as {
      occurred_on: string | null;
      retired_document_key: string | null;
      retired_key: string | null;
      legacy_key: string | null;
    };
    const misread = /^20(\d{2})-\/\d-(\d)\/$/.exec(f.occurred_on ?? "");
    if (!misread) {
      unreadable.push(`${flowId} («${f.occurred_on ?? ""}»)`);
      continue;
    }
    const year = `20${misread[1]}`;
    const day = `0${misread[2]}`;
    const named = new Set(
      [f.retired_document_key, f.retired_key, f.legacy_key]
        .flatMap((k) => (k ?? "").match(/\d{4}-\d{2}-\d{2}/g) ?? [])
        .filter((iso) => iso.startsWith(`${year}-`) && iso.endsWith(`-${day}`))
    );
    const recovered = named.size === 1 ? [...named][0]! : null;
    const dayOn = recovered ?? `${year}-01-01`;
    if (!recovered) {
      console.warn(
        `migration 370: flow ${flowId} lost its month («${f.occurred_on}», no line and no document key names its day): dated ${dayOn}`
      );
    }
    flowsRepaired += setDay.run(dayOn, flowId, dayOn).changes;
  }
  if (unreadable.length > 0) {
    throw new Error(`migration 370: flows with a malformed day that is not a misread card line day: ${unreadable.slice(0, 20).join(", ")}`);
  }
  const malformedSet = new Set(malformed);
  for (const flowId of new Set(redated.map((r) => r.flow_id))) {
    if (malformedSet.has(flowId)) continue;
    const b = best.get(flowId) as { id: number; stated_on: string } | undefined;
    if (!b || !redatedEvidence.has(b.id)) continue;
    flowsRepaired += setDay.run(b.stated_on, flowId, b.stated_on).changes;
  }
  console.log(`migration 370: ${redated.length} card line evidence day(s) re-stated, ${flowsRepaired} flow day(s) repaired`);
}
