import { Button } from "@crfrsr/ui";
import { HeadingLink } from "../ui/HeadingLink";
import { useTranslation } from "../../i18n";
import { useHeldLatestMovements } from "../../queries/hooks";
import type { CcExpenseBigGroupDto, CcExpenseCategoryDto, LatestCardPayment, LatestIncomeMovement, LatestMovementsResponse } from "../../types";
import { hasSchemaVersion, persistedPayload, usePersistedPayload } from "../../queries/persistedPayloadCache";
import { PageGridTile } from "../layout/PageGridTile";
import {
  CreditCardExpenseLinesTable,
  ExpenseListStaticRow,
  MoneyAmount,
  expenseListVendorClassName,
  type ExpenseListItem,
} from "../credit-card/CreditCardExpenseLinesTable";
import { ExpenseOriginIcon } from "../credit-card/ExpenseOriginIcon";
import { ExpenseVendorLabel } from "../credit-card/ExpenseVendorLabel";
import { PillPicker } from "../ui/PillPicker";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";

const LATEST_MOVEMENTS_LIMIT = 15;

/** A stored «Últimos movimientos» entry the panel can draw. */
function isLatestMovements(v: unknown): v is LatestMovementsResponse {
  if (v == null || typeof v !== "object") return false;
  const { rows, categories, big_groups } = v as Record<string, unknown>;
  return (
    Array.isArray(rows) &&
    Array.isArray(categories) &&
    Array.isArray(big_groups) &&
    rows.every((r) => {
      if (r == null || typeof r !== "object" || typeof r.on !== "string" || typeof r.arrival_key !== "string") return false;
      if (r.kind === "expense") {
        return r.line != null && r.line.name != null && typeof r.line.purchase_key === "string" && r.line.amount != null && Number.isFinite(r.line.amount.value) && r.line.converted !== undefined && typeof r.line.value_clp === "number";
      }
      if (r.kind === "income") {
        return r.income != null && r.income.name != null && typeof r.income.key === "string" && r.income.amount != null && Number.isFinite(r.income.amount.value) && r.income.converted !== undefined;
      }
      if (r.kind === "card_payment") {
        return r.payment != null && typeof r.payment.key === "string" && r.payment.amount != null && Number.isFinite(r.payment.amount.value) && r.payment.converted !== undefined && Array.isArray(r.payment.lines);
      }
      return false;
    })
  );
}

const LATEST_MOVEMENTS = persistedPayload(
  "latest_movements",
  (v): v is LatestMovementsResponse => hasSchemaVersion(v, "latest_movements") && isLatestMovements(v)
);

/** An income credit drawn in the expense rows' grid: origin, date, its kind as a pill, the payer, the pesos. */
function IncomeMovementRow({ on, income }: { on: string; income: LatestIncomeMovement }) {
  const { t } = useTranslation();
  return (
    <ExpenseListStaticRow
      origin={
        <ExpenseOriginIcon
          origin={{
            kind: income.source === "checking" ? "checking" : "manual",
            account_name: income.account_label,
            card_last4: null,
            additional: false,
          }}
        />
      }
      date={on}
      pills={
        <PillPicker
          readOnly
          value={income.income_kind ? { key: income.income_kind, label: t(`income.chart.${income.income_kind}`) } : null}
          emptyLabel={t("income.chart.other")}
          options={[]}
          onSelect={() => undefined}
          onClear={() => undefined}
          clearLabel=""
          ariaLabel=""
        />
      }
      vendor={
        <ExpenseVendorLabel
          // The server's name for the credit («Transf. de <payer>»), the bank's description in the ⓘ card.
          source={{
            name: income.name,
            name_detail: income.name_detail,
            link_label: income.link_label,
            transfer_counterparty: income.transfer_counterparty,
          }}
          note={null}
          className={expenseListVendorClassName}
        />
      }
      amount={<MoneyAmount money={income} />}
    />
  );
}

/**
 * A card payment, once: «Pago Lider ·0101 · desde Santander ·0781» / «… · desde Cuenta corriente»,
 * its amount in its own currency, and in its ⋯ panel the evidence lines (the PAGO on the card paid,
 * the paying charge or plan) with their own category and note controls.
 */
