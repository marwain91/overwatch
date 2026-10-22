# Overwatch - Multi-Tenant Management Tool

# Every stage uses node:24-alpine pinned by digest, so a rebuild of the same
# commit gets the same base image. The tag stays in the reference for humans
# and for Dependabot, which bumps the digest (all three FROM lines together).

# ── Stage 1: Build server from source ──
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS server-build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts/ ./scripts/
COPY templates/ ./templates/
COPY src/ ./src/
RUN npm run build

# ── Stage 2: Build React UI ──
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS ui-build
WORKDIR /ui
COPY ui/package*.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

# ── Stage 3: Runtime ──
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

ARG BUILD_TIME=dev
ARG BUILD_COMMIT=dev
ENV BUILD_TIME=$BUILD_TIME
ENV BUILD_COMMIT=$BUILD_COMMIT

WORKDIR /app

# Install dependencies for health checks, backup operations, and database dumps.
# `su-exec` lets the entrypoint drop from root to the `node` user while preserving
# a clean signal-handling path (unlike `su` / `sudo`).
RUN apk add --no-cache wget restic docker-cli docker-cli-compose mysql-client postgresql-client su-exec shadow

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy built application
COPY --from=server-build /app/dist ./dist

# Copy React UI build
COPY --from=ui-build /ui/dist ./ui/dist

# Create data directory with the `node` user as owner so the app can write
# even after we drop privileges below.
RUN mkdir -p /app/data && chown -R node:node /app

# Entrypoint drops privileges to `node` before running the app. Because
# /var/run/docker.sock is owned by root:docker (or a host-specific GID), the
# entrypoint detects the socket's GID at runtime and ensures the node user is
# a member of a matching group — no operator config required for the common case.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

# Expose port
EXPOSE 3002

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3002/health || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
