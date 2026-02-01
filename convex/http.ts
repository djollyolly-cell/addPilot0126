import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

// Telegram Bot webhook endpoint
http.route({
  path: "/telegram",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      // Verify webhook secret token (CSRF protection)
      const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
      if (webhookSecret) {
        const receivedToken = request.headers.get(
          "X-Telegram-Bot-Api-Secret-Token"
        );
        if (receivedToken !== webhookSecret) {
          console.warn(
            "[telegram webhook] Invalid or missing secret token"
          );
          return new Response("Unauthorized", { status: 401 });
        }
      }

      const body = await request.json();
      await ctx.runAction(internal.telegram.handleWebhook, { body });
      return new Response("ok", { status: 200 });
    } catch (error) {
      console.error(
        "[telegram webhook] Error:",
        error instanceof Error ? error.message : error
      );
      // Always return 200 to Telegram to prevent retries
      return new Response("ok", { status: 200 });
    }
  }),
});

// bePaid webhook endpoint for payment notifications
http.route({
  path: "/api/bepaid-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      // Verify Basic Auth credentials (CSRF/replay protection)
      const shopId = process.env.BEPAID_SHOP_ID;
      const secretKey = process.env.BEPAID_SECRET_KEY;

      if (shopId && secretKey) {
        const authHeader = request.headers.get("Authorization");
        if (!authHeader || !authHeader.startsWith("Basic ")) {
          console.warn("[bePaid webhook] Missing or invalid Authorization header");
          return new Response("Unauthorized", { status: 401 });
        }

        // Decode and verify Basic Auth credentials
        const base64Credentials = authHeader.slice(6); // Remove "Basic "
        let decodedCredentials: string;
        try {
          decodedCredentials = atob(base64Credentials);
        } catch {
          console.warn("[bePaid webhook] Invalid Base64 in Authorization header");
          return new Response("Unauthorized", { status: 401 });
        }

        const expectedCredentials = `${shopId}:${secretKey}`;
        if (decodedCredentials !== expectedCredentials) {
          console.warn("[bePaid webhook] Invalid credentials in Authorization header");
          return new Response("Unauthorized", { status: 401 });
        }
      }

      const body = await request.json();

      // bePaid sends transaction data in the body
      // Extract relevant fields
      const transaction = body.transaction;

      if (!transaction) {
        console.error("[bePaid webhook] No transaction in body:", body);
        return new Response("ok", { status: 200 });
      }

      console.log("[bePaid webhook] Received:", {
        uid: transaction.uid,
        status: transaction.status,
        type: transaction.type,
        tracking_id: transaction.tracking_id,
      });

      await ctx.runMutation(internal.billing.handleBepaidWebhook, {
        transactionType: transaction.type || "payment",
        status: transaction.status,
        trackingId: transaction.tracking_id,
        uid: transaction.uid,
        amount: transaction.amount ? parseInt(transaction.amount) / 100 : 0,
        currency: transaction.currency || "BYN",
        message: transaction.message,
      });

      return new Response("ok", { status: 200 });
    } catch (error) {
      console.error(
        "[bePaid webhook] Error:",
        error instanceof Error ? error.message : error
      );
      // Return 200 to prevent retries
      return new Response("ok", { status: 200 });
    }
  }),
});

export default http;
