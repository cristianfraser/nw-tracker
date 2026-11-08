import { usePersistedPref } from "./usePersistedPref";

const parseInclude = (raw: string | null) => raw === "1";
const asText = (include: boolean) => (include ? "1" : "0");

/**
 * Whether the Expenses page also counts the deductions taken from a payslip (pre-tax expenses);
 * off by default, remembered per browser. The page tracks spending from net pay.
 */
export function useExpensesIncludePreTax(): {
  includePreTax: boolean;
  setIncludePreTax: (include: boolean) => void;
} {
  const [includePreTax, setIncludePreTax] = usePersistedPref("nw-tracker.expenses.includePreTax", parseInclude, asText);
  return { includePreTax, setIncludePreTax };
}
