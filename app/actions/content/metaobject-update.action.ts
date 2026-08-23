/**
 * The metaobject branch of `updateContent`.
 *
 * It lives in its own module because the entry editor addresses fields
 * differently from every other content type: a form field key here is
 * `<Metaobject GID>#<field key>` (PLAN_METAOBJECTS_EDITOR §6.1), so one save
 * can carry several fields of several entries. It is still reached ONLY
 * through `handleUnifiedContentActions` -- this is a helper of the one handler,
 * not a second one.
 *
 * Four things changed with Phase 3 and each of them was a real defect:
 *
 * - **Every field, not just the label.** The old branch looked up the label
 *   field of each entry and wrote that one. A definition's colour, description
 *   or list field had no way in at all.
 * - **The echo decides** (B4). `translationsRegister` was judged by
 *   `userErrors` alone and the `MetaobjectTranslation` row was written
 *   regardless -- the exact silent-no-op CLAUDE.md names. Registering now goes
 *   through `registerAndVerify` and removing through `removeAndVerify`; an
 *   unconfirmed REMOVAL keeps the local row on purpose, because deleting it
 *   would make the app disagree with a shop that still has the translation.
 * - **`MetaobjectTranslation.type` is the bare type** (B5). It used to be set
 *   to `itemId`, which on this page is `metaobject_type_<type>`. The sync's
 *   definition stale-delete removes rows whose `type` is not a live type --
 *   that is, exactly those rows. It was masked only because the same sync run
 *   re-created them from Shopify while the key was always a label field; with
 *   arbitrary field keys the mask is gone. Rows already written wrong are
 *   repaired on the next write of the same entry.
 * - **An empty PRIMARY value is only refused for the label field** (§6.4). An
 *   entry with no display name is unfindable, so that one stays blocked; for
 *   every other field "" legitimately clears the value and Shopify's own
 *   required-field validation is what refuses it, visibly, per field.
 *
 * Failures are per FIELD, never per card -- the same rule as `BulkFailure.columnId`.
 */

import { data as json } from "react-router";
import { logger } from "../../utils/logger.server";
import { getFormString } from "../../utils/form-data.utils";
import { safeJsonParse } from "../../utils/validation";
import { isMetaobjectLabelField } from "../../constants/shopifyFields";
import type { ContentActionHandlerContext } from "./alt-text.action";
import type { DataResponse } from "~/types/data-response";
import {
  formatMetaobjectFieldValue,
  isTranslatableMetaobjectFieldType,
  metaobjectFieldRole,
  metaobjectListValueIsAmbiguous,
  isWritableMetaobjectFieldType,
  parseMetaobjectFieldInput,
  parseMetaobjectTaxonomyValues,
  taxonomyValueBounds,
  parseMetaobjectFieldKey,
} from "~/services/metaobject-fields.shared";
import { writeMetaobjectFields, type MetaobjectFieldWrite } from "~/services/metaobject-write.server";
import type { MetaobjectFieldDefinition } from "~/config/create-fields.config";

/** The GID prefix that marks a form field as belonging to a metaobject. */
const METAOBJECT_GID_PREFIX = "gid://shopify/Metaobject/";

interface SubmittedField {
  compoundKey: string;
  metaobjectId: string;
  fieldKey: string;
  /** The DISPLAY value as the editor sent it (a list is still `A | B | C`). */
  value: string;
}

interface CachedEntry {
  id: string;
  type: string;
  fields: Array<{ key: string; value: string | null; type?: string }>;
}

/**
 * `list.min` / `list.max` for a taxonomy reference, or `null` when they hold.
 *
 * Read from the definition's validations, never hardcoded. A field with no
 * cached definition has no validations and therefore no bounds -- unknown
 * bounds are not a refusal, the same rule every other "we cannot tell" in this
 * codebase follows.
 */
