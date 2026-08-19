/**
 * The editor for a metaobject field of Shopify type
 * `product_taxonomy_value_reference` (and its `list.` flavour).
 *
 * This is the control that unblocks CREATING an entry of a Shopify standard
 * definition: `shopify--color-pattern` and nine siblings on a live shop have
 * such a field marked REQUIRED, so without an editor for it the create form
 * could only ever produce a rejection.
 *
 * Four things are load-bearing.
 *
 * 1. **It speaks GIDs and shows NAMES.** The stored value is
 *    `gid://shopify/TaxonomyValue/11`; nobody can pick that. The names come
 *    from `/api/metaobject-taxonomy`, which resolves them SERVER-side out of
 *    the definition's own validations -- the client never names an attribute.
 * 2. **The list is fetched ONCE per (type, field), not once per entry.** A page
 *    of 25 colour entries renders 25 of these controls, all wanting the same 19
 *    values; a naive fetch-on-mount would be 25 identical requests, each paying
 *    the category sweep. The promise is shared at module scope.
 * 3. **A value that is not in the offered list stays VISIBLE.** It can happen
 *    (the definition changed, or the attribute was matched wrongly) and the one
 *    thing that must not follow is the control rendering empty -- the next save
 *    would then clear a value nobody meant to touch. It is shown as a chip with
 *    its resolved name, or with its bare id when even that fails.
 * 4. **A failed lookup is not an empty list.** `known: false` renders an
 *    explanation and a deep link into the Shopify admin, which is exactly the
 *    §5 fallback of PLAN_METAOBJECT_TAXONOMY_CREATE -- built rather than left
 *    out, because a picker offering nothing looks like the field has no values.
 *
 * Read-only outside the primary locale, like the colour and file controls: a
 * taxonomy reference points into Shopify's GLOBAL taxonomy and has one value
 * per shop, not one per language.
 *
 * TWO exports, one implementation. `TaxonomyValuePicker` is the control and
 * knows nothing about the editor; `TaxonomyValueField` adapts the editor's
 * `FieldRenderProps` onto it. The CREATE modal renders the picker directly --
 * its fields are `CreateFieldDef`s, a different shape entirely, and a second
 * picker there is how the form and the editor would come to write different
 * bytes into the same field.
 */

import { useEffect, useMemo, useState } from "react";
import { Banner, BlockStack, InlineStack, Link, Select, Spinner, Tag, Text } from "@shopify/polaris";
import { ChipCombobox, type ChipOption } from "../unified/ChipCombobox";
import { FieldLabel } from "../unified/FieldChrome";
import {
  parseMetaobjectTaxonomyValues,
  serializeMetaobjectTaxonomyValues,
} from "~/services/metaobject-fields.shared";
import type { FieldRenderProps } from "~/types/content-editor.types";

interface TaxonomyPayload {
  success: boolean;
  error?: string;
  field?: { key: string; type: string; isList: boolean; handle: string | null; min: number | null; max: number | null };
  values?:
    | { known: true; attributeName: string; values: Array<{ id: string; name: string }>; truncated: boolean }
    | { known: false; reason: "attributeNotFound" | "lookupFailed"; detail?: string };
  names?: Record<string, string>;
}

/**
 * One in-flight request per (type, field) for the whole page.
 *
 * Module scope rather than a hook cache: the controls are siblings under the
 * editor and share no state, so anything narrower would still fan out. The
 * entry is kept after it resolves, which also makes switching entry pages free.
 */
const listRequests = new Map<string, Promise<TaxonomyPayload>>();

/** Exposed so a test can start from a clean slate; a memo that survives
 *  between tests hides a request that was never made. */
export function clearTaxonomyFieldCache(): void {
  listRequests.clear();
  nameCache.clear();
  nameRequests.clear();
}

function fetchList(type: string, fieldKey: string): Promise<TaxonomyPayload> {
  const key = `${type}|${fieldKey}`;
  const existing = listRequests.get(key);
  if (existing) return existing;
  const request = fetch(
    `/api/metaobject-taxonomy?type=${encodeURIComponent(type)}&field=${encodeURIComponent(fieldKey)}`,
  )
    .then((res) => res.json() as Promise<TaxonomyPayload>)
    .catch((error) => ({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }))
    .then((payload: TaxonomyPayload) => {
      // Only a SUCCESSFUL answer is remembered. A 403 mid-upgrade, a 500 from
      // the definition lookup or a dropped connection all resolve to a payload
      // rather than throwing, and caching one would keep every control on
      // every entry page saying "could not be read" until a hard reload --
      // this is a single-page app, so navigating away does not clear it. The
      // SERVER refuses to memoise its own failures for the same reason; a
      // client cache that does undoes that.
      if (!payload.success) listRequests.delete(key);
      return payload;
    });
  listRequests.set(key, request);
  return request;
}

