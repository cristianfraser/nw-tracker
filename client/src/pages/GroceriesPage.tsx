import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "@crfrsr/ui";
import { CartesianGrid, Line, XAxis, YAxis } from "recharts";
import { api } from "../api";
import { AppLineChart } from "../components/charts/AppLineChart";
import { ProductConfigPanel } from "../components/groceries/ProductConfigPanel";
import { TableMobileCard, TableMobileCardRow } from "../components/ui/TableMobileCard";
import { formatClp } from "../format";
import type {
  GroceriesSummary,
  GroceryBrandRow,
  GroceryProductDetail,
  GroceryReceiptItemRow,
  ProductHistoryRow,
  UnclassifiedGroup,
} from "../types/groceries";

/** Alias-group identity for selection state (mirrors the server's grouping key). */
function groupKey(g: UnclassifiedGroup): string {
  return g.barcode ? `${g.store_chain}|b|${g.barcode}` : `${g.store_chain}|d|${g.description}`;
}

function isoMinute(dt: string): string {
  return dt.slice(0, 16);
}

function isoDay(dt: string | null): string {
  return (dt ?? "").slice(0, 10);
}

/** Grocery receipts + product catalog (`/flows/expenses/groceries`). */
export function GroceriesPage() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<GroceriesSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignProductId, setAssignProductId] = useState<string>("");
  const [newProductName, setNewProductName] = useState("");
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignNote, setAssignNote] = useState<string | null>(null);

  const [historyProductId, setHistoryProductId] = useState<number | null>(null);
  const [historyRows, setHistoryRows] = useState<ProductHistoryRow[] | null>(null);
  const [productDetail, setProductDetail] = useState<GroceryProductDetail | null>(null);
  const [brands, setBrands] = useState<GroceryBrandRow[]>([]);
  const [priceMode, setPriceMode] = useState<"effective" | "list" | "normalized">("effective");
  const [branchFilter, setBranchFilter] = useState<string>("");
  const [cityFilter, setCityFilter] = useState<string>("");
  const [brandFilter, setBrandFilter] = useState<string>("");

  const [openReceiptId, setOpenReceiptId] = useState<number | null>(null);
  const [receiptItems, setReceiptItems] = useState<Record<number, GroceryReceiptItemRow[]>>({});

  const reload = useCallback(() => {
    api
      .groceriesSummary()
      .then((s) => {
        setSummary(s);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => reload(), [reload]);

  const toggleSelected = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const runClassify = useCallback(
    async (opts: {
      targets: UnclassifiedGroup[];
      product_id?: number;
      new_product_name?: string;
    }) => {
      if (opts.targets.length === 0) return;
      const chain = opts.targets[0]!.store_chain;
      setAssignBusy(true);
      setAssignNote(null);
      try {
        const res = await api.groceriesClassify({
          store_chain: chain,
          targets: opts.targets.map((g) => ({ barcode: g.barcode, description: g.description })),
          product_id: opts.product_id,
          new_product_name: opts.new_product_name,
        });
        setAssignNote(t("groceries.cleaning.assignedResult", { stamped: res.stamped }));
        setSelected(new Set());
        setNewProductName("");
        reload();
        if (historyProductId === res.product_id) {
          api.groceriesProductHistory(res.product_id).then((h) => setHistoryRows(h.rows));
        }
      } catch (e) {
        setAssignNote(e instanceof Error ? e.message : String(e));
      } finally {
        setAssignBusy(false);
      }
    },
    [historyProductId, reload, t]
  );

  const openHistory = useCallback((productId: number) => {
    setHistoryProductId(productId);
    setHistoryRows(null);
    setProductDetail(null);
    setBranchFilter("");
    setCityFilter("");
    setBrandFilter("");
    api
      .groceriesProductHistory(productId)
      .then((h) => setHistoryRows(h.rows))
      .catch(() => setHistoryRows([]));
    api.groceriesProductDetail(productId).then(setProductDetail).catch(() => setProductDetail(null));
    api
      .groceriesBrands()
      .then((b) => setBrands(b.brands))
      .catch(() => setBrands([]));
  }, []);

  /** After a config/merge change: config, brands, history and the products list all shift. */
  const refreshProductConfig = useCallback(() => {
    reload();
    api.groceriesBrands().then((b) => setBrands(b.brands)).catch(() => undefined);
    if (historyProductId == null) return;
    api
      .groceriesProductDetail(historyProductId)
      .then((d) => {
        setProductDetail(d);
        api.groceriesProductHistory(historyProductId).then((h) => setHistoryRows(h.rows));
      })
      .catch(() => {
        // Merged away: the product no longer exists — close the detail view.
        setHistoryProductId(null);
        setProductDetail(null);
        setHistoryRows(null);
      });
  }, [historyProductId, reload]);

  const toggleReceipt = useCallback(
    (receiptId: number) => {
      if (openReceiptId === receiptId) {
        setOpenReceiptId(null);
        return;
      }
      setOpenReceiptId(receiptId);
      if (!receiptItems[receiptId]) {
        api.groceriesReceiptItems(receiptId).then((r) =>
          setReceiptItems((prev) => ({ ...prev, [receiptId]: r.items }))
        );
      }
    },
    [openReceiptId, receiptItems]
  );

  const selectedGroups = useMemo(
    () => (summary?.unclassified ?? []).filter((g) => selected.has(groupKey(g))),
    [selected, summary]
  );

  const historyProduct = useMemo(
    () => summary?.products.find((p) => p.id === historyProductId) ?? null,
    [historyProductId, summary]
  );

  const historyBranches = useMemo(
    () => [...new Set((historyRows ?? []).map((r) => r.branch))].sort(),
    [historyRows]
  );
  const historyCities = useMemo(
    () => [...new Set((historyRows ?? []).map((r) => r.city ?? ""))].filter(Boolean).sort(),
    [historyRows]
  );
  const historyBrands = useMemo(
    () => [...new Set((historyRows ?? []).map((r) => r.brand_name ?? ""))].filter(Boolean).sort(),
    [historyRows]
  );
  const filteredHistory = useMemo(
    () =>
      (historyRows ?? []).filter(
        (r) =>
          (!branchFilter || r.branch === branchFilter) &&
          (!cityFilter || r.city === cityFilter) &&
          (!brandFilter || r.brand_name === brandFilter)
      ),
    [branchFilter, brandFilter, cityFilter, historyRows]
  );
  const baseUnit = productDetail?.base_unit ?? "un";
  const baseUnitLabel = t(`groceries.config.unit.${baseUnit}`);
  const chartData = useMemo(
    () =>
      filteredHistory.map((r) => ({
        date: isoDay(r.purchased_at),
        price:
          priceMode === "normalized"
            ? r.normalized_unit_price_clp
            : priceMode === "effective"
              ? r.effective_unit_price_clp
              : r.unit_price_clp,
      })),
    [filteredHistory, priceMode]
  );

  if (error) {
    return (
      <div className="page">
        <h1>{t("groceries.title")}</h1>
        <p className="muted">{error}</p>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>{t("groceries.title")}</h1>
      <p className="muted">{t("groceries.intro")}</p>

      {/* ── Cleaning workbench ─────────────────────────────────────────────── */}
      <section style={{ margin: "1.5rem 0" }}>
        <h2>{t("groceries.cleaning.title")}</h2>
        {summary && summary.unclassified.length === 0 ? (
          <p className="muted">{t("groceries.cleaning.allClassified")}</p>
        ) : (
          <>
            <p className="muted">{t("groceries.cleaning.intro")}</p>
            <div
              style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center", margin: "0.5rem 0" }}
            >
              <span>{t("groceries.cleaning.assignSelected", { count: selected.size })}</span>
              <select
                value={assignProductId}
                onChange={(e) => setAssignProductId(e.target.value)}
                disabled={assignBusy}
              >
                <option value="">{t("groceries.cleaning.existingProduct")}</option>
                {(summary?.products ?? []).map((p) => (
                  <option key={p.id} value={String(p.id)}>
                    {p.name}
                  </option>
                ))}
              </select>
              <Button
                onClick={() =>
                  runClassify({ targets: selectedGroups, product_id: Number(assignProductId) })
                }
                disabled={assignBusy || selected.size === 0 || !assignProductId}
              >
                {t("groceries.cleaning.assign")}
              </Button>
              <Input
                value={newProductName}
                onChange={(e) => setNewProductName(e.target.value)}
                placeholder={t("groceries.cleaning.newProductPlaceholder")}
                disabled={assignBusy}
              />
              <Button
                onClick={() =>
                  runClassify({ targets: selectedGroups, new_product_name: newProductName.trim() })
                }
                disabled={assignBusy || selected.size === 0 || newProductName.trim() === ""}
              >
                {t("groceries.cleaning.create")}
              </Button>
              {assignNote ? <span className="muted">{assignNote}</span> : null}
            </div>
            <table className="data-table">
              <thead className="desktop-only">
                <tr>
                  <th />
                  <th>{t("groceries.cleaning.colName")}</th>
                  <th>{t("groceries.cleaning.colBarcode")}</th>
                  <th className="num">{t("groceries.cleaning.colOccurrences")}</th>
                  <th>{t("groceries.cleaning.colLastSeen")}</th>
                  <th className="num">{t("groceries.cleaning.colLastPrice")}</th>
                  <th>{t("groceries.cleaning.colSuggestions")}</th>
                </tr>
              </thead>
              <tbody>
                {(summary?.unclassified ?? []).map((g) => {
                  const key = groupKey(g);
                  const suggestionButtons = g.suggestions.map((s) => (
                    <Button
                      key={s.product_id}
                      variant="link"
                      onClick={() => runClassify({ targets: [g], product_id: s.product_id })}
                      disabled={assignBusy}
                      title={s.via}
                    >
                      {s.product_name}
                    </Button>
                  ));
                  const checkbox = (
                    <input
                      type="checkbox"
                      checked={selected.has(key)}
                      onChange={() => toggleSelected(key)}
                    />
                  );
                  return (
                    <tr key={key}>
                      <td className="desktop-only">{checkbox}</td>
                      <td className="desktop-only">{g.description}</td>
                      <td className="desktop-only muted">{g.barcode ?? "—"}</td>
                      <td className="desktop-only num">{g.occurrences}</td>
                      <td className="desktop-only">{isoDay(g.last_seen)}</td>
                      <td className="desktop-only num">
                        {formatClp(g.last_unit_price_clp)}
                        {g.qty_unit === "kg" ? t("groceries.history.perKg") : ""}
                      </td>
                      <td className="desktop-only">{suggestionButtons}</td>
                      <td className="mobile-only">
                        <TableMobileCard
                          title={
                            <span style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                              {checkbox}
                              {g.description}
                            </span>
                          }
                        >
                          <TableMobileCardRow
                            label={t("groceries.cleaning.colOccurrences")}
                            value={g.occurrences}
                          />
                          <TableMobileCardRow
                            label={t("groceries.cleaning.colLastSeen")}
                            value={isoDay(g.last_seen)}
                          />
                          <TableMobileCardRow
                            label={t("groceries.cleaning.colLastPrice")}
                            value={
                              formatClp(g.last_unit_price_clp) +
                              (g.qty_unit === "kg" ? t("groceries.history.perKg") : "")
                            }
                          />
                          {g.suggestions.length > 0 ? (
                            <TableMobileCardRow
                              label={t("groceries.cleaning.colSuggestions")}
                              value={suggestionButtons}
                            />
                          ) : null}
                        </TableMobileCard>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </section>

      {/* ── Products + price history ───────────────────────────────────────── */}
      <section style={{ margin: "1.5rem 0" }}>
        <h2>{t("groceries.products.title")}</h2>
        {summary && summary.products.length === 0 ? (
          <p className="muted">{t("groceries.products.none")}</p>
        ) : (
          <table className="data-table">
            <thead className="desktop-only">
              <tr>
                <th>{t("groceries.products.colProduct")}</th>
                <th className="num">{t("groceries.products.colAliases")}</th>
                <th className="num">{t("groceries.products.colPurchases")}</th>
                <th>{t("groceries.products.colLastPurchased")}</th>
                <th className="num">{t("groceries.products.colLastPrice")}</th>
              </tr>
            </thead>
            <tbody>
              {(summary?.products ?? []).map((p) => {
                const nameButton = (
                  <Button variant="link" onClick={() => openHistory(p.id)}>
                    {p.name}
                  </Button>
                );
                return (
                  <tr key={p.id} className={p.id === historyProductId ? "row--selected" : undefined}>
                    <td className="desktop-only">{nameButton}</td>
                    <td className="desktop-only num">{p.alias_count}</td>
                    <td className="desktop-only num">{p.purchase_count}</td>
                    <td className="desktop-only">{isoDay(p.last_purchased_at)}</td>
                    <td className="desktop-only num">
                      {p.last_effective_unit_price_clp != null
                        ? formatClp(p.last_effective_unit_price_clp)
                        : "—"}
                    </td>
                    <td className="mobile-only">
                      <TableMobileCard title={nameButton}>
                        <TableMobileCardRow
                          label={t("groceries.products.colPurchases")}
                          value={p.purchase_count}
                        />
                        <TableMobileCardRow
                          label={t("groceries.products.colLastPurchased")}
                          value={isoDay(p.last_purchased_at)}
                        />
                        <TableMobileCardRow
                          label={t("groceries.products.colLastPrice")}
                          value={
                            p.last_effective_unit_price_clp != null
                              ? formatClp(p.last_effective_unit_price_clp)
                              : "—"
                          }
                        />
                      </TableMobileCard>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <h3 style={{ marginTop: "1rem" }}>
          {t("groceries.history.title")}
          {historyProduct ? ` — ${historyProduct.name}` : ""}
        </h3>
        {historyProductId == null ? (
          <p className="muted">{t("groceries.history.pickProduct")}</p>
        ) : historyRows == null ? null : (
          <>
            {productDetail ? (
              <ProductConfigPanel
                detail={productDetail}
                products={summary?.products ?? []}
                brands={brands}
                onChanged={refreshProductConfig}
              />
            ) : null}
            <div
              style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center", margin: "0.5rem 0" }}
            >
              <select
                value={priceMode}
                onChange={(e) => setPriceMode(e.target.value as "effective" | "list" | "normalized")}
              >
                <option value="effective">{t("groceries.history.priceEffective")}</option>
                <option value="list">{t("groceries.history.priceList")}</option>
                {baseUnit !== "un" ? (
                  <option value="normalized">
                    {t("groceries.history.priceNormalized", { unit: baseUnitLabel })}
                  </option>
                ) : null}
              </select>
              {historyBrands.length > 0 ? (
                <label>
                  {t("groceries.history.filterBrand")}{" "}
                  <select value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)}>
                    <option value="">{t("groceries.history.all")}</option>
                    {historyBrands.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label>
                {t("groceries.history.filterBranch")}{" "}
                <select value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)}>
                  <option value="">{t("groceries.history.all")}</option>
                  {historyBranches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </label>
              {historyCities.length > 1 ? (
                <label>
                  {t("groceries.history.filterCity")}{" "}
                  <select value={cityFilter} onChange={(e) => setCityFilter(e.target.value)}>
                    <option value="">{t("groceries.history.all")}</option>
                    {historyCities.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            {chartData.length > 1 ? (
              <div style={{ width: "100%", height: 240 }}>
                <AppLineChart
                  data={chartData}
                  tooltip={{
                    formatValue: (v) => formatClp(Number(v)),
                    formatLabel: (l) => String(l),
                  }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tick={{ fill: "var(--muted)", fontSize: 10 }} minTickGap={24} />
                  <YAxis
                    tick={{ fill: "var(--muted)", fontSize: 10 }}
                    width={52}
                    tickFormatter={(v: number) => formatClp(v)}
                    domain={["auto", "auto"]}
                  />
                  <Line type="monotone" dataKey="price" stroke="var(--accent, #2f81f7)" strokeWidth={2} dot />
                </AppLineChart>
              </div>
            ) : null}
            <table className="data-table">
              <thead className="desktop-only">
                <tr>
                  <th>{t("groceries.history.colDate")}</th>
                  <th>{t("groceries.history.colBranch")}</th>
                  <th className="num">{t("groceries.history.colQty")}</th>
                  <th className="num">{t("groceries.history.colUnitPrice")}</th>
                  <th className="num">{t("groceries.history.colDiscount")}</th>
                  <th className="num">{t("groceries.history.colEffective")}</th>
                  {baseUnit !== "un" ? (
                    <th className="num">{t("groceries.history.colNormalized", { unit: baseUnitLabel })}</th>
                  ) : null}
                  <th className="num">{t("groceries.history.colTotal")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredHistory.map((r, i) => (
                  <tr key={`${r.purchased_at}-${i}`}>
                    <td className="desktop-only">{isoMinute(r.purchased_at)}</td>
                    <td className="desktop-only">{r.branch}</td>
                    <td className="desktop-only num">
                      {r.qty}
                      {r.qty_unit === "kg" ? " kg" : ""}
                    </td>
                    <td className="desktop-only num">{formatClp(r.unit_price_clp)}</td>
                    <td className="desktop-only num">
                      {r.discount_clp > 0 ? formatClp(-r.discount_clp) : "—"}
                    </td>
                    <td className="desktop-only num">{formatClp(r.effective_unit_price_clp)}</td>
                    {baseUnit !== "un" ? (
                      <td className="desktop-only num">
                        {r.normalized_unit_price_clp != null ? (
                          formatClp(r.normalized_unit_price_clp)
                        ) : (
                          <span className="muted">{t("groceries.history.noContent")}</span>
                        )}
                      </td>
                    ) : null}
                    <td className="desktop-only num">{formatClp(r.total_clp - r.discount_clp)}</td>
                    <td className="mobile-only">
                      <TableMobileCard title={isoMinute(r.purchased_at)}>
                        <TableMobileCardRow label={t("groceries.history.colBranch")} value={r.branch} />
                        <TableMobileCardRow
                          label={t("groceries.history.colQty")}
                          value={`${r.qty}${r.qty_unit === "kg" ? " kg" : ""}`}
                        />
                        <TableMobileCardRow
                          label={t("groceries.history.colUnitPrice")}
                          value={formatClp(r.unit_price_clp)}
                        />
                        {r.discount_clp > 0 ? (
                          <TableMobileCardRow
                            label={t("groceries.history.colDiscount")}
                            value={formatClp(-r.discount_clp)}
                          />
                        ) : null}
                        <TableMobileCardRow
                          label={t("groceries.history.colEffective")}
                          value={formatClp(r.effective_unit_price_clp)}
                        />
                        {baseUnit !== "un" ? (
                          <TableMobileCardRow
                            label={t("groceries.history.colNormalized", { unit: baseUnitLabel })}
                            value={
                              r.normalized_unit_price_clp != null
                                ? formatClp(r.normalized_unit_price_clp)
                                : t("groceries.history.noContent")
                            }
                          />
                        ) : null}
                        <TableMobileCardRow
                          label={t("groceries.history.colTotal")}
                          value={formatClp(r.total_clp - r.discount_clp)}
                        />
                      </TableMobileCard>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      {/* ── Receipts ───────────────────────────────────────────────────────── */}
      <section style={{ margin: "1.5rem 0" }}>
        <h2>{t("groceries.receipts.title")}</h2>
        {summary && summary.receipts.length === 0 ? (
          <p className="muted">{t("groceries.receipts.none")}</p>
        ) : (
          <table className="data-table">
            <thead className="desktop-only">
              <tr>
                <th>{t("groceries.receipts.colDate")}</th>
                <th>{t("groceries.receipts.colBranch")}</th>
                <th>{t("groceries.receipts.colCity")}</th>
                <th className="num">{t("groceries.receipts.colTotal")}</th>
                <th className="num">{t("groceries.receipts.colCardPaid")}</th>
                <th className="num">{t("groceries.receipts.colItems")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(summary?.receipts ?? []).map((r) => {
                const toggle = (
                  <Button variant="link" onClick={() => toggleReceipt(r.id)}>
                    {openReceiptId === r.id
                      ? t("groceries.receipts.hideItems")
                      : t("groceries.receipts.showItems")}
                  </Button>
                );
                const itemsRow =
                  openReceiptId === r.id && receiptItems[r.id] ? (
                    <ul style={{ margin: "0.25rem 0 0.5rem", paddingLeft: "1.25rem" }}>
                      {receiptItems[r.id]!.map((item) => (
                        <li key={item.id}>
                          {item.product_name ?? item.description}
                          {item.product_name ? (
                            <span className="muted"> · {item.description}</span>
                          ) : null}{" "}
                          — {item.qty}
                          {item.qty_unit === "kg" ? " kg" : ""} ×{" "}
                          {formatClp(item.unit_price_clp)}
                          {item.discount_clp > 0 ? ` (${formatClp(-item.discount_clp)})` : ""} ={" "}
                          {formatClp(item.total_clp - item.discount_clp)}
                        </li>
                      ))}
                    </ul>
                  ) : null;
                return (
                  <Fragment key={r.id}>
                    <tr>
                      <td className="desktop-only">{isoMinute(r.purchased_at)}</td>
                      <td className="desktop-only">{r.branch}</td>
                      <td className="desktop-only muted">{r.city ?? "—"}</td>
                      <td className="desktop-only num">{formatClp(r.total_clp)}</td>
                      <td className="desktop-only num">
                        {r.card_paid_clp > 0 ? formatClp(r.card_paid_clp) : "—"}
                      </td>
                      <td className="desktop-only num">
                        {r.classified_count}/{r.item_count}
                      </td>
                      <td className="desktop-only">{toggle}</td>
                      <td className="mobile-only">
                        <TableMobileCard title={`${isoMinute(r.purchased_at)} · ${r.branch}`}>
                          <TableMobileCardRow
                            label={t("groceries.receipts.colTotal")}
                            value={formatClp(r.total_clp)}
                          />
                          <TableMobileCardRow
                            label={t("groceries.receipts.colCardPaid")}
                            value={r.card_paid_clp > 0 ? formatClp(r.card_paid_clp) : "—"}
                          />
                          <TableMobileCardRow
                            label={t("groceries.receipts.colItems")}
                            value={`${r.classified_count}/${r.item_count}`}
                          />
                          <TableMobileCardRow label="" value={toggle} />
                          {itemsRow ? <div>{itemsRow}</div> : null}
                        </TableMobileCard>
                      </td>
                    </tr>
                    {openReceiptId === r.id && itemsRow ? (
                      <tr className="desktop-only">
                        <td colSpan={7}>{itemsRow}</td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
