/**
 * One row of a bank account's recent-movements listing, as the bank lists it: the bank's posting
 * date, the bank's description, the signed peso amount, the document number ("" when the row
 * prints none). The posting date is the row's identity (note key, cartola and transfer matching);
 * the stored `occurred_on` may be earlier (see {@link importCheckingPartialMovements}).
 */
export type PartialBankMovement = {
  occurred_on: string;
  description: string;
  amount_clp: number;
  document_no: string;
};
