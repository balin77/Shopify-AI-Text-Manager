import type { RouteConfig } from "@react-router/dev/routes";
import { flatRoutes } from "@react-router/fs-routes";

// React Router 7 requires routes to be declared explicitly (what Remix called
// the `v3_routeConfig` future flag). `flatRoutes` reproduces Remix v2's file
// naming convention exactly, so every file under app/routes/ keeps its current
// name and nesting — this file only re-declares the convention, it does not
// change any route.
export default flatRoutes({
  ignoredRouteFiles: ["**/.*"],
}) satisfies RouteConfig;
