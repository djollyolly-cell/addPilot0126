#!/bin/bash
# ============================================
# Deploy Convex Functions Script
# Sprint 32 — Self-Hosted Docker Deploy
# ============================================
# Usage: ./deploy-convex.sh [dev|prod]

set -e

ENV=${1:-dev}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(dirname "$DOCKER_DIR")"

echo "🔧 Deploying Convex functions to $ENV..."

cd "$PROJECT_DIR"

case $ENV in
    dev)
        CONVEX_URL="http://localhost:3210"
        CONTAINER="adpilot-convex-dev"
        ;;
    prod)
        if [ -z "$DOMAIN" ]; then
            source "$DOCKER_DIR/.env.prod" 2>/dev/null || true
        fi
        if [ -z "$DOMAIN" ]; then
            echo "❌ Error: DOMAIN not set"
            exit 1
        fi
        CONVEX_URL="https://convex.$DOMAIN"
        CONTAINER="adpilot-convex-prod"
        ;;
    *)
        echo "❌ Unknown environment: $ENV"
        echo "   Usage: ./deploy-convex.sh [dev|prod]"
        exit 1
        ;;
esac

# Check if container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    echo "❌ Container $CONTAINER is not running"
    echo "   Start it with: docker compose -f docker/docker-compose.$ENV.yml up -d"
    exit 1
fi

echo "📍 Deploying to: $CONVEX_URL"

# Get admin key from container or environment
if [ -n "$CONVEX_ADMIN_KEY" ]; then
    ADMIN_KEY="$CONVEX_ADMIN_KEY"
else
    ADMIN_KEY=$(docker exec "$CONTAINER" cat /convex/data/admin_key 2>/dev/null || echo "")
fi

if [ -z "$ADMIN_KEY" ]; then
    echo "⚠️  No admin key found. Generating one..."
    docker exec "$CONTAINER" convex-local-backend generate-admin-key > /tmp/admin_key.txt
    ADMIN_KEY=$(cat /tmp/admin_key.txt)
    echo "📝 Admin key: $ADMIN_KEY"
    echo "   Save this key to your .env.$ENV file as CONVEX_ADMIN_KEY"
fi

# Deploy
npx convex deploy --url "$CONVEX_URL" --admin-key "$ADMIN_KEY" --yes

echo ""
echo "✅ Convex functions deployed to $ENV!"