function taxonomyBoundsError(
  fieldType: string,
  storedValue: string,
  validations: Array<{ name: string; value?: string | null }> | undefined,
): string | null {
  if (metaobjectFieldRole(fieldType) !== "taxonomyValue") return null;
  // An empty value is a CLEAR; Shopify's required-field validation decides.
  if (storedValue === "") return null;
  const { min, max } = taxonomyValueBounds(fieldType, validations);
  const count = parseMetaobjectTaxonomyValues(fieldType, storedValue).length;
  if (max !== null && count > max) return `at most ${max} value(s) allowed, got ${count}.`;
  if (min !== null && count < min) return `at least ${min} value(s) required, got ${count}.`;
  return null;
}

function fieldTypeOf(
  fieldKey: string,
  entry: CachedEntry,
  definitionFields: MetaobjectFieldDefinition[],
): string {
  const fromDefinition = definitionFields.find((f) => f.key === fieldKey);
  if (fromDefinition) {
    return typeof fromDefinition.type === "string" ? fromDefinition.type : fromDefinition.type?.name ?? "";
  }
  // Definition not cached (or the field was added after the last sync): the
  // entry's own field carries its type. Unknown stays unknown -- an empty
  // string maps to the `unsupported` role, which refuses the write rather than
  // guessing "text" and sending a list value as a bare string.
  return entry.fields.find((f) => f.key === fieldKey)?.type ?? "";
}

