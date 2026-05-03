# План реализации: Account Activation + Auto-Reactivation

**Дата:** 2026-05-03
**Связанный спек:** `docs/specs/2026-05-03-account-activation-spec.md`
**Статус:** готов к нарезке на PR'ы

## Принцип

Делим работу на 5 последовательных задач. Каждая = отдельный PR, отдельный commit, отдельный typecheck/test gate. Поздние задачи зависят от ранних — порядок строгий.

Каждая задача имеет:
- **Что делаем** — список изменений.
- **Acceptance** — что должно работать к концу задачи.
- **Тесты** — какие новые тесты добавить.
- **Не делаем** — явно вынесено в следующие задачи.

---

## Задача 1: Schema + downgrade marker + cleanup в `rules` мутациях

**Цель:** ввести billing-marker и весь его lifecycle (выставление при downgrade + очистка при ручных изменениях правил) одним PR. Это критично: если разнести на разные PR, между деплоями будет окно, в котором downgrade ставит маркер, а ручной toggle/update не очищает — апгрейд может «реактивировать» правило, которое юзер сознательно выключил.

**Поведение, которое реально меняется (НЕ silent infra-only задача):**
- `video_rotation` при downgrade теперь действительно останавливается (через scheduler), а не только помечается `isActive: false`. До этого ротация продолжала работать в фоне до health-check'а — pre-existing bug, который мы попутно чиним.

### Что делаем
- `convex/schema.ts`: + `rules.disabledByBillingAt: v.optional(v.number())` + `users.lastReactivationAt: v.optional(v.number())`.
- `convex/billing.ts:1390` (`updateLimitsOnDowngrade`): для не-`video_rotation` правил выставлять `disabledByBillingAt: Date.now()` в patch; для `video_rotation` — дёргать `ctx.scheduler.runAfter(0, internal.videoRotation.deactivate, { ruleId })`.
- `convex/rules.ts`: + helper `patchRuleAndClearBillingMarker` (см. §5 спека).
  - Использует тип `MutationCtx` из `_generated/server` (НЕ self-referential `typeof ctx.*`).
  - Локальный тип `RulePatch = Partial<Omit<Doc<"rules">, "_id" | "_creationTime">>`.
  - `cleanPatch` через `Object.fromEntries(...filter v !== undefined)` перед replace/patch.
  - `replace()` с destructure `_id`, `_creationTime`, `disabledByBillingAt`.
- `convex/rules.ts:861` (`toggleActive`): использовать helper.
- `convex/rules.ts:615` (`update`): использовать helper.

### Acceptance
- Schema typecheck clean.
- При следующем downgrade-кроне reactive-правила получают timestamp в `disabledByBillingAt`; rotation-правила — нет, но scheduler call зафиксирован.
- При downgrade `rotationState` для выключенного `video_rotation` правила реально останавливается.
- Ручной `rules.toggleActive` или `rules.update` физически удаляет `disabledByBillingAt` через replace (поле отсутствует в записи).
- Existing tests на `updateLimitsOnDowngrade`, `rules.toggleActive`, `rules.update` продолжают проходить.
- Кабинеты paused-механика не изменилась.

### Тесты
- `billing.test.ts`: маркер ставится для reactive, НЕ ставится для rotation, deactivate-scheduler вызывается для rotation.
- `billing.test.ts`: тест на актуальное состояние `rotationState`. Поскольку `videoRotation.deactivate` запускается через `scheduler.runAfter`, проверяем одним из двух способов:
  - (a) **scheduled call assertion** — spy на `ctx.scheduler.runAfter`, проверяем что вызвано с правильным `ruleId`. Проще, не покрывает реальное поведение deactivate.
  - (b) **integration-style** — после downgrade явно прогнать scheduler queue (через `convexTest` API) и проверить что rotationState физически остановлен. Точнее, но требует convexTest scheduler runner. **Рекомендую (b)**: меньше mock'ов, ближе к prod.
- `rules.test.ts`: helper тесты — toggleActive с маркером (replace path), toggleActive без маркера (patch path), update с маркером, update с `{ name: undefined }` (cleanPatch не пускает undefined в replace), system fields не теряются.

### Не делаем
- Reactivation на upgrade (Задача 2).
- Manual activate, updateStatus guard, UI кнопка (Задача 3).
- CTA + frontend (Задача 4).

