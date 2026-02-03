# AdPilot Self-Hosted Docker Deployment

Sprint 32 — Self-Hosted Docker Deploy

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Dokploy + Traefik                       │
│                    (SSL/TLS, Reverse Proxy)                     │
└─────────────────────────────────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
        ▼                       ▼                       ▼
┌───────────────┐      ┌───────────────┐      ┌───────────────┐
│   Frontend    │      │    Convex     │      │    Convex     │
│   (React)     │      │   Backend     │      │   Dashboard   │
│  :3000        │      │ :3210, :3211  │      │    :6791      │
└───────────────┘      └───────────────┘      └───────────────┘
        │                       │
        │                       ▼
        │              ┌───────────────┐
        │              │  Convex Data  │
        │              │   (Volume)    │
        └──────────────┴───────────────┘
```

## Quick Start

### Local Development

```bash
# 1. Copy environment file
cp docker/.env.dev.example docker/.env.dev

# 2. Edit with your credentials
nano docker/.env.dev

# 3. Start DEV environment
./docker/scripts/init-dev.sh

# Or manually:
docker compose -f docker/docker-compose.dev.yml up -d
```

### Production (Dokploy)

1. **In Dokploy:**
   - Create new project from Git repository
   - Set Docker Compose file: `docker/docker-compose.prod.yml`

2. **Set Environment Variables in Dokploy:**
   ```
   DOMAIN=aipilot.by
   CONVEX_ADMIN_KEY=your_admin_key
   VK_CLIENT_ID=...
   VK_CLIENT_SECRET=...
   TELEGRAM_BOT_TOKEN=...
   BEPAID_SHOP_ID=...
   BEPAID_SECRET_KEY=...
   ```

3. **Deploy!**

## URLs

### DEV Environment
| Service | URL |
|---------|-----|
| Frontend | http://localhost:3000 |
| Convex API | http://localhost:3210 |
| Convex WS | http://localhost:3211 |
| Dashboard | http://localhost:6791 |

### PROD Environment (with DOMAIN=aipilot.by)
| Service | URL |
|---------|-----|
| Frontend | https://aipilot.by |
| Convex API | https://convex.aipilot.by |
| Convex WS | https://api.aipilot.by |
| Dashboard | https://dashboard.aipilot.by |

## DNS Configuration

Add these DNS records for your domain:

```
A     @           → your-server-ip
A     www         → your-server-ip
A     convex      → your-server-ip
A     api         → your-server-ip
A     dashboard   → your-server-ip
```

## Deploying Convex Functions

After changing Convex functions (`convex/*.ts`):

```bash
# DEV
./docker/scripts/deploy-convex.sh dev

# PROD
./docker/scripts/deploy-convex.sh prod
```

## Commands

```bash
# Start
docker compose -f docker/docker-compose.dev.yml up -d

# Stop
docker compose -f docker/docker-compose.dev.yml down

# Logs
docker compose -f docker/docker-compose.dev.yml logs -f

# Restart specific service
docker compose -f docker/docker-compose.dev.yml restart convex-backend-dev

# View Convex data
docker exec -it adpilot-convex-dev ls /convex/data
```

## Backup & Restore

### Backup Convex Data
```bash
# DEV
docker run --rm -v adpilot-convex-data-dev:/data -v $(pwd):/backup \
  alpine tar czf /backup/convex-backup-dev.tar.gz -C /data .

# PROD
docker run --rm -v adpilot-convex-data-prod:/data -v $(pwd):/backup \
  alpine tar czf /backup/convex-backup-prod.tar.gz -C /data .
```

### Restore
```bash
docker run --rm -v adpilot-convex-data-dev:/data -v $(pwd):/backup \
  alpine tar xzf /backup/convex-backup-dev.tar.gz -C /data
```

## Troubleshooting

### Convex backend not starting
```bash
docker logs adpilot-convex-dev
# Check for port conflicts or volume permissions
```

### Functions not deploying
```bash
# Check admin key
docker exec adpilot-convex-dev cat /convex/data/admin_key

# Manual deploy
npx convex deploy --url http://localhost:3210 --admin-key YOUR_KEY
```

### Frontend can't connect to Convex
- Check VITE_CONVEX_URL in environment
- Verify Convex backend is healthy
- Check CORS settings
