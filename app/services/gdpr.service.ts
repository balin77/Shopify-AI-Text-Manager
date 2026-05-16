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

  // Find all sessions for this customer (by email or userId)
  const sessions = await db.session.findMany({
    where: {
      shop: shop_domain,
      OR: [
        { email: customer.email },
        { userId: BigInt(customer.id) },
      ],
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

  // Delete all sessions for this customer
  const deleted = await db.session.deleteMany({
    where: {
      shop: shop_domain,
      OR: [
        { email: customer.email },
        { userId: BigInt(customer.id) },
      ],
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
 * Coverage of all 29 models in prisma/schema.prisma:
 *
 *  • Explicitly deleted below (scope field in parentheses):
 *      Session, AISettings, AIInstructions, Task, Product, Collection,
 *      Article, Page, ShopPolicy, Menu, ContentTranslation, ThemeContent,
 *      ThemeTranslation, WebhookLog, WebhookRetry, OptionValueMemory,
 *      GroupedFieldTranslation, AltTextTemplate, MetaobjectDefinition,
 *      Metaobject, MetaobjectTranslation, ShopInstallState
 *                                                (all scoped by `shop`)
 *      ImageManagerSettings                      (scoped by `shopId`)
 *
 *  • Removed transitively via Product `onDelete: Cascade` — do NOT delete
 *    explicitly: ProductImage, ProductImageAltTranslation (cascade through
 *    ProductImage), ProductOption, ProductMetafield, ProductVariant.
 *
 *  • Deliberately RETAINED: GdprAuditLog — mandatory 3-year retention
 *    (Art. 5(2) GDPR). Its time-based upper bound is enforced by
 *    GdprAuditLogCleanupService
 *    (src/services/gdpr-audit-cleanup.service.ts; standalone mirror
 *    gdpr-audit-cleanup.service.js, started from server.js, runs daily and
 *    deletes rows where requestedAt < now − 3 years). Never deleted here.
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

    // 23. Delete install-state marker (R3) — leaving no residue keeps both the
    //     shop/redact webhook and the 30-day reaper idempotent (a redelivered
    //     request finds no marker and deletes 0 rows everywhere).
    const shopInstallStateDeleted = await tx.shopInstallState.deleteMany({
      where: { shop: shop_domain },
    });
    logger.debug(`[GDPR] Deleted ${shopInstallStateDeleted.count} install-state rows`);
  });

  logger.info(`[GDPR] Successfully redacted ALL data for shop ${shop_domain}`);
}

/**
 * Log GDPR request for compliance audit trail.
 *
 * Persists every GDPR webhook event to the GdprAuditLog table. The mandatory
 * 3-year retention period (Art. 5(2) GDPR) is enforced by
 * GdprAuditLogCleanupService (src/services/gdpr-audit-cleanup.service.ts;
 * standalone mirror gdpr-audit-cleanup.service.js, started from server.js),
 * which runs daily and deletes only rows where requestedAt < now − 3 years.
 */
export async function logGDPRRequest(
  shop: string,
  requestType: 'data_request' | 'customer_redact' | 'shop_redact',
  customerId?: number,
  customerEmail?: string,
  dataExported?: unknown,
  error?: string
): Promise<void> {
  const status = error ? 'failed' : 'completed';
  const dataExportedSnippet = dataExported
    ? JSON.stringify(dataExported).substring(0, 500)
    : null;

  logger.info(`[GDPR] ${requestType} for shop=${shop} status=${status}`, {
    customerId,
    customerEmail,
    error,
  });

  await db.gdprAuditLog.create({
    data: {
      shop,
      requestType,
      customerId: customerId != null ? BigInt(customerId) : null,
      customerEmail: customerEmail ?? null,
      status,
      dataExported: dataExportedSnippet,
      error: error ?? null,
      completedAt: new Date(),
    },
  });
}
