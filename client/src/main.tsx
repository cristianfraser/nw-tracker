import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@crfrsr/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./i18n";
import App from "./App";
import "./index.css";
// @crfrsr/ui: token defaults + component styles. The library reset is
// intentionally NOT imported (this app has its own reset); crfrsr-baseline.css
// supplies the small bit the components need on top of it.
import "@crfrsr/ui/tokens.css";
import "@crfrsr/ui/styles.css";
import "./styles/crfrsr-baseline.css";
import { AppErrorBoundary } from "./components/ui/AppErrorBoundary";
import { queryClient } from "./queryClient";
import { nwTrackerTheme } from "./theme";

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
