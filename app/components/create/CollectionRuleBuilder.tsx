/**
 * PLAN_CONTENT_CREATION §1.4b — the collection rule editor.
 *
 * Standalone because Phase 3 reuses it for EXISTING collections; it therefore
 * owns no fetching and no save, only the value.
 *
 * ── The shape of the UI follows the shape of the risk ───────────────────────
 * The default view is one inclusion list plus "all / any" — exactly the smart
 * collection a merchant already knows from Shopify. Exclusions, extra named
 * sources and the source title live behind "Advanced" and appear only when
 * they are used or asked for. §2.5's rule: the simple case stays simple, the
 * power is reachable but not in the way.
 *
 * ── Two things this deliberately does NOT do ────────────────────────────────
 * 1. It does not offer a match-count preview. That would need a product query
 *    running the same rules, which is a second implementation of the matching
 *    semantics and would be wrong in exactly the cases that matter. The dialog
 *    says membership becomes visible after saving instead of guessing at it.
 * 2. It does not touch what it cannot render. A source using sub-collections,
 *    a shareable source, or a condition kind this editor does not know is
 *    shown read-only with a link to the admin and carried through unchanged.
 *    Shopify itself ships an "unknown condition" type, so meeting one is
 *    designed for — and silently simplifying a rule would change a
 *    collection's membership without anyone noticing.
 */

import { useCallback } from "react";
import {
  BlockStack,
  InlineStack,
  Card,
  Checkbox,
  Select,
  TextField,
  Button,
  Text,
  Banner,
  Collapsible,
  Box,
  Link,
} from "@shopify/polaris";
import {
  CONDITION_MATCH_TYPES,
  WEIGHT_UNITS,
  conditionKind,
  conditionKinds,
  newCondition,
  type ConditionSide,
  type RuleCondition,
  type RuleSource,
  type RuleValidationError,
  type WeightUnit,
} from "~/config/collection-rules.shared";

export interface CollectionRuleBuilderTexts {
  heading?: string;
  matchAll?: string;
  matchAny?: string;
  addCondition?: string;
  removeCondition?: string;
  advanced?: string;
  simple?: string;
  exclusionsHeading?: string;
  addExclusion?: string;
  sourceTitle?: string;
  addSource?: string;
  removeSource?: string;
  noPreview?: string;
  readOnlyHeading?: string;
  readOnlyBody?: string;
  openInAdmin?: string;
  unavailable?: string;
  definitionPlaceholder?: string;
  commaSeparated?: string;
  includeDescendants?: string;
  weightUnits?: Record<string, string>;
  kinds?: Record<string, string>;
  relations?: Record<string, string>;
}

export interface CollectionRuleBuilderProps {
  sources: RuleSource[];
  onChange: (sources: RuleSource[]) => void;
  errors?: RuleValidationError[];
  /** False below API 2026-07 — `sources[]` simply does not exist there. */
  available: boolean;
  /** Shown in place of the editor when `available` is false. */
  unavailableReason?: string;
  /** Link target for structures rendered read-only. */
  adminUrlForCollection?: string;
  /**
   * The SHOP's currency. `MoneyInput` requires one on every price condition,
   * and the value is compared in the shop's currency — so a new condition is
   * stamped with it here rather than each save picking a placeholder.
   */
  currencyCode?: string;
  showAdvanced: boolean;
  onToggleAdvanced: () => void;
  t?: CollectionRuleBuilderTexts;
}

let localIdCounter = 0;
function nextLocalId(): string {
  localIdCounter += 1;
  return `c${localIdCounter}`;
}

