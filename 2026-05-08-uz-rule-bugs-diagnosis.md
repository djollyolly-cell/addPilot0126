# Диагностика жалоб клиентов на правило УЗ — 2026-05-08

> **Generated at:** 2026-05-08 ~17:30 МСК (UTC+3) · **Data captured at:** того же окна. Все «сегодня/сейчас» в тексте — относительно этой отметки.

## Контекст

Жалобы от клиентов сегодня:
1. **Pavel Krabov:** «6 РК отмечено в правиле, на 4 работает, на 2 нет; они называются одинаково».
2. **Алёна Соколова (аккаунт «Прутовых»):** «Вчера отключала баннеры вручную, оставила несколько штук. Сегодня все 58 включены. Уже исправила вручную».
3. **Алёна Соколова (Прутовых, «Универсалка 3»):** «Сегодня не сбросился бюджет в 00:00».

Принцип диагностики: реальные данные из БД и VK API + код, без предположений.

## Сводка приоритетов

| # | Жалоба | Тип | Системность | Приоритет |
|---|---|---|---|---|
| 3 | Reset бюджета в 00:00 не работает | Регрессия (cron disabled) | Затрагивает все правила с `resetDaily=true` (см. reconciliation ниже) | 🔴 CRITICAL |
| 2 | Ручные паузы баннеров откатываются | Архитектурный баг | Затрагивает любого, кто ставит UZ-правило с user-paused баннерами | 🔴 HIGH |
| 1 | Pavel «4 работает 2 нет» | Восприятие | — | 🟢 NOT-A-BUG |

### Reconciliation чисел UZ-правил

В разных скриптах за разные моменты времени числа дрейфуют (правила создаются/деактивируются клиентами в фоне). Снимки:

| Метрика | Значение | Источник |
|---|---|---|
| Active UZ rules total (`isActive=true`) | **114** | check-uz-bug10.cjs (последний прогон) |
| Active UZ rules (предыдущий прогон) | 115 | check-uz-bug.cjs / check-uz-bug9.cjs (на ~30 мин раньше) |
| Rules с историческим budget_reset логом за всё время | **93** | check-uz-bug10.cjs |
| Rules с budget_reset сегодня (UTC) | **0** | check-uz-bug9.cjs |
| Алёна — UZ-правил | 9 | check-uz-bug2.cjs |
| Алёна — кампаний под этими правилами | 60 | check-uz-bug11.cjs |
| Pavel — UZ-правил | 5 | check-uz-bug2.cjs |
| Emergency reset target count (правила с `resetDaily=true`) | **≈93** (по числу когда-либо ресетившихся) или **114** (все active UZ) — зависит от стратегии | — |

«93» — это историческое наблюдение количества правил, у которых reset _когда-то_ происходил. Сейчас активных правил `resetDaily=true` точно может быть больше — мы не выгружали явно `conditions.resetDaily` для всех 114. Перед emergency-прогоном надо отдельно посчитать `WHERE type=uz_budget_manage AND isActive AND conditions.resetDaily=true`.

---

## 🟢 Pavel Krabov — БАГА НЕТ (ошибочное восприятие)

### Идентификаторы
- userId: `kx7d88ythjctg7nkxj0eh5ssx584p12s`
- accountId: `j97a1nkp3ta6p16a1hp7qm95gd857hgw` (Туркиш В)
- ruleId: `kd78x27728wx41gr6ya5d9r9a985dtjs` (Туркиш В)
- targetAdPlanIds: `20583021, 20583123, 20583141, 20583260, 20583289, 20583368` (6 шт)
- targetCampaignIds: 303
- conditions: `initialBudget=100, step=100, resetDaily=true`

### Реальные данные (VK API + actionLogs за 2026-05-08)

