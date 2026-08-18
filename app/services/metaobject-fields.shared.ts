/**
 * What the metaobject editor may do with ONE field of a definition.
 *
 * Client-safe and pure: the field config (`content-fields.config.tsx`), the
 * entry card and the SERVER write path all have to agree on three things, and
 * a second copy of any of them is how a save silently writes the wrong shape.
 *
 * 1. **The compound field key.** The single editor addresses a field by
 *    `<Metaobject GID>#<field key>` (PLAN_METAOBJECTS_EDITOR §6.1). Before
 *    this the key WAS the GID, so one entry could only ever have one editable
 *    field. `#` is collision-free: Shopify field keys are
 *    `[a-z0-9_]`-shaped and a GID contains no `#` either, so the split is at
 *    the FIRST `#` and cannot be ambiguous. The server scan that recognises a
 *    metaobject form field (`key.startsWith("gid://shopify/Metaobject/")`)
 *    keeps working unchanged, which is why the GID stays in front.
 *
 * 2. **Which field types this app can honestly edit.** The list is the same
 *    one the bulk editor and the create form use -- `isEditableMetaobjectFieldType`
 *    in `bulk-editor/columns.shared.ts` is the origin and stays the authority,
 *    so the two cannot drift. Everything outside it gets a ROLE that says what
 *    the UI should do instead: show it read-only (`richText`), give it its own
 *    control (`color`, `file`) or name it as not editable here
 *    (`unsupported`). A field that silently disappears looks like a bug; one
 *    with a reason is an explanation.
 *
 * 3. **Which field types TRANSLATE.** Only the text ones. A colour and a file
 *    reference have exactly one value per shop, so their `translationKey` is
 *    `""` -- `resolve()` short-circuits that to the primary value. Sent down
 *    the foreign chain instead they would resolve to `""`, and a save in a
 *    foreign locale would then CLEAR the colour. That is the same rule the
 *    merchandising attributes follow, for the same reason.
 */

import {
  METAFIELD_TYPE_LIST_SINGLE_LINE,
  METAFIELD_TYPE_MULTI_LINE,
  METAFIELD_TYPE_RICH_TEXT,
  METAFIELD_TYPE_SINGLE_LINE,
  formatListMetafieldValue,
  isEditableMetaobjectFieldType,
  listValueContainsSeparator,
  parseListMetafieldInput,
  richTextPreview,
} from "./bulk-editor/columns.shared";

/** Shopify field type for a colour swatch value (a hex string). */
export const METAOBJECT_TYPE_COLOR = "color";
/** Shopify field type for a single file/image reference (a File GID). */
export const METAOBJECT_TYPE_FILE_REFERENCE = "file_reference";

/**
 * Separates the metaobject GID from the field key in a form field name.
 * NEVER change this without changing the server scan and the tests together.
 */
export const METAOBJECT_FIELD_KEY_SEPARATOR = "#";

/** `<gid>#<fieldKey>` — the editor's field key for one field of one entry. */
export function metaobjectFieldKey(metaobjectId: string, fieldKey: string): string {
  return `${metaobjectId}${METAOBJECT_FIELD_KEY_SEPARATOR}${fieldKey}`;
}

/**
 * Splits `<gid>#<fieldKey>` again.
 *
 * `null` for anything that is not a compound key -- including a BARE metaobject
 * GID, which is what the editor sent before this existed. Callers decide what
 * to do with that; the parser refuses to guess a field key, because guessing
 * the label field would make a save write the wrong field of a real entry.
 */
export function parseMetaobjectFieldKey(
  compound: string,
): { metaobjectId: string; fieldKey: string } | null {
  const at = compound.indexOf(METAOBJECT_FIELD_KEY_SEPARATOR);
  if (at <= 0) return null;
  const metaobjectId = compound.slice(0, at);
  const fieldKey = compound.slice(at + 1);
  if (!metaobjectId || !fieldKey) return null;
  return { metaobjectId, fieldKey };
}

/**
 * What the UI does with a field of this Shopify type.
 *
 * - `text` / `textarea` / `list` — an editable, translatable control
 * - `richText` — shown, never edited: a half rich-text editor that damages the
 *   JSON structure is worse than no editor (§6.5)
 * - `color` / `file` — own control, primary-locale only (Phase 4)
 * - `unsupported` — named with its type, so the merchant sees WHY it is absent
 */
export type MetaobjectFieldRole = "text" | "textarea" | "list" | "richText" | "color" | "file" | "unsupported";

export function metaobjectFieldRole(fieldType: string): MetaobjectFieldRole {
  if (fieldType === METAFIELD_TYPE_SINGLE_LINE) return "text";
  if (fieldType === METAFIELD_TYPE_MULTI_LINE) return "textarea";
  if (fieldType === METAFIELD_TYPE_LIST_SINGLE_LINE) return "list";
  if (fieldType === METAFIELD_TYPE_RICH_TEXT) return "richText";
  if (fieldType === METAOBJECT_TYPE_COLOR) return "color";
  if (fieldType === METAOBJECT_TYPE_FILE_REFERENCE) return "file";
  return "unsupported";
}