function CardPaymentRow({
  on,
  payment,
  categories,
  bigGroups,
  unit,
}: {
  on: string;
  payment: LatestCardPayment;
  categories: readonly CcExpenseCategoryDto[];
  bigGroups: readonly CcExpenseBigGroupDto[];
  /** The unit the panel's payload was requested in. */
  unit: string | null;
}) {
  const { t } = useTranslation();
  const from =
    payment.from.kind === "card"
      ? t("dashboard.latestMovements.fromCard", { brand: payment.from.card_brand, last4: payment.from.card_last4 })
      : payment.from.account_name;
  const name = t("dashboard.latestMovements.cardPayment", {
    brand: payment.to.card_brand,
    last4: payment.to.card_last4,
    from,
  });
  return (
    <ExpenseListStaticRow
      origin={
        <ExpenseOriginIcon
          origin={{
            kind: payment.from.kind === "card" ? "card" : "checking",
            account_name: payment.from.kind === "account" ? payment.from.account_name : null,
            card_last4: payment.from.kind === "card" ? payment.from.card_last4 : null,
            additional: false,
          }}
        />
      }
      date={on}
      pills={
        <PillPicker
          readOnly
          value={{ key: "card_payment", label: t("dashboard.latestMovements.cardPaymentPill") }}
          emptyLabel=""
          options={[]}
          onSelect={() => undefined}
          onClear={() => undefined}
          clearLabel=""
          ariaLabel=""
        />
      }
      vendor={<ExpenseVendorLabel source={{ name: { kind: "text", text: name } }} note={null} className={expenseListVendorClassName} />}
      amount={<MoneyAmount money={payment} />}
      moreAriaLabel={t("expenses.creditCard.lineRow.moreAria", { merchant: name })}
      panel={
        payment.lines.length > 0 ? (
          <CreditCardExpenseLinesTable
            lines={payment.lines}
            unit={unit}
            categories={categories}
            bigGroups={bigGroups}
            showBigGroupControls
            enableCheckingNotes
            hideHeader
            emptyLabel=""
          />
        ) : null
      }
    />
  );
}

/**
 * Home «Últimos movimientos»: the newest expense lines across every source (card, checking,
 * manual, payroll) and the income credits, interleaved by the day they happened, as the server
 * lists them (`GET /api/dashboard/latest-movements`). Expense rows are the Expenses page's own row
 * (`CreditCardExpenseLinesTable`: category and big-group pills, note, linked details) dated by the
 * movement's day; income rows share its grid.
 */
export function LatestMovementsTable() {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  // Held across a unit switch, in the unit it was requested in (`query.unit`: the payload has none).
  const query = useHeldLatestMovements("home.latestMovements", LATEST_MOVEMENTS_LIMIT, displayUnit);
  // Before anything was drawn this session, the last stored copy of this unit (its rows' values
  // are in it; the payload names no unit, so its unit is the one it was stored under).
  const { value: data, storedUnit } = usePersistedPayload(
    LATEST_MOVEMENTS,
    { surface: `latestMovements|${LATEST_MOVEMENTS_LIMIT}`, unit: displayUnit, scope: [displayUnit] },
    { shown: query.data, live: query.live, failed: query.error != null }
  );
  const unit = storedUnit ?? query.unit ?? null;
  // A stored copy of this unit paints undimmed (first paint); one held across a switch dims.
  const loading = data == null || (storedUnit != null ? storedUnit !== displayUnit : query.loading);
  const loadError = query.error;

  const items: ExpenseListItem[] = (data?.rows ?? []).map((r) => {
    if (r.kind === "expense") return { kind: "expense", on: r.on, line: r.line, arrivalKey: r.arrival_key };
    if (r.kind === "income") {
      return { kind: "custom", key: r.income.key, arrivalKey: r.arrival_key, node: <IncomeMovementRow on={r.on} income={r.income} /> };
    }
    return {
      kind: "custom",
      key: r.payment.key,
      arrivalKey: r.arrival_key,
      node: (
        <CardPaymentRow
          on={r.on}
          payment={r.payment}
          categories={data?.categories ?? []}
          bigGroups={data?.big_groups ?? []}
          unit={unit}
        />
      ),
    };
  });

  return (
    <PageGridTile id="latest-movements" className="dashboard-rail-fill">
      <h2>
        <HeadingLink to="/flows/expenses">{t("dashboard.latestMovements.title")}</HeadingLink>
      </h2>
      {loadError ? (
        <p className="error">
          {loadError instanceof Error ? loadError.message : t("common.loadFailedTables")}
        </p>
      ) : (
        <div className="dashboard-rail-fill__scroll">
          <CreditCardExpenseLinesTable
            items={items}
            categories={data?.categories ?? []}
            bigGroups={data?.big_groups ?? []}
            showBigGroupControls
            enableCheckingNotes
            hideHeader
            emptyLabel={t("dashboard.latestMovements.empty")}
            loading={loading}
            unit={unit}
            animateArrivals
          />
          {/* Not wired yet: a longer list comes later. */}
          <Button variant="ghost" onClick={() => undefined}>
            {t("dashboard.latestMovements.showMore")}
          </Button>
        </div>
      )}
    </PageGridTile>
  );
}
