# Components

React UI organized by responsibility. Import from the subfolder that matches the component (e.g. `components/ui/Table`), or from barrel files where provided (`components/ui`).

## `ui/` — primitives

Stateless, reusable building blocks with no domain knowledge.

- **Modal**, **Table**, **Pill**, **ColorPickerThumb**

## `layout/` — app shell

Global chrome: navigation, page chrome, loading, ticker.

- **AppSidebar**, **MobileNavDrawer**, **AppDisplayPreferencesBar**, **PageTitleRow**, **GlobalLoadingSpinner**, **AppMarquee**, **MarketTickerPanel**

## `charts/` — data visualization

Recharts wrappers and chart panels shared across pages.

- **AppLineChart**, **ValuationLineCharts**, **MonthlyPerformanceComboChart**, category/apartment/deposit charts, **PortfolioGroupChartsSection**

## `dashboard/` — portfolio cards & metrics

Dashboard cards, NAV strips, entity summaries, color picker for entities.

- **CompactEntityCard**, **DashboardCard***, **Portfolio***, **DeltaMetricFlow**, **AnimatedNumberFlow**, **EntityColorPicker**, **HierarchyNavRow**

## `group/` — class / group pages

Shared sections for brokerage, liabilities, and group info routes.

- **GroupInfoBase**, **GroupInfoNavHierarchyTable**

## `account/` — account detail utilities

Tables and import UI used on account detail pages.

- **AccountFlowsTable**, **AccountImportPanel**, **AccountImportSection**, **MonthlyPerfDetailTable**

## `credit-card/` — credit card expenses UI

Expenses tab tables for the Pasivos credit card group.

- **CreditCardGroupExpensesMonthTable**, **CreditCardExpenseLinesTable**, **CreditCardExpenseMonthModalSections** (expenses month modal: compras / cuotas / abonos / excluidos), **CreditCardFacturacionModalSections** (facturación modal: gastos / abonos), **CreditCardUnclassifiedExpensesTable**

## `sync/` — sync / messages

- **SyncLogStatusPanel**
