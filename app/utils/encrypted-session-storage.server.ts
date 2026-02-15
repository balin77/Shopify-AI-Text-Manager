/**
 * Encrypted Session Storage Wrapper
 *
 * Wraps PrismaSessionStorage to encrypt/decrypt OAuth tokens (accessToken, refreshToken)
 * at rest. The Shopify SDK's PrismaSessionStorage writes tokens in plaintext to the
 * Session table; this wrapper intercepts storeSession and loadSession to apply
 * AES-256-GCM encryption via the existing encryption utilities.
 *
 * All other SessionStorage methods delegate directly to the inner PrismaSessionStorage.
 */

import { Session } from "@shopify/shopify-api";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import { encryptToken, decryptToken } from "./encryption.server";
import { logger } from "./logger.server";

export class EncryptedPrismaSessionStorage implements SessionStorage {
  constructor(private readonly inner: PrismaSessionStorage<any>) {}

  /**
   * Encrypt tokens before persisting the session.
   */
  async storeSession(session: Session): Promise<boolean> {
    // Clone the session so we don't mutate the in-memory original
    const clone = new Session(session.toObject());

    if (clone.accessToken) {
      const encrypted = encryptToken(clone.accessToken);
      if (!encrypted) {
        throw new Error("[EncryptedSessionStorage] Failed to encrypt accessToken: encryptToken returned null");
      }
      clone.accessToken = encrypted;
    }

    if (clone.refreshToken) {
      const encrypted = encryptToken(clone.refreshToken);
      if (!encrypted) {
        throw new Error("[EncryptedSessionStorage] Failed to encrypt refreshToken: encryptToken returned null");
      }
      clone.refreshToken = encrypted;
    }

    return this.inner.storeSession(clone);
  }

  /**
   * Decrypt tokens after loading the session.
   */
  async loadSession(id: string): Promise<Session | undefined> {
    const session = await this.inner.loadSession(id);
    if (!session) return undefined;

    if (session.accessToken) {
      try {
        session.accessToken = decryptToken(session.accessToken) ?? session.accessToken;
      } catch (error) {
        logger.error(
          "[EncryptedSessionStorage] Failed to decrypt accessToken, returning as-is:",
          error instanceof Error ? error.message : "Unknown error",
        );
      }
    }

    if (session.refreshToken) {
      try {
        session.refreshToken = decryptToken(session.refreshToken) ?? session.refreshToken;
      } catch (error) {
        logger.error(
          "[EncryptedSessionStorage] Failed to decrypt refreshToken, returning as-is:",
          error instanceof Error ? error.message : "Unknown error",
        );
      }
    }

    return session;
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.inner.deleteSession(id);
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    return this.inner.deleteSessions(ids);
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const sessions = await this.inner.findSessionsByShop(shop);

    for (const session of sessions) {
      if (session.accessToken) {
        try {
          session.accessToken = decryptToken(session.accessToken) ?? session.accessToken;
        } catch (error) {
          logger.error(
            "[EncryptedSessionStorage] Failed to decrypt accessToken in findSessionsByShop:",
            error instanceof Error ? error.message : "Unknown error",
          );
        }
      }

      if (session.refreshToken) {
        try {
          session.refreshToken = decryptToken(session.refreshToken) ?? session.refreshToken;
        } catch (error) {
          logger.error(
            "[EncryptedSessionStorage] Failed to decrypt refreshToken in findSessionsByShop:",
            error instanceof Error ? error.message : "Unknown error",
          );
        }
      }
    }

    return sessions;
  }
}
