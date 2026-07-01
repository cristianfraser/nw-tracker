import { db } from "./db.js";
import { parseWebPasteAmountToken } from "./ccWebPasteParse.js";
import { webPasteAmountUsdForDb } from "./ccPaymentLines.js";

/** USD amount token embedded in a stored raw_line (`… -USD99,28`). */
const USD_AMOUNT_IN_RAW_RE = /([+-]?\s*(?:US\$|USD|U\$S?)\s*[\d.,]+)/i;

type MisStoredUsdLine = {
  id: number;
  merchant: string | null;
  amount_clp: number | null;
  raw_line: string | null;
  card_group: string;
  account_id: number;
};

/**
 * One-off repair for web-paste lines whose USD amount was mis-imported into `amount_clp` (truncated,
 * sign-flipped) before the parser understood the `USD` token. Re-parses `raw_line` to recover the
 * dollar amount, then stores it in `amount_usd` (+ `orig_currency='usd'`) with `amount_clp` cleared,
 * so it is FX-converted at read time like any foreign charge.
 */
export function backfillWebPasteUsdLines(opts?: { dryRun?: boolean }): {
  scanned: number;
  fixed: number;
  accounts: number[];
  changes: { id: number; merchant: string | null; before_clp: number | null; after_usd: number }[];
} {
  const rows = db
    .prepare(
      `SELECT l.id, l.merchant, l.amount_clp, l.raw_line, s.card_group, s.account_id
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.source_pdf LIKE 'import:web-paste%'
         AND l.installment_flag = 0
         AND (l.orig_currency IS NULL OR l.orig_currency = '')
         AND (l.amount_usd IS NULL)
         AND (l.raw_line LIKE '%USD%' OR l.raw_line LIKE '%US$%')`
    )
    .all() as MisStoredUsdLine[];

  const update = db.prepare(
    `UPDATE cc_statement_lines
       SET amount_usd = @amount_usd, amount_clp = NULL, orig_currency = 'usd'
     WHERE id = @id`
  );

  const changes: { id: number; merchant: string | null; before_clp: number | null; after_usd: number }[] = [];
  const accounts = new Set<number>();

  const apply = db.transaction((toFix: typeof changes) => {
    for (const c of toFix) update.run({ id: c.id, amount_usd: c.after_usd });
  });

  for (const r of rows) {
    const m = r.raw_line ? USD_AMOUNT_IN_RAW_RE.exec(r.raw_line) : null;
    if (!m) continue;
    const parsed = parseWebPasteAmountToken(m[1]!);
    if (!parsed || parsed.currency !== "usd") continue;
    const usd = webPasteAmountUsdForDb(parsed.amount, r.merchant, r.card_group);
    if (usd === 0) continue;
    changes.push({ id: r.id, merchant: r.merchant, before_clp: r.amount_clp, after_usd: usd });
    accounts.add(r.account_id);
  }

  if (!opts?.dryRun && changes.length > 0) apply(changes);

  return { scanned: rows.length, fixed: changes.length, accounts: [...accounts], changes };
}
