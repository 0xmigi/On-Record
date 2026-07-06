import Fastify from "fastify";
import { env, logger } from "@onrecord/core";
import { registerWebhookRoutes } from "./routes/webhook.js";
import { registerPublicRoutes } from "./routes/public.js";
import { registerAdminRoutes } from "./routes/admin.js";

const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });

// permissive CORS on the read API — it's a public record
app.addHook("onSend", async (req, reply) => {
  if (req.url.startsWith("/api") || req.url.startsWith("/rss")) {
    reply.header("access-control-allow-origin", "*");
  }
});

registerWebhookRoutes(app);
registerPublicRoutes(app);
await registerAdminRoutes(app);

await app.listen({ port: env.PORT, host: "0.0.0.0" });
logger.info({ port: env.PORT }, "onrecord ingest API listening");
