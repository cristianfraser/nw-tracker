import { useState } from "react";
import { useTranslation } from "react-i18next";
import { downloadFile } from "../../downloadFile";
import { Modal } from "../ui/Modal";

const SECTIONS = ["closings", "aportes", "pl", "movements"] as const;
type Section = (typeof SECTIONS)[number];

const FIRST_DATA_YEAR = 2016;

type RangePreset = "all" | "last_month" | "last_6m" | "last_year" | "custom" | `year:${number}`;

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthsAgo(n: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - n);
  return monthKey(d);
}

function rangeForPreset(
  preset: RangePreset,
  custom: { from: string; to: string }
): { from?: string; to?: string } {
  switch (preset) {
    case "all":
      return {};
    case "last_month":
      return { from: monthsAgo(1), to: monthsAgo(1) };
    case "last_6m":
      return { from: monthsAgo(5), to: monthKey(new Date()) };
    case "last_year":
      return { from: monthsAgo(11), to: monthKey(new Date()) };
    case "custom":
      return { from: custom.from || undefined, to: custom.to || undefined };
    default: {
      const year = preset.slice(5);
      return { from: `${year}-01`, to: `${year}-12` };
    }
  }
}

/** Toolbar button + modal: pick range/sections/unit, download one XLSX workbook. */
export function ExportToolbarButton({ exportPath }: { exportPath: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<RangePreset>("all");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [sections, setSections] = useState<Set<Section>>(new Set(SECTIONS));
  const [unit, setUnit] = useState<"clp" | "usd">("clp");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const years: number[] = [];
  for (let y = new Date().getFullYear(); y >= FIRST_DATA_YEAR; y--) years.push(y);

  const toggleSection = (s: Section) => {
    setSections((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const download = async () => {
    const range = rangeForPreset(preset, custom);
    const qs = new URLSearchParams();
    if (range.from) qs.set("from", range.from);
    if (range.to) qs.set("to", range.to);
    qs.set("sections", [...sections].join(","));
    if (unit === "usd") qs.set("unit", "usd");
    setBusy(true);
    setError(null);
    try {
      await downloadFile(`${exportPath}?${qs.toString()}`);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        {t("export.button")}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t("export.title")}
        footer={
          <>
            <button type="button" onClick={() => setOpen(false)} disabled={busy}>
              {t("export.cancel")}
            </button>{" "}
            <button type="button" onClick={download} disabled={busy || sections.size === 0}>
              {busy ? t("export.downloading") : t("export.download")}
            </button>
          </>
        }
      >
        {error ? <p className="error">{error}</p> : null}
        <p>
          <label>
            {t("export.rangeLabel")}{" "}
            <select value={preset} onChange={(e) => setPreset(e.target.value as RangePreset)}>
              <option value="all">{t("export.rangeAll")}</option>
              <option value="last_month">{t("export.rangeLastMonth")}</option>
              <option value="last_6m">{t("export.rangeLast6m")}</option>
              <option value="last_year">{t("export.rangeLastYear")}</option>
              {years.map((y) => (
                <option key={y} value={`year:${y}`}>
                  {y}
                </option>
              ))}
              <option value="custom">{t("export.rangeCustom")}</option>
            </select>
          </label>
        </p>
        {preset === "custom" ? (
          <p>
            <label>
              {t("export.customFrom")}{" "}
              <input
                type="month"
                value={custom.from}
                onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
              />
            </label>{" "}
            <label>
              {t("export.customTo")}{" "}
              <input
                type="month"
                value={custom.to}
                onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
              />
            </label>
          </p>
        ) : null}
        <fieldset style={{ border: "none", padding: 0, margin: "0.5rem 0" }}>
          <legend>{t("export.sectionsLabel")}</legend>
          {SECTIONS.map((s) => (
            <label key={s} style={{ display: "block" }}>
              <input type="checkbox" checked={sections.has(s)} onChange={() => toggleSection(s)} />{" "}
              {t(`export.sections.${s}`)}
            </label>
          ))}
        </fieldset>
        <p>
          <label>
            {t("export.unitLabel")}{" "}
            <select value={unit} onChange={(e) => setUnit(e.target.value as "clp" | "usd")}>
              <option value="clp">CLP</option>
              <option value="usd">USD</option>
            </select>
          </label>
        </p>
      </Modal>
    </>
  );
}
