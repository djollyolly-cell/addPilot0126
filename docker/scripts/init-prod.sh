#!/bin/bash
# ============================================
# AdPilot PROD Environment Initialization
# Sprint 32 — Self-Hosted Docker Deploy
# ============================================
# For Dokploy deployment

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(dirname "$DOCKER_DIR")"

echo "🚀 Starting AdPilot PROD Environment..."
echo "=========================================="

# Check for required environment variables
if [ -z "$DOMAIN" ]; then
    echo "❌ Error: DOMAIN environment variable is required"
    echo "   Set it in Dokploy or export DOMAIN=yourdomain.com"
    exit 1
fi

echo "📍 Domain: $DOMAIN"

# Check if .env.prod exists
if [ ! -f "$DOCKER_DIR/.env.prod" ]; then
    echo "📝 Creating .env.prod from example..."
    cp "$DOCKER_DIR/.env.prod.example" "$DOCKER_DIR/.env.prod"
    echo "⚠️  Please edit docker/.env.prod with your credentials"
fi

# Load environment
export $(grep -v '^#' "$DOCKER_DIR/.env.prod" | xargs)

# Pull latest images
echo ""
echo "📥 Pulling latest images..."
docker compose -f "$DOCKER_DIR/docker-compose.prod.yml" pull

# Start all services
echo ""
echo "📦 Starting all services..."
docker compose -f "$DOCKER_DIR/docker-compose.prod.yml" up -d

# Wait for Convex to be ready
echo ""
echo "⏳ Waiting for Convex backend to be ready..."
timeout=120
while [ $timeout -gt 0 ]; do
    if docker exec adpilot-convex-prod curl -s http://localhost:3210/version > /dev/null 2>&1; then
        echo "✅ Convex backend is ready!"
        break
    fi
    sleep 3
    timeout=$((timeout - 3))
done

if [ $timeout -le 0 ]; then
    echo "❌ Timeout waiting for Convex backend"
    docker compose -f "$DOCKER_DIR/docker-compose.prod.yml" logs convex-backend-prod
    exit 1
fi

# Deploy Convex functions
echo ""
echo "🔧 Deploying Convex functions to PROD..."
cd "$PROJECT_DIR"

if [ -n "$CONVEX_ADMIN_KEY" ]; then
    npx convex deploy --url "https://convex.$DOMAIN" --admin-key "$CONVEX_ADMIN_KEY" --yes
else
    echo "⚠️  CONVEX_ADMIN_KEY not set. Skipping function deployment."
    echo "   Run manually: npx convex deploy --url https://convex.$DOMAIN --admin-key YOUR_KEY"
fi

echo ""
echo "=========================================="
echo "✅ AdPilot PROD Environment is running!"
echo ""
echo "📍 URLs:"
echo "   Frontend:  https://$DOMAIN"
echo "   Convex:    https://convex.$DOMAIN"
echo "   Dashboard: https://dashboard.$DOMAIN"
echo "   API (WS):  https://api.$DOMAIN"
echo ""
echo "🔒 SSL certificates are managed by Traefik/Dokploy"
echo "=========================================="
