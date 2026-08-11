import type { Config } from "@react-router/dev/config";

// Replaces remix.config.js. The old file's appDirectory/serverBuildPath/
// assetsBuildDirectory/publicPath values were the Vite-era defaults and are no
// longer configured here — React Router builds to build/server + build/client,
// which is what server.js and scripts/strip-client-sourcemaps.mjs already read.
export default {
  ssr: true,
} satisfies Config;
