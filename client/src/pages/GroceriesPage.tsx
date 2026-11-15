import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "@crfrsr/ui";
import { CartesianGrid, Line, XAxis, YAxis } from "recharts";
import { api } from "../api";
import { PageGridTile } from "../components/layout/PageGridTile";
import { AppLineChart } from "../components/charts/AppLineChart";
import { buildNiceYAxis, minMaxForKeys } from "../components/charts/chartLayout";
import { ProductConfigPanel } from "../components/groceries/ProductConfigPanel";
import { Pill } from "../components/ui/Pill";
import { ColumnTable, type TableColumn } from "../components/ui/ColumnTable";
import { formatReceiptPesos } from "../formatNative";
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
  const [mixedPackages, setMixedPackages] = useState(false);
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
      .then((h) => {
        setHistoryRows(h.rows);
        setMixedPackages(h.heterogeneous_packages);
      })
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
        api.groceriesProductHistory(historyProductId).then((h) => {
          setHistoryRows(h.rows);
          setMixedPackages(h.heterogeneous_packages);
        });
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
  // The per-unit mode is offered whenever it says something the package price doesn't: any
  // physical base unit, or a count-dimension product with a multipack configured (x3 ≠ x1).
  const normalizedAvailable =
    baseUnit !== "un" ||
    mixedPackages ||
    (historyRows?.some(
      (r) =>
        r.normalized_unit_price_clp != null &&
        r.normalized_unit_price_clp !== r.effective_unit_price_clp
    ) ??
      false);
  // Mixed package sizes make per-package prices incomparable (1 L at $1.300 vs 200 mL at
  // $600, or a x1 beside a x3 multipack): only the per-unit mode is offered then.
  const normalizedOnly = mixedPackages;
  const effectivePriceMode = normalizedOnly ? "normalized" : priceMode;
  const chartData = useMemo(
    () =>
      filteredHistory.map((r) => ({
        date: isoDay(r.purchased_at),
        price:
          effectivePriceMode === "normalized"
            ? r.normalized_unit_price_clp
            : effectivePriceMode === "effective"
              ? r.effective_unit_price_clp
              : r.unit_price_clp,
      })),
    [effectivePriceMode, filteredHistory]
  );
  // A price axis starts at 0 like every value chart; only the finite prices set the top.
  const yScale = useMemo(() => {
    const { max } = minMaxForKeys(chartData, ["price"]);
    return buildNiceYAxis(0, Math.max(0, max));
  }, [chartData]);

  if (error) {
    return (
      <div className="page-grid">
        <h2 className="flow-section-title">{t("groceries.title")}</h2>
        <p className="muted">{error}</p>
      </div>
    );
  }

  const suggestionButtons = (g: UnclassifiedGroup) =>
    g.suggestions.map((s) => (
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
  const groupCheckbox = (g: UnclassifiedGroup) => (
    <input type="checkbox" checked={selected.has(groupKey(g))} onChange={() => toggleSelected(groupKey(g))} />
  );
  const cleaningColumns: TableColumn<UnclassifiedGroup>[] = [
    // On the card the checkbox sits in the title, beside the name.
    { key: "select", header: "", cell: groupCheckbox, desktopOnly: true },
    {
      key: "name",
      header: t("groceries.cleaning.colName"),
      cell: (g) => g.description,
      title: (g) => (
        <span style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          {groupCheckbox(g)}
          {g.description}
        </span>
      ),
    },
    {
      key: "barcode",
      header: t("groceries.cleaning.colBarcode"),
      className: "muted",
      cell: (g) => g.barcode ?? "—",
      desktopOnly: true,
    },
    {
      key: "occurrences",
      header: t("groceries.cleaning.colOccurrences"),
      headerClassName: "num",
      className: "num",
      cell: (g) => g.occurrences,
    },
    { key: "lastSeen", header: t("groceries.cleaning.colLastSeen"), cell: (g) => isoDay(g.last_seen) },
    {
      key: "lastPrice",
      header: t("groceries.cleaning.colLastPrice"),
      headerClassName: "num",
      className: "num",
      cell: (g) => formatReceiptPesos(g.last_unit_price_clp),
    },
    {
      key: "suggestions",
      header: t("groceries.cleaning.colSuggestions"),
      cell: suggestionButtons,
      card: (g) => (g.suggestions.length > 0 ? suggestionButtons(g) : null),
    },
  ];

  type ProductRow = GroceriesSummary["products"][number];
  const productColumns: TableColumn<ProductRow>[] = [
    {
      key: "product",
      header: t("groceries.products.colProduct"),
      cell: (p) => (
        <Button variant="link" onClick={() => openHistory(p.id)}>
          {p.name}
        </Button>
      ),
      title: true,
    },
    {
      key: "aliases",
      header: t("groceries.products.colAliases"),
      headerClassName: "num",
      className: "num",
      cell: (p) => p.alias_count,
      desktopOnly: true,
    },
    {
      key: "purchases",
      header: t("groceries.products.colPurchases"),
      headerClassName: "num",
      className: "num",
      cell: (p) => p.purchase_count,
    },
    {
      key: "lastPurchased",
      header: t("groceries.products.colLastPurchased"),
      cell: (p) => isoDay(p.last_purchased_at),
    },
    {
      key: "lastPrice",
      header: t("groceries.products.colLastPrice"),
      headerClassName: "num",
      className: "num",
      cell: (p) =>
        p.last_effective_unit_price_clp != null ? formatReceiptPesos(p.last_effective_unit_price_clp) : "—",
    },
  ];

  const num = { headerClassName: "num", className: "num" };
  const historyColumns: TableColumn<ProductHistoryRow>[] = [
    { key: "date", header: t("groceries.history.colDate"), cell: (r) => isoMinute(r.purchased_at), title: true },
    { key: "branch", header: t("groceries.history.colBranch"), cell: (r) => r.branch },
    {
      key: "qty",
      header: t("groceries.history.colQty"),
      ...num,
      cell: (r) => `${r.qty}${r.qty_unit === "kg" ? " kg" : ""}`,
    },
    {
      key: "unitPrice",
      header: t("groceries.history.colUnitPrice"),
      ...num,
      cell: (r) => formatReceiptPesos(r.unit_price_clp),
    },
    {
      key: "discount",
      header: t("groceries.history.colDiscount"),
      ...num,
      cell: (r) => (r.discount_clp > 0 ? formatReceiptPesos(-r.discount_clp) : "—"),
      // The card leaves the row out when there was no discount.
      card: (r) => (r.discount_clp > 0 ? formatReceiptPesos(-r.discount_clp) : null),
    },
    {
      key: "effective",
      header: t("groceries.history.colEffective"),
      ...num,
      cell: (r) => formatReceiptPesos(r.effective_unit_price_clp),
    },
    ...(normalizedAvailable
      ? [
          {
            key: "normalized",
            header: t("groceries.history.colNormalized", { unit: baseUnitLabel }),
            ...num,
            cell: (r) =>
              r.normalized_unit_price_clp != null ? (
                formatReceiptPesos(r.normalized_unit_price_clp)
              ) : (
                <span className="muted">{t("groceries.history.noContent")}</span>
              ),
            card: (r) =>
              r.normalized_unit_price_clp != null
                ? formatReceiptPesos(r.normalized_unit_price_clp)
                : t("groceries.history.noContent"),
          } satisfies TableColumn<ProductHistoryRow>,
        ]
      : []),
    {
      key: "total",
      header: t("groceries.history.colTotal"),
      ...num,
      cell: (r) => formatReceiptPesos(r.total_clp - r.discount_clp),
    },
  ];

  type ReceiptRow = GroceriesSummary["receipts"][number];
  /** An open receipt's items (once fetched); null while closed. */
  const receiptItemsList = (r: ReceiptRow) =>
    openReceiptId === r.id && receiptItems[r.id] ? (
      <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
        {receiptItems[r.id]!.map((item) => (
          <li key={item.id}>
            {item.product_name ?? item.description}
            {item.product_name ? <span className="muted"> · {item.description}</span> : null} — {item.qty}
            {item.qty_unit === "kg" ? " kg" : ""} × {formatReceiptPesos(item.unit_price_clp)}
            {item.discount_clp > 0 ? ` (${formatReceiptPesos(-item.discount_clp)})` : ""} ={" "}
            {formatReceiptPesos(item.total_clp - item.discount_clp)}
          </li>
        ))}
      </ul>
    ) : null;
  const receiptColumns: TableColumn<ReceiptRow>[] = [
    {
      key: "date",
      header: t("groceries.receipts.colDate"),
      cell: (r) => isoMinute(r.purchased_at),
      // The card's title carries the branch too.
      title: (r) => `${isoMinute(r.purchased_at)} · ${r.branch}`,
    },
    { key: "branch", header: t("groceries.receipts.colBranch"), cell: (r) => r.branch, desktopOnly: true },
    {
      key: "city",
      header: t("groceries.receipts.colCity"),
      className: "muted",
      cell: (r) => r.city ?? "—",
      desktopOnly: true,
    },
    {
      key: "source",
      header: t("groceries.receipts.colSource"),
      // Provenance of the document that owns the row (e-mail PDF, hand-saved PDF, photo).
      cell: (r) => <Pill size="small" label={t(`groceries.receipts.source.${r.source}`)} />,
    },
    { key: "total", header: t("groceries.receipts.colTotal"), ...num, cell: (r) => formatReceiptPesos(r.total_clp) },
    {
      key: "cardPaid",
      header: t("groceries.receipts.colCardPaid"),
      ...num,
      // A card-paid receipt at a store no map names yet: flagged, no card line of its own until
      // the bank's line for the same day and amount pairs it.
      cell: (r) =>
        r.card_paid_clp > 0 ? (
          <>
            {formatReceiptPesos(r.card_paid_clp)}
            {r.card_line_status === "pending_branch" ? (
              <>
                {" "}
                <Pill
                  size="small"
                  label={t("groceries.receipts.cardLine.pendingBranch")}
                  title={t("groceries.receipts.cardLine.pendingBranchHint")}
                />
              </>
            ) : null}
          </>
        ) : (
          "—"
        ),
    },
    {
      key: "items",
      header: t("groceries.receipts.colItems"),
      ...num,
      cell: (r) => `${r.classified_count}/${r.item_count}`,
    },
    {
      key: "toggle",
      header: "",
      cell: (r) => (
        <Button variant="link" onClick={() => toggleReceipt(r.id)}>
          {openReceiptId === r.id ? t("groceries.receipts.hideItems") : t("groceries.receipts.showItems")}
        </Button>
      ),
    },
  ];

  return (
    <div className="page-grid">
      <h2 className="flow-section-title">{t("groceries.title")}</h2>

      {/* ── Cleaning workbench ─────────────────────────────────────────────── */}
      <PageGridTile id="cleaning">
        <h3>{t("groceries.cleaning.title")}</h3>
        {summary && summary.unclassified.length === 0 ? (
          <p className="muted">{t("groceries.cleaning.allClassified")}</p>
        ) : (
          <>
            <div
              style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}
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
            <ColumnTable
              rows={summary?.unclassified ?? []}
              columns={cleaningColumns}
              rowKey={groupKey}
              cardLayout="flat"
              tableClassName="data-table"
            />
          </>
        )}
      </PageGridTile>

      {/* ── Products + price history ───────────────────────────────────────── */}
      <PageGridTile id="products">
        <h3>{t("groceries.products.title")}</h3>
        {summary && summary.products.length === 0 ? (
          <p className="muted">{t("groceries.products.none")}</p>
        ) : (
          <ColumnTable
            rows={summary?.products ?? []}
            columns={productColumns}
            rowKey={(p) => p.id}
            rowProps={(p) => ({ className: p.id === historyProductId ? "row--selected" : undefined })}
            cardLayout="flat"
            tableClassName="data-table"
          />
        )}

        <h4>
          {t("groceries.history.title")}
          {historyProduct ? ` — ${historyProduct.name}` : ""}
        </h4>
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
              style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}
            >
              {normalizedOnly ? (
                <span className="muted">
                  {t("groceries.history.mixedPackages", { unit: baseUnitLabel })}
                </span>
              ) : (
                <select
                  value={effectivePriceMode}
                  onChange={(e) => setPriceMode(e.target.value as "effective" | "list" | "normalized")}
                >
                  <option value="effective">{t("groceries.history.priceEffective")}</option>
                  <option value="list">{t("groceries.history.priceList")}</option>
                  {normalizedAvailable ? (
                    <option value="normalized">
                      {t("groceries.history.priceNormalized", { unit: baseUnitLabel })}
                    </option>
                  ) : null}
                </select>
              )}
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
                    formatValue: (v) => formatReceiptPesos(Number(v)),
                    formatLabel: (l) => String(l),
                  }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tick={{ fill: "var(--muted)", fontSize: 10 }} minTickGap={24} />
                  <YAxis
                    tick={{ fill: "var(--muted)", fontSize: 10 }}
                    width={52}
                    tickFormatter={(v: number) => formatReceiptPesos(v)}
                    domain={yScale.domain}
                    ticks={yScale.ticks}
                  />
                  <Line type="monotone" dataKey="price" stroke="var(--accent, #2f81f7)" strokeWidth={2} dot />
                </AppLineChart>
              </div>
            ) : null}
            <ColumnTable
              rows={filteredHistory}
              columns={historyColumns}
              rowKey={(r, i) => `${r.purchased_at}-${i}`}
              cardLayout="flat"
              tableClassName="data-table"
            />
          </>
        )}
      </PageGridTile>

      {/* ── Receipts ───────────────────────────────────────────────────────── */}
      <PageGridTile id="receipts">
        <h3>{t("groceries.receipts.title")}</h3>
        {summary && summary.receipts.length === 0 ? (
          <p className="muted">{t("groceries.receipts.none")}</p>
        ) : (
          <ColumnTable
            rows={summary?.receipts ?? []}
            columns={receiptColumns}
            rowKey={(r) => r.id}
            rowExpansion={receiptItemsList}
            cardLayout="flat"
            tableClassName="data-table"
          />
        )}
      </PageGridTile>
    </div>
  );
}
