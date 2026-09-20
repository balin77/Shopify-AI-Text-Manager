/**
 * Environment Variables Validation Script
 * Checks all required .env variables for correctness
 * Works both locally (with .env) and in production (with Railway env vars)
 */

// Only load .env if not in production (Railway sets env vars directly)
if (process.env.NODE_ENV !== 'production') {
  const { config } = await import('dotenv');
  config();
}

const errors = [];
const warnings = [];

// Required variables
const REQUIRED_VARS = [
  'SHOPIFY_API_KEY',
  'SHOPIFY_API_SECRET',
  'SHOPIFY_SCOPES',
  'SHOPIFY_APP_URL',
];

// Check if required vars exist
console.log('🔍 Validating environment variables...\n');

for (const varName of REQUIRED_VARS) {
  if (!process.env[varName]) {
    errors.push(`❌ Missing required variable: ${varName}`);
  } else {
    console.log(`✅ ${varName}: ${process.env[varName].substring(0, 20)}...`);
  }
}

// Validate SHOPIFY_API_KEY format
if (process.env.SHOPIFY_API_KEY) {
  if (process.env.SHOPIFY_API_KEY.length !== 32) {
    warnings.push(`⚠️  SHOPIFY_API_KEY should be 32 characters (current: ${process.env.SHOPIFY_API_KEY.length})`);
  }
}

// Validate SHOPIFY_API_SECRET format
if (process.env.SHOPIFY_API_SECRET) {
  if (!process.env.SHOPIFY_API_SECRET.startsWith('shpss_')) {
    warnings.push(`⚠️  SHOPIFY_API_SECRET should start with "shpss_"`);
  }
}

// Validate SHOPIFY_APP_URL
if (process.env.SHOPIFY_APP_URL) {
  const url = process.env.SHOPIFY_APP_URL;

  // Check for localhost in production
  if (process.env.NODE_ENV === 'production' && url.includes('localhost')) {
    errors.push(`❌ SHOPIFY_APP_URL cannot be localhost in production: ${url}`);
  }

  // Check for cloudflare tunnel (diese sind temporär!)
  if (url.includes('trycloudflare.com')) {
    warnings.push(`⚠️  SHOPIFY_APP_URL uses Cloudflare Tunnel (temporary!): ${url}`);
    warnings.push(`   Diese URL ist vermutlich abgelaufen. Bitte aktualisiere auf deine Railway URL!`);
    warnings.push(`   Railway URL Format: https://[your-project].up.railway.app`);
  }

  // Check for HTTPS
  if (!url.startsWith('https://')) {
    errors.push(`❌ SHOPIFY_APP_URL must use HTTPS: ${url}`);
  }

  // Check for trailing slash
  if (url.endsWith('/')) {
    warnings.push(`⚠️  SHOPIFY_APP_URL should not end with a slash: ${url}`);
  }
}

// Validate SHOPIFY_SCOPES
if (process.env.SHOPIFY_SCOPES) {
  console.log('\n📋 Detailed SHOPIFY_SCOPES validation:');
  console.log('   Raw value:', process.env.SHOPIFY_SCOPES);

  const scopes = process.env.SHOPIFY_SCOPES.split(',');
  console.log('   Parsed scopes count:', scopes.length);
  console.log('   Individual scopes:');
  scopes.forEach((scope, index) => {
    const trimmed = scope.trim();
    if (scope !== trimmed) {
      warnings.push(`⚠️  Scope at position ${index} has whitespace: "${scope}" (should be "${trimmed}")`);
      console.log(`     ${index + 1}. "${scope}" ⚠️ HAS WHITESPACE!`);
    } else {
      console.log(`     ${index + 1}. "${scope}"`);
    }
  });

  const requiredScopes = [
    'read_products',
    'write_products',
    'read_translations',
    'write_translations',
    'read_locales',
  ];

  const missingScopes = requiredScopes.filter(scope => !scopes.includes(scope));
  if (missingScopes.length > 0) {
    errors.push(`❌ Missing required scopes: ${missingScopes.join(', ')}`);
  } else {
    console.log(`✅ All required scopes present (${scopes.length} total)`);
  }
}

