/**
 * Unit Tests for EncryptedPrismaSessionStorage
 *
 * Verifies that online-session PII (firstName/lastName/email) is encrypted
 * before it reaches the inner PrismaSessionStorage and decrypted again on the
 * read paths, while:
 *  - plaintext legacy rows (pre-backfill) survive without crashing,
 *  - the in-memory original session is never mutated by storeSession,
 *  - offline sessions (no onlineAccessInfo) are left untouched.
 *
 * encryption.server runs for real here (genuine AES-256-GCM roundtrip via the
 * ENCRYPTION_KEY set in tests/setup.ts); only the logger is mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Session } from '@shopify/shopify-api';
import type { PrismaSessionStorage } from '@shopify/shopify-app-session-storage-prisma';
import { EncryptedPrismaSessionStorage } from '~/utils/encrypted-session-storage.server';
import { encryptPII, isEncrypted } from '~/utils/encryption.server';

vi.mock('~/utils/logger.server', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

/**
 * Minimal fake inner storage: it keeps the last stored Session as-is. Because
 * PrismaSessionStorage maps onlineAccessInfo.associated_user <-> DB columns
 * 1:1, inspecting the stored Session's associated_user is equivalent to
 * inspecting the persisted firstName/lastName/email columns.
 */
function makeFakeInner() {
  const store = new Map<string, Session>();
  const inner = {
    storeSession: vi.fn(async (s: Session) => {
      store.set(s.id, s);
      return true;
    }),
    loadSession: vi.fn(async (id: string) => store.get(id)),
    findSessionsByShop: vi.fn(async (shop: string) =>
      [...store.values()].filter((s) => s.shop === shop),
    ),
  };
  return { inner, store };
}

function onlineSession(overrides?: { firstName?: string; lastName?: string; email?: string }) {
  return new Session({
    id: 'online_test-shop.myshopify.com_42',
    shop: 'test-shop.myshopify.com',
    state: 'state',
    isOnline: true,
    accessToken: 'access-token-abc',
    onlineAccessInfo: {
      expires_in: 3600,
      associated_user_scope: 'read_products',
      associated_user: {
        id: 42,
        first_name: overrides?.firstName ?? 'John',
        last_name: overrides?.lastName ?? 'Doe',
        email: overrides?.email ?? 'john@example.com',
        email_verified: true,
        account_owner: true,
        locale: 'en',
        collaborator: false,
      },
    },
  } as any);
}

describe('EncryptedPrismaSessionStorage – PII', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY =
      '988568df2b8ae4861f66586e234cb1ba58560d67e1842fa5040da8f98a3e5162';
  });

  it('encrypts firstName/lastName/email before persisting', async () => {
    const { inner, store } = makeFakeInner();
    const storage = new EncryptedPrismaSessionStorage(
      inner as unknown as PrismaSessionStorage<any>,
    );
    const session = onlineSession();

    await storage.storeSession(session);

    const stored = store.get(session.id)!;
    const user = stored.onlineAccessInfo!.associated_user;
    expect(isEncrypted(user.first_name)).toBe(true);
    expect(isEncrypted(user.last_name)).toBe(true);
    expect(isEncrypted(user.email)).toBe(true);
    expect(user.first_name).not.toBe('John');
  });

  it('does not mutate the in-memory original session on store', async () => {
    const { inner } = makeFakeInner();
    const storage = new EncryptedPrismaSessionStorage(
      inner as unknown as PrismaSessionStorage<any>,
    );
    const session = onlineSession();

    await storage.storeSession(session);

    expect(session.onlineAccessInfo!.associated_user.first_name).toBe('John');
    expect(session.onlineAccessInfo!.associated_user.email).toBe('john@example.com');
  });

  it('roundtrips PII through storeSession -> loadSession', async () => {
    const { inner } = makeFakeInner();
    const storage = new EncryptedPrismaSessionStorage(
      inner as unknown as PrismaSessionStorage<any>,
    );
    const session = onlineSession();

    await storage.storeSession(session);
    const loaded = await storage.loadSession(session.id);

    const user = loaded!.onlineAccessInfo!.associated_user;
    expect(user.first_name).toBe('John');
    expect(user.last_name).toBe('Doe');
    expect(user.email).toBe('john@example.com');
  });

  it('roundtrips PII through findSessionsByShop', async () => {
    const { inner } = makeFakeInner();
    const storage = new EncryptedPrismaSessionStorage(
      inner as unknown as PrismaSessionStorage<any>,
    );
    const session = onlineSession();

    await storage.storeSession(session);
    const found = await storage.findSessionsByShop('test-shop.myshopify.com');

    const user = found[0].onlineAccessInfo!.associated_user;
    expect(user.first_name).toBe('John');
    expect(user.email).toBe('john@example.com');
  });

  it('reads legacy plaintext PII rows without crashing', async () => {
    const { inner, store } = makeFakeInner();
    const storage = new EncryptedPrismaSessionStorage(
      inner as unknown as PrismaSessionStorage<any>,
    );
    // Simulate a pre-backfill row that was persisted in plaintext.
    const legacy = onlineSession({ firstName: 'Jane', lastName: 'Plain', email: 'jane@plain.test' });
    store.set(legacy.id, legacy);

    const loaded = await storage.loadSession(legacy.id);

    const user = loaded!.onlineAccessInfo!.associated_user;
    expect(user.first_name).toBe('Jane');
    expect(user.last_name).toBe('Plain');
    expect(user.email).toBe('jane@plain.test');
  });

  it('is idempotent: does not double-encrypt already-encrypted PII on re-store', async () => {
    const { inner, store } = makeFakeInner();
    const storage = new EncryptedPrismaSessionStorage(
      inner as unknown as PrismaSessionStorage<any>,
    );
    const preEncrypted = onlineSession({
      firstName: encryptPII('John')!,
      lastName: encryptPII('Doe')!,
      email: encryptPII('john@example.com')!,
    });

    await storage.storeSession(preEncrypted);
    const loaded = await storage.loadSession(preEncrypted.id);

    // One decrypt layer -> original plaintext (would be ciphertext if double-encrypted).
    const user = loaded!.onlineAccessInfo!.associated_user;
    expect(user.first_name).toBe('John');
    expect(user.email).toBe('john@example.com');
  });

  it('leaves offline sessions (no onlineAccessInfo) untouched', async () => {
    const { inner, store } = makeFakeInner();
    const storage = new EncryptedPrismaSessionStorage(
      inner as unknown as PrismaSessionStorage<any>,
    );
    const offline = new Session({
      id: 'offline_test-shop.myshopify.com',
      shop: 'test-shop.myshopify.com',
      state: 'state',
      isOnline: false,
      accessToken: 'offline-access-token',
    } as any);

    await storage.storeSession(offline);
    const stored = store.get(offline.id)!;
    expect(stored.onlineAccessInfo).toBeUndefined();

    const loaded = await storage.loadSession(offline.id);
    expect(loaded!.onlineAccessInfo).toBeUndefined();
  });
});
