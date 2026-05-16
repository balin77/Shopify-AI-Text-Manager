/**
 * Encrypted Session Storage Wrapper
 *
 * Wraps PrismaSessionStorage to encrypt/decrypt OAuth tokens (accessToken,
 * refreshToken) and online-session PII (firstName, lastName, email) at rest.
 * The Shopify SDK's PrismaSessionStorage writes these in plaintext to the
 * Session table; this wrapper intercepts storeSession/loadSession/
 * findSessionsByShop to apply AES-256-GCM encryption via the existing
 * encryption utilities.
 *
 * PII lives at `session.onlineAccessInfo.associated_user.{first_name,
 * last_name,email}` (online sessions only — offline sessions have no
 * onlineAccessInfo). PrismaSessionStorage maps that nested struct to/from the
 * Session table's firstName/lastName/email columns.
 *
 * Idempotency / migration: encryptPII is only applied to values that are not
 * already encrypted (isEncrypted guard), and decryptPII passes plaintext
 * through unchanged. This makes the wrapper safe against the pre-backfill
 * plaintext rows handled by scripts/migrate-encrypt-session-pii.ts.
 *
 * PII decryption failures only log + keep the raw value — unlike accessToken,
 * they must NOT force re-auth (a name/email we can't decrypt is not a reason
 * to throw the user out of an otherwise valid session).
 *
 * All other SessionStorage methods delegate directly to the inner PrismaSessionStorage.
 */

import { Session } from "@shopify/shopify-api";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import { encryptToken, decryptToken, encryptPII, decryptPII, isEncrypted } from "./encryption.server";
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

    // Encrypt online-session PII before persisting. Session.toObject() copies
    // onlineAccessInfo BY REFERENCE, so the clone shares associated_user with
    // the in-memory original — we must deep-copy it before mutating, otherwise
    // the caller's live session would end up holding ciphertext.
    const sourceUser = clone.onlineAccessInfo?.associated_user;
    if (sourceUser) {
      const user = { ...sourceUser };
      clone.onlineAccessInfo = { ...clone.onlineAccessInfo!, associated_user: user };

      // isEncrypted guard keeps this idempotent: re-storing a session whose PII
      // is already encrypted (not freshly decrypted via loadSession) won't
      // double-encrypt it.
      if (user.first_name && !isEncrypted(user.first_name)) {
        user.first_name = encryptPII(user.first_name) ?? user.first_name;
      }
      if (user.last_name && !isEncrypted(user.last_name)) {
        user.last_name = encryptPII(user.last_name) ?? user.last_name;
      }
      if (user.email && !isEncrypted(user.email)) {
        user.email = encryptPII(user.email) ?? user.email;
      }
    }

    const result = await this.inner.storeSession(clone);
    logger.info(`[EncryptedSessionStorage] storeSession('${session.id}'): stored=${result}, scope=${session.scope || "none"}`);
    return result;
  }

  /**
   * Decrypt tokens after loading the session.
   */
  async loadSession(id: string): Promise<Session | undefined> {
    const session = await this.inner.loadSession(id);
    if (!session) {
      logger.info(`[EncryptedSessionStorage] loadSession('${id}'): NOT FOUND in DB`);
      return undefined;
    }

    logger.info(`[EncryptedSessionStorage] loadSession('${id}'): found, hasToken=${!!session.accessToken}, scope=${session.scope || "none"}`);

    if (session.accessToken) {
      try {
        session.accessToken = decryptToken(session.accessToken) ?? session.accessToken;
        logger.info(`[EncryptedSessionStorage] loadSession('${id}'): decryption OK`);
      } catch (error) {
        logger.error(
          "[EncryptedSessionStorage] Failed to decrypt accessToken — treating session as missing to force re-auth:",
          error instanceof Error ? error.message : "Unknown error",
        );
        // Return undefined so the SDK redirects to OAuth instead of sending the
        // raw encrypted string as a Bearer token (which would produce a Shopify 401).
        return undefined;
      }
    }

    if (session.refreshToken) {
      try {
        session.refreshToken = decryptToken(session.refreshToken) ?? session.refreshToken;
      } catch (error) {
        logger.error(
          "[EncryptedSessionStorage] Failed to decrypt refreshToken, clearing it:",
          error instanceof Error ? error.message : "Unknown error",
        );
        session.refreshToken = undefined;
      }
    }

    this.decryptSessionPII(session);

    return session;
  }

  /**
   * Decrypt online-session PII (firstName, lastName, email) in place.
   *
   * The session is freshly constructed by PrismaSessionStorage.rowToSession,
   * so its onlineAccessInfo is not shared with anything — in-place mutation is
   * safe here (unlike storeSession). Decryption failures are logged and the
   * raw value is kept; PII we cannot decrypt must NOT invalidate the session.
   */
  private decryptSessionPII(session: Session): void {
    const user = session.onlineAccessInfo?.associated_user;
    if (!user) {
      return;
    }

    user.first_name = this.decryptPiiField(user.first_name, "firstName", session.id);
    user.last_name = this.decryptPiiField(user.last_name, "lastName", session.id);
    user.email = this.decryptPiiField(user.email, "email", session.id);
  }

  private decryptPiiField<T extends string | undefined>(value: T, field: string, id: string): T {
    if (!value) {
      return value;
    }
    try {
      // decryptPII is idempotent: plaintext (pre-backfill rows) passes through
      // unchanged, only ciphertext is decrypted.
      return (decryptPII(value) ?? value) as T;
    } catch (error) {
      logger.error(
        `[EncryptedSessionStorage] Failed to decrypt PII '${field}' for session '${id}' — keeping raw value:`,
        error instanceof Error ? error.message : "Unknown error",
      );
      return value;
    }
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

      this.decryptSessionPII(session);
    }

    return sessions;
  }
}
