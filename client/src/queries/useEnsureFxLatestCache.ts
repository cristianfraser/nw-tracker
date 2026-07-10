import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { readFxLatestCache, writeFxLatestCache } from "./fxLatestCache";
import { queryKeys } from "./keys";

/**
 * Seed the localStorage FX cache (`nw:fx-latest-v1`) when it is empty. Only the dashboard bundle
 * carries `fx` and writes the cache; deep-linking to a group/account page without ever visiting
 * the dashboard would leave the CLP↔USD keep-previous conversions without a rate (charts blink
 * to the flat-zero placeholder). One fetch per session at most — no-op once the cache exists.
 */
export function useEnsureFxLatestCache(enabled = true) {
  const hasCache = readFxLatestCache() != null;
  useQuery({
    queryKey: queryKeys.fxLatest(),
    queryFn: async () => {
      const fx = await api.fxLatest();
      writeFxLatestCache(fx);
      return fx ?? null;
    },
    enabled: enabled && !hasCache,
    staleTime: Infinity,
    retry: 1,
  });
}
