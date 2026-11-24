import { describe, expect, it } from "vitest";
import type { GroceryProductRow } from "../../types/groceries";
import { productPickTarget } from "./ProductPicker";

const product = (id: number, name: string) => ({ id, name }) as GroceryProductRow;
const products = [product(1, "Limon"), product(2, "Limón"), product(3, "Leche entera")];

describe("productPickTarget", () => {
  it("assigns to the product picked from the list, not the first with a folded-equal name", () => {
    expect(productPickTarget(products, { text: "Limón", productId: 2 })).toEqual({ productId: 2 });
  });

  it("drops a pick whose product left the catalog and reads the text instead", () => {
    const merged = [product(1, "Limon")];
    expect(productPickTarget(merged, { text: "Limón", productId: 2 })).toEqual({ productId: 1 });
  });

  it("prefers the exact name, then the one product the text folds to", () => {
    expect(productPickTarget(products, { text: " Limon ", productId: null })).toEqual({ productId: 1 });
    expect(productPickTarget(products, { text: "leche ENTERA", productId: null })).toEqual({ productId: 3 });
  });

  it("names nothing when several products fold to the text and none is exact", () => {
    expect(productPickTarget(products, { text: "limon", productId: null })).toBeNull();
  });

  it("offers a new product for a name no product folds to", () => {
    expect(productPickTarget(products, { text: "Palta", productId: null })).toEqual({ newName: "Palta" });
  });

  it("names nothing while the field is empty", () => {
    expect(productPickTarget(products, { text: "  ", productId: null })).toBeNull();
  });
});
