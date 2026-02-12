# AdPilot Self-Hosted Convex — Deployment Guide

## Architecture

```
Server: 178.172.235.49

┌─────────────────────────────────────────────────────────────┐
│                    Dokploy + Traefik                         │
│                  (SSL/TLS, Reverse Proxy)                    │
└─────────────────────────────────────────────────────────────┘
        │                                          │
        ▼                                          ▼
┌───────────────┐         ┌──────────────────────────────────┐
│   Frontend    │         │    Convex Self-Hosted (отдельный  │
│   (React)     │         │    compose-сервис)                │
│  aipilot.by   │         │                                  │
│  :3000        │         │  ┌──────────┐ ┌─────────┐       │
└───────────────┘         │  │ Backend  │ │Dashboard│       │
        │                 │  │ :3220    │ │ :6792   │       │
        │                 │  │ :3221    │ └─────────┘       │
        │                 │  └────┬─────┘                    │
        │                 │       │                          │
        │                 │  ┌────▼─────┐                    │
        │                 │  │PostgreSQL│                    │
        │                 │  │ :5433    │                    │
        └─────────────────┤  └──────────┘                    │
                          └──────────────────────────────────┘

TenderPlan (уже занято): 3210/3211/6791/5432
AdPilot (новое):         3220/3221/6792/5433
```

## Deployment Steps

### Step 1: Deploy Convex Backend in Dokploy

1. В Dokploy создать новый **Compose** сервис (в проекте AddPilot или отдельном)
2. Вставить содержимое `docker/docker-compose.convex-selfhosted.yml`
3. Задать Environment Variables:
   ```
   INSTANCE_NAME=adpilot-prod
   INSTANCE_SECRET=<openssl rand -hex 32>
   POSTGRES_PASSWORD=<openssl rand -hex 16>
   ```
4. Deploy

### Step 2: Verify Backend

```bash
curl http://178.172.235.49:3220/version
# Должен вернуть версию Convex
```

### Step 3: Get Admin Key

```bash
# Способ 1: Через API
curl http://178.172.235.49:3220/api/generate_admin_key

# Способ 2: Из контейнера (SSH на сервер)
docker exec adpilot-convex-backend cat /convex/data/admin_key
```

Сохраните admin key — он нужен для деплоя функций.

### Step 4: Deploy Convex Functions

```bash
cd "/Users/anzelikamedvedeva/основное/ИИ и все что с ним связано/addpilot from claude"

# Вариант 1: Через скрипт
./docker/scripts/deploy-convex.sh <ADMIN_KEY>

# Вариант 2: Напрямую
npx convex deploy --url http://178.172.235.49:3220 --admin-key <ADMIN_KEY> --yes
```

Это задеплоит схему (15 таблиц) и все Convex функции.

### Step 5: Set Convex Environment Variables

В dashboard (http://178.172.235.49:6792) задать environment variables для Convex functions:
```
VK_CLIENT_ID=54431984
VK_CLIENT_SECRET=<your_secret>
TELEGRAM_BOT_TOKEN=<your_bot_token>
TELEGRAM_WEBHOOK_SECRET=<openssl rand -hex 32>
YANDEX_EMAIL=<your_email>
YANDEX_APP_PASSWORD=<your_app_password>
BEPAID_SHOP_ID=<your_shop_id>
BEPAID_SECRET_KEY=<your_secret_key>
```

### Step 6: Update Frontend in Dokploy

В Dokploy для сервиса AddPilot (prod) обновить Environment:
```
VITE_CONVEX_URL=http://178.172.235.49:3220
VITE_CONVEX_SITE_URL=http://178.172.235.49:3221
```
Остальные переменные (DOMAIN, VITE_REDIRECT_URI, VITE_TELEGRAM_BOT_USERNAME) — без изменений.

### Step 7: Redeploy Frontend

Нажать Deploy в Dokploy для AddPilot prod. Frontend пересоберётся с новыми URL.

## Verification

```bash
# 1. Backend responds
curl http://178.172.235.49:3220/version

# 2. Dashboard accessible
open http://178.172.235.49:6792

# 3. Frontend works
open https://aipilot.by

# 4. Test VK auth login flow
# 5. Verify data saves to tables in dashboard
```

## URLs

| Service | URL |
|---------|-----|
| Convex Backend | http://178.172.235.49:3220 |
| Convex HTTP Actions | http://178.172.235.49:3221 |
| Convex Dashboard | http://178.172.235.49:6792 |
| Frontend | https://aipilot.by |

## Troubleshooting

### Backend not starting
```bash
# SSH to server, check logs
docker logs adpilot-convex-backend
docker logs adpilot-postgres
```

### Functions not deploying
```bash
# Check backend is reachable
curl http://178.172.235.49:3220/version

# Check admin key is valid
npx convex deploy --url http://178.172.235.49:3220 --admin-key <KEY> --dry-run
```

### Frontend can't connect to Convex
- Check `VITE_CONVEX_URL` is set to `http://178.172.235.49:3220`
- Check that port 3220 is open in firewall
- Check browser console for CORS errors

### Port conflicts
TenderPlan and AdPilot use different ports. If ports conflict:
```bash
# Check what's using the port
ss -tlnp | grep 3220
```
