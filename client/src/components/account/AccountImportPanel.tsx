import { useCallback, useState } from "react";
import { api } from "../../api";
import { formatCcExpenseLineAmount, formatUsdFine } from "../../format";
import { useTranslation } from "../../i18n";
import { useAccountImportMutation } from "../../queries/hooks";
import styles from "./AccountImportPanel.module.css";
import { Button, Textarea } from "@crfrsr/ui";

type ImportFlowItem = {
  occurred_on: string;
  description: string;
  /** Null for lines with no CLP amount (CC USD-pasted / foreign lines). */
  amount_clp: number | null;
  amount_usd?: number | null;
  /** CC extras — absent on checking flows. */
  cuota?: string | null;
  statement?: string;
};
type SkippedImportFlowItem = ImportFlowItem & { reason: string };

const SKIP_REASON_KEY: Record<string, string> = {
  duplicate: "accountDetail.import.resultSkipReasonDuplicate",
  fuzzy_duplicate: "accountDetail.import.resultSkipReasonDuplicateApprox",
  installment_overlap: "accountDetail.import.resultSkipReasonInstallmentOverlap",
  duplicate_in_paste: "accountDetail.import.resultSkipReasonDuplicateInPaste",
  already_present: "accountDetail.import.resultSkipReasonAlreadyPresent",
  superseded_by_cartola: "accountDetail.import.resultSkipReasonSupersededByCartola",
  superseded_by_transfer: "accountDetail.import.resultSkipReasonSupersededByTransfer",
};

function isFlowItem(v: unknown): v is ImportFlowItem {
  if (typeof v !== "object" || v === null) return false;
  const f = v as ImportFlowItem;
  return (
    typeof f.occurred_on === "string" &&
    (typeof f.amount_clp === "number" || f.amount_clp === null)
  );
}

function flowAmountLabel(flow: ImportFlowItem): string {
  if (typeof flow.amount_clp === "number") {
    return formatCcExpenseLineAmount(flow.amount_clp, flow.amount_usd ?? null);
  }
  if (typeof flow.amount_usd === "number") return formatUsdFine(flow.amount_usd);
  return "—";
}

function flowArray(data: Record<string, unknown>, key: string): ImportFlowItem[] | null {
  const raw = data[key];
  if (!Array.isArray(raw)) return null;
  return raw.filter(isFlowItem) as ImportFlowItem[];
}

type TextSlot = {
  kind: "textarea";
  label: string;
  hint?: string;
  submitLabel: string;
  onSubmit: (text: string) => Promise<Record<string, unknown>>;
};

type FileSlot = {
  kind: "file";
  label: string;
  hint?: string;
  accept: string;
  submitLabel: string;
  fieldName?: string;
  onSubmit: (file: File) => Promise<Record<string, unknown>>;
};

type MultiFileSlot = {
  kind: "multi-file";
  label: string;
  hint?: string;
  submitLabel: string;
  fields: { name: string; label: string; accept: string }[];
  onSubmit: (files: Record<string, File | undefined>) => Promise<Record<string, unknown>>;
};

export type ImportSlot = TextSlot | FileSlot | MultiFileSlot;

type Props = {
  accountId: number;
  displayUnit: "clp" | "usd";
  extraCcOffsetsKey?: string;
  slots: ImportSlot[];
};

type TFn = (key: string, opts?: Record<string, unknown>) => string;

function numField(data: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    if (typeof data[k] === "number") return data[k] as number;
  }
  return undefined;
}

/**
 * Count summary — only shown when the response carries no per-flow arrays (document imports,
 * older shapes). Web-paste responses use snake_case; the statement-merge response uses camelCase.
 */
