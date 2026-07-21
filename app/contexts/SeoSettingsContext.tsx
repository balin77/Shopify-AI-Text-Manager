/**
 * Seo Settings Context
 * Provides the shop-level SEO character-limits knobs throughout the app.
 *
 *  - `seoTitleSuffix`: when non-empty, the SeoSidebar and AI generation use
 *    an adjusted upper limit of (seoTitleMax - suffix.length).
 *  - `seoLimits`: merchant overrides for the length thresholds every scorer
 *    and every character-counter hint on the content editor consumes.
 *    Sparse (only overridden keys) — `resolveSeoLimits()` fills in defaults.
 */

import { createContext, useContext, type ReactNode } from "react";
import type { SeoLimits } from "../utils/character-limits";

interface SeoSettingsContextValue {
  /** The suffix Shopify appends to SEO titles (e.g., " – Patis Universe").
   *  Empty string when the feature is disabled. */
  seoTitleSuffix: string;
  /** Sparse merchant overrides for SEO character limits. `null` = defaults. */
  seoLimits: Partial<SeoLimits> | null;
}

const SeoSettingsContext = createContext<SeoSettingsContextValue>({
  seoTitleSuffix: "",
  seoLimits: null,
});

interface SeoSettingsProviderProps {
  seoTitleSuffix: string;
  seoLimits: Partial<SeoLimits> | null;
  children: ReactNode;
}

export function SeoSettingsProvider({ seoTitleSuffix, seoLimits, children }: SeoSettingsProviderProps) {
  return (
    <SeoSettingsContext.Provider value={{ seoTitleSuffix, seoLimits }}>
      {children}
    </SeoSettingsContext.Provider>
  );
}

export function useSeoSettings(): SeoSettingsContextValue {
  return useContext(SeoSettingsContext);
}
