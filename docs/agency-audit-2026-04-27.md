# Agency Feature Audit — 2026-04-27

Полный аудит реализации агентств в AdPilot. Проведён анализ всех спеков (Plans 0-6), кода (convex/, src/) и их взаимосвязей.

---

## Общая картина

Реализовано: schema (7 новых таблиц + orgId на 10 существующих), авторизация, двухфазные инвайты, биллинг с agency-тарифами, load units + grace-фазы, UI онбординга/команды, 8 agency-провайдеров, L2/L3 инфраструктура правил.

Главная проблема: **существующие модули (rules, adAccounts, syncMetrics, clientReport, ruleEngine) не интегрированы с accessControl**. Менеджер, приглашённый в организацию, фактически не может работать — не видит кабинеты, не видит правила, не может их редактировать.

---

## P0 — Безопасность и архитектурный баг доступа

### 0. getAccessibleAccountIds — теряет личные кабинеты при вступлении в org

- **Файл:** `convex/accessControl.ts:11-48`
- **Проблема:** Функция работает как switch (либо personal, либо org), а не как union. Как только у user устанавливается `organizationId`, ветка `!user.organizationId` перестаёт срабатывать. Личные кабинеты с `excludeFromOrgTransfer: true` (без `orgId`) становятся **невидимы** — не попадают ни в `by_orgId` (нет orgId), ни в `by_userId` (ветка не достигается).
- **Сценарий (owner):**
  1. У owner-а 5 кабинетов, 2 помечены `excludeFromOrgTransfer: true`
  2. Создаёт org → 3 кабинета получают `orgId`, 2 остаются без
  3. `getAccessibleAccountIds` → ветка owner → `by_orgId` → возвращает 3
  4. 2 личных кабинета **потеряны** для UI, правил, отчётов
- **Сценарий (manager):**
  1. Менеджер имел 2 личных кабинета до вступления в org
  2. Принимает инвайт → `user.organizationId` устанавливается
  3. `getAccessibleAccountIds` → ветка manager → `assignedAccountIds` → только org-кабинеты
  4. Личные кабинеты менеджера **потеряны**
- **Масштаб:** Все модули, использующие `getAccessibleAccountIds`, затронуты: reports.ts, правила, rule engine, clientReport — везде будут недоступны личные кабинеты org-пользователей.
- **Также:** `validateAdPlanIds` (line 94-148) дублирует ту же логику — тот же баг.
- **Исправление:** Возвращать **union** org-кабинетов и личных:
  ```typescript
  // 1. Org accounts (owner: by_orgId, manager: assignedAccountIds)
  const orgAccountIds = membership.role === "owner"
    ? (await ctx.db.query("adAccounts").withIndex("by_orgId", ...).collect()).map(a => a._id)
    : membership.assignedAccountIds;

  // 2. Personal accounts (by_userId, where orgId is undefined)
  const personalAccounts = await ctx.db.query("adAccounts")
    .withIndex("by_userId", q => q.eq("userId", args.userId))
    .collect();
  const personalIds = personalAccounts
    .filter(a => !a.orgId)  // only non-transferred
    .map(a => a._id);

  // 3. Union (deduplicated)
  return [...new Set([...orgAccountIds, ...personalIds])];
  ```
- **Затрагивает:** `accessControl.ts` (getAccessibleAccountIds + validateAdPlanIds). Все потребители автоматически получат правильный набор.

### 1. clientReport.buildReport — нет проверки доступа

- **Файл:** `convex/clientReport.ts:171-430`
- **Проблема:** Любой авторизованный пользователь может вызвать `buildReport(userId, accountId)` с чужим `accountId`. Нет вызова `getAccessibleAccountIds` для валидации.
- **Риск:** Утечка данных — чужая статистика, расходы, лиды.
- **Исправление:** Добавить в начало handler вызов `getAccessibleAccountIds(ctx, args.userId)`, проверить что `args.accountId` входит в результат. Если нет — `throw new Error("Нет доступа к этому кабинету")`.
- **Затрагивает:** Только `clientReport.ts`, без побочных эффектов.

