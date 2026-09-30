/**
 * The managed-AI refusal on the paths OTHER than the per-request preflight —
 * the HTTP gate (`aiRefusalResponse`), a mid-call refusal on `/api/ai`
 * (`managedRefusalResponse`), the client's error translator, and the repair's
 * stand-down record.
 *
 * The load-bearing case is §10's hand-back: a spent taster is STAMPED
 * wherever it is discovered, and a shop with a key of its own is handed back
 * to it. Before this, only the preflight stamped — and the preflight is never
 * reached behind a refusal, so a merchant who had added their own key stayed
 * refused on every interactive click for ever.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('~/utils/encryption.server', () => ({
  tryDecryptApiKey: (value: string | null | undefined) => value ?? null,
}));

vi.mock('~/utils/logger.server', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  loggers: { ai: vi.fn() },
}));

const db = vi.hoisted(() => ({
  aISettings: { findUnique: vi.fn(), updateMany: vi.fn() },
  task: { findFirst: vi.fn(), create: vi.fn() },
}));
vi.mock('~/db.server', () => ({ db }));
vi.mock('../../app/db.server', () => ({ db }));

const budget = vi.hoisted(() => ({ managedBudgetStatus: vi.fn() }));
vi.mock('~/services/ai/managed-budget.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  managedBudgetStatus: budget.managedBudgetStatus,
}));

const pool = vi.hoisted(() => ({ globalPoolStatus: vi.fn() }));
vi.mock('~/services/ai/managed-global-pool.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  globalPoolStatus: pool.globalPoolStatus,
}));

import {
  markTasterSpentIfExhausted,
  fallBackToOwnKeyIfTasterSpent,
} from '~/services/ai/ai-credentials.server';
import {
  aiRefusalResponse,
  managedRefusalResponse,
} from '../../app/routes/api-ai-handlers/shared';
import { AI_PROCESSING_CONSENT_VERSION } from '~/services/ai/managed-ai.shared';
import { ManagedAiRefusedError } from '../../src/services/ai.service';
import { translateErrorMessage } from '~/utils/editor-error-messages';
import { recordManagedStandDown } from '~/services/translations/stale-translation-sync.server';

const SHOP = 'demo.myshopify.com';

/** A Free shop on the TASTER: asked for managed, consented, never bought. */
const tasterShop = (over: Record<string, unknown> = {}) =>
  ({
    shop: SHOP,
    preferredProvider: 'openai',
    openaiApiKey: 'sk-merchant',
    selectedModel: 'gpt-4o-mini',
    subscriptionPlan: 'free',
    aiKeySource: 'managed',
    managedAiActive: false,
    aiProcessingConsentAt: new Date(),
    aiProcessingConsentVersion: AI_PROCESSING_CONSENT_VERSION,
    managedAiTasterSpentAt: null,
    appLanguage: 'en',
    ...over,
  }) as never;

const spentTaster = {
  kind: 'taster',
  allowed: false,
  usedMicros: 100,
  limitMicros: 100,
  remainingMicros: 0,
  period: 'taster',
};

const envelope = (response: unknown) =>
  response as { data: Record<string, unknown>; init?: { status?: number } };

