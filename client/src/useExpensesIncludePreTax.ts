import { useCallback, useState } from "react";

const LS_KEY = "nw-tracker.expenses.includePreTax";

function readStored(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Whether the Expenses page also counts the deductions taken from a payslip (pre-tax expenses);
 * off by default, remembered per browser. The page tracks spending from net pay.
 */
export function useExpensesIncludePreTax(): {
  includePreTax: boolean;
  setIncludePreTax: (include: boolean) => void;
} {
  const [includePreTax, setState] = useState<boolean>(readStored);
  const setIncludePreTax = useCallback((include: boolean) => {
    setState(include);
    try {
      localStorage.setItem(LS_KEY, include ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, []);
  return { includePreTax, setIncludePreTax };
}
