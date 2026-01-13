#!/usr/bin/env node
/**
 * Debug Script: Check Menu Cache
 *
 * This script checks if the Menu table exists and shows cached menus.
 * Run with: node scripts/check-menu-cache.js
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔍 Checking Menu cache in database...\n');

  try {
    // Check if we can query the Menu table
    const menus = await prisma.menu.findMany({
      orderBy: { title: 'asc' }
    });

    console.log(`✅ Menu table exists!`);
    console.log(`📊 Found ${menus.length} cached menus\n`);

    if (menus.length > 0) {
      console.log('Cached menus:');
      menus.forEach((menu, index) => {
        console.log(`\n${index + 1}. ${menu.title}`);
        console.log(`   ID: ${menu.id}`);
        console.log(`   Handle: ${menu.handle}`);
        console.log(`   Shop: ${menu.shop}`);
        console.log(`   Items: ${Array.isArray(menu.items) ? menu.items.length : 0} top-level items`);
        console.log(`   Last synced: ${menu.lastSyncedAt}`);
      });
    } else {
      console.log('⚠️  No menus cached yet.');
      console.log('The first time you visit /app/menus, menus will be automatically cached.');
    }

  } catch (error) {
    if (error.code === 'P2021') {
      console.log('❌ Menu table does NOT exist in database!');
      console.log('\nThe migration has not run yet. This can happen if:');
      console.log('1. Railway deployment is still in progress');
      console.log('2. Migration failed during deployment');
      console.log('3. Pre-deploy command is not configured correctly\n');
      console.log('Check Railway build logs for migration status.');
    } else {
      console.error('❌ Error:', error.message);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main();
