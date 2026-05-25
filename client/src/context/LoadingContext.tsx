import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { GlobalLoadingSpinner } from "../components/layout/GlobalLoadingSpinner";

type LoadingContextValue = {
  loading: boolean;
  setLoading: (active: boolean) => void;
};

const LoadingContext = createContext<LoadingContextValue | null>(null);

export function LoadingProvider({ children }: { children: ReactNode }) {
  const [loading, setLoadingState] = useState(false);

  const setLoading = useCallback((active: boolean) => {
    setLoadingState(active);
  }, []);

  const value = useMemo(
    () => ({
      loading,
      setLoading,
    }),
    [loading, setLoading]
  );

  return (
    <LoadingContext.Provider value={value}>
      {children}
      {value.loading ? <GlobalLoadingSpinner /> : null}
    </LoadingContext.Provider>
  );
}

export function useLoading(): LoadingContextValue {
  const ctx = useContext(LoadingContext);
  if (!ctx) {
    throw new Error("useLoading must be used within LoadingProvider");
  }
  return ctx;
}
