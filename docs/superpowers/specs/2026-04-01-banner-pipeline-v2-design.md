# Banner Pipeline V2 — Стили, FLUX Ultra, Canvas-композитинг

## Контекст

Текущий пайплайн генерации баннеров (`aiGenerate.ts`, `creatives.ts`) использует generic промпт + FLUX Pro 1.1 608×608. Нет стилей, нет текста на баннере, низкое качество. Решения приняты после A/B тестирования моделей, стилей и форматов (2026-04-01).

## Решения (протестированы)

| Параметр | Было | Стало |
|---|---|---|
| Промпт для FLUX | Sonnet 4, generic | **Haiku 4.5**, стилевой system prompt |
| FLUX модель | Pro 1.1, 608×608 | **Ultra**, `aspect_ratio: "1:1"`, `raw: true` |
| Выходной размер | 608×608, 48KB | 2048×2048 (~800KB), VK ресайзит сам |
| Стили | 1 (generic) | **6** (из vk-banner skill), авто-выбор по нише |
| Текст на баннере | Нет | **Canvas-композитинг на фронте** |
| Стоимость | ~₽4.5 | ~₽6 |

## Архитектура

```
[Frontend]                              [Backend (Convex)]

User input (бизнес, title, text)  →     generateBannerImage()
                                          ├─ selectStyle(businessDirection)
                                          ├─ Haiku 4.5 → FLUX prompt
                                          ├─ FLUX Ultra (aspect_ratio "1:1", raw)
                                          ├─ Poll → download → store
                                          └─ return storageId

storageId ←────────────────────────
    │
    ▼
Canvas compositing (browser):
  1. Load FLUX image
  2. Draw gradient overlay (bottom 33%)
  3. Draw text (title, subtitle)
  4. Export JPEG
  5. Show preview to user
  6. Upload final to Convex Storage (or VK)
```

## Backend: новый файл `convex/bannerStyles.ts`

6 стилевых конфигов, каждый содержит:
- `systemPrompt` — system prompt для Haiku (из skill, адаптирован под квадрат)
- `suffix` — суффикс для FLUX промпта
- `nicheKeywords` — ключевые слова для авто-маппинга

### Стили

| Код | Описание | Ниши |
|---|---|---|
| `lifestyle_candid` | Люди, натуральное фото, "Shot on iPhone" суффикс | фитнес, красота, еда, мероприятия |
| `cinematic` | Драматичные метафоры, контраст | лидогенерация, маркетинг, финансы |
| `product_focus` | Продукт крупным планом, студия | товары, e-commerce, электроника |
| `result_visual` | Результат/трансформация | обучение, курсы, коучинг |
| `location` | Интерьер/место, атмосфера | недвижимость, локальный бизнес |
| `minimal_3d` | Абстрактная 3D форма, минимализм | SaaS, IT, приложения |

### Маппинг `selectStyle(businessDirection: string): StyleConfig`

Ищет ключевые слова в `businessDirection` (lowercase). Если нет совпадений — fallback `cinematic`.

### Квадратный промпт (все стили)

Адаптация для 1:1:
- Medium/wide shot, объект ~40% кадра
- Нижняя треть темнее для текста
- "plain uniform, no logos, no patches, no badges" (против фейкового текста на одежде)
- Убрать "subject on the right" (это для wide)

## Backend: обновление `convex/aiGenerate.ts`

### `generateBannerImage` — изменения:

1. **Новый аргумент**: `niche: v.optional(v.string())`
2. **Шаг 1**: `selectStyle(args.niche || args.businessDirection)` → получаем `systemPrompt` + `suffix`
3. **Шаг 2**: Haiku 4.5 (вместо Sonnet) с выбранным `systemPrompt`
4. **Шаг 3**: FLUX Ultra `api.bfl.ai/v1/flux-pro-1.1-ultra` с `{ prompt, aspect_ratio: "1:1", raw: true }`
5. **Шаг 4**: Poll (макс 60 итераций × 3 сек = 3 мин таймаут)
6. **Шаг 5**: Download → store blob → return `{ storageId, style }`

### `generateBannerTexts` — обновление формата

Текущий формат: `{ title: string, text: string }` (25 / 90 символов)

