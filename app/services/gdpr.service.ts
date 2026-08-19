/**
 * GDPR Service
 *
 * Handles GDPR compliance requests from Shopify:
 * - customers/data_request: Export customer data
 * - customers/redact: Delete customer data
 * - shop/redact: Delete all shop data
 *
 * GDPR Requirements:
 * - Data requests: Must be fulfilled within 30 days
 * - Customer redaction: Must be completed within 30 days
 * - Shop redaction: Must be completed within 48 hours
 */

import { db } from "../db.server";
import { decryptPII } from "../utils/encryption.server";
import { logger } from "~/utils/logger.server";

/**
 * R5-G2: `BigInt(x)` THROWS on an empty / non-numeric / placeholder value.
 * Shopify's automated customers/data_request compliance test sends a signed
 * request whose customer.id may be empty/placeholder; an unguarded
 * BigInt(customer.id) made the handler 500, and the compliance check expects
 * 2xx for a valid signed request → App Store submission blocked. Parse
 * defensively and treat anything non-coercible as "no identifier".
 */
function toBigIntOrNull(value: unknown): bigint | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (s === '' || !/^-?\d+$/.test(s)) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

export interface GDPRCustomerDataRequest {
  shop_id: number;
  shop_domain: string;
  orders_requested: string[];
  customer: {
    id: number;
    email: string;
    phone: string;
  };
}

export interface GDPRCustomerRedactRequest {
  shop_id: number;
  shop_domain: string;
  customer: {
    id: number;
    email: string;
    phone: string;
  };
  orders_to_redact: string[];
}

export interface GDPRShopRedactRequest {
  shop_id: number;
  shop_domain: string;
}

/**
 * Export all data we have stored for a specific customer
 */
export async function exportCustomerData(
  request: GDPRCustomerDataRequest
): Promise<any> {
  const { shop_domain, customer } = request;

  logger.info(`[GDPR] Exporting data for customer ${customer.id} from shop ${shop_domain}`);

  // Find all sessions for this customer (by email or userId). R5-G2: build
  // the OR conditions defensively — only include the userId clause when the
  // id actually coerces to a BigInt, and only the email clause when present.
  // If neither identifier is usable (e.g. Shopify's compliance test
  // payload), return an empty-but-well-formed export instead of throwing.
  const userIdBig = toBigIntOrNull(customer?.id);
  const orConditions: Array<Record<string, unknown>> = [];
  if (customer?.email) orConditions.push({ email: customer.email });
  if (userIdBig !== null) orConditions.push({ userId: userIdBig });

  const sessions = orConditions.length === 0
    ? []
    : await db.session.findMany({
    where: {
      shop: shop_domain,
      OR: orConditions,
    },
    select: {
      id: true,
      shop: true,
      userId: true,
      firstName: true,
      lastName: true,
      email: true,
      locale: true,
      accountOwner: true,
      collaborator: true,
      emailVerified: true,
      lastActivityAt: true,
      // Don't export sensitive tokens
      // accessToken: false,
      // refreshToken: false,
    },
  });

  // Convert BigInt to string and decrypt PII for JSON serialization
  const sanitizedSessions = sessions.map(session => ({
    ...session,
    userId: session.userId ? session.userId.toString() : null,
    // Decrypt PII data before exporting (GDPR right to access requires readable data)
    firstName: decryptPII(session.firstName),
    lastName: decryptPII(session.lastName),
    email: decryptPII(session.email),
  }));

  const exportData = {
    customer: {
      id: customer.id,
      email: customer.email,
      phone: customer.phone,
    },
    shop: shop_domain,
    sessions: sanitizedSessions,
    dataCollected: {
      personalData: {
        firstName: decryptPII(sessions[0]?.firstName) || null,
        lastName: decryptPII(sessions[0]?.lastName) || null,
        email: decryptPII(sessions[0]?.email) || null,
        locale: sessions[0]?.locale || null,
      },
      metadata: {
        accountOwner: sessions[0]?.accountOwner || false,
        collaborator: sessions[0]?.collaborator || false,
        emailVerified: sessions[0]?.emailVerified || false,
        lastActivity: sessions[0]?.lastActivityAt || null,
      },
    },
    note: "This app only stores session data for authentication purposes. No order data, payment information, or other sensitive data is stored. PII data is encrypted at rest for security.",
  };

  logger.info(`[GDPR] Exported data for customer ${customer.id}: ${sessions.length} sessions found`);

  return exportData;
}

