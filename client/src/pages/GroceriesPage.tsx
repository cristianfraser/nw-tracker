import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "@crfrsr/ui";
import { ChevronIcon } from "../components/ui/ChevronIcon";
import { CartesianGrid, Line, XAxis, YAxis } from "recharts";
import { api } from "../api";
import { PageGridTile } from "../components/layout/PageGridTile";
import { AppLineChart } from "../components/charts/AppLineChart";
import { buildNiceYAxis, minMaxForKeys } from "../components/charts/chartLayout";
import { ProductConfigPanel } from "../components/groceries/ProductConfigPanel";
import {
  EMPTY_PRODUCT_PICK,
  ProductPicker,
  foldSearch,
  productPickTarget,
  type ProductPickerValue,
} from "../components/groceries/ProductPicker";
import { useIsNarrowViewport } from "../useIsNarrowViewport";
import { cn } from "../cn";
import { Pill } from "../components/ui/Pill";
import { ColumnTable, type TableColumn } from "../components/ui/ColumnTable";
import { formatReceiptPesos } from "../formatNative";
import styles from "./GroceriesPage.module.css";
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

/** Rows a long list shows before its «show all» button. */
const COLLAPSED_ROWS = 10;
/** Purchases an open product lists before its «all purchases» button. */
const COLLAPSED_HISTORY_ROWS = 5;

