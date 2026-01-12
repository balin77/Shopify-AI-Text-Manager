/**
 * App Index - Redirects to Products page
 *
 * This route immediately redirects to the products page,
 * which is the main entry point of the application.
 */

import { useEffect } from "react";
import { useNavigate, useFetcher } from "@remix-run/react";

export default function AppIndex() {
  const navigate = useNavigate();
  const fetcher = useFetcher();

  // Trigger initial sync on app start
  useEffect(() => {
    // Only trigger if not already loading/submitting and no data yet
    if (fetcher.state === 'idle' && !fetcher.data) {
      console.log('[APP] Triggering initial background sync...');
      fetcher.submit(
        {},
        {
          method: 'POST',
          action: '/api/sync-content?types=pages,policies,themes'
        }
      );
    }
  }, []);

  // Redirect to products page
  useEffect(() => {
    navigate("/app/products", { replace: true });
  }, [navigate]);

  // Return null while redirecting
  return null;
}
