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
 * fetched live when the card is opened (`/api/product-option-details`). When
 * that count is unavailable the dialog says so rather than showing a zero — a
 * zero would read as "nothing depends on this, delete freely", which is the
 * opposite of what an unanswered question means.
 *
 * -- Ordering ----------------------------------------------------------------
 * Both options AND their values are draggable. `optionValuesToUpdate` renames
 * by id and carries no position -- which is where this file's earlier "values
 * cannot be reordered" note came from -- but `productOptionsReorder` takes a
 * NESTED value list with positions, which is how Shopify's own admin does it.
 * It matters beyond tidiness: the first option and its first value decide which
 * variant the storefront shows FIRST, i.e. the one a customer sees before
 * touching anything.
 *
 * -- Swatches ----------------------------------------------------------------
 * A colour value is painted next to its name. Shopify's own per-value swatch
 * is the source wherever there is one; the rest is `resolveSwatch`, which will
 * read a hex out of the name and knows the basic colour WORDS of the three
 * languages this app ships in, and returns nothing for anything else. A swatch
 * that is confidently the wrong colour is worse than none, because it is what
 * the merchant looks at instead of the name.
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
  Modal,
  Tag,
  Text,
  TextField,
} from "@shopify/polaris";
import { DeleteIcon, DragHandleIcon, PlusIcon } from "@shopify/polaris-icons";
import { DisabledActionTooltip } from "../DisabledActionTooltip";
import { useSingleLocaleHint } from "../../contexts/LocaleAvailabilityContext";
import { variantCountKey } from "../../services/product-options.shared";
import {
  looksLikeColourOption,
  resolveSwatch,
  type OptionValueSwatch,
} from "../../services/product-option-swatch.shared";
import type { OptionData } from "./OptionsField";

/**
 * The colour chip in front of a value.
 *
 * `aria-hidden`: the name next to it already says which colour this is, so a
 * screen reader would only hear it twice. A swatch IMAGE (a pattern, a fabric)
 * is shown as the image, since a pattern cannot be one colour.
 */
