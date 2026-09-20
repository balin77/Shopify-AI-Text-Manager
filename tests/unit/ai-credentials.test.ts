/**
 * The credential resolver's gate matrix — PLAN_MANAGED_AI_KEY §5, §2, §9.4.
 *
 * One decision per combination, and the combinations are what matter: mode x
 * consent x kill switch x configuration. Each refusal is a VALUE rather than
 * an exception, because two of them reach a detached repair where a throw is
 * indistinguishable from "the AI could not deliver this entry" — which on a
 * shop with auto-translate on is a `translationsRemove` plus a local delete.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('~/utils/encryption.server', () => ({
  // The stored columns are encrypted; the test writes plaintext and this
  // stands in for the decrypt so the fixtures stay readable.
  tryDecryptApiKey: (value: string | null | undefined) => value ?? null,
}));

vi.mock('~/utils/logger.server', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  loggers: { ai: vi.fn() },
}));

import {
  resolveAiCredentials,
  managedAiAvailable,
  isManagedAiEnabled,
  readManagedCredential,
  missingMerchantKey,
} from '~/services/ai/ai-credentials.server';
import { AI_PROCESSING_CONSENT_VERSION } from '~/services/ai/managed-ai.shared';
import { TASTER_PERIOD } from '~/config/managed-ai-budget';
import { DEV_APP_CLIENT_ID } from '~/services/dev-plan-override.server';

type Settings = Parameters<typeof resolveAiCredentials>[0]['settings'];

/** A shop with its own OpenAI key and nothing else. */
const byoShop = (over: Record<string, unknown> = {}) =>
  ({
    preferredProvider: 'openai',
    openaiApiKey: 'sk-merchant',
    selectedModel: 'gpt-4o-mini',
    aiKeySource: 'byo',
    managedAiActive: false,
    ...over,
  }) as unknown as Settings;

/** A shop that bought managed AI, asked for it and consented. */
const managedShop = (over: Record<string, unknown> = {}) =>
  byoShop({
    aiKeySource: 'managed',
    managedAiActive: true,
    aiProcessingConsentAt: new Date(),
    aiProcessingConsentVersion: AI_PROCESSING_CONSENT_VERSION,
    ...over,
  });

const ENV_KEYS = [
  'MANAGED_AI_ENABLED',
  'MANAGED_AI_PROVIDER',
  'MANAGED_AI_MODEL',
  'MANAGED_AI_API_KEY',
  'MANAGED_AI_FALLBACK_PROVIDER',
  'MANAGED_AI_FALLBACK_MODEL',
  'MANAGED_AI_FALLBACK_API_KEY',
  'DEV_APP_CLIENT_ID',
  'SHOPIFY_API_KEY',
  'APP_ENV',
];
let saved: Record<string, string | undefined>;

