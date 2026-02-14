/**
 * useAppNavigation Hook
 *
 * Centralized navigation logic for Shopify embedded apps.
 * Preserves all Shopify session parameters across navigation.
 *
 * Uses window.location.href for navigation to ensure reliable page loads
 * in the Shopify Admin iframe context.
 *
 * NOTE: Does NOT use sessionStorage/localStorage to comply with Shopify's
 * requirement that embedded apps work without third-party cookies/storage
 * (e.g. Chrome Incognito mode). Shop/host params are preserved via URL only.
 */

import { useCallback } from "react";

interface NavigateOptions {
  /** Additional search params to include (will be merged with preserved params) */
  searchParams?: URLSearchParams;
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

    // IMPORTANT: Use absolute URL with current origin to avoid iframe navigation issues
    // If we use a relative path, the browser might resolve it to admin.shopify.com
    const fullUrl = new URL(pathWithParams, window.location.origin).toString();

    // Use window.location.href for reliable navigation in iframe
    if (window.shopify && typeof window.shopify.loading === 'function') {
      window.shopify.loading(true);
    }
    window.location.href = fullUrl;
  }, []);

  return { handleNavigate };
}
