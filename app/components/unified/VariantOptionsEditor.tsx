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
 * The dragging itself is dnd-kit, not the browser's own HTML5 drag, and that
 * is not a preference. A native drag reports where the pointer WAS when the
 * merchant let go and nothing else: the list cannot move until the drop, so
 * dragging a value across three others looked exactly like dragging it across
 * none -- the only way to find out where it would land was to drop it and read
 * the result. dnd-kit slides the other items out of the way while the drag is
 * in flight, so what is under the cursor IS what the save will store. It also
 * gives the two gestures a native drag has none of: a 250ms press-and-hold on
 * a touch device (`dragstart` never fires from a finger at all, and the
 * Shopify admin is used on tablets), and Space-arrow-Space from the keyboard.
 * The keyboard path is covered by a test; the touch path is the sensor's,
 * configured exactly as the galleries configure it, and not measured here.
 *
 * Same library, same sensors and same reading (the item in flight is ghosted)
 * as the image manager's galleries -- one drag gesture across the app.
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

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ActionList,
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  Icon,
  InlineStack,
  Modal,
  Popover,
  Tag,
  Text,
  TextField,
  Tooltip,
} from "@shopify/polaris";
import { DeleteIcon, DragHandleIcon, PlusIcon } from "@shopify/polaris-icons";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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

/**
 * What a `SortableItem` hands its drag handle, or null where the item cannot
 * be picked up at all (a value with no Shopify GID, the option card that is
 * currently open).
 *
 * A context rather than a render prop: the handle sits several elements deep
 * inside a Polaris stack in four different places, and threading a props bag
 * through each of them is how two of the four end up spelled differently.
 */
type SortableHandle = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;
const DragHandleContext = createContext<SortableHandle | null>(null);

/**
 * One item of a sortable list.
 *
 * `transform` is the whole point: while a drag is in flight dnd-kit gives
 * every OTHER item the offset it would move by, so the list rearranges under
 * the cursor and the merchant sees the result before committing to it. The
 * dragged item is ghosted and lifted above its neighbours, or it disappears
 * behind the one it is being dragged past.
 *
 * `disabled` means "cannot be picked up", never "is not part of the list": the
 * item stays a DROP TARGET and keeps its rect, because an open option card in
 * the middle of the list is something the other cards still have to be able to
 * move across.
 *
 * The drag listeners always sit on the `DragHandle` inside, never on this
 * wrapper. Two reasons, and the second is the one that is easy to miss: a
 * value row carries a TextField, and a pointer sensor on its container turns
 * "select the word I want to fix" into a drag -- and dnd-kit's activator
 * carries `role="button"`, which under ARIA makes everything inside it
 * presentational. On the collapsed option card that is not theoretical: the
 * "Metaobject" badge in it is the only in-app route to a linked option's
 * values, and a screen reader would stop reporting it as a link at all.
 */
