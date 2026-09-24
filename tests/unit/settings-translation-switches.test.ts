/**
 * The Translations card's save — `saveInstructions` on /app/settings.
 *
 * Two properties, and both are bugs this route has already had once:
 *
 *  - **A save writes only the fields it brings.** One save of the AI tab
 *    once cleared the SEO title suffix, because a write built from the whole
 *    settings row re-sent what the form did not carry. Every switch here is
 *    therefore present-or-absent: a form field that is not in the payload must
 *    leave its column alone.
 *  - **A payload that matches what is stored is a NO-OP, never a 403.** A
 *    downgraded shop re-submits its stored `true` on every save of this tab,
 *    and refusing that would make the card unsaveable for exactly the shops
 *    that cannot change the switch anyway.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const authenticate = { admin: vi.fn() };
vi.mock("~/shopify.server", () => ({ authenticate }));
vi.mock("../../app/shopify.server", () => ({ authenticate }));

const aISettings = { findUnique: vi.fn(), upsert: vi.fn(async () => ({})) };
const aIInstructions = { upsert: vi.fn(async () => ({})) };
const dbStub = { aISettings, aIInstructions };
vi.mock("~/db.server", () => ({ db: dbStub, default: dbStub }));
vi.mock("../../app/db.server", () => ({ db: dbStub, default: dbStub }));

const { action } = await import("~/routes/app.settings");

const SHOP = "test.myshopify.com";

function post(fields: Record<string, string>) {
  const body = new FormData();
  body.set("actionType", "saveInstructions");
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return { method: "POST", formData: async () => body } as unknown as Request;
}

async function run(fields: Record<string, string>) {
  const response = await action({ request: post(fields), params: {}, context: {} } as never);
  const envelope = response as unknown as { data: Record<string, unknown>; init?: { status?: number } };
  return { status: envelope.init?.status ?? 200, body: envelope.data };
}

/** What the one AISettings write of a save carried, or null when there was none. */
function settingsWrite(): Record<string, unknown> | null {
  const call = (aISettings.upsert.mock.calls as unknown as Array<[{ update: Record<string, unknown> }]>)[0]?.[0];
  return call?.update ?? null;
}

beforeEach(() => {
  aISettings.findUnique.mockReset();
  aISettings.upsert.mockClear();
  aIInstructions.upsert.mockClear();
  authenticate.admin.mockResolvedValue({ admin: {}, session: { shop: SHOP } });
  aISettings.findUnique.mockResolvedValue({
    subscriptionPlan: "max",
    autoTranslateExternalChanges: false,
    autoTranslateHandles: false,
    autoTranslateDailyLimit: null,
  });
});