/**
 * Resolved names, shared across every control on the page.
 *
 * The per-control version fired exactly when the LIST failed -- 25 entries
 * whose stored ids nothing could explain meant 25 requests. With `mode=names`
 * the server no longer sweeps for them, and this keeps even those 25 down to
 * one request per distinct set of ids.
 */
const nameCache = new Map<string, string>();
const nameRequests = new Map<string, Promise<Record<string, string>>>();

/** Names for stored ids the offered list does not contain. Per control,
 *  because the ids are the entry's own -- and rare, because a stored value is
 *  normally in the list. */
async function fetchNames(type: string, fieldKey: string, ids: string[]): Promise<Record<string, string>> {
  const wanted = ids.filter((id) => !nameCache.has(id));
  const known: Record<string, string> = {};
  for (const id of ids) {
    const name = nameCache.get(id);
    if (name) known[id] = name;
  }
  if (wanted.length === 0) return known;

  const key = `${type}|${fieldKey}|${[...wanted].sort().join(",")}`;
  const existing = nameRequests.get(key);
  const request =
    existing ??
    fetch(
      `/api/metaobject-taxonomy?mode=names&type=${encodeURIComponent(type)}&field=${encodeURIComponent(
        fieldKey,
      )}&ids=${encodeURIComponent(wanted.join(","))}`,
    )
      .then((res) => res.json() as Promise<TaxonomyPayload>)
      .then((payload) => {
        const names = payload.names ?? {};
        for (const [id, name] of Object.entries(names)) nameCache.set(id, name);
        return names;
      })
      .catch(() => ({} as Record<string, string>))
      .finally(() => {
        // Never kept: an empty answer is indistinguishable from a failed one
        // here, and remembering it would stop a later attempt from resolving a
        // name the first request missed.
        nameRequests.delete(key);
      });
  if (!existing) nameRequests.set(key, request);
  return { ...known, ...(await request) };
}

export interface TaxonomyValuePickerProps {
  label: string;
  /** The stored form: a JSON array of GIDs, or a bare GID. */
  value: string;
  onChange: (next: string) => void;
  /** The metaobject DEFINITION type (`shopify--color-pattern`). */
  metaobjectType: string;
  /** The definition's own field key, without the entry GID in front. */
  taxonomyFieldKey: string;
  /** Shopify's field type, which decides list vs. single serialisation. */
  fieldType: string;
  /** From the definition's validations. `null` = the definition names no
   *  attribute, which is a REASON to show and not an empty picker. */
  attributeHandle: string | null;
  isList: boolean;
  min: number | null;
  max: number | null;
  readOnly?: boolean;
  /** Why it is locked, when it is. The editor has two different reasons and
   *  the create form has none, so the sentence comes from the host. */
  readOnlyReason?: string;
  /** A validation message from the host (the create modal's field errors). */
  error?: string;
  content?: Record<string, string>;
}

