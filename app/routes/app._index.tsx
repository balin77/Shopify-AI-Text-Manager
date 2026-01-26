/**
 * App Index - Redirects to Products page
 *
 * This route:
 * 1. Triggers initial setup (webhooks + fast product sync) if not done yet
 * 2. Redirects to the products page
 */

import { useEffect } from "react";
import { useNavigate, useFetcher } from "@remix-run/react";

export default function AppIndex() {
  const navigate = useNavigate();
  const setupFetcher = useFetcher();

  // Trigger initial setup on app start (webhooks + products)
  useEffect(() => {
    // Only trigger if not already loading/submitting and no data yet
    if (setupFetcher.state === 'idle' && !setupFetcher.data) {
      console.log('[APP] Triggering initial setup (webhooks + products)...');
      setupFetcher.submit(
        {},
        {
          method: 'POST',
          action: '/api/initial-setup'
        }
      );
    }
  }, []);

  // Log setup result
  useEffect(() => {
    if (setupFetcher.data) {
      const data = setupFetcher.data as { success: boolean; skipped?: boolean; productsSynced?: number; message?: string };
      if (data.success) {
        if (data.skipped) {
          console.log('[APP] Initial setup skipped (already completed)');
        } else {
          console.log(`[APP] Initial setup complete! Products synced: ${data.productsSynced}`);
        }
      } else {
        console.error('[APP] Initial setup failed:', data);
      }
    }
  }, [setupFetcher.data]);

  // Redirect to products page
  useEffect(() => {
    navigate("/app/products", { replace: true });
  }, [navigate]);

  // Return null while redirecting
  return null;
}