Новый формат:
```ts
{
  headline: string,       // заголовок для баннера
  subtitle?: string,      // подзаголовок
  bullets: string[],      // 2-4 буллета
  adTitle: string,        // title для VK Ads (до 25 симв)
  adText: string,         // text для VK Ads (до 90 симв)
}
```

Генерируем и текст НА баннере (headline/subtitle/bullets), и текст ДЛЯ VK Ads (adTitle/adText) — это разные вещи.

### `improveTextField` — добавить поддержку новых полей (headline, subtitle, bullet)

## Backend: обновление `convex/creatives.ts`

`generateImage` — аналогичные изменения (Haiku + Ultra + стили). Использует те же `bannerStyles.ts`.

## Frontend: Canvas-композитинг

### Новый компонент `src/components/BannerCompositor.tsx`

Принимает:
- `imageUrl` (или storageId) — фон от FLUX
- `headline` — заголовок
- `subtitle` — подзаголовок (опционально)
- `bullets` — массив буллетов (до 5 шт)

Рисует на `<canvas>`:
1. Загружает FLUX-изображение
2. Рисует **градиентный оверлей** — прозрачный сверху → чёрный (opacity 60%) внизу, нижние 38%
3. Рисует **подложки (плашки)** под текстовые блоки:
   - **Headline plaque**: полупрозрачный чёрный (rgba 0,0,0, opacity 180/255), скругление 6px, padding 12px по бокам / 8px сверху-снизу. Акцентная цветная линия 3px слева (configurable accent color, default синий `#4A90E2`)
   - **Card overlay** (layout `card_overlay`): полноширинная тёмная карточка в нижней части, скругление 10px, opacity 180
   - Подложки рисуются **ДО текста** чтобы текст был поверх
4. Рисует **headline** — белый (#FFFFFF), bold, ~48px, поверх плашки
5. Рисует **subtitle** — светло-серый (#DCDCDC), regular, ~28px
6. Рисует **bullets** — с маркером "•", светло-серый (#C8C8C8), ~26px, до 5 штук
7. **Проверка text coverage ≤18%** (VK лимит 20%, буфер 2%)
8. Если >18% — **auto-fit**: уменьшение шрифтов 10% → ещё 10% → убрать последний буллет → убрать subtitle → обрезать headline
9. Экспортирует `canvas.toBlob("image/jpeg", 0.92)` для скачивания/загрузки

### Text Coverage Check (≤18%)

VK официально разрешает до 20% текста на изображении. Мы используем 18% как безопасный буфер.

Расчёт: суммарная площадь bounding box всех текстовых блоков / (width × height) × 100.

**Auto-fit порядок уменьшения** (из skill):
1. Уменьшить все шрифты на 10%
2. Уменьшить ещё на 10%
3. Убрать последний буллет
4. Убрать subtitle
5. Обрезать headline + уменьшить шрифты на 15%
6. Агрессивное уменьшение шрифтов на 20%

### Шрифты
- Используем web font: Inter или Roboto (подключить через Google Fonts)
- Fallback: system sans-serif

### Интеграция

**AICabinetNewPage**: после генерации изображения показываем `BannerCompositor` с preview. Пользователь видит баннер с текстом, может изменить title/text и увидеть результат в реальном времени.

**CreativesPage**: аналогично в `CreativeGallery`.

## Что НЕ входит в скоуп

- Выбор стиля вручную (UI для пикера стилей) — только авто-маппинг
- Форматы 1200×628 и 1080×1920 — пока только квадрат
- Загрузка готового баннера в VK через API — отдельная задача

## Файлы

| Действие | Файл |
|---|---|
| Создать | `convex/bannerStyles.ts` — стили, промпты, маппинг |
| Обновить | `convex/aiGenerate.ts` — generateBannerImage → Haiku + Ultra + стили |
| Обновить | `convex/creatives.ts` — generateImage → аналогично |
| Создать | `src/components/BannerCompositor.tsx` — Canvas-композитинг |
| Обновить | `src/pages/AICabinetNewPage.tsx` — интеграция BannerCompositor |
| Обновить | `src/pages/CreativesPage.tsx` — интеграция BannerCompositor |
