/**
 * Seo Settings Context
 * Provides the shop-level SEO title suffix throughout the app.
 * When seoTitleSuffix is non-empty, the SeoSidebar and AI generation
 * use an adjusted character limit of (60 - suffix.length).
 */

import { createContext, useContext, type ReactNode } from "react";

interface SeoSettingsContextValue {
  /** The suffix Shopify appends to SEO titles (e.g., " – Patis Universe").
   *  Empty string when the feature is disabled. */
  seoTitleSuffix: string;
}

const SeoSettingsContext = createContext<SeoSettingsContextValue>({ seoTitleSuffix: "" });

interface SeoSettingsProviderProps {
  seoTitleSuffix: string;
  children: ReactNode;
}

export function SeoSettingsProvider({ seoTitleSuffix, children }: SeoSettingsProviderProps) {
  return (
    <SeoSettingsContext.Provider value={{ seoTitleSuffix }}>
      {children}
    </SeoSettingsContext.Provider>
  );
}

export function useSeoSettings(): SeoSettingsContextValue {
  return useContext(SeoSettingsContext);
}