export function CollectionRuleBuilder({
  sources,
  onChange,
  errors = [],
  available,
  unavailableReason,
  adminUrlForCollection,
  currencyCode,
  showAdvanced,
  onToggleAdvanced,
  t = {},
}: CollectionRuleBuilderProps) {
  const updateSource = useCallback(
    (index: number, patch: Partial<RuleSource>) => {
      onChange(sources.map((s, i) => (i === index ? { ...s, ...patch } : s)));
    },
    [sources, onChange],
  );

  const updateCondition = useCallback(
    (sourceIndex: number, side: ConditionSide, localId: string, patch: Partial<RuleCondition>) => {
      const source = sources[sourceIndex];
      const block = side === "inclusion" ? source.inclusion : source.exclusion;
      if (!block) return;
      const next = {
        ...block,
        conditions: block.conditions.map((c) => (c.localId === localId ? { ...c, ...patch } : c)),
      };
      updateSource(sourceIndex, side === "inclusion" ? { inclusion: next } : { exclusion: next });
    },
    [sources, updateSource],
  );

  if (!available) {
    return (
      <Banner tone="info" title={t.unavailable || "Rules are not available yet"}>
        <p>{unavailableReason}</p>
      </Banner>
    );
  }

  const errorFor = (sourceIndex: number, conditionId?: string) =>
    errors.find((e) => e.sourceIndex === sourceIndex && e.conditionId === conditionId);

  const renderCondition = (sourceIndex: number, side: ConditionSide, condition: RuleCondition) => {
    const spec = conditionKind(side, condition.kind);
    const error = errorFor(sourceIndex, condition.localId);
    const valueless = condition.relation === "IS_SET" || condition.relation === "IS_NOT_SET";

    return (
      <InlineStack key={condition.localId} gap="200" blockAlign="start" wrap>
        <Box minWidth="180px">
          <Select
            label=""
            labelHidden
            options={conditionKinds(side).map((k) => ({ value: k.key, label: t.kinds?.[k.labelKey] ?? k.key }))}
            value={condition.kind}
            onChange={(kind) =>
              // Switching the kind resets relation and value: the previous
              // relation almost certainly does not exist on the new kind, and
              // keeping it would build a payload Shopify refuses.
              updateCondition(sourceIndex, side, condition.localId, {
                ...newCondition(side, kind, condition.localId, { currencyCode }),
              })
            }
          />
        </Box>

        {spec && spec.relations.length > 0 && (
          <Box minWidth="180px">
            <Select
              label=""
              labelHidden
              options={spec.relations.map((r) => ({ value: r, label: t.relations?.[r] ?? r }))}
              value={condition.relation}
              onChange={(relation) => updateCondition(sourceIndex, side, condition.localId, { relation })}
            />
          </Box>
        )}

        {spec?.needsDefinition && (
          <Box minWidth="200px">
            <TextField
              label=""
              labelHidden
              placeholder={t.definitionPlaceholder || "Metafield definition ID"}
              value={condition.definitionId ?? ""}
              onChange={(definitionId) => updateCondition(sourceIndex, side, condition.localId, { definitionId })}
              autoComplete="off"
              error={error?.code === "missingDefinition"}
            />
          </Box>
        )}

        {!valueless && (
          <Box minWidth="200px">
            <TextField
              label=""
              labelHidden
              value={condition.value}
              onChange={(value) => updateCondition(sourceIndex, side, condition.localId, { value })}
              autoComplete="off"
              // A list kind takes several values; saying so beats a merchant
              // discovering it by trying.
              helpText={spec?.list ? t.commaSeparated || "Comma-separated" : undefined}
              error={error?.code === "emptyValue"}
            />
          </Box>
        )}

        {/* `WeightInput` takes a unit, and the number means nothing without
            it: 2 kilograms and 2 ounces are different rules. */}
        {spec?.read === "weight" && !valueless && (
          <Box minWidth="140px">
            <Select
              label=""
              labelHidden
              options={WEIGHT_UNITS.map((u) => ({ value: u, label: t.weightUnits?.[u] ?? u }))}
              value={condition.weightUnit ?? "KILOGRAMS"}
              onChange={(unit) =>
                updateCondition(sourceIndex, side, condition.localId, { weightUnit: unit as WeightUnit })
              }
            />
          </Box>
        )}

        {/* Shopify stores this per category value; the form holds one answer
            for the condition, and a tree that disagrees is read-only instead. */}
        {spec?.read === "category" && (
          <Box minWidth="200px">
            <Checkbox
              label={t.includeDescendants || "Including subcategories"}
              checked={condition.includeDescendants === true}
              onChange={(includeDescendants) =>
                updateCondition(sourceIndex, side, condition.localId, { includeDescendants })
              }
            />
          </Box>
        )}

        {/* The condition's OWN matchType — the second level, and the one the
            legacy ruleSet projection drops. Only meaningful with >1 value. */}
        {spec?.list && showAdvanced && condition.value.includes(",") && (
          <Box minWidth="150px">
            <Select
              label=""
              labelHidden
              options={CONDITION_MATCH_TYPES.map((m) => ({
                value: m,
                label: m === "ALL" ? t.matchAll || "all of these" : t.matchAny || "any of these",
              }))}
              value={condition.matchType ?? "ANY"}
              onChange={(matchType) =>
                updateCondition(sourceIndex, side, condition.localId, {
                  matchType: matchType as (typeof CONDITION_MATCH_TYPES)[number],
                })
              }
            />
          </Box>
        )}

        <Button
          variant="plain"
          tone="critical"
          onClick={() => {
            const source = sources[sourceIndex];
            const block = side === "inclusion" ? source.inclusion : source.exclusion;
            if (!block) return;
            const next = { ...block, conditions: block.conditions.filter((c) => c.localId !== condition.localId) };
            updateSource(sourceIndex, side === "inclusion" ? { inclusion: next } : { exclusion: next });
          }}
        >
          {t.removeCondition || "Remove"}
        </Button>
      </InlineStack>
    );
  };

  return (
    <BlockStack gap="400">
      {sources.map((source, sourceIndex) => {
        // §2.4 read-only rule. Displayed, never edited, never submitted.
        if (source.unrenderable) {
          return (
            <Banner key={source.id ?? sourceIndex} tone="warning" title={t.readOnlyHeading || "Rule kept unchanged"}>
              <BlockStack gap="200">
                <Text as="p">
                  {t.readOnlyBody ||
                    "This rule uses something this editor cannot show. It is left exactly as it is — edit it in the Shopify admin."}
                </Text>
                {adminUrlForCollection && (
                  <Link url={adminUrlForCollection} target="_blank">
                    {t.openInAdmin || "Open in Shopify admin"}
                  </Link>
                )}
              </BlockStack>
            </Banner>
          );
        }

        const sourceError = errorFor(sourceIndex);

        return (
          <Card key={source.id ?? sourceIndex}>
            <BlockStack gap="300">
              {showAdvanced && sources.length > 1 && (
                <TextField
                  label={t.sourceTitle || "Name of this rule set"}
                  value={source.title}
                  onChange={(title) => updateSource(sourceIndex, { title })}
                  autoComplete="off"
                  error={sourceError?.code === "noTitle"}
                />
              )}

              <InlineStack gap="200" blockAlign="center">
                <Text as="p" variant="bodyMd">{t.heading || "Products must match"}</Text>
                <Box minWidth="160px">
                  <Select
                    label=""
                    labelHidden
                    options={CONDITION_MATCH_TYPES.map((m) => ({
                      value: m,
                      label: m === "ALL" ? t.matchAll || "all conditions" : t.matchAny || "any condition",
                    }))}
                    value={source.inclusion.matchType}
                    onChange={(matchType) =>
                      updateSource(sourceIndex, {
                        inclusion: { ...source.inclusion, matchType: matchType as (typeof CONDITION_MATCH_TYPES)[number] },
                      })
                    }
                  />
                </Box>
              </InlineStack>

              <BlockStack gap="200">
                {source.inclusion.conditions.map((c) => renderCondition(sourceIndex, "inclusion", c))}
              </BlockStack>

              {sourceError?.code === "noConditions" && (
                <Text as="p" tone="critical">
                  {/* A source with no inclusion matches nothing — never the intent. */}
                  At least one condition is required.
                </Text>
              )}

              <InlineStack gap="200">
                <Button
                  onClick={() =>
                    updateSource(sourceIndex, {
                      inclusion: {
                        ...source.inclusion,
                        conditions: [
                          ...source.inclusion.conditions,
                          newCondition("inclusion", conditionKinds("inclusion")[0].key, nextLocalId(), { currencyCode }),
                        ],
                      },
                    })
                  }
                >
                  {t.addCondition || "Add condition"}
                </Button>
                <Button variant="plain" disclosure={showAdvanced ? "up" : "down"} onClick={onToggleAdvanced}>
                  {showAdvanced ? t.simple || "Fewer options" : t.advanced || "Advanced"}
                </Button>
              </InlineStack>

              <Collapsible open={showAdvanced} id={`rule-advanced-${sourceIndex}`}>
                <Box paddingBlockStart="300">
                  <BlockStack gap="300">
                    <Text as="p" variant="headingSm">{t.exclusionsHeading || "Except products that match"}</Text>
                    <Text as="p" tone="subdued">
                      {/* Said out loud because the asymmetry is invisible
                          otherwise and produces a rejected save. */}
                      Fewer criteria can be excluded than included — Shopify's rules, not ours.
                    </Text>
                    {(source.exclusion?.conditions ?? []).map((c) => renderCondition(sourceIndex, "exclusion", c))}
                    <Button
                      onClick={() =>
                        updateSource(sourceIndex, {
                          exclusion: {
                            matchType: source.exclusion?.matchType ?? "ANY",
                            conditions: [
                              ...(source.exclusion?.conditions ?? []),
                              newCondition("exclusion", conditionKinds("exclusion")[0].key, nextLocalId(), { currencyCode }),
                            ],
                          },
                        })
                      }
                    >
                      {t.addExclusion || "Add exclusion"}
                    </Button>

                    {sources.length > 1 && (
                      <Button
                        variant="plain"
                        tone="critical"
                        onClick={() => onChange(sources.filter((_, i) => i !== sourceIndex))}
                      >
                        {t.removeSource || "Remove this rule set"}
                      </Button>
                    )}
                  </BlockStack>
                </Box>
              </Collapsible>
            </BlockStack>
          </Card>
        );
      })}

      {showAdvanced && (
        <Button
          onClick={() =>
            onChange([
              ...sources,
              {
                title: `Rule set ${sources.length + 1}`,
                inclusion: {
                  matchType: "ALL",
                  conditions: [newCondition("inclusion", conditionKinds("inclusion")[0].key, nextLocalId(), { currencyCode })],
                },
              },
            ])
          }
        >
          {t.addSource || "Add another rule set"}
        </Button>
      )}

      <Text as="p" tone="subdued">
        {t.noPreview || "Which products match becomes visible after saving."}
      </Text>
    </BlockStack>
  );
}