/**
 * Delete all data we have stored for a specific customer
 */
export async function redactCustomerData(
  request: GDPRCustomerRedactRequest
): Promise<void> {
  const { shop_domain, customer } = request;

  logger.info(`[GDPR] Redacting data for customer ${customer.id} from shop ${shop_domain}`);

  // R5-G2: mirror exportCustomerData's defensive parsing — an unguarded
  // BigInt(customer.id) throws on an empty/non-numeric/placeholder value
  // (e.g. Shopify's compliance test payload), which made this handler 500
  // instead of redacting what it safely can.
  const userIdBig = toBigIntOrNull(customer?.id);
  const orConditions: Array<Record<string, unknown>> = [];
  if (customer?.email) orConditions.push({ email: customer.email });
  if (userIdBig !== null) orConditions.push({ userId: userIdBig });

  // Delete all sessions for this customer
  const deleted = orConditions.length === 0
    ? { count: 0 }
    : await db.session.deleteMany({
      where: {
        shop: shop_domain,
        OR: orConditions,
      },
    });

  logger.info(`[GDPR] Redacted ${deleted.count} sessions for customer ${customer.id}`);
}

/**
 * Delete ALL data for a shop (when app is uninstalled / shop/redact webhook).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * COMPLETENESS CONTRACT — read before adding a Prisma model
 * ────────────────────────────────────────────────────────────────────────────
 * Every shop-scoped table MUST be purged here, filtered strictly by the
 * incoming `shop_domain` (NEVER an unscoped/`startsWith` delete — that would
 * wipe other tenants, see regression R1).
 *
 * Coverage of all 59 models in prisma/schema.prisma:
 *
 *  • Explicitly deleted below (scope field in parentheses):
 *      Session, AISettings, AIInstructions, Task, Product, Collection,
 *      Article, Page, ShopPolicy, Menu, ProductCollection,
 *      ContentTranslation, ThemeContent,
 *      ThemeTranslation, WebhookLog, WebhookRetry, OptionValueMemory,
 *      GroupedFieldTranslation, AltTextTemplate, MetaobjectDefinition,
 *      Metaobject, MetaobjectTranslation, ShopInstallState,
 *      ImageOperationCounter, EnabledMetafieldDefinition,
 *      DirectTranslationItem, DirectTranslationCandidate,
 *      DirectTranslationSettings, Seo404Hit, SeoAiReferral, SeoKeyword,
 *      SeoKeywordAssignment, SeoKeywordGroup, SeoKeywordGroupMembership,
 *      SeoKeywordSnapshot,
 *      GoogleSearchConsoleConnection, SeoIndexNowConfig,
 *      SeoIndexNowQueue, SeoScoreSnapshot, SeoPageSpeedAudit,
 *      GlossaryEntry, SeoWebVitalSample, SeoCrawlSnapshot, SeoCrawlPage,
 *      SeoCrawlBrokenLink, SeoCrawlExternalLink, SeoGscPageStat,
 *      SeoInternalLinkSuggestion,
 *      SeoSitemapExclusion, MediaLibraryImage, MediaLibrarySyncState
 *                                                 (all scoped by `shop`)
 *      ImageManagerSettings                      (scoped by `shopId`)
 *
 *  • Removed transitively via `onDelete: Cascade` — do NOT delete explicitly:
 *      through Product: ProductImage, ProductImageAltTranslation (cascade
 *      through ProductImage), ProductOption, ProductMetafield, ProductVariant;
 *      through DirectTranslationItem: DirectTranslation.
 *
 *  • Deliberately RETAINED: GdprAuditLog — mandatory 3-year retention
 *    (Art. 5(2) GDPR). Its time-based upper bound is enforced by
 *    GdprAuditLogCleanupService — it runs daily and deletes rows where
 *    requestedAt < now − 3 years. Never deleted here. Two copies exist on
 *    purpose: gdpr-audit-cleanup.service.js in the repo root is the one
 *    server.js actually starts (plain JS, loaded by Node without the app
 *    build), src/services/gdpr-audit-cleanup.service.ts is the typed twin
 *    covered by tests/unit/gdpr-audit-cleanup.service.test.ts. Change both.
 *
 * A schema-coverage guard in tests/unit/gdpr.service.test.ts parses
 * schema.prisma and fails if a new shop-scoped model is added without being
 * accounted for above. If that test fails: add the deleteMany here (or, if the
 * table cascades / is intentionally retained, extend the test's allowlist).
 * ────────────────────────────────────────────────────────────────────────────
 */