/** Fields the editor renders at all (editable or deliberately read-only). */
export function isRenderableMetaobjectFieldType(fieldType: string): boolean {
  return metaobjectFieldRole(fieldType) !== "unsupported";
}

/** Fields the editor may WRITE a primary value for. */
export function isWritableMetaobjectFieldType(fieldType: string): boolean {
  const role = metaobjectFieldRole(fieldType);
  return role === "text" || role === "textarea" || role === "list" || role === "color" || role === "file";
}

/**
 * Fields that carry a per-locale value.
 *
 * Deliberately the SAME set the bulk editor calls editable — colours and file
 * references are writable but have one value per shop, and giving them a
 * translation key is what would clear them on a foreign-locale save.
 */
export function isTranslatableMetaobjectFieldType(fieldType: string): boolean {
  return isEditableMetaobjectFieldType(fieldType);
}

/** The stored value as the editor shows it (list JSON becomes `A | B | C`). */
export function formatMetaobjectFieldValue(fieldType: string, raw: string): string {
  const role = metaobjectFieldRole(fieldType);
  if (role === "list") return formatListMetafieldValue(raw);
  if (role === "richText") return richTextPreview(raw);
  return raw;
}

/**
 * True when a list value cannot survive the display round trip because one of
 * its ENTRIES contains the "|" separator. The bulk editor makes such a cell
 * read-only for the same reason; here it disables the control and says so,
 * rather than shattering the entry on save.
 */
export function metaobjectListValueIsAmbiguous(fieldType: string, raw: string): boolean {
  return metaobjectFieldRole(fieldType) === "list" && listValueContainsSeparator(raw);
}

export type MetaobjectFieldParse =
  | { ok: true; value: string }
  | { ok: false; error: "emptyListEntry" | "invalidColor" | "notWritable" };

/** `#rgb`, `#rrggbb`, `#rrggbbaa` — the SAME shape `resolveSwatch` accepts, so
 *  a value this app writes is a value its own swatch preview can paint. */
export const METAOBJECT_HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * The editor's display value back into what Shopify stores.
 *
 * Runs on BOTH sides: the card validates before enabling save, and the action
 * validates again because it is directly POST-reachable.
 */
export function parseMetaobjectFieldInput(fieldType: string, display: string): MetaobjectFieldParse {
  const role = metaobjectFieldRole(fieldType);
  // "" always means "clear this field" — Shopify's own required-field
  // validation decides whether that is allowed, and its userError is what the
  // merchant sees. Guessing here would refuse edits Shopify accepts.
  if (display === "") return { ok: true, value: "" };
  switch (role) {
    case "text":
    case "textarea":
      return { ok: true, value: display };
    case "list": {
      const parsed = parseListMetafieldInput(display);
      if (!parsed.ok) return { ok: false, error: "emptyListEntry" };
      return { ok: true, value: JSON.stringify(parsed.values) };
    }
    case "color": {
      const trimmed = display.trim();
      // Merchants type "ff0000"; a leading "#" is added rather than refused.
      const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
      if (!METAOBJECT_HEX_PATTERN.test(withHash)) return { ok: false, error: "invalidColor" };
      return { ok: true, value: withHash };
    }
    case "file":
      return { ok: true, value: display.trim() };
    default:
      return { ok: false, error: "notWritable" };
  }
}

// ─── One entry's fields, as the editor renders them ────────────────────────

/** A value on a cached metaobject entry. */
export interface MetaobjectEntryFieldValue {
  key: string;
  value: string | null;
  type?: string;
}

/** The shape the metaobjects page carries for one entry. */
export interface MetaobjectEntryLike {
  id: string;
  handle?: string;
  displayName?: string;
  fields?: MetaobjectEntryFieldValue[];
}

/** A field of a DEFINITION, as `MetaobjectDefinition.fieldDefinitions` stores it. */
export interface MetaobjectDefinitionFieldLike {
  key: string;
  name?: string;
  type?: { name?: string } | string;
  required?: boolean;
}

export function definitionFieldType(def: MetaobjectDefinitionFieldLike): string {
  return typeof def.type === "string" ? def.type : def.type?.name ?? "";
}

/** Everything the card needs about ONE field of ONE entry. */
export interface MetaobjectFieldSpec {
  metaobjectId: string;
  fieldKey: string;
  /** `<gid>#<fieldKey>` — the editor's form field name. */
  compoundKey: string;
  /** The definition's own field name, verbatim (never translated — a
   *  merchant-defined label is theirs, the same rule metafield labels follow). */
  label: string;
  fieldType: string;
  role: MetaobjectFieldRole;
  /** `undefined` = the definition predates the required-flag sync. NOT "optional". */
  required: boolean | undefined;
  /** As Shopify stores it. */
  rawValue: string;
  /** As the editor shows it (a list becomes `A | B | C`). */
  displayValue: string;
}

/**
 * The DEFINITION decides which fields exist and in which order -- an entry's
 * own `fields` array only carries what the last sync happened to see, so
 * building from it would hide a field the merchant has never filled in, which
 * is precisely the field they came here to fill in.
 *
 * Fields present on the ENTRY but not in the definition are appended rather
 * than dropped: that is what a definition changed since the last definition
 * sync looks like, and a value that exists in the shop must not vanish from
 * the screen. With NO definition fields at all (definition not cached yet) the
 * entry's own fields are the whole list.
 */
