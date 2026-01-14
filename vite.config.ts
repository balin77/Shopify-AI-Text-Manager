import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    remix({
      ignoredRouteFiles: ["**/.*"],
    }),
  ],
  server: {
    port: 3000,
    allowedHosts: [
      "shopify-ai-text-manager-production.up.railway.app",
      "shopify-ai-text-manager-development.up.railway.app",
      ".railway.app", // Allow all Railway domains
      ".trycloudflare.com", // For local development tunnels
    ],
  },
});
