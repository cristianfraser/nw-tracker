import type { ReactNode } from "react";
import { DEMO_EDITS_LIMITED } from "../../demoEdits";
import { useTranslation } from "../../i18n";
import type { IncomeKind } from "../../types";
import { useIncomeRentPlaces } from "../../queries/hooks";
import { useIncomeRefundMutation, usePatchIncomeMovementMutation } from "../../queries/mutations";
import { cn } from "../../cn";
import { Pill } from "../ui/Pill";
import { PillPicker, type PillPickerOption } from "../ui/PillPicker";
import { incomeKindColor } from "./incomeColors";
import styles from "./IncomeRows.module.css";

/**
 * One income line of a row list (`styles.lines`): date, kind (or what stands in its place: a
 * refund's category, a filter's reason), name, account, amount and an action. On a wide list each
 * is a column; on a narrow one the row is date + amount, the name, then kind + account + action.
 * `note` is a line of its own under the row (a salary's payslip).
 */
export function IncomeLineRow({
  date,
  kind,
  name,
  account,
  amount,
  action,
  note,
}: {
  date: string;
  kind: ReactNode;
  name: ReactNode;
  account: ReactNode;
  amount: string;
  action?: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className={styles.row}>
      <span className={cn("mono muted", styles.lDate, styles.nowrap)}>{date}</span>
      <span className={styles.lKind}>{kind}</span>
      <div className={styles.lName}>{name}</div>
      <span className={cn("muted", styles.lAccount, styles.ellipsis)}>{account}</span>
      <span className={cn("mono", styles.lAmount, styles.num)}>{amount}</span>
      <span className={styles.lAction}>{action}</span>
      {note ? <div className={cn(styles.lNote, styles.small)}>{note}</div> : null}
    </div>
  );
}

/** The type picker's «refund of spending» choice (not an income kind: it moves the credit to the expenses). */
const REFUND_OPTION = "__refund";
/** A rent choice names its place: `rent:<place slug>`. */
const RENT_OPTION_PREFIX = "rent:";

/** An income kind nobody can change here (a manual entry, a dollar wire's payslip). */
export function IncomeKindPill({ kind }: { kind: IncomeKind }) {
  const { t } = useTranslation();
  return (
    <Pill
      size="small"
      uppercase={false}
      label={t(`income.chart.${kind}`)}
      backgroundColor={kind === "other" ? undefined : incomeKindColor(kind)}
    />
  );
}

/**
 * A checking credit's income kind as a pill that opens the choices: salary, severance, the
 * parent's gift, a rent per tracked place, or «refund of spending» (which takes the credit out of
 * income). «Unclassified» is the unset pill; clearing a kind returns to it.
 */
export function IncomeKindPicker({ movementId, kind }: { movementId: number; kind: IncomeKind }) {
  const { t } = useTranslation();
  const patch = usePatchIncomeMovementMutation();
  const refund = useIncomeRefundMutation();
  const rentPlaces = useIncomeRentPlaces();

  const rentOptions: PillPickerOption[] = (rentPlaces.data?.places ?? []).map((p) => ({
    key: `${RENT_OPTION_PREFIX}${p.slug}`,
    label: t(p.dfl2 ? "income.rentOptionDfl2" : "income.rentOption", { place: p.label }),
    color: incomeKindColor("rent"),
  }));
  const kindOptions: PillPickerOption[] = (["salary", "severance", "parent_gift"] as const).map((k) => ({
    key: k,
    label: t(`income.chart.${k}`),
    color: incomeKindColor(k),
  }));
  const refundOption: PillPickerOption = { key: REFUND_OPTION, label: t("income.markRefund") };

  let value: PillPickerOption | null = null;
  if (kind === "rent") {
    const slug = rentPlaces.data?.place_by_movement_id[movementId];
    value = rentOptions.find((o) => o.key === `${RENT_OPTION_PREFIX}${slug}`) ?? {
      key: RENT_OPTION_PREFIX,
      label: t("income.chart.rent"),
      color: incomeKindColor("rent"),
    };
  } else if (kind !== "other") {
    value = kindOptions.find((o) => o.key === kind) ?? null;
  }

  return (
    <PillPicker
      value={value}
      emptyLabel={t("income.chart.other")}
      // The demo opens only the refund mark; the other kinds stay as generated.
      options={DEMO_EDITS_LIMITED ? [refundOption] : [...kindOptions, ...rentOptions, refundOption]}
      pending={patch.isPending || refund.isPending}
      ariaLabel={t("income.colIncomeKind")}
      clearLabel={t("income.clearKind")}
      onClear={() => patch.mutate({ movement_id: movementId, income_kind: "other" })}
      onSelect={(key) => {
        if (key === REFUND_OPTION) {
          refund.mutate({ movement_id: movementId, refund: true });
        } else if (key.startsWith(RENT_OPTION_PREFIX)) {
          patch.mutate({
            movement_id: movementId,
            income_kind: "rent",
            rent_place_slug: key.slice(RENT_OPTION_PREFIX.length),
          });
        } else {
          patch.mutate({ movement_id: movementId, income_kind: key as IncomeKind });
        }
      }}
    />
  );
}
