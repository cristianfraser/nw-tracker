import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "@crfrsr/ui";
import { api } from "../../api";
import { TableMobileCard, TableMobileCardRow } from "../ui/TableMobileCard";
import type {
  GroceryBaseUnit,
  GroceryBrandRow,
  GroceryProductAliasConfigRow,
  GroceryProductDetail,
  GroceryProductRow,
} from "../../types/groceries";

export const GROCERY_BASE_UNITS: GroceryBaseUnit[] = ["un", "g", "kg", "ml", "l", "m"];

/** Factor from a unit to its dimension's canonical small unit (g / ml / m) — mirror of the server's. */
const CANONICAL_FACTOR: Record<GroceryBaseUnit, number> = { un: 1, g: 1, kg: 1000, ml: 1, l: 1000, m: 1 };

const DIMENSION: Record<GroceryBaseUnit, string> = {
  un: "count",
  g: "mass",
  kg: "mass",
  ml: "volume",
  l: "volume",
  m: "length",
};

/** Units offered for content entry on a product of this base unit (same dimension only). */
export function contentUnitsFor(baseUnit: GroceryBaseUnit): GroceryBaseUnit[] {
  if (baseUnit === "un") return [];
  return GROCERY_BASE_UNITS.filter((u) => u !== "un" && DIMENSION[u] === DIMENSION[baseUnit]);
}