---

## Задача 2: Upgrade restore (`updateLimitsOnUpgrade`)

**Цель:** при payment success автоматически восстанавливать кабинеты и reactive-правила.

### Что делаем
- `convex/billing.ts`: + новая `updateLimitsOnUpgrade` internalMutation (см. §3 спека).
  - Активирует первые N paused аккаунтов до лимита.
  - Реактивирует только rules с маркером (фильтр + `r.type !== "video_rotation"` belt-and-suspenders).
  - **`replace()` для физического удаления `disabledByBillingAt`** (с destructure `_id`, `_creationTime`).
  - Стампит `users.lastReactivationAt` если что-то реально реактивировано.
  - Audit log `account_activated`/`rule_reactivated` с `source: "auto_reactivation"`.
- `convex/billing.ts:843` (bePaid webhook success): вызов `updateLimitsOnUpgrade`.
- `convex/billing.ts:953`/`:1064` (mock `processPayment`): тот же вызов.

### Acceptance
- После успешного bePaid платежа paused-кабинеты автоматически возвращаются в active (до лимита нового тарифа).
- Reactive-правила, выключенные биллингом, автоматически реактивируются (до лимита).
- `video_rotation` правила НЕ реактивируются.
- `users.lastReactivationAt` обновлён.
- Webhook retry не дублирует audit log.
- Mock payment flow в dev среде ведёт себя так же.

### Тесты
- `billing.test.ts`: счётчики совпадают, video_rotation skip, replace физически удаляет поле, идемпотентность retry, lastReactivationAt только при реальной реактивации, mock processPayment триггерит реактивацию, ступенчатый upgrade, сортировка по createdAt и disabledByBillingAt asc, skip org-member.
- `billing.test.ts`: **proAccountLimit явный тест** — upgrade на pro с `user.proAccountLimit = 27` поднимает до 27 paused-кабинетов; без `proAccountLimit` — до `TIERS.pro.accountsLimit` (9). Match с формулой из спека: `user.proAccountLimit ?? TIERS.pro.accountsLimit`.

### Не делаем
- Manual activate кнопка (Задача 3).
- updateStatus guard (Задача 3).
- CTA + frontend (Задача 4).

---

## Задача 3: Manual activate + `updateStatus` guard + UI кнопка

**Цель:** ручной fallback для пользователей, которые остались с paused-кабинетами после auto-reactivation (превышение лимита).

### Что делаем
- `convex/adAccounts.ts`: + новая публичная `activate` mutation (см. §7 спека).
  - Resolve effective tier через `account.orgId ?? user.organizationId`, проверка `frozen` grace.
  - Лимит check, audit log `source: "manual"`.
  - Стампит `lastReactivationAt`.
- `convex/adAccounts.ts:1458` (`updateStatus`): inline guard на `paused → active`, кидает осмысленную ошибку.
- `src/components/AccountCard.tsx`: + icon-only кнопка «Активировать» для `status === "paused"` рядом с disconnect.
- `src/components/AccountCard.tsx:285`: **скрыть SyncButton для paused** (`status !== 'abandoned' && status !== 'paused'`).
- `src/components/AccountList.tsx`: проброс `onActivated` / `onActivationError` callbacks в `AccountCard`.
- `src/pages/AccountsPage.tsx`: callbacks → `setSuccess` / `setError`.

### Acceptance
- Кнопка «Активировать» работает: paused → active при наличии слота, ошибка с человеческим текстом при превышении лимита.
- Sync button НЕ виден на paused.
- `updateStatus` блокирует клиентский bypass.
- Все existing 10 вызовов `updateStatus` в `syncMetrics.ts` продолжают работать (ни один не делает `paused → active`).
- Agency/unlimited org accounts (`accountsLimit === -1`) активируются без count-limit. Если у org появится finite tier — применяем его лимит как для обычного юзера. `org.expiredGracePhase === "frozen"` блокирует активацию.

### Тесты
- `adAccounts.test.ts`: 18 unit-тестов из секции «Тесты» спека.
- E2E: кнопка видна/скрыта, activate в пределах лимита, activate выше лимита, sync hidden на paused.
- **Finite/non-agency org tier** — НЕ тестируем: `organizations.subscriptionTier` в schema сейчас union только `agency_s|m|l|xl` (см. `convex/schema.ts:909`). Если в будущем расширят — добавить тест на org с finite tier и проверить что count-limit применяется (формула та же, что для индивидуального юзера).

