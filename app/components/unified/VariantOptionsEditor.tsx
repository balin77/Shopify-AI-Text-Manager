/**
 * The variants card, in the shape the Shopify admin uses.
 *
 * -- What changed and why -----------------------------------------------------
 * The old card put every option into an always-open form: a name field, one
 * text input per value, all of it stacked, headed "Option 1" / "Option 2". A
 * product with a dozen colours filled the screen with inputs nobody was editing,
 * and the heading named a position rather than the thing itself.
 *
 * So: each option is a COLLAPSED summary — its name and its values as chips —
 * until it is clicked. That is Shopify's own arrangement, and it is the right
 * one: reading which options exist is the common case, editing them is the rare
 * one.
 *
 * -- The part that is not layout ---------------------------------------------
 * Three of the actions here change the product's VARIANT MATRIX, and one of
 * them destroys data:
 *
 *   adding a value      creates variants (priced 0 until the merchant says
 *                       otherwise) -- harmless, and undone by deleting it again
 *   deleting a value    DELETES the variants that used it, with their stock,
 *                       prices, SKUs and image assignments. Irreversible.
 *   deleting an option  collapses the matrix onto the remaining options
 *
 * The delete confirmation therefore names the NUMBER of variants at stake,
 * fetched live when the card is opened (`/api/product-option-impact`). When
 * that count is unavailable the dialog says so rather than showing a zero — a
 * zero would read as "nothing depends on this, delete freely", which is the
 * opposite of what an unanswered question means.
 *
 * -- What it deliberately does not do ----------------------------------------
 * Values cannot be reordered. Shopify's `optionValuesToUpdate` renames by id
 * and has no position, so a drag here could only be faked locally and would
 * snap back on the next load. Options CAN be reordered, because
 * `productOptionsReorder` exists for exactly that.
 *
 * Nothing here writes on its own: every action edits pending state that the
 * editor's ONE save bar carries, the same as the text fields.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  Icon,
  InlineStack,
  Tag,
  Text,
  TextField,
} from "@shopify/polaris";
import { DeleteIcon, DragHandleIcon, PlusIcon } from "@shopify/polaris-icons";
import { DisabledActionTooltip } from "../DisabledActionTooltip";
import { useSingleLocaleHint } from "../../contexts/LocaleAvailabilityContext";
import { variantCountKey } from "../../services/product-options.shared";
import type { OptionData } from "./OptionsField";

export interface VariantOptionsEditorProps {
  productId: string;
  options: OptionData[];
  /** Pending text edits, keyed by option id. */
  primaryOptions: Record<string, { name: string; values: string[] }>;
  /** Values added but not yet saved, per option id. */
  valuesToAdd: Record<string, string[]>;
  /** Value GIDs removed but not yet saved, per option id. */
  valuesToDelete: Record<string, string[]>;
  /** Whole options added but not yet saved. */
  optionsToCreate: Array<{ name: string; values: string[] }>;
  /** Option ids removed but not yet saved. */
  optionsToDelete: string[];

  onNameChange: (optionId: string, name: string) => void;
  onValuesChange: (optionId: string, values: string[]) => void;
  onAddValue: (optionId: string, name: string) => void;
  onRemoveValue: (optionId: string, valueId: string, addedIndex?: number) => void;
  onEditPendingValue: (optionId: string, index: number, name: string) => void;
  onCreateOption: (name: string, values: string[]) => void;
  onDeleteOption: (optionId: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onTranslate?: (optionId: string) => void;
  translatingFieldIds?: Set<string>;

  t?: Record<string, string | undefined>;
}

