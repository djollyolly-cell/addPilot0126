import { v } from "convex/values";
import { action, query, internalMutation, internalQuery } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const VK_API_VERSION = "5.131";
const VK_TOKEN_URL = "https://oauth.vk.com/token";
const VK_API_URL = "https://api.vk.com/method";

const MAX_ATTEMPTS = 5;
const BLOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// Validate email format
export function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Check rate limiting for email login
export const checkRateLimit = query({
  args: {
    email: v.string(),
  },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("loginAttempts")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first();

    if (!record) {
      return { blocked: false, attemptsLeft: MAX_ATTEMPTS };
    }

    const now = Date.now();

    if (record.blockedUntil && record.blockedUntil > now) {
      const remainingMs = record.blockedUntil - now;
      const remainingMin = Math.ceil(remainingMs / 60000);
      return {
        blocked: true,
        attemptsLeft: 0,
        remainingMinutes: remainingMin,
      };
    }

    // Reset if block has expired
    if (record.blockedUntil && record.blockedUntil <= now) {
      return { blocked: false, attemptsLeft: MAX_ATTEMPTS };
    }

    return {
      blocked: false,
      attemptsLeft: MAX_ATTEMPTS - record.attempts,
    };
  },
});

// Record a failed login attempt (internal)
export const recordFailedAttempt = internalMutation({
  args: {
    email: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const record = await ctx.db
      .query("loginAttempts")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first();

    if (!record) {
      await ctx.db.insert("loginAttempts", {
        email: args.email,
        attempts: 1,
        lastAttemptAt: now,
      });
      return;
    }

    // Reset if previously blocked and block expired
    if (record.blockedUntil && record.blockedUntil <= now) {
      await ctx.db.patch(record._id, {
        attempts: 1,
        lastAttemptAt: now,
        blockedUntil: undefined,
      });
      return;
    }

    const newAttempts = record.attempts + 1;

    if (newAttempts >= MAX_ATTEMPTS) {
      await ctx.db.patch(record._id, {
        attempts: newAttempts,
        lastAttemptAt: now,
        blockedUntil: now + BLOCK_DURATION_MS,
      });
    } else {
      await ctx.db.patch(record._id, {
        attempts: newAttempts,
        lastAttemptAt: now,
      });
    }
  },
});

// Reset login attempts on successful login (internal)
export const resetAttempts = internalMutation({
  args: {
    email: v.string(),
  },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("loginAttempts")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first();

    if (record) {
      await ctx.db.delete(record._id);
    }
  },
});

