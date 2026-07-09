import type { FastifyInstance } from "fastify";
import basicAuth from "@fastify/basic-auth";
import { desc, eq } from "drizzle-orm";
import {
  db,
  schema,
  env,
  getConfig,
  newId,
  updateConfig,
  type RuntimeConfig,
} from "@onrecord/core";
import { addManualWatch } from "@onrecord/enrich";

// ---------------------------------------------------------------------------
// Operator levers (SPEC §5). The radar runs itself; these are the controls:
// name unknown programs / clone clusters, tune thresholds + novelty weights,
// watch a program or authority. Every lever pull is logged — edits are part of
// the record.
// ---------------------------------------------------------------------------

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  await app.register(basicAuth, {
    validate: async (username, password) => {
      if (!env.ADMIN_PASSWORD || username !== "admin" || password !== env.ADMIN_PASSWORD) {
        return new Error("bad credentials");
      }
    },
    authenticate: { realm: "onrecord-admin" },
  });

  app.register(async (admin) => {
    admin.addHook("onRequest", admin.basicAuth);

    // CORS for the web admin page (basic-auth header comes from the browser)
    admin.addHook("onSend", async (_req, reply) => {
      reply.header("access-control-allow-origin", "*");
      reply.header("access-control-allow-headers", "authorization, content-type");
      reply.header("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
    });
    admin.options("/*", async (_req, reply) => reply.code(204).send());

    const log = async (action: string, target: string | null, before: unknown, after: unknown) => {
      await db.insert(schema.operatorLog).values({
        id: newId("opl"),
        actor: "admin",
        action,
        target,
        before,
        after,
      });
    };

    // --- naming lever: attach a name to an unknown program or clone cluster --
    admin.post<{ Body: { subjectId?: string; bucketId?: string; name: string } }>(
      "/admin/name",
      async (req, reply) => {
        const { subjectId, bucketId, name } = req.body ?? ({} as never);
        if (!name || (!subjectId && !bucketId)) {
          return reply.code(400).send({ error: "need name and subjectId or bucketId" });
        }
        if (subjectId) {
          const rows = await db.select().from(schema.subjects).where(eq(schema.subjects.id, subjectId));
          if (!rows[0]) return reply.code(404).send({ error: "subject not found" });
          await db
            .update(schema.subjects)
            .set({ name, updatedAt: new Date() })
            .where(eq(schema.subjects.id, subjectId));
          await log("name.subject", subjectId, { name: rows[0].name }, { name });
        }
        if (bucketId) {
          const rows = await db.select().from(schema.copyBuckets).where(eq(schema.copyBuckets.id, bucketId));
          if (!rows[0]) return reply.code(404).send({ error: "cluster not found" });
          await db.update(schema.copyBuckets).set({ label: name }).where(eq(schema.copyBuckets.id, bucketId));
          await log("name.cluster", bucketId, { label: rows[0].label }, { label: name });
        }
        return { ok: true };
      },
    );

    // --- thresholds, novelty weights, windows --------------------------------
    admin.get("/admin/config", async () => getConfig());
    admin.put<{ Body: Partial<RuntimeConfig> }>("/admin/config", async (req) => {
      const before = await getConfig();
      const after = await updateConfig(req.body ?? {});
      await log("config.update", null, before, after);
      return after;
    });

    // --- watchlist add --------------------------------------------------------
    admin.post<{ Body: { programId?: string; authority?: string; note?: string } }>(
      "/admin/watchlist",
      async (req, reply) => {
        const { programId, authority, note } = req.body ?? ({} as never);
        if (!programId && !authority) {
          return reply.code(400).send({ error: "need programId or authority" });
        }
        const id = await addManualWatch({ programId, authority, note });
        await log("watchlist.add", id, null, { programId, authority, note });
        return { ok: true, id };
      },
    );

    // --- the record of the record ---------------------------------------------
    admin.get("/admin/log", async () => {
      const rows = await db
        .select()
        .from(schema.operatorLog)
        .orderBy(desc(schema.operatorLog.at))
        .limit(200);
      return rows.map((r) => ({
        id: r.id,
        actor: r.actor,
        action: r.action,
        target: r.target,
        before: r.before,
        after: r.after,
        at: r.at.toISOString(),
      }));
    });
  });
}
