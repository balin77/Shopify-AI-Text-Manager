/**
 * Shared types for the ThemeContent-backed content rubrics (Templates / System /
 * Online-Store-Extras / Selling-Plans). Lives in a plain types module so both
 * the server loader/action factories and the client page component can import
 * them without crossing the .server / client boundary.
 */

import type { TranslatableField } from "~/actions/templates/shared";

/** A cached theme translation record (one key/value for one locale). */
export interface ThemeTranslationRecord {
  key: string;
  value: string;
  locale?: string;
}

/** A theme navigation item returned by the domain loader (one per group). */
export interface ThemeNavItem {
  id: string;
  title: string;
  groupName: string;
  icon: string;
  groupId: string;
  role: string;
  contentCount: number;
  /**
   * Shopify resource type of the group (e.g. SELLING_PLAN_GROUP, SELLING_PLAN).
   * Drives the item-list type filter when a domain holds more than one type.
   */
  type?: string;
  /** Human label for `type` (e.g. "Abo-Gruppe"), shown as the icon's tooltip. */
  iconTooltip?: string;
  translatableContent: TranslatableField[];
  translations: ThemeTranslationRecord[];
  /**
   * App-Embed group (ONLINE_STORE_THEME_APP_EMBED) — its translatable content is
   * mostly technical (CSS selectors / config); the editor shows a warning that
   * translating it may break the embed.
   */
  embedTechnical?: boolean;
  /**
   * True for an email-notification template that has no AI short title yet.
   * The System page uses this to lazily trigger the title-backfill task.
   */
  aiTitlePending?: boolean;
}
