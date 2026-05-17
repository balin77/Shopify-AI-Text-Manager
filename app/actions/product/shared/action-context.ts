/**
 * Action Context
 *
 * Shared context preparation for all product actions.
 * Loads AI settings, instructions, and prepares services.
 */

import { logger } from "~/utils/logger.server";
import { tryDecryptApiKey } from "~/utils/encryption.server";
import type { Session } from "@shopify/shopify-api";
import { AIService, type AIProvider, toValidProvider } from "../../../../src/services/ai.service";
import { TranslationService } from "../../../../src/services/translation.service";
import { ShopifyApiGateway } from "~/services/shopify-api-gateway.service";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import type { PrismaClient } from "@prisma/client";

interface AIConfig {
  huggingfaceApiKey?: string;
  geminiApiKey?: string;
  claudeApiKey?: string;
  openaiApiKey?: string;
  grokApiKey?: string;
  deepseekApiKey?: string;
  selectedModel?: string;
}

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
  const provider = toValidProvider(aiSettings?.preferredProvider || process.env.AI_PROVIDER);

  const config: AIConfig = {
    huggingfaceApiKey: tryDecryptApiKey(aiSettings?.huggingfaceApiKey, "huggingface") || undefined,
    geminiApiKey: tryDecryptApiKey(aiSettings?.geminiApiKey, "gemini") || undefined,
    claudeApiKey: tryDecryptApiKey(aiSettings?.claudeApiKey, "claude") || undefined,
    openaiApiKey: tryDecryptApiKey(aiSettings?.openaiApiKey, "openai") || undefined,
    grokApiKey: tryDecryptApiKey(aiSettings?.grokApiKey, "grok") || undefined,
    deepseekApiKey: tryDecryptApiKey(aiSettings?.deepseekApiKey, "deepseek") || undefined,
    selectedModel: aiSettings?.selectedModel || undefined,
  };

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