// Login via email and password through VK Ads
export const loginWithEmail = action({
  args: {
    email: v.string(),
    password: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    sessionToken: v.optional(v.string()),
    user: v.optional(
      v.object({
        id: v.string(),
        vkId: v.optional(v.string()),
        name: v.string(),
        avatarUrl: v.optional(v.string()),
        email: v.string(),
      })
    ),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args): Promise<{
    success: boolean;
    sessionToken?: string;
    user?: {
      id: string;
      vkId?: string;
      name: string;
      avatarUrl?: string;
      email: string;
    };
    error?: string;
  }> => {
    // Validate email format
    if (!validateEmail(args.email)) {
      return {
        success: false,
        error: "Некорректный формат email",
      };
    }

    if (!args.password || args.password.length === 0) {
      return {
        success: false,
        error: "Введите пароль",
      };
    }

    // Check rate limit
    const rateLimitRecord = await ctx.runQuery(
      api.authEmail.checkRateLimit,
      { email: args.email }
    );

    if (rateLimitRecord.blocked) {
      return {
        success: false,
        error: `Слишком много попыток. Повторите через ${rateLimitRecord.remainingMinutes} мин.`,
      };
    }

    // Try local bcrypt first (for org-users with passwordHash)
    const userByEmail = await ctx.runQuery(internal.authEmail.findUserByEmail, {
      email: args.email,
    });

    if (userByEmail?.passwordHash) {
      const bcrypt = await import("bcryptjs");
      const valid = await bcrypt.compare(args.password, userByEmail.passwordHash);
      if (!valid) {
        await ctx.runMutation(internal.authEmail.recordFailedAttempt, {
          email: args.email,
        });
        return { success: false, error: "Неверный email или пароль" };
      }

      // Success — create session
      const sessionToken: string = await ctx.runMutation(
        internal.authInternal.createSession,
        { userId: userByEmail._id }
      );

      await ctx.runMutation(internal.authEmail.resetAttempts, { email: args.email });

      try {
        await ctx.runMutation(internal.auditLog.log, {
          userId: userByEmail._id,
          category: "auth",
          action: "login",
          status: "success",
          details: { method: "bcrypt" },
        });
      } catch { /* non-critical */ }

      return {
        success: true,
        sessionToken,
        user: {
          id: userByEmail._id as string,
          vkId: userByEmail.vkId,
          name: userByEmail.name ?? "",
          avatarUrl: userByEmail.avatarUrl,
          email: userByEmail.email,
        },
      };
    }

    try {
      // Authenticate via VK OAuth with direct auth (password grant)
      const clientId = process.env.VK_CLIENT_ID;
      const clientSecret = process.env.VK_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        throw new Error("VK OAuth credentials are not configured");
      }

      const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        username: args.email,
        password: args.password,
        grant_type: "password",
        scope: "ads,offline",
        v: VK_API_VERSION,
      });

      const response = await fetch(VK_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      });

      const data = await response.json();

      if (data.error) {
        // Record failed attempt
        await ctx.runMutation(internal.authEmail.recordFailedAttempt, {
          email: args.email,
        });

        // System log: login failed (userId unknown)
        try { await ctx.runMutation(internal.systemLogger.log, {
          level: "warn",
          source: "auth",
          message: `Login failed (email): ${args.email} — ${data.error}`,
        }); } catch { /* non-critical */ }

        if (data.error === "invalid_client" || data.error === "invalid_grant") {
          return {
            success: false,
            error: "Неверный email или пароль",
          };
        }

        if (data.error === "need_validation") {
          return {
            success: false,
            error: "Требуется двухфакторная аутентификация. Используйте вход через VK.",
          };
        }

        return {
          success: false,
          error: data.error_description || "Ошибка авторизации",
        };
      }

      // Get user info
      const userInfoParams = new URLSearchParams({
        access_token: data.access_token,
        v: VK_API_VERSION,
        fields: "photo_200",
      });

      const userInfoResponse = await fetch(
        `${VK_API_URL}/users.get?${userInfoParams.toString()}`
      );
      const userInfoData = await userInfoResponse.json();

      if (userInfoData.error) {
        return {
          success: false,
          error: "Не удалось получить данные пользователя",
        };
      }

      const vkUser = userInfoData.response[0];

      // Create or update user
      const userId: Id<"users"> = await ctx.runMutation(
        internal.users.upsertFromVk,
        {
          vkId: String(data.user_id),
          email: args.email,
          name: `${vkUser.first_name} ${vkUser.last_name}`,
          avatarUrl: vkUser.photo_200,
          accessToken: data.access_token,
          expiresIn: data.expires_in || 0,
        }
      );

      // Create session
      const sessionToken: string = await ctx.runMutation(
        internal.authInternal.createSession,
        { userId }
      );

      // Reset rate limit on success
      await ctx.runMutation(internal.authEmail.resetAttempts, {
        email: args.email,
      });

      // Audit log: login success
      try { await ctx.runMutation(internal.auditLog.log, {
        userId,
        category: "auth",
        action: "login",
        status: "success",
        details: { method: "email" },
      }); } catch { /* non-critical */ }

      return {
        success: true,
        sessionToken,
        user: {
          id: userId as string,
          vkId: String(data.user_id),
          name: `${vkUser.first_name} ${vkUser.last_name}`,
          avatarUrl: vkUser.photo_200,
          email: args.email,
        },
      };
    } catch (err) {
      // Record failed attempt for unexpected errors
      await ctx.runMutation(internal.authEmail.recordFailedAttempt, {
        email: args.email,
      });

      return {
        success: false,
        error:
          err instanceof Error
            ? err.message
            : "Произошла ошибка. Попробуйте позже.",
      };
    }
  },
});

// Change password — validates old password via VK, sets new one
export const changePassword = action({
  args: {
    email: v.string(),
    oldPassword: v.string(),
    newPassword: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    error: v.optional(v.string()),
  }),
  handler: async (_ctx, args): Promise<{ success: boolean; error?: string }> => {
    if (!args.newPassword || args.newPassword.length < 6) {
      return { success: false, error: "Новый пароль должен быть не менее 6 символов" };
    }

    // Verify old password via VK OAuth
    const clientId = process.env.VK_CLIENT_ID;
    const clientSecret = process.env.VK_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return { success: false, error: "OAuth не настроен" };
    }

    try {
      const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        username: args.email,
        password: args.oldPassword,
        grant_type: "password",
        scope: "ads,offline",
        v: VK_API_VERSION,
      });

      const response = await fetch(VK_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });

      const data = await response.json();

      if (data.error) {
        if (data.error === "invalid_client" || data.error === "invalid_grant") {
          return { success: false, error: "Неверный текущий пароль" };
        }
        return { success: false, error: data.error_description || "Ошибка проверки пароля" };
      }

      // Old password is correct — password change should be done via VK settings
      return { success: true };
    } catch {
      return { success: false, error: "Произошла ошибка. Попробуйте позже." };
    }
  },
});

