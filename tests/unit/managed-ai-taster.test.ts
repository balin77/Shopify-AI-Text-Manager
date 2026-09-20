/**
 * The one-time taster — PLAN_MANAGED_AI_KEY §10.
 *
 * `managed-ai-margin.test.ts` pins the LADDER (how big the grant may be); this
 * pins the ENFORCEMENT: who gets a period budget, who falls to the taster, and
 * — the rule that carries the whole thing — that the key the meter WRITES under
 * is the key the budget READS under.
 *
 * That last one is not decoration. Written under `b:2026-10-14` and read back
 * under `taster`, the used figure is always zero, the cap never fires, and a
 * free shop spends the operator's key without limit. The two sides therefore
 * call ONE function, and both directions are asserted here against the same
 * settings object.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('~/utils/encryption.server', () => ({
  tryDecryptApiKey: (value: string | null | undefined) => value ?? null,
}));

vi.mock('~/utils/logger.server', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  loggers: { ai: vi.fn(), queue: vi.fn() },
}));

const aggregate = vi.fn();
vi.mock('~/db.server', () => ({
  db: {
    aiUsageCounter: { aggregate: (...args: unknown[]) => aggregate(...args) },
    aISettings: { findUnique: vi.fn().mockResolvedValue(null), updateMany: vi.fn() },
  },
}));

import {
  managedBudgetStatus,
  managedPeriodKey,
  managedPoolFor,
  periodBudgetMicros,
} from '~/services/ai/managed-budget.server';
import { resolveAiCredentials, managedTasterLimitMicros } from '~/services/ai/ai-credentials.server';
import { AI_PROCESSING_CONSENT_VERSION } from '~/services/ai/managed-ai.shared';
import { MANAGED_BUDGET_MICROS, TASTER_PERIOD } from '~/config/managed-ai-budget';

type Settings = Parameters<typeof managedBudgetStatus>[1];

const shop = 'taster-test.myshopify.com';

const settingsFor = (over: Record<string, unknown> = {}) =>
  ({
    preferredProvider: 'openai',
    openaiApiKey: 'sk-merchant',
    aiKeySource: 'managed',
    managedAiActive: false,
    managedAiPeriodEnd: null,
    managedAiTasterGrantedAt: null,
    subscriptionPlan: 'free',
    aiProcessingConsentAt: new Date(),
    aiProcessingConsentVersion: AI_PROCESSING_CONSENT_VERSION,
    ...over,
  }) as unknown as Settings;

const ENV = ['MANAGED_AI_ENABLED', 'MANAGED_AI_PROVIDER', 'MANAGED_AI_MODEL', 'MANAGED_AI_API_KEY'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.MANAGED_AI_ENABLED = 'true';
  process.env.MANAGED_AI_PROVIDER = 'openai';
  process.env.MANAGED_AI_MODEL = 'gpt-5-nano';
  process.env.MANAGED_AI_API_KEY = 'sk-operator';
  aggregate.mockReset();
  aggregate.mockResolvedValue({ _sum: { billedMicros: null } });
});

afterEach(() => {
  // Restored by SETTING, never by delete — the TZ lesson in use-hydrated.test.ts.
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('who gets a PERIOD budget and who gets the taster', () => {
  it('a shop that bought the AI-included variant gets its plan volume', () => {
    const settings = settingsFor({ managedAiActive: true, subscriptionPlan: 'pro' });
    expect(periodBudgetMicros(shop, settings, 'pro')).toBe(MANAGED_BUDGET_MICROS.pro);
    expect(managedPoolFor(shop, settings, 'pro')).toBe('paid');
  });

  it('a PAID shop that did NOT buy it gets no period volume — the tampering case', () => {
    // Posting `aiKeySource=managed` from the BYO variant of Pro must not hand
    // out Pro's monthly budget. `managedAiActive` is mirrored by
    // checkAndSyncSubscription and settable by nobody else.
    const settings = settingsFor({ subscriptionPlan: 'pro' });
    expect(periodBudgetMicros(shop, settings, 'pro')).toBe(0);
    expect(managedPoolFor(shop, settings, 'pro')).toBe('taster');
  });

  it('a free shop gets no period volume', () => {
    expect(periodBudgetMicros(shop, settingsFor(), 'free')).toBe(0);
  });

  it('a dev store and a trialing shop get none either (§7a, §7 rule 1)', () => {
    const dev = settingsFor({ managedAiActive: true, subscriptionPlan: 'max', partnerDevelopment: true });
    expect(periodBudgetMicros(shop, dev, 'max')).toBe(0);

    const trialing = settingsFor({
      managedAiActive: true,
      subscriptionPlan: 'max',
      trialConsumedAt: new Date(),
    });
    expect(periodBudgetMicros(shop, trialing, 'max')).toBe(0);
  });
});

describe('the meter writes under the key the budget reads under', () => {
  it('a taster shop: the credential and the budget agree on `taster`', async () => {
    const settings = settingsFor({ managedAiPeriodEnd: new Date('2099-10-14T00:00:00Z') });

    const decision = resolveAiCredentials({ shop, settings });
    if (!decision.ok || decision.source !== 'managed') throw new Error('expected managed');

    const status = await managedBudgetStatus(shop, settings, 'free');
    expect(status.kind).toBe('taster');
    expect(status.period).toBe(TASTER_PERIOD);
    expect(decision.config.usagePeriod).toBe(status.period);
    expect(decision.config.usagePool).toBe('taster');
    expect(managedPeriodKey(shop, settings, 'free')).toBe(status.period);
    // And the aggregate really asked for that key.
    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shop, period: TASTER_PERIOD, source: 'managed' },
      }),
    );
  });

  it('a paying shop: both sides agree on the BILLING period', async () => {
    const settings = settingsFor({
      managedAiActive: true,
      subscriptionPlan: 'basic',
      managedAiPeriodEnd: new Date('2099-10-14T00:00:00Z'),
    });

    const decision = resolveAiCredentials({ shop, settings });
    if (!decision.ok || decision.source !== 'managed') throw new Error('expected managed');

    const status = await managedBudgetStatus(shop, settings, 'basic');
    expect(status.kind).toBe('period');
    expect(status.period).toBe('b:2099-10-14');
    expect(decision.config.usagePeriod).toBe(status.period);
    expect(status.limitMicros).toBe(MANAGED_BUDGET_MICROS.basic);
  });
});

describe('the grant is spent once and never comes back', () => {
  it('allows while the ledger is under the limit', async () => {
    aggregate.mockResolvedValue({ _sum: { billedMicros: BigInt(1_000) } });
    const status = await managedBudgetStatus(shop, settingsFor(), 'free');
    expect(status.allowed).toBe(true);
    expect(status.remainingMicros).toBe(status.limitMicros - 1_000);
  });

  it('refuses once the taster row reaches the limit — and there is no next period', async () => {
    const limit = managedTasterLimitMicros();
    expect(limit).toBeGreaterThan(0);
    aggregate.mockResolvedValue({ _sum: { billedMicros: BigInt(limit) } });

    const status = await managedBudgetStatus(shop, settingsFor(), 'free');
    expect(status.allowed).toBe(false);
    expect(status.kind).toBe('taster');
    // The key has no successor: `m:`/`b:` roll over, this one cannot.
    expect(status.period).toBe(TASTER_PERIOD);
  });

  it('a shop that UPGRADES after spending its taster gets a fresh PERIOD budget', async () => {
    // The point is the KEY separation, so the ledger has to be asked with a
    // spent taster row really in it: answering zero for every period would
    // pass whether or not the two keys were told apart.
    aggregate.mockImplementation(async (args: { where: { period: string } }) => ({
      _sum: {
        billedMicros:
          args.where.period === TASTER_PERIOD ? BigInt(managedTasterLimitMicros()) : BigInt(0),
      },
    }));

    const spent = await managedBudgetStatus(shop, settingsFor(), 'free');
    expect(spent.allowed).toBe(false);

    const bought = await managedBudgetStatus(
      shop,
      settingsFor({
        managedAiActive: true,
        subscriptionPlan: 'basic',
        managedAiPeriodEnd: new Date('2099-10-14T00:00:00Z'),
      }),
      'basic',
    );
    expect(bought.kind).toBe('period');
    expect(bought.period).toBe('b:2099-10-14');
    expect(bought.usedMicros).toBe(0);
    expect(bought.allowed).toBe(true);
  });
});

describe('a taster it cannot size is a refusal, never an unlimited grant', () => {
  it('no managed credential configured ⇒ zero, and the budget refuses', async () => {
    delete process.env.MANAGED_AI_API_KEY;
    expect(managedTasterLimitMicros()).toBe(0);

    const status = await managedBudgetStatus(shop, settingsFor(), 'free');
    expect(status.limitMicros).toBe(0);
    expect(status.allowed).toBe(false);
  });

  it('a DB failure refuses rather than spending on unread evidence', async () => {
    aggregate.mockRejectedValue(new Error('connection reset'));
    const status = await managedBudgetStatus(shop, settingsFor(), 'free');
    expect(status.allowed).toBe(false);
  });
});

describe('the grant is frozen once it starts', () => {
  it('a stored worth wins over the current model price', async () => {
    // Otherwise "once, ever" is really "once per managed-model price": the
    // limit is re-derived on every read while the used figure never resets,
    // so moving MANAGED_AI_MODEL to a dearer model silently hands a second
    // taster to every shop that spent its first — an ops action nobody would
    // associate with a grant.
    const frozen = 120_050;
    process.env.MANAGED_AI_MODEL = 'claude-opus-4-0-20250514';
    process.env.MANAGED_AI_PROVIDER = 'claude';

    const status = await managedBudgetStatus(
      shop,
      settingsFor({ managedAiTasterMicros: frozen }),
      'free',
    );
    expect(status.limitMicros).toBe(frozen);
    // Without the freeze this deployment would grant the ladder ceiling.
    expect(managedTasterLimitMicros()).toBeGreaterThan(frozen);
  });

  it('and a shop that has not started one is sized at the current model', async () => {
    const status = await managedBudgetStatus(shop, settingsFor(), 'free');
    expect(status.limitMicros).toBe(managedTasterLimitMicros());
  });
});

describe('which POOL a taster spend lands in', () => {
  it('a trialing shop that BOUGHT the variant draws on the paid pool', () => {
    // It has no period budget (§7 rule 1) and therefore spends the taster,
    // but it is a paying customer in waiting: letting it into the taster pool
    // would let paying shops exhaust the ring that keeps free installs off
    // the paid one.
    const trialing = settingsFor({
      managedAiActive: true,
      subscriptionPlan: 'max',
      trialConsumedAt: new Date(),
    });
    expect(periodBudgetMicros(shop, trialing, 'max')).toBe(0);
    expect(managedPoolFor(shop, trialing, 'max')).toBe('paid');
  });

  it('a free shop draws on the taster pool', () => {
    expect(managedPoolFor(shop, settingsFor(), 'free')).toBe('taster');
  });
});

describe('a plan column that contradicts the entitlement is never a grant', () => {
  it('bought + free plan refuses as UNAVAILABLE, and spends no taster', async () => {
    // The state a throttled subscription lookup used to leave behind. It is
    // ours to fix, so it must not read as "your volume is used up" and must
    // not quietly consume the one-time grant.
    const status = await managedBudgetStatus(
      shop,
      settingsFor({ managedAiActive: true, subscriptionPlan: 'free' }),
      'free',
    );
    expect(status.allowed).toBe(false);
    expect(status.unavailable).toBe(true);
    expect(status.kind).toBe('period');
    expect(aggregate).not.toHaveBeenCalled();
  });
});
