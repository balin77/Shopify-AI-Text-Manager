#!/usr/bin/env node
/**
 * Backfill Script: ThemeContent / ThemeTranslation → themeId
 *
 * Part of the Theme-Auswahl (Theme Selection) feature. The structural migration
 * (20260706130000_add_theme_id) adds a `themeId` column defaulting to "". This
 * script assigns each legacy row its real Theme-GID so the theme-scoped reads and
 * the write-path resolver address the same theme, and so the next full sync
 * upserts onto the existing rows instead of creating theme-specific duplicates.
 *
 * Strategy (see PLAN_THEME_SELECTION §3.2), pure DB — no Shopify calls needed:
 *   (a) Extract theme_id from the resourceId GID (the same rule the sync uses,
 *       app/utils/theme-id.ts) and normalise to gid://shopify/OnlineStoreTheme/<n>.
 *   (b) Fallback for rows whose GID carries no theme_id: if a shop already has
 *       EXACTLY ONE distinct real themeId (the historical single-published-theme
 *       reality), assign the remaining "" rows of that shop to it. If a shop has
 *       zero or several, leave "" — the read layer's compat-OR treats "" as
 *       "belongs to the active theme", so nothing breaks; those rows are picked
 *       up on the next full sync.
 *
 * Idempotent: only ever touches rows with themeId = "". Safe to re-run.
 *
 * Run with:  node scripts/backfill-theme-id.js
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const THEME_GID_PREFIX = 'gid://shopify/OnlineStoreTheme/';

/** Mirror of app/utils/theme-id.ts normalizeThemeGid (kept in sync manually). */
function normalizeThemeGid(raw) {
  if (!raw) return null;
  let value;
  try {
    value = decodeURIComponent(String(raw)).trim();
  } catch {
    value = String(raw).trim();
  }
  if (!value) return null;
  if (value.startsWith(THEME_GID_PREFIX)) {
    const id = value.slice(THEME_GID_PREFIX.length);
    return id ? `${THEME_GID_PREFIX}${id}` : null;
  }
  const gidMatch = value.match(/(\d+)\s*$/);
  if (value.startsWith('gid://') && gidMatch) {
    return `${THEME_GID_PREFIX}${gidMatch[1]}`;
  }
  if (/^\d+$/.test(value)) {
    return `${THEME_GID_PREFIX}${value}`;
  }
  return null;
}

function extractThemeIdFromResourceId(resourceId) {
  if (!resourceId) return null;
  const match = String(resourceId).match(/[?&]theme_id=([^&]+)/);
  if (!match) return null;
  return normalizeThemeGid(match[1]);
}

/**
 * Step (a): extract & assign theme_id from resourceId for one model.
 * Returns the number of rows updated.
 */
async function backfillFromResourceId(model, label) {
  const rows = await model.findMany({
    where: { themeId: '' },
    select: { id: true, resourceId: true },
  });
  let updated = 0;
  for (const row of rows) {
    const themeId = extractThemeIdFromResourceId(row.resourceId);
    if (themeId) {
      await model.update({ where: { id: row.id }, data: { themeId } });
      updated++;
    }
  }
  console.log(`  [${label}] step (a) extracted theme_id for ${updated}/${rows.length} legacy rows`);
  return updated;
}

/**
 * Step (b): per-shop single-theme fallback for the remaining "" rows.
 * Returns the number of rows updated.
 */
async function backfillSingleThemeFallback(model, label) {
  const shops = await model.findMany({
    where: { themeId: '' },
    select: { shop: true },
    distinct: ['shop'],
  });
  let updated = 0;
  for (const { shop } of shops) {
    const distinctThemes = await model.findMany({
      where: { shop, themeId: { not: '' } },
      select: { themeId: true },
      distinct: ['themeId'],
    });
    if (distinctThemes.length === 1) {
      const themeId = distinctThemes[0].themeId;
      const res = await model.updateMany({
        where: { shop, themeId: '' },
        data: { themeId },
      });
      updated += res.count;
      console.log(`  [${label}] step (b) shop ${shop}: assigned ${res.count} rows → ${themeId}`);
    } else {
      console.log(
        `  [${label}] step (b) shop ${shop}: ${distinctThemes.length} distinct themes → left "" (compat-OR)`,
      );
    }
  }
  return updated;
}

async function main() {
  console.log('🎨 Backfilling themeId on ThemeContent / ThemeTranslation…\n');

  console.log('ThemeContent:');
  await backfillFromResourceId(prisma.themeContent, 'ThemeContent');
  await backfillSingleThemeFallback(prisma.themeContent, 'ThemeContent');

  console.log('\nThemeTranslation:');
  await backfillFromResourceId(prisma.themeTranslation, 'ThemeTranslation');
  await backfillSingleThemeFallback(prisma.themeTranslation, 'ThemeTranslation');

  const remainingContent = await prisma.themeContent.count({ where: { themeId: '' } });
  const remainingTrans = await prisma.themeTranslation.count({ where: { themeId: '' } });
  console.log(
    `\n✅ Done. Remaining "" rows (handled by compat-OR / next sync): ` +
      `ThemeContent=${remainingContent}, ThemeTranslation=${remainingTrans}`,
  );
}

main()
  .catch((err) => {
    console.error('❌ Backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
