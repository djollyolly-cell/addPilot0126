"use node";

/**
 * Email Service
 * Email Notifications via Yandex SMTP (nodemailer)
 */

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import nodemailer from "nodemailer";

// ═══════════════════════════════════════════════════════════
// Yandex SMTP Configuration
// ═══════════════════════════════════════════════════════════

function createTransporter() {
  const user = process.env.YANDEX_EMAIL;
  const pass = process.env.YANDEX_APP_PASSWORD;

  if (!user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host: "smtp.yandex.ru",
    port: 465,
    secure: true, // SSL
    auth: {
      user,
      pass,
    },
  });
}

// ═══════════════════════════════════════════════════════════
// Email Templates
// ═══════════════════════════════════════════════════════════

// Rule triggered notification template
function getRuleTriggeredEmailHtml(params: {
  ruleName: string;
  campaignName: string;
  metricValue: number;
  threshold: number;
  condition: string;
  actionTaken: string;
  timestamp: string;
}): string {
  const { ruleName, campaignName, metricValue, threshold, condition, actionTaken, timestamp } = params;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AddPilot - Правило сработало</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="background-color: #3b82f6; padding: 24px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px;">AddPilot</h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 32px;">
              <h2 style="margin: 0 0 16px 0; color: #1f2937; font-size: 20px;">Правило сработало</h2>

              <div style="background-color: #fef3c7; border-left: 4px solid #f59e0b; padding: 16px; margin-bottom: 24px; border-radius: 0 4px 4px 0;">
                <p style="margin: 0; color: #92400e; font-weight: 600;">${ruleName}</p>
              </div>

              <table width="100%" cellpadding="8" cellspacing="0" style="margin-bottom: 24px;">
                <tr>
                  <td style="color: #6b7280; width: 140px;">Кампания:</td>
                  <td style="color: #1f2937; font-weight: 500;">${campaignName}</td>
                </tr>
                <tr>
                  <td style="color: #6b7280;">Условие:</td>
                  <td style="color: #1f2937;">${condition}</td>
                </tr>
                <tr>
                  <td style="color: #6b7280;">Значение:</td>
                  <td style="color: #dc2626; font-weight: 600;">${metricValue} (порог: ${threshold})</td>
                </tr>
                <tr>
                  <td style="color: #6b7280;">Действие:</td>
                  <td style="color: #059669; font-weight: 500;">${actionTaken}</td>
                </tr>
                <tr>
                  <td style="color: #6b7280;">Время:</td>
                  <td style="color: #1f2937;">${timestamp}</td>
                </tr>
              </table>

              <a href="https://adpilot.ru/logs" style="display: inline-block; background-color: #3b82f6; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 500;">Открыть логи</a>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f9fafb; padding: 16px; text-align: center; border-top: 1px solid #e5e7eb;">
              <p style="margin: 0; color: #9ca3af; font-size: 12px;">
                Это автоматическое уведомление от AddPilot.<br>
                Настроить уведомления можно в <a href="https://adpilot.ru/settings" style="color: #3b82f6;">настройках</a>.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

// Subscription expiry notification template
function getExpiryEmailHtml(params: {
  userName: string;
  tierName: string;
  daysLeft: number;
  expiresAt: string;
}): string {
  const { userName, tierName, daysLeft, expiresAt } = params;

  const urgencyColor = daysLeft <= 1 ? "#dc2626" : "#f59e0b";
  const urgencyBg = daysLeft <= 1 ? "#fef2f2" : "#fef3c7";

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AddPilot - Подписка истекает</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="background-color: #3b82f6; padding: 24px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px;">AddPilot</h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 32px;">
              <p style="margin: 0 0 16px 0; color: #1f2937;">Здравствуйте${userName ? `, ${userName}` : ""}!</p>

              <div style="background-color: ${urgencyBg}; border-left: 4px solid ${urgencyColor}; padding: 16px; margin-bottom: 24px; border-radius: 0 4px 4px 0;">
                <p style="margin: 0; color: ${urgencyColor}; font-weight: 600;">
                  ${daysLeft <= 1 ? "Ваша подписка истекает завтра!" : `Ваша подписка истекает через ${daysLeft} дней`}
                </p>
              </div>

              <table width="100%" cellpadding="8" cellspacing="0" style="margin-bottom: 24px;">
                <tr>
                  <td style="color: #6b7280; width: 140px;">Тариф:</td>
                  <td style="color: #1f2937; font-weight: 500;">${tierName}</td>
                </tr>
                <tr>
                  <td style="color: #6b7280;">Действует до:</td>
                  <td style="color: #1f2937;">${expiresAt}</td>
                </tr>
              </table>

              <p style="margin: 0 0 24px 0; color: #6b7280;">
                После истечения подписки ваш аккаунт будет переведён на бесплатный тариф Freemium с ограничениями.
              </p>

              <a href="https://adpilot.ru/pricing" style="display: inline-block; background-color: #3b82f6; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 500;">Продлить подписку</a>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f9fafb; padding: 16px; text-align: center; border-top: 1px solid #e5e7eb;">
              <p style="margin: 0; color: #9ca3af; font-size: 12px;">
                Это автоматическое уведомление от AddPilot.<br>
                Настроить уведомления можно в <a href="https://adpilot.ru/settings" style="color: #3b82f6;">настройках</a>.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

// ═══════════════════════════════════════════════════════════
// Email Sending Functions
// ═══════════════════════════════════════════════════════════

// Send rule triggered notification email (internal)
export const sendRuleNotificationEmail = internalAction({
  args: {
    userId: v.id("users"),
    ruleName: v.string(),
    campaignName: v.string(),
    metricValue: v.number(),
    threshold: v.number(),
    condition: v.string(),
    actionTaken: v.string(),
  },
  handler: async (ctx, args): Promise<{ success: boolean; error?: string }> => {
    const transporter = createTransporter();
    const fromEmail = process.env.YANDEX_EMAIL;

    if (!transporter || !fromEmail) {
      console.log("[email] Yandex SMTP not configured, skipping email");
      return { success: false, error: "Email service not configured" };
    }

    // Get user email
    const user = await ctx.runQuery(internal.users.getById, { userId: args.userId });
    if (!user || !user.email) {
      return { success: false, error: "User not found or no email" };
    }

    // Skip fake VK emails
    if (user.email.endsWith("@vk.com")) {
      console.log(`[email] Skipping fake VK email: ${user.email}`);
      return { success: false, error: "No real email available" };
    }

    const timestamp = new Date().toLocaleString("ru-RU", {
      timeZone: "Europe/Moscow",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    try {
      await transporter.sendMail({
        from: `AddPilot <${fromEmail}>`,
        to: user.email,
        subject: `AddPilot: Правило "${args.ruleName}" сработало`,
        html: getRuleTriggeredEmailHtml({
          ruleName: args.ruleName,
          campaignName: args.campaignName,
          metricValue: args.metricValue,
          threshold: args.threshold,
          condition: args.condition,
          actionTaken: args.actionTaken,
          timestamp,
        }),
      });

      console.log(`[email] Rule notification sent to ${user.email}`);
      return { success: true };
    } catch (err) {
      console.error("[email] Error sending email:", err);
      return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
    }
  },
});

// Send subscription expiry notification email (internal)
export const sendExpiryNotificationEmail = internalAction({
  args: {
    userId: v.id("users"),
    daysLeft: v.number(),
  },
  handler: async (ctx, args): Promise<{ success: boolean; error?: string }> => {
    const transporter = createTransporter();
    const fromEmail = process.env.YANDEX_EMAIL;

    if (!transporter || !fromEmail) {
      console.log("[email] Yandex SMTP not configured, skipping email");
      return { success: false, error: "Email service not configured" };
    }

    // Get user info
    const user = await ctx.runQuery(internal.users.getById, { userId: args.userId });
    if (!user || !user.email) {
      return { success: false, error: "User not found or no email" };
    }

    // Skip fake VK emails
    if (user.email.endsWith("@vk.com")) {
      console.log(`[email] Skipping fake VK email: ${user.email}`);
      return { success: false, error: "No real email available" };
    }

    const tierNames: Record<string, string> = {
      start: "Start",
      pro: "Pro",
      freemium: "Freemium",
    };

    const expiresAt = user.subscriptionExpiresAt
      ? new Date(user.subscriptionExpiresAt).toLocaleDateString("ru-RU", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        })
      : "Неизвестно";

    try {
      await transporter.sendMail({
        from: `AddPilot <${fromEmail}>`,
        to: user.email,
        subject: args.daysLeft <= 1
          ? "AddPilot: Ваша подписка истекает завтра!"
          : `AddPilot: Подписка истекает через ${args.daysLeft} дней`,
        html: getExpiryEmailHtml({
          userName: user.name || "",
          tierName: tierNames[user.subscriptionTier] || user.subscriptionTier,
          daysLeft: args.daysLeft,
          expiresAt,
        }),
      });

      console.log(`[email] Expiry notification sent to ${user.email}`);
      return { success: true };
    } catch (err) {
      console.error("[email] Error sending email:", err);
      return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
    }
  },
});

// Test email sending (for debugging)
export const sendTestEmail = action({
  args: {
    to: v.string(),
  },
  handler: async (_ctx, args): Promise<{ success: boolean; error?: string }> => {
    const transporter = createTransporter();
    const fromEmail = process.env.YANDEX_EMAIL;

    if (!transporter || !fromEmail) {
      return { success: false, error: "YANDEX_EMAIL or YANDEX_APP_PASSWORD not configured" };
    }

    try {
      await transporter.sendMail({
        from: `AddPilot <${fromEmail}>`,
        to: args.to,
        subject: "AddPilot: Тестовое письмо",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #3b82f6;">Тестовое письмо от AddPilot</h1>
            <p>Если вы видите это письмо, email-уведомления через Яндекс почту работают корректно.</p>
            <p style="color: #666;">Время отправки: ${new Date().toLocaleString("ru-RU")}</p>
          </div>
        `,
      });

      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
    }
  },
});
