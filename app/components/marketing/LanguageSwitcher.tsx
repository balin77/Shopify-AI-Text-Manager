import { useEffect, useRef } from "react";
import { Link } from "react-router";
import {
  MARKETING_LOCALES,
  MARKETING_LOCALE_LABELS,
  localizedPath,
  type MarketingLocale,
} from "../../services/marketing-locale.shared";

/** How long the open menu waits for a choice before folding up again. */
const AUTO_CLOSE_MS = 5000;

/**
 * The language switcher: shows the CURRENT language only, and opens to all
 * three when pressed.
 *
 * Built on <details>, not on state: the summary/menu pair is a native
 * disclosure, so it renders closed on the server and on the client's first
 * paint alike (no hydration mismatch), and it still opens and closes without
 * JavaScript. What the effect adds is the part a disclosure does not have —
 * it folds up by itself after a few seconds, on a click anywhere else, on
 * Escape, and the moment a language is picked. Without the script the menu
 * simply stays open until pressed again, which is a worse switcher and not
 * a broken one.
 */
export function LanguageSwitcher({
  locale,
  rest,
  label,
}: {
  locale: MarketingLocale;
  /** The current path WITHOUT its locale prefix, e.g. `/features`. */
  rest: string;
  /** Accessible name of the control, e.g. "Language". */
  label: string;
}) {
  const ref = useRef<HTMLDetailsElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let timer: number | undefined;
    const close = () => {
      window.clearTimeout(timer);
      el.open = false;
    };
    const onToggle = () => {
      window.clearTimeout(timer);
      if (el.open) timer = window.setTimeout(close, AUTO_CLOSE_MS);
    };
    const onDocumentClick = (event: MouseEvent) => {
      if (el.open && !el.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && el.open) close();
    };

    el.addEventListener("toggle", onToggle);
    document.addEventListener("click", onDocumentClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      el.removeEventListener("toggle", onToggle);
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <details className="mk-lang" ref={ref}>
      <summary aria-label={`${label}: ${MARKETING_LOCALE_LABELS[locale]}`}>
        {locale.toUpperCase()}
        <span className="mk-lang__chevron" aria-hidden="true" />
      </summary>
      <div className="mk-lang__menu" role="group" aria-label={label}>
        {MARKETING_LOCALES.map((alt) => (
          <Link
            key={alt}
            to={localizedPath(alt, rest)}
            hrefLang={alt}
            aria-current={alt === locale ? "true" : undefined}
            onClick={() => {
              if (ref.current) ref.current.open = false;
            }}
          >
            {alt.toUpperCase()}
            <span className="mk-visually-hidden"> {MARKETING_LOCALE_LABELS[alt]}</span>
          </Link>
        ))}
      </div>
    </details>
  );
}