/** Grocery receipts + product catalog (`/flows/expenses/groceries`). */
export function GroceriesPage() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<GroceriesSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** The assign target: a picked product, or typed text naming one (or a new one). */
  const [pick, setPick] = useState<ProductPickerValue>(EMPTY_PRODUCT_PICK);
  // On a phone the assign bar sticks to the bottom of the screen, so it comes after the list;
  // on the desktop it is above it, in reading (and tab) order.
  const narrow = useIsNarrowViewport();
  const [showAllUnclassified, setShowAllUnclassified] = useState(false);
  const [showAllReceipts, setShowAllReceipts] = useState(false);
  const [productQuery, setProductQuery] = useState("");
  const [showConfig, setShowConfig] = useState(false);
  const [showAllHistory, setShowAllHistory] = useState(false);
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

  const historyProductIdRef = useRef(historyProductId);
  historyProductIdRef.current = historyProductId;

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
        setPick(EMPTY_PRODUCT_PICK);
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

  /** Opens a product's price history under its row; the open product's own name closes it. */
  const openHistory = useCallback((productId: number) => {
    setHistoryRows(null);
    setProductDetail(null);
    setShowConfig(false);
    setShowAllHistory(false);
    if (historyProductIdRef.current === productId) {
      setHistoryProductId(null);
      return;
    }
    setHistoryProductId(productId);
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
        className={styles.name}
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
    { key: "select", header: "", cell: groupCheckbox },
    { key: "name", header: t("groceries.cleaning.colName"), cell: (g) => g.description },
    {
      key: "barcode",
      header: t("groceries.cleaning.colBarcode"),
      className: "muted",
      cell: (g) => g.barcode ?? "—",
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
    { key: "suggestions", header: t("groceries.cleaning.colSuggestions"), cell: suggestionButtons },
  ];
  /**
   * The card of an unclassified name: tick + name + last price, then barcode (names group by
   * barcode, so two with the same text tell apart by it), count, day and suggestions.
   */
  const cleaningCard = (g: UnclassifiedGroup) => (
    <div className={cn(styles.row, styles.rowTick)}>
      <label className={styles.tick}>
        {groupCheckbox(g)}
        <span className={styles.printed}>{g.description}</span>
      </label>
      <span className={styles.amount}>{formatReceiptPesos(g.last_unit_price_clp)}</span>
      <span className={styles.sub}>
        {g.barcode ? <span className="mono">{g.barcode} · </span> : null}
        {t("groceries.countAndLast", { count: g.occurrences, date: isoDay(g.last_seen) })}
        {g.suggestions.length > 0 ? <> · → {suggestionButtons(g)}</> : null}
      </span>
    </div>
  );

  type ProductRow = GroceriesSummary["products"][number];
  const productButton = (p: ProductRow) => (
    <Button
      variant="link"
      className={styles.name}
      onClick={() => openHistory(p.id)}
      aria-expanded={p.id === historyProductId}
    >
      {p.name}
      <ChevronIcon className={cn(styles.chevron, p.id === historyProductId && styles.chevronOpen)} />
    </Button>
  );
  const productLastPrice = (p: ProductRow) =>
    p.last_effective_unit_price_clp != null ? formatReceiptPesos(p.last_effective_unit_price_clp) : "—";
  const productColumns: TableColumn<ProductRow>[] = [
    { key: "product", header: t("groceries.products.colProduct"), cell: productButton },
    {
      key: "aliases",
      header: t("groceries.products.colAliases"),
      headerClassName: "num",
      className: "num",
      cell: (p) => p.alias_count,
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
      cell: productLastPrice,
    },
  ];
  /** A product's card: name + last price, then purchases, the last day and its printed names. */
  const productCard = (p: ProductRow) => (
    <div className={styles.row}>
      {productButton(p)}
      <span className={styles.amount}>{productLastPrice(p)}</span>
      <span className={styles.sub}>
        {t("groceries.countAndLast", { count: p.purchase_count, date: isoDay(p.last_purchased_at) })} ·{" "}
        {t("groceries.products.aliasCount", { count: p.alias_count })}
      </span>
    </div>
  );

  const num = { headerClassName: "num", className: "num" };
  const historyQty = (r: ProductHistoryRow) => `${r.qty}${r.qty_unit === "kg" ? " kg" : ""}`;
  const historyColumns: TableColumn<ProductHistoryRow>[] = [
    { key: "date", header: t("groceries.history.colDate"), cell: (r) => isoMinute(r.purchased_at) },
    { key: "branch", header: t("groceries.history.colBranch"), cell: (r) => r.branch },
    { key: "qty", header: t("groceries.history.colQty"), ...num, cell: historyQty },
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
          } satisfies TableColumn<ProductHistoryRow>,
        ]
      : []),
    {
      key: "total",
      header: t("groceries.history.colTotal"),
      ...num,
      cell: (r) => formatReceiptPesos(r.line_total_clp),
    },
  ];
  /**
   * A purchase's card: day + the effective price, then branch, quantity × list price, the
   * discount when there was one, the per-unit price when the product has one and the line total.
   */
  const historyCard = (r: ProductHistoryRow) => (
    <div className={styles.row}>
      <span className="mono">{isoMinute(r.purchased_at)}</span>
      <span className={styles.amount}>{formatReceiptPesos(r.effective_unit_price_clp)}</span>
      <span className={styles.sub}>
        {r.branch} · {historyQty(r)} × {formatReceiptPesos(r.unit_price_clp)}
        {r.discount_clp > 0 ? ` (${formatReceiptPesos(-r.discount_clp)})` : ""}
        {normalizedAvailable ? (
          <>
            {" · "}
            {r.normalized_unit_price_clp != null
              ? `${formatReceiptPesos(r.normalized_unit_price_clp)}/${baseUnitLabel}`
              : t("groceries.history.noContent")}
          </>
        ) : null}
        {" · "}
        {t("groceries.history.colTotal")} {formatReceiptPesos(r.line_total_clp)}
      </span>
    </div>
  );
  // Newest first: the list is cut to the latest purchases until asked for all.
  const historyNewestFirst = [...filteredHistory].reverse();
  const historyShown = showAllHistory ? historyNewestFirst : historyNewestFirst.slice(0, COLLAPSED_HISTORY_ROWS);

  /** The open product's detail, drawn under its row: price mode + filters, chart, purchases, settings. */
  const productHistory = (p: ProductRow) =>
    p.id !== historyProductId || historyRows == null ? null : (
      <div className={styles.detail}>
        <div className={styles.controls}>
          {normalizedOnly ? (
            <span className="muted">{t("groceries.history.mixedPackages", { unit: baseUnitLabel })}</span>
          ) : (
            <select
              value={effectivePriceMode}
              onChange={(e) => setPriceMode(e.target.value as "effective" | "list" | "normalized")}
            >
              <option value="effective">{t("groceries.history.priceEffective")}</option>
              <option value="list">{t("groceries.history.priceList")}</option>
              {normalizedAvailable ? (
                <option value="normalized">{t("groceries.history.priceNormalized", { unit: baseUnitLabel })}</option>
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
          {productDetail ? (
            <Button variant="link" onClick={() => setShowConfig((v) => !v)} aria-expanded={showConfig}>
              {t("groceries.config.title")}
              <ChevronIcon className={cn(styles.chevron, showConfig && styles.chevronOpen)} />
            </Button>
          ) : null}
        </div>
        {showConfig && productDetail ? (
          <ProductConfigPanel
            detail={productDetail}
            products={summary?.products ?? []}
            brands={brands}
            onChanged={refreshProductConfig}
          />
        ) : null}
        {chartData.length > 1 ? (
          <div className={styles.chart}>
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
          rows={historyShown}
          columns={historyColumns}
          card={historyCard}
          rowKey={(r, i) => `${r.purchased_at}-${i}`}
          tableClassName="data-table"
        />
        {historyNewestFirst.length > COLLAPSED_HISTORY_ROWS ? (
          <Button variant="ghost" onClick={() => setShowAllHistory((v) => !v)}>
            {showAllHistory
              ? t("table.showLess")
              : t("groceries.history.allPurchases", { count: historyNewestFirst.length })}
          </Button>
        ) : null}
      </div>
    );

  type ReceiptRow = GroceriesSummary["receipts"][number];
  /** An open receipt's items (once fetched); null while closed. One list for the row and the card. */
  const receiptItemsList = (r: ReceiptRow) =>
    openReceiptId === r.id && receiptItems[r.id] ? (
      <div className={styles.items}>
        {receiptItems[r.id]!.map((item) => (
          <div key={item.id} className={styles.row}>
            {item.product_name != null ? (
              <span className={styles.itemName}>{item.product_name}</span>
            ) : (
              <span className={cn(styles.printed, "muted")}>{item.description}</span>
            )}
            <span className={styles.amount}>{formatReceiptPesos(item.line_total_clp)}</span>
            <span className={styles.sub}>
              {item.qty}
              {item.qty_unit === "kg" ? " kg" : ""} × {formatReceiptPesos(item.unit_price_clp)}
              {item.discount_clp > 0 ? ` (${formatReceiptPesos(-item.discount_clp)})` : ""} ·{" "}
              {item.product_name != null ? (
                <span className={styles.printed}>{item.description}</span>
              ) : (
                t("groceries.receipts.itemUnclassified")
              )}
            </span>
          </div>
        ))}
      </div>
    ) : null;
  const sourcePill = (r: ReceiptRow) => <Pill size="small" label={t(`groceries.receipts.source.${r.source}`)} />;
  // A card-paid receipt at a store no map names yet: flagged, no card line of its own until
  // the bank's line for the same day and amount pairs it.
  const pendingBranchPill = (r: ReceiptRow) =>
    r.card_line_status === "pending_branch" ? (
      <Pill
        size="small"
        label={t("groceries.receipts.cardLine.pendingBranch")}
        title={t("groceries.receipts.cardLine.pendingBranchHint")}
      />
    ) : null;
  const receiptColumns: TableColumn<ReceiptRow>[] = [
    { key: "date", header: t("groceries.receipts.colDate"), cell: (r) => isoMinute(r.purchased_at) },
    { key: "branch", header: t("groceries.receipts.colBranch"), cell: (r) => r.branch },
    { key: "city", header: t("groceries.receipts.colCity"), className: "muted", cell: (r) => r.city ?? "—" },
    // Provenance of the document that owns the row (e-mail PDF, hand-saved PDF, photo).
    { key: "source", header: t("groceries.receipts.colSource"), cell: sourcePill },
    { key: "total", header: t("groceries.receipts.colTotal"), ...num, cell: (r) => formatReceiptPesos(r.total_clp) },
    {
      key: "cardPaid",
      header: t("groceries.receipts.colCardPaid"),
      ...num,
      cell: (r) =>
        r.card_paid_clp > 0 ? (
          <>
            {formatReceiptPesos(r.card_paid_clp)} {pendingBranchPill(r)}
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
        <Button variant="link" onClick={() => toggleReceipt(r.id)} aria-expanded={openReceiptId === r.id}>
          {openReceiptId === r.id ? t("groceries.receipts.hideItems") : t("groceries.receipts.showItems")}
        </Button>
      ),
    },
  ];
  /**
   * A receipt's card: day (opens the items) + source + total, then branch, city and classified
   * count; the card-paid amount only when it is not the total.
   */
  const receiptCard = (r: ReceiptRow) => (
    <div className={styles.row}>
      <span className={styles.receiptHead}>
        <Button
          variant="link"
          className={cn(styles.name, "mono")}
          onClick={() => toggleReceipt(r.id)}
          aria-expanded={openReceiptId === r.id}
          aria-label={`${isoMinute(r.purchased_at)} · ${
            openReceiptId === r.id ? t("groceries.receipts.hideItems") : t("groceries.receipts.showItems")
          }`}
        >
          {isoMinute(r.purchased_at)}
          <ChevronIcon className={cn(styles.chevron, openReceiptId === r.id && styles.chevronOpen)} />
        </Button>
        {sourcePill(r)}
      </span>
      <span className={styles.amount}>{formatReceiptPesos(r.total_clp)}</span>
      <span className={styles.sub}>
        {r.branch}
        {r.city ? ` · ${r.city}` : ""} · {t("groceries.receipts.classified", { classified: r.classified_count, total: r.item_count })}
        {r.card_paid_clp !== r.total_clp ? (
          <>
            {" · "}
            {t("groceries.receipts.colCardPaid")} {r.card_paid_clp > 0 ? formatReceiptPesos(r.card_paid_clp) : "—"}
          </>
        ) : null}{" "}
        {pendingBranchPill(r)}
      </span>
    </div>
  );

  const unclassified = summary?.unclassified ?? [];
  const unclassifiedShown = showAllUnclassified ? unclassified : unclassified.slice(0, COLLAPSED_ROWS);
  const receipts = summary?.receipts ?? [];
  const receiptsShown = showAllReceipts ? receipts : receipts.slice(0, COLLAPSED_ROWS);
  const products = summary?.products ?? [];
  const wantedProduct = foldSearch(productQuery);
  const productsShown =
    wantedProduct === "" ? products : products.filter((p) => foldSearch(p.name).includes(wantedProduct));

  const target = productPickTarget(products, pick);
  const assignSelected = () => {
    if (target == null) return;
    void ("productId" in target
      ? runClassify({ targets: selectedGroups, product_id: target.productId })
      : runClassify({ targets: selectedGroups, new_product_name: target.newName }));
  };
  const assignBar = (
    <div className={cn(styles.assignBar, selected.size === 0 && styles.assignBarIdle)}>
      <span>{t("groceries.cleaning.assignSelected", { count: selected.size })}</span>
      <ProductPicker products={products} value={pick} onChange={setPick} disabled={assignBusy} />
      <Button onClick={assignSelected} disabled={assignBusy || selected.size === 0 || target == null}>
        {target != null && "newName" in target ? t("groceries.cleaning.create") : t("groceries.cleaning.assign")}
      </Button>
    </div>
  );
  const assignNoteLine = assignNote ? <p className={cn("muted", styles.assignNote)}>{assignNote}</p> : null;

  return (
    <div className="page-grid">
      <h2 className="flow-section-title">{t("groceries.title")}</h2>

      {/* ── Cleaning workbench ─────────────────────────────────────────────── */}
      <PageGridTile id="cleaning">
        <h3>
          {t("groceries.cleaning.title")}
          {unclassified.length > 0 ? <span className={styles.count}> · {unclassified.length}</span> : null}
        </h3>
        {summary && unclassified.length === 0 ? (
          <p className="muted">{assignNote ?? t("groceries.cleaning.allClassified")}</p>
        ) : (
          <div className={styles.cleaning}>
            {narrow ? null : (
              <>
                {assignBar}
                {assignNoteLine}
              </>
            )}
            <ColumnTable
              rows={unclassifiedShown}
              columns={cleaningColumns}
              card={cleaningCard}
              rowKey={groupKey}
              tableClassName="data-table"
            />
            {unclassified.length > COLLAPSED_ROWS ? (
              <Button variant="ghost" onClick={() => setShowAllUnclassified((v) => !v)}>
                {showAllUnclassified ? t("table.showLess") : t("groceries.showAll", { count: unclassified.length })}
              </Button>
            ) : null}
            {narrow ? (
              <>
                {assignNoteLine}
                {/* After the list, so it sticks to the bottom of the screen while names are ticked. */}
                {assignBar}
              </>
            ) : null}
          </div>
        )}
      </PageGridTile>

      {/* ── Products, each opening its price history under its row ─────────── */}
      <PageGridTile id="products">
        <h3>
          {t("groceries.products.title")}
          {products.length > 0 ? <span className={styles.count}> · {products.length}</span> : null}
        </h3>
        {summary && products.length === 0 ? (
          <p className="muted">{t("groceries.products.none")}</p>
        ) : (
          <>
            <Input
              className={styles.search}
              type="search"
              value={productQuery}
              onChange={(e) => setProductQuery(e.target.value)}
              placeholder={t("groceries.products.search")}
              aria-label={t("groceries.products.search")}
            />
            <ColumnTable
              rows={productsShown}
              columns={productColumns}
              card={productCard}
              rowKey={(p) => p.id}
              rowProps={(p) => ({ className: p.id === historyProductId ? "row--selected" : undefined })}
              rowExpansion={productHistory}
              emptyLabel={summary ? t("groceries.products.noMatch") : undefined}
              tableClassName="data-table"
            />
          </>
        )}
      </PageGridTile>

      {/* ── Receipts ───────────────────────────────────────────────────────── */}
      <PageGridTile id="receipts">
        <h3>
          {t("groceries.receipts.title")}
          {receipts.length > 0 ? <span className={styles.count}> · {receipts.length}</span> : null}
        </h3>
        {summary && receipts.length === 0 ? (
          <p className="muted">{t("groceries.receipts.none")}</p>
        ) : (
          <>
            <ColumnTable
              rows={receiptsShown}
              columns={receiptColumns}
              card={receiptCard}
              rowKey={(r) => r.id}
              rowExpansion={receiptItemsList}
              tableClassName="data-table"
            />
            {receipts.length > COLLAPSED_ROWS ? (
              <Button variant="ghost" onClick={() => setShowAllReceipts((v) => !v)}>
                {showAllReceipts ? t("table.showLess") : t("groceries.showAll", { count: receipts.length })}
              </Button>
            ) : null}
          </>
        )}
      </PageGridTile>
    </div>
  );
}
