import '@testing-library/jest-dom';

// Mock environment variables for tests
process.env.NODE_ENV = 'test';
// Valid 32-byte hex key (64 hex characters)
process.env.ENCRYPTION_KEY = '988568df2b8ae4861f66586e234cb1ba58560d67e1842fa5040da8f98a3e5162';
process.env.SHOPIFY_API_KEY = 'test-api-key';
process.env.SHOPIFY_API_SECRET = 'test-api-secret';

console.log('✅ Test setup loaded');
