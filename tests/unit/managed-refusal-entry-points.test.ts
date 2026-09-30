/**
 * The AI compliance gate on the entry points OUTSIDE `/api/ai`: the unified
 * content handler, the theme-content translate-all / generate actions and the
 * helper that turns a refusal thrown mid-run into the same coded JSON.
 *
 * The bug: these asked no pre-check, so a managed refusal (budget spent,
 * taster spent, consent missing, unavailable) reached the merchant as a raw
 * 500, as "every locale failed" under success:true, or not at all.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { data as json } from "react-router";

vi.mock("~/utils/logger.server", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  loggers: new Proxy({}, { get: () => vi.fn() }),
}));

const gate = vi.hoisted(() => ({ aiRefusalResponse: vi.fn() }));
vi.mock("~/routes/api-ai-handlers/shared", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  aiRefusalResponse: gate.aiRefusalResponse,
}));

vi.mock("../../src/services/ai-queue.service", () => ({
  AIQueueService: { getInstance: () => ({ updateRateLimits: vi.fn(async () => undefined) }) },
}));

import {
  handleUnifiedContentActions,
  AI_CONTENT_ACTIONS,
} from "../../app/actions/unified-content.actions";
import { handleTranslateAll as handleTemplatesTranslateAll } from "../../app/actions/templates/templates-translate-all.action";
import { handleGenerateAIText as handleTemplatesGenerate } from "../../app/actions/templates/templates-generate.action";
import {
  managedRefusalResponseFromError,
  refusalPayload,
} from "../../app/utils/ai-refusal-response.server";
import { ManagedAiRefusedError } from "../../src/services/ai.service";
import { PRODUCTS_CONFIG } from "../../app/config/content-fields.config";

const SHOP = "demo.myshopify.com";

const envelope = (response: unknown) =>
  response as { data: Record<string, unknown>; init?: { status?: number } };

const consentRefusal = () =>
  json(
    { success: false, code: "AI_CONSENT_REQUIRED", error: "Confirm AI processing." },
    { status: 409 },
  );

const form = (entries: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
};

function makeDb() {
  return {
    task: { create: vi.fn(), update: vi.fn() },
    aISettings: { findUnique: vi.fn(async () => ({ shop: SHOP, appLanguage: "en" })) },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  gate.aiRefusalResponse.mockResolvedValue(null);
});

describe("handleUnifiedContentActions — AI pre-check", () => {
  const run = (db: any, entries: Record<string, string>) =>
    handleUnifiedContentActions({
      admin: { graphql: vi.fn() } as any,
      session: { shop: SHOP } as any,
      formData: form(entries),
      contentConfig: PRODUCTS_CONFIG,
      db,
      aiSettings: { shop: SHOP } as any,
      aiInstructions: null,
    });

  it("refuses a translate-all BEFORE any Task row, echoing its actionType", async () => {
    gate.aiRefusalResponse.mockResolvedValue(consentRefusal());
    const db = makeDb();
    const res = envelope(
      await run(db, { action: "translateAll", itemId: "gid://shopify/Product/1" }),
    );
    expect(res.init?.status).toBe(409);
    expect(res.data).toMatchObject({
      success: false,
      code: "AI_CONSENT_REQUIRED",
      actionType: "translateAll",
    });
    expect(db.task.create).not.toHaveBeenCalled();
  });

  it("echoes fieldType on a single-field translate so the error lands on the field", async () => {
    gate.aiRefusalResponse.mockResolvedValue(consentRefusal());
    const res = envelope(
      await run(makeDb(), {
        action: "translateField",
        itemId: "gid://shopify/Product/1",
        fieldType: "title",
      }),
    );
    expect(res.data).toMatchObject({ actionType: "translateField", fieldType: "title" });
  });

  it("never asks the gate for an action that reaches no AI", async () => {
    gate.aiRefusalResponse.mockResolvedValue(consentRefusal());
    const res = envelope(await run(makeDb(), { action: "noSuchAction" }));
    expect(res.data.error).toBe("Unknown action");
    expect(gate.aiRefusalResponse).not.toHaveBeenCalled();
  });

  it("lists exactly the AI actions — never a save, load, create, delete or SKU copy", () => {
    for (const nonAi of [
      "loadTranslations",
      "updateContent",
      "saveImageAltText",
      "loadImageAltTranslations",
      "loadSubResourceTranslations",
      "saveSubResourceTranslations",
      "savePrimarySubResources",
      "createContent",
      "deleteContent",
      "duplicateContent",
      "generateAltTextFromSku",
    ]) {
      expect(AI_CONTENT_ACTIONS.has(nonAi)).toBe(false);
    }
    for (const ai of [
      "translateAll",
      "translateAllForLocale",
      "translateSubResources",
      "translateSubResourceToAllLocales",
      "generateAIText",
      "formatAIText",
      "generateAllAltTexts",
      "translateAltTextToAllLocales",
    ]) {
      expect(AI_CONTENT_ACTIONS.has(ai)).toBe(true);
    }
  });
});

describe("theme-content actions — AI pre-check", () => {
  const ctx = (db: any) =>
    ({
      admin: { graphql: vi.fn() },
      session: { shop: SHOP },
      db,
      formData: form({ targetLocale: "fr", fieldType: "general.title" }),
      domain: "theme",
      groupId: "g1",
      themeGroups: [],
      firstGroup: { groupName: "General" },
      resourceId: "gid://shopify/OnlineStoreTheme/1",
      keyToResourceId: new Map(),
      keyToResourceType: new Map(),
    }) as any;

  it("translate-all refuses before a Task row exists", async () => {
    gate.aiRefusalResponse.mockResolvedValue(consentRefusal());
    const db = makeDb();
    const res = envelope(await handleTemplatesTranslateAll(ctx(db), "translateAll"));
    expect(res.data.code).toBe("AI_CONSENT_REQUIRED");
    expect(db.task.create).not.toHaveBeenCalled();
  });

  it("generate refuses before a Task row exists", async () => {
    gate.aiRefusalResponse.mockResolvedValue(consentRefusal());
    const db = makeDb();
    const res = envelope(await handleTemplatesGenerate(ctx(db)));
    expect(res.data.code).toBe("AI_CONSENT_REQUIRED");
    expect(db.task.create).not.toHaveBeenCalled();
  });
});

describe("managedRefusalResponseFromError", () => {
  it("leaves every other error to the caller's own catch", () => {
    expect(managedRefusalResponseFromError(new Error("boom"), null)).toBeNull();
  });

  it("answers a refusal thrown mid-run with the coded JSON and the route's shape", () => {
    const res = envelope(
      managedRefusalResponseFromError(
        new ManagedAiRefusedError("budgetExceeded", { usedMicros: 5, limitMicros: 5 }),
        { appLanguage: "en" } as any,
        { actionType: "translateAll" },
      ),
    );
    expect(res.init?.status).toBe(402);
    expect(res.data).toMatchObject({
      success: false,
      code: "AI_BUDGET_EXCEEDED",
      actionType: "translateAll",
    });
    expect(typeof res.data.error).toBe("string");
  });

  it("refusalPayload reads error, code and status for routes with their own shape", () => {
    expect(refusalPayload(consentRefusal())).toEqual({
      error: "Confirm AI processing.",
      code: "AI_CONSENT_REQUIRED",
      status: 409,
    });
  });
});
