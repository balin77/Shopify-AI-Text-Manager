import { json } from "@remix-run/node";
import { ENABLE_THEME_PRIMARY_EDIT } from "~/config/constants";
import { getFormString, getFormJSON } from "~/utils/form-data.utils";
import { logger } from "~/utils/logger.server";
import { TRANSLATE_CONTENT, REMOVE_TRANSLATIONS, UPSERT_THEME_FILES } from "~/graphql/content.mutations";
import { GET_THEMES, GET_THEME_FILES, GET_SHOP_LOCALES } from "~/graphql/content.queries";
import { keyToFilename, replaceValuesInJson } from "~/utils/templates/templates.utils";
import type { TemplatesActionContext, TranslatableField } from "./shared";

export async function handleUpdateContent(ctx: TemplatesActionContext): Promise<Response> {
  const { admin, db, session, formData, groupId, domain, themeGroups, resourceId, keyToResourceId } = ctx;
  const locale = getFormString(formData, "locale");
  const primaryLocale = getFormString(formData, "primaryLocale");

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
    "imageAltTexts", "changedAltTextIndices", "contentType",
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
  const failedDeleteKeys: string[] = [];
  const shopifyErrors: string[] = [];

  // STEP 1: Register translations with Shopify (only for foreign locales)
  if (locale !== primaryLocale) {
    const digestMap = new Map<string, string>();
    for (const item of allContent) {
      if (item.digest) digestMap.set(item.key, item.digest);
    }

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

      const digest = digestMap.get(key) || "";
      if (!digest) {
        logger.warn("[TEMPLATES] No digest for key — skipping Shopify save", {
          context: "Templates",
          key,
          locale,
          resourceId: fieldResId,
        });
        skippedKeys.push(key);
        continue;
      }

      if (!translationsByResource.has(fieldResId)) translationsByResource.set(fieldResId, []);
      translationsByResource.get(fieldResId)!.push({ key, value, locale, translatableContentDigest: digest });
    }

    // Send one translationsRegister call per resource ID
    const shopifyErrors: string[] = [];
    for (const [resId, translationInputs] of translationsByResource) {
      if (translationInputs.length === 0) continue;

      logger.info("[TEMPLATES] Sending translations to Shopify", {
        context: "Templates",
        resourceId: resId,
        locale,
        fieldCount: translationInputs.length,
        sampleKeys: translationInputs.slice(0, 3).map((t) => t.key),
      });

      try {
        const response = await admin.graphql(TRANSLATE_CONTENT, {
          variables: { resourceId: resId, translations: translationInputs },
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
          logger.info("[TEMPLATES] Shopify translations registered successfully", {
            context: "Templates",
            locale,
            resourceId: resId,
            fieldCount: translationInputs.length,
          });
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

    // Delete cleared translations from Shopify via translationsRemove
    const failedDeleteKeys: string[] = [];
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
          variables: { resourceId: resId, translationKeys: keysToDelete, locales: [locale] },
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
          logger.info("[TEMPLATES] Cleared translations removed from Shopify", {
            context: "Templates",
            resourceId: resId,
            keyCount: keysToDelete.length,
            locale,
          });
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

        const filename = keyToFilename(key);
        if (filename) {
          const existing = keysByFilename.get(filename) || [];
          existing.push(key);
          keysByFilename.set(filename, existing);
        } else {
          unmappedKeys.push(key);
        }
      }

      if (unmappedKeys.length > 0) {
        logger.warn("[TEMPLATES] Keys could not be mapped to filenames — skipping Shopify push", {
          context: "Templates",
          unmappedKeys,
        });
      }

      if (keysByFilename.size > 0) {
        const themesResponse = await admin.graphql(GET_THEMES, { variables: { first: 10 } });
        const themesData = await themesResponse.json();
        const mainTheme = themesData.data?.themes?.edges?.find(
          (edge: { node: { role: string } }) => edge.node.role === "MAIN"
        );

        if (!mainTheme) {
          logger.error("[TEMPLATES] No MAIN theme found — cannot push primary locale changes", {
            context: "Templates",
          });
          return json(
            {
              success: false,
              error: "No active (MAIN) theme found. Cannot save primary locale changes to Shopify.",
            },
            { status: 500 }
          );
        }

        const themeId = mainTheme.node.id;
        const filenames = Array.from(keysByFilename.keys());

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

        const filesToUpsert: Array<{ filename: string; body: { type: string; value: string } }> = [];
        const fileShopifyErrors: string[] = [];

        for (const [filename, keys] of keysByFilename) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const fileNode = fileNodes.find((n: any) => n.filename === filename);

          logger.debug("[TEMPLATES] Theme file node details", {
            context: "Templates",
            filename,
            found: !!fileNode,
            bodyKeys: fileNode?.body ? Object.keys(fileNode.body) : null,
            bodyType: typeof fileNode?.body,
            contentPreview:
              typeof fileNode?.body?.content === "string"
                ? fileNode.body.content.substring(0, 300)
                : `(type: ${typeof fileNode?.body?.content})`,
          });

          const rawContent = fileNode?.body?.content ?? fileNode?.body;
          if (!rawContent || typeof rawContent !== "string") {
            logger.warn("[TEMPLATES] Theme file not found or no text content", {
              context: "Templates",
              filename,
              keys,
              rawContentType: typeof rawContent,
            });
            fileShopifyErrors.push(`File not found or not a text file: ${filename}`);
            continue;
          }

          const leadingCommentRegex = /^\s*\/\*[\s\S]*?\*\/\s*/;
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
            fileShopifyErrors.push(`Invalid JSON in file: ${filename}`);
            continue;
          }

          const replacements = new Map<string, { oldValue: string; newValue: string; keyHint: string }>();
          for (const key of keys) {
            const oldValue = oldValueMap.get(key) || "";
            const newValue = updatedFields[key];
            const keyParts = key.split(".");
            const keyHint = keyParts[keyParts.length - 1];
            replacements.set(key, { oldValue, newValue, keyHint });
          }

          const replacedKeys = replaceValuesInJson(fileJson, replacements);

          logger.info("[TEMPLATES] Value replacement results", {
            context: "Templates",
            filename,
            totalKeys: keys.length,
            replacedCount: replacedKeys.size,
            replacedKeys: Array.from(replacedKeys),
            missedKeys: keys.filter((k) => !replacedKeys.has(k)),
          });

          if (replacedKeys.size > 0) {
            filesToUpsert.push({
              filename,
              body: {
                type: "TEXT",
                value: hasLeadingComment
                  ? rawContent.match(leadingCommentRegex)![0] + JSON.stringify(fileJson, null, 2)
                  : JSON.stringify(fileJson, null, 2),
              },
            });
          }
        }

        if (filesToUpsert.length > 0) {
          logger.info("[TEMPLATES] Pushing changes to Shopify via themeFilesUpsert", {
            context: "Templates",
            themeId,
            fileCount: filesToUpsert.length,
            filenames: filesToUpsert.map((f) => f.filename),
          });

          try {
            const upsertResponse = await admin.graphql(UPSERT_THEME_FILES, {
              variables: { themeId, files: filesToUpsert },
            });
            const upsertData = await upsertResponse.json();

            if (upsertData.data?.themeFilesUpsert?.userErrors?.length > 0) {
              const errors = upsertData.data.themeFilesUpsert.userErrors;
              logger.error("[TEMPLATES] themeFilesUpsert returned errors", { context: "Templates", errors });
              fileShopifyErrors.push(...errors.map((e: { message: string }) => e.message));
            } else {
              logger.info("[TEMPLATES] themeFilesUpsert succeeded", {
                context: "Templates",
                upsertedFiles: upsertData.data?.themeFilesUpsert?.upsertedThemeFiles?.map(
                  (f: { filename: string }) => f.filename
                ),
              });
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
          }
        }

        if (fileShopifyErrors.length > 0) {
          logger.error("[TEMPLATES] Shopify rejected primary locale save — aborting without local DB update", {
            context: "Templates",
            errors: fileShopifyErrors,
          });
          return json(
            {
              success: false,
              error: `Shopify rejected the changes: ${fileShopifyErrors.join("; ")}`,
              actionType: "updateContent",
            },
            { status: 500 }
          );
        }
      }
    }

    // STEP 2b: Update primary locale in local DB (translatableContent in ThemeContent)
    for (const group of themeGroups) {
      const content = (group.translatableContent as unknown) as TranslatableField[];
      let hasChanges = false;

      for (const item of content) {
        if (updatedFields[item.key] !== undefined) {
          item.value = updatedFields[item.key];
          hasChanges = true;
        }
      }

      if (hasChanges) {
        await db.themeContent.update({
          where: {
            shop_resourceId_groupId: {
              shop: session.shop,
              resourceId: group.resourceId,
              groupId: groupId,
            },
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data: { translatableContent: content as any, lastSyncedAt: new Date() },
        });
      }
    }

    // Delete translations for changed fields (they are now outdated)
    if (changedFields.length > 0) {
      logger.debug("[TEMPLATES] Deleting translations for changed fields", {
        context: "Templates",
        keysToDelete: changedFields,
        groupId,
      });

      // STEP A: Delete from Shopify via translationsRemove
      const changedKeysByResource = new Map<string, string[]>();
      for (const key of changedFields) {
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

      // STEP B: Delete from local DB
      const deleteResult = await db.themeTranslation.deleteMany({
        where: { shop: session.shop, groupId: groupId, key: { in: changedFields }, domain: domain },
      });
      logger.debug("[TEMPLATES] Deleted translation entries", { context: "Templates", count: deleteResult.count });
    } else {
      logger.debug("[TEMPLATES] No changedFields to delete translations for", { context: "Templates" });
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
      dbOps.push(
        db.themeTranslation.upsert({
          where: {
            shop_resourceId_groupId_key_locale: {
              shop: session.shop,
              resourceId: keyResId,
              groupId: groupId,
              key: key,
              locale: locale,
            },
          },
          update: { value: value, updatedAt: new Date() },
          create: {
            shop: session.shop,
            groupId: groupId,
            resourceId: keyResId,
            domain: domain,
            locale: locale,
            key: key,
            value: value,
          },
        })
      );
    }

    if (keysToDelete.length > 0) {
      dbOps.push(
        db.themeTranslation.deleteMany({
          where: { shop: session.shop, groupId: groupId, key: { in: keysToDelete }, locale: locale, domain: domain },
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
