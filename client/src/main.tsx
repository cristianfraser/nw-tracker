import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@crfrsr/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./i18n";
import App from "./App";
// @crfrsr/ui: shared reset + token defaults + component styles, before the
// app's own CSS so app rules win. The library reset is the single reset for
// all crfrsr apps (the app's former Meyer reset was removed in its favor).
import "@crfrsr/ui/reset.css";
import "@crfrsr/ui/tokens.css";
import "@crfrsr/ui/styles.css";
import "./index.css";
import { AppErrorBoundary } from "./components/ui/AppErrorBoundary";
import { queryClient } from "./queryClient";
import { nwTrackerTheme } from "./theme";
import { installVersionConsoleHelper } from "./version";

installVersionConsoleHelper();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <ThemeProvider theme={nwTrackerTheme} skipBodyFontFamily>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter
            future={{
              v7_startTransition: true,
              v7_relativeSplatPath: true,
            }}
          >
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </ThemeProvider>
    </AppErrorBoundary>
  </StrictMode>
);
