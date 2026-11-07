/**
 * Re-export of the number parsers in `nw-tracker-contracts` (formats/numbers.ts) for the importers
 * other untangle streams own (afpUnoApi, spAfpFundUnits, siiInformedDj, siiOfficialIpc and four
 * server/scripts). New code imports from `nw-tracker-contracts`.
 */
export { isChileanNumber, parseChileanNumber, parseOptionalChileanInteger, parseUsNumber } from "nw-tracker-contracts";