export async function redactShopData(
  request: GDPRShopRedactRequest
): Promise<void> {
  const { shop_domain } = request;

  logger.info(`[GDPR] Redacting ALL data for shop ${shop_domain}`);

  // Use a transaction to delete all data atomically
  await db.$transaction(async (tx) => {
    // 1. Delete all sessions
    const sessionsDeleted = await tx.session.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${sessionsDeleted.count} sessions`);

    // 2. Delete AI settings
    const aiSettingsDeleted = await tx.aISettings.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${aiSettingsDeleted.count} AI settings`);

    // 3. Delete AI instructions
    const aiInstructionsDeleted = await tx.aIInstructions.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${aiInstructionsDeleted.count} AI instructions`);

    // 4. Delete tasks
    const tasksDeleted = await tx.task.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${tasksDeleted.count} tasks`);

    // 5. Delete products (cascade will delete translations, images, etc.)
    // ProductCollection cascades through Product, but is deleted explicitly
    // anyway: it is shop-scoped in its own right, and a purge that depends on
    // the FK would silently miss rows whose product row was already gone.
    const productCollectionsDeleted = await tx.productCollection.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${productCollectionsDeleted.count} product-collection memberships`);

    // PLAN_CONTENT_CREATION Phase 4 — the commerce tables. Same reasoning as
    // ProductCollection above: they cascade through Product / ProductVariant,
    // and are deleted explicitly anyway because they are shop-scoped in their
    // own right and a purge that leans on the FK misses rows whose parent was
    // already gone. InventoryLevel first — it references Location.
    const inventoryLevelsDeleted = await tx.inventoryLevel.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${inventoryLevelsDeleted.count} inventory levels`);

    const publicationsDeleted = await tx.productPublication.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${publicationsDeleted.count} product publications`);

    const locationsDeleted = await tx.location.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${locationsDeleted.count} locations`);

    const productsDeleted = await tx.product.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${productsDeleted.count} products (with cascading relations)`);

    // 6. Delete collections
    const collectionsDeleted = await tx.collection.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${collectionsDeleted.count} collections`);

    // 7. Delete articles
    const articlesDeleted = await tx.article.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${articlesDeleted.count} articles`);

    // 8. Delete pages
    const pagesDeleted = await tx.page.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${pagesDeleted.count} pages`);

    // 9. Delete shop policies
    const policiesDeleted = await tx.shopPolicy.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${policiesDeleted.count} shop policies`);

    // 10. Delete menus
    const menusDeleted = await tx.menu.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${menusDeleted.count} menus`);

    // 11. Delete content translations
    //     R1 FIX: must be scoped by `shop`. The previous `resourceId
    //     startsWith 'gid://shopify/'` filter matched EVERY tenant's rows and
    //     deleted all shops' translations on any single shop/redact.
    const contentTranslationsDeleted = await tx.contentTranslation.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${contentTranslationsDeleted.count} content translations`);

    // 12. Delete theme content
    const themeContentDeleted = await tx.themeContent.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${themeContentDeleted.count} theme content entries`);

    // 13. Delete theme translations
    const themeTranslationsDeleted = await tx.themeTranslation.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${themeTranslationsDeleted.count} theme translations`);

    // 14. Delete webhook logs
    const webhookLogsDeleted = await tx.webhookLog.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${webhookLogsDeleted.count} webhook logs`);

    // 15. Delete webhook retry queue (R2)
    const webhookRetriesDeleted = await tx.webhookRetry.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${webhookRetriesDeleted.count} webhook retries`);

    // 16. Delete option-value translation memory (R2)
    const optionValueMemoryDeleted = await tx.optionValueMemory.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${optionValueMemoryDeleted.count} option value memory entries`);

    // 17. Delete grouped-field translations (R2)
    const groupedFieldTranslationsDeleted = await tx.groupedFieldTranslation.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${groupedFieldTranslationsDeleted.count} grouped field translations`);

    // 18. Delete alt-text templates (R2)
    const altTextTemplatesDeleted = await tx.altTextTemplate.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${altTextTemplatesDeleted.count} alt text templates`);

    // 19. Delete image manager settings (R2) — NOTE: scoped by `shopId`
    //     (stores the shop domain), not `shop`.
    const imageManagerSettingsDeleted = await tx.imageManagerSettings.deleteMany({
      where: { shopId: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${imageManagerSettingsDeleted.count} image manager settings`);

    // 20. Delete metaobject definitions (R2)
    const metaobjectDefinitionsDeleted = await tx.metaobjectDefinition.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${metaobjectDefinitionsDeleted.count} metaobject definitions`);

    // 21. Delete metaobjects (R2)
    const metaobjectsDeleted = await tx.metaobject.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${metaobjectsDeleted.count} metaobjects`);

    // 22. Delete metaobject translations (R2)
    const metaobjectTranslationsDeleted = await tx.metaobjectTranslation.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${metaobjectTranslationsDeleted.count} metaobject translations`);

    // 24. Delete install-state marker (R3) — leaving no residue keeps both the
    //     shop/redact webhook and the 30-day reaper idempotent (a redelivered
    //     request finds no marker and deletes 0 rows everywhere).
    const shopInstallStateDeleted = await tx.shopInstallState.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${shopInstallStateDeleted.count} install-state rows`);

    // 24. Delete image-operation usage counters — shop-identifying usage data
    //     (Art. 17). Without this, monthly counters keyed by `shop` survive
    //     redaction indefinitely.
    const imageOperationCountersDeleted = await tx.imageOperationCounter.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${imageOperationCountersDeleted.count} image operation counters`);

    // 25. Delete enabled metafield-definition selections — shop-scoped config
    //     (which product metafields the merchant enabled for translation).
    const enabledMetafieldDefsDeleted = await tx.enabledMetafieldDefinition.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${enabledMetafieldDefsDeleted.count} enabled metafield definitions`);

    // 26. Delete direct translations ("Direktübersetzungen") + settings —
    //     shop-scoped merchant-authored content for the client-side translation
    //     layer. DirectTranslation rows cascade via DirectTranslationItem.
    const directTranslationItemsDeleted = await tx.directTranslationItem.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${directTranslationItemsDeleted.count} direct translation items (with cascading translations)`);

    const directTranslationSettingsDeleted = await tx.directTranslationSettings.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${directTranslationSettingsDeleted.count} direct translation settings`);

    const directTranslationCandidatesDeleted = await tx.directTranslationCandidate.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${directTranslationCandidatesDeleted.count} direct translation candidates`);

    // SEO tab Phase 3: storefront 404-hit collector (shop-scoped usage data).
    const seo404HitsDeleted = await tx.seo404Hit.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${seo404HitsDeleted.count} SEO 404 hits`);

    // AI referral tracking (aggregate visits from ChatGPT/Perplexity/...).
    // Shop-scoped usage data, no visitor identifiers — deleted with the shop
    // all the same.
    const seoAiReferralsDeleted = await tx.seoAiReferral.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${seoAiReferralsDeleted.count} AI referral rows`);

    // Ranking history for SEO keyword assignments (shop-scoped). Deleted
    // before the assignment/keyword tables even though it also cascades on
    // assignmentId, so the count logged here is meaningful rather than
    // always zero.
    const seoKeywordSnapshotsDeleted = await tx.seoKeywordSnapshot.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${seoKeywordSnapshotsDeleted.count} SEO keyword snapshots`);

    // Keywords expansion (PLAN_KEYWORDS_EXPANSION.md §2.3): assignment /
    // group / membership rows all carry their own shop column and are deleted
    // explicitly (the schema-coverage guard checks the shop field, not
    // cascades), children before parents so the logged counts stay meaningful.
    const seoKeywordAssignmentsDeleted = await tx.seoKeywordAssignment.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${seoKeywordAssignmentsDeleted.count} SEO keyword assignments`);

    const seoKeywordGroupMembershipsDeleted = await tx.seoKeywordGroupMembership.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${seoKeywordGroupMembershipsDeleted.count} SEO keyword group memberships`);

    const seoKeywordGroupsDeleted = await tx.seoKeywordGroup.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${seoKeywordGroupsDeleted.count} SEO keyword groups`);

    // SEO tab Phase 5: tracked keywords (shop-scoped; standalone objects since
    // the keywords expansion — assignment rows above carry the item linkage).
    const seoKeywordsDeleted = await tx.seoKeyword.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${seoKeywordsDeleted.count} SEO keywords`);

    // SEO tab Phase 6: Google Search Console connection (encrypted refresh token).
    const gscConnectionsDeleted = await tx.googleSearchConsoleConnection.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${gscConnectionsDeleted.count} GSC connections`);

    // SEO tab Phase 8: IndexNow config + submit queue (shop-scoped).
    const indexNowConfigsDeleted = await tx.seoIndexNowConfig.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${indexNowConfigsDeleted.count} IndexNow configs`);

    const indexNowQueueDeleted = await tx.seoIndexNowQueue.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${indexNowQueueDeleted.count} IndexNow queue rows`);

    // SEO Audit Dashboard: persisted analyzeStore() snapshots (shop-scoped).
    const seoScoreSnapshotsDeleted = await tx.seoScoreSnapshot.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${seoScoreSnapshotsDeleted.count} SEO score snapshots`);

    // PageSpeed audits: cached PSI results incl. storefront screenshots (shop-scoped).
    const pageSpeedAuditsDeleted = await tx.seoPageSpeedAudit.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${pageSpeedAuditsDeleted.count} PageSpeed audits`);

    // Glossary: merchant terminology (GlossaryEntryTranslation cascades).
    const glossaryEntriesDeleted = await tx.glossaryEntry.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${glossaryEntriesDeleted.count} glossary entries`);

    // SEO tab Performance section, Phase 2: real-user web-vitals (RUM)
    // samples beaconed from the storefront (shop-scoped, no visitor
    // identifiers — see web-vitals.types.ts).
    const seoWebVitalSamplesDeleted = await tx.seoWebVitalSample.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${seoWebVitalSamplesDeleted.count} SEO web-vital samples`);

    // Phase 1 (storefront crawler, PLAN_SEO_SUITE_COMPLETION.md §2/§3):
    // children before the parent so the logged counts stay meaningful, even
    // though onDelete: Cascade on snapshotId would clean them up either way.
    const seoCrawlBrokenLinksDeleted = await tx.seoCrawlBrokenLink.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${seoCrawlBrokenLinksDeleted.count} SEO crawl broken links`);

    // PLAN_SEO_CRAWL_EXPANSION §6: outbound links to other domains, found by
    // the same crawl — another child of the snapshot.
    const seoCrawlExternalLinksDeleted = await tx.seoCrawlExternalLink.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${seoCrawlExternalLinksDeleted.count} SEO crawl external links`);

    const seoCrawlPagesDeleted = await tx.seoCrawlPage.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${seoCrawlPagesDeleted.count} SEO crawl pages`);

    const seoCrawlSnapshotsDeleted = await tx.seoCrawlSnapshot.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${seoCrawlSnapshotsDeleted.count} SEO crawl snapshots`);

    // Phase 3 (Content-Freshness audit, PLAN_SEO_SUITE_COMPLETION.md §2/§5.1
    // option b): per-page GSC rollup. The "Ignorieren" dismissed-list itself
    // is a JSON column on AISettings (already purged above), not a separate
    // model.
    const seoGscPageStatsDeleted = await tx.seoGscPageStat.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${seoGscPageStatsDeleted.count} SEO GSC page stats`);

    // Phase 2 (Internal Linking, PLAN_SEO_SUITE_COMPLETION.md §2/§4):
    // suggested internal links between DB-cached content.
    const seoInternalLinkSuggestionsDeleted = await tx.seoInternalLinkSuggestion.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${seoInternalLinkSuggestionsDeleted.count} SEO internal link suggestions`);

    // Phase 4 (Sitemap / indexation control, PLAN_SEO_SUITE_COMPLETION.md
    // §2/§6): sitemap-exclusion suggestions + applied/reverted decisions.
    const seoSitemapExclusionsDeleted = await tx.seoSitemapExclusion.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${seoSitemapExclusionsDeleted.count} SEO sitemap exclusions`);

    // Delete the media-library cache (Shopify Files / MediaImage) plus its
    // sync marker. Both are shop-scoped caches with no cascade parent, so
    // they must be purged explicitly.
    const mediaLibraryImagesDeleted = await tx.mediaLibraryImage.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${mediaLibraryImagesDeleted.count} media library images`);

    const mediaLibrarySyncStateDeleted = await tx.mediaLibrarySyncState.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${mediaLibrarySyncStateDeleted.count} media library sync state rows`);
  });

  logger.info(`[GDPR] Successfully redacted ALL data for shop ${shop_domain}`);
}

/**
 * Log GDPR request for compliance audit trail.
 *
 * Persists every GDPR webhook event to the GdprAuditLog table. The mandatory
 * 3-year retention period (Art. 5(2) GDPR) is enforced by
 * GdprAuditLogCleanupService (gdpr-audit-cleanup.service.js in the repo root is
 * what server.js starts; src/services/gdpr-audit-cleanup.service.ts is its
 * tested twin), which runs daily and deletes only rows where
 * requestedAt < now − 3 years.
 */
export async function logGDPRRequest(
  shop: string,
  requestType: 'data_request' | 'customer_redact' | 'shop_redact',
  customerId?: number | string | null,
  customerEmail?: string,
  dataExported?: unknown,
  error?: string,
  webhookId?: string | null,
): Promise<void> {
  const status = error ? 'failed' : 'completed';
  // R5-G1: previously only a 500-char SNIPPET was stored, and the admin page
  // never surfaced it — so a customers/data_request was a silent no-op (the
  // merchant could never actually obtain the data Shopify obliges them to
  // provide). Persist the FULL export JSON (the column is @db.Text; the
  // stored data is only session rows so it is small). The 1 MB cap is just a
  // defensive bound against a pathological payload, not the old truncation.
  const dataExportedJson = dataExported
    ? JSON.stringify(dataExported).slice(0, 1_000_000)
    : null;

  logger.info(`[GDPR] ${requestType} for shop=${shop} status=${status}`, {
    customerId,
    customerEmail,
    error,
    webhookId,
  });

  await db.gdprAuditLog.create({
    data: {
      shop,
      requestType,
      // R5-G2: never let an empty/placeholder id throw here either.
      customerId: toBigIntOrNull(customerId),
      customerEmail: customerEmail ?? null,
      status,
      dataExported: dataExportedJson,
      error: error ?? null,
      // R5-G4: Shopify redelivers a non-2xx compliance webhook for up to
      // ~48h. Storing X-Shopify-Webhook-Id lets the (deliberately
      // append-only, 3-year-retained) audit trail CORRELATE the duplicate
      // attempts instead of presenting contradictory rows with no link.
      webhookId: webhookId ?? null,
      completedAt: new Date(),
    },
  });
}