export function VariantOptionsEditor({
  productId,
  options,
  primaryOptions,
  valuesToAdd,
  valuesToDelete,
  optionsToCreate,
  optionsToDelete,
  onNameChange,
  onValuesChange,
  onAddValue,
  onRemoveValue,
  onEditPendingValue,
  onCreateOption,
  onDeleteOption,
  onReorder,
  onTranslate,
  translatingFieldIds = new Set(),
  t = {},
}: VariantOptionsEditorProps) {
  const singleLocaleHint = useSingleLocaleHint();

  /** Which option is open. One at a time — Shopify does the same, and two open
   *  editors make the "Done" buttons ambiguous. */
  const [openOptionId, setOpenOptionId] = useState<string | null>(null);
  /** The draft for a brand-new option, or null while none is being added. */
  const [draft, setDraft] = useState<{ name: string; values: string[] } | null>(null);
  /** Per-option text in the "add a value" box. */
  const [valueDrafts, setValueDrafts] = useState<Record<string, string>>({});
  /** Variants per option-value, for the delete confirmation. `null` = not
   *  loaded, which the dialog reports rather than treating as zero. */
  const [impact, setImpact] = useState<Record<string, number> | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  /**
   * The order shown. Local, because a drag has to feel immediate — the pending
   * order travels to the save separately.
   */
  const [order, setOrder] = useState<string[] | null>(null);

  const visible = useMemo(() => {
    const alive = options.filter((o) => !optionsToDelete.includes(o.id));
    if (!order) return alive;
    const byId = new Map(alive.map((o) => [o.id, o]));
    // Anything the order does not mention (an option that arrived after the
    // drag) keeps its place at the end rather than disappearing.
    const ordered = order.map((id) => byId.get(id)).filter((o): o is OptionData => !!o);
    const rest = alive.filter((o) => !order.includes(o.id));
    return [...ordered, ...rest];
  }, [options, optionsToDelete, order]);

  /**
   * The variant impact, fetched once per product and only when an option is
   * actually opened. It is a 250-variant query; putting it on every product
   * open would pay for it on every product nobody edits.
   */
  useEffect(() => {
    if (!openOptionId || impact !== null || !productId) return;
    let cancelled = false;
    fetch(`/api/product-option-impact?productId=${encodeURIComponent(productId)}`)
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        setImpact(body?.success ? (body.counts as Record<string, number>) : {});
      })
      .catch(() => {
        // An empty map is "we could not count", which the dialog says out loud.
        if (!cancelled) setImpact({});
      });
    return () => { cancelled = true; };
  }, [openOptionId, impact, productId]);

  /** Reset the fetched impact when the product changes — another product's
   *  counts would name the wrong number in a delete dialog. */
  useEffect(() => {
    setImpact(null);
    setOpenOptionId(null);
    setDraft(null);
    setOrder(null);
  }, [productId]);

  const nameOf = (option: OptionData) =>
    primaryOptions[option.id]?.name !== undefined ? primaryOptions[option.id].name : option.name;

  /** The values as they currently READ: saved ones minus pending deletes, plus
   *  pending adds. Rendering the saved list alone would make a removal look
   *  like it had not registered until the save. */
  const valuesOf = (option: OptionData): Array<{
    /** "" for a value that exists only locally — it has no Shopify GID yet. */
    id: string;
    name: string;
    linked?: boolean;
    /** Set only on a pending add: which entry of `valuesToAdd` this is. */
    addedIndex?: number;
  }> => {
    const removed = new Set(valuesToDelete[option.id] ?? []);
    const edited = primaryOptions[option.id]?.values;
    const existing = option.values
      .map((v, index) => ({ id: v.id, name: edited?.[index] ?? v.name, linked: v.linked }))
      .filter((v) => !removed.has(v.id));
    const added = (valuesToAdd[option.id] ?? []).map((name, index) => ({
      id: "",
      name,
      addedIndex: index,
      linked: false,
    }));
    return [...existing, ...added];
  };

  const confirmValueDelete = useCallback(
    (optionName: string, valueName: string) => {
      const count = impact?.[variantCountKey(optionName, valueName)];
      const message =
        count === undefined
          ? t.deleteValueUnknown ||
            "This deletes the variants that use this value, with their stock and prices. How many that is could not be read."
          : (t.deleteValueCount || "This deletes {n} variant(s), including their stock, prices and SKUs.").replace(
              "{n}",
              String(count),
            );
      return window.confirm(`${message}`);
    },
    [impact, t],
  );

  const commitDraft = () => {
    if (!draft) return;
    const values = draft.values.map((v) => v.trim()).filter(Boolean);
    if (!draft.name.trim() || values.length === 0) return;
    onCreateOption(draft.name.trim(), values);
    setDraft(null);
  };

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h3" variant="headingMd" fontWeight="bold">
            {t.title || "Variants"}
          </Text>
          <Button
            icon={PlusIcon}
            size="slim"
            onClick={() => {
              setOpenOptionId(null);
              setDraft({ name: "", values: [""] });
            }}
            disabled={!!draft}
          >
            {t.addOption || "Add variant"}
          </Button>
        </InlineStack>

        {visible.map((option) => {
          const isOpen = openOptionId === option.id;
          const values = valuesOf(option);

          if (!isOpen) {
            return (
              <div
                key={option.id}
                draggable
                onDragStart={() => setDragId(option.id)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => {
                  if (!dragId || dragId === option.id) return;
                  const ids = visible.map((o) => o.id);
                  const from = ids.indexOf(dragId);
                  const to = ids.indexOf(option.id);
                  if (from < 0 || to < 0) return;
                  ids.splice(to, 0, ...ids.splice(from, 1));
                  setOrder(ids);
                  onReorder(ids);
                  setDragId(null);
                }}
                style={{ cursor: "pointer" }}
              >
                <Card background="bg-surface-secondary" padding="300">
                  <InlineStack gap="300" blockAlign="start" wrap={false}>
                    {/* The handle is the affordance; the whole row is draggable
                        so a merchant does not have to hit an 8px target. */}
                    <span style={{ cursor: "grab", paddingTop: "2px" }} aria-hidden>
                      <Icon source={DragHandleIcon} tone="subdued" />
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }} onClick={() => setOpenOptionId(option.id)}>
                      <BlockStack gap="150">
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="p" variant="bodyMd" fontWeight="semibold">
                            {nameOf(option)}
                          </Text>
                          {option.isLinked && <Badge tone="info">{t.linkedBadge || "Metaobject"}</Badge>}
                        </InlineStack>
                        <InlineStack gap="100" wrap>
                          {values.map((value) => (
                            <Tag key={value.id || `new-${value.name}`}>{value.name}</Tag>
                          ))}
                        </InlineStack>
                      </BlockStack>
                    </div>
                  </InlineStack>
                </Card>
              </div>
            );
          }

          return (
            <Card key={option.id} padding="300">
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                    {t.optionNameLabel || "Option name"}
                  </Text>
                  {onTranslate && !option.isLinked && (
                    <DisabledActionTooltip hint={singleLocaleHint}>
                      <Button
                        size="slim"
                        onClick={() => onTranslate(option.id)}
                        loading={translatingFieldIds.has(`${option.id}:entire`)}
                        disabled={!!singleLocaleHint}
                      >
                        {t.translateButton || "Translate option"}
                      </Button>
                    </DisabledActionTooltip>
                  )}
                </InlineStack>

                <TextField
                  label={t.optionNameLabel || "Option name"}
                  labelHidden
                  value={nameOf(option)}
                  onChange={(value) => onNameChange(option.id, value)}
                  autoComplete="off"
                />

                {/* A metaobject-linked option's values live in the metaobjects,
                    so they are shown and never edited here — the same rule the
                    old card followed. */}
                {option.isLinked ? (
                  <InlineStack gap="100" wrap>
                    {values.map((value) => (
                      <Tag key={value.id}>{value.name}</Tag>
                    ))}
                  </InlineStack>
                ) : (
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd">{t.valuesLabel || "Option values"}</Text>
                    {values.map((value, index) => (
                      <InlineStack key={value.id || `new-${index}`} gap="200" blockAlign="center" wrap={false}>
                        <div style={{ flex: 1 }}>
                          <TextField
                            label={t.valueLabel || "Value"}
                            labelHidden
                            value={value.name}
                            onChange={(next) => {
                              // Only SAVED values are renamed positionally —
                              // a pending add has no id to rename against, so
                              // it is replaced in the pending list instead.
                              if (!value.id) {
                                if (value.addedIndex !== undefined) {
                                  onEditPendingValue(option.id, value.addedIndex, next);
                                }
                                return;
                              }
                              const all = option.values.map(
                                (v, i) => primaryOptions[option.id]?.values?.[i] ?? v.name,
                              );
                              const target = option.values.findIndex((v) => v.id === value.id);
                              if (target < 0) return;
                              all[target] = next;
                              onValuesChange(option.id, all);
                            }}
                            autoComplete="off"
                          />
                        </div>
                        <Button
                          icon={DeleteIcon}
                          accessibilityLabel={t.removeValue || "Remove value"}
                          onClick={() => {
                            // A value that was only added locally takes nothing
                            // with it, so it needs no warning.
                            if (!value.id) {
                              onRemoveValue(option.id, "", value.addedIndex);
                              return;
                            }
                            if (!confirmValueDelete(nameOf(option), value.name)) return;
                            onRemoveValue(option.id, value.id);
                          }}
                          // Shopify keeps every option on at least one value.
                          disabled={values.length <= 1}
                        />
                      </InlineStack>
                    ))}

                    <InlineStack gap="200" blockAlign="center" wrap={false}>
                      <div style={{ flex: 1 }}>
                        <TextField
                          label={t.addValue || "Add another value"}
                          labelHidden
                          placeholder={t.addValue || "Add another value"}
                          value={valueDrafts[option.id] ?? ""}
                          onChange={(next) => setValueDrafts((prev) => ({ ...prev, [option.id]: next }))}
                          autoComplete="off"
                        />
                      </div>
                      <Button
                        onClick={() => {
                          onAddValue(option.id, valueDrafts[option.id] ?? "");
                          setValueDrafts((prev) => ({ ...prev, [option.id]: "" }));
                        }}
                        disabled={!(valueDrafts[option.id] ?? "").trim()}
                      >
                        {t.add || "Add"}
                      </Button>
                    </InlineStack>
                  </BlockStack>
                )}

                <InlineStack align="space-between" blockAlign="center">
                  <Button
                    tone="critical"
                    variant="tertiary"
                    onClick={() => {
                      const message =
                        t.deleteOptionConfirm ||
                        "This removes the option and rebuilds the product's variants around the remaining ones.";
                      if (!window.confirm(message)) return;
                      onDeleteOption(option.id);
                      setOpenOptionId(null);
                    }}
                    // The last option cannot go: Shopify keeps every product
                    // on at least one, and the server refuses it too.
                    disabled={visible.length <= 1}
                  >
                    {t.deleteOption || "Delete"}
                  </Button>
                  <Button variant="primary" onClick={() => setOpenOptionId(null)}>
                    {t.done || "Done"}
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          );
        })}

        {/* Options added in this session but not yet saved. Shown as plain
            summaries: their values have no Shopify ids yet, so there is nothing
            here that could be renamed or translated until the save lands. */}
        {optionsToCreate.map((created, index) => (
          <Card key={`pending-${index}`} background="bg-surface-secondary" padding="300">
            <BlockStack gap="150">
              <InlineStack gap="200" blockAlign="center">
                <Text as="p" variant="bodyMd" fontWeight="semibold">{created.name}</Text>
                <Badge tone="attention">{t.pendingBadge || "Not saved yet"}</Badge>
              </InlineStack>
              <InlineStack gap="100" wrap>
                {created.values.map((value) => <Tag key={value}>{value}</Tag>)}
              </InlineStack>
            </BlockStack>
          </Card>
        ))}

        {draft && (
          <Card padding="300">
            <BlockStack gap="300">
              <TextField
                label={t.optionNameLabel || "Option name"}
                value={draft.name}
                onChange={(name) => setDraft({ ...draft, name })}
                autoComplete="off"
                placeholder={t.optionNamePlaceholder || "Size, Colour, Material"}
              />
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd">{t.valuesLabel || "Option values"}</Text>
                {draft.values.map((value, index) => (
                  <InlineStack key={index} gap="200" blockAlign="center" wrap={false}>
                    <div style={{ flex: 1 }}>
                      <TextField
                        label={t.valueLabel || "Value"}
                        labelHidden
                        value={value}
                        onChange={(next) => {
                          const values = [...draft.values];
                          values[index] = next;
                          // A trailing empty row appears as soon as the last one
                          // is filled, so adding three values is three keystrokes
                          // and no button presses.
                          if (next.trim() && index === values.length - 1) values.push("");
                          setDraft({ ...draft, values });
                        }}
                        autoComplete="off"
                      />
                    </div>
                    <Button
                      icon={DeleteIcon}
                      accessibilityLabel={t.removeValue || "Remove value"}
                      onClick={() => setDraft({ ...draft, values: draft.values.filter((_, i) => i !== index) })}
                      disabled={draft.values.length <= 1}
                    />
                  </InlineStack>
                ))}
              </BlockStack>
              <InlineStack align="space-between" blockAlign="center">
                <Button variant="tertiary" onClick={() => setDraft(null)}>
                  {t.cancel || "Cancel"}
                </Button>
                <Button
                  variant="primary"
                  onClick={commitDraft}
                  disabled={!draft.name.trim() || !draft.values.some((v) => v.trim())}
                >
                  {t.done || "Done"}
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Card>
  );
}
