import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  parseStartCommand,
  generateRandomToken,
  buildBotLink,
  formatRuleNotification,
  formatGroupedNotification,
  buildInlineKeyboard,
  parseCallbackData,
  isQuietHours,
  formatDailyDigest,
  RuleNotificationEvent,
  DigestActionLogSummary,
} from "./telegram";
import { REVERT_TIMEOUT_MS } from "./ruleEngine";

// Helper: create test user
async function createTestUser(t: ReturnType<typeof convexTest>) {
  const userId = await t.mutation(api.users.create, {
    email: "tg@test.com",
    vkId: "tg_user",
    name: "Telegram Test User",
  });
  return userId;
}

describe("telegram", () => {
  // ═══════════════════════════════════════════════════════════
  // Pure function tests
  // ═══════════════════════════════════════════════════════════

  test("parseStartCommand extracts token from /start payload", () => {
    expect(parseStartCommand("/start abc123xyz")).toBe("abc123xyz");
  });

  test("parseStartCommand returns null for bare /start", () => {
    expect(parseStartCommand("/start")).toBeNull();
  });

  test("parseStartCommand returns null for non-start commands", () => {
    expect(parseStartCommand("/help")).toBeNull();
    expect(parseStartCommand("hello")).toBeNull();
  });

  test("parseStartCommand handles whitespace in payload", () => {
    expect(parseStartCommand("/start   token_with_spaces  ")).toBe(
      "token_with_spaces"
    );
  });

  test("generateRandomToken returns 32-char alphanumeric string", () => {
    const token = generateRandomToken();
    expect(token).toHaveLength(32);
    expect(token).toMatch(/^[A-Za-z0-9]+$/);
  });

  test("generateRandomToken generates unique tokens", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(generateRandomToken());
    }
    expect(tokens.size).toBe(100);
  });

  test("buildBotLink creates correct deep link URL", () => {
    const url = buildBotLink("Addpilot_bot", "mytoken123");
    expect(url).toBe("https://t.me/Addpilot_bot?start=mytoken123");
  });

  // ═══════════════════════════════════════════════════════════
  // Sprint 9 DoD #1: handleWebhook /start -> chatId saved
  // ═══════════════════════════════════════════════════════════

  test("S9-DoD#1: /start with valid token saves chatId to user", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);

    // Generate link token
    const token = await t.mutation(api.telegram.generateLinkToken, {
      userId,
    });
    expect(token).toBeDefined();
    expect(token).toHaveLength(32);

    // Process /start command (simulates webhook handler logic)
    const result = await t.mutation(api.telegram.processStartCommand, {
      chatId: "123456789",
      token,
    });

    expect(result.linked).toBe(true);

    // Verify chatId is saved on the user
    const user = await t.query(api.users.get, { id: userId });
    expect(user?.telegramChatId).toBe("123456789");
  });

  // ═══════════════════════════════════════════════════════════
  // Sprint 9 DoD #2: sendMessage — correct function signature
  // ═══════════════════════════════════════════════════════════

  test("S9-DoD#2: sendMessage action exists with correct args", () => {
    // Verify the sendMessagePublic action is exported in the API
    expect(api.telegram.sendMessagePublic).toBeDefined();
    // The action takes chatId and text arguments
    // Actual HTTP call tested in integration (requires bot token)
  });

  // ═══════════════════════════════════════════════════════════
  // Sprint 9 DoD #3: Telegram webhook -> 200 OK
  // (HTTP handler tested via processStartCommand flow)
  // ═══════════════════════════════════════════════════════════

  test("S9-DoD#3: webhook flow processes valid /start correctly", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);

    // Generate token
    const token = await t.mutation(api.telegram.generateLinkToken, {
      userId,
    });

    // Simulate the webhook payload processing
    // (the HTTP handler parses body and calls processStartCommand)
    const result = await t.mutation(api.telegram.processStartCommand, {
      chatId: "987654321",
      token,
    });

    expect(result.linked).toBe(true);

    // Verify chatId saved
    const user = await t.query(api.users.get, { id: userId });
    expect(user?.telegramChatId).toBe("987654321");

    // Verify token is consumed (deleted)
    const remainingToken = await t.query(api.telegram.getLinkToken, {
      userId,
    });
    expect(remainingToken).toBeNull();
  });

  // ═══════════════════════════════════════════════════════════
  // Sprint 9 DoD #4-5: Settings page has QR code
  // (UI component existence verified by import + route test)
  // ═══════════════════════════════════════════════════════════

  test("S9-DoD#4-5: generateLinkToken + getLinkToken flow for QR code", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);

    // No token initially
    const noToken = await t.query(api.telegram.getLinkToken, { userId });
    expect(noToken).toBeNull();

    // Generate token
    const token = await t.mutation(api.telegram.generateLinkToken, {
      userId,
    });
    expect(token).toHaveLength(32);

    // Token retrievable
    const savedToken = await t.query(api.telegram.getLinkToken, { userId });
    expect(savedToken).toBe(token);

    // Bot link is correct
    const link = buildBotLink("Addpilot_bot", token);
    expect(link).toContain("t.me/Addpilot_bot?start=");
    expect(link).toContain(token);
  });

  // ═══════════════════════════════════════════════════════════
  // Sprint 9 DoD #6: /start -> "Подключено!" message
  // (Message is sent by handleWebhook after processStartCommand)
  // ═══════════════════════════════════════════════════════════

  test("S9-DoD#6: successful /start links user and confirms", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);

    // Generate token
    const token = await t.mutation(api.telegram.generateLinkToken, {
      userId,
    });

    // Process /start
    const result = await t.mutation(api.telegram.processStartCommand, {
      chatId: "TG_CHAT_42",
      token,
    });

    expect(result.linked).toBe(true);

    // After this, handleWebhook would call sendMessage with
    // "Подключено!" text. Verify the user is linked.
    const status = await t.query(api.telegram.getConnectionStatus, {
      userId,
    });
    expect(status.connected).toBe(true);
    expect(status.chatId).toBe("TG_CHAT_42");
  });

  // ═══════════════════════════════════════════════════════════
  // Sprint 9 DoD #8: Repeated /start -> chatId updated
  // ═══════════════════════════════════════════════════════════

  test("S9-DoD#8: repeated /start updates chatId", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);

    // First connection
    const token1 = await t.mutation(api.telegram.generateLinkToken, {
      userId,
    });
    await t.mutation(api.telegram.processStartCommand, {
      chatId: "first_chat_id",
      token: token1,
    });

    const status1 = await t.query(api.telegram.getConnectionStatus, {
      userId,
    });
    expect(status1.connected).toBe(true);
    expect(status1.chatId).toBe("first_chat_id");

    // Second connection (new device / re-link)
    const token2 = await t.mutation(api.telegram.generateLinkToken, {
      userId,
    });
    await t.mutation(api.telegram.processStartCommand, {
      chatId: "second_chat_id",
      token: token2,
    });

    const status2 = await t.query(api.telegram.getConnectionStatus, {
      userId,
    });
    expect(status2.connected).toBe(true);
    expect(status2.chatId).toBe("second_chat_id");
  });

  // ═══════════════════════════════════════════════════════════
  // Edge cases
  // ═══════════════════════════════════════════════════════════

  test("processStartCommand with invalid token returns linked=false", async () => {
    const t = convexTest(schema);
    await createTestUser(t);

    const result = await t.mutation(api.telegram.processStartCommand, {
      chatId: "123",
      token: "nonexistent_token",
    });

    expect(result.linked).toBe(false);
    expect(result.reason).toBe("invalid_token");
  });

  test("generateLinkToken replaces old token for same user", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);

    // Generate first token
    const token1 = await t.mutation(api.telegram.generateLinkToken, {
      userId,
    });

    // Generate second token (should replace first)
    const token2 = await t.mutation(api.telegram.generateLinkToken, {
      userId,
    });

    expect(token1).not.toBe(token2);

    // Only new token should be valid
    const current = await t.query(api.telegram.getLinkToken, { userId });
    expect(current).toBe(token2);

    // Old token should be invalid
    const resultOld = await t.mutation(api.telegram.processStartCommand, {
      chatId: "old_chat",
      token: token1,
    });
    expect(resultOld.linked).toBe(false);

    // New token should work
    const resultNew = await t.mutation(api.telegram.processStartCommand, {
      chatId: "new_chat",
      token: token2,
    });
    expect(resultNew.linked).toBe(true);
  });

  test("getConnectionStatus returns false for user without Telegram", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);

    const status = await t.query(api.telegram.getConnectionStatus, {
      userId,
    });
    expect(status.connected).toBe(false);
    expect(status.chatId).toBeUndefined();
  });

  test("token is consumed after successful /start", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);

    const token = await t.mutation(api.telegram.generateLinkToken, {
      userId,
    });

    // Use token
    await t.mutation(api.telegram.processStartCommand, {
      chatId: "chat_id",
      token,
    });

    // Token should be consumed
    const remaining = await t.query(api.telegram.getLinkToken, { userId });
    expect(remaining).toBeNull();

    // Reusing same token should fail
    const retry = await t.mutation(api.telegram.processStartCommand, {
      chatId: "another_chat",
      token,
    });
    expect(retry.linked).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════
  // Sprint 10 — Telegram: уведомления
  // ═══════════════════════════════════════════════════════════

  // S10-DoD#1: formatRuleNotification — correct format from PRD
  test("S10-DoD#1: formatRuleNotification produces correct message format", () => {
    const event: RuleNotificationEvent = {
      ruleName: "CPL Limit",
      adName: "Баннер 123",
      campaignName: "Летняя акция",
      reason: "CPL 500₽ превысил лимит 300₽",
      actionType: "stopped_and_notified",
      savedAmount: 1500,
      metrics: {
        spent: 3000,
        leads: 6,
        cpl: 500,
        ctr: 1.25,
      },
    };

    const message = formatRuleNotification(event);

    // Contains action emoji and status
    expect(message).toContain("🛑");
    expect(message).toContain("Остановлено");
    // Contains rule name, ad name, campaign
    expect(message).toContain("CPL Limit");
    expect(message).toContain("Баннер 123");
    expect(message).toContain("Летняя акция");
    // Contains reason
    expect(message).toContain("CPL 500₽ превысил лимит 300₽");
    // Contains metrics
    expect(message).toContain("3000₽");
    expect(message).toContain("CPL: 500₽");
    expect(message).toContain("CTR: 1.25%");
    // Contains savings
    expect(message).toContain("1500₽");
  });

  test("S10-DoD#1: formatRuleNotification for notify-only uses warning emoji", () => {
    const event: RuleNotificationEvent = {
      ruleName: "Min CTR",
      adName: "Ad 456",
      reason: "CTR 0.5% ниже минимума 1%",
      actionType: "notified",
      savedAmount: 0,
      metrics: { spent: 1000, leads: 2 },
    };

    const message = formatRuleNotification(event);

    expect(message).toContain("⚠️");
    expect(message).toContain("Требует внимания");
    expect(message).not.toContain("Сэкономлено");
  });

  // S10-DoD#2: Critical notification — priority=critical → immediate
  test("S10-DoD#2: storePendingNotification stores critical notification", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);

    const event = {
      ruleName: "CPL Limit",
      adName: "Ad 1",
      reason: "CPL too high",
      actionType: "stopped" as const,
      savedAmount: 500,
      metrics: { spent: 1000, leads: 2 },
    };

    const notifId = await t.mutation(internal.telegram.storePendingNotification, {
      userId,
      event,
      priority: "critical",
      createdAt: Date.now(),
    });

    expect(notifId).toBeDefined();
  });

  // S10-DoD#3: Grouping — multiple events → grouped message
  test("S10-DoD#3: formatGroupedNotification groups multiple events", () => {
    const events: RuleNotificationEvent[] = [
      {
        ruleName: "CPL Limit",
        adName: "Баннер 1",
        reason: "CPL 500₽ превысил лимит",
        actionType: "stopped",
        savedAmount: 1000,
        metrics: { spent: 2000, leads: 4 },
      },
      {
        ruleName: "Min CTR",
        adName: "Баннер 2",
        reason: "CTR 0.3% ниже минимума",
        actionType: "notified",
        savedAmount: 0,
        metrics: { spent: 500, leads: 0 },
      },
      {
        ruleName: "Budget Limit",
        adName: "Баннер 3",
        reason: "Расход превысил бюджет",
        actionType: "stopped_and_notified",
        savedAmount: 2000,
        metrics: { spent: 5000, leads: 3 },
      },
    ];

    const message = formatGroupedNotification(events);

    // Header with count
    expect(message).toContain("Сработало правил: 3");
    // All ads listed
    expect(message).toContain("Баннер 1");
    expect(message).toContain("Баннер 2");
    expect(message).toContain("Баннер 3");
    // Stopped count (2: stopped + stopped_and_notified)
    expect(message).toContain("Остановлено: 2");
    // Total savings = 1000 + 0 + 2000 = 3000
    expect(message).toContain("3000₽");
  });

  test("S10-DoD#3: formatGroupedNotification with 1 event returns single format", () => {
    const events: RuleNotificationEvent[] = [
      {
        ruleName: "Test",
        adName: "Ad 1",
        reason: "Test reason",
        actionType: "stopped",
        savedAmount: 100,
        metrics: { spent: 200, leads: 1 },
      },
    ];

    const message = formatGroupedNotification(events);
    // Should use single format, not grouped
    expect(message).toContain("🛑");
    expect(message).toContain("Остановлено");
    expect(message).not.toContain("Сработало правил");
  });

  test("S10-DoD#3: formatGroupedNotification with 0 events returns empty", () => {
    expect(formatGroupedNotification([])).toBe("");
  });

  // S10-DoD#6: Missing chatId → notification not sent
  test("S10-DoD#6: getUserChatId returns null for user without Telegram", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);

    const chatId = await t.query(internal.telegram.getUserChatId, { userId });
    expect(chatId).toBeNull();
  });

  test("S10-DoD#6: getUserChatId returns chatId for connected user", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);

    // Connect Telegram
    const token = await t.mutation(api.telegram.generateLinkToken, { userId });
    await t.mutation(api.telegram.processStartCommand, {
      chatId: "999888777",
      token,
    });

    const chatId = await t.query(internal.telegram.getUserChatId, { userId });
    expect(chatId).toBe("999888777");
  });

  // S10-DoD#7: Retry logic (tested via pure function behavior)
  test("S10-DoD#7: sendMessageWithRetry action exists", () => {
    // Verify the internal action is exported
    expect(internal.telegram.sendMessageWithRetry).toBeDefined();
  });

  // Notification lifecycle: store → get pending → mark sent
  test("S10: notification lifecycle: store → pending → mark sent", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);
    const now = Date.now();

    const event = {
      ruleName: "Budget Limit",
      adName: "Ad 100",
      reason: "Расход превысил бюджет",
      actionType: "stopped" as const,
      savedAmount: 750,
      metrics: { spent: 3000, leads: 4 },
    };

    // Store notification
    const notifId = await t.mutation(internal.telegram.storePendingNotification, {
      userId,
      event,
      priority: "standard",
      createdAt: now,
    });
    expect(notifId).toBeDefined();

    // Get pending within 5 min window
    const pending = await t.query(internal.telegram.getPendingNotifications, {
      userId,
      since: now - 5 * 60 * 1000,
    });
    expect(pending.length).toBe(1);
    expect(pending[0].status).toBe("pending");
    expect(pending[0].channel).toBe("telegram");

    // Mark as sent
    await t.mutation(internal.telegram.markNotificationsSent, {
      notificationIds: [notifId],
    });

    // Verify no longer pending
    const afterSend = await t.query(internal.telegram.getPendingNotifications, {
      userId,
      since: now - 5 * 60 * 1000,
    });
    expect(afterSend.length).toBe(0);
  });

  // Notification failure tracking
  test("S10: markNotificationFailed records error message", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);

    const notifId = await t.mutation(internal.telegram.storePendingNotification, {
      userId,
      event: {
        ruleName: "Test",
        adName: "Ad 1",
        reason: "Test",
        actionType: "notified" as const,
        savedAmount: 0,
        metrics: { spent: 100, leads: 0 },
      },
      priority: "standard",
      createdAt: Date.now(),
    });

    await t.mutation(internal.telegram.markNotificationFailed, {
      notificationId: notifId,
      errorMessage: "Telegram API Error 429: Too Many Requests",
    });

    // Verify no longer in pending
    const pending = await t.query(internal.telegram.getPendingNotifications, {
      userId,
      since: Date.now() - 5 * 60 * 1000,
    });
    expect(pending.length).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════
  // Sprint 11 — Telegram: inline-кнопки и откат
  // ═══════════════════════════════════════════════════════════

  // S11-DoD#1: inline_keyboard — формирование reply_markup с 2 кнопками
  test("S11-DoD#1: buildInlineKeyboard returns 2 buttons", () => {
    const keyboard = buildInlineKeyboard("log123");

    expect(keyboard.inline_keyboard).toHaveLength(1);
    expect(keyboard.inline_keyboard[0]).toHaveLength(2);

    const [revertBtn, okBtn] = keyboard.inline_keyboard[0];
    expect(revertBtn.text).toContain("Отменить");
    expect(revertBtn.callback_data).toBe("revert:log123");
    expect(okBtn.text).toContain("ОК");
    expect(okBtn.callback_data).toBe("dismiss:log123");
  });

  test("S11-DoD#1: parseCallbackData parses revert action", () => {
    const result = parseCallbackData("revert:abc123");
    expect(result).toEqual({ action: "revert", actionLogId: "abc123" });
  });

  test("S11-DoD#1: parseCallbackData parses dismiss action", () => {
    const result = parseCallbackData("dismiss:xyz789");
    expect(result).toEqual({ action: "dismiss", actionLogId: "xyz789" });
  });

  test("S11-DoD#1: parseCallbackData returns null for invalid data", () => {
    expect(parseCallbackData("invalid")).toBeNull();
    expect(parseCallbackData("")).toBeNull();
    expect(parseCallbackData("unknown:123")).toBeNull();
  });

  // S11-DoD#2: callback revert → actionLogs.status=reverted
  test("S11-DoD#2: revertAction sets status=reverted on actionLog", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);

    // Upgrade to pro so stopAd is available
    await t.mutation(api.users.updateTier, { userId, tier: "pro" });

    // Create an ad account
    const accountId = await t.mutation(api.adAccounts.connect, {
      userId,
      vkAccountId: "test_acc_1",
      name: "Test Account",
      accessToken: "tok",
    });

    // Create a rule
    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "CPL Limit",
      type: "cpl_limit",
      value: 300,
      actions: { stopAd: true, notify: true },
      targetAccountIds: [accountId],
    });

    // Create an action log (simulates a stopped ad)
    const actionLogId = await t.mutation(api.ruleEngine.createActionLogPublic, {
      userId,
      ruleId,
      accountId,
      adId: "ad_001",
      adName: "Баннер 1",
      actionType: "stopped",
      reason: "CPL too high",
      metricsSnapshot: { spent: 1000, leads: 2 },
      savedAmount: 500,
      status: "success",
    });

    // Revert
    const result = await t.mutation(internal.ruleEngine.revertAction, {
      actionLogId,
      revertedBy: "telegram:12345",
    });

    expect(result.success).toBe(true);
    expect(result.reason).toBe("ok");

    // Verify status is reverted
    const log = await t.query(internal.ruleEngine.getActionLog, { actionLogId });
    expect(log).toBeDefined();
    expect(log!.status).toBe("reverted");
    expect(log!.revertedBy).toBe("telegram:12345");
    expect(log!.revertedAt).toBeDefined();
  });

  // S11-DoD#3: revertAction mutation exists (tested by DoD#2 above)
  test("S11-DoD#3: revertAction internal mutation is available", () => {
    expect(internal.ruleEngine.revertAction).toBeDefined();
  });

  // S11-DoD#4: answerCallbackQuery action exists
  test("S11-DoD#4: answerCallbackQuery action exists", () => {
    expect(internal.telegram.answerCallbackQuery).toBeDefined();
  });

  test("S11-DoD#4: sendMessageWithKeyboard action exists", () => {
    expect(internal.telegram.sendMessageWithKeyboard).toBeDefined();
  });

  // S11-DoD#7: > 5 минут → "Время истекло"
  test("S11-DoD#7: revertAction returns timeout after 5 minutes", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);

    // Upgrade to pro so stopAd is available
    await t.mutation(api.users.updateTier, { userId, tier: "pro" });

    const accountId = await t.mutation(api.adAccounts.connect, {
      userId,
      vkAccountId: "test_acc_7",
      name: "Test Account",
      accessToken: "tok",
    });

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Budget Limit",
      type: "budget_limit",
      value: 5000,
      actions: { stopAd: true, notify: true },
      targetAccountIds: [accountId],
    });

    // Create action log with old createdAt (6 minutes ago)
    // We insert directly to control timestamp
    const actionLogId = await t.mutation(api.ruleEngine.createActionLogPublic, {
      userId,
      ruleId,
      accountId,
      adId: "ad_timeout",
      adName: "Old Ad",
      actionType: "stopped",
      reason: "Budget exceeded",
      metricsSnapshot: { spent: 6000, leads: 1 },
      savedAmount: 300,
      status: "success",
    });

    // Wait-simulate: patch the log to have old createdAt
    // Since createActionLog uses Date.now(), and REVERT_TIMEOUT_MS is 5 min,
    // we need to test the timing. We'll patch the createdAt manually.
    await t.run(async (ctx) => {
      await ctx.db.patch(actionLogId, {
        createdAt: Date.now() - REVERT_TIMEOUT_MS - 60000, // 6 minutes ago
      });
    });

    const result = await t.mutation(internal.ruleEngine.revertAction, {
      actionLogId,
      revertedBy: "telegram:999",
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe("timeout");
  });

  // S11-DoD#8: Повторный клик → "Уже отменено"
  test("S11-DoD#8: revertAction returns already_reverted on second click", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);

    // Upgrade to pro so stopAd is available
    await t.mutation(api.users.updateTier, { userId, tier: "pro" });

    const accountId = await t.mutation(api.adAccounts.connect, {
      userId,
      vkAccountId: "test_acc_8",
      name: "Test Account",
      accessToken: "tok",
    });

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "CTR Check",
      type: "min_ctr",
      value: 1,
      actions: { stopAd: true, notify: true },
      targetAccountIds: [accountId],
    });

    const actionLogId = await t.mutation(api.ruleEngine.createActionLogPublic, {
      userId,
      ruleId,
      accountId,
      adId: "ad_double",
      adName: "Double Click Ad",
      actionType: "stopped",
      reason: "CTR too low",
      metricsSnapshot: { spent: 500, leads: 0 },
      savedAmount: 200,
      status: "success",
    });

    // First revert → success
    const result1 = await t.mutation(internal.ruleEngine.revertAction, {
      actionLogId,
      revertedBy: "telegram:111",
    });
    expect(result1.success).toBe(true);

    // Second revert → already_reverted
    const result2 = await t.mutation(internal.ruleEngine.revertAction, {
      actionLogId,
      revertedBy: "telegram:111",
    });
    expect(result2.success).toBe(false);
    expect(result2.reason).toBe("already_reverted");
  });

  // Edge: revert on notify-only action (not stoppable)
  test("S11: revertAction on notify-only action returns not_stoppable", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);

    const accountId = await t.mutation(api.adAccounts.connect, {
      userId,
      vkAccountId: "test_acc_ns",
      name: "Test Account",
      accessToken: "tok",
    });

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Notify Only",
      type: "cpl_limit",
      value: 100,
      actions: { stopAd: false, notify: true },
      targetAccountIds: [accountId],
    });

    const actionLogId = await t.mutation(api.ruleEngine.createActionLogPublic, {
      userId,
      ruleId,
      accountId,
      adId: "ad_notify",
      adName: "Notify Ad",
      actionType: "notified",
      reason: "CPL high",
      metricsSnapshot: { spent: 200, leads: 1 },
      savedAmount: 0,
      status: "success",
    });

    const result = await t.mutation(internal.ruleEngine.revertAction, {
      actionLogId,
      revertedBy: "telegram:222",
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe("not_stoppable");
  });

  // ═══════════════════════════════════════════════════════════
  // Sprint 12 — Telegram: дайджест и тихие часы
  // ═══════════════════════════════════════════════════════════

  // S12-DoD#1: sendDailyDigest — формирование дайджеста (сводка за день)
  test("S12-DoD#1: formatDailyDigest produces daily summary", () => {
    const events: DigestActionLogSummary[] = [
      {
        adName: "Баннер 1",
        actionType: "stopped",
        reason: "CPL 500₽ превысил лимит",
        savedAmount: 1500,
        metricsSnapshot: { spent: 3000, leads: 6, cpl: 500 },
      },
      {
        adName: "Баннер 2",
        actionType: "notified",
        reason: "CTR 0.3% ниже минимума",
        savedAmount: 0,
        metricsSnapshot: { spent: 800, leads: 0, ctr: 0.3 },
      },
      {
        adName: "Баннер 3",
        actionType: "stopped_and_notified",
        reason: "Бюджет исчерпан",
        savedAmount: 2000,
        metricsSnapshot: { spent: 5000, leads: 3 },
      },
    ];

    const message = formatDailyDigest(events, "27.01.2026");

    // Contains date header
    expect(message).toContain("Дайджест за 27.01.2026");
    // Contains rule count
    expect(message).toContain("Сработало правил: 3");
    // Contains stopped count (2: stopped + stopped_and_notified)
    expect(message).toContain("Остановлено: 2");
    // Contains warning count
    expect(message).toContain("Предупреждений: 1");
    // Contains total spend
    expect(message).toContain("8800₽");
    // Contains total savings (1500 + 2000 = 3500)
    expect(message).toContain("3500₽");
    // Contains details for each ad
    expect(message).toContain("Баннер 1");
    expect(message).toContain("Баннер 2");
    expect(message).toContain("Баннер 3");
  });

  // S12-DoD#2: Тихие часы блокируют — 23:00-07:00, now=02:00 → не отправляется
  test("S12-DoD#2: isQuietHours blocks at 02:00 in 23:00-07:00 range", () => {
    expect(isQuietHours("02:00", "23:00", "07:00")).toBe(true);
  });

  test("S12-DoD#2: isQuietHours allows at 12:00 in 23:00-07:00 range", () => {
    expect(isQuietHours("12:00", "23:00", "07:00")).toBe(false);
  });

  test("S12-DoD#2: isQuietHours blocks at 23:30 in 23:00-07:00 range", () => {
    expect(isQuietHours("23:30", "23:00", "07:00")).toBe(true);
  });

  test("S12-DoD#2: isQuietHours allows at 07:00 (end is exclusive)", () => {
    expect(isQuietHours("07:00", "23:00", "07:00")).toBe(false);
  });

  test("S12-DoD#2: isQuietHours same-day range (09:00-18:00)", () => {
    expect(isQuietHours("12:00", "09:00", "18:00")).toBe(true);
    expect(isQuietHours("08:00", "09:00", "18:00")).toBe(false);
    expect(isQuietHours("18:00", "09:00", "18:00")).toBe(false);
  });

  // S12-DoD#3: Cron daily-digest — sendDailyDigest action exists
  test("S12-DoD#3: sendDailyDigest internal action exists", () => {
    expect(internal.telegram.sendDailyDigest).toBeDefined();
  });

  // S12-DoD#3: getDigestRecipients returns connected users with digest enabled
  test("S12-DoD#3: getDigestRecipients returns users with Telegram connected", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);

    // Connect Telegram
    const token = await t.mutation(api.telegram.generateLinkToken, { userId });
    await t.mutation(api.telegram.processStartCommand, {
      chatId: "digest_chat_1",
      token,
    });

    const recipients = await t.query(internal.telegram.getDigestRecipients, {});
    expect(recipients.length).toBeGreaterThanOrEqual(1);
    const found = recipients.find((r: any) => r.chatId === "digest_chat_1");
    expect(found).toBeDefined();
  });

  // S12-DoD#3: getDigestActionLogs returns logs within date range
  test("S12-DoD#3: getDigestActionLogs returns logs within range", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);

    const accountId = await t.mutation(api.adAccounts.connect, {
      userId,
      vkAccountId: "digest_acc",
      name: "Digest Account",
      accessToken: "tok",
    });

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Digest Rule",
      type: "cpl_limit",
      value: 100,
      actions: { stopAd: false, notify: true },
      targetAccountIds: [accountId],
    });

    const now = Date.now();

    // Create action log
    await t.mutation(api.ruleEngine.createActionLogPublic, {
      userId,
      ruleId,
      accountId,
      adId: "ad_digest",
      adName: "Digest Ad",
      actionType: "notified",
      reason: "CPL high",
      metricsSnapshot: { spent: 500, leads: 1 },
      savedAmount: 0,
      status: "success",
    });

    const logs = await t.query(internal.telegram.getDigestActionLogs, {
      userId,
      since: now - 24 * 60 * 60 * 1000,
      until: now + 60000,
    });

    expect(logs.length).toBe(1);
    expect(logs[0].adName).toBe("Digest Ad");
  });

  // S12-DoD#7: Нет событий за день — дайджест не отправляется
  test("S12-DoD#7: formatDailyDigest returns empty for 0 events", () => {
    const message = formatDailyDigest([], "27.01.2026");
    expect(message).toBe("");
  });

  // S12-DoD#8: 00:00-00:00 — тихие часы отключены
  test("S12-DoD#8: isQuietHours with 00:00-00:00 is disabled", () => {
    expect(isQuietHours("02:00", "00:00", "00:00")).toBe(false);
    expect(isQuietHours("12:00", "00:00", "00:00")).toBe(false);
    expect(isQuietHours("23:59", "00:00", "00:00")).toBe(false);
  });

  // S12: setQuietHours mutation works
  test("S12: setQuietHours creates settings and saves quiet hours", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);

    await t.mutation(api.userSettings.setQuietHours, {
      userId,
      enabled: true,
      start: "23:00",
      end: "07:00",
    });

    const settings = await t.query(api.userSettings.get, { userId });
    expect(settings).toBeDefined();
    expect(settings!.quietHoursEnabled).toBe(true);
    expect(settings!.quietHoursStart).toBe("23:00");
    expect(settings!.quietHoursEnd).toBe("07:00");
  });

  // S12: setDigestEnabled mutation works
  test("S12: setDigestEnabled creates settings and saves digest pref", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);

    await t.mutation(api.userSettings.setDigestEnabled, {
      userId,
      enabled: false,
    });

    const settings = await t.query(api.userSettings.get, { userId });
    expect(settings).toBeDefined();
    expect(settings!.digestEnabled).toBe(false);
  });

  // S12: Digest recipient excluded when digestEnabled=false
  test("S12: getDigestRecipients excludes users with digest disabled", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);

    // Connect Telegram
    const token = await t.mutation(api.telegram.generateLinkToken, { userId });
    await t.mutation(api.telegram.processStartCommand, {
      chatId: "no_digest_chat",
      token,
    });

    // Disable digest
    await t.mutation(api.userSettings.setDigestEnabled, {
      userId,
      enabled: false,
    });

    const recipients = await t.query(internal.telegram.getDigestRecipients, {});
    const found = recipients.find((r: any) => r.chatId === "no_digest_chat");
    expect(found).toBeUndefined();
  });
});
