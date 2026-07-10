import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolveVersionInfo } from "../scripts/version-info.mjs";

const apiProxy = {
  "/api": {
    target: process.env.NW_TRACKER_API_PROXY_TARGET ?? "http://localhost:3001",
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react()],
  // Bake the client version into the bundle (dev-server start / build time). The
  // server reports its own version at /api/health — see scripts/version-info.mjs.
  define: { __NW_CLIENT_VERSION__: JSON.stringify(resolveVersionInfo()) },
  server: {
    port: 5173,
    proxy: apiProxy,
  },
  preview: {
    port: 4173,
    proxy: apiProxy,
  },
});
