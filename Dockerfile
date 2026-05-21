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

RUN apk add --no-cache openssl libc6-compat

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

# Copy runtime files
COPY --chown=node:node server.js start.js remix.config.js ./
COPY --chown=node:node task-cleanup.service.js task-recovery.service.js webp-processor.service.js stale-image-cleanup.service.js gdpr-audit-cleanup.service.js image-op-refund.js ./
COPY --chown=node:node scripts ./scripts/

# Copy middleware and other app files needed at runtime by server.js
COPY --chown=node:node app/middleware ./app/middleware/
COPY --chown=node:node app/utils ./app/utils/
COPY --chown=node:node app/config ./app/config/

EXPOSE 3000

CMD ["npm", "run", "start"]