| ad_plan_id | name | groups | status | avg бюджет (init=100) | fired сегодня |
|---|---|---|---|---|---|
| 20583021 | 0505 47040708 КРЭМ олива… Крео 1 | 51/51 | active | 182 | 26 |
| 20583123 | 0505 47040708 КРЭМ олива… Крео 1 | 51/51 | active | **135** | 14 |
| 20583141 | 0505 47040708 КРЭМ олива… Крео 1 | 51/51 | active | 169 | 22 |
| 20583260 | 0505 Ш зеленый восст… крео 2 | 50/50 | active | 210 | 37 |
| 20583289 | 0505 Ш зеленый восст… крео 2 | 50/50 | active | 214 | 37 |
| 20583368 | 0505 Ш зеленый восст… крео 2 | 50/50 | active | 227 | 38 |

Всего за 2026-05-08:
- **202 успешных** `budget_increased` action logs
- **0 failed** logs
- 174 distinct campaign IDs хотя бы один раз превысили порог
- Все 303 `targetCampaignIds` присутствуют в VK live data
- Все 6 ad_plans активны, у всех средний бюджет вырос с initial=100

### Вывод

У всех 6 ad_plans бюджет растёт. Восприятие «работает только на 4» ошибочно: у двух ad_plans с меньшим расходом (avg 135 и 169) реже срабатывает порог `spent ≥ limit - step`, поэтому визуально кажется, что бюджет «не двигается». Это not-a-bug.

**Рекомендация клиенту:** показать график `budget_limit_day` по этим ad_plans за сутки — видно непрерывный рост.

---

## 🔴 Алёна Соколова (Прутовых) — РЕАЛЬНЫЙ АРХИТЕКТУРНЫЙ БАГ

### Идентификаторы
- userId: `kx76ap50x0j4dm6ayrcm5skeh984dyzd`
- accountId: `j974xsvtjy0rs0qbpyh7ak4s9n84edsb` (Прутовых)
- ad_plan: `19913847`, 39 ad_groups
- Правила:
  - `kd75cgv5ksma3dq7z07828t6rs86959r` — «Ижевск уз 3 ключи 07.05» (8 групп, init=251, step=50, max=450, resetDaily=true)
  - `kd7e4w3rzs8t295fyrx34953s18686we` — «Ижевск интересы уз 3 07.05» (3 группы, init=151, step=50, max=400, resetDaily=true)
- Создано: 2026-05-07 11:16:58Z и 11:17:30Z (вчера)
- Обновлено: =created (правила не редактировались после создания)

### actionLogs за 2026-05-07
- Правило 1: 6 budget_increased на 6 distinct campaigns, окно 11:30:27Z – 19:00:26Z
- Правило 2: 3 budget_increased на 3 distinct campaigns, окно 11:30:29Z – 11:30:30Z
- Сегодня (2026-05-08): 0 logs на оба правила

### Root cause — конкретные артефакты в коде

