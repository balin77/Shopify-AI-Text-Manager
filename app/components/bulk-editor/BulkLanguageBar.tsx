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
    /** Accessible name of the button group — a bare run of language names
     * is unidentifiable to a screen reader (the Select it replaced had one). */
    groupLabel: string;
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
    <div role="group" aria-label={strings.groupLabel}>
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
            <span
              // On macOS a Ctrl+click is a SECONDARY click: it fires
              // pointerdown and contextmenu, but no click — so the guard flag
              // set below would never be cleared and would swallow the next
              // plain click. Clearing it here (and on any non-modifier
              // pointerdown) closes that and the press-then-drag-off case.
              onContextMenu={(event: React.MouseEvent) => {
                if (locale.primary) return;
                event.preventDefault();
                ctrlPressed.current[locale.locale] = false;
              }}
              // Keyboard equivalent of the Ctrl+click toggle — onPointerDown
              // never fires for Space/Enter, so without this a keyboard user
              // could never switch a language off (or back on).
              onKeyDown={(event: React.KeyboardEvent) => {
                if (locale.primary || !(event.ctrlKey || event.metaKey)) return;
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onToggle(locale.locale);
              }}
            >
              <Button
                size="slim"
                variant={isCurrent ? "primary" : undefined}
                tone={isEnabled ? undefined : "critical"}
                // "Which language am I viewing" was conveyed by colour alone.
                pressed={isCurrent}
                onPointerDown={(event: React.PointerEvent) => {
                  if (!(event.ctrlKey || event.metaKey) || locale.primary) {
                    ctrlPressed.current[locale.locale] = false;
                    return;
                  }
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
            </span>
          </Tooltip>
        );
      })}
        <HelpTooltip helpKey="ctrlClickLanguage" position="below" />
      </InlineStack>
    </div>
  );
}
