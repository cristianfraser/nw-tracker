import { db } from "./db.js";
import { ccStatementSourceKindOf, isListingSourceKind } from "./ccStatementSourceKind.js";
import { oneShotLineFuzzyMatchExists, shouldSkipOneShotStatementImport } from "./ccCrossImportDedupe.js";
import { applyAdditionalCardNoCuentaForLine } from "./ccAdditionalCardExpenseMatch.js";
import {
  adoptReimportedCardLines,
  captureCardLines,
  restoreLineCategories,
  snapshotLineCategories,
} from "./flows/cardLineAdoption.js";
import {
  canonicalCcLineDedupeKeys,
  ccLineDedupeKeyExistsOnAccount,
  patchCcLineOriginCardOnDedupeHit,
} from "./ccExpenseLineDedupe.js";
import { ccLineOriginCurrency } from "./ccOriginCurrency.js";
import { cardStatementFingerprint, storedCardLineAmounts, storedLineColumns, storedStatementColumns } from "./cards/statementStorage.js";
import {
  cardStatementKey,
  parseDdMmYyToIso,
  type CardCanonicalLine,
  type CardCanonicalStatement,
} from "nw-tracker-contracts";

function assertStatementHeader(statement: CardCanonicalStatement): void {
  if (isListingSourceKind(ccStatementSourceKindOf(statement.document))) return;
  const missing: string[] = [];
  if (!statement.close.trim()) missing.push("statement_date");
  if (!statement.period_from) missing.push("period_from");
  if (!statement.period_to) missing.push("period_to");
  if (missing.length === 0) return;
  throw new Error(
    `CC statement import missing ${missing.join(", ")} for ${statement.document}; ` +
      `re-run parse:cc-pdfs and import`
  );
}

/** Per-line import outcome, rendered by the account-page import panel (parity with checking imports). */
export type CcImportFlowItem = {
  /** ISO transaction (fallback posting) date; raw text when unparseable. */
  occurred_on: string;
  description: string;
  /** Null when the line carries no CLP amount (e.g. USD-pasted / foreign lines). */
  amount_clp: number | null;
  amount_usd: number | null;
  installment: boolean;
  /** `NN/MM` tag when the line is an indexed cuota. */
  cuota: string | null;
  /** Statement the line belongs to (ISO close date + currency) — disambiguates multi-statement uploads. */
  statement: string;
};

export type CcImportSkipReason =
  | "duplicate"
  | "fuzzy_duplicate"
  | "installment_overlap"
  /** Dropped before the merge: bank's «CUOT: N OPER: M» re-listing of a cuota being billed. */
  | "cuota_billing"
  /** Dropped before the merge: the table's «SALDO INICIAL» row (the previous bill's total). */
  | "saldo_inicial";

export type SkippedCcImportFlowItem = CcImportFlowItem & { reason: CcImportSkipReason };

export function ccImportFlowItemFromLine(line: CardCanonicalLine, statementLabel: string): CcImportFlowItem {
  const inst = line.installment;
  return {
    occurred_on:
      line.transaction_date ?? line.posting_date ?? (line.printed_transaction_date || line.printed_posting_date || ""),
    description: line.merchant || line.description || "—",
    amount_clp: line.currency === "clp" ? line.amount : null,
    amount_usd: line.currency === "usd" ? line.amount : null,
    installment: inst != null,
    cuota:
      inst?.number != null && inst.count != null
        ? `${String(inst.number).padStart(2, "0")}/${String(inst.count).padStart(2, "0")}`
        : null,
    statement: statementLabel,
  };
}

/** `2026-06-23 · CLP` — the per-line statement tag shown on multi-statement uploads. */
export function ccStatementLabel(statementDate: string, currency: string): string {
  const iso = parseDdMmYyToIso(statementDate) ?? statementDate;
  return `${iso} · ${currency.toUpperCase()}`;
}

/** The line's import dedupe keys (the document's, plus the one-shot key). */
export function canonicalLineDedupeKeys(cardGroup: string, line: CardCanonicalLine): string[] {
  return canonicalCcLineDedupeKeys(cardGroup, {
    installment: line.installment != null,
    dateIso: line.transaction_date ?? line.posting_date,
    merchant: line.merchant,
    amountClp: storedCardLineAmounts(line).amount_clp,
    documentKey: line.document.dedupe_key,
  });
}