export function metaobjectFieldSpecs(
  entry: MetaobjectEntryLike,
  definitionFields: MetaobjectDefinitionFieldLike[] | undefined,
): MetaobjectFieldSpec[] {
  const entryFields = entry.fields ?? [];
  const seen = new Set<string>();
  const specs: MetaobjectFieldSpec[] = [];

  const push = (fieldKey: string, label: string, fieldType: string, required: boolean | undefined) => {
    if (!fieldKey || seen.has(fieldKey)) return;
    seen.add(fieldKey);
    const rawValue = entryFields.find((f) => f.key === fieldKey)?.value ?? "";
    specs.push({
      metaobjectId: entry.id,
      fieldKey,
      compoundKey: metaobjectFieldKey(entry.id, fieldKey),
      label: label || fieldKey,
      fieldType,
      role: metaobjectFieldRole(fieldType),
      required,
      rawValue,
      displayValue: formatMetaobjectFieldValue(fieldType, rawValue),
    });
  };

  for (const def of definitionFields ?? []) {
    push(def.key, def.name || def.key, definitionFieldType(def), def.required);
  }
  for (const field of entryFields) {
    push(field.key, field.key, field.type ?? "", undefined);
  }
  return specs;
}

/**
 * One field's PRIMARY value, looked up in a loaded entry list.
 *
 * THE reader for metaobject field values on the client: the field config, the
 * resolve() fallback chain and the "is there a source text to translate?"
 * check all ask this, so a compound key is understood in exactly one place.
 *
 * A bare metaobject GID (what a stale tab sends) falls back to the entry's
 * label field: showing the right text in an old tab costs nothing, while
 * GUESSING the field on the SAVE path would write a real entry — which is why
 * `parseMetaobjectFieldKey` refuses it there and this reader tolerates it here.
 */
export function metaobjectFieldValueFor(
  entries: MetaobjectEntryLike[] | undefined,
  definitionFields: MetaobjectDefinitionFieldLike[] | undefined,
  fieldKey: string,
  isLabelField: (key: string) => boolean,
): string {
  if (!Array.isArray(entries)) return "";
  const parsed = parseMetaobjectFieldKey(fieldKey);

  if (!parsed) {
    const legacy = entries.find((m) => m.id === fieldKey);
    if (!legacy) return "";
    const labelField = legacy.fields?.find((f) => isLabelField(f.key));
    return labelField?.value || legacy.displayName || "";
  }

  const entry = entries.find((m) => m.id === parsed.metaobjectId);
  if (!entry) return "";
  const field = entry.fields?.find((f) => f.key === parsed.fieldKey);
  if (!field) return "";
  const fieldType =
    field.type ||
    (definitionFields ?? []).filter((d) => d.key === parsed.fieldKey).map(definitionFieldType)[0] ||
    "";
  return formatMetaobjectFieldValue(fieldType, field.value ?? "");
}

// ─── Whether this app may WRITE entries of a definition (§7.2) ─────────────

/**
 * Three states, and the third one is the point.
 *
 * `unknown` is what a definition row synced before the `adminAccess` column
 * existed says, and it is NOT "writable" and NOT "read-only" — the same
 * discriminator rule as `attributesSyncedAt`. An unknown definition behaves
 * exactly as it did before this existed: the editor lets the merchant try, and
 * Shopify's own answer decides. Locking on unknown would take the feature away
 * from every shop that has not resynced.
 */
export type MetaobjectWriteAccess = "writable" | "readOnly" | "unknown";

/**
 * Shopify's `MetaobjectAdminAccess`, read as "may this app write here?".
 *
 * `MERCHANT_READ` grants read-only Admin API access and `PRIVATE` restricts a
 * definition to the app that owns it, so neither accepts our `metaobjectUpdate`.
 * Anything else that came back is treated as writable — a value this app has
 * never seen is not evidence of a restriction, and that default is what carried
 * the one value the probe actually found.
 *
 * MEASURED (2026-08-18, live shop, API 2026-07 — PLAN §2.1): all ten of that
 * shop's Shopify STANDARD definitions report **`PUBLIC_READ_WRITE`**, including
 * `shopify--color-pattern`. That is a strong indication that V1 (may a
 * third-party app write entries of a standard definition?) is positive, but it
 * is an indication, not a measurement: only the probe's WRITE test answers it,
 * and if it disagrees with this mapping the probe wins.
 */
export function metaobjectWriteAccess(adminAccess: string | null | undefined): MetaobjectWriteAccess {
  if (adminAccess === null || adminAccess === undefined || adminAccess === "") return "unknown";
  const normalized = adminAccess.toUpperCase();
  if (normalized === "MERCHANT_READ" || normalized === "PRIVATE") return "readOnly";
  // PUBLIC_READ_WRITE and MERCHANT_READ_WRITE both land here, as does anything
  // new — see the note above on why an unknown value is not a restriction.
  return "writable";
}
