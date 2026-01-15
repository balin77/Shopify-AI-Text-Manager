/**
 * Action Context
 *
 * Shared context preparation for all product actions.
 * Loads AI settings, instructions, and prepares services.
 */

import { logger } from "~/utils/logger.server";
import { decryptApiKey } from "~/utils/encryption.server";
import type { Session } from "@shopify/shopify-api";
import { AIService } from "../../../../src/services/ai.service";
import { TranslationService } from "../../../../src/services/translation.service";
import { ShopifyApiGateway } from "~/services/shopify-api-gateway.service";

interface AISettings {
  id: string;
  shop: string;
  preferredProvider: string | null;
  huggingfaceApiKey: string | null;
  geminiApiKey: string | null;
  claudeApiKey: string | null;
  openaiApiKey: string | null;
  grokApiKey: string | null;
  deepseekApiKey: string | null;
}

interface AIInstructions {
  id: string;
  shop: string;
  productTitleFormat: string | null;
  productTitleInstructions: string | null;
  productDescriptionFormat: string | null;
  productDescriptionInstructions: string | null;
  productHandleFormat: string | null;
  productHandleInstructions: string | null;
  productSeoTitleFormat: string | null;
  productSeoTitleInstructions: string | null;
  productMetaDescFormat: string | null;
  productMetaDescInstructions: string | null;
  productAltTextFormat: string | null;
  productAltTextInstructions: string | null;
}

interface AIConfig {
  huggingfaceApiKey?: string;
  geminiApiKey?: string;
  claudeApiKey?: string;
  openaiApiKey?: string;
  grokApiKey?: string;
  deepseekApiKey?: string;
}

export interface ActionContext {
  admin: any;
  session: Session;
  shop: string;
  db: any;
  aiSettings: AISettings;
  aiInstructions: AIInstructions;
  provider: string;
  config: AIConfig;
  gateway: ShopifyApiGateway;
}

/**
 * Prepares shared context for all product actions
 */
export async function prepareActionContext(
  admin: any,
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

  // Load AI instructions (with defaults if not exists)
  let aiInstructions = await db.aIInstructions.findUnique({
    where: { shop },
  });

  // Create or update AI Instructions with defaults if needed
  const { DEFAULT_PRODUCT_INSTRUCTIONS } = await import(
    "~/constants/aiInstructionsDefaults"
  );

  if (!aiInstructions) {
    logger.info("Creating default AI instructions", {
      context: "ActionContext",
      shop,
    });

    aiInstructions = await db.aIInstructions.create({
      data: {
        shop,
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
      },
    });
  } else if (!aiInstructions.productSeoTitleInstructions) {
    // Update existing entry with missing fields
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
  const provider =
    (aiSettings?.preferredProvider as any) ||
    process.env.AI_PROVIDER ||
    "huggingface";

  const config: AIConfig = {
    huggingfaceApiKey: decryptApiKey(aiSettings?.huggingfaceApiKey) || undefined,
    geminiApiKey: decryptApiKey(aiSettings?.geminiApiKey) || undefined,
    claudeApiKey: decryptApiKey(aiSettings?.claudeApiKey) || undefined,
    openaiApiKey: decryptApiKey(aiSettings?.openaiApiKey) || undefined,
    grokApiKey: decryptApiKey(aiSettings?.grokApiKey) || undefined,
    deepseekApiKey: decryptApiKey(aiSettings?.deepseekApiKey) || undefined,
  };

  // Create Shopify API Gateway
  const gateway = new ShopifyApiGateway(admin);

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
    aiSettings: aiSettings!,
    aiInstructions: aiInstructions!,
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
