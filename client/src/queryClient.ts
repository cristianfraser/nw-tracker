import { QueryClient } from "@tanstack/react-query";
import { shareKeepingLiveInputs } from "./liveInputs";
import { trackFetchTimes } from "./queries/heldUnitPayload";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      // Keeps each payload's live inputs through structural sharing (`liveInputs.ts`).
      structuralSharing: shareKeepingLiveInputs,
    },
  },
});

// The held surfaces date a cached copy by its last fetch, never by an in-place patch.
trackFetchTimes(queryClient);
