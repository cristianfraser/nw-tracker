import { QueryClient } from "@tanstack/react-query";
import { shareKeepingLiveInputs } from "./liveInputs";

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
