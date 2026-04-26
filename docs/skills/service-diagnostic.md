# Service Diagnostic Skill

## Trigger

Use when: diagnosing service issues, checking health, user reports "not working",
monitoring, health check, "why isn't rule/account/sync working?"

## Quick Commands

Manual checks from admin panel or Convex dashboard:

- **System check (Cycle 1):** Admin panel -> "Быстрая проверка" (5-15 sec)
- **Full diagnostic (Cycle 2):** Admin panel -> "Полная диагностика" (30-120 sec)
- **Single user:** Admin panel -> enter userId -> check (30-60 sec)

## Automated Schedule

- Cycle 1 (system health): every 6h (00:00, 06:00, 12:00, 18:00 UTC)
- Cycle 2 (function check): every 12h (03:00, 15:00 UTC)
- External ping: every 15 min (independent of Convex)

## What Gets Checked

### Cycle 1 — System Health (no VK API)
1. Crons: heartbeat + result verification (sync completeness, budget resets, digests)
2. User tokens: expiry, refresh capability
3. Account sync: status, lastSyncAt, credentials, agency tokens
4. Notifications: delivery failures, Telegram linkage
5. Payments: stuck pending, expired not downgraded
6. Subscriptions: expiring, limit violations

### Cycle 2 — Function Verification (with VK API, per-user)
1. User profile: tier limits, stopAd on freemium
2. Token test: real VK API call per account
3. Rule coverage: targetCampaignIds vs actionLogs (M < N = gap)
4. VK campaign status: our DB vs VK API (status, delivery mismatches)
5. Rule logic trace: evaluateCondition with real numbers
6. Log dynamics: spent growth pattern, budget reset verification
7. Leads: 5-source comparison, Lead Ads API availability
8. Deduplication: double stops, UZ campaign overlap
9. Account functionality: fetchUzCampaigns test, empty groups detection
10. Budget overspend: spent vs budget_limit_day per group

## Interpreting Results

- **ok**: everything works
- **warning**: degraded but functional (expiring tokens, stale sync, minor overspend)
- **error**: broken and needs fixing (expired tokens, rules not working, budget not reset)

## Key Files

- `convex/healthCheck.ts` — all check logic
- `convex/healthReport.ts` — Telegram formatting
- `convex/crons.ts` — scheduled runs
- `scripts/external-ping.sh` — independent uptime monitor

## Debugging with Diagnostic Data

### ОБЯЗАТЕЛЬНЫЙ ПОРЯДОК (не пропускать шаги)

When a user reports an issue or an alert fires:

**Шаг 0 — Системная картина (ВСЕГДА ПЕРВЫЙ)**

Прежде чем копать конкретный аккаунт/пользователя/правило — проверить общее здоровье системы:

```
Запросить healthCheck system results → прочитать блок "Кроны" →
найти строку "sync: X/Y синхронизированы"
```

Ответить на вопрос: **проблема единичная или массовая?**

| Результат | Вывод | Следующий шаг |
|---|---|---|
| sync 260/264 | Единичная проблема конкретного аккаунта | → Шаг 1 (индивидуальная диагностика) |
| sync 28/264 | Системная проблема — sync не справляется | → Искать причину в архитектуре sync (timeout, scheduler, deploy) |
| sync 0/264 | Cron сломан или Convex лежит | → Проверить cron heartbeat, Convex dashboard |

**Если проблема массовая — ЗАПРЕЩЕНО диагностировать конкретный аккаунт.** Починка одного аккаунта не поможет если 200+ аккаунтов не синхронизируются. Сначала системная причина.

**Шаг 1 — Индивидуальная диагностика** (только если Шаг 0 показал единичную проблему)

1. Run single-user diagnostic from admin panel
2. Read the Telegram report — it shows exactly which block failed
3. Each block provides specific error codes (COVERAGE_GAP, RESET_FAILED, etc.)
4. Follow the error to the relevant code/data

**Шаг 2 — Верификация гипотезы**

Прежде чем объявить корневую причину:
1. Предъявить конкретный артефакт (строка кода, лог, запись в БД, git diff)
2. Объяснить timeline: когда сломалось → почему → когда починилось (если починилось)
3. Если нашёл баг в коде — проверить: **этот баг объясняет ВСЕ симптомы или только часть?**
4. Если баг объясняет только часть — продолжить диагностику, не объявлять его причиной

### Антипаттерны (запрещены)

| Антипаттерн | Пример | Почему опасно |
|---|---|---|
| Копать деталь до проверки масштаба | Алерт "аккаунт X stale" → лезть в token recovery | 236/264 аккаунтов тоже stale, проблема системная |
| Первая гипотеза = финальная | Нашёл баг в handleTokenExpired → "вот причина" | Баг реальный, но не он вызвал проблему |
| Уверенность без данных | "Деплой перезапустил recovery" | Не проверил что именно перезапустил и когда |
| Фикс детали вместо системы | Починить token recovery для одного аккаунта | 200+ аккаунтов всё ещё не синхронизируются |
