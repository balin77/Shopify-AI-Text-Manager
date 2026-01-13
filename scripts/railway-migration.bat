@echo off
REM ============================================
REM Railway Migration & Start Script (Windows)
REM ============================================
REM This script runs database migrations and then starts the app
REM ============================================

echo Starting Railway deployment...

REM Check if DATABASE_URL is set
if "%DATABASE_URL%"=="" (
    echo ERROR: DATABASE_URL environment variable is not set!
    exit /b 1
)

echo DATABASE_URL is configured

REM Run the migration SQL file
echo Running database migration...
if exist "prisma\migrations\add_entity_specific_ai_instructions.sql" (
    psql "%DATABASE_URL%" -f prisma\migrations\add_entity_specific_ai_instructions.sql
    echo Migration completed successfully
) else (
    echo Migration file not found, skipping...
)

REM Generate Prisma Client
echo Generating Prisma Client...
call npx prisma generate

echo Prisma Client generated

REM Start the application
echo Starting application...
call npm run start
