#!/bin/bash
# Overwatch Self-Update Script
# Run this on the server to update Overwatch to the latest version
#
# Usage: ./update.sh [--check]
#   --check   Only check for updates, don't apply

set -e

# Configuration
COMPOSE_DIR="${COMPOSE_DIR:-/opt/myapp/deploy/infrastructure}"
SERVICE_NAME="${SERVICE_NAME:-admin}"
IMAGE="${IMAGE:-ghcr.io/marwain91/overwatch:latest}"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}Overwatch Update${NC}"
echo "================"
echo ""

# Get current image digest
echo "Checking current version..."
CURRENT_DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE" 2>/dev/null || echo "none")
echo "Current: ${CURRENT_DIGEST:-not found}"

# Pull latest image
echo ""
echo "Pulling latest image..."
docker pull "$IMAGE"

# Get new image digest
NEW_DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE" 2>/dev/null || echo "none")
echo "Latest:  ${NEW_DIGEST}"

# Compare digests
if [ "$CURRENT_DIGEST" = "$NEW_DIGEST" ]; then
    echo ""
    echo -e "${GREEN}Already up to date!${NC}"
    exit 0
fi

echo ""
echo -e "${YELLOW}Update available!${NC}"

# Check-only mode
if [ "$1" = "--check" ]; then
    echo "Run without --check to apply the update."
    exit 0
fi

# Apply update
echo ""
echo "Applying update..."
cd "$COMPOSE_DIR"
docker compose up -d "$SERVICE_NAME"

echo ""
echo -e "${GREEN}Update complete!${NC}"
echo ""

# Wait and show status
sleep 3
echo "Container status:"
docker ps --filter "name=$SERVICE_NAME" --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"
