import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  plugins: [
    remix({
      ignoredRouteFiles: ["**/.*"],
      future: {
        v3_fetcherPersist: true,
        v3_lazyRouteDiscovery: true,
        v3_relativeSplatPath: true,
        v3_singleFetch: true,
        v3_throwAbortReason: true,
      },
    }),
  ],
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "./app"),
    },
  },
  server: {
    port: 3000,
    allowedHosts: [
      "shopify-ai-text-manager-production.up.railway.app",
      "shopify-ai-text-manager-development.up.railway.app",
      ".railway.app", // Allow all Railway domains
      ".trycloudflare.com", // For local development tunnels
    ],
    // Disable HMR when running on Railway or in production
    hmr: process.env.RAILWAY_ENVIRONMENT ? false : undefined,
  },
});
