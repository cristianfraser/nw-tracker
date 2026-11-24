import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ComboBox, Input, ListBox, ListBoxItem, Popover } from "react-aria-components";
import { foldAccents } from "nw-tracker-contracts/formats/text";
import type { GroceryProductRow } from "../../types/groceries";
import { useIsNarrowViewport } from "../../useIsNarrowViewport";
import styles from "./ProductPicker.module.css";

const CREATE_KEY = "__create__";
/** Options listed at once: the list is a filter, so a long tail is reached by typing. */
const MAX_OPTIONS = 40;

/** Search text: accents and case dropped, so «limon» finds «Limón». */
export function foldSearch(text: string): string {
  return foldAccents(text).toLowerCase().trim();
}

/**
 * The picker's value: the field's text, and the product picked from the list while the text is
 * still that product's name. Typing clears the pick, so the text alone then names the target.
 */
export type ProductPickerValue = { text: string; productId: number | null };

export const EMPTY_PRODUCT_PICK: ProductPickerValue = { text: "", productId: null };

/**
 * What the picker names: the picked product, else the product whose name is exactly the typed
 * text (the server dedupes exact names on create, so assigning to it is what create would do),
 * else a new product's name. Accents and case are NOT folded here: «Limon» and «Limón» may both
 * be products, and each must be reachable.
 */
export function productPickTarget(
  products: readonly GroceryProductRow[],
  value: ProductPickerValue
): { productId: number } | { newName: string } | null {
  if (value.productId != null) return { productId: value.productId };
  const name = value.text.trim();
  if (name === "") return null;
  const exact = products.find((p) => p.name === name);
  return exact ? { productId: exact.id } : { newName: name };
}

/**
 * Pick-or-name a product: a text field that filters the catalog as you type. A typed name that
 * is no product's is a new product's name, offered as the last option. The popover is as wide as
 * the field.
 */
export function ProductPicker({
  products,
  value,
  onChange,
  disabled = false,
}: {
  products: readonly GroceryProductRow[];
  value: ProductPickerValue;
  onChange: (value: ProductPickerValue) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  // On a phone the options open above the field: below it is the on-screen keyboard.
  const narrow = useIsNarrowViewport();
  // react-aria reports a pick as a selection AND as the field's new text, in either order, within
  // one event (so `value` is the same stale prop in both): the ref carries the pick across them.
  const pickRef = useRef<{ id: number; name: string } | null>(null);
  const options = useMemo(() => {
    const wanted = foldSearch(value.text);
    const matches = wanted === "" ? products : products.filter((p) => foldSearch(p.name).includes(wanted));
    return matches.slice(0, MAX_OPTIONS);
  }, [products, value.text]);
  const target = productPickTarget(products, value);
  const offersCreate = target != null && "newName" in target;

  return (
    <ComboBox
      className={styles.picker}
      aria-label={t("groceries.cleaning.pickerPlaceholder")}
      inputValue={value.text}
      onInputChange={(text) => {
        const pick = pickRef.current;
        if (pick && text === pick.name) {
          onChange({ text, productId: pick.id });
          return;
        }
        pickRef.current = null;
        onChange({ text, productId: null });
      }}
      onSelectionChange={(key) => {
        if (key == null || key === CREATE_KEY) return;
        const picked = products.find((p) => String(p.id) === String(key));
        if (!picked) return;
        pickRef.current = { id: picked.id, name: picked.name };
        onChange({ text: picked.name, productId: picked.id });
      }}
      selectedKey={null}
      allowsCustomValue
      allowsEmptyCollection
      menuTrigger="focus"
      isDisabled={disabled}
    >
      <Input
        className={`crfrsr-input crfrsr-input--md ${styles.input}`}
        placeholder={t("groceries.cleaning.pickerPlaceholder")}
      />
      <Popover className={styles.popover} offset={4} placement={narrow ? "top start" : "bottom start"}>
        <ListBox className={styles.list}>
          {options.map((p) => (
            <ListBoxItem key={p.id} id={String(p.id)} textValue={p.name} className={styles.option}>
              {p.name}
            </ListBoxItem>
          ))}
          {offersCreate ? (
            <ListBoxItem id={CREATE_KEY} textValue={target.newName} className={`${styles.option} ${styles.create}`}>
              {t("groceries.cleaning.createOption", { name: target.newName })}
            </ListBoxItem>
          ) : null}
        </ListBox>
      </Popover>
    </ComboBox>
  );
}
