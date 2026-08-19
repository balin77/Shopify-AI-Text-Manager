/**
 * Unit tests — the translation-change policy (Settings → Übersetzungen).
 *
 * The two rules that matter are behavioural, not cosmetic:
 *   - it FAILS OPEN (a lookup error must keep the historic purge behaviour,
 *     never silently start preserving stale translations), and
 *   - the Max gate is applied on every READ, so a stored `true` left over from
 *     a former Max subscription stays inert after a downgrade.
 *
 * DB is fully mocked (image-operations.test.ts convention).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { row, db } = vi.hoisted(() => {
  const row: { value: any; error: Error | null } = { value: null, error: null };
  const db = {
    aISettings: {
      findUnique: vi.fn(async () => {
        if (row.error) throw row.error;
        return row.value;
      }),
    },
  };
  return { row, db };
});

vi.mock("../../app/db.server", () => ({ db, default: db }));

import {
  loadTranslationChangePolicy,
  isPurgeOnPrimaryChangeEnabled,
} from "../../app/services/translations/translation-change-policy.server";

beforeEach(() => {
  row.value = null;
  row.error = null;
  db.aISettings.findUnique.mockClear();
});

describe("loadTranslationChangePolicy", () => {
  it("defaults to purging when the shop has no settings row yet", async () => {
    const policy = await loadTranslationChangePolicy("shop.myshopify.com");
    expect(policy.purgeOnPrimaryChange).toBe(true);
    expect(policy.autoTranslateExternalChanges).toBe(false);
  });

  it("honours a merchant who switched the purge off", async () => {
    row.value = {
      translationPurgeOnPrimaryChange: false,
      autoTranslateExternalChanges: false,
      subscriptionPlan: "pro",
    };
    expect(await isPurgeOnPrimaryChangeEnabled("shop.myshopify.com")).toBe(false);
  });

  it("fails OPEN: a lookup error keeps the historic purge behaviour", async () => {
    row.error = new Error("connection lost");
    const policy = await loadTranslationChangePolicy("shop.myshopify.com");
    expect(policy.purgeOnPrimaryChange).toBe(true);
    expect(policy.autoTranslateExternalChanges).toBe(false);
  });

  it("grants auto-translation on Max", async () => {
    row.value = {
      translationPurgeOnPrimaryChange: true,
      autoTranslateExternalChanges: true,
      subscriptionPlan: "max",
    };
    const policy = await loadTranslationChangePolicy("shop.myshopify.com");
    expect(policy.autoTranslateExternalChanges).toBe(true);
  });

  it("keeps a stored `true` inert below Max (downgrade never resets the column)", async () => {
    for (const plan of ["free", "basic", "pro"]) {
      row.value = {
        translationPurgeOnPrimaryChange: true,
        autoTranslateExternalChanges: true,
        subscriptionPlan: plan,
      };
      const policy = await loadTranslationChangePolicy("shop.myshopify.com");
      expect(policy.autoTranslateExternalChanges).toBe(false);
      expect(policy.plan).toBe(plan);
    }
  });

  it("defaults both switches when the row carries neither field", async () => {
    // Defensive only. The real pre-migration case does NOT reach here: Prisma
    // raises P2022 for a `select` of a column the database does not have, so a
    // container running ahead of its migration lands in the fail-open catch
    // above — same outcome, different route.
    row.value = { subscriptionPlan: "max" };
    const policy = await loadTranslationChangePolicy("shop.myshopify.com");
    expect(policy.purgeOnPrimaryChange).toBe(true);
    expect(policy.autoTranslateExternalChanges).toBe(false);
  });
});