---

## P1 — Менеджеры не могут работать (критический функционал)

### 2. adAccounts.list — менеджеры не видят кабинеты

- **Файл:** `convex/adAccounts.ts:117-127`
- **Проблема:** Запрос `list` фильтрует только по `by_userId` индексу. Менеджер с `assignedAccountIds` не увидит ни одного кабинета (у него другой `userId`).
- **Последствия:** Весь UI завязан на `adAccounts.list` — Dashboard, Rules, Reports, Analytics. Менеджер видит пустой интерфейс.
- **Исправление:** Заменить на логику из `accessControl.getAccessibleAccountIds`:
  - Individual user (no org) -> `by_userId` (текущее поведение)
  - Org owner -> `by_orgId` (все кабинеты организации)
  - Org manager -> fetch by `assignedAccountIds`
- **Проверить:** Все места, которые вызывают `adAccounts.list` на фронтенде, должны продолжать работать.

### 3. adAccounts.connect — не ставит orgId

- **Файл:** `convex/adAccounts.ts:294-305`
- **Проблема:** При подключении кабинета пользователем из организации — `orgId` не записывается в документ. Кабинет остаётся "личным" и невидим для других членов организации через `by_orgId` индекс.
- **Исправление:** При `db.insert("adAccounts", {...})` добавить `orgId: user?.organizationId ?? undefined`. Аналогично в мутации `reconnect`, если она есть.
- **Побочный эффект:** Нужно также обновить `disconnect` — при отключении кабинета из org, нужно решить: удалять `orgId` или нет.

### 4. rules.list — менеджеры не видят правила организации

- **Файл:** `convex/rules.ts:179-189`
- **Проблема:** Загрузка по `by_userId`. Менеджер с разрешением `rules` не видит правила, созданные другими членами организации.
- **Исправление:** Для org-users загружать правила по `by_orgId_active` индексу (уже существует в schema). Для individual users — оставить `by_userId`.
- **Нюанс:** Менеджер должен видеть только правила для своих `assignedAccountIds`. Фильтровать на клиенте или в запросе по `targetAccountIds ∩ assignedAccountIds`.

### 5. rules.update / toggleActive / remove — нет checkOrgWritable + нет прав менеджера

- **Файл:** `convex/rules.ts`
- **Проблема (A):** `update` (line 517), `toggleActive` (line 760), `remove` (line 834) — не вызывают `checkOrgWritable`. В замороженной/read-only организации эти мутации обходят grace-блокировку.
- **Проблема (B):** Проверка владения `rule.userId !== args.userId` блокирует менеджеров. Менеджер с разрешением `rules` не может редактировать правила org-аккаунтов.
- **Исправление (A):** Добавить `checkOrgWritable(ctx, args.userId)` в начало каждой мутации (по аналогии с `create`, line 256).
- **Исправление (B):** Заменить `rule.userId !== args.userId` на:
  ```
  if (rule.orgId) {
    // Org rule — check membership + "rules" permission
    const hasAccess = await hasPermission(ctx, args.userId, rule.orgId, "rules");
    if (!hasAccess) throw new Error("Нет прав на это правило");
  } else {
    // Personal rule — original ownership check
    if (rule.userId !== args.userId) throw new Error("...");
  }
  ```

### 6. Tier limits — проверяются по личной подписке, не по org

- **Файл:** `convex/rules.ts:788-793` (в `toggleActive`)
- **Проблема:** `toggleActive` проверяет `user.subscriptionTier` для лимита правил. У менеджера это `freemium` → лимит 3 правила. Вместо этого для org-users нужно проверять org.subscriptionTier (все agency тарифы имеют `rulesLimit: -1`, т.е. unlimited).
- **Также:** `create` mutation (line 384) — аналогичная проверка `TIER_RULE_LIMITS[user.subscriptionTier]`.
- **Исправление:** Если `user.organizationId` → загрузить org → использовать `org.subscriptionTier` для определения лимитов.

---

## P2 — Целостность данных и логика

### 7. Conflict validation — scope по userId, не по orgId