export function TaxonomyValuePicker({
  label,
  value,
  onChange,
  metaobjectType,
  taxonomyFieldKey,
  fieldType,
  attributeHandle,
  isList,
  min,
  max,
  readOnly = false,
  readOnlyReason,
  error,
  content = {},
}: TaxonomyValuePickerProps) {

  const [payload, setPayload] = useState<TaxonomyPayload | null>(null);
  const [extraNames, setExtraNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const selected = useMemo(
    () => parseMetaobjectTaxonomyValues(fieldType, value),
    [fieldType, value],
  );

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchList(metaobjectType, taxonomyFieldKey).then((result) => {
      if (!alive) return;
      setPayload(result);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [metaobjectType, taxonomyFieldKey]);

  const offered = useMemo(() => {
    const list = payload?.values?.known ? payload.values.values : [];
    return new Map(list.map((v) => [v.id, v.name]));
  }, [payload]);

  // Only the ids the list does NOT explain need a second request. Normally
  // none, which is why the list request carries no ids of its own.
  const unknownIds = useMemo(
    () => selected.filter((id) => !offered.has(id) && !extraNames[id]),
    [selected, offered, extraNames],
  );

  useEffect(() => {
    if (loading || unknownIds.length === 0) return;
    let alive = true;
    fetchNames(metaobjectType, taxonomyFieldKey, unknownIds).then((names) => {
      if (alive && Object.keys(names).length > 0) setExtraNames((prev) => ({ ...prev, ...names }));
    });
    return () => {
      alive = false;
    };
    // `unknownIds` is derived and stable by content; joining it keeps the
    // effect from re-firing on every render for the same set of ids.
  }, [loading, metaobjectType, taxonomyFieldKey, unknownIds.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const nameOf = (id: string): string => offered.get(id) ?? extraNames[id] ?? id;

  const commit = (ids: string[]) => onChange(serializeMetaobjectTaxonomyValues(fieldType, ids));

  const listUnavailable = payload && payload.success && payload.values && !payload.values.known;
  const requestFailed = payload && !payload.success;
  // The ROUTE reads the handle out of the cached definition; the prop is only
  // what the host happened to know. The create modal has no validations on the
  // client at all and passes `null`, which without this made it say "this field
  // names no taxonomy attribute" about a field that names `color` -- a
  // different, and false, sentence for the same payload the editor explains
  // correctly.
  const effectiveHandle = payload?.field?.handle ?? attributeHandle;

  /** Shopify's own editor for this definition — the honest way out when the
   *  values cannot be offered here. Not a dead end, and not a fake picker. */
  const adminLink = (
    <Link url={`shopify://admin/content/entries/${encodeURIComponent(metaobjectType)}`} target="_blank">
      {content.metaobjectEntryOpenInAdmin || "Edit in the Shopify admin"}
    </Link>
  );

  const boundsHint = isList
    ? [
        min !== null ? (content.metaobjectTaxonomyMin || "at least {n}").replace("{n}", String(min)) : null,
        max !== null ? (content.metaobjectTaxonomyMax || "at most {n}").replace("{n}", String(max)) : null,
      ]
        .filter(Boolean)
        .join(", ")
    : undefined;

  if (loading) {
    return (
      <BlockStack gap="150">
        <FieldLabel label={label} />
        <InlineStack gap="200" blockAlign="center">
          <Spinner size="small" />
          <Text as="span" variant="bodySm" tone="subdued">
            {content.metaobjectTaxonomyLoading || "Loading the permitted values…"}
          </Text>
        </InlineStack>
      </BlockStack>
    );
  }

  // No list. The stored value is still SHOWN — clearing it is the one outcome
  // that would lose data, and it is exactly what an empty control invites.
  if (listUnavailable || requestFailed) {
    const reason =
      requestFailed || (payload?.values && !payload.values.known && payload.values.reason === "lookupFailed")
        ? content.metaobjectTaxonomyLookupFailed ||
          "The permitted values could not be read from Shopify just now."
        : effectiveHandle
          ? (content.metaobjectTaxonomyAttributeMissing ||
              'No taxonomy attribute called "{handle}" was found for this field.').replace(
              "{handle}",
              effectiveHandle,
            )
          : content.metaobjectTaxonomyNoHandle ||
            "This field does not name a taxonomy attribute, so its values cannot be listed here.";
    return (
      <BlockStack gap="150">
        <FieldLabel label={label} />
        {selected.length > 0 && (
          <InlineStack gap="100" wrap>
            {selected.map((id) => (
              <Tag key={id}>{nameOf(id)}</Tag>
            ))}
          </InlineStack>
        )}
        <Banner tone="warning">
          <BlockStack gap="100">
            <Text as="p" variant="bodySm">{reason}</Text>
            <Text as="p" variant="bodySm">{adminLink}</Text>
          </BlockStack>
        </Banner>
      </BlockStack>
    );
  }

  const values = payload?.values?.known ? payload.values.values : [];
  // Reported, never swallowed: a capped list shown as the whole one makes a
  // value that exists simply absent, with no explanation.
  const truncated = payload?.values?.known ? payload.values.truncated : false;

  if (!isList) {
    // A single reference is a plain Select: 19 or 51 options, measured, and a
    // browser's own type-ahead is better than anything built here.
    const current = selected[0] ?? "";
    const options = [
      { value: "", label: content.metaobjectTaxonomyNone || "—" },
      ...values.map((v) => ({ value: v.id, label: v.name })),
      // A stored value outside the list keeps its own option, or selecting it
      // would be impossible and the Select would silently show "—".
      ...(current && !offered.has(current) ? [{ value: current, label: nameOf(current) }] : []),
    ];
    return (
      <BlockStack gap="150">
        <Select
          label={<FieldLabel label={label} />}
          options={options}
          value={current}
          disabled={readOnly}
          onChange={(next) => commit(next ? [next] : [])}
          error={error}
          helpText={readOnly ? readOnlyReason : undefined}
        />
        {truncated && (
          <Text as="span" variant="bodySm" tone="subdued">
            {content.metaobjectTaxonomyTruncated ||
              "Only the first values are listed — there may be more."}
          </Text>
        )}
      </BlockStack>
    );
  }

  const atMax = max !== null && selected.length >= max;
  const chipOptions: ChipOption[] = [
    ...values.map((v) => ({
      value: v.id,
      label: v.name,
      // At the cap every UNCHOSEN option is locked WITH ITS REASON rather than
      // filtered away: a click that does nothing and says nothing is the
      // failure this borrows ChipCombobox's lock mechanism to avoid.
      lockedReason:
        atMax && !selected.includes(v.id)
          ? (content.metaobjectTaxonomyMaxReached || "At most {n} values").replace("{n}", String(max))
          : undefined,
    })),
    // Stored-but-not-offered values get an option too, so their chip shows a
    // name and stays removable.
    ...selected
      .filter((id) => !offered.has(id))
      .map((id) => ({ value: id, label: nameOf(id) })),
  ];

  const belowMin = min !== null && selected.length < min;

  return (
    <BlockStack gap="150">
      <ChipCombobox
        label={label}
        selected={selected}
        options={chipOptions}
        onChange={(next) => {
          // Enforced here as well as in the lock: the lock covers the listbox,
          // and this covers everything else that can reach onChange. A REMOVAL
          // is always allowed, even while over the cap -- an entry can already
          // hold more values than `list.max` (written by Shopify's own editor,
          // or before the bound was lowered), and refusing the shrink would
          // leave the merchant unable to get back under it from this app,
          // clicking an × that does nothing and says nothing.
          if (max !== null && next.length > max && next.length > selected.length) return;
          commit(next);
        }}
        readOnly={readOnly}
        allowFreeText={false}
        // The list is closed and MEASURED small (19 colours), so it is shown
        // rather than hidden behind a guessed substring — see `suggestAtRest`.
        suggestAtRest
        placeholder={content.metaobjectTaxonomySearch || "Search or pick a value…"}
        helpText={boundsHint}
        emptyText={content.metaobjectTaxonomyEmpty || "No values selected."}
      />
      {belowMin && !readOnly && (
        <Text as="span" variant="bodySm" tone="critical">
          {(content.metaobjectTaxonomyBelowMin || "Select at least {n} value(s).").replace("{n}", String(min))}
        </Text>
      )}
      {truncated && (
        <Text as="span" variant="bodySm" tone="subdued">
          {content.metaobjectTaxonomyTruncated ||
            "Only the first values are listed — there may be more."}
        </Text>
      )}
      {error && (
        <Text as="span" variant="bodySm" tone="critical">{error}</Text>
      )}
      {readOnly && readOnlyReason && (
        <Text as="span" variant="bodySm" tone="subdued">{readOnlyReason}</Text>
      )}
    </BlockStack>
  );
}

/**
 * The editor's adapter: `FieldRenderProps` onto the picker above.
 *
 * The only thing it decides is the LOCK and its sentence, and it has two
 * independent reasons for one -- a foreign locale (a taxonomy reference points
 * into Shopify's global taxonomy and has one value per shop) and the editor's
 * own §7.2 verdict. Either is enough, and they need different words: "exists
 * once per shop" is true of the first and false of the second, where the field
 * is not writable at all.
 */
interface TaxonomyValueFieldProps extends FieldRenderProps {
  metaobjectType: string;
  taxonomyFieldKey: string;
  fieldType: string;
  attributeHandle: string | null;
  isList: boolean;
  min: number | null;
  max: number | null;
}

export function TaxonomyValueField({
  field,
  value,
  onChange,
  isPrimaryLocale = true,
  readOnly: editorReadOnly = false,
  metaobjectType,
  taxonomyFieldKey,
  fieldType,
  attributeHandle,
  isList,
  min,
  max,
  t,
}: TaxonomyValueFieldProps) {
  const content = (t as { content?: Record<string, string> } | undefined)?.content ?? {};
  const readOnly = !isPrimaryLocale || editorReadOnly;
  return (
    <TaxonomyValuePicker
      label={field.label}
      value={value}
      onChange={onChange}
      metaobjectType={metaobjectType}
      taxonomyFieldKey={taxonomyFieldKey}
      fieldType={fieldType}
      attributeHandle={attributeHandle}
      isList={isList}
      min={min}
      max={max}
      readOnly={readOnly}
      readOnlyReason={
        !isPrimaryLocale
          ? content.attributesForeignLocale || "This value exists once per shop, not per language."
          : content.metaobjectEntryReadOnlyDefinition ||
            "This app cannot change entries of this definition."
      }
      content={content}
    />
  );
}
