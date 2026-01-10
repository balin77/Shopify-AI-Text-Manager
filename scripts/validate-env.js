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
  const scopes = process.env.SHOPIFY_SCOPES.split(',');
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