### Не делаем
- CTA баннер (Задача 4).
- Чистка маркера в rules мутациях — **уже сделано в Задаче 1** (помещено туда, чтобы избежать deployment window).

---

## Задача 4: Контекстный CTA

**Цель:** показать юзеру баннер с напоминанием включить правила, которые auto-reactivation не вернула. Чисто frontend + read-only query.

### Что делаем
- `convex/rules.ts`: + `getReactivationCta` query (см. Frontend секцию спека). Возвращает `{ show, count, hasVideoRotation }`.
- `src/pages/AccountsPage.tsx`: + `useQuery(api.rules.getReactivationCta)` и условный CTA-баннер с `data-testid="reactivation-cta"`.

### Acceptance
- CTA показывается только в окне 7 дней после reactivation event (`lastReactivationAt` < 7 дней).
- CTA включает video_rotation правила в `count` и в `hasVideoRotation` flag.
- Не показывается у юзеров без `lastReactivationAt`.
- НЕ показывается, если все disabled rules — биллинговые reactive (auto-reactivation их вернула).

### Тесты
- `rules.test.ts`: 5 тестов на `getReactivationCta` — show=true в окне, false вне окна, false без lastReactivationAt, hasVideoRotation flag, фильтрация биллинговых reactive.
- E2E: 5 CTA-сценариев из спека.

### Не делаем
- Cleanup маркера (уже в Задаче 1).
- Никаких schema/backend изменений в payment/billing flow.

---

## Задача 5: Final integration tests + cleanup

**Цель:** end-to-end проверка всего lifecycle и финальная сверка.

### Что делаем
- Integration test: полный walkthrough «pro → freemium → start → upgrade → activate» в `convexTest`.
- Прогнать все pre-commit checks из спека: 12 grep-команд, typecheck, lint, тесты.
- Проверить, что 10 callers `updateStatus` в `syncMetrics.ts` не задеты.
- Manual smoke test в dev: реальный mock payment, проверить что paused → active, audit log заполнен.

### Acceptance
- Все unit + integration + E2E тесты зелёные.
- Pre-commit чеклист спека пройден целиком.
- В dev среде end-to-end flow работает.

### Не делаем
- Никаких новых features. Только проверка.

---

## Зависимости

```
1 (schema + downgrade marker + cleanup helper в rules мутациях)
  ↓
2 (upgrade restore) — нужен маркер из 1; cleanup из 1 гарантирует что user-выключенные правила не реактивируются
  ↓
3 (manual activate + UI) — нужен lastReactivationAt из 1; updateStatus guard независим, но логично здесь
  ↓
4 (CTA) — нужен lastReactivationAt из 1 и активный auto-reactivation flow из 2
  ↓
5 (integration)
```

**Почему cleanup в Задаче 1, а не в 4:** если разнести deploy 1 → 2 → ... → 4 во времени, то после деплоя 2 будет окно, где `updateLimitsOnUpgrade` уже читает маркер, но `rules.toggleActive` ещё не очищает его. Сценарий: юзер на freemium → выключил R1 руками → upgrade → R1 неожиданно реактивировано (потому что маркер с прошлого downgrade остался). Поэтому marker lifecycle (set + clear) обязан жить в одном PR.

Параллельно делать нельзя: каждая задача меняет схему/логику, на которой стоит следующая.

## Принципы для каждого PR

- **Один PR = одна задача.** Не объединять.
- **TypeCheck + lint + test** перед коммитом каждой задачи (см. CLAUDE.md `Pre-Commit Verification`).
- **Companion-sync check** перед коммитом каждой задачи (см. CLAUDE.md).
- **Audit log** проверка: новые мутации логируют action.
- **Никаких параллельных рефакторингов** — централизация tier helper'а в follow-up, не в этих задачах.

## Follow-up тикеты (после всех 5 задач)

1. Централизация `resolveAccountLimits` в `convex/billing.ts`.
2. `users.getLimits` alignment с activate-семантикой.
3. Кнопка «Приостановить» в AccountCard.
4. `pausedReason` поле для различения billing/manual pause.