- **Файл:** `convex/rules.ts:61-176`
- **Проблема:** `validateRotationConflicts` (line 61-92) и `validateNoConflictingRules` (line 95-176) ищут конфликты по `by_userId` индексу. Два менеджера одной организации могут создать конфликтующие правила для одного и того же аккаунта (например, два video_rotation на один кабинет).
- **Исправление:** Для org-users конфликты нужно искать по `orgId`:
  ```
  // Если user в org — ищем конфликты среди всех правил организации
  ctx.db.query("rules").withIndex("by_orgId_active", q => q.eq("orgId", user.organizationId))
  ```
  Для individual users — оставить `by_userId`.

### 8. Rule engine — загрузка правил по userId, не по account/org

- **Файл:** `convex/ruleEngine.ts:1599-1618`
- **Проблема:** `checkRulesForAccount` вызывает `listActiveRules(userId)` и фильтрует по `targetAccountIds`. Если правило создал менеджер А (userId_A), а кабинет назначен менеджеру Б — правило может не попасть в обработку, т.к. привязано к userId_A.
- **Более глубокая проблема:** `checkAllRules` (line 2122) итерирует accounts через `listActiveAccounts`, потом для каждого аккаунта ищет правила по `account.userId`. Для org-аккаунтов `account.userId` — это user который подключил кабинет, а правила могли создать другие менеджеры.
- **Исправление:** Для org-аккаунтов (`account.orgId !== undefined`) загружать правила по `by_orgId_active` индексу и фильтровать по `targetAccountIds`. Для personal accounts — оставить `by_userId`.

### 9. Rule engine — нет проверки grace/load в checkRulesForAccount

- **Файл:** `convex/ruleEngine.ts:1599`
- **Проблема:** Правила продолжают работать (останавливать рекламу, слать уведомления) даже когда организация в фазе `read_only` / `frozen`. `checkOrgWritable` не вызывается перед выполнением action (остановка рекламы).
- **Исправление:** В начале `checkRulesForAccount`:
  ```
  if (account.orgId) {
    const org = await ctx.runQuery(internal.loadUnits.getOrgById, { orgId: account.orgId });
    if (org?.expiredGracePhase === "read_only" || org?.expiredGracePhase === "frozen") {
      return; // skip rule execution for frozen orgs
    }
  }
  ```

### 10. deleteUser cascade — пропущена таблица agencyRequests

- **Файл:** `convex/users.ts:587-821`
- **Проблема:** Каскадное удаление покрывает orgMembers, organizations, orgInvites, loadUnitsHistory, agencyCredentials. Но `agencyRequests` (XL-заявки) — нет каскада. Удаление owner-а оставит orphaned записи.
- **Исправление:** В блоке удаления owned orgs (line 781-814) добавить:
  ```
  const agencyRequests = await ctx.db.query("agencyRequests")
    .withIndex("by_orgId", q => q.eq("orgId", org._id)).collect();
  for (const req of agencyRequests) await ctx.db.delete(req._id);
  ```
- **Также:** Проверить, есть ли индекс `by_orgId` на `agencyRequests`. Если нет — добавить в schema.

### 11. adAccounts.disconnect — owner org не может отключить кабинет менеджера

- **Файл:** `convex/adAccounts.ts:341-410`
- **Проблема:** `account.userId !== args.userId` — только user, который подключил кабинет, может его отключить. Owner организации не может отключить кабинет, подключённый менеджером.
- **Исправление:** Добавить проверку: если `account.orgId` и caller является owner этой org — разрешить disconnect.

---

## P3 — Документация и расхождения

### 12. Спеки устарели — pricing/load units не совпадают с кодом

Код обновлён коммитом `1331c7c fix(agency): align niches, tiers and pricing with spec`. Планы содержат старые значения:

