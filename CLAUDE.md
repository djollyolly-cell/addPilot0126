# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AdPilot — SaaS for automating VK Ads (myTarget API v2). Rule-based monitoring stops ineffective ads and sends Telegram/email notifications. Self-hosted Convex backend + React frontend deployed via Docker/Dokploy.

## Quick Commands

```bash
npm run dev                              # Vite dev server
npm run build                            # Production build
npm run lint                             # ESLint (max 50 warnings)
npm run test                             # Unit + integration (Vitest)
npm run test:e2e                         # Playwright E2E
npm run ci                               # Full pipeline
npx tsc --noEmit -p convex/tsconfig.json # Typecheck Convex
```

**Deploy:** Push to `main` → GitHub Actions auto-deploys Convex + Docker image.

## Modular Rules

Detailed rules are in `.claude/rules/`:

| File | Contents |
|---|---|
| `architecture.md` | Stack, project structure, data flow, key files |
| `design-system.md` | Colors (HSL tokens), light/dark mode, spacing, animations |
| `components.md` | UI components (Button, Card, Badge variants), icon usage |
| `layout-and-navigation.md` | Sidebar, mobile nav, page structure, grid patterns |
| `frontend-patterns.md` | React patterns, hooks, forms, routing, formatting |
| `convex-patterns.md` | Backend functions, queries, mutations, VK API, rule engine |
| `database-schema.md` | All 16 tables with fields, indexes, conventions |
| `deploy-and-testing.md` | Deploy flow, servers, testing commands, env vars |

## Critical Conventions

- **Language:** All UI text in Russian. Use `ru-RU` locale for formatting.
- **Colors:** NEVER use raw hex/rgb. Always use design tokens (`bg-primary`, `text-muted-foreground`, etc.)
- **Components:** shadcn/ui pattern with CVA. Merge classes with `cn()`.
- **Backend:** Convex functions (query/mutation/action). VK API via `callMtApi()` with retry.
- **Dates:** UTC in backend (`todayStr()`). Russian format in frontend (`formatDate()`).
- **Leads:** 5 sources (base.goals, vk.result, vk.goals, events, Lead Ads API), take `Math.max()`. Safety check via statistics API before stopping ads.
- **Notifications:** Critical → immediate. Standard → 5-min grouped. Quiet hours for non-critical.
- **Path alias:** `@/*` → `./src/*`
- **Testing:** Add `data-testid` to key elements.

## Plans & Schema Changes

- Before writing/reviewing a plan: READ every file the plan modifies.
- New table with `userId` → add to `deleteUser` cascade + `data-retention.md`.
- New table that is a companion/state for another entity → verify ALL mutations (create/update/toggle/delete) on the parent entity synchronize the companion.
- After writing a plan: integration check — every import path, every type, every UI pattern verified against real code. Do NOT claim "done" without this.

## Pre-Commit Verification

- ALWAYS run `npx tsc --noEmit -p convex/tsconfig.json` before committing Convex changes. Must see clean output — no exceptions.
- After adding/renaming files in `convex/` — `_generated/api.ts` must be in sync; typecheck catches missing `internal.*` references.
- Check source files for encoding issues (broken UTF-8 characters like `Но��еров`).
- **ОБЯЗАТЕЛЬНО: `npm run test` перед каждым коммитом.** Все тесты должны проходить. Если тест падает — не коммитить, а починить. Если изменение затрагивает UI-компонент с несколькими сценариями (create/edit, разные роли, разные состояния) — проверить что существующие тесты покрывают все сценарии, при отсутствии — написать недостающие тесты ДО коммита.
- **Companion-sync check при мутациях:** При изменении/создании мутации на сущность с companion-таблицей (rules→rotationState, rules→budgetManageState) — перечислить ВСЕ мутации этой сущности (create/update/toggle/delete) и убедиться что каждая синхронизирует companion. Верификация: `grep -n "scheduler.runAfter.*videoRotation" convex/rules.ts` — количество вызовов должно покрывать все мутации. Если мутация не вызывает companion — обосновать почему.

