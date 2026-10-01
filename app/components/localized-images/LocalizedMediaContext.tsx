/**
 * Hands the per-language media state of ONE product to both of its galleries
 * (the image manager's product gallery and the plain ImageGalleryField), which
 * are two different components that the product page renders alternatively.
 *
 * Mounted by the product page only, around the editor: other content types
 * have no provider, so `useLocalizedMediaState()` answers null there and the
 * galleries render nothing of it. Gated on the PLAN by the page (never on the
 * image manager's on/off), because replacements keep serving on the storefront
 * when the manager is switched off.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { MarketInfo, ShopLocale } from "../../types/content-editor.types";
import { useLocalizedMedia, type LocalizedMediaState } from "./useLocalizedMedia";

interface LocalizedMediaContextValue {
  state: LocalizedMediaState;
  /** Theme-editor deep link that activates the storefront embed; null hides the button. */
  embedActivationUrl: string | null;
}

const LocalizedMediaContext = createContext<LocalizedMediaContextValue | null>(null);

export function LocalizedMediaProvider({
  productId,
  shopLocales,
  markets,
  currentLanguage,
  selectedMarketId,
  embedActivationUrl,
  reloadKey,
  enabled,
  children,
}: {
  productId: string;
  shopLocales: ShopLocale[];
  markets: MarketInfo[];
  currentLanguage?: string;
  selectedMarketId?: string;
  embedActivationUrl?: string | null;
  reloadKey?: string;
  /** The plan gate, and a product being selected. */
  enabled: boolean;
  children: ReactNode;
}) {
  const state = useLocalizedMedia({
    productId,
    shopLocales,
    markets,
    currentLanguage,
    selectedMarketId,
    enabled,
    reloadKey,
  });
  return (
    <LocalizedMediaContext.Provider value={{ state, embedActivationUrl: embedActivationUrl ?? null }}>
      {children}
    </LocalizedMediaContext.Provider>
  );
}

/** The product's per-language media state, or null outside a product page / below the plan. */
export function useLocalizedMediaContext(): LocalizedMediaContextValue | null {
  return useContext(LocalizedMediaContext);
}
