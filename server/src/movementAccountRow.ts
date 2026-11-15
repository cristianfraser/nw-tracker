/** The account facts the movement-create rules read (`accountRowForId` loads them). */
export type AccountRow = {
  /** The account's id, when the row came from the database (`accountRowForId`); an option contract is told by it. */
  account_id?: number;
  bucket_slug: string;
  group_slug: string;
  notes?: string | null;
  import_key?: string | null;
  equity_ticker?: string | null;
};
