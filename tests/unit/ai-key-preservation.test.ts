/**
 * Switching to managed AI must not cost the merchant their stored keys —
 * PLAN_MANAGED_AI_KEY §8a rules 4 and 5.
 *
 * The owner's rule: *"if the merchant once entered keys, they are not deleted;
 * they may want to switch back"*. This is a source-shape guard, because the
 * property is about which action writes which column and that is exactly what
 * a payload-level test cannot see.
 *
 * The first draft of §8a claimed the hazard was "the next settings save writes
 * null over all six keys". Review corrected it: every other tab posts its own
 * narrow actionType and none touches the key columns, so hiding the tab
 * REMOVES the only writer. What is real is structural — a catch-all `else`
 * that writes keys would null them for any future payload that lands in it,
 * because `encryptApiKey(undefined)` returns null exactly like
 * `encryptApiKey("")`. That branch is now named and unknown actions 400.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const settingsRoute = readFileSync(join(root, 'app/routes/app.settings.tsx'), 'utf8');

/** The body of one `actionType === "x"` branch. */
function branch(name: string): string {
  const start = settingsRoute.indexOf(`actionType === "${name}"`);
  expect(start, `no ${name} branch`).toBeGreaterThan(-1);
  const next = settingsRoute.indexOf('} else if (actionType ===', start + 10);
  return settingsRoute.slice(start, next > -1 ? next : start + 4000);
}

const KEY_COLUMNS = [
  'huggingfaceApiKey',
  'geminiApiKey',
  'claudeApiKey',
  'openaiApiKey',
  'grokApiKey',
  'deepseekApiKey',
];

describe('only the save that OWNS the keys may write them', () => {
  it('recording consent writes no key column', () => {
    const body = branch('saveAiProcessingConsent');
    for (const column of KEY_COLUMNS) {
      expect(body, `consent writes ${column}`).not.toContain(`${column}:`);
    }
  });

  it('the language and vision saves still write no key column', () => {
    for (const action of ['saveAppLanguage', 'saveAiVision']) {
      const body = branch(action);
      for (const column of KEY_COLUMNS) {
        expect(body, `${action} writes ${column}`).not.toContain(`${column}:`);
      }
    }
  });
});

describe('a merchant can still erase a credential they gave us', () => {
  it('deleteAiKeys clears all six and nothing else', () => {
    // Without this, hiding the key fields would leave "uninstall the app" as
    // the only erasure route — a weak answer to a GDPR request and an obvious
    // App Review question.
    const body = branch('deleteAiKeys');
    for (const column of KEY_COLUMNS) {
      expect(body, `deleteAiKeys does not clear ${column}`).toContain(`${column}: null`);
    }
    // The provider and model survive, so deleting a key and pasting a new one
    // puts the merchant back where they were.
    expect(body).not.toContain('preferredProvider:');
    expect(body).not.toContain('selectedModel:');
  });
});

/** Every Prisma `data: { … }` block in the settings route, brace-matched. */
function dataBlocks(): string[] {
  const blocks: string[] = [];
  for (const match of settingsRoute.matchAll(/\bdata:\s*\{/g)) {
    let depth = 0;
    let i = settingsRoute.indexOf('{', match.index);
    const start = i;
    for (; i < settingsRoute.length; i++) {
      if (settingsRoute[i] === '{') depth++;
      else if (settingsRoute[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    blocks.push(settingsRoute.slice(start, i + 1));
  }
  return blocks;
}

describe('the managed mode cannot be granted by a form', () => {
  it('there is no action that switches the AI source — the PLAN decides', () => {
    // The owner's decision (2026-10-01): the merchant no longer chooses the
    // mode. An action that still accepted a source would be a second answer
    // to a question only the billing sync may answer.
    expect(settingsRoute).not.toContain('actionType === "saveAiSource"');
    const writers = dataBlocks().filter((b) => /\baiKeySource\b/.test(b));
    expect(writers, 'a settings write touches aiKeySource').toEqual([]);
  });

  it('nothing in the settings route WRITES managedAiActive', () => {
    // A form that could set it would be a free operator key for anyone who
    // can open devtools. Reads are fine and plentiful (the select, the loader
    // payload, the 403 check) — what must not exist is the column inside a
    // Prisma `data:` block, which is the only shape that writes.
    const offenders = dataBlocks()
      .filter((block) => /\bmanagedAiActive\b/.test(block))
      .map((block) => block.slice(0, 120));
    expect(offenders, 'a settings write touches managedAiActive').toEqual([]);
  });
});

describe('the key plaintext stops travelling under a plan with AI', () => {
  it('the loader withholds the keys exactly when a VERIFIED AI plan is served', () => {
    // It used to decrypt unconditionally and ship six credentials to the
    // browser on every Settings load. A taster shop has no key by definition
    // and must be able to add one, so only a verified plan that actually
    // carries a period budget withholds them (`keyFieldsWithheld`).
    expect(settingsRoute).toMatch(
      /const keysWithheld = keyFieldsWithheld\(session\.shop, settings\);/,
    );
    expect(settingsRoute).toMatch(/if \(!keysWithheld\) \{[\s\S]{0,400}decryptApiKeyChecked/);
  });

  it('saveAiKeys writes no key column under a plan with AI, whatever the form says', () => {
    // Under the plan the tab is seeded with "" for every key, and
    // `encryptApiKey("")` is null — writing that back would delete every
    // stored merchant key. The STORED entitlement refuses even when a form
    // (stale bundle, devtools) omits `keysWithheld`.
    const body = branch('saveAiKeys');
    expect(body).toContain('formData.get("keysWithheld") === "true"');
    expect(body).toMatch(/keyFieldsWithheld\(session\.shop, storedForKeys\)/);
    expect(body).toMatch(/const keyWrites = keysWithheld\s*\?\s*\{\}/);
  });

  it('and the merchant is still told how many are stored', () => {
    expect(settingsRoute).toContain('storedApiKeyCount');
  });
});
