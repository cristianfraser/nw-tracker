/**
 * @deprecated Import from `bcentralApi.js` — SBIF replaced by Banco Central BDE API.
 */
export {
  BCENTRAL_WS_BASE,
  bcentralIndexDateToYmd,
  fetchBcentralJson,
  fetchBcentralSearchSeries,
  fetchBcentralSeries,
  fetchDolarAfterDate,
  fetchDolarYear,
  fetchEuroAfterDate,
  fetchEuroYear,
  fetchIpcAfterMonth,
  fetchIpcYear,
  fetchUfAfterDate,
  fetchUfYear,
  fetchUtmAfterMonth,
  fetchUtmYear,
  isBcentralConfigured,
  isBcentralNoDataError,
  loadBcentralCredentials,
  parseBcentralNumber,
  type BcentralCredentials,
  type BcentralSeriesInfo,
} from "./bcentralApi.js";

/** @deprecated use `parseBcentralNumber` */
export { parseBcentralNumber as parseSbifNumber } from "./bcentralApi.js";

/** @deprecated use `isBcentralNoDataError` */
export { isBcentralNoDataError as isSbifNoDataError } from "./bcentralApi.js";
