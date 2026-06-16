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

// Print results
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
