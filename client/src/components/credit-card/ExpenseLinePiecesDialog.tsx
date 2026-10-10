import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Input } from "@crfrsr/ui";
import { api } from "../../api";
import { assignableCcExpenseCategories, ccExpenseCategoryPathLabel } from "../../ccExpenseCategories";
import { isCcExpenseTotalsExcludedSlug } from "../../ccExpenseLineBuckets";
import { formatClp, formatNumberInput, parseNumberInput } from "../../format";
import { useTranslation } from "../../i18n";
import { useSaveExpenseLinePiecesMutation } from "../../queries/hooks";
import type { CcExpenseCategoryDto, FlowCcExpenseLineRow } from "../../types";
import { Modal } from "../ui/Modal";

type PieceRow = {
  /** Kept so a saved piece keeps its big group and note. */
  seq?: number;
  /** '' = the line's own day. */
  spentOn: string;
  amountText: string;
  categorySlug: string;
};

/**
 * Breaks a card or checking purchase line (a cash withdrawal, one charge that paid for several
 * things) into dated pieces. What the pieces leave stays the line's own expense — the server
 * computes that remainder; this dialog only shows it while editing.
 */
export function ExpenseLinePiecesDialog({
  line,
  categories,
  onClose,
}: {
  /** The line (or one of its pieces / its remainder) whose pieces to edit; null = closed. */
  line: FlowCcExpenseLineRow | null;
  categories: readonly CcExpenseCategoryDto[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const source = line?.source === "cc" || line?.source === "checking" ? line.source : null;
  const lineId = line?.statement_line_id ?? 0;
  const open = source != null && lineId > 0;
  const query = useQuery({
    queryKey: ["expenseLinePieces", source, lineId],
    queryFn: () => api.expenseLinePieces(source!, lineId),
    enabled: open,
    staleTime: 0,
  });
  const save = useSaveExpenseLinePiecesMutation();
  const [rows, setRows] = useState<PieceRow[] | null>(null);

  useEffect(() => {
    if (!open) {
      setRows(null);
      save.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !query.data || rows != null) return;
    setRows(
      query.data.pieces.map((p) => ({
        seq: p.seq,
        spentOn: p.spent_on ?? "",
        amountText: formatNumberInput(p.amount_clp),
        categorySlug: p.category_slug,
      }))
    );
  }, [open, query.data, rows]);

  const pickable = assignableCcExpenseCategories(categories).filter((c) => !isCcExpenseTotalsExcludedSlug(c.slug));
  const data = query.data;
  const parsed = (rows ?? []).map((r) => parseNumberInput(r.amountText));
  const amounts = parsed.map((p) => (p.ok ? p.value : null));
  const piecesTotal = amounts.reduce<number>((s, v) => s + (v ?? 0), 0);
  const remainder = data ? data.line_amount_clp - piecesTotal : 0;
  const amountError = parsed.some((p) => !p.ok)
    ? (parsed.find((p) => !p.ok) as { ok: false; message: string }).message
    : amounts.some((v) => v == null || v <= 0 || !Number.isInteger(v))
      ? t("expenses.creditCard.pieces.amountRequired")
      : null;
  const formError = amountError ?? (remainder < 0 ? t("expenses.creditCard.pieces.over") : null);
  const saveError = save.error instanceof Error ? save.error.message : null;

  const update = (i: number, patch: Partial<PieceRow>) =>
    setRows((prev) => (prev ?? []).map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const onSave = async () => {
    if (!data || !rows || formError) return;
    await save.mutateAsync({
      source: data.source,
      line_id: data.line_id,
      pieces: rows.map((r, i) => ({
        ...(r.seq != null ? { seq: r.seq } : {}),
        spent_on: r.spentOn || null,
        amount_clp: amounts[i]!,
        category_slug: r.categorySlug,
      })),
    });
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("expenses.creditCard.pieces.title", { merchant: data?.merchant ?? line?.merchant ?? "" })}
      closeAriaLabel={t("common.close")}
    >
      {query.error instanceof Error ? <p className="error">{query.error.message}</p> : null}
      {data && rows ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: "40rem" }}>
          <p className="muted">{t("expenses.creditCard.pieces.intro", { date: data.line_date })}</p>
          <table>
            <thead>
              <tr>
                <th>{t("expenses.creditCard.pieces.colDate")}</th>
                <th>{t("expenses.creditCard.pieces.colAmount")}</th>
                <th>{t("expenses.creditCard.pieces.colCategory")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.seq ?? `new-${i}`}>
                  <td>
                    <Input
                      type="date"
                      value={r.spentOn}
                      min={data.line_date}
                      placeholder={data.line_date}
                      onChange={(e) => update(i, { spentOn: e.target.value })}
                    />
                  </td>
                  <td>
                    <Input
                      type="text"
                      inputMode="numeric"
                      value={r.amountText}
                      onChange={(e) => update(i, { amountText: e.target.value })}
                    />
                  </td>
                  <td>
                    <select value={r.categorySlug} onChange={(e) => update(i, { categorySlug: e.target.value })}>
                      {pickable.map((c) => (
                        <option key={c.slug} value={c.slug}>
                          {ccExpenseCategoryPathLabel(c)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <Button variant="ghost" onClick={() => setRows((prev) => (prev ?? []).filter((_, j) => j !== i))}>
                      {t("expenses.creditCard.pieces.remove")}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div>
            <Button
              variant="secondary"
              onClick={() =>
                setRows((prev) => [
                  ...(prev ?? []),
                  {
                    spentOn: "",
                    amountText: remainder > 0 ? formatNumberInput(remainder) : "",
                    categorySlug: pickable.some((c) => c.slug === data.category_slug)
                      ? data.category_slug
                      : (pickable[0]?.slug ?? ""),
                  },
                ])
              }
            >
              {t("expenses.creditCard.pieces.add")}
            </Button>
          </div>
          <dl className="mono" style={{ display: "grid", gridTemplateColumns: "auto auto", gap: "0.25rem 1rem", margin: 0 }}>
            <dt>{t("expenses.creditCard.pieces.line")}</dt>
            <dd style={{ margin: 0 }}>{formatClp(data.line_amount_clp)}</dd>
            <dt>{t("expenses.creditCard.pieces.inPieces")}</dt>
            <dd style={{ margin: 0 }}>{formatClp(piecesTotal)}</dd>
            <dt>{t("expenses.creditCard.pieces.remainder")}</dt>
            <dd style={{ margin: 0 }}>{formatClp(remainder)}</dd>
          </dl>
          {formError ? <p className="error">{formError}</p> : null}
          {saveError ? <p className="error">{saveError}</p> : null}
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <Button disabled={save.isPending || formError != null} onClick={() => void onSave()}>
              {save.isPending ? t("expenses.creditCard.pieces.saving") : t("expenses.creditCard.pieces.save")}
            </Button>
            <Button variant="secondary" onClick={onClose}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
