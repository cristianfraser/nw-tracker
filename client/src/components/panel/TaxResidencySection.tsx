import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@crfrsr/ui";
import { addDaysIso } from "nw-tracker-contracts/formats/dates";
import { useTranslation } from "../../i18n";
import { api } from "../../api";
import { loadableClass } from "../ui/Loadable";
import { useTaxResidency } from "../../queries/hooks";
import { invalidateResources, resources } from "../../queries/resources";
import { queryShowsLoading } from "../../queries/pageShapeReady";
import { DEMO_EDITS_LIMITED } from "../../demoEdits";
import type { TaxJurisdiction } from "../../types";
import formStyles from "./PanelForm.module.css";
import styles from "./TaxResidencySection.module.css";

const JURISDICTIONS: readonly TaxJurisdiction[] = ["cl", "us"];

/** Where the tax return takes you to be resident while nothing is declared, and before the first declared day. */
const UNDECLARED_JURISDICTION: TaxJurisdiction = "cl";

/**
 * The declared tax residency (Settings): where you are resident now, the periods as rows, newest
 * first — Chile before any declaration as a row of its own, so the list is never empty —, a form
 * that opens in place to declare the next one from a day, and the removal of the latest. Declared,
 * never inferred — the tax return reads it.
 */
export function TaxResidencySection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const q = useTaxResidency();
  const periods = q.data?.periods ?? [];
  const [formOpen, setFormOpen] = useState(false);
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
      setFormOpen(false);
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
  const first = periods[0];
  const latest = periods[periods.length - 1];
  const busy = declare.isPending || remove.isPending;
  const jurisdictionName = (j: TaxJurisdiction) => t(`panelSettings.taxResidency.jurisdictions.${j}`);
  const current = latest?.jurisdiction ?? UNDECLARED_JURISDICTION;
  // What the form is about to do, said only for a day the open period can be closed before.
  const announces = from !== "" && (latest == null || from > latest.from);
  return (
    <section className={`${styles.frame} ${loadableClass(queryShowsLoading(q))}`}>
      <h2>{t("panelSettings.taxResidency.title")}</h2>
      <div className={styles.now}>
        <span className={styles.nowWhere}>{jurisdictionName(current)}</span>
        <span className="muted">
          {latest ? t("panelSettings.taxResidency.since", { from: latest.from }) : t("panelSettings.taxResidency.none")}
        </span>
        {DEMO_EDITS_LIMITED ? null : (
          <span className={styles.nowAction}>
            <Button
              type="button"
              variant="secondary"
              aria-expanded={formOpen}
              aria-controls="nw-tax-residency-form"
              disabled={busy}
              onClick={() => {
                setError(null);
                setFormOpen((o) => !o);
              }}
            >
              {formOpen ? t("common.cancel") : t("panelSettings.taxResidency.declareChange")}
            </Button>
          </span>
        )}
      </div>
      {formOpen && !DEMO_EDITS_LIMITED ? (
        <form
          id="nw-tax-residency-form"
          className={`${formStyles.form} ${styles.declare}`}
          onSubmit={(e) => {
            e.preventDefault();
            declare.mutate();
          }}
        >
          <label className={formStyles.field}>
            <span className="muted">{t("panelSettings.taxResidency.jurisdiction")}</span>
            <select value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value as TaxJurisdiction)} disabled={busy}>
              {JURISDICTIONS.map((j) => (
                <option key={j} value={j}>
                  {jurisdictionName(j)}
                </option>
              ))}
            </select>
          </label>
          <label className={formStyles.field}>
            <span className="muted">{t("panelSettings.taxResidency.from")}</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required disabled={busy} />
          </label>
          <label className={`${formStyles.field} ${formStyles.noteField}`}>
            <span className="muted">{t("panelSettings.taxResidency.note")}</span>
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} disabled={busy} />
          </label>
          <div className={formStyles.actions}>
            <Button type="submit" disabled={busy || from === ""}>
              {t("panelSettings.taxResidency.declare")}
            </Button>
          </div>
          {announces ? (
            <p className={`muted ${formStyles.line}`}>
              {t("panelSettings.taxResidency.willDo", {
                previous: jurisdictionName(current),
                to: addDaysIso(from, -1),
                next: jurisdictionName(jurisdiction),
                from,
              })}
            </p>
          ) : null}
        </form>
      ) : null}
      {error ? <p className={`error ${formStyles.note}`}>{error}</p> : null}
      <ul className={styles.periods}>
        {[...periods].reverse().map((p) => (
          <li key={p.id} className={styles.period}>
            <span className={styles.where}>
              <i className={p.to == null ? styles.markOpen : styles.mark} aria-hidden="true" />
              {jurisdictionName(p.jurisdiction)}
            </span>
            <span className={`mono ${styles.dates}`}>
              <span className="visually-hidden">{t("panelSettings.taxResidency.from")} </span>
              <span className={styles.day}>{p.from}</span>
              <span aria-hidden="true"> → </span>
              <span className="visually-hidden"> {t("panelSettings.taxResidency.to")} </span>
              {p.to ?? t("panelSettings.taxResidency.open")}
            </span>
            <span className={`muted ${styles.noteCell}`}>{p.note ?? ""}</span>
            <span className={styles.action}>
              {p.id === latest?.id && !DEMO_EDITS_LIMITED ? (
                <button
                  type="button"
                  className={styles.remove}
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(t("panelSettings.taxResidency.deleteConfirm", { from: p.from }))) remove.mutate(p.id);
                  }}
                >
                  {t("panelSettings.taxResidency.remove")}
                </button>
              ) : null}
            </span>
          </li>
        ))}
        {/* What the tax return assumes for the days no period covers. */}
        <li className={`${styles.period} ${styles.implied}`}>
          <span className={styles.where}>
            <i className={first ? styles.mark : styles.markOpen} aria-hidden="true" />
            {jurisdictionName(UNDECLARED_JURISDICTION)}
          </span>
          <span className={`mono ${styles.dates}`}>
            <span aria-hidden="true">— → </span>
            <span className="visually-hidden">{t("panelSettings.taxResidency.to")} </span>
            {first ? addDaysIso(first.from, -1) : t("panelSettings.taxResidency.open")}
          </span>
          <span className={`muted ${styles.noteCell}`}>
            {first ? t("panelSettings.taxResidency.assumedBefore") : t("panelSettings.taxResidency.assumedOnly")}
          </span>
          <span className={styles.action} />
        </li>
      </ul>
      <p className={`muted ${styles.hint}`}>
        {DEMO_EDITS_LIMITED ? t("panelSettings.taxResidency.readOnlyDemo") : t("panelSettings.taxResidency.explain")}
      </p>
    </section>
  );
}