function summaryCountParts(data: Record<string, unknown>, t: TFn): string[] {
  const parts: string[] = [];
  const push = (key: string, n: number | undefined, alwaysWhenPresent = false) => {
    if (n != null && (alwaysWhenPresent || n > 0)) {
      parts.push(t(`accountDetail.import.${key}`, { n }));
    }
  };
  push("summaryParsed", numField(data, "lines_parsed", "lineCount"), true);
  push("summaryInserted", numField(data, "inserted", "linesInserted"), true);
  push("summarySkippedDuplicate", numField(data, "skipped_duplicate", "linesSkippedDuplicate"), true);
  push("summarySkippedFuzzyDuplicate", numField(data, "skipped_fuzzy_duplicate", "linesSkippedFuzzyDuplicate"));
  push("summarySkippedInstallmentOverlap", numField(data, "skipped_installment_overlap", "linesSkippedInstallmentOverlap"));
  push("summarySkippedDuplicateInPaste", numField(data, "skipped_duplicate_in_paste"));
  push("summarySkippedSupersededByCartola", numField(data, "skipped_superseded_by_cartola"));
  push("summarySkippedSupersededByTransfer", numField(data, "skipped_superseded_by_transfer"));
  return parts;
}

/** Result info the per-flow arrays don't carry — shown above the detail groups too. */
function summaryExtraParts(data: Record<string, unknown>, t: TFn): string[] {
  const parts: string[] = [];

  const statements = numField(data, "statement_count");
  if (statements != null && statements > 1) {
    parts.push(t("accountDetail.import.summaryStatements", { n: statements }));
  }

  const ledger =
    typeof data.ledger === "object" && data.ledger !== null
      ? (data.ledger as Record<string, unknown>)
      : null;
  if (ledger) {
    const plans = numField(ledger, "purchaseUpserts");
    if (plans) parts.push(t("accountDetail.import.summaryInstallmentPlans", { n: plans }));
    const payments = numField(ledger, "paymentUpserts");
    if (payments) parts.push(t("accountDetail.import.summaryInstallmentPayments", { n: payments }));
  }

  const removed = numField(data, "overlap_removed");
  if (removed) parts.push(t("accountDetail.import.summaryOverlapRemoved", { n: removed }));

  const nudges = data.installment_first_due_nudges;
  if (Array.isArray(nudges) && nudges.length > 0) {
    const labels = (nudges as { merchant?: string | null; to?: string }[])
      .map((n) => `${n.merchant || "—"} → ${n.to ?? ""}`)
      .join(", ");
    parts.push(t("accountDetail.import.summaryFirstDueNudges", { labels }));
  }

  const warnings = Array.isArray(data.parse_errors)
    ? (data.parse_errors as string[])
    : Array.isArray(data.errors)
      ? (data.errors as string[])
      : [];
  if (warnings.length > 0) {
    parts.push(
      t("accountDetail.import.summaryWarnings", { msgs: warnings.slice(0, 3).join("; ") })
    );
  }
  return parts;
}

function FlowLine({
  flow,
  reason,
  showStatement,
}: {
  flow: ImportFlowItem;
  reason?: string;
  showStatement?: boolean;
}) {
  const { t } = useTranslation();
  const reasonKey = reason ? SKIP_REASON_KEY[reason] : undefined;
  return (
    <li className={styles.resultFlow}>
      {flow.occurred_on} · {flow.description || "—"} ·{" "}
      <span className={styles.resultFlowAmount}>{flowAmountLabel(flow)}</span>
      {flow.cuota && <> · {t("accountDetail.import.resultCuotaTag", { cuota: flow.cuota })}</>}
      {showStatement && flow.statement && (
        <span className={styles.resultFlowReason}> · {flow.statement}</span>
      )}
      {reasonKey && <span className={styles.resultFlowReason}> ({t(reasonKey)})</span>}
    </li>
  );
}

/**
 * Renders the import result as a two-group bulleted list (inserted / skipped flows) when the
 * response carries per-flow arrays (checking recent/cartola, cuenta vista and CC paste/PDF
 * imports), with a summary line above for info the arrays don't carry (removed overlaps,
 * first-due nudges, warnings). Responses without arrays fall back to the count summary.
 */