function AliasConfigRow({
  alias,
  baseUnit,
  brands,
  onSaved,
}: {
  alias: GroceryProductAliasConfigRow;
  baseUnit: GroceryBaseUnit;
  brands: GroceryBrandRow[];
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [brandName, setBrandName] = useState(alias.brand_name ?? "");
  const [contentValue, setContentValue] = useState(
    alias.content != null && baseUnit !== "un"
      ? String(alias.content / CANONICAL_FACTOR[baseUnit])
      : ""
  );
  const [contentUnit, setContentUnit] = useState<GroceryBaseUnit>(baseUnit === "un" ? "un" : baseUnit);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // The base unit changing re-frames the prefill (content is canonical; display scale moved).
  useEffect(() => {
    setContentUnit(baseUnit === "un" ? "un" : baseUnit);
    setContentValue(
      alias.content != null && baseUnit !== "un"
        ? String(alias.content / CANONICAL_FACTOR[baseUnit])
        : ""
    );
  }, [alias.content, baseUnit]);

  const save = async () => {
    setBusy(true);
    setNote(null);
    try {
      const body: Parameters<typeof api.groceriesUpdateAlias>[1] = {};
      const trimmedBrand = brandName.trim();
      if (trimmedBrand !== (alias.brand_name ?? "")) {
        if (trimmedBrand === "") body.brand_id = null;
        else body.brand_name = trimmedBrand;
      }
      if (baseUnit !== "un") {
        const raw = contentValue.trim().replace(",", ".");
        if (raw === "") {
          if (alias.content != null) body.content_value = null;
        } else {
          const value = Number(raw);
          body.content_value = value;
          body.content_unit = contentUnit;
        }
      }
      if (Object.keys(body).length > 0) {
        await api.groceriesUpdateAlias(alias.id, body);
        onSaved();
      }
      setNote(t("groceries.config.saved"));
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const identity = alias.barcode ?? alias.description ?? "";
  const brandInput = (
    <>
      <Input
        list="grocery-brands-datalist"
        value={brandName}
        onChange={(e) => setBrandName(e.target.value)}
        placeholder={t("groceries.config.brandPlaceholder")}
        disabled={busy}
      />
      <datalist id="grocery-brands-datalist">
        {brands.map((b) => (
          <option key={b.id} value={b.name} />
        ))}
      </datalist>
    </>
  );
  const contentInput =
    baseUnit === "un" ? (
      <span className="muted">—</span>
    ) : (
      <span style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center" }}>
        <Input
          value={contentValue}
          onChange={(e) => setContentValue(e.target.value)}
          disabled={busy}
          style={{ width: "5.5rem" }}
        />
        <select
          value={contentUnit}
          onChange={(e) => setContentUnit(e.target.value as GroceryBaseUnit)}
          disabled={busy}
        >
          {contentUnitsFor(baseUnit).map((u) => (
            <option key={u} value={u}>
              {t(`groceries.config.unit.${u}`)}
            </option>
          ))}
        </select>
      </span>
    );
  const saveButton = (
    <Button onClick={() => void save()} disabled={busy}>
      {t("groceries.config.save")}
    </Button>
  );

  return (
    <tr>
      <td className="desktop-only muted">{identity}</td>
      <td className="desktop-only">{alias.sample_description ?? alias.description ?? "—"}</td>
      <td className="desktop-only num">{alias.purchase_count}</td>
      <td className="desktop-only">{brandInput}</td>
      <td className="desktop-only">{contentInput}</td>
      <td className="desktop-only">
        {saveButton}
        {note ? <span className="muted"> {note}</span> : null}
      </td>
      <td className="mobile-only">
        <TableMobileCard title={alias.sample_description ?? identity}>
          <TableMobileCardRow label={t("groceries.config.colAlias")} value={identity} truncateValue />
          <TableMobileCardRow label={t("groceries.config.colPurchases")} value={alias.purchase_count} />
          <TableMobileCardRow label={t("groceries.config.colBrand")} value={brandInput} />
          <TableMobileCardRow label={t("groceries.config.colContent")} value={contentInput} />
          <TableMobileCardRow label="" value={<>{saveButton}{note ? <span className="muted"> {note}</span> : null}</>} />
        </TableMobileCard>
      </td>
    </tr>
  );
}

/**
 * Product config: base unit, per-alias brand + package content, merge-into. The brand catalog
 * is GLOBAL (pick-or-create by name); the product↔brand relation is derived from aliases.
 */
export function ProductConfigPanel({
  detail,
  products,
  brands,
  onChanged,
}: {
  detail: GroceryProductDetail;
  products: GroceryProductRow[];
  brands: GroceryBrandRow[];
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [mergeTarget, setMergeTarget] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const mergeTargets = useMemo(
    () => products.filter((p) => p.id !== detail.id),
    [detail.id, products]
  );

  const setBaseUnit = async (unit: GroceryBaseUnit) => {
    setBusy(true);
    setNote(null);
    try {
      await api.groceriesUpdateProduct(detail.id, { base_unit: unit });
      onChanged();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const merge = async () => {
    const target = mergeTargets.find((p) => p.id === Number(mergeTarget));
    if (!target) return;
    const confirmed = window.confirm(
      t("groceries.config.mergeConfirm", { source: detail.name, target: target.name })
    );
    if (!confirmed) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await api.groceriesMergeProduct(detail.id, target.id);
      setNote(t("groceries.config.mergeDone", { items: res.items_restamped }));
      onChanged();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ margin: "0.75rem 0" }}>
      <h4 style={{ margin: "0 0 0.25rem" }}>{t("groceries.config.title")}</h4>
      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
        <label>
          {t("groceries.config.baseUnit")}{" "}
          <select
            value={detail.base_unit}
            onChange={(e) => void setBaseUnit(e.target.value as GroceryBaseUnit)}
            disabled={busy}
          >
            {GROCERY_BASE_UNITS.map((u) => (
              <option key={u} value={u}>
                {t(`groceries.config.unit.${u}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("groceries.config.mergeInto")}{" "}
          <select value={mergeTarget} onChange={(e) => setMergeTarget(e.target.value)} disabled={busy}>
            <option value="">—</option>
            {mergeTargets.map((p) => (
              <option key={p.id} value={String(p.id)}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={() => void merge()} disabled={busy || !mergeTarget} variant="danger">
          {t("groceries.config.merge")}
        </Button>
        {note ? <span className="muted">{note}</span> : null}
      </div>
      <p className="muted" style={{ margin: "0.25rem 0 0.5rem" }}>
        {t("groceries.config.baseUnitHint")}
      </p>
      <table className="data-table">
        <thead className="desktop-only">
          <tr>
            <th>{t("groceries.config.colAlias")}</th>
            <th>{t("groceries.config.colSample")}</th>
            <th className="num">{t("groceries.config.colPurchases")}</th>
            <th>{t("groceries.config.colBrand")}</th>
            <th>{t("groceries.config.colContent")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {detail.aliases.map((alias) => (
            <AliasConfigRow
              key={alias.id}
              alias={alias}
              baseUnit={detail.base_unit}
              brands={brands}
              onSaved={onChanged}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
