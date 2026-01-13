#!/bin/bash
# ============================================
# Railway Migration & Start Script
# ============================================
# This script runs database migrations and then starts the app
# Use this as your Railway Custom Start Command:
#   bash scripts/railway-migration.sh
# ============================================

set -e  # Exit on any error

echo "🚀 Starting Railway deployment..."

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
    echo "❌ ERROR: DATABASE_URL environment variable is not set!"
    exit 1
fi

echo "✅ DATABASE_URL is configured"

# Run the migration SQL file
echo "📦 Running database migration..."
if [ -f "prisma/migrations/add_entity_specific_ai_instructions.sql" ]; then
    # Use psql to run the migration
    psql "$DATABASE_URL" -f prisma/migrations/add_entity_specific_ai_instructions.sql
    echo "✅ Migration completed successfully"
else
    echo "⚠️  Migration file not found, skipping..."
fi

# Generate Prisma Client
echo "🔨 Generating Prisma Client..."
npx prisma generate

echo "✅ Prisma Client generated"

# Start the application
echo "🚀 Starting application..."
exec npm run start
