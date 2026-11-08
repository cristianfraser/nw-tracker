/** An account a group page's consolidated tables cover. */
export type GroupInfoTableAccount = {
  id: number;
  name: string;
  /** Optional: dashboard/page-bundle rows may omit category_slug. */
  category_slug?: string;
};