describe("saveInstructions — the translation switches", () => {
  it("writes ONLY the switches the payload carries", async () => {
    await run({ autoTranslateHandles: "true" });

    // Not `translationMode`, not `keywordAwareTranslation`, not the vision
    // pair, not `autoTranslateExternalChanges` — none of them were sent.
    expect(settingsWrite()).toEqual({ autoTranslateHandles: true });
  });

  it("writes NO instruction text when the payload carries none — a switch-only save", async () => {
    // The card's copy of the texts is seeded at mount and never re-synced, so
    // it now sends only what changed; writing every absent field as NULL here
    // would erase every instruction the merchant did not touch.
    await run({ autoTranslateHandles: "true" });
    expect(aIInstructions.upsert).not.toHaveBeenCalled();
  });

  it("writes ONLY the instruction texts the payload carries", async () => {
    await run({ writingStyleInstructions: "Kurz und sachlich.", productTitleFormat: "" });
    const call = (aIInstructions.upsert.mock.calls[0] as unknown as [any])[0];
    // A cleared field is sent as "" and stored as NULL; nothing else is named.
    expect(call.update).toEqual({ writingStyleInstructions: "Kurz und sachlich.", productTitleFormat: null });
  });

  it("touches AISettings not at all when the payload carries no setting", async () => {
    await run({ writingStyleInstructions: "Kurz und sachlich." });
    expect(aISettings.upsert).not.toHaveBeenCalled();
    // The instruction texts still land — this is the card's own save.
    expect(aIInstructions.upsert).toHaveBeenCalled();
  });

  it("stores the handle opt-in independently of the parent switch", async () => {
    // Deliberate: the column survives the merchant switching the automation off
    // to try something, and the server ANDs the two on every read.
    await run({ autoTranslateExternalChanges: "false", autoTranslateHandles: "true" });
    expect(settingsWrite()).toEqual({ autoTranslateHandles: true });
  });

  it("is a no-op, not a 403, when a downgraded shop re-sends its stored values", async () => {
    aISettings.findUnique.mockResolvedValue({
      subscriptionPlan: "pro",
      autoTranslateExternalChanges: true,
      autoTranslateHandles: true,
    });
    const { status } = await run({
      autoTranslateExternalChanges: "true",
      autoTranslateHandles: "true",
    });
    expect(status).toBe(200);
    expect(settingsWrite()).toBeNull();
  });

  it("refuses a CHANGE to the handle opt-in below the required plan", async () => {
    aISettings.findUnique.mockResolvedValue({
      subscriptionPlan: "pro",
      autoTranslateExternalChanges: false,
      autoTranslateHandles: false,
    });
    const { status } = await run({ autoTranslateHandles: "true" });
    expect(status).toBe(403);
    // Refused BEFORE anything was written — a half-applied save of this card
    // would fail again on every retry.
    expect(aISettings.upsert).not.toHaveBeenCalled();
    expect(aIInstructions.upsert).not.toHaveBeenCalled();
  });

  it("grants the change on the entitled plan", async () => {
    const { status } = await run({ autoTranslateHandles: "true" });
    expect(status).toBe(200);
    expect(settingsWrite()).toEqual({ autoTranslateHandles: true });
  });
});

describe("saveInstructions — the optional daily limit", () => {
  it("stores a whole number", async () => {
    const { status } = await run({ autoTranslateDailyLimit: "50" });
    expect(status).toBe(200);
    expect(settingsWrite()).toEqual({ autoTranslateDailyLimit: 50 });
  });

  it("an EMPTY field clears the limit — no limit, not zero", async () => {
    aISettings.findUnique.mockResolvedValue({
      subscriptionPlan: "max",
      autoTranslateExternalChanges: true,
      autoTranslateHandles: false,
      autoTranslateDailyLimit: 50,
    });
    await run({ autoTranslateDailyLimit: "" });
    expect(settingsWrite()).toEqual({ autoTranslateDailyLimit: null });
  });

  it.each(["0", "-3", "2.5", "abc"])("refuses %s BEFORE anything is written", async (value) => {
    const { status } = await run({ autoTranslateDailyLimit: value, writingStyleInstructions: "x" });
    expect(status).toBe(400);
    expect(aISettings.upsert).not.toHaveBeenCalled();
    expect(aIInstructions.upsert).not.toHaveBeenCalled();
  });

  it("is plan-gated like the switch it belongs to", async () => {
    aISettings.findUnique.mockResolvedValue({
      subscriptionPlan: "pro",
      autoTranslateExternalChanges: false,
      autoTranslateHandles: false,
      autoTranslateDailyLimit: null,
    });
    const { status } = await run({ autoTranslateDailyLimit: "10" });
    expect(status).toBe(403);
    expect(aISettings.upsert).not.toHaveBeenCalled();
  });

  it("re-sending the stored value is a no-op, not a 403", async () => {
    aISettings.findUnique.mockResolvedValue({
      subscriptionPlan: "pro",
      autoTranslateExternalChanges: false,
      autoTranslateHandles: false,
      autoTranslateDailyLimit: 10,
    });
    const { status } = await run({ autoTranslateDailyLimit: "10" });
    expect(status).toBe(200);
    expect(settingsWrite()).toBeNull();
  });
});