const ENV = ['MANAGED_AI_ENABLED', 'MANAGED_AI_PROVIDER', 'MANAGED_AI_MODEL', 'MANAGED_AI_API_KEY'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.MANAGED_AI_ENABLED = 'true';
  process.env.MANAGED_AI_PROVIDER = 'openai';
  process.env.MANAGED_AI_MODEL = 'gpt-5-nano';
  process.env.MANAGED_AI_API_KEY = 'sk-operator';
  vi.clearAllMocks();
  db.aISettings.updateMany.mockResolvedValue({ count: 1 });
  pool.globalPoolStatus.mockResolvedValue({ allowed: true });
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('markTasterSpentIfExhausted', () => {
  it('stamps a spent taster, guarded on the column still being null', async () => {
    expect(await markTasterSpentIfExhausted(SHOP, spentTaster)).toBe(true);
    expect(db.aISettings.updateMany).toHaveBeenCalledWith({
      where: { shop: SHOP, managedAiTasterSpentAt: null },
      data: { managedAiTasterSpentAt: expect.any(Date) },
    });
  });

  it.each([
    ['a period budget', { ...spentTaster, kind: 'period' }],
    ['a taster with budget left', { ...spentTaster, allowed: true }],
    ['a ledger that could not be read', { ...spentTaster, readFailed: true }],
    ['a refusal that is ours to fix', { ...spentTaster, unavailable: true }],
    // A limit of zero is a taster that could not be SIZED (unpriced model, a
    // lookup that threw) — a deployment fault, never proof of a spent grant.
    ['a taster that could not be sized', { ...spentTaster, usedMicros: 0, limitMicros: 0 }],
    ['a limit not yet reached', { ...spentTaster, usedMicros: 50 }],
  ])('never stamps %s', async (_label, status) => {
    expect(await markTasterSpentIfExhausted(SHOP, status)).toBe(false);
    expect(db.aISettings.updateMany).not.toHaveBeenCalled();
  });
});

describe('aiRefusalResponse — a spent taster', () => {
  it('stamps and hands a shop WITH its own key back to it', async () => {
    budget.managedBudgetStatus.mockResolvedValue(spentTaster);
    // The re-read after the stamp sees the stamp.
    db.aISettings.findUnique.mockResolvedValue(tasterShop({ managedAiTasterSpentAt: new Date() }));

    const settings = tasterShop() as { managedAiTasterSpentAt: Date | null };
    const response = await aiRefusalResponse(settings as never, SHOP);

    expect(response).toBeNull();
    expect(db.aISettings.updateMany).toHaveBeenCalledTimes(1);
    // The caller builds its service from THIS object after the gate — it must
    // now resolve to the merchant's key, or the first request is refused by
    // the managed preflight as "left managed mode".
    expect(settings.managedAiTasterSpentAt).toBeInstanceOf(Date);
    const { resolveAiCredentials } = await import('~/services/ai/ai-credentials.server');
    const decision = resolveAiCredentials({ shop: SHOP, settings: settings as never });
    expect(decision.ok && decision.source).toBe('byo');
  });

  it('stamps and still refuses a shop with NO key of its own', async () => {
    budget.managedBudgetStatus.mockResolvedValue(spentTaster);
    db.aISettings.findUnique.mockResolvedValue(
      tasterShop({ openaiApiKey: null, managedAiTasterSpentAt: new Date() }),
    );

    const response = envelope(await aiRefusalResponse(tasterShop({ openaiApiKey: null }), SHOP));

    expect(db.aISettings.updateMany).toHaveBeenCalledTimes(1);
    expect(response.init?.status).toBe(402);
    expect(response.data.code).toBe('AI_TASTER_EXHAUSTED');
    expect(response.data.usedMicros).toBe(100);
  });

  it('answers a taster the RESOLVER already refused as exhausted, not as unavailable', async () => {
    // The stamp is set and there is no key: the static decision refuses, and
    // that refusal used to fall through to the 503 "temporarily unavailable".
    const response = envelope(
      await aiRefusalResponse(
        tasterShop({ openaiApiKey: null, managedAiTasterSpentAt: new Date() }),
        SHOP,
      ),
    );
    expect(response.init?.status).toBe(402);
    expect(response.data.code).toBe('AI_TASTER_EXHAUSTED');
    expect(budget.managedBudgetStatus).not.toHaveBeenCalled();
  });
});

describe('aiRefusalResponse — the other managed answers', () => {
  it('lets a managed call with budget and pool left through', async () => {
    budget.managedBudgetStatus.mockResolvedValue({ ...spentTaster, allowed: true });
    expect(await aiRefusalResponse(tasterShop(), SHOP)).toBeNull();
    expect(db.aISettings.updateMany).not.toHaveBeenCalled();
  });

  it('refuses an exhausted GLOBAL pool as unavailable (the merchant has budget left)', async () => {
    budget.managedBudgetStatus.mockResolvedValue({ ...spentTaster, allowed: true });
    pool.globalPoolStatus.mockResolvedValue({ allowed: false });
    const response = envelope(await aiRefusalResponse(tasterShop(), SHOP));
    expect(response.init?.status).toBe(503);
    expect(response.data.code).toBe('AI_TEMPORARILY_UNAVAILABLE');
  });

  it('refuses a spent PERIOD budget without stamping the taster', async () => {
    budget.managedBudgetStatus.mockResolvedValue({ ...spentTaster, kind: 'period' });
    const response = envelope(
      await aiRefusalResponse(tasterShop({ managedAiActive: true, subscriptionPlan: 'pro' }), SHOP),
    );
    expect(response.init?.status).toBe(402);
    expect(response.data.code).toBe('AI_BUDGET_EXCEEDED');
    expect(db.aISettings.updateMany).not.toHaveBeenCalled();
  });
});

describe('managedRefusalResponse — one builder for the gate and a mid-call refusal', () => {
  it.each([
    ['budgetExceeded', 402, 'AI_BUDGET_EXCEEDED'],
    ['tasterExhausted', 402, 'AI_TASTER_EXHAUSTED'],
    ['consentMissing', 409, 'AI_CONSENT_REQUIRED'],
    ['managedUnavailable', 503, 'AI_TEMPORARILY_UNAVAILABLE'],
    ['somethingNew', 503, 'AI_TEMPORARILY_UNAVAILABLE'],
  ])('%s → %i %s', (reason, status, code) => {
    const response = envelope(managedRefusalResponse(reason, tasterShop({ appLanguage: 'de' })));
    expect(response.init?.status).toBe(status);
    expect(response.data.code).toBe(code);
    expect(response.data.success).toBe(false);
    expect(typeof response.data.error).toBe('string');
    expect(String(response.data.error)).not.toMatch(/managed_ai_refused/);
  });
});

describe('fallBackToOwnKeyIfTasterSpent', () => {
  it('answers null when the re-read fails — refusing stays the safe answer', async () => {
    db.aISettings.findUnique.mockRejectedValue(new Error('db down'));
    expect(await fallBackToOwnKeyIfTasterSpent(SHOP, spentTaster)).toBeNull();
  });
});

describe('the refusal travels as a machine code and is localized on the client', () => {
  it('ManagedAiRefusedError carries the code as its message', () => {
    expect(new ManagedAiRefusedError('budgetExceeded').message).toBe(
      'managed_ai_refused:budgetExceeded',
    );
  });

  it.each([
    ['budgetExceeded', 'managedAiBudgetExceeded'],
    ['tasterExhausted', 'managedAiTasterExhausted'],
    ['consentMissing', 'managedAiConsentMissing'],
    ['managedUnavailable', 'managedAiUnavailable'],
  ])('translateErrorMessage maps %s', (reason, key) => {
    const t = { tasks: { taskErrors: { [key]: `LOCALIZED ${key}` } } } as never;
    expect(translateErrorMessage(`managed_ai_refused:${reason}`, t)).toBe(`LOCALIZED ${key}`);
    // A handler that prefixed its own context must not push it back to raw.
    expect(translateErrorMessage(`Translation failed: managed_ai_refused:${reason}`, t)).toBe(
      `LOCALIZED ${key}`,
    );
  });
});

describe('recordManagedStandDown — the repair pre-check is visible on the Tasks tab', () => {
  const target = {
    shop: SHOP,
    resourceId: 'gid://shopify/Page/1',
    contentKind: 'page' as const,
    resourceTitle: 'About',
  };

  it('writes one terminal row with the machine code', async () => {
    db.task.findFirst.mockResolvedValue(null);
    db.task.create.mockResolvedValue({});
    const now = new Date('2026-09-30T15:00:00Z');

    await recordManagedStandDown(target, 'tasterExhausted', now);

    expect(db.task.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          shop: SHOP,
          error: 'managed_ai_refused:tasterExhausted',
          createdAt: { gte: new Date('2026-09-30T00:00:00Z') },
        }),
      }),
    );
    expect(db.task.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        shop: SHOP,
        type: 'translation',
        status: 'completed_with_errors',
        resourceType: 'page',
        resourceId: 'gid://shopify/Page/1',
        fieldType: 'autoTranslateExternalChange',
        error: 'managed_ai_refused:tasterExhausted',
      }),
    });
  });

  it('writes nothing when the same reason was already recorded today', async () => {
    db.task.findFirst.mockResolvedValue({ id: 'existing' });
    await recordManagedStandDown(target, 'budgetExceeded');
    expect(db.task.create).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    db.task.findFirst.mockRejectedValue(new Error('db down'));
    await expect(recordManagedStandDown(target, 'budgetExceeded')).resolves.toBeUndefined();
  });
});

