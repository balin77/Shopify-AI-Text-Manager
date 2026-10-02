/**
 * Hands the per-language media state of ONE product to both of its galleries
 * (the image manager's product gallery and the plain ImageGalleryField), which
 * are two different components that the product page renders alternatively.
 *
 * Mounted by the product page only, around the editor: other content types
 * have no provider, so `useLocalizedMediaState()` answers null there and the
 * galleries render nothing of it. Never gated on the image manager's on/off, nor
 * on the PLAN (a plan below the feature gets a remove-only view): replacements
 * keep serving on the storefront when the manager is switched off or the plan
 * is downgraded, so they must stay removable.
 */
import { createContext, useContext, useEffect, type MutableRefObject, type ReactNode } from "react";
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
  embedActive,
  reloadKey,
  enabled,
  canReplace,
  draftsPendingRef,
  children,
}: {
  productId: string;
  shopLocales: ShopLocale[];
  markets: MarketInfo[];
  currentLanguage?: string;
  selectedMarketId?: string;
  embedActivationUrl?: string | null;
  /** The embed is on in the live theme (true / false / null = unknown). */
  embedActive?: boolean | null;
  reloadKey?: string;
  /** A product being selected. */
  enabled: boolean;
  /** The plan allows new replacements (false = remove-only view). */
  canReplace?: boolean;
  /** Mirrors "unsaved drafts exist" for the page's item-switch guard (the drafts live here, below the page's hooks). */
  draftsPendingRef?: MutableRefObject<boolean>;
  children: ReactNode;
}) {
  const state = useLocalizedMedia({
    productId,
    shopLocales,
    markets,
    currentLanguage,
    selectedMarketId,
    enabled,
    canReplace,
    reloadKey,
    embedActivationUrl,
    embedActive,
  });
  useEffect(() => {
    if (draftsPendingRef) draftsPendingRef.current = state.hasDrafts;
  }, [draftsPendingRef, state.hasDrafts]);
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
