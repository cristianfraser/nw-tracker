import { describe, expect, it } from "vitest";
import type { GroceryProductRow } from "../../types/groceries";
import { productPickTarget } from "./ProductPicker";

const product = (id: number, name: string) => ({ id, name }) as GroceryProductRow;
const products = [product(1, "Limon"), product(2, "Limón"), product(3, "Leche entera")];

describe("productPickTarget", () => {
  it("assigns to the product picked from the list, not the first with a folded-equal name", () => {
    expect(productPickTarget(products, { text: "Limón", productId: 2 })).toEqual({ productId: 2 });
  });

  it("matches typed text by its exact name only", () => {
    expect(productPickTarget(products, { text: " Limon ", productId: null })).toEqual({ productId: 1 });
    expect(productPickTarget(products, { text: "limon", productId: null })).toEqual({ newName: "limon" });
  });

  it("offers a new product for a name only accents or case set apart", () => {
    const onlyPlain = [product(1, "Limon")];
    expect(productPickTarget(onlyPlain, { text: "Limón", productId: null })).toEqual({ newName: "Limón" });
  });

  it("names nothing while the field is empty", () => {
    expect(productPickTarget(products, { text: "  ", productId: null })).toBeNull();
  });
});