function configureManaged() {
  process.env.MANAGED_AI_ENABLED = 'true';
  process.env.MANAGED_AI_PROVIDER = 'openai';
  process.env.MANAGED_AI_MODEL = 'gpt-5-nano';
  process.env.MANAGED_AI_API_KEY = 'sk-operator';
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    // Restored by SETTING, never by delete: on some platforms a delete does not
    // reset a process's view of a variable, which makes the next test read the
    // previous one's environment (the TZ lesson in use-hydrated.test.ts).
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('the kill switch', () => {
  it('is OPT-IN: an unset MANAGED_AI_ENABLED means OFF', () => {
    process.env.MANAGED_AI_PROVIDER = 'openai';
    process.env.MANAGED_AI_MODEL = 'gpt-5-nano';
    process.env.MANAGED_AI_API_KEY = 'sk-operator';

    expect(isManagedAiEnabled()).toBe(false);
    expect(managedAiAvailable()).toBe(false);
  });

  it('hands a shop that HAS its own key straight back to it', () => {
    // Managed cannot be served, so the merchant's own credential is the right
    // answer and not a refusal — their work does not stop because our kill
    // switch is off. The stored choice is untouched, so the moment managed
    // comes back they are on it again.
    const decision = resolveAiCredentials({ shop: 's', settings: managedShop() });
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('expected ok');
    expect(decision.source).toBe('byo');
    expect(decision.config.openaiApiKey).toBe('sk-merchant');
  });

  it('…and refuses only a shop that has no key to fall back to', () => {
    const decision = resolveAiCredentials({
      shop: 's',
      settings: managedShop({ openaiApiKey: null }),
    });
    expect(decision).toEqual({ ok: false, reason: 'managedUnavailable' });
  });

  it('refuses to serve an operator key from a dev/custom-app build', () => {
    configureManaged();
    // The REAL dev client id, imported rather than invented: the first cut of
    // this test set `DEV_APP_CLIENT_ID` in the environment and the guard read
    // it from there — so the test constructed the one world in which the
    // guard worked, while in every real deployment it was dead.
    process.env.SHOPIFY_API_KEY = DEV_APP_CLIENT_ID;
    process.env.APP_ENV = 'development';

    expect(managedAiAvailable()).toBe(false);
    expect(
      resolveAiCredentials({ shop: 's', settings: managedShop({ openaiApiKey: null }) }),
    ).toEqual({ ok: false, reason: 'managedUnavailable' });
  });
});

describe('the mode comes from the subscription AND the stored choice', () => {
  beforeEach(configureManaged);

  it('a shop that asked for managed and bought it gets the operator key', () => {
    const decision = resolveAiCredentials({ shop: 's', settings: managedShop() });

    expect(decision.ok).toBe(true);
    if (!decision.ok || decision.source !== 'managed') throw new Error('expected managed');
    expect(decision.provider).toBe('openai');
    expect(decision.model).toBe('gpt-5-nano');
    expect(decision.config.openaiApiKey).toBe('sk-operator');
    expect(decision.config.credentialSource).toBe('managed');
    // The MANAGED model is pinned — a merchant's stored model choice is not
    // theirs to spend our key on.
    expect(decision.config.selectedModel).toBe('gpt-5-nano');
  });

  it('a shop that asked for managed but did NOT buy it gets the operator key too — on the TASTER', () => {
    // §10 changed this answer, deliberately. It used to resolve to the
    // merchant's own key, which put the one grant an evaluating shop is
    // offered before it buys anything out of reach of every Free shop — the
    // only population it exists for.
    //
    // What did NOT change is what a merchant can give themselves. The
    // verified half moved DOWN, to the size of the budget: this shop draws on
    // the taster (worth cents, once per shop ever, its own ledger key and its
    // own global pool), never on a plan's monthly volume. That half is
    // `periodBudgetMicros`, and the two tests below pin it.
    const decision = resolveAiCredentials({
      shop: 's',
      settings: managedShop({ managedAiActive: false }),
    });

    expect(decision.ok).toBe(true);
    if (!decision.ok || decision.source !== 'managed') throw new Error('expected managed');
    expect(decision.config.openaiApiKey).toBe('sk-operator');
    // The TASTER key, not a billing period — the meter writes under the key
    // the budget is read under, or the cap never fires.
    expect(decision.config.usagePeriod).toBe(TASTER_PERIOD);
    expect(decision.config.usagePool).toBe('taster');
  });

  it('a shop that BOUGHT it is metered against its billing period and the paid pool', () => {
    const decision = resolveAiCredentials({
      shop: 's',
      settings: managedShop({
        subscriptionPlan: 'pro',
        managedAiPeriodEnd: new Date('2099-10-14T00:00:00Z'),
      }),
    });
    if (!decision.ok || decision.source !== 'managed') throw new Error('expected managed');
    expect(decision.config.usagePeriod).toBe('b:2099-10-14');
    expect(decision.config.usagePool).toBe('paid');
  });

  it('a PAID plan with no verified managed purchase still draws on the taster', () => {
    // The tampering case: posting `aiKeySource=managed` from a Pro shop on the
    // BYO variant must not hand it Pro's monthly volume.
    const decision = resolveAiCredentials({
      shop: 's',
      settings: managedShop({ subscriptionPlan: 'pro', managedAiActive: false }),
    });
    if (!decision.ok || decision.source !== 'managed') throw new Error('expected managed');
    expect(decision.config.usagePeriod).toBe(TASTER_PERIOD);
    expect(decision.config.usagePool).toBe('taster');
  });

  it('a shop that bought managed but kept its own key gets its own key', () => {
    // The stored CHOICE decides. This is what makes "I hit the cap" one click
    // rather than a support ticket.
    const decision = resolveAiCredentials({
      shop: 's',
      settings: managedShop({ aiKeySource: 'byo' }),
    });

    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('expected ok');
    expect(decision.source).toBe('byo');
  });

  it('an unrecognised aiKeySource reads as the merchant\'s own key', () => {
    const decision = resolveAiCredentials({
      shop: 's',
      settings: managedShop({ aiKeySource: 'MANAGED' }),
    });
    expect(decision.ok && decision.source).toBe('byo');
  });
});

describe('consent is checked before anything is spent', () => {
  beforeEach(configureManaged);

  it('refuses a managed call with no consent at all', () => {
    expect(
      resolveAiCredentials({
        shop: 's',
        settings: managedShop({ aiProcessingConsentAt: null, aiProcessingConsentVersion: null }),
      }),
    ).toEqual({ ok: false, reason: 'consentMissing' });
  });

  it('refuses when the stored consent is for an OLDER version of the text', () => {
    // A merchant who consented to two named sub-processors has not consented
    // to a third — which is exactly what a version bump records.
    expect(
      resolveAiCredentials({
        shop: 's',
        settings: managedShop({ aiProcessingConsentVersion: '2020-01-01.1' }),
      }),
    ).toEqual({ ok: false, reason: 'consentMissing' });
  });

  it('refuses a version match with no timestamp — consent is an EVENT', () => {
    expect(
      resolveAiCredentials({
        shop: 's',
        settings: managedShop({ aiProcessingConsentAt: null }),
      }),
    ).toEqual({ ok: false, reason: 'consentMissing' });
  });

  it('does not ask a BYO shop for consent at all', () => {
    // The merchant's own key needs no permission from us to be used.
    const decision = resolveAiCredentials({
      shop: 's',
      settings: byoShop({ aiProcessingConsentAt: null, aiProcessingConsentVersion: null }),
    });
    expect(decision.ok).toBe(true);
  });
});

describe('the BYO path', () => {
  it('refuses with the PROVIDER that is missing a key', () => {
    expect(
      resolveAiCredentials({
        shop: 's',
        settings: byoShop({ openaiApiKey: null }),
      }),
    ).toEqual({ ok: false, reason: 'noKey', provider: 'openai' });
  });

  it('names the preferred provider, not whichever key happens to exist', () => {
    // A shop with a Claude key but preferring OpenAI is missing an OpenAI key.
    expect(
      missingMerchantKey(
        byoShop({ openaiApiKey: null, claudeApiKey: 'sk-ant' }) as never,
      ),
    ).toBe('openai');
  });

  it('carries the merchant\'s own model choice', () => {
    const decision = resolveAiCredentials({ shop: 's', settings: byoShop() });
    expect(decision.ok && decision.config.selectedModel).toBe('gpt-4o-mini');
    expect(decision.ok && decision.config.credentialSource).toBe('byo');
  });

  it('treats a whitespace-only stored key as no key', () => {
    expect(
      resolveAiCredentials({ shop: 's', settings: byoShop({ openaiApiKey: '   ' }) }),
    ).toEqual({ ok: false, reason: 'noKey', provider: 'openai' });
  });
});

describe('the operator credential is read as a UNIT', () => {
  it('a partial configuration yields nothing', () => {
    process.env.MANAGED_AI_ENABLED = 'true';
    process.env.MANAGED_AI_PROVIDER = 'openai';
    process.env.MANAGED_AI_MODEL = 'gpt-5-nano';
    // no key
    expect(readManagedCredential('default')).toBeNull();
    expect(managedAiAvailable()).toBe(false);
  });

  it('an UNKNOWN provider name is ignored rather than defaulted', () => {
    // `toValidProvider` falls back to 'claude', which is right for a
    // merchant's stored preference and catastrophic here: it would pair an
    // unknown provider's key with Anthropic's endpoint.
    configureManaged();
    process.env.MANAGED_AI_PROVIDER = 'openai-compatible-gateway';
    expect(readManagedCredential('default')).toBeNull();
    expect(
      resolveAiCredentials({ shop: 's', settings: managedShop({ openaiApiKey: null }) }),
    ).toEqual({ ok: false, reason: 'managedUnavailable' });
  });

  it('falls back to the DEFAULT credential when no failover is configured', () => {
    configureManaged();
    const decision = resolveAiCredentials({ shop: 's', settings: managedShop(), role: 'failover' });
    expect(decision.ok).toBe(true);
    if (!decision.ok || decision.source !== 'managed') throw new Error('expected managed');
    // Reported honestly as the default, not as a failover that did not happen.
    expect(decision.role).toBe('default');
    expect(decision.provider).toBe('openai');
  });

  it('serves the failover credential when one IS configured', () => {
    configureManaged();
    process.env.MANAGED_AI_FALLBACK_PROVIDER = 'claude';
    process.env.MANAGED_AI_FALLBACK_MODEL = 'claude-haiku-4-5';
    process.env.MANAGED_AI_FALLBACK_API_KEY = 'sk-ant-operator';

    const decision = resolveAiCredentials({ shop: 's', settings: managedShop(), role: 'failover' });
    if (!decision.ok || decision.source !== 'managed') throw new Error('expected managed');
    expect(decision.role).toBe('failover');
    expect(decision.provider).toBe('claude');
    expect(decision.config.claudeApiKey).toBe('sk-ant-operator');
    // The key goes in ITS provider's slot and nowhere else.
    expect(decision.config.openaiApiKey).toBeUndefined();
  });
});

describe('a refusal is a value, never an exception', () => {
  it('every refusal path returns instead of throwing', () => {
    // §6a rule 1: inside a detached repair a thrown error is indistinguishable
    // from "the AI could not deliver", which becomes translationsRemove plus a
    // local delete. A refusal that can be inspected is what lets that path
    // abort instead.
    const cases: Settings[] = [
      byoShop({ openaiApiKey: null }),
      managedShop(),
      managedShop({ aiProcessingConsentVersion: 'old' }),
      null,
    ];
    for (const settings of cases) {
      expect(() => resolveAiCredentials({ shop: 's', settings })).not.toThrow();
    }
  });

  it('a shop with no settings row at all is a missing key, not a crash', () => {
    expect(resolveAiCredentials({ shop: 's', settings: null })).toEqual({
      ok: false,
      reason: 'noKey',
      provider: 'claude',
    });
  });
});

describe('a spent taster hands the shop back to its own key (§10)', () => {
  beforeEach(configureManaged);

  it('a shop that never bought it, taster spent, WITH a key of its own', () => {
    // The state a cancelled AI-included plan leaves behind: the stored choice
    // is still "managed" (cancelling deliberately keeps it, and keeps the
    // stored keys), but there is no entitlement and no grant left. Before
    // this rule that shop sat in managed mode refusing every call while
    // holding a perfectly good credential nothing ever reached.
    const decision = resolveAiCredentials({
      shop: 's',
      settings: managedShop({
        managedAiActive: false,
        managedAiTasterSpentAt: new Date('2026-09-01'),
      }),
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('expected ok');
    expect(decision.source).toBe('byo');
  });

  it('…and refuses with tasterExhausted when there is no key to fall back to', () => {
    expect(
      resolveAiCredentials({
        shop: 's',
        settings: managedShop({
          managedAiActive: false,
          openaiApiKey: null,
          managedAiTasterSpentAt: new Date('2026-09-01'),
        }),
      }),
    ).toMatchObject({ ok: false, reason: 'tasterExhausted' });
  });

  it('a shop that BOUGHT managed is unaffected by an old taster stamp', () => {
    // It has a period budget; the stamp is a record of a grant it spent
    // before it bought anything.
    const decision = resolveAiCredentials({
      shop: 's',
      settings: managedShop({ managedAiTasterSpentAt: new Date('2026-09-01') }),
    });
    expect(decision.ok && decision.source).toBe('managed');
  });
});