export async function handleMetaobjectUpdate(
  ctx: ContentActionHandlerContext,
  formData: FormData,
  scope: { locale: string; primaryLocale: string; marketId: string },
): Promise<DataResponse> {
  const { admin, session, db } = ctx;
  const { locale, primaryLocale, marketId } = scope;

  // ── 1. Collect the submitted fields ─────────────────────────────────────
  const submitted: SubmittedField[] = [];
  const errors: string[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith(METAOBJECT_GID_PREFIX)) continue;
    const parsed = parseMetaobjectFieldKey(key);
    if (!parsed) {
      // A BARE metaobject GID -- what the editor sent before Phase 3. Guessing
      // the label field here would write a real entry from a stale client, so
      // it is refused by name instead.
      errors.push(`Unrecognised metaobject field key "${key}" — reload the page.`);
      continue;
    }
    submitted.push({ compoundKey: key, metaobjectId: parsed.metaobjectId, fieldKey: parsed.fieldKey, value: String(value) });
  }

  if (submitted.length === 0) {
    return errors.length > 0
      ? json({ success: false, error: errors.join("; "), actionType: "updateContent" }, { status: 400 })
      : json({ success: true, actionType: "updateContent" });
  }

  // On a primary-locale save the client sends ALL fields (buildFieldsForSave
  // only filters for foreign locales); `changedFields` names the ones that
  // actually changed. Restricting to those is what keeps an unrelated edit
  // from re-writing and re-invalidating every entry on the page. Foreign saves
  // already send only changed fields and omit the list; flows that omit it
  // deliberately (accept-and-translate) fall through to the per-field
  // value comparison below.
  const changedFieldsStr = getFormString(formData, "changedFields");
  const changedKeys = changedFieldsStr ? safeJsonParse<string[]>(changedFieldsStr, []) : null;
  const toProcess =
    locale === primaryLocale && changedKeys && changedKeys.length > 0
      ? submitted.filter((s) => changedKeys.includes(s.compoundKey))
      : submitted;

  if (toProcess.length === 0) {
    return json({ success: true, actionType: "updateContent" });
  }

  // ── 2. Resolve the cache rows (tenancy) and the definitions ─────────────
  const entryIds = [...new Set(toProcess.map((s) => s.metaobjectId))];
  const cachedRows = await db.metaobject.findMany({
    where: { shop: session.shop, id: { in: entryIds } },
    select: { id: true, type: true, fields: true },
  });
  const entries = new Map<string, CachedEntry>(
    cachedRows.map((row) => [
      row.id,
      {
        id: row.id,
        type: row.type,
        fields: Array.isArray(row.fields) ? (row.fields as CachedEntry["fields"]) : [],
      },
    ]),
  );
  const missing = entryIds.filter((id) => !entries.has(id));
  for (const id of missing) {
    errors.push(`${id}: not in the local cache — resync this metaobject type first.`);
  }

  const types = [...new Set([...entries.values()].map((e) => e.type))];
  const definitionRows = await db.metaobjectDefinition.findMany({
    where: { shop: session.shop, type: { in: types } },
    select: { type: true, fieldDefinitions: true },
  });
  const definitions = new Map<string, MetaobjectFieldDefinition[]>(
    definitionRows.map((row) => [
      row.type,
      (Array.isArray(row.fieldDefinitions) ? row.fieldDefinitions : []) as unknown as MetaobjectFieldDefinition[],
    ]),
  );

  const { ShopifyApiGateway } = await import("~/services/shopify-api-gateway.service");
  const gateway = new ShopifyApiGateway(admin, session.shop);

  /** Filled by the same lookup as `foreignLocalesCache` — the language the
   *  primary values are written in, which the re-translation has to name. */
  let primaryLocaleCache = "";
  // Declared BEFORE the dispatch below: savePrimary() -> invalidateForeign() ->
  // getForeignLocales() reads it, and a `let` further down would still be in
  // its temporal dead zone at that point.
  let foreignLocalesCache: string[] | null = null;

  const written = locale === primaryLocale
    ? await savePrimary()
    : await saveForeign();

  if (errors.length > 0) {
    logger.error("[UnifiedContent] Metaobject update errors", { context: "Metaobjects", errors });
    return json(
      { success: false, error: `Some updates failed: ${errors.join("; ")}`, actionType: "updateContent" },
      { status: 500 },
    );
  }

  logger.info("[UnifiedContent] Metaobjects updated successfully", {
    context: "Metaobjects",
    fields: written,
    locale,
  });
  return json({ success: true, actionType: "updateContent" });

  // ── 3a. Primary locale: the entry's own field values ────────────────────
  async function savePrimary(): Promise<number> {
    let confirmedTotal = 0;
    const byEntry = new Map<string, SubmittedField[]>();
    for (const field of toProcess) {
      if (!entries.has(field.metaobjectId)) continue;
      const list = byEntry.get(field.metaobjectId) ?? [];
      list.push(field);
      byEntry.set(field.metaobjectId, list);
    }

    for (const [metaobjectId, fields] of byEntry) {
      const entry = entries.get(metaobjectId)!;
      const definitionFields = definitions.get(entry.type) ?? [];
      const writes: MetaobjectFieldWrite[] = [];
      const translatableConfirmedKeys: string[] = [];

      for (const field of fields) {
        const fieldType = fieldTypeOf(field.fieldKey, entry, definitionFields);
        // A rich-text field is rendered READ-ONLY and as a plain-text preview,
        // so the form echoes that preview back on every primary save. Skipping
        // it silently is the correct reading of "the client sends every field
        // in the primary locale" -- erroring would make every save on a
        // definition that HAS a rich-text field report a failure, and writing
        // it would replace Shopify's JSON document with its own preview text.
        if (metaobjectFieldRole(fieldType) === "richText") continue;
        if (!isWritableMetaobjectFieldType(fieldType)) {
          // Anything else that cannot be written is a field the editor never
          // rendered a control for -- so its arrival means the definition
          // cache is stale, which the merchant has to be told about.
          errors.push(`${field.fieldKey}: fields of type "${fieldType || "unknown"}" cannot be edited here.`);
          continue;
        }
        // §6.4 — an entry with no display name is unfindable, so clearing the
        // LABEL is refused. Every other field may legitimately be emptied;
        // Shopify's required-field validation answers with a userError that
        // reaches the merchant per field.
        if (field.value.trim() === "" && isMetaobjectLabelField(field.fieldKey)) {
          errors.push(`${field.fieldKey}: the display name cannot be empty.`);
          continue;
        }
        const stored = entry.fields.find((f) => f.key === field.fieldKey)?.value ?? "";
        // Safety net for flows that omit `changedFields` (accept-and-translate):
        // an unchanged value must not re-write and must not invalidate the
        // entry's foreign translations.
        //
        // The comparison is on the DISPLAY form, not the stored one. A list is
        // shown as `A | B | C` and stored as JSON, so a value that came back
        // exactly as it was sent down can still fail to round-trip -- and then
        // an untouched field would be "changed" and written in its damaged
        // form. What the editor showed against what it sent back is the only
        // comparison that answers "did the merchant touch this".
        if (formatMetaobjectFieldValue(fieldType, stored) === field.value) continue;

        // A list ENTRY that itself contains the separator cannot survive the
        // join/split round trip: editing it would shatter one entry into
        // several. The bulk editor makes such a cell read-only for the same
        // reason; here the write is refused with the reason, which is the only
        // honest answer once the merchant HAS changed something.
        //
        // CLEARING is exempt: "" is not split, so it cannot shatter anything,
        // and refusing it would leave such a field permanently unremovable.
        if (field.value !== "" && metaobjectListValueIsAmbiguous(fieldType, stored)) {
          errors.push(
            `${field.fieldKey}: one of the list values contains "|", which this editor uses to separate them. Edit this field in the Shopify admin.`,
          );
          continue;
        }

        const parsed = parseMetaobjectFieldInput(fieldType, field.value);
        if (!parsed.ok) {
          errors.push(
            parsed.error === "invalidColor"
              ? `${field.fieldKey}: "${field.value}" is not a valid hex colour.`
              : parsed.error === "emptyListEntry"
                ? `${field.fieldKey}: list values must not be empty — separate them with | and remove empty entries.`
                : parsed.error === "invalidTaxonomyValue"
                  // Refused HERE rather than forwarded: a value that is not a
                  // TaxonomyValue GID fails at the GraphQL SCHEMA level, which
                  // returns a top-level `errors` array with `data: null` and
                  // never reaches `userErrors` — so a forwarded bad value makes
                  // the whole save read as a success while nothing was written.
                  ? `${field.fieldKey}: this must be a Shopify taxonomy value, not "${field.value}".`
                  : `${field.fieldKey}: this field cannot be written from here.`,
          );
          continue;
        }
        // The list bounds, on the UPDATE path too. `parseMetaobjectFieldInput`
        // only checks the GID SHAPE, and the create path validates the bounds
        // server-side -- this action takes a direct POST as well, so leaving
        // them to the client would make the two write paths disagree about
        // what a valid entry is. A bad bound does come back as a Shopify
        // userError rather than a silent success, which is why this is a
        // symmetry fix and not a data-loss one.
        const boundsError = taxonomyBoundsError(
          fieldType,
          parsed.value,
          definitionFields.find((f) => f.key === field.fieldKey)?.validations,
        );
        if (boundsError) {
          errors.push(`${field.fieldKey}: ${boundsError}`);
          continue;
        }
        if (stored === parsed.value) continue;
        writes.push({ ref: field.compoundKey, key: field.fieldKey, value: parsed.value });
        if (isTranslatableMetaobjectFieldType(fieldType)) translatableConfirmedKeys.push(field.fieldKey);
      }

      if (writes.length === 0) continue;

      const result = await writeMetaobjectFields({ gateway, db, shop: session.shop, id: metaobjectId, writes });
      for (const failure of result.failures) {
        errors.push(`${failure.ref.split("#").slice(1).join("#") || failure.ref}: ${failure.message}`);
      }
      confirmedTotal += result.confirmedRefs.length;

      // The primary value changed, so every foreign translation of THAT field
      // is stale. Removed on Shopify first and locally only for the (locale,
      // key) pairs Shopify confirmed — an unconfirmed removal keeps the row.
      const staleKeys = result.confirmedKeys.filter((key) => translatableConfirmedKeys.includes(key));
      if (staleKeys.length > 0) {
        await invalidateForeign(metaobjectId, staleKeys);
      }
    }
    return confirmedTotal;
  }

  /**
   * Echo-verified removal of the now-stale GLOBAL foreign translations.
   *
   * Whether this happens at all is a merchant switch (Settings →
   * Übersetzungen) — the same question every other purge site in this app
   * asks, through the same module, which fails OPEN so a lookup error keeps
   * the historic behaviour.
   */
  async function invalidateForeign(metaobjectId: string, keys: string[]): Promise<void> {
    try {
      const { loadTranslationChangePolicy } = await import(
        "~/services/translations/translation-change-policy.server"
      );
      const policy = await loadTranslationChangePolicy(session.shop, db);
      const foreignLocales = await getForeignLocales();
      if (foreignLocales.length === 0) return;

      // With auto-translate on, THIS save is the repair: a metaobject field is
      // outside every sync and every webhook in this app, so nothing else would
      // ever refresh the row — which is precisely why the deletion used to
      // stand regardless of the switch. Now that the save can replace the text,
      // the merchant's "translate it again" answer applies here too.
      if (policy.autoTranslateExternalChanges && primaryLocaleCache) {
        const { reconcileAfterPrimarySave, metaobjectTranslationMirror } = await import(
          "~/services/translations/stale-translation-sync.server"
        );
        const entry = entries.get(metaobjectId);
        await reconcileAfterPrimarySave({
          client: admin,
          shop: session.shop,
          resourceId: metaobjectId,
          // The Shopify resource IS the entry; its fields are keys on it, not
          // sub-resources — so no entry names a resource of its own.
          resourceType: "Metaobject",
          // A metaobject has no kind of its own in the AI vocabulary; the
          // prompt comes from `translateAs` anyway, and this only decides the
          // Task row's label.
          contentKind: "page",
          resourceTitle: entry?.type ? `${entry.type} · ${metaobjectId}` : metaobjectId,
          changed: keys.map((key) => ({ key })),
          foreignLocales,
          policy,
          mirror: metaobjectTranslationMirror(session.shop, metaobjectId, entry?.type ?? ""),
          translateAs: {
            kind: "values",
            context: "metaobject field values",
            sourceLocale: primaryLocaleCache,
          },
        });
        return;
      }

      if (!policy.purgeUnreconciledSurfaces) return;
      const { removeAndVerifyAcrossLocales, LOCALE_KEY_SEP } = await import(
        "~/services/bulk-editor/translations.server"
      );
      // Skip Shopify entirely when there is nothing to invalidate — the common
      // case on a shop that never translated this field.
      const existing = await db.metaobjectTranslation.findMany({
        where: {
          shop: session.shop,
          metaobjectId,
          marketId: "",
          key: { in: keys },
          locale: { in: foreignLocales },
        },
        select: { key: true, locale: true },
      });
      if (existing.length === 0) return;

      const { confirmedPairs } = await removeAndVerifyAcrossLocales(
        gateway,
        metaobjectId,
        [...new Set(existing.map((e) => e.key))],
        [...new Set(existing.map((e) => e.locale))],
        "",
      );
      const byLocale = new Map<string, string[]>();
      for (const row of existing) {
        if (!confirmedPairs.has(`${row.locale}${LOCALE_KEY_SEP}${row.key}`)) continue;
        const list = byLocale.get(row.locale) ?? [];
        list.push(row.key);
        byLocale.set(row.locale, list);
      }
      for (const [rowLocale, rowKeys] of byLocale) {
        await db.metaobjectTranslation.deleteMany({
          // Global rows only — mirroring the global-only Shopify removal, so a
          // market override survives on both sides.
          where: { shop: session.shop, metaobjectId, key: { in: rowKeys }, locale: rowLocale, marketId: "" },
        });
      }
    } catch (err: unknown) {
      // Never fail the save over the cleanup — the primary write already
      // happened, and the next re-translate repairs the leftovers.
      logger.warn("[UnifiedContent] metaobject translation invalidation failed (non-fatal)", {
        context: "Metaobjects",
        metaobjectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function getForeignLocales(): Promise<string[]> {
    if (foreignLocalesCache) return foreignLocalesCache;
    const { GET_SHOP_LOCALES } = await import("../../graphql/content.queries");
    const response = await admin.graphql(GET_SHOP_LOCALES);
    const data = (await response.json()) as {
      data?: { shopLocales?: Array<{ locale: string; primary: boolean; published: boolean }> };
    };
    const shopLocales = data.data?.shopLocales ?? [];
    primaryLocaleCache = shopLocales.find((l) => l.primary)?.locale ?? "";
    foreignLocalesCache = shopLocales
      .filter((l) => !l.primary && l.published)
      .map((l) => l.locale);
    return foreignLocalesCache;
  }

  // ── 3b. Foreign locale: translations, register/remove both echo-verified ─
  async function saveForeign(): Promise<number> {
    const { registerAndVerify, removeAndVerify, fetchDigestsForResource } = await import(
      "~/services/bulk-editor/translations.server"
    );
    let confirmedTotal = 0;

    const byEntry = new Map<string, SubmittedField[]>();
    for (const field of toProcess) {
      if (!entries.has(field.metaobjectId)) continue;
      const list = byEntry.get(field.metaobjectId) ?? [];
      list.push(field);
      byEntry.set(field.metaobjectId, list);
    }

    for (const [metaobjectId, fields] of byEntry) {
      const entry = entries.get(metaobjectId)!;
      const definitionFields = definitions.get(entry.type) ?? [];

      const toRegister: Array<{ key: string; value: string }> = [];
      const toRemove: string[] = [];

      // A list TRANSLATION is stored as JSON too, so it has the same
      // round-trip hazard as the primary value: an entry containing "|" would
      // be shattered by the split. The stored rows are only read when a list
      // field is actually among the writes.
      const hasListField = fields.some(
        (f) => metaobjectFieldRole(fieldTypeOf(f.fieldKey, entry, definitionFields)) === "list",
      );
      const storedTranslations = hasListField
        ? await db.metaobjectTranslation.findMany({
            where: {
              shop: session.shop,
              metaobjectId,
              locale,
              marketId,
              key: { in: fields.map((f) => f.fieldKey) },
            },
            select: { key: true, value: true },
          })
        : [];
      const storedTranslationByKey = new Map(storedTranslations.map((r) => [r.key, r.value]));

      for (const field of fields) {
        const fieldType = fieldTypeOf(field.fieldKey, entry, definitionFields);
        if (!isTranslatableMetaobjectFieldType(fieldType)) {
          // A colour or a file reference has ONE value per shop; its
          // `translationKey` is "" so it should never arrive here. If it does,
          // dropping it is the only safe answer -- writing it would store a
          // per-locale value Shopify does not have a concept of, and clearing
          // it would delete the shop-wide one.
          logger.warn("[UnifiedContent] dropped a non-translatable metaobject field from a foreign save", {
            context: "Metaobjects",
            metaobjectId,
            fieldKey: field.fieldKey,
            fieldType,
          });
          continue;
        }
        const storedTranslation = storedTranslationByKey.get(field.fieldKey) ?? "";
        // Unchanged in the DISPLAY form ⇒ nothing to write. Same reason as on
        // the primary path: a list does not round-trip byte for byte.
        if (storedTranslation !== "" && formatMetaobjectFieldValue(fieldType, storedTranslation) === field.value) {
          continue;
        }
        // Same exemption as on the primary path: clearing a translation is a
        // removal, not a split.
        if (field.value !== "" && metaobjectListValueIsAmbiguous(fieldType, storedTranslation)) {
          errors.push(
            `${field.fieldKey}: one of the translated list values contains "|", which this editor uses to separate them. Edit this field in the Shopify admin.`,
          );
          continue;
        }
        // Translations are stored the way Shopify stores the primary value, so
        // a list translation is JSON too.
        const parsed = parseMetaobjectFieldInput(fieldType, field.value);
        if (!parsed.ok) {
          errors.push(
            parsed.error === "emptyListEntry"
              ? `${field.fieldKey}: list values must not be empty — separate them with | and remove empty entries.`
              : `${field.fieldKey}: this value cannot be stored.`,
          );
          continue;
        }
        if (parsed.value === "") toRemove.push(field.fieldKey);
        else toRegister.push({ key: field.fieldKey, value: parsed.value });
      }

      if (toRemove.length > 0) {
        try {
          const { confirmedKeys, userErrors } = await removeAndVerify(
            gateway,
            metaobjectId,
            toRemove,
            locale,
            marketId,
          );
          for (const key of toRemove) {
            if (confirmedKeys.has(key)) {
              await db.metaobjectTranslation.deleteMany({
                where: { shop: session.shop, metaobjectId, key, locale, marketId },
              });
              confirmedTotal++;
            } else {
              // CLAUDE.md: an unconfirmed removal leaves the local row alone.
              errors.push(
                `${key}: Shopify did not confirm the removal — the translation was kept.${
                  userErrors.length > 0 ? ` (${userErrors[0].message})` : ""
                }`,
              );
            }
          }
        } catch (err: unknown) {
          errors.push(`${metaobjectId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (toRegister.length > 0) {
        try {
          const digests = await fetchDigestsForResource(
            gateway,
            metaobjectId,
            toRegister.map((r) => r.key),
          );
          const inputs = [];
          for (const item of toRegister) {
            const digest = digests.get(item.key);
            if (!digest) {
              // `translatableContent` only lists keys that HAVE a primary
              // value, so a missing digest most often means the primary field
              // is empty — which is a reason, not a silent drop.
              errors.push(
                `${item.key}: no translation digest — the primary value of this field is empty or the field is not translatable.`,
              );
              continue;
            }
            inputs.push({
              key: item.key,
              value: item.value,
              locale,
              translatableContentDigest: digest,
              ...(marketId ? { marketId } : {}),
            });
          }
          if (inputs.length > 0) {
            const { confirmedKeys, userErrors } = await registerAndVerify(gateway, metaobjectId, inputs);
            for (const input of inputs) {
              if (!confirmedKeys.has(input.key)) {
                errors.push(
                  `${input.key}: Shopify did not confirm the translation.${
                    userErrors.length > 0 ? ` (${userErrors[0].message})` : ""
                  }`,
                );
                continue;
              }
              await db.metaobjectTranslation.upsert({
                where: {
                  shop_metaobjectId_key_locale_marketId: {
                    shop: session.shop,
                    metaobjectId,
                    key: input.key,
                    locale,
                    marketId,
                  },
                },
                create: {
                  shop: session.shop,
                  metaobjectId,
                  // B5: the BARE type. `itemId` on this page is
                  // `metaobject_type_<type>`, and the sync's definition
                  // stale-delete removes rows whose type is not a live type.
                  type: entry.type,
                  key: input.key,
                  value: input.value,
                  locale,
                  outdated: false,
                  marketId,
                },
                update: {
                  value: input.value,
                  outdated: false,
                  // Repairs rows an older build wrote with the pseudo-item id.
                  type: entry.type,
                  updatedAt: new Date(),
                },
              });
              confirmedTotal++;
            }
          }
        } catch (err: unknown) {
          errors.push(`${metaobjectId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return confirmedTotal;
  }
}