export type CcStatementsMergeResult = {
  statementCount: number;
  lineCount: number;
  linesInserted: number;
  linesSkippedDuplicate: number;
  /** One-shot line skipped — same date+amount+fuzzy merchant already exists (different truncation). */
  linesSkippedFuzzyDuplicate: number;
  /** One-shot line skipped — same purchase already in installment ledger. */
  linesSkippedInstallmentOverlap: number;
  /** Existing lines whose origin_card_last4 was updated on dedupe skip. */
  linesOriginCardPatched: number;
  /** Adicional-card lines auto-tagged Único + additional_card during import. */
  additionalCardCategoriesApplied: number;
  categoriesRestored: number;
  /**
   * Earliest transaction date among lines this run actually INSERTED (null when everything
   * deduped). Feeds `upsertCreditCardValuationsFromLedger`'s stale-stamp purge: evidence
   * added for a past day invalidates the frozen stamps written after it.
   */
  earliestInsertedTxDate: string | null;
  /** Per-line outcomes for the import panel — strip from `createImportBatch` payloads. */
  inserted_flows: CcImportFlowItem[];
  skipped_flows: SkippedCcImportFlowItem[];
};

export type CcStatementsMergeOpts = {
  /** Wipe all statements for the account before import (`import:cc-parsed --wipe`). */
  replaceAll?: boolean;
  /** Replace only these statement keys (`card_group\\tsource_pdf\\tstatement_date`). */
  replaceStatementKeys?: Set<string>;
  /** Skip line when dedupe_key already exists on any statement for this account. */
  skipGlobalDedupeKeys?: boolean;
};

const findStmtId = db.prepare(
  `SELECT id FROM cc_statements
   WHERE account_id = ? AND card_group = ? AND source_pdf = ? AND statement_date = ?`
);

/** Same billing close re-imported from a different PDF filename (CLP vs USD stay separate). */
const findStmtByClose = db.prepare(
  `SELECT id FROM cc_statements
   WHERE account_id = ? AND card_group = ? AND statement_date = ?
     AND COALESCE(card_last4, '') = COALESCE(?, '')
     AND currency = ?
   ORDER BY id ASC
   LIMIT 1`
);

function maybeApplyAdditionalCardNoCuenta(
  accountId: number,
  statementLineId: number,
  originCardLast4: string | null,
  primaryCardLast4: string | null
): boolean {
  const result = applyAdditionalCardNoCuentaForLine({
    accountId,
    statementLineId,
    originCardLast4,
    primaryCardLast4,
  });
  return result.applied;
}

