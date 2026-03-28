# Авто-привязка видео + Telegram-уведомления — Design Spec

**Дата:** 2026-03-28
**Скоуп:** Авто-привязка видео к объявлениям (VK API) + Telegram-уведомления о досмотренности

---

## Проблема

Видео-аналитика (creativeStats, AI-анализ досмотренности) не работает без привязки видео к объявлению (`vkAdId`). Сейчас привязка возможна только вызовом `linkToAd` mutation, но нигде не вызывается — ни из UI, ни автоматически.

## Проверено реальным API-запросом

`GET banners.json?fields=id,content&limit=3` возвращает:

```json
{
  "id": 172725114,
  "content": {
    "icon_256x256": {
      "id": 46302869,
      "type": "static",
      "variants": { "original": { "media_type": "image", ... } }
    },
    "image_600x600": {
      "id": 54893009,
      "type": "static",
      "variants": { "original": { "media_type": "image", ... } }
    }
  }
}
```

Структура `content`:
- Ключи — слоты контента (`icon_256x256`, `image_600x600`, `video_16x9`, `video_1x1` и т.д.)
- Каждый слот имеет `id` (media ID), `type` ("static" | "video"), `variants` с `media_type`
- Для видео-баннеров: ключ `video_*` с `type: "video"` или `variants.*.media_type: "video"`
- `id` внутри слота — это `vkMediaId` который сохраняется при загрузке видео

## Решение

### 1. Авто-привязка через VK API

**Механизм:** При sync (`syncMetrics.syncAll`), баннеры уже запрашиваются (строка 53). Расширяем `fields` чтобы включить `content`. Для каждого баннера перебираем ключи `content`, ищем слот с видео (`type === "video"` или `variants.*.media_type === "video"`). Берём его `id` и сопоставляем с `videos.vkMediaId` для этого аккаунта.

**Алгоритм:**
1. Расширить `MtBanner` интерфейс: `content?: Record<string, { id: number; type?: string; variants?: Record<string, { media_type: string }> }>`
2. В `getMtBanners` добавить `content` в `fields`: `"id,campaign_id,textblocks,status,moderation_status,created,updated,content"`
3. В `syncAll`, после построения `bannerCampaignMap` (строка 56-60), добавить:
   - Для каждого баннера с `content` → перебрать ключи
   - Найти слот где `type === "video"` или любой `variant.media_type === "video"`
   - Взять `slot.id` → найти видео с `vkMediaId === String(slot.id)` в этом аккаунте
   - Если найдено и `video.vkAdId` пустой → проставить `vkAdId = String(banner.id)`
   - Логировать: `[syncMetrics] Auto-linked video "filename.mp4" → banner 12345`

### 2. Ручная привязка (фоллбэк)

**Механизм:** В `VideoItem.tsx`, если видео не привязано (`!video.vkAdId`), показать кнопку "Привязать к объявлению". По клику — дропдаун с объявлениями аккаунта из таблицы `ads`. Выбор → вызов `linkToAd`.

**UI:**
- Показывать только в expanded-состоянии VideoItem
- Кнопка: "Привязать к объявлению" с иконой Link
- Дропдаун: список объявлений с именами из таблицы `ads`, фильтр по `accountId`
- После привязки: показать Badge с именем объявления

### 3. Telegram-уведомления о досмотренности

**Механизм:** В `creativeAnalytics.analyzeWatchRates`, после сохранения AI-анализа, отправляем Telegram-уведомление через `internal.telegram.sendMessage(chatId, text)` (HTML-формат, строка 339 в telegram.ts).

**Логика отправки:**
- Первый анализ (`!video.lastAnalyzedAt`) → всегда отправляем
- Ре-анализ → сравниваем новый `score` с предыдущим `aiWatchScore` из последней записи `creativeStats`. Отправляем только если |новый - старый| ≥ 15 пунктов

**Получение chatId:** Из `video.userId` → запрос `users` → `telegramChatId`. Если chatId нет — пропускаем без ошибки.

**Формат сообщения (первый анализ):**
```
📊 Анализ видео «filename.mp4»

Оценка удержания: 35/100 — Плохо
Воронка: 100% → 65% (3с) → 40% (25%) → 18% (50%) → 8% (100%)

⚠️ Рекомендации:
• Слабый хук — первый кадр не цепляет
• Нет CTA в финале
```

**Формат сообщения (ре-анализ со значительным изменением):**
```
📊 Ре-анализ видео «filename.mp4»

Оценка удержания: 52/100 — Средне
Изменение: 35 → 52 (+17 за 7 дней)
Воронка: 100% → 72% (3с) → 48% (25%) → 25% (50%) → 12% (100%)

✅ Улучшения:
• Хук стал цеплять лучше (+7% на 3с)
```

---

## Файлы и изменения

| Файл | Действие | Что меняется |
|------|----------|-------------|
| `convex/vkApi.ts` | Modify | Расширить `MtBanner` полем `content`, `getMtBanners` добавить `content` в `fields` |
| `convex/syncMetrics.ts` | Modify | Добавить авто-линковку после построения bannerCampaignMap (строка 60) |
| `convex/videos.ts` | Modify | Добавить `autoLinkVideos` internalMutation, `listAdsForAccount` query |
| `convex/creativeAnalytics.ts` | Modify | Добавить Telegram-уведомление после AI-анализа, получение предыдущего score |
| `src/components/VideoItem.tsx` | Modify | Кнопка + дропдаун ручной привязки, Badge привязанного объявления |

## Что НЕ входит в этот спек

- Фото-креативы (отдельный спек)
- AI-режим создания кампаний (отдельный спек)
- Сравнение креативов (отдельный спек)
