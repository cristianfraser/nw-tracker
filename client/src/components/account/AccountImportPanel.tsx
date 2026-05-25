import { useCallback, useState } from "react";
import { api } from "../../api";
import { useTranslation } from "../../i18n";
import { useAccountImportMutation } from "../../queries/hooks";
import styles from "./AccountImportPanel.module.css";

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

function formatResult(data: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof data.inserted === "number") parts.push(`insertados: ${data.inserted}`);
  if (typeof data.linesInserted === "number") parts.push(`líneas: ${data.linesInserted}`);
  if (typeof data.skipped_duplicate === "number")
    parts.push(`omitidos (duplicado): ${data.skipped_duplicate}`);
  if (typeof data.linesSkippedDuplicate === "number")
    parts.push(`omitidos (duplicado): ${data.linesSkippedDuplicate}`);
  if (Array.isArray(data.parse_errors) && data.parse_errors.length > 0) {
    parts.push(`avisos: ${(data.parse_errors as string[]).slice(0, 3).join("; ")}`);
  }
  if (parts.length === 0) return JSON.stringify(data, null, 2);
  return parts.join(" · ");
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
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileMap, setFileMap] = useState<Record<string, File | undefined>>({});
  const busy = importMutation.isPending;

  const run = useCallback(
    (fn: () => Promise<Record<string, unknown>>) => {
      setError(null);
      setResult(null);
      importMutation.mutate(fn, {
        onSuccess: (data) => setResult(formatResult(data)),
        onError: (e) => setError(e instanceof Error ? e.message : String(e)),
      });
    },
    [importMutation]
  );

  if (!slots.length) return null;

  return (
    <section className={styles.panel}>
      <button type="button" className={styles.toggle} onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"} {t("accountDetail.import.sectionTitle")}
      </button>
      {open && (
        <div className={styles.body}>
          {slots.map((slot, idx) => (
            <div key={idx} className={styles.slot}>
              <h4 className={styles.slotTitle}>{slot.label}</h4>
              {slot.hint && <p className="muted">{slot.hint}</p>}
              {slot.kind === "textarea" && (
                <>
                  <textarea
                    className={styles.textarea}
                    rows={8}
                    value={pasteText}
                    onChange={(e) => setPasteText(e.target.value)}
                    placeholder={t("accountDetail.import.pastePlaceholder")}
                  />
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || !pasteText.trim()}
                    onClick={() => run(() => slot.onSubmit(pasteText))}
                  >
                    {busy ? t("accountDetail.import.busy") : slot.submitLabel}
                  </button>
                </>
              )}
              {slot.kind === "file" && (
                <>
                  <input
                    type="file"
                    accept={slot.accept}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      setFileMap((m) => ({ ...m, [slot.label]: f }));
                    }}
                  />
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || !fileMap[slot.label]}
                    onClick={() => {
                      const f = fileMap[slot.label];
                      if (!f) return;
                      void run(() => slot.onSubmit(f));
                    }}
                  >
                    {busy ? t("accountDetail.import.busy") : slot.submitLabel}
                  </button>
                </>
              )}
              {slot.kind === "multi-file" && (
                <>
                  {slot.fields.map((field) => (
                    <label key={field.name} className={styles.fileLabel}>
                      {field.label}
                      <input
                        type="file"
                        accept={field.accept}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          setFileMap((m) => ({ ...m, [field.name]: f }));
                        }}
                      />
                    </label>
                  ))}
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || !Object.values(fileMap).some(Boolean)}
                    onClick={() => run(() => slot.onSubmit(fileMap))}
                  >
                    {busy ? t("accountDetail.import.busy") : slot.submitLabel}
                  </button>
                </>
              )}
            </div>
          ))}
          {result && <p className={styles.ok}>{result}</p>}
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
