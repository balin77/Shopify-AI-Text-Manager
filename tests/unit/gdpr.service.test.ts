/**
 * Unit Tests for gdpr.service.ts – logGDPRRequest
 *
 * ✅ No real database needed (db is mocked)
 * ✅ No real Shopify needed
 * ✅ Fast (<50ms per test)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logGDPRRequest, redactShopData } from '~/services/gdpr.service';

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockGdprAuditLogCreate, mockTransaction } = vi.hoisted(() => ({
  mockGdprAuditLogCreate: vi.fn().mockResolvedValue({ id: 'audit-1' }),
  mockTransaction: vi.fn(),
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
    $transaction: mockTransaction,
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

// ── redactShopData() ─────────────────────────────────────────────────────────

interface DeleteCall {
  model: string;
  where: Record<string, unknown> | undefined;
}

/**
 * Builds a fake Prisma `tx` whose every `<model>.deleteMany` is a spy that
 * records the model name and the `where` clause it was called with.
 */
function makeTxRecorder() {
  const calls: DeleteCall[] = [];
  const cache: Record<string, { deleteMany: ReturnType<typeof vi.fn> }> = {};
  const tx = new Proxy(
    {},
    {
      get(_t, prop: string | symbol) {
        if (typeof prop !== 'string') return undefined;
        if (!cache[prop]) {
          cache[prop] = {
            deleteMany: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
              calls.push({ model: prop, where: args?.where });
              return { count: 0 };
            }),
          };
        }
        return cache[prop];
      },
    }
  );
  return { tx, calls };
}

const SHOP_A = 'shop-a.myshopify.com';
const SHOP_B = 'shop-b.myshopify.com';

describe('redactShopData()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('R1 regression: scopes EVERY deleteMany to the requested shop only', async () => {
    const { tx, calls } = makeTxRecorder();
    mockTransaction.mockImplementation(async (cb: (t: unknown) => Promise<void>) => cb(tx));

    await redactShopData({ shop_id: 1, shop_domain: SHOP_A });

    expect(calls.length).toBeGreaterThan(0);

    for (const call of calls) {
      // Each delete must carry an explicit shop scope (`shop` or `shopId`)
      // matching the requested domain — never an unscoped/startsWith filter
      // that would reach across tenants (the original ContentTranslation bug).
      const scope = call.where?.shop ?? call.where?.shopId;
      expect(
        scope,
        `${call.model}.deleteMany was not scoped to a shop domain: ${JSON.stringify(call.where)}`
      ).toBe(SHOP_A);
      // Defense-in-depth: no `startsWith`/`contains` style cross-tenant filter.
      expect(JSON.stringify(call.where ?? {})).not.toContain('startsWith');
    }
  });

  it('R1 regression: redacting shop A issues no delete that could touch shop B', async () => {
    const { tx, calls } = makeTxRecorder();
    mockTransaction.mockImplementation(async (cb: (t: unknown) => Promise<void>) => cb(tx));

    await redactShopData({ shop_id: 1, shop_domain: SHOP_A });

    const touchesShopB = calls.some((c) => {
      const scope = c.where?.shop ?? c.where?.shopId;
      return scope === SHOP_B || scope === undefined;
    });
    expect(touchesShopB).toBe(false);
  });

  it('purges every shop-scoped table (schema-coverage guard)', async () => {
    const { tx, calls } = makeTxRecorder();
    mockTransaction.mockImplementation(async (cb: (t: unknown) => Promise<void>) => cb(tx));

    await redactShopData({ shop_id: 1, shop_domain: SHOP_A });

    // Prisma delegate name = model name with first character lower-cased
    // (e.g. AISettings -> aISettings).
    const delegate = (model: string) => model.charAt(0).toLowerCase() + model.slice(1);
    const deletedDelegates = new Set(calls.map((c) => c.model));

    // Parse schema.prisma for every model carrying a `shop`/`shopId` field.
    const schemaPath = join(process.cwd(), 'prisma', 'schema.prisma');
    const schema = readFileSync(schemaPath, 'utf8');
    const modelRegex = /model\s+(\w+)\s*\{([^}]*)\}/g;
    const shopScopedModels: string[] = [];
    for (let m = modelRegex.exec(schema); m; m = modelRegex.exec(schema)) {
      const [, name, body] = m;
      if (/^\s*(shop|shopId)\s+\w/m.test(body)) shopScopedModels.push(name);
    }

    // Tables NOT expected to be explicitly deleted in redactShopData:
    //  - cascade children of Product (onDelete: Cascade)
    //  - GdprAuditLog (deliberately retained, 3-year GDPR retention)
    // If you add a new shop-scoped model, either delete it in redactShopData
    // or justify its place in this allowlist.
    const ALLOWLIST = new Set<string>([
      'ProductImage',
      'ProductImageAltTranslation',
      'ProductOption',
      'ProductMetafield',
      'ProductVariant',
      'GdprAuditLog',
    ]);

    const sanity = ['Session', 'Product', 'ContentTranslation', 'ImageManagerSettings'];
    expect(sanity.every((s) => shopScopedModels.includes(s))).toBe(true);

    const missing = shopScopedModels
      .filter((name) => !ALLOWLIST.has(name))
      .filter((name) => !deletedDelegates.has(delegate(name)));

    expect(
      missing,
      `Shop-scoped model(s) not purged by redactShopData (add a deleteMany or ` +
        `extend the allowlist with justification): ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('does NOT delete the deliberately retained GdprAuditLog', async () => {
    const { tx, calls } = makeTxRecorder();
    mockTransaction.mockImplementation(async (cb: (t: unknown) => Promise<void>) => cb(tx));

    await redactShopData({ shop_id: 1, shop_domain: SHOP_A });

    expect(calls.some((c) => c.model === 'gdprAuditLog')).toBe(false);
  });
});
