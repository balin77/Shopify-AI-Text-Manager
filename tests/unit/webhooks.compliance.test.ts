/**
 * Unit Tests for app/routes/webhooks.compliance.tsx (R3)
 *
 * The compliance dispatcher must return HTTP 500 when a handler throws so
 * Shopify retries the webhook (a swallowed error + 200 would retain data
 * forever), and HTTP 200 on success. Bad HMAC (401) is handled by
 * authenticate.webhook() upstream and is out of scope here.
 *
 * ✅ shopify.server + gdpr.service mocked — no real Shopify / DB
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateWebhook,
  mockRedactShopData,
  mockRedactCustomerData,
  mockExportCustomerData,
  mockLogGDPRRequest,
} = vi.hoisted(() => ({
  mockAuthenticateWebhook: vi.fn(),
  mockRedactShopData: vi.fn(),
  mockRedactCustomerData: vi.fn(),
  mockExportCustomerData: vi.fn(),
  mockLogGDPRRequest: vi.fn(),
}));

vi.mock('~/shopify.server', () => ({
  authenticate: { webhook: mockAuthenticateWebhook },
}));

vi.mock('~/services/gdpr.service', () => ({
  redactShopData: mockRedactShopData,
  redactCustomerData: mockRedactCustomerData,
  exportCustomerData: mockExportCustomerData,
  logGDPRRequest: mockLogGDPRRequest,
}));

vi.mock('~/utils/logger.server', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { action } from '~/routes/webhooks.compliance';

const req = () => new Request('https://app.example.com/webhooks/compliance', { method: 'POST' });
const invoke = () => action({ request: req(), params: {}, context: {} } as never) as Promise<Response>;

describe('webhooks.compliance action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogGDPRRequest.mockResolvedValue(undefined);
  });

  it('returns 200 when SHOP_REDACT succeeds', async () => {
    mockAuthenticateWebhook.mockResolvedValue({
      topic: 'SHOP_REDACT',
      shop: 'shop.myshopify.com',
      payload: { shop_id: 1, shop_domain: 'shop.myshopify.com' },
    });
    mockRedactShopData.mockResolvedValue(undefined);

    const res = await invoke();

    expect(res.status).toBe(200);
    expect(mockRedactShopData).toHaveBeenCalledOnce();
  });

  it('returns 500 when SHOP_REDACT deletion fails (so Shopify retries)', async () => {
    mockAuthenticateWebhook.mockResolvedValue({
      topic: 'SHOP_REDACT',
      shop: 'shop.myshopify.com',
      payload: { shop_id: 1, shop_domain: 'shop.myshopify.com' },
    });
    mockRedactShopData.mockRejectedValue(new Error('transient DB error'));

    const res = await invoke();

    expect(res.status).toBe(500);
    // A failed audit row is written for the trail.
    expect(mockLogGDPRRequest).toHaveBeenCalledWith(
      'shop.myshopify.com',
      'shop_redact',
      undefined,
      undefined,
      undefined,
      'transient DB error',
    );
  });

  it('returns 500 when CUSTOMERS_REDACT fails', async () => {
    mockAuthenticateWebhook.mockResolvedValue({
      topic: 'CUSTOMERS_REDACT',
      shop: 'shop.myshopify.com',
      payload: { shop_domain: 'shop.myshopify.com', customer: { id: 5, email: 'a@b.c' } },
    });
    mockRedactCustomerData.mockRejectedValue(new Error('boom'));

    const res = await invoke();

    expect(res.status).toBe(500);
  });

  it('still returns 500 even if the failed-audit write also throws', async () => {
    mockAuthenticateWebhook.mockResolvedValue({
      topic: 'SHOP_REDACT',
      shop: 'shop.myshopify.com',
      payload: { shop_id: 1, shop_domain: 'shop.myshopify.com' },
    });
    mockRedactShopData.mockRejectedValue(new Error('db down'));
    mockLogGDPRRequest.mockRejectedValue(new Error('audit log also down'));

    const res = await invoke();

    expect(res.status).toBe(500);
  });

  it('returns 200 for an unhandled topic (no infinite retry)', async () => {
    mockAuthenticateWebhook.mockResolvedValue({
      topic: 'SOMETHING_ELSE',
      shop: 'shop.myshopify.com',
      payload: {},
    });

    const res = await invoke();

    expect(res.status).toBe(200);
  });
});