export function importCcStatementsMerge(
  accountId: number,
  statements: readonly CardCanonicalStatement[],
  opts?: CcStatementsMergeOpts
): CcStatementsMergeResult {
  const categorySnap = snapshotLineCategories(accountId);

  const replaceAll = opts?.replaceAll === true;
  const replaceKeys = opts?.replaceStatementKeys;
  const skipGlobalDedupe = opts?.skipGlobalDedupeKeys !== false;

  if (replaceAll) {
    db.prepare(
      `DELETE FROM cc_statement_lines WHERE statement_id IN (
        SELECT id FROM cc_statements WHERE account_id = ?
      )`
    ).run(accountId);
    db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(accountId);
  }

  // One entry per ledger statement: a source never names one statement twice, but a caller may
  // hand several copies of a statement's lines (the parsed corpus re-sent), which import in order.
  const byStmt = new Map<string, { statement: CardCanonicalStatement; lines: CardCanonicalLine[] }>();
  for (const statement of statements) {
    // A statement is its lines: one with none writes nothing (a bucket whose rows were all skipped).
    if (statement.lines.length === 0) continue;
    const k = cardStatementKey(statement);
    const entry = byStmt.get(k);
    if (entry) entry.lines.push(...statement.lines);
    else byStmt.set(k, { statement, lines: [...statement.lines] });
  }

  const insStmt = db.prepare(`
    INSERT INTO cc_statements (
      account_id, card_group, source_pdf, statement_date, period_from, period_to, pay_by,
      card_last4, card_product, layout, currency,
      saldo_anterior, abono, compras_cargos, deuda_total, monto_facturado,
      monto_pagado_anterior, monto_pagado_anterior_date, next_period_from, next_period_to,
      import_fingerprint
    ) VALUES (
      @account_id, @card_group, @source_pdf, @statement_date, @period_from, @period_to, @pay_by,
      @card_last4, @card_product, @layout, @currency,
      @saldo_anterior, @abono, @compras_cargos, @deuda_total, @monto_facturado,
      @monto_pagado_anterior, @monto_pagado_anterior_date, @next_period_from, @next_period_to,
      @import_fingerprint
    )
  `);

  const updStmt = db.prepare(`
    UPDATE cc_statements SET
      statement_date = @statement_date,
      period_from = @period_from, period_to = @period_to, pay_by = @pay_by,
      card_last4 = @card_last4, card_product = @card_product, layout = @layout, currency = @currency,
      saldo_anterior = @saldo_anterior, abono = @abono, compras_cargos = @compras_cargos,
      deuda_total = @deuda_total, monto_facturado = @monto_facturado,
      monto_pagado_anterior = @monto_pagado_anterior,
      monto_pagado_anterior_date = @monto_pagado_anterior_date,
      next_period_from = @next_period_from, next_period_to = @next_period_to,
      import_fingerprint = @import_fingerprint
    WHERE id = @id
  `);

  const delLinesForStmt = db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`);

  const insLine = db.prepare(`
    INSERT INTO cc_statement_lines (
      statement_id, transaction_date, posting_date, place, merchant, description_merged,
      country, amount_orig, orig_currency, amount_clp, amount_usd, installment_flag,
      nro_cuota_current, nro_cuota_total, valor_cuota_mensual_clp, valor_cuota_mensual_usd,
      interest_rate_text, tipo_cuota, dedupe_key, parser_row_id, raw_line, origin_card_last4, kind
    ) VALUES (
      @statement_id, @transaction_date, @posting_date, @place, @merchant, @description_merged,
      @country, @amount_orig, @orig_currency, @amount_clp, @amount_usd, @installment_flag,
      @nro_cuota_current, @nro_cuota_total, @valor_cuota_mensual_clp, NULL,
      @interest_rate_text, @tipo_cuota, @dedupe_key, @parser_row_id, @raw_line, @origin_card_last4, @kind
    )
  `);

  let statementCount = 0;
  let lineCount = 0;
  let linesInserted = 0;
  /** Lines this call wrote, per statement: never fuzzy duplicates of one another (`oneShotLineFuzzyMatchExists`). */
  const insertedLineIdsByStatement = new Map<number, Set<number>>();
  let linesSkippedDuplicate = 0;
  let linesSkippedFuzzyDuplicate = 0;
  let linesSkippedInstallmentOverlap = 0;
  let linesOriginCardPatched = 0;
  let additionalCardCategoriesApplied = 0;
  let earliestInsertedTxDate: string | null = null;
  const inserted_flows: CcImportFlowItem[] = [];
  const skipped_flows: SkippedCcImportFlowItem[] = [];

  for (const [key, { statement, lines }] of byStmt) {
    assertStatementHeader(statement);
    const stored = storedStatementColumns(statement);
    const { card_group: cardGroup, source_pdf: sourcePdf, statement_date: statementDate, currency } = stored;
    // A PDF/JSON statement import must not count open web-paste bucket lines as existing
    // evidence: `reconcileOpenWebPasteAfterPdfImports` deletes the bucket's in-period lines
    // right after this loop, so a skip against one destroys the purchase from both places
    // (2026-08 ·0101: 9 lines / 1.xxx.xxx CLP vanished). Web-paste imports keep full scans —
    // deduping a re-paste against its own bucket and against PDF lines is their whole point.
    const dedupeScanOpts = { excludeWebPasteSources: !isListingSourceKind(ccStatementSourceKindOf(sourcePdf)) };

    // The synthesized header PAGO is dated evidence like any line (see `normalizedPostCloseLines`),
    // so it too can contradict a stamp written after that day.
    const paidOn = stored.monto_pagado_anterior_date;
    if (paidOn && (earliestInsertedTxDate == null || paidOn < earliestInsertedTxDate)) {
      earliestInsertedTxDate = paidOn;
    }

    const stmtParams = {
      account_id: accountId,
      ...stored,
      // Written here rather than by the caller because only this loop knows which row the
      // statement actually resolved to: the close-date fallback below can match a row filed
      // under a DIFFERENT source_pdf (a re-downloaded statement), and a fingerprint keyed by
      // the incoming statement's own identity would silently never land — leaving it
      // re-importing forever.
      import_fingerprint: cardStatementFingerprint({ ...statement, lines }),
    };

    let statementId: number;
    const cardLast4 = stored.card_last4;
    let existing = findStmtId.get(accountId, cardGroup, sourcePdf, statementDate) as
      | { id: number }
      | undefined;
    if (!existing) {
      existing = findStmtByClose.get(accountId, cardGroup, statementDate, cardLast4, currency) as { id: number } | undefined;
    }

    if (existing) {
      statementId = existing.id;
      updStmt.run({ ...stmtParams, id: statementId });
      if (replaceKeys?.has(key) || replaceAll) {
        delLinesForStmt.run(statementId);
      }
    } else {
      const r = insStmt.run(stmtParams);
      statementId = Number(r.lastInsertRowid);
    }
    statementCount += 1;

    const seenDedupeInBatch = new Set<string>();
    const statementLabel = ccStatementLabel(statementDate, currency);

    for (const line of lines) {
      const inst = line.installment != null;
      const columns = storedLineColumns(statement, line);
      const amountClp = columns.amount_clp;
      const flowItem = ccImportFlowItemFromLine(line, statementLabel);
      let dedupeKeys = canonicalLineDedupeKeys(cardGroup, line);

      if (dedupeKeys.length > 0) {
        // All keys seen (parser key included) = a truly redundant repeat: skip. A
        // colliding computed key with a fresh parser key is a genuine same-statement
        // twin (identical merchant+amount+date twice, e.g. a double PAT charge):
        // occurrence-suffix the colliding key so both twins import and re-imports
        // stay idempotent.
        if (dedupeKeys.every((k) => seenDedupeInBatch.has(k))) {
          linesSkippedDuplicate += 1;
          skipped_flows.push({ ...flowItem, reason: "duplicate" });
          continue;
        }
        dedupeKeys = dedupeKeys.map((k) => {
          if (!seenDedupeInBatch.has(k)) return k;
          let n = 1;
          while (seenDedupeInBatch.has(`${k}#dup${n}`)) n += 1;
          return `${k}#dup${n}`;
        });
        for (const k of dedupeKeys) seenDedupeInBatch.add(k);
        if (skipGlobalDedupe && ccLineDedupeKeyExistsOnAccount(accountId, dedupeKeys, dedupeScanOpts)) {
          const originCardLast4 = columns.origin_card_last4;
          const patch = patchCcLineOriginCardOnDedupeHit(accountId, dedupeKeys, originCardLast4, dedupeScanOpts);
          if (patch.patched) linesOriginCardPatched += 1;
          if (patch.lineId != null) {
            if (maybeApplyAdditionalCardNoCuenta(accountId, patch.lineId, originCardLast4, cardLast4)) {
              additionalCardCategoriesApplied += 1;
            }
          }
          linesSkippedDuplicate += 1;
          skipped_flows.push({ ...flowItem, reason: "duplicate" });
          continue;
        }
      }

      const lineDateIso = line.transaction_date ?? line.posting_date;
      if (!inst && amountClp > 0) {
        const merchant = columns.merchant;
        if (shouldSkipOneShotStatementImport(accountId, merchant, lineDateIso, amountClp)) {
          linesSkippedInstallmentOverlap += 1;
          skipped_flows.push({ ...flowItem, reason: "installment_overlap" });
          continue;
        }
        // A #dup-keyed row is a parser-affirmed same-statement twin — its sibling in
        // the DB is exactly what the fuzzy match would find, so skip that check.
        const isSameStatementTwin = dedupeKeys.some((k) => k.includes("#dup"));
        if (
          !isSameStatementTwin &&
          oneShotLineFuzzyMatchExists(accountId, merchant, lineDateIso, amountClp, {
            ...dedupeScanOpts,
            excludeLineIds: insertedLineIdsByStatement.get(statementId),
          })
        ) {
          linesSkippedFuzzyDuplicate += 1;
          skipped_flows.push({ ...flowItem, reason: "fuzzy_duplicate" });
          continue;
        }
      }

      const ins = insLine.run({
        statement_id: statementId,
        ...columns,
        orig_currency: ccLineOriginCurrency({ amountOrig: columns.amount_orig, amountUsd: columns.amount_usd, dateIso: lineDateIso }),
        dedupe_key: dedupeKeys[dedupeKeys.length - 1] ?? null,
        kind: line.kind,
      });
      const statementLineId = Number(ins.lastInsertRowid);
      const writtenHere = insertedLineIdsByStatement.get(statementId) ?? new Set<number>();
      writtenHere.add(statementLineId);
      insertedLineIdsByStatement.set(statementId, writtenHere);
      if (maybeApplyAdditionalCardNoCuenta(accountId, statementLineId, columns.origin_card_last4, cardLast4)) {
        additionalCardCategoriesApplied += 1;
      }
      // Earliest date this import actually ADDED evidence for — dedupe-skipped rows change
      // nothing, so re-importing the same statement contradicts no stamp.
      if (lineDateIso && (earliestInsertedTxDate == null || lineDateIso < earliestInsertedTxDate)) {
        earliestInsertedTxDate = lineDateIso;
      }
      lineCount += 1;
      linesInserted += 1;
      inserted_flows.push(flowItem);
    }
  }

  const restored = restoreLineCategories(accountId, categorySnap);

  return {
    statementCount,
    lineCount,
    linesInserted,
    linesSkippedDuplicate,
    linesSkippedFuzzyDuplicate,
    linesSkippedInstallmentOverlap,
    linesOriginCardPatched,
    additionalCardCategoriesApplied,
    categoriesRestored: restored,
    earliestInsertedTxDate,
    inserted_flows,
    skipped_flows,
  };
}

/** Full account wipe + reload (CLI `import:cc-parsed --wipe`). */
export function importCcStatementsWipeAndReload(
  accountId: number,
  statements: readonly CardCanonicalStatement[]
): CcStatementsMergeResult {
  return db.transaction(() => {
    const expenseLines = captureCardLines(accountId);
    const result = importCcStatementsMerge(accountId, statements, {
      replaceAll: true,
      skipGlobalDedupeKeys: false,
    });
    adoptReimportedCardLines(expenseLines);
    return result;
  })();
}
