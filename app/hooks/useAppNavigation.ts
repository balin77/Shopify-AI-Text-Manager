/**
 * useAppNavigation Hook
 *
 * Centralized navigation logic for Shopify embedded apps.
 * Preserves all Shopify session parameters across navigation.
 *
 * Uses window.location.href for navigation to ensure reliable page loads
 * in the Shopify Admin iframe context.
 */

import { useLocation } from "@remix-run/react";
import { useCallback, useEffect } from "react";

interface NavigateOptions {
  /** Additional search params to include (will be merged with preserved params) */
  searchParams?: URLSearchParams;
}

/**
 * Custom hook for navigation in Shopify embedded apps
 *
 * Features:
 * - Preserves ALL Shopify session parameters
 * - Stores session params in SessionStorage as fallback
 * - Works reliably in Shopify iframe context
 *
 * @returns handleNavigate function for navigation
 */
export function useAppNavigation() {
  const location = useLocation();

  // Save critical session params to SessionStorage on mount and location change
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const searchParams = new URLSearchParams(window.location.search);
    const shop = searchParams.get('shop');
    const host = searchParams.get('host');

    // Store in SessionStorage if present
    if (shop) {
      sessionStorage.setItem('shopify_shop', shop);
    }
    if (host) {
      sessionStorage.setItem('shopify_host', host);
    }
  }, [location.search]);

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

    // 3. Ensure shop and host are present (fallback to SessionStorage)
    if (!finalParams.has('shop')) {
      const shop = sessionStorage.getItem('shopify_shop');
      if (shop) finalParams.set('shop', shop);
    }
    if (!finalParams.has('host')) {
      const host = sessionStorage.getItem('shopify_host');
      if (host) finalParams.set('host', host);
    }

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
