import { reactRouter } from "@react-router/dev/vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { defineConfig } from "vite";
import path from "path";

// Sourcemap upload is OPTIONAL and OFF by default. It runs only when
// SENTRY_AUTH_TOKEN is set — without it the build is byte-for-byte identical
// to before. Uploading does NOT consume the error quota; it only makes
// captured stack traces readable (de-minified) in Sentry.
//
// Security: when the token IS set we emit "hidden" sourcemaps, upload them to
// Sentry, then DELETE the client-side .map files so they can never be served
// publicly (express.static serves build/client by direct URL). When the token
// is NOT set we don't emit sourcemaps at all — nothing to leak.
const sourcemapUploadEnabled = !!process.env.SENTRY_AUTH_TOKEN;

const sentrySourcemapPlugins = sourcemapUploadEnabled
  ? [
      sentryVitePlugin({
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        authToken: process.env.SENTRY_AUTH_TOKEN,
        release: {
          name:
            process.env.SENTRY_RELEASE ||
            process.env.RAILWAY_GIT_COMMIT_SHA ||
            undefined,
        },
        sourcemaps: {
          // Remove the public client maps after they are uploaded to Sentry.
          // Sentry keeps its own copy, so stack traces stay readable while the
          // .map files are gone from the deployed bundle.
          filesToDeleteAfterUpload: ["./build/client/**/*.map"],
        },
      }),
    ]
  : [];

export default defineConfig({
  plugins: [
    reactRouter(),
    ...sentrySourcemapPlugins,
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
      "react-router",
    ],
  },
  build: {
    // Use a modern target to avoid esbuild failing to transpile Polaris
    // destructuring patterns to legacy browser targets (chrome87/es2020).
    // The app runs in Shopify Admin which always uses a modern browser.
    target: "esnext",
    // Only emit sourcemaps when they will be uploaded to Sentry AND deleted
    // afterwards (see sentrySourcemapPlugins). "hidden" = emitted for upload
    // but not referenced in the shipped bundles. Without the upload token we
    // emit none at all, so there is nothing public to leak.
    sourcemap: sourcemapUploadEnabled ? "hidden" : false,
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
