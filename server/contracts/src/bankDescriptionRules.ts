import { fileURLToPath } from "node:url";

/**
 * How the bank's checking descriptions are read (own transfers, card payments, investment wires,
 * DAP refunds): one rule set, `data/bankDescriptionRules.json`, compiled by the server's
 * `cards/bankDescriptions.ts`. The owner's name is not in it: it is the `owner_identity` table.
 */
export const BANK_DESCRIPTION_RULES_PATH = fileURLToPath(new URL("../data/bankDescriptionRules.json", import.meta.url));