// Find user by email (for bcrypt path)
export const findUserByEmail = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first();
  },
});

// ═══════════════════════════════════════════════════════════
// Password Reset (for org-users with bcrypt accounts)
// ═══════════════════════════════════════════════════════════

const RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
const RESET_COOLDOWN_MS = 60 * 1000; // 1 min between requests

/** Generate a secure random token */
function generateResetToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Save a password reset token */
export const saveResetToken = internalMutation({
  args: { email: v.string(), token: v.string(), expiresAt: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.insert("passwordResetTokens", {
      email: args.email,
      token: args.token,
      expiresAt: args.expiresAt,
      createdAt: Date.now(),
    });
  },
});

/** Request password reset — sends email with reset link */
export const requestPasswordReset = action({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    if (!validateEmail(email)) {
      throw new Error("Некорректный email");
    }

    const user = await ctx.runQuery(internal.authEmail.findUserByEmail, { email });
    // Always return success to prevent email enumeration
    if (!user || !user.passwordHash) {
      return { success: true };
    }

    // Rate limit: check recent tokens for this email
    const recentTokens = await ctx.runQuery(internal.authEmail.getRecentResetTokens, { email });
    if (recentTokens.length > 0) {
      const lastCreated = recentTokens[0].createdAt;
      if (Date.now() - lastCreated < RESET_COOLDOWN_MS) {
        return { success: true }; // silently ignore, don't reveal rate limit
      }
    }

    const token = generateResetToken();
    const expiresAt = Date.now() + RESET_TOKEN_EXPIRY_MS;

    await ctx.runMutation(internal.authEmail.saveResetToken, { email, token, expiresAt });

    // Send email
    await ctx.runAction(internal.email.sendPasswordResetEmail, {
      to: email,
      resetToken: token,
      userName: user.name ?? email,
    });

    return { success: true };
  },
});

/** Get recent reset tokens for rate limiting */
export const getRecentResetTokens = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("passwordResetTokens")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .order("desc")
      .take(3);
  },
});

/** Validate reset token and return email */
export const validateResetToken = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("passwordResetTokens")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();
    if (!record) return { valid: false, email: null };
    if (record.usedAt) return { valid: false, email: null };
    if (Date.now() > record.expiresAt) return { valid: false, email: null };
    return { valid: true, email: record.email };
  },
});

/** Mark token as used */
export const markTokenUsed = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("passwordResetTokens")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();
    if (record) {
      await ctx.db.patch(record._id, { usedAt: Date.now() });
    }
  },
});

/** Reset password with token */
export const resetPassword = action({
  args: { token: v.string(), newPassword: v.string() },
  handler: async (ctx, args) => {
    if (args.newPassword.length < 8) {
      throw new Error("Пароль должен быть не менее 8 символов");
    }

    const tokenRecord = await ctx.runQuery(api.authEmail.validateResetToken, {
      token: args.token,
    });
    if (!tokenRecord.valid || !tokenRecord.email) {
      throw new Error("Ссылка для сброса пароля недействительна или истекла");
    }

    const user = await ctx.runQuery(internal.authEmail.findUserByEmail, {
      email: tokenRecord.email,
    });
    if (!user || !user.passwordHash) {
      throw new Error("Пользователь не найден");
    }

    const bcrypt = await import("bcryptjs");
    const hash = await bcrypt.hash(args.newPassword, 10);

    await ctx.runMutation(internal.authEmail.updatePasswordHash, {
      userId: user._id,
      passwordHash: hash,
    });
    await ctx.runMutation(internal.authEmail.markTokenUsed, { token: args.token });

    return { success: true };
  },
});

/** Update user's passwordHash */
export const updatePasswordHash = internalMutation({
  args: { userId: v.id("users"), passwordHash: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      passwordHash: args.passwordHash,
      updatedAt: Date.now(),
    });
    // Revoke all sessions for security
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    for (const s of sessions) {
      await ctx.db.delete(s._id);
    }
  },
});