function Swatch({ swatch }: { swatch: ReturnType<typeof resolveSwatch> }) {
  if (!swatch) return null;
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: "16px",
        height: "16px",
        flex: "0 0 auto",
        borderRadius: "4px",
        // A border so white and very light colours are still a visible chip
        // rather than a hole in the card.
        border: "1px solid var(--p-color-border)",
        // The colour sits UNDER the image, so an image that 404s or is blocked
        // by CSP falls back to the known colour instead of an empty chip. The
        // URL is pinned to `https?://` without quotes or parens by
        // `resolveSwatch`; the quoting here is the second half of that.
        backgroundColor: swatch.color,
        backgroundImage: swatch.imageUrl ? `url(${JSON.stringify(swatch.imageUrl)})` : undefined,
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      }}
    />
  );
}

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
  /** Drops a not-yet-saved option again, by its index in `optionsToCreate`. */
  onCancelCreateOption?: (index: number) => void;
  onDeleteOption: (optionId: string) => void;
  onReorder: (orderedIds: string[]) => void;
  /** Values in their new order, for one option. Their order decides which
   *  variant the storefront shows first. */
  onReorderValues?: (optionId: string, orderedValueIds: string[]) => void;
  /** Jump to this app's own metaobjects page for a linked option. */
  onOpenMetaobjects?: (option: OptionData) => void;
  onTranslate?: (optionId: string) => void;
  translatingFieldIds?: Set<string>;
  /** Bumped whenever a save lands. The variant counts are re-fetched: a save
   *  that added a value multiplied the matrix, and the next delete dialog must
   *  not name the number from before it. */
  savedNonce?: number;

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
  onCancelCreateOption,
  onDeleteOption,
  onReorder,
  onReorderValues,
  onOpenMetaobjects,
  onTranslate,
  translatingFieldIds = new Set(),
  savedNonce = 0,
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
  /** Shopify's own swatches, keyed by value GID. Fetched with the counts. */
  const [swatches, setSwatches] = useState<Record<string, OptionValueSwatch>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  /** The GID of the value being dragged. A value only ever moves within its
   *  own option: `moveValue` looks both ids up in ONE option's list and bails
   *  when either is absent. */
  const [dragValue, setDragValue] = useState<string | null>(null);
  /** The dragged value order per option id, or absent while untouched. Local,
   *  because a drag has to feel immediate. */
  const [valueOrder, setValueOrder] = useState<Record<string, string[]>>({});
  /**
   * The pending confirmation, or null.
   *
   * A Polaris Modal rather than `window.confirm`: inside the embedded admin
   * iframe the native dialog is a focus trap, and the browser's "prevent
   * additional dialogs" checkbox silently suppresses it -- which would delete
   * a merchant's variants with NO confirmation at all. Same ruling as the plan
   * downgrade and the image delete.
   */
  const [pendingConfirm, setPendingConfirm] = useState<
    | { kind: "value"; optionId: string; valueId: string; body: string }
    | { kind: "option"; optionId: string; body: string }
    | null
  >(null);

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
    fetch(`/api/product-option-details?productId=${encodeURIComponent(productId)}`)
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        setImpact(body?.success ? (body.counts as Record<string, number>) : {});
        setSwatches(body?.success ? ((body.swatches ?? {}) as Record<string, OptionValueSwatch>) : {});
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
    setSwatches({});
    setOpenOptionId(null);
    setDraft(null);
    setOrder(null);
    setValueOrder({});
    setPendingConfirm(null);
  }, [productId]);

  /**
   * A landed save invalidates two things.
   *
   * The counts, because adding a value multiplies the matrix and the next
   * delete dialog would otherwise name the pre-save number. And the local drag
   * order, because a DISCARD clears the hook's pending order while this
   * component would happily keep showing an arrangement that will never be
   * saved.
   */
  useEffect(() => {
    if (savedNonce === 0) return;
    setImpact(null);
    setOrder(null);
    setValueOrder({});
  }, [savedNonce]);

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

    // The dragged order, when there is one. Anything the order does not
    // mention (a value that arrived after the drag) keeps its place at the end
    // rather than disappearing.
    const wanted = valueOrder[option.id];
    const ordered = wanted
      ? [
          ...wanted.map((id) => existing.find((v) => v.id === id)).filter((v): v is typeof existing[number] => !!v),
          ...existing.filter((v) => !wanted.includes(v.id)),
        ]
      : existing;

    const added = (valuesToAdd[option.id] ?? []).map((name, index) => ({
      id: "",
      name,
      addedIndex: index,
      linked: false,
    }));
    // Pending adds stay at the END: they have no Shopify id yet, so they
    // cannot take part in a reorder and pretending otherwise would show an
    // arrangement the save cannot express.
    return [...ordered, ...added];
  };

  /** Moves `fromId` to where `toId` sits, within one option. */
  const moveValue = (option: OptionData, fromId: string, toId: string) => {
    if (!fromId || !toId || fromId === toId) return;
    const ids = valuesOf(option).filter((v) => v.id).map((v) => v.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    setValueOrder((prev) => ({ ...prev, [option.id]: ids }));
    onReorderValues?.(option.id, ids);
  };

  const deleteValueBody = useCallback(
    (optionName: string, valueName: string) => {
      // The SAVED names, never the edited ones: the map is keyed on what
      // Shopify reports in `selectedOptions`, so looking it up under a pending
      // rename made every count read as unavailable.
      const count = impact?.[variantCountKey(optionName, valueName)];
      return count === undefined
        ? t.deleteValueUnknown ||
            "This deletes the variants that use this value, with their stock and prices. How many that is could not be read."
        : (t.deleteValueCount || "This deletes {n} variant(s), including their stock, prices and SKUs.").replace(
            "{n}",
            String(count),
          );
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
          // Gates the bare-hex rule only: on a Size option "DDD" is a cup size.
          const isColourOption = looksLikeColourOption(option.name, option.linkedMetaobjectType);

          if (!isOpen) {
            return (
              <div
                key={option.id}
                draggable
                onDragStart={() => setDragId(option.id)}
                // Released over dead space, the id would otherwise stay set and
                // the NEXT drop -- of anything -- would replay this move.
                onDragEnd={() => setDragId(null)}
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
                          {option.isLinked &&
                            (onOpenMetaobjects ? (
                              // A linked option's values live in metaobjects,
                              // so the place to edit them is this app's own
                              // metaobjects page -- one click, not a hunt.
                              <span
                                role="link"
                                tabIndex={0}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onOpenMetaobjects(option);
                                }}
                                onKeyDown={(event) => {
                                  if (event.key !== "Enter" && event.key !== " ") return;
                                  event.stopPropagation();
                                  onOpenMetaobjects(option);
                                }}
                                style={{ cursor: "pointer" }}
                              >
                                <Badge tone="info">{t.linkedBadge || "Metaobject"}</Badge>
                              </span>
                            ) : (
                              <Badge tone="info">{t.linkedBadge || "Metaobject"}</Badge>
                            ))}
                        </InlineStack>
                        <InlineStack gap="100" wrap>
                          {values.map((value) => {
                            const swatch = resolveSwatch(value.name, swatches[value.id], { isColourOption });
                            return (
                              <Tag key={value.id || `new-${value.addedIndex}`}>
                                {swatch ? (
                                  <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                                    <Swatch swatch={swatch} />
                                    {value.name}
                                  </span>
                                ) : (
                                  value.name
                                )}
                              </Tag>
                            );
                          })}
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

                {/* Capped: an option name is two words, and left to itself a
                    Polaris field fills the whole editor column. */}
                <div style={{ maxWidth: "var(--app-short-field-width)" }}>
                  <TextField
                    label={t.optionNameLabel || "Option name"}
                    labelHidden
                    value={nameOf(option)}
                    onChange={(value) => onNameChange(option.id, value)}
                    autoComplete="off"
                  />
                </div>

                {/* A metaobject-linked option's values live in the metaobjects,
                    so they are shown and never edited here — the same rule the
                    old card followed. */}
                {option.isLinked ? (
                  <BlockStack gap="200">
                    <InlineStack gap="100" wrap>
                      {values.map((value) => {
                        const swatch = resolveSwatch(value.name, swatches[value.id], { isColourOption });
                        return (
                          <Tag key={value.id}>
                            {swatch ? (
                              <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                                <Swatch swatch={swatch} />
                                {value.name}
                              </span>
                            ) : (
                              value.name
                            )}
                          </Tag>
                        );
                      })}
                    </InlineStack>
                    {onOpenMetaobjects && (
                      <InlineStack>
                        <Button variant="plain" onClick={() => onOpenMetaobjects(option)}>
                          {t.editMetaobject || "Edit these values"}
                        </Button>
                      </InlineStack>
                    )}
                  </BlockStack>
                ) : (
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd">{t.valuesLabel || "Option values"}</Text>
                    {values.map((value, index) => (
                      <div
                        key={value.id || `new-${index}`}
                        // Only SAVED values can move: a pending add has no
                        // Shopify id, so it cannot be given a position.
                        draggable={!!value.id}
                        onDragStart={(event) => {
                          if (!value.id) return;
                          // Stops the OPTION card underneath from being
                          // dragged at the same time.
                          event.stopPropagation();
                          setDragValue(value.id);
                        }}
                        onDragEnd={() => setDragValue(null)}
                        onDragOver={(event) => {
                          if (!value.id || !dragValue) return;
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onDrop={(event) => {
                          if (!value.id || !dragValue) return;
                          event.stopPropagation();
                          moveValue(option, dragValue, value.id);
                          setDragValue(null);
                        }}
                      >
                      <InlineStack gap="200" blockAlign="center" wrap={false}>
                        {value.id && (
                          <span style={{ cursor: "grab", display: "flex" }} aria-hidden>
                            <Icon source={DragHandleIcon} tone="subdued" />
                          </span>
                        )}
                        <Swatch swatch={resolveSwatch(value.name, swatches[value.id], { isColourOption })} />
                        <div style={{ flex: 1, maxWidth: "var(--app-short-field-width)" }}>
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
                            const saved = option.values.find((v) => v.id === value.id);
                            setPendingConfirm({
                              kind: "value",
                              optionId: option.id,
                              valueId: value.id,
                              body: deleteValueBody(option.name, saved?.name ?? value.name),
                            });
                          }}
                          // Shopify keeps every option on at least one value.
                          disabled={values.length <= 1}
                        />
                      </InlineStack>
                      </div>
                    ))}

                    <InlineStack gap="200" blockAlign="center" wrap={false}>
                      <div style={{ flex: 1, maxWidth: "var(--app-short-field-width)" }}>
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
                    onClick={() =>
                      setPendingConfirm({
                        kind: "option",
                        optionId: option.id,
                        body:
                          t.deleteOptionConfirm ||
                          "This removes the option and rebuilds the product's variants around the remaining ones. Variants that become duplicates are deleted with their stock and prices.",
                      })
                    }
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
            <InlineStack align="space-between" blockAlign="start" wrap={false}>
              <BlockStack gap="150">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="p" variant="bodyMd" fontWeight="semibold">{created.name}</Text>
                  <Badge tone="attention">{t.pendingBadge || "Not saved yet"}</Badge>
                </InlineStack>
                <InlineStack gap="100" wrap>
                  {created.values.map((value) => <Tag key={value}>{value}</Tag>)}
                </InlineStack>
              </BlockStack>
              {/* Nothing has been written yet, so this takes nothing with it
                  and needs no confirmation. Without it the only way out of a
                  mistyped option was discarding every other edit too. */}
              <Button
                icon={DeleteIcon}
                variant="tertiary"
                accessibilityLabel={t.removeValue || "Remove value"}
                onClick={() => onCancelCreateOption?.(index)}
              />
            </InlineStack>
          </Card>
        ))}

        {draft && (
          <Card padding="300">
            <BlockStack gap="300">
              <div style={{ maxWidth: "var(--app-short-field-width)" }}>
                <TextField
                  label={t.optionNameLabel || "Option name"}
                  value={draft.name}
                  onChange={(name) => setDraft({ ...draft, name })}
                  autoComplete="off"
                  placeholder={t.optionNamePlaceholder || "Size, Colour, Material"}
                />
              </div>
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd">{t.valuesLabel || "Option values"}</Text>
                {draft.values.map((value, index) => (
                  <InlineStack key={index} gap="200" blockAlign="center" wrap={false}>
                    <Swatch swatch={resolveSwatch(value, null, { isColourOption: looksLikeColourOption(draft.name) })} />
                    <div style={{ flex: 1, maxWidth: "var(--app-short-field-width)" }}>
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

      <Modal
        open={!!pendingConfirm}
        onClose={() => setPendingConfirm(null)}
        title={
          pendingConfirm?.kind === "option"
            ? t.deleteOptionTitle || "Delete this variant?"
            : t.deleteValueTitle || "Delete this value?"
        }
        primaryAction={{
          content: t.deleteOption || "Delete",
          destructive: true,
          onAction: () => {
            if (!pendingConfirm) return;
            if (pendingConfirm.kind === "value") {
              onRemoveValue(pendingConfirm.optionId, pendingConfirm.valueId);
            } else {
              onDeleteOption(pendingConfirm.optionId);
              setOpenOptionId(null);
            }
            setPendingConfirm(null);
          },
        }}
        secondaryActions={[
          { content: t.cancel || "Cancel", onAction: () => setPendingConfirm(null) },
        ]}
      >
        <Modal.Section>
          <Text as="p">{pendingConfirm?.body}</Text>
        </Modal.Section>
      </Modal>
    </Card>
  );
}
