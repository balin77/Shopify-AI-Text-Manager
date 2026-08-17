/**
 * useAppNavigation Hook
 *
 * Centralized navigation logic for Shopify embedded apps.
 * Preserves all Shopify session parameters across navigation.
 *
 * Uses Remix client-side navigation (useNavigate) so the persistent layout
 * route (app.tsx) — including the navigation bars — stays mounted across
 * sub-page navigation and only the <Outlet /> content swaps. App Bridge
 * (initialized via the CDN script + shopify-api-key meta in root.tsx) keeps
 * the embedded session alive and injects the session token into Remix data
 * requests, so client-side loader fetches authenticate without a full reload.
 *
 * All current URL search params (shop, host, embedded, …) are carried over to
 * the target path so anything that reads them keeps working.
 *
 * NOTE: Does NOT use sessionStorage/localStorage to comply with Shopify's
 * requirement that embedded apps work without third-party cookies/storage
 * (e.g. Chrome Incognito mode). Shop/host params are preserved via URL only.
 */

import { useCallback } from "react";
import { useNavigate } from "react-router";

interface NavigateOptions {
  /** Additional search params to include (will be merged with preserved params) */
  searchParams?: URLSearchParams;
  /** Replace the current history entry instead of pushing a new one — useful
   * for filter-style params (e.g. a locale picker) where every change
   * shouldn't add its own back-button stop. Defaults to false (push), so
   * existing callers are unaffected. */
  replace?: boolean;
}

/**
 * Custom hook for navigation in Shopify embedded apps
 *
 * Features:
 * - Preserves ALL Shopify session parameters via URL params
 * - Works reliably in Shopify iframe context (including Incognito mode)
 *
 * @returns handleNavigate function for navigation
 */
export function useAppNavigation() {
  const navigate = useNavigate();

  /**
   * Navigate to a path while preserving ALL Shopify session parameters
   *
   * @param path - The path to navigate to (e.g., "/app/products")
   * @param options - Optional configuration
   */
  const handleNavigate = useCallback((path: string, options: NavigateOptions = {}) => {
    if (typeof window === 'undefined') return;

    // Get current search params from window.location (most reliable source)
    const currentParams = new URLSearchParams(window.location.search);

    // Get additional params from options
    const additionalParams = options.searchParams || new URLSearchParams();

    // Build final search params, preserving ALL current params
    const finalParams = new URLSearchParams();

    // 1. Copy ALL current params first (preserve everything from Shopify)
    currentParams.forEach((value, key) => {
      finalParams.set(key, value);
    });

    // 2. Override with any additional params from options
    additionalParams.forEach((value, key) => {
      finalParams.set(key, value);
    });

    // Build final path with params
    const searchString = finalParams.toString();
    const pathWithParams = searchString ? `${path}?${searchString}` : path;

    // Client-side Remix navigation: only the <Outlet /> re-renders, the layout
    // route (app.tsx) and its navigation bars stay mounted. The leading-slash
    // path is resolved in-app by Remix, so there is no risk of the browser
    // resolving it against admin.shopify.com (the reason the old hard-reload
    // implementation built an absolute URL).
    navigate(pathWithParams, options.replace ? { replace: true } : undefined);
  }, [navigate]);

  return { handleNavigate };
}
