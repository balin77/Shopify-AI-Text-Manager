# Use Node 22 Alpine (required for jsdom@27, isomorphic-dompurify 2.35+)
FROM node:22-alpine

# Install dependencies for Prisma and build tools
RUN apk add --no-cache openssl libc6-compat

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json ./
COPY prisma ./prisma/

# Install dependencies with proper platform support
# Use --ignore-scripts to skip problematic postinstall hooks (like husky)
RUN npm install --legacy-peer-deps --ignore-scripts

# Manually run prisma generate (normally done in postinstall)
RUN npx prisma generate

# Explicitly install the Alpine Linux rollup binary
RUN npm install --no-save @rollup/rollup-linux-x64-musl

# Copy application code
COPY . .

# Build the application
RUN npm run build

# Expose port
EXPOSE 3000

# Start command (runs migrations then starts server)
CMD ["npm", "run", "start"]
