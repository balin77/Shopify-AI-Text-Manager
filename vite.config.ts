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
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "@remix-run/react",
      "react-router",
      "react-router-dom",
    ],
  },
  build: {
    // Use a modern target to avoid esbuild failing to transpile Polaris
    // destructuring patterns to legacy browser targets (chrome87/es2020).
    // The app runs in Shopify Admin which always uses a modern browser.
    target: "esnext",
  },
  server: {
    port: 3000,
    allowedHosts: [
      ".railway.app", // Allow all Railway domains (includes contentpilotai.up.railway.app)
      ".trycloudflare.com", // For local development tunnels
    ],
    // Disable HMR when running on Railway or in production
    hmr: process.env.RAILWAY_ENVIRONMENT ? false : undefined,
  },
});
