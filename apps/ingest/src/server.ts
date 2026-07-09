import Fastify, { type FastifyInstance } from "fastify";
import { env, logger } from "@onrecord/core";
import { registerWebhookRoutes } from "./routes/webhook.js";
import { registerPublicRoutes } from "./routes/public.js";
import { registerAdminRoutes } from "./routes/admin.js";

// Build the API with every route registered but not yet listening. Shared by
// the standalone API entry (below) and the single-process live entry (live.ts),
// so the routing wiring lives in exactly one place.
export async function createApp(): Promise<FastifyInstance> {
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
  return app;
}

export async function startServer(): Promise<FastifyInstance> {
  const app = await createApp();
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  logger.info({ port: env.PORT }, "onrecord ingest API listening");
  return app;
}

// Run directly (dev:ingest / start) — skipped when imported by live.ts.
const isMain =
  process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (isMain) await startServer();
