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
  translatableContent: TranslatableField[];
  translations: ThemeTranslationRecord[];
}
