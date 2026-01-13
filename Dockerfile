# Overwatch - Multi-Tenant Management Tool
FROM node:20-alpine

WORKDIR /app

# Install dependencies for health checks and backup operations
RUN apk add --no-cache wget curl restic

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy built application
COPY dist/ ./dist/
COPY public/ ./public/

# Create data directory for admin users
RUN mkdir -p /app/data

# Expose port
EXPOSE 3002

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3002/health || exit 1

# Start the application
CMD ["node", "dist/index.js"]
