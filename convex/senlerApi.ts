// Senler API client
// Docs: https://help.senler.ru/sender/dev/api
const SENLER_API_BASE = "https://senler.ru/api";

export interface SenlerError {
  error_code: number;
  error_message: string;
}

async function callSenlerApi<T>(
  method: string,
  apiKey: string,
  body: Record<string, unknown> = {}
): Promise<T> {
  const res = await fetch(`${SENLER_API_BASE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      access_token: apiKey,
      ...body,
    }),
  });
  if (!res.ok) {
    throw new Error(`Senler API HTTP ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { success?: boolean; error?: SenlerError } & T;
  if (json.error) {
    throw new Error(`Senler API error ${json.error.error_code}: ${json.error.error_message}`);
  }
  return json;
}

/**
 * Ping для валидации ключа. Senler требует хотя бы group_id — используем subscriptions.get,
 * если ключ валиден — получаем список групп подписчиков. Если ключ невалиден — ошибка.
 */
export async function validateSenlerKey(apiKey: string): Promise<void> {
  await callSenlerApi<{ items: unknown[] }>("subscriptions/get", apiKey);
}

// ─── Subscribers by date range ────────────────────────────

export interface SenlerSubscriber {
  vk_user_id: number;
  date_subscribe: number;   // unix seconds
  subscription_id: number;
}

/**
 * Получает список подписчиков, подписавшихся в заданном диапазоне unix-timestamps.
 * Пагинирует по 1000.
 */
export async function getSubscribersByDateRange(
  apiKey: string,
  fromTs: number,  // unix seconds
  toTs: number
): Promise<SenlerSubscriber[]> {
  const all: SenlerSubscriber[] = [];
  let offset = 0;
  const COUNT = 1000;
  for (let page = 0; page < 50; page++) {
    const res = await callSenlerApi<{ items: SenlerSubscriber[] }>(
      "subscribers/get",
      apiKey,
      {
        count: COUNT,
        offset,
        date_subscribe_from: fromTs,
        date_subscribe_to: toTs,
      }
    );
    if (!res.items || res.items.length === 0) break;
    all.push(...res.items);
    if (res.items.length < COUNT) break;
    offset += COUNT;
  }
  return all;
}
