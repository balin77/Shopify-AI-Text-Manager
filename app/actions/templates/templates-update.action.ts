import { data as json } from "react-router";
import { ENABLE_THEME_PRIMARY_EDIT } from "~/config/constants";
import { getFormString, getFormJSON } from "~/utils/form-data.utils";
import { logger } from "~/utils/logger.server";
import { extractThemeIdFromResourceId } from "~/utils/theme-id";
import { resolveSelectedThemeId } from "~/services/theme-selection.server";
import { TRANSLATE_CONTENT, REMOVE_TRANSLATIONS, UPSERT_THEME_FILES } from "~/graphql/content.mutations";
import { GET_THEME_FILES, GET_SHOP_LOCALES } from "~/graphql/content.queries";
import { keyToFilename, replaceValuesInJson } from "~/utils/templates/templates.utils";
import { normalizeShopifyRichtext, hasHtmlTags, isRichtextTopLevelError } from "~/utils/richtext-normalize.server";
import type { TemplatesActionContext, TranslatableField } from "./shared";
import type { DataResponse } from "~/types/data-response";
import { markTranslationSaved } from "~/utils/translation-save-lock.server";

export async function handleUpdateContent(ctx: TemplatesActionContext): Promise<DataResponse> {
  const { admin, db, session, formData, groupId, domain, themeGroups, resourceId, keyToResourceId, keyToResourceType, selectedThemeId } = ctx;
  const locale = getFormString(formData, "locale");
  const primaryLocale = getFormString(formData, "primaryLocale");
  // Market scope for market-specific ("Translate & Adapt") theme translations.
  // Primary-locale theme content is always global, so only foreign locales carry it.
  const marketId = locale !== primaryLocale ? getFormString(formData, "marketId") : "";

  // Resolve the theme file that owns a translatable key's PRIMARY value.
  // JSON-template keys (section.*, collections.json.*) live in templates/*.json.
  // Locale-content keys (accessibility.*, general.*, shopify.checkout.*, …) live
  // in the theme's default locale file; these have no section/collections pattern,
  // so keyToFilename alone returns null and they were silently dropped from the
  // Shopify push — the silent-save bug.
  //
  // Shopify theme locale filenames are LOWERCASED (e.g. locales/pt-br.default.json
  // for a "pt-BR" shop locale), so we lowercase the constructed name. The real
  // default-locale file is also discovered by glob below (isLocaleDefaultFile),
  // which additionally covers themes whose default locale differs from the shop's
  // primary locale.
  // ONLINE_STORE_THEME is a ~99% duplicate of LOCALE_CONTENT (same accessibility.*
  // / general.* keys, same default locale file), so legacy rows of that type route
  // to the same file — this also makes resolution deterministic when a key exists
  // under both types (keyToResourceType's "last group wins" no longer matters).
  const LOCALE_CONTENT_TYPES = new Set(["ONLINE_STORE_THEME_LOCALE_CONTENT", "ONLINE_STORE_THEME"]);
  const resolveFilename = (key: string): string | null => {
    const templateFile = keyToFilename(key);
    if (templateFile) return templateFile;
    const resourceType = keyToResourceType.get(key) ?? "";
    if (LOCALE_CONTENT_TYPES.has(resourceType)) {
      return `locales/${primaryLocale.toLowerCase()}.default.json`;
    }
    // Two theme-settings tabs store merchant-entered VALUES (not schema labels) in
    // the theme's config/settings_data.json:
    //   • "Statische Abschnitte" (ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS) —
    //     keys section.<sectionId>.<blockId>.<setting>, values under current.sections.*
    //   • "Theme-Einstellungen" (ONLINE_STORE_THEME_SETTINGS_CATEGORY) — top-level
    //     theme settings like the Brand-information category (general.brand_headline,
    //     general.brand_description, …), values under current.<setting_id>. The
    //     translatable resourceId encodes this: OnlineStoreThemeSettingsCategory/
    //     Brand+information?theme_id=…&first_setting_id=brand_headline.
    // Neither key pattern has a ".json." segment, so keyToFilename returns null and
    // both were reported as unmapped and never pushed (the silent-drop bug). Route
    // both by resource type. replaceValuesInJson locates the value anywhere in the
    // file by old-value + last-segment keyHint, so the exact nesting is irrelevant.
    if (
      resourceType === "ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS" ||
      resourceType === "ONLINE_STORE_THEME_SETTINGS_CATEGORY"
    ) {
      return "config/settings_data.json";
    }
    return null;
  };

  // Matches any theme default-locale file (exactly one exists per theme),
  // independent of the locale code or its casing.
  const isLocaleDefaultFile = (filename: string): boolean =>
    /^locales\/[^/]+\.default\.json$/i.test(filename);

  const changedFields: string[] = getFormJSON<string[]>(formData, "changedFields") || [];

  const allFormDataKeys: string[] = [];
  formData.forEach((_value, key) => { allFormDataKeys.push(key); });
  logger.debug("[TEMPLATES] Update content - start", {
    context: "Templates",
    formDataKeys: allFormDataKeys,
    locale,
    primaryLocale,
    isPrimaryLocale: locale === primaryLocale,
    changedFields,
  });

  const updatedFields: Record<string, string> = {};
  const allContent = themeGroups.flatMap(
    (group) => (group.translatableContent as unknown) as TranslatableField[]
  );
  const uniqueKeys = new Set(allContent.map((item) => item.key));

  const metadataKeys = new Set([
    "action", "itemId", "locale", "primaryLocale", "changedFields",
    "imageAltTexts", "changedAltTextIndices", "contentType", "marketId",
  ]);
  let formFieldCount = 0;
  formData.forEach((_value, key) => { if (!metadataKeys.has(key)) formFieldCount++; });

  for (const key of uniqueKeys) {
    const value = formData.get(key);
    if (typeof value === "string") {
      updatedFields[key] = value;
    }
  }

  logger.info("[TEMPLATES] Update content - field matching", {
    context: "Templates",
    dbUniqueKeys: uniqueKeys.size,
    formFieldEntries: formFieldCount,
    matchedFields: Object.keys(updatedFields).length,
    locale,
    isPrimaryLocale: locale === primaryLocale,
  });

  if (Object.keys(updatedFields).length === 0) {
    logger.warn("[TEMPLATES] Update content - NO fields matched! Save is a no-op.", {
      context: "Templates",
      sampleDbKeys: Array.from(uniqueKeys).slice(0, 3),
      sampleFormKeys: allFormDataKeys.filter((k) => !metadataKeys.has(k)).slice(0, 3),
    });
    return json({ success: true, actionType: "updateContent" });
  }

  // ─── CRITICAL: Reject empty primary-language fields ───────────────────────
  // Shopify permanently removes template fields when the primary-locale value is
  // saved as empty. Once removed, the field can NEVER be restored.
  // DO NOT remove this check — it protects against irreversible data loss.
  // ─────────────────────────────────────────────────────────────────────────
  if (locale === primaryLocale) {
    const emptyKeys = Object.entries(updatedFields)
      .filter(([, value]) => value.trim() === "")
      .map(([key]) => key);

    if (emptyKeys.length > 0) {
      logger.warn("[TEMPLATES] Blocked save — empty primary-locale fields detected", {
        context: "Templates",
        locale,
        emptyKeys,
      });
      return json({ success: false, errorKey: "emptyPrimaryFieldsError" }, { status: 400 });
    }
  }

  const skippedKeys: string[] = [];
  const noDigestKeys: string[] = [];
  const failedDeleteKeys: string[] = [];
  const shopifyErrors: string[] = [];

  // STEP 1: Register translations with Shopify (only for foreign locales)
  if (locale !== primaryLocale) {
    const digestMap = new Map<string, string>();
    for (const item of allContent) {
      if (item.digest) digestMap.set(item.key, item.digest);
    }

    // The cached digests above (from db.themeContent) go stale the moment the
    // primary content changes on Shopify — e.g. a foreign-locale "Accept &
    // Translate" writes the primary base value before registering the foreign
    // translation. Registering with a stale digest fails with "Translatable
    // content hash is invalid". Fetch fresh digests LIVE per resource (mirrors
    // the AI translate handler's getCachedDigest) and prefer them over the cache.
    const liveDigestCache = new Map<string, Map<string, string>>();
    const fetchLiveDigest = async (resId: string, key: string): Promise<string> => {
      if (!liveDigestCache.has(resId)) {
        const map = new Map<string, string>();
        try {
          const resp = await admin.graphql(
            `#graphql
              query getTranslatableContent($resourceId: ID!) {
                translatableResource(resourceId: $resourceId) {
                  translatableContent { key digest }
                }
              }`,
            { variables: { resourceId: resId } },
          );
          const d = await resp.json();
          const content = d.data?.translatableResource?.translatableContent || [];
          for (const c of content as Array<{ key: string; digest?: string }>) {
            if (c.digest) map.set(c.key, c.digest);
          }
        } catch (digestErr) {
          logger.warn("[TEMPLATES] Live digest fetch failed — falling back to cached digest", {
            context: "Templates",
            resourceId: resId,
            error: digestErr instanceof Error ? digestErr.message : String(digestErr),
          });
        }
        liveDigestCache.set(resId, map);
      }
      return liveDigestCache.get(resId)!.get(key) || "";
    };

    const translationsByResource = new Map<
      string,
      Array<{ key: string; value: string; locale: string; translatableContentDigest: string }>
    >();
    const deletionsByResource = new Map<string, string[]>();

    for (const [key, value] of Object.entries(updatedFields)) {
      const fieldResId = keyToResourceId.get(key) || resourceId;

      if (value === "") {
        const existing = deletionsByResource.get(fieldResId) || [];
        existing.push(key);
        deletionsByResource.set(fieldResId, existing);
        continue;
      }

      // Prefer a fresh live digest; fall back to the cached one only if the
      // live fetch produced nothing (network error or key not currently present).
      const digest = (await fetchLiveDigest(fieldResId, key)) || digestMap.get(key) || "";
      if (!digest) {
        logger.warn("[TEMPLATES] No digest for key — skipping Shopify save", {
          context: "Templates",
          key,
          locale,
          resourceId: fieldResId,
        });
        skippedKeys.push(key);
        noDigestKeys.push(key);
        continue;
      }

      if (!translationsByResource.has(fieldResId)) translationsByResource.set(fieldResId, []);
      translationsByResource.get(fieldResId)!.push({ key, value, locale, translatableContentDigest: digest });
    }

    // Send one translationsRegister call per resource ID.
    // NOTE: reuse the function-scope `shopifyErrors` declared above — do NOT
    // re-declare it here. A local `const shopifyErrors` shadowed the outer one,
    // so the final `if (shopifyErrors.length > 0)` check (which reads the outer
    // variable) was always empty and partial Shopify rejections were reported
    // as success: true — the silent-error bug on Theme-Standardinhalte saves.
    for (const [resId, translationInputs] of translationsByResource) {
      if (translationInputs.length === 0) continue;

      // §5.2 Divergenz-Guard: never register foreign translations against a
      // resource whose embedded theme_id differs from the selected theme —
      // otherwise a stale/mis-scoped resourceId would silently write into a
      // FOREIGN theme. Theme-agnostic resources (no theme_id → null) and an unset
      // selection are always allowed.
      const resThemeId = extractThemeIdFromResourceId(resId);
      if (selectedThemeId && resThemeId && resThemeId !== selectedThemeId) {
        logger.error("[TEMPLATES] Cross-theme write blocked — resource belongs to a different theme than selected", {
          context: "Templates",
          resourceId: resId,
          resThemeId,
          selectedThemeId,
          locale,
        });
        skippedKeys.push(...translationInputs.map((t) => t.key));
        shopifyErrors.push(
          `Refusing to write translations into a different theme than the selected one (resource ${resId}).`
        );
        continue;
      }

      logger.info("[TEMPLATES] Sending translations to Shopify", {
        context: "Templates",
        resourceId: resId,
        locale,
        fieldCount: translationInputs.length,
        sampleKeys: translationInputs.slice(0, 3).map((t) => t.key),
      });

      try {
        const response = await admin.graphql(TRANSLATE_CONTENT, {
          variables: {
            resourceId: resId,
            translations: marketId
              ? translationInputs.map((t) => ({ ...t, marketId }))
              : translationInputs,
          },
        });
        const data = await response.json();

        if (data.data?.translationsRegister?.userErrors?.length > 0) {
          const errors = data.data.translationsRegister.userErrors;
          logger.error("[TEMPLATES] Shopify translation errors", {
            context: "Templates",
            errors,
            resourceId: resId,
            locale,
          });
          skippedKeys.push(...translationInputs.map((t) => t.key));
          shopifyErrors.push(errors[0].message);
        } else {
          // Shopify can return NO userErrors yet register NOTHING — App-Embed keys
          // (ONLINE_STORE_THEME_APP_EMBED) silently no-op this way. The mutation
          // echoes back the translations it actually stored, so confirm every key
          // we sent is present. A missing key never persisted on Shopify and must
          // NOT be mirrored into the local DB (skippedKeys → excluded from the DB
          // upsert below) — otherwise the DB shows a value the storefront never
          // received and the save is reported as success (the silent-save bug).
          const registeredKeys = new Set(
            (data.data?.translationsRegister?.translations ?? []).map(
              (t: { key: string }) => t.key
            )
          );
          const notPersisted = translationInputs.filter((t) => !registeredKeys.has(t.key));
          if (notPersisted.length > 0) {
            logger.error("[TEMPLATES] Shopify returned no error but registered no translation for some keys", {
              context: "Templates",
              resourceId: resId,
              locale,
              missingKeys: notPersisted.map((t) => t.key),
              registeredCount: registeredKeys.size,
            });
            skippedKeys.push(...notPersisted.map((t) => t.key));
            shopifyErrors.push(
              `Shopify did not store ${notPersisted.length} translation(s) although it reported no error: ${notPersisted
                .slice(0, 5)
                .map((t) => t.key)
                .join(", ")}`
            );
          }
          if (notPersisted.length < translationInputs.length) {
            logger.info("[TEMPLATES] Shopify translations registered successfully", {
              context: "Templates",
              locale,
              resourceId: resId,
              fieldCount: translationInputs.length - notPersisted.length,
            });
          }
        }
      } catch (registerError) {
        const errorMsg = registerError instanceof Error ? registerError.message : String(registerError);
        logger.error("[TEMPLATES] translationsRegister failed", {
          context: "Templates",
          error: errorMsg,
          resourceId: resId,
        });
        skippedKeys.push(...translationInputs.map((t) => t.key));
        shopifyErrors.push(errorMsg);
      }
    }

    // Delete cleared translations from Shopify via translationsRemove.
    // NOTE: reuse the function-scope `failedDeleteKeys` declared above — do NOT
    // re-declare it. A shadowing local meant failed deletions were never
    // excluded from the local DB delete below, silently diverging DB ↔ Shopify.
    for (const [resId, keysToDelete] of deletionsByResource) {
      if (keysToDelete.length === 0) continue;

      logger.info("[TEMPLATES] Deleting cleared translations from Shopify", {
        context: "Templates",
        resourceId: resId,
        locale,
        keyCount: keysToDelete.length,
        sampleKeys: keysToDelete.slice(0, 3),
      });

      try {
        const removeResponse = await admin.graphql(REMOVE_TRANSLATIONS, {
          variables: { resourceId: resId, translationKeys: keysToDelete, locales: [locale], marketIds: marketId ? [marketId] : null },
        });
        const removeData = await removeResponse.json();

        if (removeData.data?.translationsRemove?.userErrors?.length > 0) {
          logger.error("[TEMPLATES] Shopify translationsRemove errors for cleared fields", {
            context: "Templates",
            errors: removeData.data.translationsRemove.userErrors,
            resourceId: resId,
          });
          failedDeleteKeys.push(...keysToDelete);
          shopifyErrors.push(removeData.data.translationsRemove.userErrors[0].message);
        } else {
          // Shopify can return NO userErrors yet remove NOTHING — some resources
          // (EMAIL_TEMPLATE et al.) silently no-op translationsRemove exactly like
          // COOKIE_BANNER does. The mutation echoes back the translations it
          // actually deleted, so confirm every cleared key is present. A key that
          // is not echoed never left Shopify and must NOT be deleted from the
          // local DB (failedDeleteKeys → excluded from the DB deleteMany below) —
          // otherwise the field looks gone locally while it survives on the
          // storefront and the save is reported as success (the silent-delete bug).
          // Foreign saves only send CHANGED fields (buildFieldsForSave filters out
          // unchanged/empty ones), so every key here genuinely had a value to
          // remove — an empty echo is a real failure, not a "nothing to do".
          const removedKeys = new Set(
            (removeData.data?.translationsRemove?.translations ?? []).map(
              (t: { key: string }) => t.key
            )
          );
          // Clearing a translation is a merchant write like any other, so an
          // in-flight theme repair must abandon the rest rather than re-create
          // what was just deleted. Claimed only once Shopify CONFIRMS it
          // removed something — every other claim in this app waits for Shopify
          // to hold the value, and aborting a run over a removal that silently
          // no-opped would cost that run for nothing. Global layer only.
          if (!marketId && removedKeys.size > 0) markTranslationSaved(resId);

          const notRemoved = keysToDelete.filter((k) => !removedKeys.has(k));
          if (notRemoved.length > 0) {
            logger.error("[TEMPLATES] Shopify returned no error but removed no translation for cleared keys", {
              context: "Templates",
              resourceId: resId,
              locale,
              notRemovedKeys: notRemoved,
              removedCount: removedKeys.size,
            });
            failedDeleteKeys.push(...notRemoved);
            shopifyErrors.push(
              `Shopify did not remove ${notRemoved.length} cleared translation(s) although it reported no error: ${notRemoved
                .slice(0, 5)
                .join(", ")}`
            );
          }
          if (notRemoved.length < keysToDelete.length) {
            logger.info("[TEMPLATES] Cleared translations removed from Shopify", {
              context: "Templates",
              resourceId: resId,
              keyCount: keysToDelete.length - notRemoved.length,
              locale,
            });
          }
        }
      } catch (removeError) {
        const errorMsg = removeError instanceof Error ? removeError.message : String(removeError);
        logger.error("[TEMPLATES] translationsRemove failed for cleared fields", {
          context: "Templates",
          error: errorMsg,
          resourceId: resId,
        });
        failedDeleteKeys.push(...keysToDelete);
        shopifyErrors.push(errorMsg);
      }
    }

    // Surface no-digest skips too: these keys are saved to neither Shopify nor
    // the local DB (they are filtered out of the DB upsert below), so without an
    // error the user would be told the save succeeded while nothing persisted.
    if (noDigestKeys.length > 0) {
      shopifyErrors.push(
        `Missing Shopify digest for ${noDigestKeys.length} field(s) — try reloading the content first: ${noDigestKeys.slice(0, 5).join(", ")}`
      );
    }

    const totalShopifyOps =
      [...translationsByResource.values()].reduce((n, arr) => n + arr.length, 0) +
      [...deletionsByResource.values()].reduce((n, arr) => n + arr.length, 0);
    const totalFailed = skippedKeys.length + failedDeleteKeys.length;
    if (totalFailed > 0 && totalFailed >= totalShopifyOps) {
      throw new Error(`Shopify rejected all changes: ${shopifyErrors.join("; ")}`);
    }
  }

  // STEP 2: Update local database
  if (locale === primaryLocale) {
    // Primary-language editing writes the source value into a theme file via
    // themeFilesUpsert (STEP 2a) — which only exists for the `theme` domain
    // (contentType "templates"). The other ThemeContent rubrics (system /
    // delivery / online_store_extras / selling_plans / customer_privacy) are
    // backed by Shopify RESOURCES with no theme file, and the app has no
    // resource-update mutation for their originals, so their primary value is
    // authoritative in Shopify admin. Reject cleanly instead of failing to map
    // keys to a non-existent file — which surfaced the confusing "not editable
    // in the primary language (no matching theme file)" partial-failure. Foreign
    // translations (STEP 1) still work for these resources via translationsRegister.
    if (domain !== "theme") {
      logger.warn("[TEMPLATES] Primary locale save rejected — resource-backed domain has no theme file", {
        context: "Templates",
        domain,
        keys: Object.keys(updatedFields),
      });
      return json(
        {
          success: false,
          error:
            "Primary-language editing is not available for this content type — edit the original in your Shopify admin. You can still translate it into other languages.",
        },
        { status: 400 }
      );
    }

    if (!ENABLE_THEME_PRIMARY_EDIT) {
      logger.warn("[TEMPLATES] Primary locale save rejected - ENABLE_THEME_PRIMARY_EDIT is false", {
        context: "Templates",
        locale,
        fieldCount: Object.keys(updatedFields).length,
      });
      return json(
        {
          success: false,
          error: "Primary locale editing for templates requires write_themes scope (not yet enabled)",
        },
        { status: 403 }
      );
    }

    // Tracks which changed primary keys actually reached Shopify. Only these are
    // written to the local DB (STEP 2b), and only an empty failure set returns
    // success — never report a save the storefront never received.
    const pushedPrimaryKeys = new Set<string>();
    const failedPrimaryKeys: string[] = [];
    const primarySaveErrors: string[] = [];
    // The value ACTUALLY written into the theme file per key. May differ from
    // updatedFields[key] when autofix/normalize rewrote it (e.g. richtext
    // normalization). STEP 2b mirrors THIS into the DB so the DB and the theme
    // file stay byte-identical — otherwise the next primary save builds
    // oldValueMap from the raw DB value, cannot find it in the (normalized) file,
    // and reports the change as an unlocatable/failed key.
    const pushedValueByKey = new Map<string, string>();

    // Merchant-selected handling of Shopify's richtext top-level-node rule for
    // theme-settings values (config/settings_data.json). See AISettings.themeRichtextMode.
    //   autofix   (default) — push raw; on the specific rejection, normalize + retry once.
    //   normalize           — normalize HTML-bearing settings values before the first push.
    //   error               — never rewrite; surface a clear instruction.
    const SETTINGS_DATA_FILE = "config/settings_data.json";
    const richtextSetting = await db.aISettings.findUnique({
      where: { shop: session.shop },
      select: { themeRichtextMode: true },
    });
    const richtextMode = richtextSetting?.themeRichtextMode ?? "autofix";

    // STEP 2a: Push primary locale changes to Shopify via themeFilesUpsert
    {
      const oldValueMap = new Map<string, string>();
      for (const group of themeGroups) {
        const content = (group.translatableContent as unknown) as TranslatableField[];
        for (const item of content) {
          if (updatedFields[item.key] !== undefined && item.value !== undefined) {
            oldValueMap.set(item.key, item.value);
          }
        }
      }

      const keysByFilename = new Map<string, string[]>();
      const unmappedKeys: string[] = [];
      for (const key of Object.keys(updatedFields)) {
        if (oldValueMap.get(key) === updatedFields[key]) continue;

        const filename = resolveFilename(key);
        if (filename) {
          const existing = keysByFilename.get(filename) || [];
          existing.push(key);
          keysByFilename.set(filename, existing);
        } else {
          unmappedKeys.push(key);
        }
      }

      // Unmapped keys are changed primary values we cannot push to any theme file.
      // They must NOT be silently saved to the local DB as success — that is the
      // exact divergence (DB updated, Shopify untouched, user told "saved") this
      // handler now guards against. Record them as failures so the response below
      // reports success: false.
      if (unmappedKeys.length > 0) {
        logger.error("[TEMPLATES] Changed primary keys could not be mapped to a theme file — cannot push to Shopify", {
          context: "Templates",
          unmappedKeys,
        });
        failedPrimaryKeys.push(...unmappedKeys);
        primarySaveErrors.push(
          `These fields are not editable in the primary language (no matching theme file): ${unmappedKeys.slice(0, 5).join(", ")}`
        );
      }

      if (keysByFilename.size > 0) {
        // Theme-Auswahl: push primary-locale changes to the theme the merchant
        // selected. Reuse the selection already resolved for this request (the same
        // value the §5.2 foreign-path guard uses) so Primary + Foreign target ONE
        // theme and we avoid a redundant GET_THEMES; resolve only if the caller did
        // not provide it. resolveSelectedThemeId falls back to MAIN when
        // unset/invalid (see PLAN_THEME_SELECTION §5).
        const themeId =
          selectedThemeId !== undefined
            ? selectedThemeId
            : await resolveSelectedThemeId(session.shop, admin);

        if (!themeId) {
          logger.error("[TEMPLATES] No theme found — cannot push primary locale changes", {
            context: "Templates",
          });
          return json(
            {
              success: false,
              error: "No theme found. Cannot save primary locale changes to Shopify.",
            },
            { status: 500 }
          );
        }
        // If a default-locale file is involved, also request it by glob so we get
        // the theme's ACTUAL default-locale file even when its name differs from
        // our constructed locales/<primaryLocale>.default.json (locale casing, or
        // a theme whose default locale ≠ the shop's primary locale).
        const hasLocaleDefault = Array.from(keysByFilename.keys()).some(isLocaleDefaultFile);
        const filenames = Array.from(keysByFilename.keys());
        if (hasLocaleDefault) filenames.push("locales/*.default.json");

        logger.info("[TEMPLATES] Reading theme files from Shopify", {
          context: "Templates",
          themeId,
          filenames,
        });

        const filesResponse = await admin.graphql(GET_THEME_FILES, { variables: { themeId, filenames } });
        const filesData = await filesResponse.json();

        logger.debug("[TEMPLATES] Raw theme files response", {
          context: "Templates",
          hasTheme: !!filesData.data?.theme,
          hasFiles: !!filesData.data?.theme?.files,
          nodeCount: filesData.data?.theme?.files?.nodes?.length ?? 0,
          errors: (filesData as any).errors,
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fileNodes: any[] = filesData.data?.theme?.files?.nodes || [];

        const fileShopifyErrors: string[] = [];
        const leadingCommentRegex = /^\s*\/\*[\s\S]*?\*\/\s*/;

        // Build one themeFilesUpsert entry for a file. Kept free of outer failure
        // side-effects so it can be re-run for the autofix retry (it re-parses the
        // original Shopify content each call, so it is idempotent). When
        // `normalizeSettings` is set, richtext values destined for
        // config/settings_data.json are rewritten to satisfy Shopify's
        // top-level-node rule (plain-text values are left untouched by the normalizer).
        const buildFileEntry = (
          filename: string,
          keys: string[],
          normalizeSettings: boolean,
        ): {
          entry?: { filename: string; body: { type: string; value: string } };
          replacedKeys: string[];
          missedKeys: string[];
          // Final value written per replaced key (post-normalization). Used to keep
          // the DB mirror consistent with what actually landed in the theme file.
          pushedValues: Map<string, string>;
          error?: string;
        } => {
          // Template files match by exact name. For the default-locale file, the
          // theme may name it differently than our constructed name (casing, or a
          // different default locale), so fall back to the single *.default.json
          // node Shopify returned for the glob.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const fileNode =
            fileNodes.find((n: any) => n.filename === filename) ??
            (isLocaleDefaultFile(filename)
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ? fileNodes.find((n: any) => typeof n.filename === "string" && isLocaleDefaultFile(n.filename))
              : undefined);
          const actualFilename: string = fileNode?.filename ?? filename;

          const rawContent = fileNode?.body?.content ?? fileNode?.body;
          if (!rawContent || typeof rawContent !== "string") {
            logger.warn("[TEMPLATES] Theme file not found or no text content", {
              context: "Templates",
              filename,
              keys,
              rawContentType: typeof rawContent,
            });
            return { replacedKeys: [], missedKeys: [...keys], pushedValues: new Map(), error: `File not found or not a text file: ${filename}` };
          }

          const hasLeadingComment = leadingCommentRegex.test(rawContent);
          const jsonContent = hasLeadingComment ? rawContent.replace(leadingCommentRegex, "") : rawContent;

          let fileJson: unknown;
          try {
            fileJson = JSON.parse(jsonContent);
          } catch {
            logger.error("[TEMPLATES] Failed to parse theme file JSON", {
              context: "Templates",
              filename,
              contentPreview: rawContent.substring(0, 500),
            });
            return { replacedKeys: [], missedKeys: [...keys], pushedValues: new Map(), error: `Invalid JSON in file: ${filename}` };
          }

          const replacements = new Map<string, { oldValue: string; newValue: string; keyHint: string }>();
          for (const key of keys) {
            const oldValue = oldValueMap.get(key) || "";
            let newValue = updatedFields[key];
            if (normalizeSettings && filename === SETTINGS_DATA_FILE && hasHtmlTags(newValue)) {
              newValue = normalizeShopifyRichtext(newValue);
            }
            const keyParts = key.split(".");
            const keyHint = keyParts[keyParts.length - 1];
            replacements.set(key, { oldValue, newValue, keyHint });
          }

          const replacedKeys = replaceValuesInJson(fileJson, replacements);
          const missedKeys = keys.filter((k) => !replacedKeys.has(k));

          // Record the value that actually went into the file (post-normalization)
          // for every replaced key, so STEP 2b can mirror the exact same value.
          const pushedValues = new Map<string, string>();
          for (const key of replacedKeys) {
            const r = replacements.get(key);
            if (r) pushedValues.set(key, r.newValue);
          }

          logger.info("[TEMPLATES] Value replacement results", {
            context: "Templates",
            filename,
            totalKeys: keys.length,
            replacedCount: replacedKeys.size,
            replacedKeys: Array.from(replacedKeys),
            missedKeys,
            normalizeSettings,
          });

          const entry =
            replacedKeys.size > 0
              ? {
                  filename: actualFilename,
                  body: {
                    type: "TEXT",
                    value: hasLeadingComment
                      ? rawContent.match(leadingCommentRegex)![0] + JSON.stringify(fileJson, null, 2)
                      : JSON.stringify(fileJson, null, 2),
                  },
                }
              : undefined;

          return { entry, replacedKeys: Array.from(replacedKeys), missedKeys, pushedValues };
        };

        const runUpsert = async (
          files: Array<{ filename: string; body: { type: string; value: string } }>,
        ): Promise<{ errors: string[]; upsertedFilenames: string[] }> => {
          const upsertResponse = await admin.graphql(UPSERT_THEME_FILES, {
            variables: { themeId, files },
          });
          const upsertData = await upsertResponse.json();
          const userErrors = upsertData.data?.themeFilesUpsert?.userErrors ?? [];
          return {
            errors: userErrors.map((e: { message: string }) => e.message),
            upsertedFilenames:
              upsertData.data?.themeFilesUpsert?.upsertedThemeFiles?.map((f: { filename: string }) => f.filename) ?? [],
          };
        };

        // First pass. In "normalize" mode we rewrite settings-data richtext up front;
        // "autofix"/"error" push the merchant's HTML verbatim and only react on error.
        const filesToUpsert: Array<{ filename: string; body: { type: string; value: string } }> = [];
        const stagedKeys: string[] = [];
        for (const [filename, keys] of keysByFilename) {
          const result = buildFileEntry(filename, keys, richtextMode === "normalize");
          if (result.error) {
            fileShopifyErrors.push(result.error);
            failedPrimaryKeys.push(...keys);
            continue;
          }
          // A missed key means our stored old value no longer matches the theme
          // file (drifted content) — we could not locate it to replace, so it
          // cannot be saved. Report it instead of silently dropping it.
          if (result.missedKeys.length > 0) {
            failedPrimaryKeys.push(...result.missedKeys);
            primarySaveErrors.push(
              `Could not locate the current value in the theme file for: ${result.missedKeys.slice(0, 5).join(", ")} (reload the content and try again)`
            );
          }
          if (result.entry) {
            stagedKeys.push(...result.replacedKeys);
            filesToUpsert.push(result.entry);
            for (const [k, v] of result.pushedValues) pushedValueByKey.set(k, v);
          }
        }

        if (filesToUpsert.length > 0) {
          logger.info("[TEMPLATES] Pushing changes to Shopify via themeFilesUpsert", {
            context: "Templates",
            themeId,
            fileCount: filesToUpsert.length,
            filenames: filesToUpsert.map((f) => f.filename),
            richtextMode,
          });

          try {
            let { errors, upsertedFilenames } = await runUpsert(filesToUpsert);

            // AUTOFIX: Shopify rejected a settings_data.json richtext value for the
            // top-level-node rule. Re-normalize just that file and retry once.
            if (
              errors.length > 0 &&
              richtextMode === "autofix" &&
              errors.some(isRichtextTopLevelError) &&
              keysByFilename.has(SETTINGS_DATA_FILE)
            ) {
              logger.info("[TEMPLATES] Autofix: normalizing richtext settings and retrying upsert", {
                context: "Templates",
                errors,
              });
              const rebuilt = buildFileEntry(SETTINGS_DATA_FILE, keysByFilename.get(SETTINGS_DATA_FILE)!, true);
              if (rebuilt.entry) {
                const retryEntry = rebuilt.entry;
                const retryFiles = filesToUpsert.map((f) =>
                  f.filename === retryEntry.filename ? retryEntry : f
                );
                ({ errors, upsertedFilenames } = await runUpsert(retryFiles));
                // The retry wrote NORMALIZED values for the settings-data keys —
                // overwrite the raw first-pass values so the DB mirror matches the file.
                for (const [k, v] of rebuilt.pushedValues) pushedValueByKey.set(k, v);
              }
            }

            if (errors.length > 0) {
              logger.error("[TEMPLATES] themeFilesUpsert returned errors", { context: "Templates", errors });
              fileShopifyErrors.push(...errors);
              // Shopify rejected the batch — none of the staged keys persisted.
              failedPrimaryKeys.push(...stagedKeys);
              // Give richtext rejections a human-actionable hint (esp. in "error"
              // mode where we deliberately do not rewrite the merchant's HTML).
              if (errors.some(isRichtextTopLevelError)) {
                primarySaveErrors.push(
                  "This is a rich-text setting: every paragraph must be wrapped in a block (e.g. <p>…</p>). " +
                    "Enable automatic formatting under Settings → Rich-text formatting to fix this on save."
                );
              }
            } else {
              logger.info("[TEMPLATES] themeFilesUpsert succeeded", {
                context: "Templates",
                upsertedFiles: upsertedFilenames,
              });
              // Confirmed persisted to Shopify — safe to mirror into the local DB.
              for (const k of stagedKeys) pushedPrimaryKeys.add(k);
            }
          } catch (upsertError) {
            const msg = upsertError instanceof Error ? upsertError.message : String(upsertError);
            logger.error("[TEMPLATES] themeFilesUpsert failed", { context: "Templates", error: msg });
            if (msg.includes("access") || msg.includes("scope") || msg.includes("permission")) {
              return json(
                {
                  success: false,
                  error: `Shopify rejected the theme update. You may need the Protected Scope Exemption for write_themes. Error: ${msg}`,
                },
                { status: 403 }
              );
            }
            fileShopifyErrors.push(msg);
            failedPrimaryKeys.push(...stagedKeys);
          }
        }

        if (fileShopifyErrors.length > 0) {
          logger.error("[TEMPLATES] Shopify rejected part of the primary locale save", {
            context: "Templates",
            errors: fileShopifyErrors,
          });
          primarySaveErrors.push(...fileShopifyErrors);
        }
      }
    }

    // STEP 2b: Update primary locale in local DB (translatableContent in ThemeContent)
    // Only mirror keys Shopify actually accepted (pushedPrimaryKeys); keys that
    // failed to push keep their old DB value so DB and storefront stay in sync.
    for (const group of themeGroups) {
      const content = (group.translatableContent as unknown) as TranslatableField[];
      let hasChanges = false;

      for (const item of content) {
        if (updatedFields[item.key] !== undefined && pushedPrimaryKeys.has(item.key)) {
          // Mirror the value that actually landed in the theme file (normalized by
          // autofix/normalize where applicable), NOT the raw submitted value — see
          // pushedValueByKey. Falls back to the raw value for keys that were pushed
          // without any rewrite.
          item.value = pushedValueByKey.get(item.key) ?? updatedFields[item.key];
          hasChanges = true;
        }
      }

      if (hasChanges) {
        // updateMany: the unique key now carries themeId, but group.resourceId is
        // already theme-specific, so (shop, resourceId, groupId) targets the right row.
        await db.themeContent.updateMany({
          where: {
            shop: session.shop,
            resourceId: group.resourceId,
            groupId: groupId,
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data: { translatableContent: content as any, lastSyncedAt: new Date() },
        });
      }
    }

    // Delete translations for changed fields (they are now outdated).
    // Only invalidate translations for fields whose primary value actually
    // changed on Shopify — a field that failed to save still has matching
    // primary content, so its translations must not be dropped.
    // Merchant-switchable (Settings → Übersetzungen), failing OPEN.
    const { loadTranslationChangePolicy } = await import(
      "~/services/translations/translation-change-policy.server"
    );
    const savedChangedFields = changedFields.filter((k) => pushedPrimaryKeys.has(k));
    const changePolicy =
      savedChangedFields.length > 0 ? await loadTranslationChangePolicy(session.shop, db) : null;
    // Theme content is repaired by THIS save or by nothing: no sync and no
    // webhook in this app ever looks at a theme resource's translations. So
    // with auto-translate on the block further down replaces the stale values
    // and the deletion stands down — read through the policy, never written as
    // `false`, because which of the two switches applies is that module's
    // question. Without a known PRIMARY locale there is nothing to translate
    // FROM, so that case keeps deleting.
    // The locales are fetched FIRST, because the deletion decision depends on
    // whether the repair can actually run: standing the purge down and then
    // finding no locales left the stale theme translations live forever, on a
    // surface nothing else revisits. The product path was restructured for
    // exactly this.
    let themeForeignLocales: string[] = [];
    if (savedChangedFields.length > 0 && changePolicy?.autoTranslateExternalChanges) {
      try {
        const localesResponse = await admin.graphql(GET_SHOP_LOCALES);
        const localesData = await localesResponse.json();
        themeForeignLocales = (localesData.data?.shopLocales || [])
          .filter((l: { primary: boolean; published: boolean }) => !l.primary && l.published)
          .map((l: { locale: string }) => l.locale);
      } catch (localeError) {
        // Non-fatal: the primary push has already succeeded.
        logger.warn("[TEMPLATES] Could not load shop locales — falling back to the deletion", {
          context: "Templates",
          error: localeError instanceof Error ? localeError.message : String(localeError),
        });
      }
    }
    const retranslateTheme =
      !!changePolicy?.autoTranslateExternalChanges &&
      !!primaryLocale &&
      themeForeignLocales.length > 0;
    const purgeTheme =
      !!changePolicy &&
      (retranslateTheme
        ? changePolicy.purgeOnPrimaryChange
        : changePolicy.purgeUnreconciledSurfaces);
    if (savedChangedFields.length > 0 && purgeTheme) {
      logger.debug("[TEMPLATES] Deleting translations for changed fields", {
        context: "Templates",
        keysToDelete: savedChangedFields,
        groupId,
      });

      // STEP A: Delete from Shopify via translationsRemove
      const changedKeysByResource = new Map<string, string[]>();
      for (const key of savedChangedFields) {
        const resId = keyToResourceId.get(key) || resourceId;
        const existing = changedKeysByResource.get(resId) || [];
        existing.push(key);
        changedKeysByResource.set(resId, existing);
      }

      const localesResponse = await admin.graphql(GET_SHOP_LOCALES);
      const localesData = await localesResponse.json();
      const foreignLocales = (localesData.data?.shopLocales || [])
        .filter((l: { primary: boolean; published: boolean }) => !l.primary && l.published)
        .map((l: { locale: string }) => l.locale);

      if (foreignLocales.length > 0) {
        for (const [resId, keys] of changedKeysByResource) {
          try {
            const removeResponse = await admin.graphql(REMOVE_TRANSLATIONS, {
              variables: { resourceId: resId, translationKeys: keys, locales: foreignLocales },
            });
            const removeData = await removeResponse.json();

            if (removeData.data?.translationsRemove?.userErrors?.length > 0) {
              logger.warn("[TEMPLATES] Shopify translationsRemove errors (non-fatal)", {
                context: "Templates",
                errors: removeData.data.translationsRemove.userErrors,
                resourceId: resId,
                keys,
              });
            } else {
              logger.info("[TEMPLATES] Shopify translations removed", {
                context: "Templates",
                resourceId: resId,
                keyCount: keys.length,
                localeCount: foreignLocales.length,
              });
            }
          } catch (removeError) {
            logger.warn("[TEMPLATES] translationsRemove failed (non-fatal)", {
              context: "Templates",
              error: removeError instanceof Error ? removeError.message : String(removeError),
              resourceId: resId,
            });
          }
        }
      }

      // STEP B: Delete from local DB. Global-scoped (marketId "") to mirror the
      // global-only Shopify removal — market overrides survive on both sides.
      const deleteResult = await db.themeTranslation.deleteMany({
        where: { shop: session.shop, groupId: groupId, key: { in: savedChangedFields }, domain: domain, marketId: "" },
      });
      logger.debug("[TEMPLATES] Deleted translation entries", { context: "Templates", count: deleteResult.count });
    } else {
      logger.debug("[TEMPLATES] No changedFields to delete translations for", { context: "Templates" });
    }

    // …or REPLACE them. One group for the whole save: a theme group's keys can
    // sit on several theme resources, which is exactly the shape the repair is
    // generic over — one Task row, one batched detection, one AI request per
    // locale (chunked). Best-effort: the primary push has already succeeded, so
    // nothing here may fail the save.
    if (savedChangedFields.length > 0 && retranslateTheme) {
      try {
        const foreignLocales = themeForeignLocales;

        {
          const { reconcileAfterPrimarySave, themeTranslationMirror } = await import(
            "~/services/translations/stale-translation-sync.server"
          );
          await reconcileAfterPrimarySave({
            client: admin,
            shop: session.shop,
            // The GROUP is the theme group the merchant saved; each key names
            // the theme resource its translation actually lives on.
            resourceId,
            resourceType: "OnlineStoreTheme",
            // The AI prompt comes from `translateAs`; this only decides the
            // Task label, and `taskResourceType` keeps a theme group out of the
            // admin-path map, which has no entry for it and must not guess one.
            contentKind: "page",
            taskResourceType: "templates",
            resourceTitle: themeGroups?.find((g) => g.groupId === groupId)?.groupName || groupId,
            // §5.2 cross-theme guard, the same one the foreign REGISTER path
            // above applies: a stale or mis-scoped resource id would otherwise
            // have translations written into a FOREIGN theme by this path while
            // the sibling path in the very same request refuses the identical
            // write. Theme-agnostic resources (no embedded theme id) and an
            // unset selection are allowed, exactly as there.
            changed: savedChangedFields
              .map((key) => ({
                resourceId: keyToResourceId.get(key) || resourceId,
                resourceType: "OnlineStoreTheme",
                key,
                // A theme write lands in a FILE and is re-indexed afterwards,
                // so the repair's read-back can still answer with the previous
                // text. Naming what we pushed lets it tell that apart from a
                // value it may translate — the normalised one, which is what
                // the file actually holds.
                expectedValue: pushedValueByKey.get(key) ?? updatedFields[key],
              }))
              .filter((entry) => {
                const entryThemeId = extractThemeIdFromResourceId(entry.resourceId);
                if (!selectedThemeId || !entryThemeId || entryThemeId === selectedThemeId) {
                  return true;
                }
                logger.error("[TEMPLATES] Cross-theme re-translation blocked", {
                  context: "Templates",
                  resourceId: entry.resourceId,
                  entryThemeId,
                  selectedThemeId,
                });
                return false;
              }),
            foreignLocales,
            policy: changePolicy!,
            mirror: themeTranslationMirror(session.shop, groupId, domain),
            translateAs: {
              kind: "values",
              context: "storefront theme texts",
              sourceLocale: primaryLocale,
            },
          });
        }
      } catch (retranslateError) {
        logger.warn("[TEMPLATES] Theme re-translation failed — translations kept", {
          context: "Templates",
          groupId,
          error: retranslateError instanceof Error ? retranslateError.message : String(retranslateError),
        });
      }
    }

    // Surface any primary fields that did NOT reach Shopify. Without this the
    // handler would fall through to success: true while the storefront kept the
    // old value — the silent-save bug on Theme-Standardinhalte (locale content).
    if (failedPrimaryKeys.length > 0 || primarySaveErrors.length > 0) {
      const message =
        primarySaveErrors.length > 0
          ? primarySaveErrors.join("; ")
          : `Some fields could not be saved to Shopify: ${failedPrimaryKeys.slice(0, 5).join(", ")}`;
      logger.error("[TEMPLATES] Primary locale save did not fully persist to Shopify", {
        context: "Templates",
        failedPrimaryKeys,
        pushedCount: pushedPrimaryKeys.size,
      });
      return json(
        { success: false, error: message, actionType: "updateContent" },
        { status: 500 }
      );
    }
  } else {
    // Update translations: batch upsert non-empty values, delete cleared values
    const skippedSet = new Set(skippedKeys);
    const failedDeleteSet = new Set(failedDeleteKeys);

    const entriesToUpsert = Object.entries(updatedFields).filter(
      ([key, value]) => value !== "" && !skippedSet.has(key)
    );
    const keysToDelete = Object.entries(updatedFields)
      .filter(([key, value]) => value === "" && !failedDeleteSet.has(key))
      .map(([key]) => key);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbOps: any[] = [];

    for (const [key, value] of entriesToUpsert) {
      const keyResId = keyToResourceId.get(key) || resourceId;
      const keyThemeId = extractThemeIdFromResourceId(keyResId) ?? "";
      // Claim the resource the merchant just translated, on the GLOBAL layer
      // only: a detached theme re-translation writes global rows, so a MARKET
      // override edit can never collide with it — and aborting the run over one
      // would leave its remaining entries in neither list, on a surface nothing
      // else revisits.
      if (!marketId) markTranslationSaved(keyResId);
      dbOps.push(
        db.themeTranslation.upsert({
          where: {
            shop_resourceId_groupId_key_locale_themeId_marketId: {
              shop: session.shop,
              resourceId: keyResId,
              groupId: groupId,
              key: key,
              locale: locale,
              themeId: keyThemeId,
              marketId,
            },
          },
          update: { value: value, updatedAt: new Date() },
          create: {
            shop: session.shop,
            groupId: groupId,
            resourceId: keyResId,
            themeId: keyThemeId,
            domain: domain,
            locale: locale,
            key: key,
            value: value,
            marketId,
          },
        })
      );
    }

    if (keysToDelete.length > 0) {
      dbOps.push(
        db.themeTranslation.deleteMany({
          where: { shop: session.shop, groupId: groupId, key: { in: keysToDelete }, locale: locale, domain: domain, marketId },
        })
      );
    }

    if (dbOps.length > 0) {
      await db.$transaction(dbOps);
    }

    if (shopifyErrors.length > 0) {
      return json(
        {
          success: false,
          error: `Some translations could not be saved to Shopify: ${shopifyErrors.join("; ")}`,
          actionType: "updateContent",
        },
        { status: 500 }
      );
    }
  }

  return json({ success: true, actionType: "updateContent" });
}
