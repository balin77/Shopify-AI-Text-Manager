/**
 * A managed refusal ABORTS the repair — it never becomes a deletion.
 *
 * PLAN_MANAGED_AI_KEY §6a rule 1 and §3a rule 5, and the only test in this
 * plan that protects merchant DATA rather than money.
 *
 * The mechanism it guards: `reconcileStaleTranslations` turns "the AI could
 * not deliver this entry" into `translationsRemove` plus a local delete. On a
 * shop with auto-translate on, `mayPurge` is always true — that is exactly the
 * population managed mode serves. So a refusal mistaken for a failure deletes
 * every storefront translation of every changed field because our prepaid
 * budget ran out, and it is unrecoverable: the digest baseline has already
 * advanced, so nothing will ever detect those rows as stale again.
 *
 * Asserted PER REASON, not once. Each arrives through a different door — the
 * budget and the spent TASTER (§10) from the per-request preflight,
 * `managedUnavailable` from the kill switch or a pool that emptied mid-outage,
 * `consentMissing` from a withdrawal during a long run — and the first cut of
 * this plan immunised only the budget.
 */

import { describe, it, expect } from 'vitest';
import { AI_REFUSAL_CODES, AI_REFUSAL_STATUS } from '~/services/ai/managed-ai.shared';
import { taskErrorText } from '~/utils/task-error-text';
import {
  ManagedAiRefusedError,
  isManagedRefusal,
  MissingAIKeyError,
} from '../../src/services/ai.service';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPAIR = join(__dirname, '..', '..', 'app/services/translations/stale-translation-sync.server.ts');

// EVERY refusal code, read from the source rather than listed here — a new
// one must force a decision in this file instead of quietly inheriting
// whatever the previous ones do. The equality assertion below is what makes
// that true; a hand-kept copy would simply drift.
const REASONS = AI_REFUSAL_CODES;

describe('a managed refusal is recognisable', () => {
  it('every refusal code this app can produce is covered here', () => {
    // The `it.each` below is true for ANY string — `isManagedRefusal` keys on
    // the class and the code and never on a reason list, which is exactly
    // what makes it safe. So the assertion that has to bite is this one: a
    // new code added to `AI_REFUSAL_CODES` must appear in the per-reason
    // sweep, and in the HTTP and task-error maps the two tests after it read.
    expect([...REASONS].sort()).toEqual(
      ['budgetExceeded', 'consentMissing', 'managedUnavailable', 'noKey', 'tasterExhausted'].sort(),
    );
  });

  it.each(REASONS)('%s is identified as a refusal', (reason) => {
    expect(isManagedRefusal(new ManagedAiRefusedError(reason))).toBe(true);
  });

  it.each(REASONS)('%s has an HTTP status and a merchant sentence', (reason) => {
    // Adding a code without either is how a refusal comes to answer
    // `undefined` as its status and render an empty string at the merchant.
    expect(AI_REFUSAL_STATUS[reason]).toBeGreaterThanOrEqual(400);
    const text = taskErrorText(`managed_ai_refused:${reason}`, { tasks: { taskErrors: {} } });
    expect(typeof text === 'string' && text.trim().length > 0, reason).toBe(true);
  });

  it('is recognised by CODE as well as by instance', () => {
    // The error crosses a dynamic-import boundary on several of these paths,
    // where two copies of the class can exist and `instanceof` quietly answers
    // false — which here means a purge instead of an abort.
    const fromAnotherCopy = { code: 'MANAGED_AI_REFUSED', reason: 'budgetExceeded' };
    expect(isManagedRefusal(fromAnotherCopy)).toBe(true);
  });

  it('does NOT swallow an ordinary AI failure', () => {
    // The distinction is the whole point: a real failure still routes to the
    // removal, because a translation of text that no longer exists is worse
    // than no translation.
    expect(isManagedRefusal(new Error('provider returned empty content'))).toBe(false);
    expect(isManagedRefusal(new MissingAIKeyError('openai'))).toBe(false);
    expect(isManagedRefusal(null)).toBe(false);
    expect(isManagedRefusal(undefined)).toBe(false);
  });

  it('carries the numbers a merchant-facing message needs', () => {
    const err = new ManagedAiRefusedError('budgetExceeded', {
      usedMicros: 1_500_000,
      limitMicros: 1_500_000,
    });
    expect(err.reason).toBe('budgetExceeded');
    expect(err.limitMicros).toBe(1_500_000);
  });
});

describe('every purge path in the repair stands down on a refusal', () => {
  const src = readFileSync(REPAIR, 'utf8');

  it('the per-CHUNK catch re-throws instead of routing entries to removal', () => {
    // `translateBatchValues` throws on a length mismatch and this catch exists
    // to keep that from discarding the chunks already translated — which means
    // its fallthrough IS "route these entries to the removal".
    const chunk = src.slice(src.indexOf('} catch (chunkError'));
    const body = chunk.slice(0, chunk.indexOf('logger.warn'));
    expect(body).toMatch(/isManagedRefusal\(chunkError\)\)\s*throw chunkError/);
  });

  it('the per-LOCALE catch re-throws before "falling back to removal"', () => {
    const idx = src.indexOf('Auto-translation failed — falling back to removal');
    const before = src.slice(src.lastIndexOf('} catch', idx), idx);
    expect(before).toMatch(/isManagedRefusal\(error\)\)\s*throw error/);
  });

  it('the RUN-level catch re-throws rather than pushing every entry to `failed`', () => {
    // This one sweeps EVERY entry into `failed`, so without the guard one
    // refusal on the last locale would purge the whole resource.
    const idx = src.indexOf('Auto-translation run failed');
    const before = src.slice(src.lastIndexOf('} catch', idx), idx);
    expect(before).toMatch(/isManagedRefusal\(error\)/);
    expect(before).toMatch(/throw error/);
  });

  it('and the wrapper turns that throw into startFailed, which skips the purge', () => {
    // `retranslateStaleEntries` already had exactly the right semantics for a
    // run that could not START; a refusal reuses them rather than inventing a
    // second way to stand down.
    expect(src).toMatch(/return \{ registered: \[\], failed: \[\], startFailed: true \}/);
    const caller = src.slice(src.indexOf('!outcome.startFailed'));
    expect(caller.slice(0, 400)).toMatch(/purgeStaleEntries/);
  });

  it('a stood-down run does not report itself as failed', () => {
    // A red task blaming the automation for a budget the merchant can top up
    // is a defect report about nothing.
    expect(src).toMatch(/managed_ai_refused:/);
    expect(src).toMatch(/Auto-translation stood down — stale rows KEPT/);
  });
});
