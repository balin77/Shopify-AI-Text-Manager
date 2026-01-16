# Use Node 22 Alpine (required for jsdom@27, isomorphic-dompurify 2.35+)
FROM node:22-alpine

# Install dependencies for Prisma and build tools
RUN apk add --no-cache openssl libc6-compat

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies with proper platform support
# Force the installation of the correct rollup binary for Alpine Linux
RUN npm install --legacy-peer-deps --force

# Copy application code
COPY . .

# Generate Prisma Client
RUN npx prisma generate

# Build the application
RUN npm run build

# Expose port
EXPOSE 3000

# Start command (runs migrations then starts server)
CMD ["npm", "run", "start"]