function ImportResultView({ data }: { data: Record<string, unknown> }) {
  const { t } = useTranslation();
  const inserted = flowArray(data, "inserted_flows");
  const skipped = flowArray(data, "skipped_flows") as SkippedImportFlowItem[] | null;
  const extras = summaryExtraParts(data, t);
  if (!inserted && !skipped) {
    const parts = [...summaryCountParts(data, t), ...extras];
    return (
      <p className={styles.ok}>
        {parts.length > 0 ? parts.join(" · ") : JSON.stringify(data, null, 2)}
      </p>
    );
  }
  const insertedFlows = inserted ?? [];
  const skippedFlows = skipped ?? [];
  // Statement tags matter only when one upload touched several statements (e.g. CLP + USD PDFs).
  const showStatement =
    new Set(
      [...insertedFlows, ...skippedFlows].map((f) => f.statement).filter(Boolean)
    ).size > 1;
  return (
    <>
      {extras.length > 0 && <p className={styles.ok}>{extras.join(" · ")}</p>}
      <ul className={styles.resultList}>
        <li className={styles.resultGroup}>
          {t("accountDetail.import.resultInsertedFlows", { n: insertedFlows.length })}:
          {insertedFlows.length === 0 ? (
            <ul>
              <li className={styles.resultFlowNone}>{t("accountDetail.import.resultFlowNone")}</li>
            </ul>
          ) : (
            <ul>
              {insertedFlows.map((flow, i) => (
                <FlowLine key={i} flow={flow} showStatement={showStatement} />
              ))}
            </ul>
          )}
        </li>
        <li className={styles.resultGroup}>
          {t("accountDetail.import.resultSkippedFlows", { n: skippedFlows.length })}:
          {skippedFlows.length === 0 ? (
            <ul>
              <li className={styles.resultFlowNone}>{t("accountDetail.import.resultFlowNone")}</li>
            </ul>
          ) : (
            <ul>
              {skippedFlows.map((flow, i) => (
                <FlowLine key={i} flow={flow} reason={flow.reason} showStatement={showStatement} />
              ))}
            </ul>
          )}
        </li>
      </ul>
    </>
  );
}

export function AccountImportPanel({
  accountId,
  displayUnit,
  extraCcOffsetsKey = "{}",
  slots,
}: Props) {
  const { t } = useTranslation();
  const importMutation = useAccountImportMutation({ accountId, displayUnit, extraCcOffsetsKey });
  const [open, setOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileMap, setFileMap] = useState<Record<string, File | undefined>>({});
  const [inputKey, setInputKey] = useState(0);
  const busy = importMutation.isPending;

  const run = useCallback(
    (fn: () => Promise<Record<string, unknown>>) => {
      setError(null);
      setResult(null);
      importMutation.mutate(fn, {
        onSuccess: (data) => {
          setResult(data);
          setPasteText("");
          setFileMap({});
          setInputKey((k) => k + 1);
        },
        onError: (e) => setError(e instanceof Error ? e.message : String(e)),
      });
    },
    [importMutation]
  );

  if (!slots.length) return null;

  return (
    <section className={styles.panel}>
      <Button variant="ghost" onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"} {t("accountDetail.import.sectionTitle")}
      </Button>
      {open && (
        <div className={styles.body}>
          {slots.map((slot, idx) => (
            <div key={idx} className={styles.slot}>
              <h4 className={styles.slotTitle}>{slot.label}</h4>
              {slot.hint && <p className="muted">{slot.hint}</p>}
              {slot.kind === "textarea" && (
                <>
                  <Textarea
                    rows={8}
                    value={pasteText}
                    onChange={(e) => setPasteText(e.target.value)}
                    placeholder={t("accountDetail.import.pastePlaceholder")}
                  />
                  <Button
                    disabled={busy || !pasteText.trim()}
                    onClick={() => run(() => slot.onSubmit(pasteText))}
                  >
                    {busy ? t("accountDetail.import.busy") : slot.submitLabel}
                  </Button>
                </>
              )}
              {slot.kind === "file" && (
                <>
                  <input
                    key={inputKey}
                    type="file"
                    accept={slot.accept}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      setFileMap((m) => ({ ...m, [slot.label]: f }));
                    }}
                  />
                  <Button
                    disabled={busy || !fileMap[slot.label]}
                    onClick={() => {
                      const f = fileMap[slot.label];
                      if (!f) return;
                      void run(() => slot.onSubmit(f));
                    }}
                  >
                    {busy ? t("accountDetail.import.busy") : slot.submitLabel}
                  </Button>
                </>
              )}
              {slot.kind === "multi-file" && (
                <>
                  {slot.fields.map((field) => (
                    <label key={field.name} className={styles.fileLabel}>
                      {field.label}
                      <input
                        key={inputKey}
                        type="file"
                        accept={field.accept}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          setFileMap((m) => ({ ...m, [field.name]: f }));
                        }}
                      />
                    </label>
                  ))}
                  <Button
                    disabled={busy || !Object.values(fileMap).some(Boolean)}
                    onClick={() => run(() => slot.onSubmit(fileMap))}
                  >
                    {busy ? t("accountDetail.import.busy") : slot.submitLabel}
                  </Button>
                </>
              )}
            </div>
          ))}
          {result && <ImportResultView data={result} />}
          {error && <p className="error">{error}</p>}
        </div>
      )}
    </section>
  );
}