// ENCRYPTION_KEY: hard-required in production. Without it, encryption.server.ts
// throws at write time and merchant API keys / Shopify tokens / session PII
// would otherwise be at risk of being persisted in plaintext (schema columns
// are nullable String?). Must be exactly 64 hex chars (32 bytes).
const isProd = process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production';
const encKey = process.env.ENCRYPTION_KEY?.trim();
if (!encKey) {
  const msg = '❌ ENCRYPTION_KEY is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"';
  if (isProd) {
    errors.push(msg + ' (REQUIRED in production — API keys/tokens/PII must not be stored in plaintext)');
  } else {
    warnings.push('⚠️  ENCRYPTION_KEY is not set (tolerated in non-production only)');
  }
} else if (!/^[0-9a-fA-F]{64}$/.test(encKey)) {
  errors.push(`❌ ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). Current length: ${encKey.length}`);
} else {
  console.log('✅ ENCRYPTION_KEY: valid (64 hex chars)');
}

// Optional: Sentry status (never an error — purely informational)
console.log('\n📡 Sentry error tracking:');
if (!process.env.SENTRY_DSN) {
  console.log('   deaktiviert (SENTRY_DSN nicht gesetzt)');
} else if (process.env.APP_ENV !== 'production') {
  console.log(`   deaktiviert (APP_ENV=${process.env.APP_ENV || 'not set'} ≠ "production") — DSN gesetzt, aber Gate greift. Genau so gewollt für Dev/Staging.`);
} else {
  console.log('   ✅ aktiv (APP_ENV=production + SENTRY_DSN gesetzt)');
  console.log(`   Sourcemap-Upload: ${process.env.SENTRY_AUTH_TOKEN ? '✅ aktiv (SENTRY_AUTH_TOKEN gesetzt)' : 'deaktiviert (SENTRY_AUTH_TOKEN nicht gesetzt — Stacktraces bleiben minifiziert)'}`);
}

// Optional: Google Search Console (SEO tab Phase 6) — never an error, the
// feature is opt-in. Only CLIENT_ID + CLIENT_SECRET are actually required:
// getGscOAuthConfig() (app/services/google-search-console.server.ts) derives
// GOOGLE_OAUTH_REDIRECT_URI from SHOPIFY_APP_URL when it isn't set explicitly,
// so listing it as "required" here would be misleading.
console.log('\n🔎 Google Search Console (SEO tab):');
{
  const gscRequiredVars = ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'];
  const present = gscRequiredVars.filter((v) => process.env[v]);
  if (present.length === 0) {
    console.log('   deaktiviert (GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET nicht gesetzt — Search-Console-Sektion zeigt "nicht konfiguriert")');
  } else if (present.length === gscRequiredVars.length) {
    if (process.env.GOOGLE_OAUTH_REDIRECT_URI) {
      console.log(`   ✅ konfiguriert (GOOGLE_OAUTH_REDIRECT_URI explizit gesetzt: ${process.env.GOOGLE_OAUTH_REDIRECT_URI})`);
    } else if (process.env.SHOPIFY_APP_URL) {
      console.log(`   ✅ konfiguriert (GOOGLE_OAUTH_REDIRECT_URI wird aus SHOPIFY_APP_URL abgeleitet: ${process.env.SHOPIFY_APP_URL.replace(/\/$/, '')}/auth/google/callback)`);
    } else {
      warnings.push('⚠️  Google Search Console: GOOGLE_OAUTH_CLIENT_ID/SECRET gesetzt, aber weder GOOGLE_OAUTH_REDIRECT_URI noch SHOPIFY_APP_URL gesetzt — die Redirect-URI kann nicht abgeleitet werden');
    }
  } else {
    const missing = gscRequiredVars.filter((v) => !process.env[v]);
    warnings.push(`⚠️  Google Search Console teilweise konfiguriert — fehlt: ${missing.join(', ')} (GSC bleibt deaktiviert, bis beide gesetzt sind; GOOGLE_OAUTH_REDIRECT_URI ist optional und fällt sonst auf SHOPIFY_APP_URL zurück)`);
  }
}

