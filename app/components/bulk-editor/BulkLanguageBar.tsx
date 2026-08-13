/**
 * Bulk editor — language bar of the grid toolbar.
 *
 * The same interaction the content editors have (UnifiedLanguageBar): a plain
 * click SWITCHES the view to that language, Ctrl/Cmd+click switches a foreign
 * language OFF (it turns red) so the per-cell "translate/copy into all active
 * languages" actions skip it. The primary language is the source and can never
 * be switched off.
 *
 * Single-language shops render nothing at all — one permanently-active button
 * is noise and the Ctrl+click hint would be a lie (CLAUDE.md single-language
 * rules; the caller drops the surrounding wrapper the same way).
 */

import { useRef } from "react";
import { Button, InlineStack, Tooltip } from "@shopify/polaris";
import { HelpTooltip } from "../HelpTooltip";
import { getLocalizedLanguageName } from "../../utils/contentEditor.utils";

export interface BulkLanguageBarProps {
  /** Published shop locales, primary first. */
  locales: { locale: string; name: string; primary: boolean }[];
  /** Currently viewed locale — "" is the primary one (the grid's own sentinel). */
  currentLocale: string;
  /** Foreign locales that are switched ON. */
  enabledLocales: string[];
  onSelect: (locale: string) => void;
  onToggle: (locale: string) => void;
  /** App UI language — localizes the language NAMES. */
  appLocale: string;
  strings: {
    /** Marker after the primary language's name. Carries its own brackets
     * ("(Primary)") — do not add another pair. */
    primarySuffix: string;
    /** Tooltip on an enabled foreign button. */
    enabledHint: string;
    /** Tooltip on a disabled (red) foreign button. */
    disabledHint: string;
  };
}

/** Caller-side emptiness check, so no empty toolbar slot is left behind. */
export function shouldRenderBulkLanguageBar(localeCount: number): boolean {
  return localeCount > 1;
}

export function BulkLanguageBar({
  locales,
  currentLocale,
  enabledLocales,
  onSelect,
  onToggle,
  appLocale,
  strings,
}: BulkLanguageBarProps) {
  // A Ctrl+click fires pointerdown AND click; the ref lets the click handler
  // know the toggle already happened so it does not ALSO switch the view.
  const ctrlPressed = useRef<Record<string, boolean>>({});

  if (!shouldRenderBulkLanguageBar(locales.length)) return null;

  return (
    <InlineStack gap="100" blockAlign="center" wrap>
      {locales.map((locale) => {
        // The grid addresses the primary locale as "" — the same sentinel the
        // edit-map keys and the URL use.
        const value = locale.primary ? "" : locale.locale;
        const isCurrent = currentLocale === value;
        const isEnabled = locale.primary || enabledLocales.includes(locale.locale);
        const label = `${getLocalizedLanguageName(locale.locale, appLocale, locale.name)}${
          locale.primary ? ` ${strings.primarySuffix}` : ""
        }`;

        return (
          <Tooltip
            key={locale.locale}
            content={isEnabled ? strings.enabledHint : strings.disabledHint}
            dismissOnMouseOut
            preferredPosition="below"
          >
            <Button
              size="slim"
              variant={isCurrent ? "primary" : undefined}
              tone={isEnabled ? undefined : "critical"}
              onPointerDown={(event: React.PointerEvent) => {
                if (!(event.ctrlKey || event.metaKey) || locale.primary) return;
                ctrlPressed.current[locale.locale] = true;
                event.preventDefault();
                onToggle(locale.locale);
              }}
              onClick={() => {
                if (ctrlPressed.current[locale.locale]) {
                  ctrlPressed.current[locale.locale] = false;
                  return;
                }
                onSelect(value);
              }}
            >
              {label}
            </Button>
          </Tooltip>
        );
      })}
      <HelpTooltip helpKey="ctrlClickLanguage" position="below" />
    </InlineStack>
  );
}
