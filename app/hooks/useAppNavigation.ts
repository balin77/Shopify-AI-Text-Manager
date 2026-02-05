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

    // Build final search params, preserving critical Shopify params
    const finalParams = new URLSearchParams();

    // 1. Start with shop and host from current URL
    const shop = currentParams.get('shop') || sessionStorage.getItem('shopify_shop');
    const host = currentParams.get('host') || sessionStorage.getItem('shopify_host');

    console.log(`🏪 [useAppNavigation] Shop: "${shop}", Host: "${host}"`);

    // If we don't have shop/host params, this is a problem - warn and use window.location as fallback
    if (!shop || !host) {
      console.warn(`⚠️ [useAppNavigation] Missing shop/host parameters! Falling back to window.location.href`);
      console.warn(`⚠️ [useAppNavigation] Shop: ${shop}, Host: ${host}`);

      // Use window.location.href as fallback when session params are missing
      const fallbackUrl = new URL(path, window.location.origin);
      if (shop) fallbackUrl.searchParams.set('shop', shop);
      if (host) fallbackUrl.searchParams.set('host', host);
      additionalParams.forEach((value, key) => {
        fallbackUrl.searchParams.set(key, value);
      });

      window.location.href = fallbackUrl.toString();
      return;
    }

    if (shop) finalParams.set('shop', shop);
    if (host) finalParams.set('host', host);

    // 2. Add any additional params (these can override shop/host if needed)
    additionalParams.forEach((value, key) => {
      finalParams.set(key, value);
    });

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
