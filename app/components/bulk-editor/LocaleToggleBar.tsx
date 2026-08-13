/**
 * Bulk editor — target-language bar of the "translate missing" page.
 *
 * The same button row as the content editors' UnifiedLanguageBar, minus the
 * "which language am I looking at" dimension: this page has no current locale,
 * every button is a target. So a PLAIN click toggles the language (Ctrl+click
 * does the same, for muscle memory from the editors), an inactive language
 * renders red (`tone="critical"`, the established "language off" colour), and
 * the reason is one Tooltip + one HelpTooltip away.
 *
 * The PRIMARY locale is not rendered at all — it is the source of every
 * translation, never a target, and a greyed-out button invites clicks that
 * cannot do anything (CLAUDE.md single-language rules: remove, don't disable,
 * when a control could never become usable).
 */

import { Button, InlineStack, Tooltip, Text } from "@shopify/polaris";
import { HelpTooltip } from "../HelpTooltip";
import { getLocalizedLanguageName } from "../../utils/contentEditor.utils";

export interface LocaleToggleBarProps {
  /** Published FOREIGN locales (primary already removed). */
  locales: { locale: string; name: string }[];
  /** Currently active target languages. */
  active: string[];
  onToggle: (locale: string) => void;
  disabled?: boolean;
  /** App UI language — localizes the language NAMES. */
  appLocale: string;
  strings: {
    label: string;
    /** Tooltip on an ACTIVE button ("click to skip this language"). */
    activeHint: string;
    /** Tooltip on an INACTIVE (red) button. */
    inactiveHint: string;
    /** Shown instead of the bar when the shop has exactly one foreign
     * locale — "{language}" is filled. */
    singleTarget: string;
  };
}

export function LocaleToggleBar({
  locales,
  active,
  onToggle,
  disabled = false,
  appLocale,
  strings,
}: LocaleToggleBarProps) {
  if (locales.length === 0) return null;

  // Exactly one target: a single permanently-on button is noise — the language
  // is stated as text instead (same rule as the locale bars elsewhere).
  if (locales.length === 1) {
    return (
      <Text as="p" variant="bodyMd" tone="subdued">
        {strings.singleTarget.replace(
          "{language}",
          getLocalizedLanguageName(locales[0].locale, appLocale, locales[0].name),
        )}
      </Text>
    );
  }

  return (
    <InlineStack gap="200" blockAlign="center" wrap>
      <Text as="span" variant="bodySm" tone="subdued">
        {strings.label}
      </Text>
      {locales.map((locale) => {
        const isActive = active.includes(locale.locale);
        return (
          <Tooltip
            key={locale.locale}
            content={isActive ? strings.activeHint : strings.inactiveHint}
            dismissOnMouseOut
            preferredPosition="below"
          >
            {/* A disabled Polaris Button dispatches no pointer events, so the
                Tooltip needs its own wrapper element to hang on. */}
            <span>
              <Button
                size="slim"
                disabled={disabled}
                variant={isActive ? "primary" : undefined}
                tone={isActive ? undefined : "critical"}
                onClick={() => onToggle(locale.locale)}
              >
                {getLocalizedLanguageName(locale.locale, appLocale, locale.name)}
              </Button>
            </span>
          </Tooltip>
        );
      })}
      <HelpTooltip helpKey="translateMissingLanguages" position="below" />
    </InlineStack>
  );
}
