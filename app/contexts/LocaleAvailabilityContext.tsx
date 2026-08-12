/**
 * LocaleAvailabilityContext — "does this shop have more than one language?"
 *
 * Everything translation-related (translate, translate-to-all-locales, copy-to-
 * all-locales) is dead weight in a single-language shop: the handlers filter the
 * primary locale out of the target list and end up with nothing to do. Instead
 * of hiding those buttons (merchants then wonder where the feature went) we grey
 * them out and explain why via tooltip — this context carries that decision down
 * to the individual field components without threading a prop through every
 * layer.
 *
 * Default is `true` (multiple locales) so components rendered outside a provider
 * behave exactly as before.
 */

import { createContext, useContext, type ReactNode } from "react";
import { useI18n } from "./I18nContext";

const LocaleAvailabilityContext = createContext<boolean>(true);

export function LocaleAvailabilityProvider({
  hasMultipleLocales,
  children,
}: {
  hasMultipleLocales: boolean;
  children: ReactNode;
}) {
  return (
    <LocaleAvailabilityContext.Provider value={hasMultipleLocales}>
      {children}
    </LocaleAvailabilityContext.Provider>
  );
}

export function useHasMultipleLocales(): boolean {
  return useContext(LocaleAvailabilityContext);
}

/**
 * Reason to show on a disabled translation action, or `undefined` when the shop
 * has enough languages for the action to work. Use it for both the `disabled`
 * flag and the tooltip:
 *
 *   const singleLocaleHint = useSingleLocaleHint();
 *   <DisabledActionTooltip hint={singleLocaleHint}>
 *     <Button disabled={!!singleLocaleHint || isLoading}>🌍 …</Button>
 *   </DisabledActionTooltip>
 */
export function useSingleLocaleHint(): string | undefined {
  const hasMultipleLocales = useHasMultipleLocales();
  const { t } = useI18n();
  if (hasMultipleLocales) return undefined;
  return (
    t.common?.requiresSecondLanguage
    || "Your shop has only one language. Add another language in your Shopify settings to use translation."
  );
}
