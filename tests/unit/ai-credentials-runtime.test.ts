/**
 * What the eleven rewired call sites actually GET — `aiCredentialsFor` and
 * `aiServiceFor`, PLAN_MANAGED_AI_KEY §5, §6, §6a.
 *
 * `ai-credentials.test.ts` covers the decision. This covers the thing built
 * FROM it, which is where the decision's value can be thrown away — and the
 * first cut threw it away in the one direction that deletes merchant data:
 * a managed refusal produced a keyless config, `initializeProvider` threw
 * `MissingAIKeyError`, and the detached repair's purge path does not recognise
 * that error. A budget that ran out would have been recorded as "the AI could
 * not deliver this entry" and answered with `translationsRemove`.
 *
 * Every assertion here is a real construction and a real call. The grep-shaped
 * test beside this one proves the repair's catches re-throw; only this one
 * proves there is something for them to catch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('~/utils/encryption.server', () => ({
  tryDecryptApiKey: (value: string | null | undefined) => value ?? null,
}));

vi.mock('~/utils/logger.server', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  loggers: { ai: vi.fn(), queue: vi.fn() },
}));

vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock('openai', () => ({ default: class { chat = { completions: { create: vi.fn() } }; } }));

vi.mock('~/db.server', () => ({
  db: {
    aiUsageCounter: { aggregate: vi.fn().mockResolvedValue({ _sum: { billedMicros: null } }) },
    task: { findUnique: vi.fn().mockResolvedValue(null) },
    aISettings: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

import { aiCredentialsFor, aiServiceFor } from '~/services/ai/ai-credentials.server';
import { AI_PROCESSING_CONSENT_VERSION } from '~/services/ai/managed-ai.shared';
import { isManagedRefusal, MissingAIKeyError } from '../../src/services/ai.service';

type Settings = Parameters<typeof aiCredentialsFor>[0];

const base = (over: Record<string, unknown> = {}) =>
  ({
    preferredProvider: 'openai',
    openaiApiKey: 'sk-merchant',
    selectedModel: 'gpt-4o-mini',
    subscriptionPlan: 'pro',
    aiKeySource: 'byo',
    managedAiActive: false,
    ...over,
  }) as unknown as Settings;

const managed = (over: Record<string, unknown> = {}) =>
  base({
    aiKeySource: 'managed',
    managedAiActive: true,
    aiProcessingConsentAt: new Date(),
    aiProcessingConsentVersion: AI_PROCESSING_CONSENT_VERSION,
    ...over,
  });

const ENV = ['MANAGED_AI_ENABLED', 'MANAGED_AI_PROVIDER', 'MANAGED_AI_MODEL', 'MANAGED_AI_API_KEY'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.MANAGED_AI_ENABLED = 'true';
  process.env.MANAGED_AI_PROVIDER = 'openai';
  process.env.MANAGED_AI_MODEL = 'gpt-5-nano';
  process.env.MANAGED_AI_API_KEY = 'sk-operator';
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Reach the first thing every AI call does, without touching a provider. */
const call = (service: unknown) =>
  (service as { replayRequest: (p: string) => Promise<string> }).replayRequest('p');

describe('a managed refusal fails as a REFUSAL, not as a missing key', () => {
  it.each([
    ['consent withdrawn mid-run', managed({ aiProcessingConsentVersion: 'older' })],
    ['consent never given', managed({ aiProcessingConsentAt: null, aiProcessingConsentVersion: null })],
  ])('%s', async (_label, settings) => {
    const { service } = aiServiceFor(settings, 'demo.myshopify.com');

    // It CONSTRUCTS — the throw used to happen here, before any call, which is
    // why the repair's per-call guards could never see it.
    expect(service).toBeTruthy();

    const error = await call(service).catch((e) => e);
    expect(isManagedRefusal(error), `got ${error?.name}: ${error?.message}`).toBe(true);
    expect(error).not.toBeInstanceOf(MissingAIKeyError);
  });

  it('the kill switch is a refusal too, not a missing key', async () => {
    // For a shop with NO key of its own. One that has one is handed back to
    // it instead — the merchant's work does not stop because our switch is
    // off — which is the case the test below pins.
    delete process.env.MANAGED_AI_ENABLED;
    const { service } = aiServiceFor(
      managed({ openaiApiKey: null }),
      'demo.myshopify.com',
    );
    const error = await call(service).catch((e) => e);
    expect(isManagedRefusal(error)).toBe(true);
    expect((error as { reason: string }).reason).toBe('managedUnavailable');
  });

  it('…while a shop WITH a key of its own keeps working on it', () => {
    delete process.env.MANAGED_AI_ENABLED;
    const creds = aiCredentialsFor(managed(), 'demo.myshopify.com');
    expect(creds.decision.ok && creds.decision.source).toBe('byo');
    expect(creds.config.openaiApiKey).toBe('sk-merchant');
    expect(creds.config.managedRefusal).toBeUndefined();
  });

  it('carries no key anywhere near the refused service', () => {
    const creds = aiCredentialsFor(managed({ aiProcessingConsentAt: null }), 'demo.myshopify.com');
    expect(creds.config.managedRefusal).toBe('consentMissing');
    expect(creds.config.openaiApiKey).toBeUndefined();
    expect(creds.config.claudeApiKey).toBeUndefined();
  });
});

