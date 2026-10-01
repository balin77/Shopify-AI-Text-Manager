# ── Stage 1: Build ────────────────────────────────────────────────
FROM node:22-alpine AS builder

RUN apk add --no-cache openssl libc6-compat

WORKDIR /app

# Copy package files and prisma schema
COPY package.json package-lock.json ./
COPY prisma ./prisma/

# Install ALL dependencies (including dev) for the build
RUN npm ci --legacy-peer-deps --ignore-scripts

# Generate Prisma Client
RUN npx prisma generate

# Install Alpine-specific rollup binary. Pinned to the exact rollup version
# from package-lock.json (rollup 4.60.1) so this --no-save install can't pull
# an arbitrary newer build — removes version drift and supply-chain surface.
RUN npm install --no-save @rollup/rollup-linux-x64-musl@4.60.1

# Copy source code and build
COPY . .
RUN npm run build

# ── Stage 2: Production ──────────────────────────────────────────
FROM node:22-alpine

# postgresql-client supplies pg_dump/pg_restore/psql for the "Db Backup" cron
# service (scripts/db-backup.mjs). All Railway services here build from this
# one Dockerfile (see RAILWAY-SETUP.md §0), so the client ships in the web
# image too — a few MB, in exchange for not maintaining a second build path.
#
# The unversioned package tracks Alpine's current default major. pg_dump
# REFUSES to dump from a server newer than itself, so if Railway's Postgres is
# ever upgraded past it, db-backup.mjs fails its version check with the exact
# package to pin here (e.g. postgresql17-client) instead of silently producing
# an unusable backup.
RUN apk add --no-cache openssl libc6-compat postgresql-client

WORKDIR /app

# Drop root early: hand /app to the built-in unprivileged `node` user (uid 1000)
# and do all installs + copies as that user. Avoids a final `chown -R /app` that
# would rewrite every file in node_modules and double the layer size (Railway
# builders run out of disk on the @huggingface/inference tree otherwise).
RUN chown node:node /app
USER node

# Copy package files and install production deps only
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node prisma ./prisma/

RUN npm ci --legacy-peer-deps --omit=dev --ignore-scripts

# Re-generate Prisma Client in production image
RUN npx prisma generate

# Copy built application from builder stage
COPY --chown=node:node --from=builder /app/build ./build

# Copy runtime files. NOTE: these are listed by NAME, so a root module imported
# by one of them and forgotten here throws ERR_MODULE_NOT_FOUND inside
# server.js's try/catch: the app still serves requests, while a whole background
# service is silently gone (missing orphan-run-recovery.js would take task
# recovery AND the stuck-task monitor for every task type with it, leaving one
# log line behind).
COPY --chown=node:node server.js start.js ./
COPY --chown=node:node task-cleanup.service.js task-recovery.service.js webp-processor.service.js stale-image-cleanup.service.js gdpr-audit-cleanup.service.js image-op-refund.js orphan-run-recovery.js ./
COPY --chown=node:node scripts ./scripts/

# Copy middleware and other app files needed at runtime by server.js
COPY --chown=node:node app/middleware ./app/middleware/
COPY --chown=node:node app/utils ./app/utils/
COPY --chown=node:node app/config ./app/config/

EXPOSE 3000

CMD ["npm", "run", "start"]
