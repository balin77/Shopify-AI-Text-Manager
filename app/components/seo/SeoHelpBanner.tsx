/**
 * The dismissible blue help box every SEO section opens with ("Was kannst du
 * hier tun?" / intro banners), plus the ❓ affordance that brings it back.
 *
 * Shape: `SeoSectionLayout` wraps its children in `SeoHelpProvider` and renders
 * `SeoHelpToggle` next to the section title, while the section itself renders
 * `SeoHelpBanner` anywhere inside. The two halves sit in different subtrees —
 * that's why the open/closed state is context and not local state, and why the
 * ❓ only appears once a banner has actually registered itself: a section
 * without help must never grow a button that opens nothing.
 *
 * Visible by default. Dismissing persists per help id (see
 * [seo-help-visibility.ts](../../utils/seo-help-visibility.ts)) — the crawl
 * section has one box per step, so hiding the on-page intro leaves the delivery
 * one alone.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Banner, Button, Tooltip } from "@shopify/polaris";
import { QuestionCircleIcon } from "@shopify/polaris-icons";
import { useI18n } from "../../contexts/I18nContext";
import { readSeoHelpHidden, writeSeoHelpHidden } from "../../utils/seo-help-visibility";

interface SeoHelpContextValue {
  /** Help id used when a banner doesn't name one — the section id. */
  defaultHelpId: string;
  /** Help id of the banner currently mounted, or null while none is. */
  activeHelpId: string | null;
  hidden: boolean;
  setHidden: (hidden: boolean) => void;
  /** Called by the banner on mount; returns its unregister callback. */
  register: (helpId: string) => () => void;
}

const SeoHelpContext = createContext<SeoHelpContextValue | null>(null);

/**
 * localStorage exists only on the client, so the dismissed state has to be
 * applied after hydration — but before paint, otherwise a merchant who hid the
 * box sees it flash on every navigation. A layout effect on the client, a
 * plain (never-running) effect on the server.
 */
const useIsomorphicLayoutEffect = typeof document !== "undefined" ? useLayoutEffect : useEffect;

export function SeoHelpProvider({
  sectionId,
  children,
}: {
  sectionId: string;
  children: ReactNode;
}) {
  const [activeHelpId, setActiveHelpId] = useState<string | null>(null);
  const [hidden, setHiddenState] = useState(false);

  const register = useCallback((helpId: string) => {
    setActiveHelpId(helpId);
    setHiddenState(readSeoHelpHidden(helpId));
    return () => setActiveHelpId((current) => (current === helpId ? null : current));
  }, []);

  const setHidden = useCallback(
    (next: boolean) => {
      setHiddenState(next);
      if (activeHelpId) writeSeoHelpHidden(activeHelpId, next);
    },
    [activeHelpId],
  );

  const value = useMemo<SeoHelpContextValue>(
    () => ({ defaultHelpId: sectionId, activeHelpId, hidden, setHidden, register }),
    [sectionId, activeHelpId, hidden, setHidden, register],
  );

  return <SeoHelpContext.Provider value={value}>{children}</SeoHelpContext.Provider>;
}

interface SeoHelpBannerProps {
  title: string;
  children: ReactNode;
  /**
   * Storage id, when the section has more than one help box (the crawl's two
   * steps). Defaults to the section id.
   */
  helpId?: string;
}

export function SeoHelpBanner({ title, children, helpId }: SeoHelpBannerProps) {
  const ctx = useContext(SeoHelpContext);
  const id = helpId ?? ctx?.defaultHelpId ?? "";
  const register = ctx?.register;

  useIsomorphicLayoutEffect(() => {
    if (!register || !id) return;
    return register(id);
  }, [register, id]);

  // Rendered outside a SeoSectionLayout (no provider): degrade to the plain,
  // always-visible banner rather than dropping the help altogether.
  if (!ctx) {
    return (
      <Banner tone="info" title={title}>
        {children}
      </Banner>
    );
  }

  // Before the register effect has run, `activeHelpId` is still null — showing
  // the banner is the right default there too.
  if (ctx.hidden && ctx.activeHelpId === id) return null;

  return (
    <Banner tone="info" title={title} onDismiss={() => ctx.setHidden(true)}>
      {children}
    </Banner>
  );
}

/** The ❓ next to the section title, shown only while the box is hidden. */
export function SeoHelpToggle() {
  const ctx = useContext(SeoHelpContext);
  const { t } = useI18n();

  if (!ctx || !ctx.activeHelpId || !ctx.hidden) return null;

  const label = t.seo.sectionHelpShow;
  return (
    <Tooltip content={label}>
      <Button
        icon={QuestionCircleIcon}
        variant="tertiary"
        accessibilityLabel={label}
        onClick={() => ctx.setHidden(false)}
      />
    </Tooltip>
  );
}
