# Overwatch - Multi-Tenant Management Tool

# ── Stage 1: Build React UI ──
FROM node:22-alpine AS ui-build
WORKDIR /ui
COPY ui/package*.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

# ── Stage 2: Runtime ──
FROM node:22-alpine

ARG BUILD_TIME=dev
ARG BUILD_COMMIT=dev
ENV BUILD_TIME=$BUILD_TIME
ENV BUILD_COMMIT=$BUILD_COMMIT

WORKDIR /app

# Install dependencies for health checks, backup operations, and database dumps
RUN apk add --no-cache wget curl restic docker-cli docker-cli-compose mysql-client postgresql-client

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy built application
COPY dist/ ./dist/

# Copy React UI build
COPY --from=ui-build /ui/dist ./ui/dist

# Keep legacy public/ as fallback
COPY public/ ./public/

# Create data directory and set ownership to node user
RUN mkdir -p /app/data && chown -R node:node /app/data

# Drop root privileges
USER node

# Expose port
EXPOSE 3002

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3002/health || exit 1

# Start the application
CMD ["node", "dist/index.js"]