export function useAccountImportSlots(
  accountId: number,
  specs: {
    supports_cc_web_paste?: boolean;
    supports_cc_statement_pdf?: boolean;
    supports_checking_recent_xlsx?: boolean;
    supports_checking_cartola_xlsx?: boolean;
    supports_cuenta_vista_web_paste?: boolean;
    document_imports?: { type: string; labelKey: string; accept: string }[];
  } | null,
  t: (key: string) => string
): ImportSlot[] {
  const slots: ImportSlot[] = [];
  if (!specs) return slots;

  if (specs.supports_cc_web_paste) {
    slots.push({
      kind: "textarea",
      label: t("accountDetail.import.ccWebPaste"),
      hint: t("accountDetail.import.ccWebPasteHint"),
      submitLabel: t("accountDetail.import.submit"),
      onSubmit: (text) => api.importCcWebPaste(accountId, text),
    });
  }
  if (specs.supports_cc_statement_pdf) {
    slots.push({
      kind: "multi-file",
      label: t("accountDetail.import.ccStatementPdf"),
      hint: t("accountDetail.import.ccStatementPdfHint"),
      submitLabel: t("accountDetail.import.submit"),
      fields: [
        { name: "clp", label: t("accountDetail.import.ccPdfClp"), accept: ".pdf" },
        { name: "usd", label: t("accountDetail.import.ccPdfUsd"), accept: ".pdf" },
      ],
      onSubmit: (files) => api.importCcStatementPdf(accountId, files),
    });
  }
  if (specs.supports_cuenta_vista_web_paste) {
    slots.push({
      kind: "textarea",
      label: t("accountDetail.import.cuentaVistaWebPaste"),
      hint: t("accountDetail.import.cuentaVistaWebPasteHint"),
      submitLabel: t("accountDetail.import.submit"),
      onSubmit: (text) => api.importCuentaVistaWebPaste(accountId, text),
    });
  }
  if (specs.supports_checking_recent_xlsx) {
    slots.push({
      kind: "file",
      label: t("accountDetail.import.checkingRecent"),
      hint: t("accountDetail.import.checkingRecentHint"),
      accept: ".xlsx,.xls",
      submitLabel: t("accountDetail.import.submit"),
      onSubmit: (file) => api.importCheckingRecentXlsx(accountId, file),
    });
  }
  if (specs.supports_checking_cartola_xlsx) {
    slots.push({
      kind: "file",
      label: t("accountDetail.import.checkingCartola"),
      hint: t("accountDetail.import.checkingCartolaHint"),
      accept: ".xlsx,.xls",
      submitLabel: t("accountDetail.import.submit"),
      onSubmit: (file) => api.importCheckingCartolaXlsx(accountId, file),
    });
  }
  for (const doc of specs.document_imports ?? []) {
    slots.push({
      kind: "file",
      label: t(doc.labelKey),
      accept: doc.accept,
      submitLabel: t("accountDetail.import.submit"),
      onSubmit: (file) => api.importAccountDocument(accountId, doc.type, file),
    });
  }
  return slots;
}