describe('the repair pre-check (source shape — its harness is the full sync)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('app/services/translations/stale-translation-sync.server.ts', 'utf8');
  const gate = src.slice(
    src.indexOf('Managed AI refused — repair stood down'),
    src.indexOf('Could not check the managed-AI gate'),
  );

  it('hands a spent taster back to the merchant key before standing down', () => {
    expect(gate).toMatch(/fallBackToOwnKeyIfTasterSpent\(shop, budget\)/);
    expect(gate).toMatch(/\(!budget\.allowed && !ownKey\) \|\| \(pool && !pool\.allowed\)/);
  });

  it('answers BOTH refusals with their reason (`managedRepairRefusal`)', () => {
    expect(gate).toMatch(/return decision\.reason;/);
    expect(gate).toMatch(/return reason;/);
  });

  it('the repair records the stand-down before returning startFailed + managedStandDown', () => {
    // The gate itself only answers; the repair is where it is RECORDED, and the
    // stand-down travels out distinctly so the retry list does not read it as
    // "nothing owed" (which settled — deleted — its row).
    expect(src).toMatch(
      /const refusal = await managedRepairRefusal\(shop, resourceId\);\s*if \(refusal\) \{\s*await recordManagedStandDown\(target, refusal\);/,
    );
    expect(src).toMatch(
      /return \{ removed: 0, retranslating: 0, startFailed: true, managedStandDown: refusal \}/,
    );
  });
});
