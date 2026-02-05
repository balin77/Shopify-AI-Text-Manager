/**
 * useAppNavigation Hook
 *
 * Centralized navigation logic for Shopify embedded apps using Remix.
 * Handles client-side routing while preserving critical session parameters.
 *
 * This hook replaces window.location.href redirects with proper Remix navigation
 * to prevent full page reloads and session loss in embedded iframes.
 */

import { useNavigate, useLocation } from "@remix-run/react";
import { useCallback, useEffect } from "react";

interface NavigateOptions {
  /** Additional search params to include (will be merged with preserved params) */
  searchParams?: URLSearchParams;
  /** Replace current history entry instead of pushing new one */
  replace?: boolean;
}

/**
 * Custom hook for navigation in Shopify embedded apps
 *
 * Features:
 * - Preserves shop and host parameters across navigation
 * - Uses Remix client-side routing (no full page reload)
 * - Stores session params in SessionStorage as fallback
 * - Works seamlessly in Shopify iframe context
 *
 * @returns handleNavigate function for navigation
 */
export function useAppNavigation() {
  const navigate = useNavigate();
  const location = useLocation();

  // Save critical session params to SessionStorage on mount and location change
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Try multiple sources for shop/host params
    const searchParams = new URLSearchParams(location.search);
    const windowParams = new URLSearchParams(window.location.search);

    const shop = searchParams.get('shop') || windowParams.get('shop');
    const host = searchParams.get('host') || windowParams.get('host');

    console.log(`💾 [useAppNavigation] Saving params - Shop: ${shop}, Host: ${host}`);

    // Store in SessionStorage if present
    if (shop) {
      sessionStorage.setItem('shopify_shop', shop);
    }
    if (host) {
      sessionStorage.setItem('shopify_host', host);
    }
  }, [location.search]);

  /**
   * Navigate to a path while preserving Shopify session parameters
   *
   * @param path - The path to navigate to (e.g., "/app/products")
   * @param options - Optional configuration
   */
  const handleNavigate = useCallback((path: string, options: NavigateOptions = {}) => {
    console.log(`🚀 [useAppNavigation] Navigating to: ${path}`);
    console.log(`📍 [useAppNavigation] Current location: ${location.pathname}${location.search}`);

    // Get current search params
    const currentParams = new URLSearchParams(location.search);
    console.log(`🔍 [useAppNavigation] Current search params:`, currentParams.toString());

    // Get additional params from options
    const additionalParams = options.searchParams || new URLSearchParams();

    // Build final search params, preserving ALL current Shopify params
    const finalParams = new URLSearchParams();

    // Critical Shopify params that must be preserved
    const shopifyParams = [
      'shop',
      'host',
      'embedded',
      'hmac',
      'id_token',
      'locale',
      'session',
      'timestamp'
    ];

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

    const shop = finalParams.get('shop');
    const host = finalParams.get('host');

    console.log(`🏪 [useAppNavigation] Shop: "${shop}", Host: "${host}"`);

    // If we STILL don't have shop/host params, fall back to full page reload
    if (!shop || !host) {
      console.warn(`⚠️ [useAppNavigation] Missing shop/host parameters! Falling back to window.location.href`);

      // Use window.location.href as fallback when session params are missing
      const fallbackUrl = new URL(path, window.location.origin);
      finalParams.forEach((value, key) => {
        fallbackUrl.searchParams.set(key, value);
      });

      window.location.href = fallbackUrl.toString();
      return;
    }

    // Build final path with params
    const searchString = finalParams.toString();
    const fullPath = searchString ? `${path}?${searchString}` : path;

    console.log(`🎯 [useAppNavigation] Final path: ${fullPath}`);

    // Use Remix navigate for client-side routing (no full page reload!)
    navigate(fullPath, {
      replace: options.replace || false,
      // Preserve scroll position for better UX
      preventScrollReset: false,
    });
  }, [navigate, location]);

  return { handleNavigate };
}
