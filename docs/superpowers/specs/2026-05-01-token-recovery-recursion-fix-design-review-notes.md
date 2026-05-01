Док хороший. В целом я согласен с направлением: **не отключать token recovery**, а разорвать рекурсию, добавить gate/cooldown и снизить повторное логирование. Это правильный вариант.

Но перед реализацией я бы поправил в дизайне 3 важных места.

**1. Gate должен быть атомарным**

В документе предлагается:

```ts
read account
if cooldown active return false
setLastRecoveryAttempt(...)
```

Это не защищает от гонки. Два action могут одновременно прочитать старое значение, оба пройти проверку, и оба начать recovery.

Нужно сделать одну mutation:

```text
claimTokenRecovery(accountId, now)
  внутри одной mutation:
    прочитать account
    если lock/cooldown активен -> return { claimed: false }
    иначе записать lock/cooldown -> return { claimed: true }
```

То есть не `query + mutation`, а **одна атомарная mutation**.

Лучше даже не `lastRecoveryAttemptAt`, а:

```ts
tokenRecoveryLockUntil?: number
nextTokenRecoveryAt?: number
lastRecoveryAttemptAt?: number
```

Минимально можно оставить одно поле, но lock/cooldown через одну mutation надежнее.

**2. Есть противоречие вокруг `tokenExpiresAt = 0`**

В одном месте док говорит:

```text
setTokenExpiry(0) — invalidate stale expiry so cascade goes through provider refresh
```

Но в другом месте:

```text
dead token with tokenExpiresAt undefined/null/0 throws TOKEN_EXPIRED
```

Это надо уточнить до реализации.

Я бы зафиксировал так:

```text
undefined/null = permanent/unknown expiry
0 = invalidated/dead token
```

И тогда `getValidTokenForAccount` при `tokenExpiresAt === 0` должен **не уходить в permanent branch**, а идти в refresh/provider cascade. Если все методы провалились — только тогда `throw TOKEN_EXPIRED`.

Иначе есть риск сломать recovery: `handleTokenExpired` выставит `0`, потом `tryRecoverToken -> getValidTokenForAccount`, а тот сразу бросит `TOKEN_EXPIRED`, не попробовав Vitamin/GetUNIQ/Click.ru/ZaleyCash.

**3. `tryRecoverToken` все еще вызывает `getValidTokenForAccount`**

Это допустимо только если строго выполнено правило:

```text
getValidTokenForAccount никогда не вызывает tokenRecovery.*
```

Тогда рекурсии не будет. Но я бы в дизайне написал жестче:

```text
tryRecoverToken may call getValidTokenForAccount only after recursion backedge is removed.
```

И тестом проверить, что в `auth.ts:getValidTokenForAccount` больше нет `internal.tokenRecovery.tryRecoverToken`.

**Что еще поправить**

В таблице файлов написано:

```text
convex/crons.ts — Pass force: true
```

Но фактически `retryRecovery` вызывает `tryRecoverToken` внутри [convex/tokenRecovery.ts](/c:/1Terminal/ADDpilot_v1/convex/tokenRecovery.ts:389), не в `crons.ts`. Значит менять надо `tokenRecovery.ts`.

Также фраза “64 MiB carryover only possible via deep nested runAction stack” слишком категоричная. Лучше написать “consistent with deep nested runAction stack”, потому что память может держаться и из-за больших closures/ответов API.

**Мой вердикт**

План хороший как основа, но я бы не реализовывал его в текущем виде без правки gate и `tokenExpiresAt=0`. Главная доработка: заменить `setLastRecoveryAttempt` на атомарный `claimRecoveryAttempt`, и четко прописать, что `0` означает invalidated, а не permanent.

После этих правок дизайн можно брать в работу.