// Print results
// ─── Managed AI (PLAN_MANAGED_AI_KEY §9.6) ───────────────────────────────────
//
// A managed mode pointing at a dead model is a 100% failure rate for paying
// customers, and it fails at the FIRST merchant call rather than at boot. So
// both credential sets are checked here: provider, model and key are a UNIT
// (the failover crosses providers, so a mismatched pair is a key sent to the
// wrong endpoint), and each provider/model pair must be one the price table
// knows — an unpriced managed model meters at a guessed ceiling.
//
// What this canNOT check is whether the model ANSWERS. That is the startup
// smoke test's job; a lookup in our own table cannot see a retired id.
const KNOWN_AI_PROVIDERS = ['huggingface', 'gemini', 'claude', 'openai', 'grok', 'deepseek'];

function checkManagedCredential(prefix, label, required) {
  const provider = process.env[`${prefix}PROVIDER`];
  const model = process.env[`${prefix}MODEL`];
  const apiKey = process.env[`${prefix}API_KEY`];
  const present = [provider, model, apiKey].filter(Boolean).length;

  if (present === 0) {
    if (required) {
      errors.push(`❌ MANAGED_AI_ENABLED is true but no ${label} credential is configured (${prefix}PROVIDER/MODEL/API_KEY)`);
    } else {
      // §3a: a missing failover does not refuse to start, but a SILENT one is
      // how an outage becomes a surprise.
      warnings.push(`⚠️  No ${label} AI credential configured — an outage of the default provider is an outage of managed AI`);
    }
    return;
  }

  if (present < 3) {
    errors.push(`❌ ${label} AI credential is incomplete — ${prefix}PROVIDER, ${prefix}MODEL and ${prefix}API_KEY must be set together`);
    return;
  }

  if (!KNOWN_AI_PROVIDERS.includes(provider)) {
    errors.push(`❌ ${prefix}PROVIDER is "${provider}" — expected one of ${KNOWN_AI_PROVIDERS.join(', ')}`);
    return;
  }

  console.log(`✅ ${label} AI: ${provider} / ${model}`);
}

if (process.env.MANAGED_AI_ENABLED === 'true') {
  checkManagedCredential('MANAGED_AI_', 'managed (default)', true);
  checkManagedCredential('MANAGED_AI_FALLBACK_', 'managed (failover)', false);

  // §7a, belt and braces: the operator key must never be served from the
  // dev/custom-app build, and the cheapest place to find that out is here.
  if (process.env.DEV_APP_CLIENT_ID &&
      process.env.SHOPIFY_API_KEY === process.env.DEV_APP_CLIENT_ID &&
      process.env.APP_ENV !== 'production') {
    errors.push('❌ MANAGED_AI_ENABLED is true in a dev/custom-app build — an operator key must never be configured there');
  }
} else if (process.env.MANAGED_AI_API_KEY) {
  // Not an error: this is exactly what the kill switch is for. But a key
  // sitting in the environment of a deployment that ignores it is worth one
  // line, because "why is managed mode off" is otherwise a hunt.
  console.log('ℹ️  A managed AI key is configured but MANAGED_AI_ENABLED is not "true" — managed mode is OFF');
}

// The six provider names compliance §B4 says must never be set. The code reads
// none of them; a set one means somebody is expecting a shared key to work.
for (const forbidden of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GROK_API_KEY', 'DEEPSEEK_API_KEY', 'HUGGINGFACE_API_KEY']) {
  if (process.env[forbidden]) {
    warnings.push(`⚠️  ${forbidden} is set. No code path reads it — merchant keys live in the database and the operator key is MANAGED_AI_API_KEY.`);
  }
}

console.log('\n' + '='.repeat(60));
if (errors.length > 0) {
  console.log('\n🚨 ERRORS FOUND:\n');
  errors.forEach(err => console.log(err));
}

if (warnings.length > 0) {
  console.log('\n⚠️  WARNINGS:\n');
  warnings.forEach(warn => console.log(warn));
}

if (errors.length === 0 && warnings.length === 0) {
  console.log('\n✅ All environment variables are valid!\n');
} else {
  console.log('\n');
}

console.log('='.repeat(60));

// Exit with error code if there are errors
if (errors.length > 0) {
  console.log('\n❌ Environment validation FAILED! Please fix the errors above.\n');
  process.exit(1);
} else if (warnings.length > 0) {
  console.log('\n⚠️  Environment validation passed with warnings. Consider fixing them.\n');
  process.exit(0);
} else {
  console.log('\n✅ Environment validation PASSED!\n');
  process.exit(0);
}