function SortableItem({
  id,
  disabled = false,
  style,
  children,
}: {
  id: string;
  disabled?: boolean;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const sortable = useSortable({
    id,
    // Draggable off, droppable ON -- see above.
    disabled: { draggable: disabled, droppable: false },
  });
  const { setNodeRef, transform, transition, isDragging } = sortable;

  return (
    <div
      ref={setNodeRef}
      // What dnd-kit knows this node as. Nothing in the app reads it; it is
      // what makes a drag inspectable in the DOM at all, since every other
      // trace of one is inline style.
      data-sortable-id={id}
      style={{
        ...style,
        // `Translate`, NOT `Transform`: the second one also writes the scaleX /
        // scaleY dnd-kit computes, which is how a sortable RESIZES an item to
        // the one it is over. On a list whose rows are all the same size that
        // is invisible; on the option cards -- one of which is an open form
        // several hundred pixels tall -- it stretched the card being dragged to
        // 6x its height and squashed the one it passed to a sliver. A preview
        // that distorts what it previews is the bug this file is fixing, in a
        // second costume.
        transform: CSS.Translate.toString(transform),
        transition,
        // The same ghosting the image galleries use, so a drag reads the same
        // way wherever it happens in this app.
        opacity: isDragging ? 0.5 : 1,
        // Lifted, and `relative` because a z-index does nothing on a statically
        // positioned element -- the chip would slide UNDER the ones it passes.
        zIndex: isDragging ? 2 : undefined,
        position: isDragging ? "relative" : undefined,
      }}
    >
      <DragHandleContext.Provider value={disabled ? null : sortable}>
        {children}
      </DragHandleContext.Provider>
    </div>
  );
}

/**
 * The grip in front of a sortable row.
 *
 * Outside a `SortableItem`, or inside a disabled one, it draws a SPACER of the
 * same width instead of nothing: the rows above it start with a handle, and a
 * pending value that begins 20px further left reads as a rendering fault
 * rather than as "this one cannot move yet". The add-a-value row below the
 * list already carried that spacer by hand.
 *
 * It is the only thing here that is not `aria-hidden`: the drag listeners live
 * on it, dnd-kit's `attributes` make it a focusable button, and the keyboard
 * sensor moves the row from it -- so it needs a name, and one that says which
 * row it belongs to. Four handles all called "Reorder" tell a screen reader
 * nothing apart, the same rule the field chrome's bin icons follow.
 */
function DragHandle({ label, style }: { label?: string; style?: CSSProperties }) {
  const handle = useContext(DragHandleContext);

  // The spacer carries no name because it is not a control -- which is also
  // why the two call sites that can only ever render one pass none.
  if (!handle) {
    return <span style={{ width: "var(--app-drag-handle-width)", flex: "0 0 auto", ...style }} aria-hidden />;
  }

  return (
    <span
      ref={handle.setActivatorNodeRef}
      {...handle.attributes}
      {...handle.listeners}
      aria-label={label}
      style={{
        cursor: "grab",
        display: "flex",
        flex: "0 0 auto",
        // The icon is 20px, which is a small thing to hit and a smaller thing
        // to hit with a thumb. The padding grows the TARGET to 32px and the
        // negative margin takes the growth straight back out of the layout, so
        // the icon does not move and the row does not get taller -- the old
        // whole-card drag target is not coming back (it would make the card's
        // contents presentational), so this is what replaces it.
        padding: "6px",
        margin: "-6px",
        ...style,
      }}
    >
      <Icon source={DragHandleIcon} tone="subdued" />
    </span>
  );
}

export interface VariantOptionsEditorProps {
  productId: string;
  options: OptionData[];
  /** Pending text edits, keyed by option id. */
  primaryOptions: Record<string, { name: string; values: string[] }>;
  /** Values added but not yet saved, per option id. */
  valuesToAdd: Record<string, string[]>;
  /** Metaobject entries queued on a LINKED option, per option id. */
  linkedValuesToAdd?: Record<string, Array<{ id: string; name: string }>>;
  /** Value GIDs removed but not yet saved, per option id. */
  valuesToDelete: Record<string, string[]>;
  /** Whole options added but not yet saved. */
  optionsToCreate: Array<{ name: string; values: string[] }>;
  /** Option ids removed but not yet saved. */
  optionsToDelete: string[];

  onNameChange: (optionId: string, name: string) => void;
  onValuesChange: (optionId: string, values: string[]) => void;
  onAddValue: (optionId: string, name: string) => void;
  /** Queue a metaobject entry on a LINKED option. */
  onAddLinkedValue?: (optionId: string, entry: { id: string; name: string }) => void;
  /** Drop a queued metaobject entry again. */
  onRemoveLinkedValue?: (optionId: string, entryId: string) => void;
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

  /**
   * Rendered inside this card, below a divider.
   *
   * The variant-level editor (prices, shipping, stock) goes here: it describes
   * the combinations the options above produce, and it used to sit two cards
   * away from the list that names them.
   */
  footer?: ReactNode;

  t?: Record<string, string | undefined>;
}

export function VariantOptionsEditor({
  productId,
  options,
  primaryOptions,
  valuesToAdd,
  linkedValuesToAdd = {},
  valuesToDelete,
  optionsToCreate,
  optionsToDelete,
  onNameChange,
  onValuesChange,
  onAddValue,
  onAddLinkedValue,
  onRemoveLinkedValue,
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
  footer,
  t = {},
}: VariantOptionsEditorProps) {
  const singleLocaleHint = useSingleLocaleHint();

  /**
   * The same three sensors, with the same constraints, as the image galleries.
   *
   * The mouse distance keeps a CLICK a click: an option card opens on click
   * and a value row's text field takes a caret, and both sit under a drag
   * listener. The touch delay is what lets a finger scroll the page past a
   * value instead of picking it up. And the keyboard sensor is the only way
   * anyone not using a pointer can reorder at all -- the native drag this
   * replaced offered nothing there.
   */
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

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
  /** The dragged value order per option id, or absent while untouched. Local,
   *  because a drag has to feel immediate. */
  const [valueOrder, setValueOrder] = useState<Record<string, string[]>>({});
  /** Which linked option's "add" popover is open. */
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  /**
   * The metaobject entries a linked option could take, per option id.
   *
   * `undefined` = not fetched, `null` = the list could NOT be read. The two
   * are different answers and the picker says so: an empty list rendered for a
   * failed read would tell the merchant their shop has no colours.
   */
  const [choices, setChoices] = useState<
    Record<
      string,
      | {
          entries: Array<{ id: string; displayName: string; color?: string }>;
          truncated: boolean;
          syncedAt: string | null;
        }
      | null
    >
  >({});
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
   * The SWATCHES, as soon as there is a product.
   *
   * Not gated on a card being open, and that is the fix for a real bug:
   * collapsed cards are where the merchant READS the values, so a swatch that
   * only appears once you open the card is missing exactly where it is wanted.
   * The symptom was one lone chip on a collapsed card -- the values whose name
   * the local colour table happens to know -- and the rest arriving on click.
   *
   * It is a cheap query (the options, no variants), which is why it can be
   * afforded on every product open while the counts cannot.
   */
  useEffect(() => {
    if (!productId) return;
    let cancelled = false;
    fetch(`/api/product-option-details?productId=${encodeURIComponent(productId)}`)
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        setSwatches(body?.success ? ((body.swatches ?? {}) as Record<string, OptionValueSwatch>) : {});
      })
      .catch(() => {
        // No swatches is the state the card already handles: the name alone.
        if (!cancelled) setSwatches({});
      });
    return () => { cancelled = true; };
  }, [productId, savedNonce]);

  /**
   * The variant impact, fetched once per product and only when an option is
   * actually opened. It is a 250-variant query -- up to ten pages of it --
   * so putting it on every product open would pay for it on every product
   * nobody edits.
   */
  useEffect(() => {
    if (!openOptionId || impact !== null || !productId) return;

    let cancelled = false;
    fetch(`/api/product-option-details?productId=${encodeURIComponent(productId)}&include=counts`)
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
    setSwatches({});
    setOpenOptionId(null);
    setDraft(null);
    setOrder(null);
    setValueOrder({});
    setPendingConfirm(null);
    setPickerFor(null);
    setChoices({});
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
    setChoices({});
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

  /**
   * Loads the entries a linked option could take, once, when its picker opens.
   *
   * Addressed by ONE of the option's current metaobject GIDs: the cache knows
   * which type a GID belongs to, while the option's `linkedMetafieldKey` is a
   * metafield namespace/key that names the type only by coincidence.
   */
  const loadChoices = useCallback(
    (option: OptionData) => {
      // A FAILED read is retried on the next open: `null` used to be
      // `!== undefined` too, so one dropped request left the picker dead for
      // the rest of the session.
      if (choices[option.id]) return;
      const anchor = option.values.find((v) => v.linkedValue)?.linkedValue;
      if (!anchor) {
        // No GID to ask with. Reported as unreadable, never as "none exist".
        setChoices((prev) => ({ ...prev, [option.id]: null }));
        return;
      }
      fetch(`/api/metaobject-choices?metaobjectId=${encodeURIComponent(anchor)}`)
        .then((r) => r.json())
        .then((body) => {
          setChoices((prev) => ({
            ...prev,
            [option.id]: body?.success
              ? { entries: body.entries ?? [], truncated: body.truncated === true, syncedAt: body.syncedAt ?? null }
              : null,
          }));
        })
        .catch(() => setChoices((prev) => ({ ...prev, [option.id]: null })));
    },
    [choices],
  );

  /** The colour a fetched choice carries, for a chip that is still pending. */
  const choiceColour = (optionId: string, entryId: string) =>
    choices[optionId]?.entries.find((c) => c.id === entryId)?.color;

  /**
   * The picker's body.
   *
   * Three states, and they are deliberately different: still loading, could
   * not be read, and read but nothing left to add. An empty list shown for a
   * failed read would tell the merchant their shop has no colours.
   */
  const renderChoices = (option: OptionData) => {
    // The same answer the chips use — hardcoding `true` here gave one entry a
    // swatch in the picker and none the moment it was queued.
    const isColourOption = looksLikeColourOption(option.name, option.linkedMetafieldKey);
    const list = choices[option.id];
    if (list === undefined) {
      return (
        <Box padding="300">
          <Text as="p" tone="subdued">{t.loading || "Loading…"}</Text>
        </Box>
      );
    }
    if (list === null) {
      return (
        <Box padding="300">
          <Text as="p" tone="subdued">
            {t.choicesUnavailable || "The available entries could not be read."}
          </Text>
        </Box>
      );
    }
    // Already ON the option, or already queued in this session.
    // Values on their way out are NOT taken: a merchant who deleted "Red" and
    // reopens the picker should see Red offered again, or the chip list and
    // the picker contradict each other with no explanation.
    const removed = new Set(valuesToDelete[option.id] ?? []);
    const taken = new Set([
      ...option.values.filter((v) => !removed.has(v.id)).map((v) => v.linkedValue).filter(Boolean),
      ...(linkedValuesToAdd[option.id] ?? []).map((e) => e.id),
    ]);
    const available = list.entries.filter((entry) => !taken.has(entry.id));
    if (available.length === 0) {
      return (
        <Box padding="300">
          <Text as="p" tone="subdued">
            {t.choicesAllUsed || "Every entry of this type is already in use."}
          </Text>
        </Box>
      );
    }
    return (
      <div style={{ maxHeight: "320px", overflowY: "auto" }}>
        {/* The cache's age and its cap, both SAID. A missing entry is
            otherwise indistinguishable from one that does not exist, and the
            merchant goes looking for a bug in the wrong place. */}
        {(list.truncated || list.syncedAt) && (
          <Box padding="200">
            <Text as="p" variant="bodySm" tone="subdued">
              {list.truncated
                ? (t.choicesTruncated || "Only the first entries are shown. Manage the rest in the Shopify admin.")
                : (t.choicesSyncedAt || "Read from the last sync — reload the product if an entry is missing.")}
            </Text>
          </Box>
        )}
        <ActionList
          items={available.map((entry) => ({
            content: entry.displayName,
            prefix: (
              <Swatch
                swatch={resolveSwatch(entry.displayName, { color: entry.color }, { isColourOption })}
              />
            ),
            onAction: () => {
              onAddLinkedValue?.(option.id, { id: entry.id, name: entry.displayName });
              setPickerFor(null);
            },
          }))}
        />
      </div>
    );
  };

  /** The horizontal, wrapping value list. Shopify's arrangement, and the one
   *  that fits how these are read: a handful of short words, not a form. */
  const valueListStyle: CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
    alignItems: "center",
  };
  const valueChipStyle: CSSProperties = {
    width: "var(--app-value-chip-width)",
    maxWidth: "100%",
  };

  /**
   * The value GIDs of one option, in the order shown.
   *
   * Only saved ones: a pending add has no ProductOptionValue GID, so it can
   * neither be given a position nor be addressed by dnd-kit, which needs a
   * stable unique id per sortable item.
   */
  const sortableValueIds = (values: Array<{ id: string }>) =>
    values.filter((v) => v.id).map((v) => v.id);

  /**
   * The name a screen reader reads for one value's drag handle.
   *
   * The VALUE is in it: a list of handles all called "Reorder value" tells a
   * screen reader nothing apart, the same rule the field chrome's bin icons
   * follow. The keyboard sensor moves the row from this control, so this name
   * is the only thing that says which row is about to move.
   */
  const reorderValueLabel = (valueName: string) =>
    (t.reorderValue || "Reorder {value}").replace("{value}", valueName);

  /**
   * A landed value drag, within ONE option.
   *
   * Values never move between options -- each option's list is its own
   * `DndContext`, so `over` can only ever be one of its own values.
   */
  const reorderValues = (option: OptionData, event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = sortableValueIds(valuesOf(option));
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = arrayMove(ids, from, to);
    setValueOrder((prev) => ({ ...prev, [option.id]: next }));
    onReorderValues?.(option.id, next);
  };

  /** A landed option drag. */
  const reorderOptions = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = visible.map((o) => o.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = arrayMove(ids, from, to);
    setOrder(next);
    onReorder(next);
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

  /**
   * "Varianten" is a lie on a product that has none.
   *
   * Most products never get an option: they are one thing at one price, and the
   * card still has to appear because it is where the price, the stock and the
   * shipping settings of that single default variant live -- and where "add a
   * variant" is. Titled "Variants" it named the one thing the card did NOT
   * show, so it reads as its content instead until an option exists.
   *
   * `optionsToCreate` counts -- an option added but not yet saved is already
   * about variants, and a heading that only catches up after the save would
   * flip at a moment that has nothing to do with it. The OPEN draft form does
   * not: while the merchant is still deciding, nothing has been added yet, and
   * a heading that flipped on "add" and back on "cancel" would just twitch.
   */
  const hasVariants = visible.length > 0 || optionsToCreate.length > 0;

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h3" variant="headingMd" fontWeight="bold">
            {(hasVariants ? t.title : t.titleNoVariants || t.title) || "Variants"}
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

        {/* `verticalListSortingStrategy`, and the reason is the OPEN card: the
            option cards are a single column whose rows are nowhere near the
            same height, since one of them is a form several hundred pixels
            tall that stays in the list as a drop target.

            That is an argument FOR this strategy, not against it, and it is
            worth stating because the opposite reads as plausible. Displacing
            every other row by the DRAGGED row's height is exactly right in one
            column: taking a row out and putting it back somewhere else moves
            everything in between by the height of the row that left, whatever
            those rows are themselves. `rectSortingStrategy` -- which the
            values below DO use -- instead assumes each item lands on some
            other item's existing rectangle, which only holds when they tile,
            and it emits a per-item SCALE besides. On [60, 100, 60] cards it
            previews the third row 40px away from where it settles.

            `closestCorners` because a card that tall has its centre nowhere
            near the edge the pointer is actually at. */}
        <DndContext id="variant-options" sensors={sensors} collisionDetection={closestCorners} onDragEnd={reorderOptions}>
        <SortableContext items={visible.map((o) => o.id)} strategy={verticalListSortingStrategy}>
        {visible.map((option) => {
          const isOpen = openOptionId === option.id;
          const values = valuesOf(option);
          // Gates the bare-hex rule only: on a Size option "DDD" is a cup size.
          const isColourOption = looksLikeColourOption(option.name, option.linkedMetafieldKey);

          if (!isOpen) {
            return (
              <SortableItem key={option.id} id={option.id} style={{ cursor: "pointer" }}>
                <Card background="bg-surface-secondary" padding="300">
                  <InlineStack gap="300" blockAlign="start" wrap={false}>
                    {/* The grip, and nothing else, starts the drag: the rest
                        of the card opens the option on click, and it holds the
                        "Metaobject" link. The padding lines the icon up with
                        the option's name -- the stack is top-aligned, since a
                        card with two rows of value chips is much taller. */}
                    <DragHandle
                      label={(t.reorderOption || "Reorder {value}").replace("{value}", nameOf(option))}
                      // A transform, not a padding: the box model here is
                      // already spoken for by the hit area above, and nudging
                      // the icon onto the option name's line must not resize
                      // the target or move the row.
                      style={{ transform: "translateY(2px)" }}
                    />
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
              </SortableItem>
            );
          }

          return (
            // Still a drop target while it is open -- the other cards have to
            // be able to move across it -- but not draggable itself: it is a
            // form, and a drag listener on it would fight every field in it.
            <SortableItem key={option.id} id={option.id} disabled>
              <Card padding="300">
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
                    {/* A linked option's values live in the metaobjects, so
                        they are not editable here -- but their ORDER belongs
                        to the product, not to the metaobjects, and it decides
                        which variant the storefront shows first. So: draggable,
                        not renameable. */}
                    <Text as="p" variant="bodyMd">{t.valuesLabel || "Option values"}</Text>
                    {/* The id is spelled out rather than generated: dnd-kit
                        would otherwise number its contexts from a module-level
                        counter, which a server render and the client hydration
                        do not agree on -- and the handle's `aria-describedby`
                        would then point at drag instructions that are not on
                        the page. */}
                    <DndContext
                      id={`option-values-${option.id}`}
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      onDragEnd={(event) => reorderValues(option, event)}
                    >
                    <div style={valueListStyle}>
                      {/* `rectSortingStrategy` here and not above: the value
                          chips are one fixed width and one line tall, and they
                          WRAP, so this is a grid rather than a column. */}
                      <SortableContext items={sortableValueIds(values)} strategy={rectSortingStrategy}>
                      {values.map((value, index) => {
                        const swatch = resolveSwatch(value.name, swatches[value.id], { isColourOption });
                        const chip = (
                            <Box
                              background="bg-surface-secondary"
                              borderRadius="200"
                              padding="200"
                              borderColor="border"
                              borderWidth="025"
                            >
                              <InlineStack gap="150" blockAlign="center" wrap={false}>
                                <DragHandle label={reorderValueLabel(value.name)} />
                                <Swatch swatch={swatch} />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <Text as="span" variant="bodyMd" truncate>{value.name}</Text>
                                </div>
                                <Button
                                  icon={DeleteIcon}
                                  variant="tertiary"
                                  accessibilityLabel={t.removeValue || "Remove value"}
                                  onClick={() =>
                                    setPendingConfirm({
                                      kind: "value",
                                      optionId: option.id,
                                      valueId: value.id,
                                      body: deleteValueBody(option.name, value.name),
                                    })
                                  }
                                  // Shopify keeps every option on at least one
                                  // value, linked or not.
                                  disabled={values.length <= 1}
                                />
                              </InlineStack>
                            </Box>
                        );
                        return value.id ? (
                          <SortableItem key={value.id} id={value.id} style={valueChipStyle}>{chip}</SortableItem>
                        ) : (
                          <div key={`new-${index}`} style={valueChipStyle}>{chip}</div>
                        );
                      })}
                      </SortableContext>
                    </div>
                    </DndContext>
                    {/* Queued entries: shown before the save, or the
                        merchant's own pick would look like it did not
                        register. They carry no ProductOptionValue GID yet, so
                        they cannot be dragged — only dropped again. */}
                    {(linkedValuesToAdd[option.id] ?? []).length > 0 && (
                      <div style={valueListStyle}>
                        {(linkedValuesToAdd[option.id] ?? []).map((entry) => (
                          <div key={entry.id} style={valueChipStyle}>
                            <Box background="bg-surface-secondary" borderRadius="200" padding="200"
                              borderColor="border" borderWidth="025">
                              <InlineStack gap="150" blockAlign="center" wrap={false}>
                                {/* No SortableItem around it, so this draws the
                                    spacer: an entry with no GID yet cannot be
                                    given a position, and a chip that starts
                                    20px left of the ones above reads as a
                                    rendering fault rather than as "not yet". */}
                                <DragHandle />
                                <Swatch
                                  swatch={resolveSwatch(
                                    entry.name,
                                    { color: choiceColour(option.id, entry.id) },
                                    { isColourOption },
                                  )}
                                />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <Text as="span" variant="bodyMd" truncate>{entry.name}</Text>
                                </div>
                                {/* A dot, not a Badge. Polaris badges are
                                    nowrap and do not shrink, and "Noch nicht
                                    gespeichert" is 135px of unshrinkable
                                    chrome in a 230px chip -- it left about
                                    13px for the name the chip exists to
                                    show. */}
                                <Tooltip content={t.pendingBadge || "Not saved yet"}>
                                  <span
                                    aria-label={t.pendingBadge || "Not saved yet"}
                                    style={{
                                      width: "8px",
                                      height: "8px",
                                      flex: "0 0 auto",
                                      borderRadius: "50%",
                                      background: "var(--p-color-bg-fill-caution)",
                                    }}
                                  />
                                </Tooltip>
                                <Button
                                  icon={DeleteIcon}
                                  variant="tertiary"
                                  accessibilityLabel={t.removeValue || "Remove value"}
                                  onClick={() => onRemoveLinkedValue?.(option.id, entry.id)}
                                />
                              </InlineStack>
                            </Box>
                          </div>
                        ))}
                      </div>
                    )}

                    <InlineStack gap="200" blockAlign="center">
                      {onAddLinkedValue && (
                        <Popover
                          active={pickerFor === option.id}
                          onClose={() => setPickerFor(null)}
                          activator={
                            <Button
                              icon={PlusIcon}
                              onClick={() => {
                                loadChoices(option);
                                setPickerFor(pickerFor === option.id ? null : option.id);
                              }}
                            >
                              {t.addValue || "Add another value"}
                            </Button>
                          }
                        >
                          {renderChoices(option)}
                        </Popover>
                      )}
                      {onOpenMetaobjects && (
                        <Button variant="plain" onClick={() => onOpenMetaobjects(option)}>
                          {t.editMetaobject || "Edit these values"}
                        </Button>
                      )}
                    </InlineStack>
                  </BlockStack>
                ) : (
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd">{t.valuesLabel || "Option values"}</Text>
                    <DndContext
                      id={`option-values-${option.id}`}
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      onDragEnd={(event) => reorderValues(option, event)}
                    >
                    <div style={valueListStyle}>
                    <SortableContext items={sortableValueIds(values)} strategy={rectSortingStrategy}>
                    {values.map((value, index) => {
                      const row = (
                      <InlineStack gap="100" blockAlign="center" wrap={false}>
                        <DragHandle label={reorderValueLabel(value.name)} />
                        <Swatch swatch={resolveSwatch(value.name, swatches[value.id], { isColourOption })} />
                        <div style={{ flex: 1, minWidth: 0 }}>
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
                          variant="tertiary"
                        />
                      </InlineStack>
                      );
                      // Only SAVED values can move: a pending add has no
                      // Shopify id, so there is no position to give it and no
                      // stable id to address it by.
                      return value.id ? (
                        <SortableItem key={value.id} id={value.id} style={valueChipStyle}>{row}</SortableItem>
                      ) : (
                        <div key={`new-${index}`} style={valueChipStyle}>{row}</div>
                      );
                    })}
                    </SortableContext>
                    </div>
                    </DndContext>

                    <InlineStack gap="100" blockAlign="center" wrap={false}>
                      {/* Outside any SortableItem, so this is the spacer the
                          width of a drag handle: the value rows above start
                          with one and this row does not, and without it the add
                          field sits 20px to their left. */}
                      <DragHandle />
                      {/* The same width as a value chip, so the row below them
                          lines up with the row above rather than running 150px
                          past it. */}
                      <div style={{ flex: 1, maxWidth: "var(--app-value-chip-width)" }}>
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
            </SortableItem>
          );
        })}
        </SortableContext>
        </DndContext>

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

        {/* No divider here. `footer &&` is true for an element that RETURNS
            null — which the variant editor does for a shop without the plan,
            while loading, and for a product with no variants — so the card
            ended with a rule under empty space. Only the footer knows whether
            it drew anything, so it draws its own separator. */}
        {footer}
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