| Tier | План (Plan 3 / Spec) | Код (billing.ts) |
|---|---|---|
| agency_s | 14,900 RUB / 60 LU / 3 niches / 6 cabinets / 1 manager | 14,900 RUB / 30 LU / unlimited accounts |
| agency_m | 24,900 RUB / 120 LU / 6 niches / 12 cabinets / 3 managers | 24,900 RUB / 60 LU / unlimited accounts |
| agency_l | 49,900 RUB / 300 LU / all niches / unlimited / 10 managers | 39,900 RUB / 120 LU / unlimited accounts |
| agency_xl | 99,900 RUB / 600 LU / 20 managers | 0 RUB (индивидуальная цена) / 200 LU |

**ИСПРАВЛЕНО (2026-04-27):**
- `maxManagers` и `maxNiches` добавлены в `TIERS` (billing.ts): agency_s=3/3, agency_m=10/6, agency_l=30/∞, agency_xl=∞/∞
- Enforcement в `inviteManager` (organizations.ts): подсчёт active managers + pending invites vs maxManagers
- Plan 3 billing doc обновлён с актуальными значениями из кода

### 13. L3 custom rules — только template handler

- **Файл:** `convex/customRules.ts`
- **Состояние:** Инфраструктура L3 полностью готова (dispatch в ruleEngine, schema `customRuleTypes`, handler interface). Но единственный зарегистрированный handler — `custom_roi` — помечен как TEMPLATE и не предназначен для production.
- **Действие:** Не блокирует запуск. Реальные L3 handlers добавляются по запросу агентств (Agency L+).

### 14. Manager limits и niche limits — не enforce-ятся

- **Проблема:** Спеки описывают лимиты менеджеров (agency_s: 1, agency_m: 3, agency_l: 10, agency_xl: 20), но в коде `organizations.inviteManager` нет проверки на количество активных менеджеров.
- **Также:** Niche limits (agency_s: 3, agency_m: 6) — нет enforce-а при создании правил или кабинетов для конкретной ниши.
- **Действие:** Добавить check в `inviteManager`: подсчёт активных `orgMembers` с `role: "manager"` и сравнение с лимитом тарифа. Для niches — определить где именно enforce-ить (при создании правила? при подключении кабинета?).

---

## P4 — Менее критичные проблемы

### 15. syncMetrics.listActiveAccounts — глобальный collect без фильтрации

- **Файл:** `convex/syncMetrics.ts:638-658`
- **Проблема:** `listActiveAccounts` делает `ctx.db.query("adAccounts").collect()` — загружает ВСЕ аккаунты из базы. Для текущего масштаба это работает (264 аккаунта), но с агентствами количество может вырасти на порядок.
- **Не является багом сейчас:** Sync правильно синхронизирует все active/error аккаунты, включая org-аккаунты. Проблема в масштабируемости, не в логике.
- **Действие (позже):** При 1000+ аккаунтах — разбить на батчи или использовать pagination.

### 16. Нет UI для load units status / grace warnings

- **Проблема:** Backend (`loadUnits.getCurrentLoadStatus`) возвращает текущий статус нагрузки, но на фронтенде нет компонента, который бы отображал: текущая нагрузка, лимит, фаза grace, дата замораживания.
- **Запланировано:** Plan 6 описывает `OrgDashboardPage`, `LoadUtilizationBadge`, `GracePhaseWarning` — но они не реализованы.
- **Действие:** Реализовать в рамках Plan 6.

### 17. Нет email-уведомлений для org lifecycle

- **Проблема:** Инвайты, overage-алерты, grace warnings — все завязаны на Telegram. Если у owner-а нет Telegram — уведомления потеряны.
- **Запланировано:** Plan 6 описывает email-уведомления для org events.
- **Действие:** Реализовать email fallback для критических org events (invite, overage, grace phase change).

---

## Что работает корректно

