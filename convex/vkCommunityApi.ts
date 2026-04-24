// VK API client — separate from vkApi.ts (myTarget API, uses target.my.com)
// This file uses VK API (api.vk.com) for community methods (groups, messages)
// Version 5.199 required for groups.getById new response format { groups: [...] }
// (vkApi.ts uses 5.131 for myTarget — different API, different versioning)
// Docs: https://dev.vk.com/ru/method
const VK_API_BASE = "https://api.vk.com/method";
const VK_API_VERSION = "5.199";

export type VkApiError = { code: number; message: string };

const VK_MAX_RETRIES = 3;
const VK_RETRY_DELAY_MS = 400;

async function callVkApi<T>(
  method: string,
  accessToken: string,
  params: Record<string, string | number> = {}
): Promise<T> {
  for (let attempt = 0; attempt < VK_MAX_RETRIES; attempt++) {
    const url = new URL(`${VK_API_BASE}/${method}`);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
    url.searchParams.set("access_token", accessToken);
    url.searchParams.set("v", VK_API_VERSION);

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`VK API HTTP ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { response?: T; error?: VkApiError };
    if (json.error) {
      // Code 6 = Too many requests per second — retry with backoff
      if (json.error.code === 6 && attempt < VK_MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, VK_RETRY_DELAY_MS * (attempt + 1)));
        continue;
      }
      throw new Error(`VK API error ${json.error.code}: ${json.error.message}`);
    }
    return json.response as T;
  }
  throw new Error("VK API: max retries exceeded");
}

export interface VkGroupInfo {
  id: number;
  name: string;
  photo_100: string;
  screen_name: string;
}

/**
 * Валидация токена через groups.getById.
 * Если токен сообщества — возвращает инфу о самом сообществе.
 * Бросает Error с кодом VK при проблемах.
 */
export async function groupsGetById(
  accessToken: string
): Promise<VkGroupInfo> {
  // Для токена сообщества groups.getById без параметров возвращает текущее сообщество
  const res = await callVkApi<{ groups: VkGroupInfo[] }>(
    "groups.getById",
    accessToken,
    { fields: "screen_name" }
  );
  if (!res.groups || res.groups.length === 0) {
    throw new Error("VK API: groups.getById returned empty result");
  }
  return res.groups[0];
}

// ─── Conversations / messages ──────────────────────────────

export interface VkConversation {
  peer: { id: number; type: string };
  last_message_id: number;
  in_read: number;
  out_read: number;
  last_message: { date: number; from_id: number; text: string; id: number };
}

export interface VkConversationsResponse {
  count: number;
  items: Array<{
    conversation: VkConversation;
    last_message?: { id: number; date: number; from_id: number; text: string };
  }>;
}

/**
 * Список диалогов сообщества, отсортированных по активности (новые первые).
 * offset и count — пагинация, max count=200.
 */
export async function messagesGetConversations(
  accessToken: string,
  offset: number,
  count: number = 200
): Promise<VkConversationsResponse> {
  return await callVkApi<VkConversationsResponse>(
    "messages.getConversations",
    accessToken,
    { offset, count, filter: "all", extended: 0 }
  );
}

// ─── History of a dialog ───────────────────────────────────

export interface VkMessage {
  id: number;
  date: number;         // unix seconds
  from_id: number;      // negative = community, positive = user
  text: string;
  peer_id: number;
}

export async function messagesGetHistory(
  accessToken: string,
  peerId: number,
  count: number = 50,
  rev: 0 | 1 = 1
): Promise<{ count: number; items: VkMessage[] }> {
  return await callVkApi<{ count: number; items: VkMessage[] }>(
    "messages.getHistory",
    accessToken,
    { peer_id: peerId, count, rev }
  );
}

// ─── Users info ────────────────────────────────────────────

export interface VkUser {
  id: number;
  first_name: string;
  last_name: string;
  photo_100?: string;
}

/**
 * Батчевое получение инфы о пользователях. Max 1000 ID за вызов,
 * но для безопасности ограничиваем 100.
 */
export async function usersGet(
  accessToken: string,
  userIds: number[]
): Promise<VkUser[]> {
  if (userIds.length === 0) return [];
  if (userIds.length > 100) {
    throw new Error("usersGet: max 100 IDs per call");
  }
  return await callVkApi<VkUser[]>(
    "users.get",
    accessToken,
    { user_ids: userIds.join(","), fields: "photo_100" }
  );
}
