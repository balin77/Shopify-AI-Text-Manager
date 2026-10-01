/**
 * Action Context
 *
 * Shared context preparation for all product actions.
 * Loads AI settings, instructions, and prepares services.
 */

import { logger } from "~/utils/logger.server";
import type { Session } from "@shopify/shopify-api";
import { AIService, type AIProvider, type AIServiceConfig } from "../../../../src/services/ai.service";
import { TranslationService } from "../../../../src/services/translation.service";
import { ShopifyApiGateway } from "~/services/shopify-api-gateway.service";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { PrismaClient } from "@prisma/client";
import { aiCredentialsFor } from "~/services/ai/ai-credentials.server";

/**
 * The AI credential config an action context carries.
 *
 * An ALIAS, not a shape of its own. It used to be a hand-written structural
 * subset that omitted `preflight` and `managedRefusal` — so the managed budget
 * gate travelled through it at runtime while being invisible to the type
 * system, and any future `{ ...context.config }` rebuild would have dropped it
 * silently and typechecked clean.
 */
type AIConfig = AIServiceConfig;

export interface ActionContext {
  admin: AdminApiContext;
  session: Session;
  shop: string;
  db: PrismaClient;
  provider: AIProvider;
  config: AIConfig;
  gateway: ShopifyApiGateway;
}

/**
 * Prepares shared context for all product actions
 */
export async function prepareActionContext(
  admin: AdminApiContext,
  session: Session
): Promise<ActionContext> {
  const { db } = await import("~/db.server");
  const shop = session.shop;

  logger.debug("Preparing action context", {
    context: "ActionContext",
    shop,
  });

  // Load AI settings
  let aiSettings = await db.aISettings.findUnique({
    where: { shop },
  });

  // Load or create AI instructions atomically (upsert avoids TOCTOU race condition)
  const { DEFAULT_PRODUCT_INSTRUCTIONS } = await import(
    "~/constants/aiInstructionsDefaults"
  );

  const defaultData = {
    productTitleFormat: DEFAULT_PRODUCT_INSTRUCTIONS.titleFormat,
    productTitleInstructions: DEFAULT_PRODUCT_INSTRUCTIONS.titleInstructions,
    productDescriptionFormat: DEFAULT_PRODUCT_INSTRUCTIONS.descriptionFormat,
    productDescriptionInstructions:
      DEFAULT_PRODUCT_INSTRUCTIONS.descriptionInstructions,
    productHandleFormat: DEFAULT_PRODUCT_INSTRUCTIONS.handleFormat,
    productHandleInstructions: DEFAULT_PRODUCT_INSTRUCTIONS.handleInstructions,
    productSeoTitleFormat: DEFAULT_PRODUCT_INSTRUCTIONS.seoTitleFormat,
    productSeoTitleInstructions:
      DEFAULT_PRODUCT_INSTRUCTIONS.seoTitleInstructions,
    productMetaDescFormat: DEFAULT_PRODUCT_INSTRUCTIONS.metaDescFormat,
    productMetaDescInstructions:
      DEFAULT_PRODUCT_INSTRUCTIONS.metaDescInstructions,
    productAltTextFormat: DEFAULT_PRODUCT_INSTRUCTIONS.altTextFormat,
    productAltTextInstructions:
      DEFAULT_PRODUCT_INSTRUCTIONS.altTextInstructions,
  };

  let aiInstructions = await db.aIInstructions.upsert({
    where: { shop },
    create: {
      shop,
      ...defaultData,
    },
    update: {},
  });

  // Back-fill missing fields on existing rows
  if (!aiInstructions.productSeoTitleInstructions) {
    logger.info("Updating AI instructions with defaults", {
      context: "ActionContext",
      shop,
    });

    aiInstructions = await db.aIInstructions.update({
      where: { shop },
      data: {
        productTitleFormat:
          aiInstructions.productTitleFormat ||
          DEFAULT_PRODUCT_INSTRUCTIONS.titleFormat,
        productTitleInstructions:
          aiInstructions.productTitleInstructions ||
          DEFAULT_PRODUCT_INSTRUCTIONS.titleInstructions,
        productDescriptionFormat:
          aiInstructions.productDescriptionFormat ||
          DEFAULT_PRODUCT_INSTRUCTIONS.descriptionFormat,
        productDescriptionInstructions:
          aiInstructions.productDescriptionInstructions ||
          DEFAULT_PRODUCT_INSTRUCTIONS.descriptionInstructions,
        productHandleFormat:
          aiInstructions.productHandleFormat ||
          DEFAULT_PRODUCT_INSTRUCTIONS.handleFormat,
        productHandleInstructions:
          aiInstructions.productHandleInstructions ||
          DEFAULT_PRODUCT_INSTRUCTIONS.handleInstructions,
        productSeoTitleFormat:
          aiInstructions.productSeoTitleFormat ||
          DEFAULT_PRODUCT_INSTRUCTIONS.seoTitleFormat,
        productSeoTitleInstructions:
          aiInstructions.productSeoTitleInstructions ||
          DEFAULT_PRODUCT_INSTRUCTIONS.seoTitleInstructions,
        productMetaDescFormat:
          aiInstructions.productMetaDescFormat ||
          DEFAULT_PRODUCT_INSTRUCTIONS.metaDescFormat,
        productMetaDescInstructions:
          aiInstructions.productMetaDescInstructions ||
          DEFAULT_PRODUCT_INSTRUCTIONS.metaDescInstructions,
        productAltTextFormat:
          aiInstructions.productAltTextFormat ||
          DEFAULT_PRODUCT_INSTRUCTIONS.altTextFormat,
        productAltTextInstructions:
          aiInstructions.productAltTextInstructions ||
          DEFAULT_PRODUCT_INSTRUCTIONS.altTextInstructions,
      },
    });
  }

  // Prepare provider and config
  // PLAN_MANAGED_AI_KEY §5 — whose key this call spends is the resolver's
  // answer, not a config literal built here. Ten copies of those six
  // decrypt lines are what made "the operator key has one reader"
  // impossible to state.
  const aiCredentials = aiCredentialsFor(aiSettings, shop);
  const provider = aiCredentials.provider;

  const config = aiCredentials.config;

  // Create Shopify API Gateway
  const gateway = new ShopifyApiGateway(admin, shop);

  logger.debug("Action context prepared", {
    context: "ActionContext",
    shop,
    provider,
    hasAISettings: !!aiSettings,
    hasAIInstructions: !!aiInstructions,
  });

  return {
    admin,
    session,
    shop,
    db,
    provider,
    config,
    gateway,
  };
}

/**
 * Creates an AI Service instance from context
 */
export function createAIService(
  context: ActionContext,
  taskId: string
): AIService {
  return new AIService(context.provider, context.config, context.shop, taskId);
}

/**
 * Creates a Translation Service instance from context
 */
export function createTranslationService(context: ActionContext): TranslationService {
  return new TranslationService(context.provider, context.config, context.shop);
}