| Компонент | Файл(ы) | Статус |
|---|---|---|
| Schema (7 таблиц + orgId на 10) | `convex/schema.ts` | Полностью |
| Access control logic | `convex/accessControl.ts` | Полностью |
| Org CRUD + invite flow | `convex/organizations.ts`, `convex/orgAuth.ts` | Полностью |
| Load units + grace phases | `convex/loadUnits.ts` | Полностью |
| Agency billing + webhook | `convex/billing.ts` | Полностью |
| Crons (6 agency-related) | `convex/crons.ts` | Полностью |
| Agency providers (8 шт) | `convex/agencyProviders.ts` | Полностью |
| deleteUser cascade | `convex/users.ts` | 95% (missing agencyRequests) |
| reports.ts (fetchReport) | `convex/reports.ts` | Полностью (единственный с accessControl) |
| L2 rules (array conditions) | `convex/ruleEngine.ts` | Полностью |
| L3 infra (dispatch + handlers) | `convex/customRules.ts` | Инфра готова, handlers — templates |
| UI: TeamPage | `src/pages/TeamPage.tsx` | Полностью |
| UI: AgencyOnboardingPage | `src/pages/AgencyOnboardingPage.tsx` | Полностью |
| UI: InviteAcceptPage | `src/pages/InviteAcceptPage.tsx` | Полностью |
| UI: Layout navigation | `src/components/Layout.tsx` | "Команда" для org-users |
| Hooks: useOrganization, usePermissions | `src/lib/` | Полностью |
| Tests: org auth, access, load, grace | `tests/` | Полностью |

---

## Порядок исправлений

```
Phase 0 — Архитектурный фикс доступа (всё остальное зависит от этого)
  #0  getAccessibleAccountIds — union personal+org       [P0, 1h]
      Также: validateAdPlanIds — аналогичный фикс

Phase 1 — Security + Manager basics (блокирует запуск) ✅ DONE
  #1  clientReport.buildReport — access control          [P0] ✅ already had checks
  #2  adAccounts.list — getAccessibleAccountIds          [P1] ✅ union logic
  #3  adAccounts.connect — set orgId                     [P1] ✅
  #4  rules.list — org-aware query                       [P1] ✅
  #5  rules update/toggle/remove — checkOrgWritable      [P1] ✅ checkRuleAccess
  #6  tier limits — org tier for org-users               [P1] ✅ getEffectiveTier

Phase 2 — Data integrity (блокирует корректную работу правил) ✅ DONE
  #7  conflict validation — orgId scope                  [P2] ✅
  #8  rule engine — load rules by account/org            [P2] ✅
  #9  rule engine — grace check before execution         [P2] ✅
  #10 deleteUser — agencyRequests cascade                [P2] ✅
  #11 adAccounts.disconnect — owner access               [P2] ✅

Phase 3 — Limits + docs ✅ DONE
  #12 update plan docs with real pricing                 [P3] ✅ plan-3-billing.md aligned
  #14 manager limits + niche limits enforce              [P3] ✅ maxManagers/maxNiches in TIERS + inviteManager check

Phase 4 — UI + notifications (Plan 6)
  #16 OrgDashboardPage + LoadUtilizationBadge            [P4]
  #17 Email notifications for org lifecycle              [P4]
```

---

## Тестовый чеклист после исправлений

- [ ] Owner org видит org-кабинеты + личные (excludeFromOrgTransfer) одновременно
- [ ] Manager видит assignedAccountIds + свои личные кабинеты (до вступления в org) одновременно
- [ ] Менеджер видит назначенные ему кабинеты на Dashboard
- [ ] Менеджер видит правила организации для своих кабинетов
- [ ] Менеджер может создать/редактировать/удалить правило для назначенного кабинета
- [ ] Менеджер НЕ может видеть кабинеты/правила вне своих assignedAccountIds
- [ ] Owner видит ВСЕ кабинеты и правила организации
- [ ] В замороженной org нельзя update/toggle/remove правила
- [ ] Два менеджера не могут создать конфликтующие rotation rules на один аккаунт
- [ ] Rule engine выполняет правила org-аккаунтов независимо от того, кто создал правило
- [ ] Rule engine НЕ выполняет правила для frozen org
- [ ] clientReport.buildReport возвращает ошибку для чужого accountId
- [ ] deleteUser owner-а удаляет agencyRequests
- [ ] Owner org может disconnect кабинет, подключённый менеджером
- [ ] Менеджер с freemium не ограничен лимитом 3 правила (используется org tier)
