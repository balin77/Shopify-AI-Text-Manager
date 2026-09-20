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

describe('the operator credential has exactly one reader', () => {
  it('no file outside the resolver mentions a MANAGED_AI_* variable', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const rel = relative(root, file).replace(/\\/g, '/');
      if (ALLOWED.has(rel)) continue;
      // `PLAN_MANAGED_AI_KEY` is the plan's filename and appears in comments
      // all over the app — a doc reference is not a credential read, and a
      // rule that could not tell them apart would be turned off within a week.
      const src = readFileSync(file, 'utf8').replace(/PLAN_MANAGED_AI_KEY/g, '');
      if (/MANAGED_AI_[A-Z_]+/.test(src)) offenders.push(rel);
    }
    expect(offenders, `these files read the operator credential: ${offenders.join(', ')}`).toEqual([]);
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
