#!/bin/bash
# ============================================
# Deploy Convex Functions to Self-Hosted Backend
# AdPilot — 178.172.235.49:3220
# ============================================
# Usage:
#   ./deploy-convex.sh                          # uses env vars
#   ./deploy-convex.sh <ADMIN_KEY>              # pass admin key
#   CONVEX_ADMIN_KEY=xxx ./deploy-convex.sh     # via env

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(dirname "$DOCKER_DIR")"

CONVEX_URL="${CONVEX_SELF_HOSTED_URL:-http://178.172.235.49:3220}"

# Admin key: argument > env var > .env file
ADMIN_KEY="${1:-${CONVEX_ADMIN_KEY:-}}"

if [ -z "$ADMIN_KEY" ]; then
    # Try loading from local env file
    if [ -f "$DOCKER_DIR/.env.selfhosted-prod" ]; then
        source "$DOCKER_DIR/.env.selfhosted-prod"
        ADMIN_KEY="${CONVEX_SELF_HOSTED_ADMIN_KEY:-}"
    fi
fi

if [ -z "$ADMIN_KEY" ]; then
    echo "Error: Admin key not provided."
    echo ""
    echo "Get admin key:"
    echo "  curl http://178.172.235.49:3220/api/generate_admin_key"
    echo ""
    echo "Then run:"
    echo "  ./deploy-convex.sh <ADMIN_KEY>"
    echo "  # or"
    echo "  CONVEX_ADMIN_KEY=<key> ./deploy-convex.sh"
    exit 1
fi

echo "Deploying Convex functions to: $CONVEX_URL"

cd "$PROJECT_DIR"

# Deploy schema + functions
npx convex deploy --url "$CONVEX_URL" --admin-key "$ADMIN_KEY" --yes

echo ""
echo "Convex functions deployed to self-hosted backend!"
echo "Dashboard: http://178.172.235.49:6792"
