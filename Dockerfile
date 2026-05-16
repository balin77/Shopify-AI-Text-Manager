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

# Install Alpine-specific rollup binary
RUN npm install --no-save @rollup/rollup-linux-x64-musl

# Copy source code and build
COPY . .
RUN npm run build

# ── Stage 2: Production ──────────────────────────────────────────
FROM node:22-alpine

RUN apk add --no-cache openssl libc6-compat

WORKDIR /app

# Copy package files and install production deps only
COPY package.json package-lock.json ./
COPY prisma ./prisma/

RUN npm ci --legacy-peer-deps --omit=dev --ignore-scripts

# Re-generate Prisma Client in production image
RUN npx prisma generate

# Copy built application from builder stage
COPY --from=builder /app/build ./build

# Copy runtime files
COPY server.js start.js remix.config.js ./
COPY task-cleanup.service.js task-recovery.service.js webp-processor.service.js stale-image-cleanup.service.js gdpr-audit-cleanup.service.js ./
COPY scripts ./scripts/

# Copy middleware and other app files needed at runtime by server.js
COPY app/middleware ./app/middleware/
COPY app/utils ./app/utils/

EXPOSE 3000

CMD ["npm", "run", "start"]
