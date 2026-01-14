/**
 * Test Script for HMAC Webhook Verification
 *
 * Tests the GDPR webhook endpoints with valid and invalid HMAC signatures.
 *
 * Usage:
 *   node scripts/test-webhook-hmac.js
 *
 * Environment Variables:
 *   SHOPIFY_API_SECRET - Your Shopify API secret (required)
 *   TEST_WEBHOOK_URL - Base URL for webhooks (default: http://localhost:3000)
 */

const crypto = require('crypto');

// Configuration
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const BASE_URL = process.env.TEST_WEBHOOK_URL || 'http://localhost:3000';

// GDPR Endpoints to test
const ENDPOINTS = [
  {
    path: '/webhooks/gdpr/customers/data_request',
    name: 'customers/data_request',
    payload: {
      shop_id: 12345,
      shop_domain: 'test-shop.myshopify.com',
      orders_requested: [],
      customer: {
        id: 67890,
        email: 'customer@example.com',
        phone: '+1234567890',
      },
    },
  },
  {
    path: '/webhooks/gdpr/customers/redact',
    name: 'customers/redact',
    payload: {
      shop_id: 12345,
      shop_domain: 'test-shop.myshopify.com',
      customer: {
        id: 67890,
        email: 'customer@example.com',
        phone: '+1234567890',
      },
      orders_to_redact: [],
    },
  },
  {
    path: '/webhooks/gdpr/shop/redact',
    name: 'shop/redact',
    payload: {
      shop_id: 12345,
      shop_domain: 'test-shop.myshopify.com',
    },
  },
];

/**
 * Generate HMAC-SHA256 signature for a payload
 */
function generateHmac(payload, secret) {
  const payloadString = JSON.stringify(payload);
  return crypto
    .createHmac('sha256', secret)
    .update(payloadString, 'utf8')
    .digest('base64');
}

/**
 * Send test webhook request
 */
async function sendWebhook(endpoint, payload, hmac, isValidTest = true) {
  const url = `${BASE_URL}${endpoint.path}`;
  const payloadString = JSON.stringify(payload);

  console.log(`\n${'='.repeat(80)}`);
  console.log(`Testing: ${endpoint.name}`);
  console.log(`URL: ${url}`);
  console.log(`Test Type: ${isValidTest ? 'Valid HMAC ✅' : 'Invalid HMAC ❌'}`);
  console.log(`${'='.repeat(80)}`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Hmac-Sha256': hmac,
        'X-Shopify-Shop-Domain': payload.shop_domain,
        'X-Shopify-Topic': endpoint.name,
        'X-Shopify-Webhook-Id': `test-${Date.now()}`,
      },
      body: payloadString,
    });

    const status = response.status;
    const responseData = await response.json().catch(() => ({}));

    console.log(`\nResponse Status: ${status}`);
    console.log('Response Body:', JSON.stringify(responseData, null, 2));

    // Verify expected behavior
    if (isValidTest && status === 200) {
      console.log('✅ PASS: Valid HMAC accepted');
      return true;
    } else if (!isValidTest && status === 401) {
      console.log('✅ PASS: Invalid HMAC rejected');
      return true;
    } else {
      console.log(`❌ FAIL: Unexpected status ${status}`);
      return false;
    }
  } catch (error) {
    console.error('❌ ERROR:', error.message);
    return false;
  }
}

/**
 * Run all tests
 */
async function runTests() {
  console.log('\n🧪 HMAC Webhook Verification Test Suite\n');

  if (!SHOPIFY_API_SECRET) {
    console.error('❌ ERROR: SHOPIFY_API_SECRET environment variable not set');
    console.error('Please set it before running tests:');
    console.error('  export SHOPIFY_API_SECRET=your_secret_here');
    process.exit(1);
  }

  console.log(`Using Base URL: ${BASE_URL}`);
  console.log(`Testing ${ENDPOINTS.length} endpoints with valid and invalid HMAC...`);

  const results = {
    passed: 0,
    failed: 0,
  };

  // Test each endpoint with valid and invalid HMAC
  for (const endpoint of ENDPOINTS) {
    // Test 1: Valid HMAC
    const validHmac = generateHmac(endpoint.payload, SHOPIFY_API_SECRET);
    const validResult = await sendWebhook(endpoint, endpoint.payload, validHmac, true);
    if (validResult) results.passed++;
    else results.failed++;

    // Wait a bit between requests
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Test 2: Invalid HMAC
    const invalidHmac = 'invalid_signature_' + Date.now();
    const invalidResult = await sendWebhook(endpoint, endpoint.payload, invalidHmac, false);
    if (invalidResult) results.passed++;
    else results.failed++;

    // Wait a bit between requests
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Print summary
  console.log(`\n${'='.repeat(80)}`);
  console.log('Test Summary');
  console.log(`${'='.repeat(80)}`);
  console.log(`Total Tests: ${results.passed + results.failed}`);
  console.log(`✅ Passed: ${results.passed}`);
  console.log(`❌ Failed: ${results.failed}`);
  console.log(`${'='.repeat(80)}\n`);

  // Exit with appropriate code
  process.exit(results.failed > 0 ? 1 : 0);
}

// Handle node fetch for older Node versions
if (typeof fetch === 'undefined') {
  console.log('⚠️  fetch not available globally, attempting to import node-fetch...');
  import('node-fetch').then((nodeFetch) => {
    global.fetch = nodeFetch.default;
    runTests();
  }).catch(() => {
    console.error('❌ ERROR: fetch not available. Please use Node.js 18+ or install node-fetch');
    process.exit(1);
  });
} else {
  runTests();
}
