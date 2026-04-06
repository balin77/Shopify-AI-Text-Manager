/**
 * Unit Tests for gdpr.service.ts – logGDPRRequest
 *
 * ✅ No real database needed (db is mocked)
 * ✅ No real Shopify needed
 * ✅ Fast (<50ms per test)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logGDPRRequest } from '~/services/gdpr.service';

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockGdprAuditLogCreate } = vi.hoisted(() => ({
  mockGdprAuditLogCreate: vi.fn().mockResolvedValue({ id: 'audit-1' }),
}));

vi.mock('~/db.server', () => ({
  db: {
    gdprAuditLog: {
      create: mockGdprAuditLogCreate,
    },
    session: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('~/utils/logger.server', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('~/utils/encryption.server', () => ({
  decryptPII: vi.fn((v: string | null) => v),
}));

// ── Tests ────────────────────────────────────────────────────────────────────

describe('logGDPRRequest()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should persist a data_request to the database', async () => {
    await logGDPRRequest(
      'test-shop.myshopify.com',
      'data_request',
      12345,
      'user@example.com'
    );

    expect(mockGdprAuditLogCreate).toHaveBeenCalledOnce();

    const { data } = mockGdprAuditLogCreate.mock.calls[0][0];
    expect(data.shop).toBe('test-shop.myshopify.com');
    expect(data.requestType).toBe('data_request');
    expect(data.customerEmail).toBe('user@example.com');
    expect(data.status).toBe('completed');
    expect(data.error).toBeNull();
    expect(data.completedAt).toBeInstanceOf(Date);
  });

  it('should set status to "failed" when an error string is provided', async () => {
    await logGDPRRequest(
      'test-shop.myshopify.com',
      'customer_redact',
      99,
      'other@example.com',
      undefined,
      'Something went wrong'
    );

    const { data } = mockGdprAuditLogCreate.mock.calls[0][0];
    expect(data.status).toBe('failed');
    expect(data.error).toBe('Something went wrong');
  });

  it('should convert customerId to BigInt', async () => {
    await logGDPRRequest(
      'shop.myshopify.com',
      'shop_redact',
      9007199254740993 // larger than Number.MAX_SAFE_INTEGER
    );

    const { data } = mockGdprAuditLogCreate.mock.calls[0][0];
    expect(typeof data.customerId).toBe('bigint');
    expect(data.customerId).toBe(BigInt(9007199254740993));
  });

  it('should store null for customerId when not provided', async () => {
    await logGDPRRequest('shop.myshopify.com', 'shop_redact');

    const { data } = mockGdprAuditLogCreate.mock.calls[0][0];
    expect(data.customerId).toBeNull();
    expect(data.customerEmail).toBeNull();
  });

  it('should truncate dataExported to 500 characters', async () => {
    const longObject = { key: 'x'.repeat(1000) };

    await logGDPRRequest(
      'shop.myshopify.com',
      'data_request',
      1,
      undefined,
      longObject
    );

    const { data } = mockGdprAuditLogCreate.mock.calls[0][0];
    expect(data.dataExported).not.toBeNull();
    expect((data.dataExported as string).length).toBeLessThanOrEqual(500);
  });

  it('should store null for dataExported when not provided', async () => {
    await logGDPRRequest('shop.myshopify.com', 'shop_redact');

    const { data } = mockGdprAuditLogCreate.mock.calls[0][0];
    expect(data.dataExported).toBeNull();
  });

  it('should propagate db errors to the caller', async () => {
    mockGdprAuditLogCreate.mockRejectedValueOnce(new Error('DB connection lost'));

    await expect(
      logGDPRRequest('shop.myshopify.com', 'customer_redact')
    ).rejects.toThrow('DB connection lost');
  });
});
