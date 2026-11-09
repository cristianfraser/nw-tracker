/**
 * The hosted demo accepts a few edits without free text (server: `demoWritePolicy.ts`,
 * docs/demo-about-plan.md §4). In a demo build the controls for the closed ones — notes, creating or
 * renaming big groups, deleting imported lines, income type changes, branch picks — are hidden
 * rather than left to fail, and a manual expense's description is picked from the server's list.
 */
export const DEMO_EDITS_LIMITED = import.meta.env.VITE_DEMO_MODE === "1";

/** Mirror of the server's `DEMO_MANUAL_EXPENSE_DESCRIPTIONS` (stored as written, not translated). */
export const DEMO_MANUAL_EXPENSE_DESCRIPTIONS = [
  "Coffee",
  "Lunch",
  "Groceries",
  "Taxi",
  "Parking",
  "Pharmacy",
  "Haircut",
  "Books",
  "Cinema",
  "Gift",
] as const;
