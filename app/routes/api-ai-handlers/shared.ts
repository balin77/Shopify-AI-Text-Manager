/**
 * Shared types and helpers used by all api.ai action handlers.
 */

import { AIService, toValidProvider } from "../../../src/services/ai.service";
import { decryptApiKey } from "../../utils/encryption.server";
import {
  PRODUCTS_CONFIG, COLLECTIONS_CONFIG, BLOGS_CONFIG, PAGES_CONFIG, POLICIES_CONFIG,
} from "../../config/content-fields.config";
import type { ContentEditorConfig } from "../../types/content-editor.types";
import type { AISettings, AIInstructions } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import type { Session } from "@shopify/shopify-api";

// ─── Content type config map ──────────────────────────────────────────────────

export const CONTENT_CONFIGS: Record<string, ContentEditorConfig> = {
  products: PRODUCTS_CONFIG,
  collections: COLLECTIONS_CONFIG,
  blogs: BLOGS_CONFIG,
  pages: PAGES_CONFIG,
  policies: POLICIES_CONFIG,
};

export const VALID_CONTENT_TYPES = new Set([
  ...Object.keys(CONTENT_CONFIGS),
  'templates',
  'metaobjects',
]);

// ─── Shared types ─────────────────────────────────────────────────────────────

/** Shape of a single item from Shopify's translatableContent array. */
export interface TranslatableContentItem {
  key: string;
  digest: string;
  value?: string;
}

/** Shape of a Shopify GraphQL response with potential data/errors. */
export interface ShopifyGraphQLResponse {
  data?: {
    translatableResource?: {
      resourceId: string;
      translatableContent: TranslatableContentItem[];
    };
    translationsRegister?: {
      userErrors: Array<{ field?: string; message: string }>;
      translations: Array<{ locale: string; key: string; value: string }>;
    };
  };
  errors?: Array<{ message: string }>;
}

/** Context passed to every action handler. */
export interface AIActionContext {
  session: Session;
  admin: AdminApiContext;
  db: PrismaClient;
  formData: FormData;
  settings: AISettings | null;
  seoTitleMaxChars: number;
  contentType: string;
  itemId: string;
}

// ─── Error helpers ────────────────────────────────────────────────────────────

/** Safely extract an error message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Safely extract an error stack from an unknown thrown value. */
export function errorStack(err: unknown): string | undefined {
  return err instanceof Error ? err.stack : undefined;
}

/** Check if an unknown error is a Prisma error with a specific code. */
export function isPrismaError(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === code
  );
}

// ─── AI Service factory ───────────────────────────────────────────────────────

/** Create an AIService instance from shop settings and a task ID. */
export function createAIService(settings: AISettings | null, shop: string, taskId: string): AIService {
  return new AIService(
    toValidProvider(settings?.preferredProvider),
    {
      huggingfaceApiKey: decryptApiKey(settings?.huggingfaceApiKey) || undefined,
      geminiApiKey: decryptApiKey(settings?.geminiApiKey) || undefined,
      claudeApiKey: decryptApiKey(settings?.claudeApiKey) || undefined,
      openaiApiKey: decryptApiKey(settings?.openaiApiKey) || undefined,
      grokApiKey: decryptApiKey(settings?.grokApiKey) || undefined,
      deepseekApiKey: decryptApiKey(settings?.deepseekApiKey) || undefined,
      selectedModel: settings?.selectedModel || undefined,
    },
    shop,
    taskId
  );
}
