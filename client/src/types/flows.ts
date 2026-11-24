/** Re-export of the shared DTOs (`server/contracts/src/dto/flows.ts`, docs/untangle-plan.md F8). */
export * from "nw-tracker-contracts/dto/flows";

/** What the Expenses page asks the spent endpoints for (client-side request shape). */
export type ExpensesSpentParams = {
  unit: string;
  mode: "split" | "total";
  level: "category" | "subcategory";
  range: import("nw-tracker-contracts/dto/flows").ExpensesSpentRange;
  excludedBigGroups: readonly string[];
  includePreTax: boolean;
};
