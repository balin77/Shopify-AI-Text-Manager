/**
 * `scripts/validate-env.js` is a plain-JS twin of three TypeScript sources —
 * PLAN_MANAGED_AI_KEY §9.6.
 *
 * It runs before the build, so it cannot import them. That is the same
 * arrangement `gdpr-audit-cleanup` uses for its own twin, and the same rule
 * applies: the copies are pinned against each other here, or they drift and
 * the check silently stops checking. Which is exactly what happened to the
 * dev-build guard — it read `process.env.DEV_APP_CLIENT_ID`, which is not an
 * environment variable anywhere in this repo, so it was dead in every
 * deployment while looking like a guard.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODEL_PRICING, UNPRICED_PROVIDERS } from '~/config/ai-pricing';
import { DEV_APP_CLIENT_ID } from '~/services/dev-plan-override.server';

const src = readFileSync(join(__dirname, '..', '..', 'scripts/validate-env.js'), 'utf8');

/** Read one of the script's literal arrays/objects back out of its source. */
function literal(name: string): string {
  const start = src.indexOf(`const ${name} =`);
  expect(start, `${name} is gone from validate-env.js`).toBeGreaterThan(-1);
  const end = src.indexOf('\n};', start) >= 0 && src.indexOf('\n};', start) < src.indexOf('\n', src.indexOf('];', start))
    ? src.indexOf('\n};', start) + 3
    : src.indexOf('];', start) + 2;
  return src.slice(start, end);
}

describe('the script and the price table agree', () => {
  it('knows every provider the app prices, and no others', () => {
    const block = literal('KNOWN_AI_PROVIDERS');
    for (const provider of Object.keys(MODEL_PRICING)) {
      expect(block, `validate-env does not know ${provider}`).toContain(`'${provider}'`);
    }
  });

  it('refuses exactly the providers the app cannot price', () => {
    const block = literal('UNPRICEABLE_AI_PROVIDERS');
    for (const provider of UNPRICED_PROVIDERS) {
      expect(block, `validate-env would accept unpriceable ${provider}`).toContain(`'${provider}'`);
    }
    // And does not refuse one we CAN price.
    for (const provider of Object.keys(MODEL_PRICING)) {
      if (UNPRICED_PROVIDERS.has(provider as never)) continue;
      expect(block).not.toContain(`'${provider}'`);
    }
  });

  it('lists every priced model id, so a typo cannot boot cleanly', () => {
    // An unlisted id meters at the provider's unknown-model CEILING — a guess,
    // and on the managed path the budget is then enforced against it.
    const block = literal('PRICED_AI_MODELS');
    for (const [provider, models] of Object.entries(MODEL_PRICING)) {
      for (const id of Object.keys(models)) {
        expect(block, `validate-env would reject the priced model ${provider}/${id}`).toContain(
          `'${id}'`,
        );
      }
    }
  });
});

describe('the dev-build guard uses the real client id', () => {
  it('names the same constant the app does', () => {
    expect(src).toContain(DEV_APP_CLIENT_ID);
  });

  it('does not read it from the environment, where it does not exist', () => {
    expect(src).not.toMatch(/process\.env\.DEV_APP_CLIENT_ID/);
  });
});
