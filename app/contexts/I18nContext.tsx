import { createContext, useContext, useMemo, type ReactNode } from "react";
import { getTranslation, type Locale } from "../i18n";
import type { Translation } from "../i18n/de";

interface I18nContextType {
  locale: Locale;
  t: Translation;
}

const I18nContext = createContext<I18nContextType>({
  locale: "de",
  t: getTranslation("de"),
});

export function I18nProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}) {
  const value = useMemo(() => ({
    locale,
    t: getTranslation(locale),
  }), [locale]);

  return (
    <I18nContext.Provider value={value}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return context;
}
