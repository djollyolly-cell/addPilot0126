#!/bin/bash
# ============================================
# AdPilot DEV Environment Initialization
# Sprint 32 — Self-Hosted Docker Deploy
# ============================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(dirname "$DOCKER_DIR")"

echo "🚀 Starting AdPilot DEV Environment..."
echo "=========================================="

# Check if .env.dev exists
if [ ! -f "$DOCKER_DIR/.env.dev" ]; then
    echo "📝 Creating .env.dev from example..."
    cp "$DOCKER_DIR/.env.dev.example" "$DOCKER_DIR/.env.dev"
    echo "⚠️  Please edit docker/.env.dev with your credentials"
fi

# Start Convex backend first
echo ""
echo "📦 Starting Convex Backend..."
docker compose -f "$DOCKER_DIR/docker-compose.dev.yml" up -d convex-backend-dev

# Wait for backend to be healthy
echo ""
echo "⏳ Waiting for Convex backend to be ready..."
timeout=60
while [ $timeout -gt 0 ]; do
    if docker exec adpilot-convex-dev curl -s http://localhost:3210/version > /dev/null 2>&1; then
        echo "✅ Convex backend is ready!"
        break
    fi
    sleep 2
    timeout=$((timeout - 2))
done

if [ $timeout -le 0 ]; then
    echo "❌ Timeout waiting for Convex backend"
    exit 1
fi

# Start dashboard
echo ""
echo "📊 Starting Convex Dashboard..."
docker compose -f "$DOCKER_DIR/docker-compose.dev.yml" up -d convex-dashboard-dev

# Deploy Convex functions
echo ""
echo "🔧 Deploying Convex functions to DEV..."
cd "$PROJECT_DIR"
npx convex deploy --url http://localhost:3210 --admin-key "$(docker exec adpilot-convex-dev cat /convex/data/admin_key 2>/dev/null || echo '')"

# Start frontend
echo ""
echo "🌐 Starting Frontend..."
docker compose -f "$DOCKER_DIR/docker-compose.dev.yml" up -d frontend-dev

echo ""
echo "=========================================="
echo "✅ AdPilot DEV Environment is running!"
echo ""
echo "📍 URLs:"
echo "   Frontend:  http://localhost:3000"
echo "   Convex:    http://localhost:3210"
echo "   Dashboard: http://localhost:6791"
echo ""
echo "📋 Commands:"
echo "   Logs:      docker compose -f docker/docker-compose.dev.yml logs -f"
echo "   Stop:      docker compose -f docker/docker-compose.dev.yml down"
echo "   Restart:   docker compose -f docker/docker-compose.dev.yml restart"
echo "=========================================="