#### 1. `resumeCampaign` массово активирует все blocked баннеры
[convex/vkApi.ts:1922-1982](convex/vkApi.ts#L1922-L1982):

```typescript
const blocked = (bannersData.items || []).filter(b => b.status === "blocked");
if (blocked.length > 0) {
  for (const b of blocked) {
    if (excludeSet.has(String(b.id))) {
      skippedByRule++;
      continue;
    }
    // POST banner status:active
    await fetch(`${MT_API_BASE}/api/v2/banners/${b.id}.json`, {
      method: "POST",
      body: JSON.stringify({ status: "active" }),
    });
  }
}
```

#### 2. `getStoppedBannerIdsForAccount` знает ТОЛЬКО про правила-стопы
[convex/ruleEngine.ts:2527-2557](convex/ruleEngine.ts#L2527-L2557):

```typescript
.filter((q) =>
  q.and(
    q.gte(q.field("createdAt"), todayStart),
    q.or(
      q.eq(q.field("actionType"), "stopped"),
      q.eq(q.field("actionType"), "stopped_and_notified")
    )
  )
)
```

`actionLogs` пишутся только когда **наши правила** что-то останавливают. **Ручные паузы пользователя в кабинете VK тут не отслеживаются** — соответственно их ID не попадают в `excludeBannerIds`.

#### 3. Триггер resumeCampaign после budget_increase
[convex/ruleEngine.ts:2822-2837](convex/ruleEngine.ts#L2822-L2837) и [3097-3104](convex/ruleEngine.ts#L3097-L3104):

```typescript
if (campaign.status !== "active" || campaign.delivery === "not_delivering") {
  const stoppedBannerIds = await ctx.runQuery(
    internal.ruleEngine.getStoppedBannerIdsForAccount,
    { accountId },
  );
  await ctx.runAction(internal.vkApi.resumeCampaign, {
    accessToken,
    campaignId: campaign.id,
    excludeBannerIds: stoppedBannerIds,  // только rule-stopped, НЕ user-paused
  });
}
```

### Цепочка бага у Алёны

1. Алёна вручную ставит на паузу часть баннеров в группах ad_plan 19913847 (status=blocked).
2. 2026-05-07 11:16-11:17Z создаёт два UZ-правила. `initializeUzBudgets` ставит `budget_limit_day` = `initialBudget` всем целевым группам.
3. У части групп `delivery="not_delivering"` (был исчерпан старый дневной лимит, VK каскадно блокирует баннеры).
4. Активный cron `uz-budget-increase` → `internal.ruleEngine.uzBudgetDispatchV2` (зарегистрирован в [convex/crons.ts:127-131](convex/crons.ts#L127-L131), интервал 45 мин) (≈11:30Z) запускает V2 worker. Worker видит активную группу с `delivery=not_delivering`, увеличивает бюджет, попадает в ветку «после успешного `setCampaignBudget` → если `status !== "active"` или `delivery === "not_delivering"` → `resumeCampaign`» (см. V2 resume-блоки в [convex/ruleEngine.ts](convex/ruleEngine.ts), там же где вызывается `getStoppedBannerIdsForAccount`). Legacy `checkUzBudgetRules` / `uzBudgetDispatch` (V1) сейчас НЕ зарегистрирован cron'ом, остаётся в коде только для обратной совместимости старых scheduled jobs.
5. `resumeCampaign` берёт пустой `excludeBannerIds` (правила ещё ничего не останавливали сегодня) и активирует ВСЕ blocked баннеры в группе, включая user-paused.
6. Клиент утром обнаруживает, что её ручные паузы откатились.

### Состыковка с симптомом «58 баннеров»

`ad_plan 19913847` содержит 39 ad_groups; в каждой группе несколько баннеров. На 6 групп, попавших в первое срабатывание правила yesterday 11:30, могло прийтись ~58 blocked-баннеров суммарно. Точное число невозможно реконструировать — ручные ID-снапшоты VK не сохраняем.

---

## Варианты фикса (нужно решение)

### A. Минимальный — убрать массовое включение баннеров из resumeCampaign

Оставить только `setCampaignBudget` + `POST status:active` на сам ad_group. Никакого банера-iter.

- ✅ Простой однострочник
- ❌ При VK-каскадной блокировке баннеров (когда у нас закончился бюджет → VK блокирует всё внутри) после restore группа останется без выдачи, придётся включать баннеры вручную

### B. Snapshot-восстановление — корректное, требует новой таблицы

**Корректный момент снапшота — НЕ при первом увеличении бюджета blocked-кампании** (к этому моменту VK уже мог cascade-block'нуть все баннеры, snapshot был бы пустым/ложным). Снапшот должен делаться **до того как кампания может попасть в blocked**:

- При создании UZ-правила (`rules.create` → после `initializeUzBudgets`).
- При update UZ-правила, если меняются target campaigns / accounts / initialBudget (та же точка где сейчас вызывается `initializeUzBudgets` из [src/pages/RulesPage.tsx:457](src/pages/RulesPage.tsx#L457)).
- При активации правила (`toggleActive` → если `isActive=true`).
- Опционально: периодическое обновление snapshot, пока кампания active+delivering, чтобы захватить новые баннеры, которые юзер добавил уже после создания правила.

Companion-таблица `bannerActiveSnapshot { ruleId, accountId, campaignId, bannerIds[], snapshotAt }`. При resume — активировать только IDs из snapshot.

**Fail-closed правило:** если snapshot отсутствует (правило старое, миграции не было) — `resumeCampaign` не трогает баннеры вообще, чтобы случайно не перепаковать user-paused. Параллельно — у пользователя в UI кнопка «Обновить snapshot» / периодический job.

- ✅ Никогда не трогаем user-paused
- ✅ Не зависит от полей VK API
- ✅ Fail-closed безопаснее, чем эвристики
- ❌ Новая таблица, companion-sync во всех мутациях правил (create/update/toggle/delete) — см. CLAUDE.md «Stateful companion sync»
- ❌ Миграция: для существующих правил snapshot отсутствует → или дозабор после деплоя, или fail-closed (баннеры не активируем до первого ручного snapshot)

### C. Гибрид по `last_updated` баннера

В `resumeCampaign` запрашивать `last_updated` (или аналог) для blocked-баннеров. Если баннер паузнут **позже** последнего нашего касания группы (или позже cascade-block по бюджету) — это user pause, пропускаем.

- ✅ Без новой таблицы
- ❌ Эвристика. Зависит от того, что VK реально отдаёт `last_updated` и что наше «последнее касание» можно определить точно
- ❌ Если VK не отдаёт нужное поле, фикс не сработает

### Рекомендация

**Вариант B**. Дороже A в реализации, но единственный без риска оставить ad_group без баннеров и без эвристик. Прод-данные (39 групп × N баннеров) подтверждают: сценарий cascade-block частый, фикс A может сильно ухудшить продукт.

---

## Что нужно решить (по багу #2)

1. Какой из вариантов фикса (A / B / C)?
2. Согласовать с продуктом сценарий «UZ-правило никогда не активирует баннеры, заблокированные пользователем» как явный contract.
3. Уведомить Алёну Соколову (telegramChatId 637451266), что баг подтверждён и фикс в работе.
4. По Pavel Krabov — ничего не правим, написать пояснение что все 6 ad_plans работают (показать табличку выше).

---

## 🔴 БАГ #3 — Reset бюджета в 00:00 не работает (CRITICAL, system-wide)

### Жалоба

Алёна Соколова: «сегодня не сбросился бюджет в 00:00» (правило на аккаунте Прутовых, кампания «Универсалка 3»). При этом она прямо сейчас обновляла правила вручную.

### Реальные данные

| Проверка | Результат |
|---|---|
| Heartbeat `resetBudgets` в cronHeartbeats | **отсутствует** (cron не пишет heartbeat — см. ниже) |
| `budget_reset` логов на 9 правил Алёны за всё время | **0** (правила созданы 2026-05-07, после drain) |
| `budget_reset` логов на ВСЕ 114 активных UZ-правил сегодня (UTC) | **0** |
| `budget_reset` логов в системе ДО drain (< 2026-05-05 02:21 UTC) | **5037** ✅ — cron работал |
| `budget_reset` логов в системе ПОСЛЕ drain | **0** ❌ — cron мёртв |
| Earliest reset log в выборке top-200/rule | 2026-04-04 21:07 UTC |
| **Latest reset log** | **2026-05-04 21:39:30 UTC = 2026-05-05 00:39 МСК** |
| Rules с ≥1 reset log за всё время | 93 из 114 (~82%) |
| `uzBudgetDispatchV2` heartbeat | live, completed 2026-05-08T04:42:10Z (29 мин назад) |
| `tokenRefreshDispatch` heartbeat | live, completed 2026-05-08T05:09:36Z (2 мин назад) |

Other crons (sync, increase, token refresh, payments-cleanup, log-cleanup, invites-cleanup) работают. Только `resetBudgets` мёртв.

**Оговорка про heartbeat:** `convex/uzBudgetCron.ts:resetBudgets` НЕ пишет `cronHeartbeats` (нет вызова `upsertCronHeartbeat`). Поэтому отсутствие heartbeat-записи само по себе ничего не доказывает. Доказательство «cron мёртв» — это **5037 reset-логов до drain → 0 после**.

### Текущее состояние правил Алёны (на «Прутовых»)

| Правило | init | max | last log | last action | бюджет на сегодня |
|---|---|---|---|---|---|
| Ижевск уз 3 ключи 07.05 | 251 | 450 | 2026-05-07 19:00:26Z | 251→301 | 301 (НЕ сброшен) |
| Ижевск интересы уз 3 07.05 | 151 | 400 | 2026-05-07 11:30:30Z | 201→251 | 251 (НЕ сброшен) |

То же — на её 7 других правилах в других аккаунтах. Везде last log за 2026-05-07, today=0.

### Root cause — конкретный артефакт

[convex/crons.ts:142-147](convex/crons.ts#L142-L147):

```javascript
// // UZ budget reset — every 30 min, checks user timezone for midnight reset
// crons.interval(
//   "uz-budget-reset",
//   { minutes: 30 },
//   internal.uzBudgetCron.resetBudgets
// );
```

**Cron `uz-budget-reset` закомменчен.**

### Timeline регрессии (по git и логам)

| Дата (UTC) | Commit | Событие |
|---|---|---|
| 2026-04-02 06:34 | `dc7966e` "fix: enable uz_budget_manage cron + sync integration" | Cron `uz-budget-reset` **впервые включили** (раскомментили registration в crons.ts) |
| 2026-04-04 21:07 | — | Первый `budget_reset` лог в системе |
| 2026-04-02 → 2026-05-04 | — | Cron работал ~33 дня; **5037 успешных budget_reset логов** на 93 правилах |
| **2026-05-04 21:39:30** | — | **Последний успешный budget_reset лог** |
| **2026-05-05 02:21:48** | `f452348` "emergency: drain-mode no-op handlers for scheduled jobs queue" | **Все кроны выключены** — backend крашился из-за 268k+ pending в `_scheduled_jobs` |
| 2026-05-05 → 2026-05-08 | `7aa2170` (Phase 1), `02bcfbb` (Phase 2 V2), `b0258fc` (Phase 6b sync), `a52a2a3` (uz-increase V2), и др. | Поэтапно восстановлены: sync-metrics, uz-budget-**increase**, token-refresh, cleanup-stuck-payments, cleanup-old-logs, cleanup-expired-invites |
| 2026-05-08 (сейчас) | — | `uz-budget-reset` НЕ восстановлен. Жалоба Алёны. |

**Итого:**
- **Cron работал** с 2026-04-02 по 2026-05-05 02:21 UTC (~33 дня) — это факт по 5037 logs.
- **Cron мёртв** с 2026-05-05 02:21 UTC по сейчас = **3 дня 4 часа** (~3 пропущенных ночных окна 00:00 МСК: ночи 5/6, 6/7, 7/8 мая).
- В восстановленном списке отсутствует ТОЛЬКО `uz-budget-reset`. Все остальные критичные кроны восстановлены. Это явный пропуск, не сознательный отказ.

### Последствия для пользователей

- Все активные UZ-правила с `resetDaily=true` не сбрасывают бюджет (точное число требует свежего подсчёта `WHERE type=uz_budget_manage AND isActive AND conditions.resetDaily=true`; см. reconciliation выше — historical reset set ≈93 на 114 active UZ).
- Бюджет каждый день остаётся накопленным до уровня вчерашнего срабатывания (часто упирается в `maxDailyBudget`).
- Поскольку VK сам обнуляет дневной spent в 00:00 UTC, кампании могут потратить ВЕСЬ накопленный бюджет (например, у Алёны лимит `301₽` вместо запланированных `251₽` → перерасход 50₽/день/группа × 8 групп = ~400₽/день; на других её правилах счёт может быть выше).
- Клиенты не видят сброс в кабинете и не получают Telegram-уведомление о ресете (notifyOnKeyEvents handler в `resetBudgets`).

### Связь с ручным обновлением Алёны сейчас

Если Алёна меняла `initialBudget` в правиле — frontend [src/pages/RulesPage.tsx:457](src/pages/RulesPage.tsx#L457) триггерит `initializeUzBudgets`, который проставляет `setCampaignBudget(initialBudget)` на все целевые кампании. Это даёт частичный эффект сброса (бюджет в VK становится init), но:
- НЕ записывает `budget_reset` лог (только `setCampaignBudget` через VK API)
- На завтрашнее 00:00 не подействует — крон всё равно мёртв
- `initializeUzBudgets` сам по себе НЕ вызывает `resumeCampaign`. Риск отката user-paused (баг #2) возникает не здесь, а на следующем тике `uzBudgetDispatchV2` — если после переустановки бюджета группа осталась `delivery=not_delivering`, V2 worker зайдёт в resume-ветку и активирует blocked-баннеры по тому же сценарию.

### Фикс (одна строка, не применяю до подтверждения)

Раскомментить [convex/crons.ts:142-147](convex/crons.ts#L142-L147):

```javascript
crons.interval(
  "uz-budget-reset",
  { minutes: 30 },
  internal.uzBudgetCron.resetBudgets
);
```

#### Доказательство что фикс работает (после деплоя)

`resetBudgets` НЕ пишет cronHeartbeat (нет вызова `upsertCronHeartbeat` в [convex/uzBudgetCron.ts:29-220](convex/uzBudgetCron.ts#L29-L220)). Поэтому проверять через heartbeat — **нельзя без отдельного code patch**. Доказательства, доступные сейчас:

1. **Convex `_scheduled_functions`:** через дашборд / admin REST API можно увидеть successful invocation `internal.uzBudgetCron.resetBudgets` каждые 30 мин.
2. **`actionLogs` в окне 00:00:** на 2026-05-09 00:00 МСК и далее должны появиться записи `actionType="budget_reset"` для правил с `resetDaily=true`. Сейчас (после drain) их 0.
3. (Опционально, отдельным PR) — добавить `upsertCronHeartbeat({ name: "resetBudgets", status })` в начало/конец `resetBudgets`, тогда healthCheck.checkCronHeartbeats сможет ловить просрочку.

#### Emergency прогонка (если не хотим ждать timezone-окна)

`emergencyBudgetReset` — **public action** (не internal): [convex/uzBudgetCron.ts:271](convex/uzBudgetCron.ts#L271) объявлено как `action({...})`. Конвенция Convex pаth: `uzBudgetCron:emergencyBudgetReset`.

Принимает `ruleIndex: number`, обрабатывает 1 правило за индекс и возвращает `{ done: boolean, ruleIndex, totalRules, ... }`. Для прогона по всем правилам — итерировать индексы пока `response.done === true`:

```bash
# Псевдокод вызова через Convex REST (Authorization: Convex <admin-key>)
i=0
while true; do
  resp=$(curl ... -d "{\"path\":\"uzBudgetCron:emergencyBudgetReset\",\"args\":{\"ruleIndex\":$i}}")
  done=$(echo "$resp" | jq -r '.value.done')
  [ "$done" = "true" ] && break
  i=$((i+1))
done
```

Не хардкодить «0..114» — фактическое количество правил с `resetDaily=true` action знает сам и вернёт `done=true` когда индекс выйдет за границы.

### Что нужно решить (по багу #3)

1. Раскомментить cron — фикс однострочный, применять?
2. Делать ли emergency прогонку сейчас (`uzBudgetCron:emergencyBudgetReset`, итерировать `ruleIndex` пока `done=true`) или ждать timezone-окна каждого пользователя? Точное число затронутых правил берёт сам action — не хардкодить.
3. Уведомить ли затронутых клиентов о возможном перерасходе за период регрессии (4+ дня)?
4. Health check на reset:
   - вариант (a) — добавить алерт по записям в `_scheduled_functions` (отсутствие successful invocation `uzBudgetCron:resetBudgets` > 1ч в окно когда у активных пользователей наступает 00:00) и/или по `actionLogs` (отсутствие новых `actionType="budget_reset"` в окне 00:00–06:00 МСК);
   - вариант (b) — отдельным code patch добавить `upsertCronHeartbeat` в `resetBudgets` и только потом включать heartbeat-based check в `healthCheck.ts`.

---

## Анализ влияния если включить cron сейчас (без других фиксов)

### Что cron делает технически

[`convex/uzBudgetCron.ts:resetBudgets`](convex/uzBudgetCron.ts) на каждый 30-мин тик:
1. `getActiveUzRules` — 1 query (~114 правил на момент диагностики, см. reconciliation).
2. Per rule с `resetDaily=true` (точное число — до fresh count; historical reset set ≈93): `getUserTimezone` → проверка hour в TZ юзера.
3. **Если `hour !== 0` → `continue`.** Никаких VK API, никаких write.

### Сценарии нагрузки

| Окно | Частота | Read Q | VK API | Write | Риск backend |
|---|---|---|---|---|---|
| `hour !== 0` (~99% времени) | каждые 30 мин | ~95 | 0 | 0 | близок к нулю |
| `hour === 0` в TZ юзера | 1 раз/сутки/пользователя | ~2× rules | per-rule × per-account × per-campaign | ~1500 actionLogs/окно | средний |

### Окно 00:00 МСК (большинство ru-клиентов)

Грубая оценка: ~93 правила (примерная оценка по historical reset set; точное число — до fresh count), в среднем ~12 кампаний/правило → ≈ **1000–1500 `setCampaignBudget` POST в VK API одним cron-тиком**.

### Архитектурные риски включения cron сейчас

1. **Sequential, без fan-out.** Двойной `for` по правилам и аккаунтам. Один action делает ВСЁ. Convex action timeout = 10 мин.
   - 1500 VK API × ~300 ms ≈ 7.5 мин wall time. Близко к лимиту. Если часть токенов протухла → `handleTokenExpired` через scheduler → может уйти в timeout. Дочистит на следующем 30-мин тике (защита через `hasResetToday`).

2. **VK API rate-limit.** Нет staggering. ~5 req/sec. Должно проходить, ретраи на 429 в `callMtApi` встроены.

3. **Триггер бага #2 (`resumeCampaign`).** После reset часть кампаний может оказаться `delivery=not_delivering`. Следующий `uzBudgetDispatchV2` (45 мин позже) увеличит бюджет → `resumeCampaign` → **снова откатит user-paused banners** у любого, у кого они есть. Повторение инцидента Алёны для других клиентов.

4. **WAL pressure.** ~1500 actionLogs/окно — сильно меньше sync-metrics каждые 15 мин. Без эффекта.

5. **`_scheduled_jobs` queue.** 1 entry / 30 мин = 48/день. Нет fan-out внутри (все через `runQuery`/`runAction`). Без эффекта на drain.

### Финансовый ущерб от регрессии (фактические данные)

Проверка `budget_limit_day` через VK API сегодня (2026-05-08 ~17:30 МСК) у Алёны:

| Правило (Алёна) | init | campaigns | с overhead | overhead/день |
|---|---|---|---|---|
| Екб 07мая | 201 | 8 | 2 | +200₽ |
| Новосиб - уз 2,3 | 221 | 10 | 1 | +82₽ |
| Прутовых: Ижевск уз 3 ключи | 251 | 8 | 0 | +0₽ |
| Прутовых: Ижевск интересы | 151 | 3 | 0 | +0₽ |
| Остальные 5 правил | – | 31 | 0 | +0₽ |
| **ИТОГО** | – | **60** | **3** | **+282₽/день** |

**Важная находка:** на правиле «Ижевск уз 3 ключи 07.05» (Прутовых) overhead=0₽, хотя last log вчера был `251→301`. Алёна, обновив правило вручную сегодня, через `initializeUzBudgets` затёрла бюджеты обратно к `init=251`. Её действие де-факто = ручной reset. Без него overhead был бы ~400₽/день (50 × 8 кампаний).

### Шаг увеличения (cron uz-budget-increase) — работает

За последние 90 мин на правилах Алёны (2 тика `uzBudgetDispatchV2`):

| Правило | logs за 90 мин |
|---|---|
| Екб 07мая | 2 (05:29:15Z, 201→301) |
| Новосиб - уз 2,3 | 1 (05:29:17Z, 221→302.69) |
| Остальные 7 правил | 0 (кампании не достигли порога или на max) |

Pavel сегодня — 202 успешных budget_increased. Step-цикл здоровый.

### Сравнение действий

| Действие | Риск backend | Риск user-данных | Решает жалобы | Срочность |
|---|---|---|---|---|
| Включить cron сейчас, без фикса #2 | Низкий | **Высокий** — следующий за reset цикл uz-increase может откатить ручные паузы | Да | Не критично: real overhead = 282₽/день у Алёны, у других не проверено |
| Включить cron + фикс #2 одним деплоем | Низкий | Низкий | Да | Корректный путь |
| Только `emergencyBudgetReset` для затронутых | Близок к нулю | Низкий (action не вызывает resumeCampaign) | Точечно | Точечная мера |
| Не делать ничего | Нулевой | Перерасход накапливается | Нет | — |

### Главный вывод

Срочности «включать сегодня же» нет — реальный overhead у Алёны мизерный благодаря её ручному апдейту. **Корректный путь: сначала закрыть #2 (snapshot-restore), потом #3 одним деплоем.** Без #2 включение #3 = риск повторить инцидент Алёны для других клиентов с user-paused баннерами.

---

## Артефакты диагностики

> ⚠️ **Скрипты `check-uz-bug*.cjs` НЕ КОММИТИТЬ.** Каждый из них хардкодит `INSTANCE_SECRET` (`<REDACTED — secret value, see env / vault>`) для генерации Convex admin key. В `.gitignore` они сейчас не указаны — нужно либо добавить паттерн `check-*.cjs` в `.gitignore`, либо удалить скрипты после диагностики, либо переписать с чтением секрета из env. Локально — оставляем как diagnostics-only артефакты, приложенные к этому отчёту через имена файлов.
>
> ⚠️ **Compromise check:** в ранней версии этого отчёта значение секрета было записано в открытом виде. Если файл успел уйти наружу (push, screenshot, share) — секрет считать скомпрометированным и ротировать `CONVEX_INSTANCE_SECRET`. Локально файл сейчас untracked, в репозитории его нет.

Скрипты для воспроизведения (запускать локально, в репозиторий не коммитить):
- `check-uz-bug.cjs` — все активные UZ-правила в системе
- `check-uz-bug2.cjs` — UZ-правила Pavel и Алёны
- `check-uz-bug3.cjs` — actionLogs правила «Туркиш В»
- `check-uz-bug4.cjs` — сравнение targetCampaignIds vs VK live (Pavel)
- `check-uz-bug5.cjs` — кросс-таблица rule × live × fired (Pavel)
- `check-uz-bug6.cjs` — статус всех 6 ad_plans Pavel + распределение бюджета
- `check-uz-bug7.cjs` — actionLogs правил Алёны (Прутовых)
- `check-uz-bug8.cjs` — текущее состояние баннеров в Прутовых (VK API)
- `check-uz-bug9.cjs` — heartbeats всех кронов + budget_reset логи на правилах Алёны и в системе
- `check-uz-bug10.cjs` — budget_reset логи до/после drain (доказательство периода регрессии)
- `check-uz-bug11.cjs` — текущий overhead vs initialBudget по правилам Алёны + проверка работы шага увеличения за последние 90 мин
