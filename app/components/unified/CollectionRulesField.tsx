/**
 * CollectionRulesField — the §Phase 3.1 rule editor for an EXISTING collection.
 *
 * A thin adapter, on purpose. `CollectionRuleBuilder` (built for the create
 * modal in §1.4b) already owns the whole form; this only does the three things
 * the editor context adds:
 *
 *   1. **Serialises through the editor's flat value map.** Every field in this
 *      editor is a string, and `getChangedFields` compares strings — so the
 *      source array travels as JSON. That is not a shortcut: it is what makes
 *      "did the merchant change the rules" answerable by the same mechanism as
 *      every other field, instead of a second change-detection path.
 *
 *   2. **Gates on the API VERSION, not the plan or the locale.** `sources[]`
 *      exists from 2026-07 on. Below that the builder renders its own
 *      explanation — the app does not offer a control that cannot work, and it
 *      does not pretend the old `ruleSet` is the same thing (CLAUDE.md: it is
 *      a lossy back-projection, and editing through it would silently change a
 *      collection's membership).
 *
 *   3. **Refuses to parse a tree it did not produce.** A value that is not the
 *      editor's own JSON is left strictly alone and reported, rather than
 *      being coerced into an empty rule set — which would read as "this
 *      collection has no rules" and, on save, make it true.
 */

import { useCallback, useMemo, useState } from "react";
import { BlockStack, Banner, Text } from "@shopify/polaris";
import { CollectionRuleBuilder } from "../create/CollectionRuleBuilder";
import {
  RULES_UNREADABLE,
  rulesAvailableOn,
  validateRuleSources,
  type RuleSource,
} from "../../config/collection-rules.shared";

export interface CollectionRulesFieldProps {
  /** JSON array of `RuleSource`. Empty string = no rules. */
  value: string;
  onChange: (value: string) => void;
  label: string;
  isPrimaryLocale: boolean;
  apiVersion: string;
  adminUrlForCollection?: string;
  t: {
    collectionRules?: Record<string, unknown>;
    content?: Record<string, unknown>;
  };
}

interface ParsedValue {
  sources: RuleSource[];
  /** True when `value` held something this component did not write. */
  unparsable: boolean;
}

function parseSources(value: string): ParsedValue {
  const raw = value.trim();
  if (!raw) return { sources: [], unparsable: false };
  // The loader's explicit "this row holds a model you may not edit" — a
  // `ruleSet` projection, an unsynced collection, a malformed envelope. It is
  // a value, not a missing one, which is the whole reason it is not "".
  if (raw === RULES_UNREADABLE) return { sources: [], unparsable: true };
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { sources: [], unparsable: true };
    return { sources: parsed as RuleSource[], unparsable: false };
  } catch {
    // Never "assume empty". An empty rule set is a MEANINGFUL value here —
    // saving it would strip the collection's rules — so a value this component
    // cannot read has to stop it, not be rounded down to nothing.
    return { sources: [], unparsable: true };
  }
}

export function CollectionRulesField({
  value,
  onChange,
  label,
  isPrimaryLocale,
  apiVersion,
  adminUrlForCollection,
  t,
}: CollectionRulesFieldProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { sources, unparsable } = useMemo(() => parseSources(value), [value]);
  const errors = useMemo(() => (unparsable ? [] : validateRuleSources(sources)), [sources, unparsable]);

  const available = rulesAvailableOn(apiVersion);
  const strings = (t.collectionRules ?? {}) as Record<string, string>;

  const handleChange = useCallback(
    (next: RuleSource[]) => onChange(JSON.stringify(next)),
    [onChange],
  );

  // Rules are one value per collection, like every other §Phase 3 attribute —
  // there is nothing to translate, so a foreign locale reads them only.
  if (!isPrimaryLocale) {
    return (
      <BlockStack gap="200">
        <Text as="p" variant="bodyMd">{label}</Text>
        <Banner tone="info">
          <Text as="p">
            {(t.content?.attributesForeignLocale as string) ||
              "This detail exists once per item, not per language. Switch to the main language to change it."}
          </Text>
        </Banner>
      </BlockStack>
    );
  }

  if (unparsable) {
    return (
      <BlockStack gap="200">
        <Text as="p" variant="bodyMd">{label}</Text>
        <Banner tone="warning">
          <Text as="p">
            {strings.unreadableTree ||
              "This collection's rules could not be read in a form this editor understands, so they are left untouched. Manage them in the Shopify admin."}
          </Text>
        </Banner>
      </BlockStack>
    );
  }

  return (
    <BlockStack gap="200">
      <Text as="p" variant="bodyMd">{label}</Text>
      <CollectionRuleBuilder
        sources={sources}
        onChange={handleChange}
        errors={errors}
        available={available}
        unavailableReason={
          available
            ? undefined
            : strings.requiresNewerApi ||
              "Automatic collection rules need a newer Shopify API version than this app currently uses. Until then, manage them in the Shopify admin."
        }
        adminUrlForCollection={adminUrlForCollection}
        showAdvanced={showAdvanced}
        onToggleAdvanced={() => setShowAdvanced((v) => !v)}
        t={strings as never}
      />
    </BlockStack>
  );
}