## Feature Implementation Checks

- **Facts only, no assumptions.** Every claim about the codebase must be backed by reading the actual file or running the actual API call. If you haven't read the code — you don't know how it works. If you haven't called the API — you don't know what it returns. Never say "скорее всего", "наверное", "должно быть" about code behavior — open the file and verify.
- **Numbers and data — query first, answer second.** When discussing specific metrics, counts, or statuses (подписки, лиды, ошибки, etc.) — FIRST query the database or API, THEN answer. Never state numbers from memory, context, or assumption. The sequence is: (1) identify what data is needed, (2) write and run a query/script to get real data, (3) present verified results. All access is provided — there is no excuse to guess instead of checking.
- **Data chain first:** Before implementing a feature, trace DB schema → backend query → frontend display. If a field is missing in `schema.ts`, the feature **cannot work** — don't build UI for it.
- **Full data pass-through check:** When adding new fields to a form or API call, trace the ENTIRE chain: TypeScript interface → form submit → callback/handler → mutation call → backend args. In this project, `RulesPage.tsx` has an intermediate `onSubmit` callback that **manually lists every field** (not `...data` spread) — any new field MUST be added in THREE places: (1) `RuleFormSubmitData` interface, (2) `RuleForm.handleSubmit` call to `onSubmit(data)`, (3) the `onSubmit` callback's call to `createRule({...})`. Missing any one link silently drops the field. After adding fields, grep for the field name and verify it appears at every layer.
- **Stateful companion sync:** Если сущность A управляет активным процессом через companion-сущность B (например: `rules` → `rotationState`, `rules` → `budgetManageState`), то **каждая** мутация на A (create, update, toggle, delete) должна синхронизировать B. Перед написанием/изменением мутации — перечислить ВСЕ мутации сущности и для каждой ответить: "нужно ли создать / обновить / удалить companion?" Типичный пропуск: `update` меняет параметры, но не перезапускает процесс — companion продолжает работать со старыми данными или не создаётся вовсе. Аналогично `deleteUser` cascade, но для ВСЕХ типов мутаций, не только delete.
- **User flow walkthrough перед кодом:** Перед написанием/изменением любого UI-компонента — перечислить ВСЕ сценарии использования (создание, редактирование, частичное обновление одного поля, повторный вход) и для каждого ответить: (1) с какого шага/состояния пользователь начинает, (2) какие данные уже есть vs какие нужно ввести, (3) какие поля обязательны именно в этом сценарии. Если компонент обслуживает несколько сценариев — каждый должен быть спроектирован отдельно. При передаче `existingId` для редактирования — всегда передавать текущие данные сущности (одного ID недостаточно для отображения). Ключевой вопрос: "что увидит пользователь, если хочет изменить только ОДНО поле?"
- **Happy path walkthrough:** After writing aggregation/grouping code, mentally walk 1 example through the full pipeline. Verify grouping keys produce unique values for distinct entities.
- **Fresh data vs cache:** Client-facing reports (`clientReport.ts buildReport`) call VK API directly (`getMtStatistics` → `statistics/banners/day.json`) instead of reading from `metricsDaily` cache. Cache is for rule engine 5-min monitoring, not for accurate reports. VK adjusts stats retroactively for past dates — cache never re-fetches. Use `base.vk.result` from fresh API — matches VK cabinet "Результат" exactly.
- **Leads context matters:** Rule engine uses `countLeadsFromRow()` with Math.max from 5 sources. Client report uses `vk.result` from fresh VK API, routed by `getCampaignTypeMap` classification into categories (subscribes/messages/lead_forms/other). Don't mix these approaches.
- **Verify real API responses before writing parsers.** Never assume response format — write a diagnostic script, call the API, inspect actual data. Package names turned out to be technical slugs (`or_tt_crossdevice_..._pricedGoals_join`), not human-readable Russian strings.
- **Verify API write endpoints before writing code that POSTs/PATCHes.** Before implementing any function that WRITES to an external API: (1) check which fields the endpoint actually accepts (GET the entity first, inspect available fields), (2) run a test POST/PATCH and verify it succeeds, (3) only then write and commit the code. Never assume a field exists on an entity — `budget_limit_day` lived on `campaigns`, not `ad_plans`, and the code silently failed for weeks.
- **Обязательный тест на реальных данных для любого нового API-вызова.** При написании любой `internalAction` / функции, которая делает POST/PATCH/DELETE во внешний API — **ДО коммита** написать и запустить диагностический скрипт, который вызывает этот endpoint на реальных данных (staging или prod). Результат должен быть 200/204. Если 4xx/5xx — не коммитить, а разобраться. Это НЕ опционально, НЕ "потом проверю". Порядок: (1) написать код, (2) написать диагностический скрипт, (3) запустить, увидеть успех, (4) только тогда коммитить. Причина: `setAdPlanBudget` был закоммичен и задеплоен без единого успешного вызова — ошибка обнаружена спустя недели.
- **Date filtering:** When extracting data from messages/events, always filter by the requested date range (`>= fromTs && <= toTs`). Don't let old data leak into reports.
- **Dialog start = first message date**, not last. Use `messagesGetHistory(rev=0, count=1)` to get the actual first message in a conversation.
- **Expected API errors:** Handle known non-error responses gracefully (e.g. Lead Ads 404 = account has no lead forms → skip silently, don't add to `partialErrors`).
- **Floating point:** Round `spent` after each summation with `Math.round(... * 100) / 100` to avoid values like `3399.9999999999995`.
- **Never offer UI options the backend can't fulfill** (e.g. `day_group` granularity when the data source has no `groupId` field).
- **NEVER write rules/docs about code without reading the actual current code first.** Verify every function name, every argument, every mechanic against the real file.
- **Never claim data is available without verifying the source.** Don't say "дайджест уже считает подписки" or "эти данные уже есть" without finding the exact function/query that produces them. Trace the full chain: API call → parser → storage → query → UI. If you can't point to the line of code — don't claim it exists.

## Parallelism & Fan-Out Checklist

When converting sequential processing to parallel/fan-out (e.g. `ctx.scheduler.runAfter` per item):

- **External API load:** N workers = N simultaneous API requests. ALWAYS stagger dispatches (`runAfter(delayMs, ...)`) — never `runAfter(0, ...)` for all items. First batch = **half** of `APPLICATION_MAX_CONCURRENT_V8_ACTIONS` (16 of 32) to leave slots for crons/rules/other actions. Then groups of 8 every 3s.
- **Scheduler saturation:** Never fill ALL V8 action slots with fan-out workers. Reserve at least 50% of slots for other system functions (crons, rule checks, token refresh, user queries). If fan-out uses all 32 slots, Convex scheduler falls behind and other scheduled functions are delayed.
- **Timeout recalibration:** Sequential model shares one action's time budget across all items. Fan-out gives each item its own action — timeouts can (and should) be more generous. Recalculate based on the new execution model.
- **Data distribution before limits:** Before setting ANY numeric limit (timeout, batch size, threshold) — query real data to find outliers. Don't assume items are uniform. Run: "what's the heaviest account/user/entity?" Example: 262 accounts have <50 campaigns, but 2 accounts have 1300–2087 — a timeout based on average will fail for outliers. ALWAYS measure before constraining.
- **Monitoring thresholds:** Stale/freshness thresholds designed for sequential timing don't apply to parallel. Recalculate: `(total_items / concurrent_limit) × avg_time + stagger_delay`.
- **Notification multiplication:** Trace the FULL alert chain before fan-out. If `systemLogger.log(level: "error")` → `adminAlerts.notify` → Telegram, then 1 sequential action = 1 alert max, but fan-out of 264 items = up to 264 Telegram messages. Either deduplicate alerts or adjust log levels for transient errors in workers.
- **Convex scheduler limits:** `ctx.scheduler.runAfter` only works in mutations (not actions). Large batches need a separate `internalMutation` for dispatching. `APPLICATION_MAX_CONCURRENT_V8_ACTIONS` env var controls concurrency ceiling.
- **Rename ripple check:** When renaming a function or heartbeat name, grep for ALL references: health checks, admin dashboards, monitoring configs, alert handlers. `grep -rn '"oldName"' convex/ --include="*.ts"` — every hit must be updated.

## Error State Lifecycle

When writing code that sets an entity to an error/failed state (`status: "error"`, `lastError`, `failCount++`, etc.):

- **Error lifecycle checklist (mandatory):** For every `status = "error"` or equivalent, answer ALL four questions before committing: (1) **Кто узнает?** — оператор/админ получит уведомление? Если нет — добавить. Ошибка без уведомления = невидимая ошибка. (2) **Сколько будет длиться?** — есть ли auto-recovery, retry, или эскалация? Если ошибка может жить вечно — добавить эскалацию (например, повторное уведомление через 2ч). (3) **Как восстановится?** — что вернёт статус в норму? Ручное действие? Следующий cron? Retry? Документировать путь восстановления. (4) **Как отличить от других ошибок?** — dedupKey/логи содержат entityId? Если несколько сущностей могут ошибаться одновременно, каждая должна иметь уникальный идентификатор в алертах.
- **DedupKey must include entityId:** При отправке алертов через `adminAlerts.notify` или аналогичные системы — `dedupKey` ОБЯЗАТЕЛЬНО должен включать ID сущности (`accountId`, `userId`, `ruleId`). Без этого ошибка аккаунта A подавляет алерт аккаунта B. Формат: `${source}:${entityId}:${messagePrefix}`.
- **Adaptive parameters for varying data scales:** ЗАПРЕЩЕНО использовать один фиксированный таймаут/лимит для сущностей с разным объёмом данных. Перед установкой ANY числового параметра (таймаут, batch size, rate limit): (1) запросить реальное распределение данных (`SELECT COUNT(*) GROUP BY entity`), (2) найти outliers (топ-5 самых тяжёлых), (3) для outliers — отдельная ветка параметров или динамическая формула. Пример: 262 аккаунта с <50 кампаниями и 2 аккаунта с 2087 — один таймаут 120с убьёт тяжёлые.
- **Silent DB writes are not notifications:** `ctx.db.insert("systemLogs", ...)` без последующего `adminAlerts.notify` — это запись в лог, НЕ уведомление оператора. Если ошибка требует внимания человека, должен быть явный вызов системы уведомлений (Telegram, email, push).
- **Every early return must complete bookkeeping:** Если функция обновляет маркер "я был здесь" (`lastSyncAt`, `lastCheckedAt`, `processedAt`) в конце — КАЖДЫЙ early return, включая "нет данных" / "пустой список" / "skip", тоже ОБЯЗАН обновить этот маркер. Иначе сущность застревает в бесконечном retry-цикле. Чеклист: найти все `return` до маркера → для каждого ответить: "это ошибка (маркер не нужен) или валидное завершение (маркер обязателен)?"
- **Log severity = final outcome, not initial symptom:** ЗАПРЕЩЕНО логировать `level: "error"` до попытки auto-recovery. Если есть механизм восстановления (tokenRecovery, retry, fallback) — сначала попробовать, потом логировать. Успешное восстановление → `warn`. Неудачное → `error`. Иначе каждый transient сбой шлёт ложный алерт оператору.
- **Alert frequency must match human response time:** Частота алертов должна соответствовать скорости реакции человека. Если оператор не может отреагировать быстрее чем за 2 часа — эскалация каждые 30 мин = шум. Правило: dedup window ≥ ожидаемого времени реакции. Для ночных ошибок — ещё длиннее.

## Debugging & Fix Discipline

- Do not fix symptoms before identifying the root cause.
- Fix at the source-of-truth (owner layer), not where the symptom appears.
- Avoid child-layer compensation (fallbacks, patches, duplicated logic, branching).
- Always do ultra-deep system research end-to-end before fixing:
  - top-down: route → page → container → orchestration → state
  - bottom-up: function → hook → service → API → DB
- Diagnose by layers:
  - data/contracts → business logic → async/timing → UI state → integration → architecture
- If a bug appears in a child, inspect the parent/owner layer first.
- When changing a mechanic, align all directly coupled layers:
  - contracts, handlers, queries, cache, serializers, loading/error states
- **String-based coupling:** When renaming or replacing a function/cron/heartbeat, `grep -rn '"oldName"' convex/ --include="*.ts"` for ALL string references. TypeScript catches broken imports but NOT broken string identifiers (heartbeat names, cron labels, log sources, event keys). Every grep hit must be updated or explicitly justified as dead code.
- Be skeptical of one-file fixes; justify why other layers are unaffected.
- For frontend issues, inspect the full flow:
  - route → layout → page → hooks → API → backend
- Prefer systemic fixes, but keep changes proportional.
- If re-architecture is needed, define scope, safety, and rollout order.
- **Корневая причина = конкретный артефакт.** При диагностике ЗАПРЕЩЕНО останавливаться на правдоподобной гипотезе ("вероятно, ошибка API", "скорее всего, таймаут"). Корневая причина должна указывать на конкретный верифицируемый артефакт: строку кода, запись в логе, git diff, запись в БД. Если артефакт не найден — диагностика не завершена. Чеклист до объявления причины: (1) проверить git diff / git log — код задеплоен? (2) проверить логи (actionLogs, auditLog, console) — есть ли ошибки? (3) проверить состояние в БД — что реально лежит? (4) сопоставить timeline событий. Только после этого — вывод. "Вероятно" = "я не проверил".
- **Сначала масштаб, потом детали.** При диагностике алерта о конкретной сущности (аккаунт, пользователь, правило) — ПЕРВЫМ ДЕЛОМ проверить системную картину: сколько сущностей вообще работает из общего числа? Если sync показывает "28/264 синхронизированы" — проблема системная (timeout, архитектура), а не в одном аккаунте. Порядок: (1) общая статистика (сколько из скольких работает), (2) если проблема массовая — искать системную причину, (3) только если проблема единичная — копать конкретную сущность. Антипаттерн: получить алерт "аккаунт X не синхронизируется 54ч" → полезть в код token recovery → найти баг → объявить его причиной, не проверив что 236 из 264 аккаунтов тоже не синхронизируются.
- **НИКОГДА не подгоняй решение под ожидаемый результат.** Если данные расходятся с ожиданиями (кабинет VK показывает одно, наш отчёт — другое), ЗАПРЕЩЕНО менять источник данных или метрику «чтобы совпало». Вместо этого: (1) написать диагностический скрипт, (2) проверить что реально приходит из API для каждого типа кампании, (3) сравнить с тем, что показывает кабинет VK, (4) найти конкретную причину расхождения (проблема в записи? в чтении? в агрегации?), (5) показать реальные данные пользователю, (6) только после подтверждения причины — вносить исправление. Менять код без диагностики = подгонка, не починка.

## Skills

| File | Trigger |
|---|---|
| `vk-banner.md` | Banner generation: FLUX prompts, visual styles, layouts, text coverage, composite |
| `service-diagnostic.md` | Service monitoring: health checks, user diagnostics, "why isn't X working?" |

When working on banner generation (creating/modifying banners, FLUX prompts, visual styles, text overlay, coverage checks), ALWAYS follow `docs/skills/vk-banner.md` first.

When diagnosing service issues, checking health, or investigating user problems, ALWAYS follow `docs/skills/service-diagnostic.md` first.