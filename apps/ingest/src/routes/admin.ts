import type { FastifyInstance } from "fastify";
import basicAuth from "@fastify/basic-auth";
import { desc, eq } from "drizzle-orm";
import {
  db,
  schema,
  enqueue,
  env,
  getConfig,
  newId,
  updateConfig,
  type RuntimeConfig,
  type WriteJob,
} from "@onrecord/core";
import { addManualWatch } from "@onrecord/enrich";

// ---------------------------------------------------------------------------
// Operator levers (spec §1.5). No human is needed for a story to publish, but
// these are the newsroom controls: kill/pin, name things, feed announcements,
// tune thresholds and tone, watch programs, review the dead-letter pile.
// Every lever pull is logged — edits are part of the record.
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

    // --- story controls -----------------------------------------------------
    const setStoryStatus = (action: string, status: string) =>
      admin.post<{ Params: { id: string } }>(`/admin/stories/:id/${action}`, async (req, reply) => {
        const rows = await db.select().from(schema.stories).where(eq(schema.stories.id, req.params.id));
        if (!rows[0]) return reply.code(404).send({ error: "story not found" });
        await db.update(schema.stories).set({ status }).where(eq(schema.stories.id, req.params.id));
        await log(`story.${action}`, req.params.id, { status: rows[0].status }, { status });
        return { ok: true };
      });
    setStoryStatus("kill", "killed");
    setStoryStatus("pin", "pinned");
    setStoryStatus("unpin", "published");
    setStoryStatus("restore", "published");

    // --- naming lever: attach a name to an unknown subject or copy-bucket ----
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
          if (!rows[0]) return reply.code(404).send({ error: "bucket not found" });
          await db.update(schema.copyBuckets).set({ label: name }).where(eq(schema.copyBuckets.id, bucketId));
          await log("name.bucket", bucketId, { label: rows[0].label }, { label: name });
        }
        return { ok: true };
      },
    );

    // --- announcement lever → corroboration/discrepancy story job ------------
    admin.post<{ Body: { url: string; programId: string } }>(
      "/admin/announcement",
      async (req, reply) => {
        const { url, programId } = req.body ?? ({} as never);
        if (!url || !programId) return reply.code(400).send({ error: "need url and programId" });

        const recent = await db
          .select()
          .from(schema.events)
          .where(eq(schema.events.programId, programId))
          .orderBy(desc(schema.events.slot))
          .limit(1);

        await enqueue("write", {
          eventId: recent[0]?.id ?? "",
          storyType: "corroboration",
          announcementUrl: url,
          programId,
        } satisfies WriteJob);
        await log("announcement", programId, null, { url, hasOnChainRecord: Boolean(recent[0]) });
        return { ok: true, hasOnChainRecord: Boolean(recent[0]) };
      },
    );

    // --- thresholds, weights, budgets, tone notes -----------------------------
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

    // --- dead-letter review ---------------------------------------------------
    admin.get("/admin/dead-letter", async () => {
      const rows = await db
        .select()
        .from(schema.stories)
        .where(eq(schema.stories.status, "dead_letter"))
        .orderBy(desc(schema.stories.createdAt))
        .limit(100);
      return rows.map((r) => ({
        id: r.id,
        type: r.type,
        headline: r.headline,
        body: r.body,
        reason: r.deadLetterReason,
        eventIds: r.eventIds,
        createdAt: r.createdAt.toISOString(),
      }));
    });

    admin.post<{ Params: { id: string } }>("/admin/dead-letter/:id/retry", async (req, reply) => {
      const rows = await db.select().from(schema.stories).where(eq(schema.stories.id, req.params.id));
      const story = rows[0];
      if (!story || story.status !== "dead_letter") {
        return reply.code(404).send({ error: "dead-letter story not found" });
      }
      const eventId = story.eventIds[0] ?? "";
      await enqueue("write", { eventId, storyType: story.type } satisfies WriteJob);
      await db.update(schema.stories).set({ status: "killed" }).where(eq(schema.stories.id, story.id));
      await log("deadletter.retry", story.id, { reason: story.deadLetterReason }, { requeued: true });
      return { ok: true };
    });

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