describe('a BYO shop is untouched', () => {
  it('still throws MissingAIKeyError when it has no key — the historic behaviour', async () => {
    // A real failure must stay a real failure: the repair purges on it, and a
    // translation of text that no longer exists is worse than no translation.
    expect(() => aiServiceFor(base({ openaiApiKey: null }), 'demo.myshopify.com')).toThrow(
      MissingAIKeyError,
    );
  });

  it('gets its own key, its own model and no preflight', () => {
    const creds = aiCredentialsFor(base(), 'demo.myshopify.com');
    expect(creds.config.openaiApiKey).toBe('sk-merchant');
    expect(creds.config.selectedModel).toBe('gpt-4o-mini');
    expect(creds.config.credentialSource).toBe('byo');
    // The merchant's own key is not ours to cap.
    expect(creds.config.preflight).toBeUndefined();
    expect(creds.config.managedRefusal).toBeUndefined();
  });
});

describe('a served managed shop is gated per request', () => {
  it('gets the operator key, the pinned model AND a preflight', () => {
    const creds = aiCredentialsFor(managed(), 'demo.myshopify.com');
    expect(creds.config.openaiApiKey).toBe('sk-operator');
    expect(creds.config.selectedModel).toBe('gpt-5-nano');
    // Per REQUEST, not per instance: a bulk run holds one service for hundreds
    // of calls, so a budget checked at construction is checked before the
    // spend it bounds.
    expect(typeof creds.config.preflight).toBe('function');
  });

  it('the preflight refuses once the budget is gone', async () => {
    const { db } = await import('~/db.server');
    (db.aISettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(managed());
    // Pro's budget is EUR 2.50; report it as fully spent.
    (db.aiUsageCounter.aggregate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      _sum: { billedMicros: BigInt(2_500_000) },
    });

    const creds = aiCredentialsFor(managed(), 'demo.myshopify.com');
    const verdict = await creds.config.preflight!();
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.reason).toBe('budgetExceeded');
  });

  it('and allows the call while anything is left', async () => {
    const { db } = await import('~/db.server');
    (db.aISettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(managed());
    (db.aiUsageCounter.aggregate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      _sum: { billedMicros: BigInt(10) },
    });
    const creds = aiCredentialsFor(managed(), 'demo.myshopify.com');
    expect((await creds.config.preflight!()).ok).toBe(true);
  });

  it('re-reads the SHOP, so a withdrawn consent stops the NEXT call', async () => {
    // Closing over the settings loaded at construction meant a merchant who
    // withdrew consent kept spending the operator key for the rest of a bulk
    // run — hours, on the one flag that makes managed mode legal.
    const { db } = await import('~/db.server');
    (db.aISettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(managed());
    const creds = aiCredentialsFor(managed(), 'demo.myshopify.com');
    expect((await creds.config.preflight!()).ok).toBe(true);

    (db.aISettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      managed({ aiProcessingConsentVersion: 'withdrawn-and-re-asked' }),
    );
    const verdict = await creds.config.preflight!();
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.reason).toBe('consentMissing');
  });

  it('a failed settings read keeps the credential rather than aborting a repair', async () => {
    const { db } = await import('~/db.server');
    (db.aISettings.findUnique as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('db blinked'),
    );
    const creds = aiCredentialsFor(managed(), 'demo.myshopify.com');
    expect((await creds.config.preflight!()).ok).toBe(true);
  });

  it('a spent budget reaches the CALL as a refusal', async () => {
    const { db } = await import('~/db.server');
    (db.aISettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(managed());
    (db.aiUsageCounter.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({
      _sum: { billedMicros: BigInt(9_999_999) },
    });

    const { service } = aiServiceFor(managed(), 'demo.myshopify.com');
    const error = await call(service).catch((e) => e);
    expect(isManagedRefusal(error)).toBe(true);
    expect((error as { reason: string }).reason).toBe('budgetExceeded');
  });
});
