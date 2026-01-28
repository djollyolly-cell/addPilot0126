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

export default http;
