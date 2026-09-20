/**
 * ONE module may hold the operator key — PLAN_MANAGED_AI_KEY §2, §5.
 *
 * The compliance audit's §B4 permits an operator-owned AI key only behind an
 * explicit, logged consent gate. The app's guarantee is structural rather than
 * procedural: the credential is read by exactly one module, and that module is
 * also the one that checks consent, the kill switch and the dev-build guard.
 * A key that can only be obtained together with its gate cannot be obtained
 * past it — but only while this stays true, which is what this test is for.
 *
 * Deliberately scoped to the MANAGED_AI_* names. A blanket `*_API_KEY` rule
 * would match `SHOPIFY_API_KEY`, which has about ten legitimate uses.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(__dirname, '..', '..');
const RESOLVER = 'app/services/ai/ai-credentials.server.ts';

/** Source trees that ship as the running app. */
const SCANNED = ['app', 'src', 'scripts', 'server.js'];

/** Files allowed to mention a MANAGED_AI_* name, and why. */
const ALLOWED = new Set([
  RESOLVER, // the resolver itself
  'scripts/validate-env.js', // startup validation must name what it validates
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const target of SCANNED) {
    const full = join(root, target);
    try {
      if (statSync(full).isDirectory()) walk(full, files);
      else files.push(full);
    } catch {
      // A scanned path that does not exist is not a failure of this test.
    }
  }
  return files;
}

/**
 * What must have ONE reader is the SECRET and the switch that permits its use.
 *
 * Not every `MANAGED_AI_*` name: the rate-limit window of our account
 * (`MANAGED_AI_TPM`/`RPM`) belongs to the queue that admits against it, and
 * the global pool ceilings belong to the module that enforces them. Those are
 * ops numbers — they cannot leak a credential, and routing them through the
 * resolver would put a key-holding module in two more import graphs for no
 * gain. The rule says what it protects, or it is a rule people widen until it
 * protects nothing.
 */
const CREDENTIAL_ENV = [
  'MANAGED_AI_API_KEY',
  'MANAGED_AI_FALLBACK_API_KEY',
  // The kill switch: whether the credential may be used at all. A second
  // reader could serve the key in a deployment that had switched it off.
  'MANAGED_AI_ENABLED',
];

describe('the operator credential has exactly one reader', () => {
  it('no file outside the resolver reads the operator SECRET or its switch', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const rel = relative(root, file).replace(/\\/g, '/');
      if (ALLOWED.has(rel)) continue;
      // What the rule MEANS is "reads a MANAGED_AI_* variable out of the
      // environment", and it has to say so: a broad match on the identifier
      // also hits `PLAN_MANAGED_AI_KEY` (the plan's filename, quoted in
      // comments all over the app) and `MANAGED_AI_REFUSED` (an error code).
      // A guard that fires on a doc reference is one somebody turns off.
      const src = readFileSync(file, 'utf8');
      // Three shapes, because two of them slipped past the first version:
      // a direct read, a DESTRUCTURE off process.env, and an aliased env
      // object. Everything else that mentions one of these names is a doc
      // reference (`PLAN_MANAGED_AI_KEY`) or an error code
      // (`MANAGED_AI_REFUSED`), and a guard that fires on those is one
      // somebody turns off.
      const destructured = new RegExp(
        `const\\s*\\{[^}]*(${CREDENTIAL_ENV.join('|')})[^}]*\\}\\s*=\\s*process\\.env`,
      ).test(src);
      const aliased = new RegExp(
        `=\\s*process\\.env\\s*;[\\s\\S]*?\\.(${CREDENTIAL_ENV.join('|')})\\b`,
      ).test(src);
      if (destructured || aliased) {
        offenders.push(`${rel} (env destructure/alias)`);
        continue;
      }
      for (const name of CREDENTIAL_ENV) {
        for (const match of src.matchAll(new RegExp(name, 'g'))) {
          const before = src.slice(Math.max(0, match.index - 80), match.index);
          if (/process\.env\s*[.[]?[^;]*$/.test(before)) {
            offenders.push(`${rel} (${name})`);
            break;
          }
        }
      }
    }
    expect(offenders, `these files read the operator credential: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the operator SECRET is not even NAMED outside the resolver and validate-env', () => {
    // The resolver builds the variable name from a prefix, so a `process.env`
    // proximity check alone could miss a second reader that spells it out.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const rel = relative(root, file).replace(/\\/g, '/');
      if (ALLOWED.has(rel)) continue;
      const src = readFileSync(file, 'utf8');
      if (/MANAGED_AI(_FALLBACK)?_API_KEY/.test(src)) offenders.push(rel);
    }
    expect(offenders, `these files name the operator secret: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the resolver really does read it — an allowlist over nothing proves nothing', () => {
    const src = readFileSync(join(root, RESOLVER), 'utf8');
    expect(src).toMatch(/MANAGED_AI_ENABLED/);
    expect(src).toMatch(/\$\{prefix\}API_KEY/);
  });

  it('and it gates that credential on consent, the kill switch and the dev build', () => {
    const src = readFileSync(join(root, RESOLVER), 'utf8');
    expect(src).toMatch(/hasCurrentAiProcessingConsent/);
    expect(src).toMatch(/isManagedAiEnabled/);
    expect(src).toMatch(/isDevAppBuild/);
  });
});

describe('no AIServiceConfig literal outside the resolver', () => {
  it('nobody builds their own bag of decrypted merchant keys', () => {
    // Ten copies of the same six decrypt lines is what made "the operator key
    // has one reader" impossible to state: managed mode would have had to be
    // added to each of them, and the one that was missed would silently keep
    // spending the merchant's key.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const rel = relative(root, file).replace(/\\/g, '/');
      if (rel === RESOLVER) continue;
      const src = readFileSync(file, 'utf8');
      // The shape is unmistakable: a decrypted key for one provider next to a
      // decrypted key for another. `loader-helpers.ts` builds `has*ApiKey`
      // BOOLEANS for the UI and does not match.
      if (
        /(?<!has)(?<!Has)\bhuggingfaceApiKey:\s*tryDecryptApiKey/.test(src) &&
        /(?<!has)(?<!Has)\bclaudeApiKey:\s*tryDecryptApiKey/.test(src)
      ) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      `these files build their own credential config: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});

describe('the forbidden provider env names stay gone', () => {
  const FORBIDDEN = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GOOGLE_API_KEY',
    'GROK_API_KEY',
    'DEEPSEEK_API_KEY',
    'HUGGINGFACE_API_KEY',
  ];

  it('no source file reads one', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const src = readFileSync(file, 'utf8');
      for (const name of FORBIDDEN) {
        // `process.env.X` or `process.env["X"]` — a mention in a comment is
        // not a read, and the templates explain why the names are absent.
        if (new RegExp(`process\\.env(\\.${name}\\b|\\[["']${name}["']\\])`).test(src)) {
          offenders.push(`${relative(root, file)} -> ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('and no env template still invites one to be set', () => {
    for (const template of ['.env.development.template', '.env.production.template']) {
      const src = readFileSync(join(root, template), 'utf8');
      for (const name of FORBIDDEN) {
        expect(
          new RegExp(`^${name}=`, 'm').test(src),
          `${template} still declares ${name}`,
        ).toBe(false);
      }
    }
  });
});
