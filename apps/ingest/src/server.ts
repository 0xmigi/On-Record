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

  // 4xx keep their messages (they describe the caller's mistake); 5xx are
  // logged in full but answered generically — Fastify's default body would
  // echo internal error text (e.g. raw Postgres messages) to the public.
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) {
      logger.error({ url: req.url, err: String(err) }, "api: unhandled error");
      return reply.code(status).send({ error: "internal error" });
    }
    return reply.code(status).send({ error: err.message });
  });

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
