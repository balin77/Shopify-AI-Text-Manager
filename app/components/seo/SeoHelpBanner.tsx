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
 * one alone. The state is therefore keyed by id throughout, never by "the
 * banner that registered last": a section is allowed to render more than one
 * box, and a single shared flag would let dismissing one hide the other.
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
  /** Help ids of the banners currently mounted, in registration order. */
  registeredIds: readonly string[];
  isHidden: (helpId: string) => boolean;
  setHidden: (helpId: string, hidden: boolean) => void;
  /** Called by the banner on mount; returns its unregister callback. */
  register: (helpId: string) => () => void;
}

const SeoHelpContext = createContext<SeoHelpContextValue | null>(null);

const EMPTY_IDS: readonly string[] = [];

/**
 * localStorage exists only on the client, so the dismissed state can only be
 * applied after hydration. A layout effect gets it in before paint on every
 * client-side navigation; on a full document load the server HTML (which has no
 * storage to read) always contains the box, so a merchant who hid it sees it
 * once, briefly. Removing that last flash would mean either persisting the
 * choice server-side or injecting pre-hydration CSS from the root document —
 * both disproportionate for a help box that defaults to visible.
 */
const useIsomorphicLayoutEffect = typeof document !== "undefined" ? useLayoutEffect : useEffect;

export function SeoHelpProvider({
  sectionId,
  children,
}: {
  sectionId: string;
  children: ReactNode;
}) {
  const [registeredIds, setRegisteredIds] = useState<readonly string[]>(EMPTY_IDS);
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set<string>());

  const applyHidden = useCallback((helpId: string, hidden: boolean) => {
    setHiddenIds((current) => {
      if (current.has(helpId) === hidden) return current;
      const next = new Set(current);
      if (hidden) next.add(helpId);
      else next.delete(helpId);
      return next;
    });
  }, []);

  const register = useCallback(
    (helpId: string) => {
      setRegisteredIds((current) => (current.includes(helpId) ? current : [...current, helpId]));
      applyHidden(helpId, readSeoHelpHidden(helpId));
      return () => setRegisteredIds((current) => current.filter((id) => id !== helpId));
    },
    [applyHidden],
  );

  const setHidden = useCallback(
    (helpId: string, hidden: boolean) => {
      applyHidden(helpId, hidden);
      writeSeoHelpHidden(helpId, hidden);
    },
    [applyHidden],
  );

  const isHidden = useCallback((helpId: string) => hiddenIds.has(helpId), [hiddenIds]);

  const value = useMemo<SeoHelpContextValue>(
    () => ({ defaultHelpId: sectionId, registeredIds, isHidden, setHidden, register }),
    [sectionId, registeredIds, isHidden, setHidden, register],
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

  // Before the register effect has run nothing is known about this id yet, and
  // showing the box is the right default there too.
  if (ctx.isHidden(id)) return null;

  return (
    <Banner tone="info" title={title} onDismiss={() => ctx.setHidden(id, true)}>
      {children}
    </Banner>
  );
}

/** The ❓ next to the section title, shown only while a box is hidden. */
export function SeoHelpToggle() {
  const ctx = useContext(SeoHelpContext);
  const { t } = useI18n();

  const hiddenIds = ctx ? ctx.registeredIds.filter((id) => ctx.isHidden(id)) : EMPTY_IDS;
  if (!ctx || hiddenIds.length === 0) return null;

  const label = t.seo.sectionHelpShow;
  return (
    <Tooltip content={label}>
      <Button
        icon={QuestionCircleIcon}
        variant="tertiary"
        accessibilityLabel={label}
        onClick={() => hiddenIds.forEach((id) => ctx.setHidden(id, false))}
      />
    </Tooltip>
  );
}
