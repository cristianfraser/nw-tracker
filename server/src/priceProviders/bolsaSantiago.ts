/**
 * The Bolsa de Santiago adapter: daily peso closes of a registered Santiago instrument, asked by its
 * nemo (the registry's display symbol). The fetching stays in `equityBolsaSantiagoEod.ts`; this
 * declares it. The exchange's API states no instrument facts the app could register (no currency,
 * no type), so a Santiago instrument is described by Yahoo or declared.
 */
import { fetchBolsaSantiagoDailyCloses } from "../equityBolsaSantiagoEod.js";
import type { PriceProvider } from "./types.js";

export const bolsaSantiagoPriceProvider: PriceProvider = {
  id: "bolsa_santiago",
  describeSymbol: async (symbol) => {
    throw new Error(
      `the Bolsa de Santiago adapter serves daily closes only; describe ${symbol} with the yahoo provider or declare it`
    );
  },
  dailyCloses: (symbol) => fetchBolsaSantiagoDailyCloses(symbol),
};
