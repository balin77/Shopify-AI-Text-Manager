/**
 * App Index - Redirect into the app
 *
 * The initial content sync now runs server-side via the sync scheduler
 * (see services/initial-sync.service.ts + sync-scheduler.service.ts) and its
 * progress is shown by the persistent InitialSyncBanner in the app shell.
 * So this route no longer blocks on a sync screen — it simply forwards the
 * user straight into the app, whether or not onboarding has finished.
 */

import { useEffect } from "react";
import { useNavigate } from "react-router";
import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

export default function AppIndex() {
  const navigate = useNavigate();

  // Always go straight to products. Preserve Shopify search params
  // (shop, host, …) so the embedded session is not lost on navigation.
  useEffect(() => {
    const search = typeof window !== "undefined" ? window.location.search : "";
    navigate(`/app/products${search}`, { replace: true });
  }, [navigate]);

  return null;
}
