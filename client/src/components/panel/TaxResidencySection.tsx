import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@crfrsr/ui";
import { useTranslation } from "../../i18n";
import { api } from "../../api";
import { ColumnTable } from "../ui/ColumnTable";
import { loadableClass } from "../ui/Loadable";
import { useTaxResidency } from "../../queries/hooks";
import { invalidateResources, resources } from "../../queries/resources";
import { queryShowsLoading } from "../../queries/pageShapeReady";
import { DEMO_EDITS_LIMITED } from "../../demoEdits";
import type { TaxJurisdiction, TaxResidencyPeriodDto } from "../../types";

const JURISDICTIONS: readonly TaxJurisdiction[] = ["cl", "us"];

/**
 * The declared tax residency (Settings): the periods, oldest first, a form to declare the next one
 * from a day, and the deletion of the latest. Declared, never inferred — the tax return reads it.
 */
export function TaxResidencySection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const q = useTaxResidency();
  const periods = q.data?.periods ?? [];
  const [jurisdiction, setJurisdiction] = useState<TaxJurisdiction>("us");
  const [from, setFrom] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const invalidate = () => invalidateResources(queryClient, resources.taxResidency());
  const declare = useMutation({
    mutationFn: () => api.declareTaxResidency({ jurisdiction, from, note: note.trim() === "" ? null : note.trim() }),
    onSuccess: () => {
      setError(null);
      setFrom("");
      setNote("");
      void invalidate();
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteTaxResidency(id),
    onSuccess: () => {
      setError(null);
      void invalidate();
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  const latest = periods[periods.length - 1];
  const busy = declare.isPending || remove.isPending;
  return (
    <section>
      <h2>{t("panelSettings.taxResidency.title")}</h2>
      <p className="muted">{t("panelSettings.taxResidency.explain")}</p>
      {periods.length === 0 && !queryShowsLoading(q) ? <p className="muted">{t("panelSettings.taxResidency.none")}</p> : null}
      {periods.length > 0 ? (
        <ColumnTable<TaxResidencyPeriodDto>
          rows={periods}
          rowKey={(p) => p.id}
          wrapClassName={loadableClass(queryShowsLoading(q))}
          cardLayout="flat"
          columns={[
            {
              key: "jurisdiction",
              header: t("panelSettings.taxResidency.jurisdiction"),
              cell: (p) => t(`panelSettings.taxResidency.jurisdictions.${p.jurisdiction}`),
              title: true,
            },
            { key: "from", header: t("panelSettings.taxResidency.from"), className: "mono", cell: (p) => p.from },
            {
              key: "to",
              header: t("panelSettings.taxResidency.to"),
              className: "mono",
              cell: (p) => p.to ?? t("panelSettings.taxResidency.open"),
            },
            { key: "note", header: t("panelSettings.taxResidency.note"), cell: (p) => p.note ?? "" },
          ]}
        />
      ) : null}
      {DEMO_EDITS_LIMITED ? (
        <p className="muted">{t("panelSettings.taxResidency.readOnlyDemo")}</p>
      ) : (
        <>
          <form
            className="toggle-row"
            onSubmit={(e) => {
              e.preventDefault();
              declare.mutate();
            }}
          >
            <label>
              <span className="muted">{t("panelSettings.taxResidency.jurisdiction")} </span>
              <select value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value as TaxJurisdiction)} disabled={busy}>
                {JURISDICTIONS.map((j) => (
                  <option key={j} value={j}>
                    {t(`panelSettings.taxResidency.jurisdictions.${j}`)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="muted">{t("panelSettings.taxResidency.from")} </span>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required disabled={busy} />
            </label>
            <label>
              <span className="muted">{t("panelSettings.taxResidency.note")} </span>
              <input type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} disabled={busy} />
            </label>
            <Button type="submit" disabled={busy || from === ""}>
              {t("panelSettings.taxResidency.declare")}
            </Button>
            {latest ? (
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(t("panelSettings.taxResidency.deleteConfirm", { from: latest.from }))) remove.mutate(latest.id);
                }}
              >
                {t("panelSettings.taxResidency.deleteLatest")}
              </Button>
            ) : null}
          </form>
          {error ? <p className="error">{error}</p> : null}
        </>
      )}
    </section>
  );
}
