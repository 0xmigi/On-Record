import type { FastifyInstance } from "fastify";
import basicAuth from "@fastify/basic-auth";
import { desc, eq } from "drizzle-orm";
import {
  db,
  schema,
  env,
  logger,
  getConfig,
  newId,
  updateConfig,
  repoSearchStatus,
  type RuntimeConfig,
} from "@onrecord/core";
import { addManualWatch } from "@onrecord/enrich";
import { runVerifiedBackfill } from "../backfill-verified.js";
import { linkOne, sweepRepoLinks } from "../repo-link.js";

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

    // --- seed the index with OtterSec verified programs ----------------------
    // pass { wait: true, max: N } for a synchronous smoke test; omit wait to
    // kick off the full run in the background (logs carry progress).
    admin.post<{ Body: { max?: number; wait?: boolean; reenrich?: boolean } }>(
      "/admin/backfill-verified",
      async (req) => {
        const { max, wait, reenrich } = req.body ?? {};
        if (wait) {
          const result = await runVerifiedBackfill({ network: "mainnet", max, reenrich });
          await log("backfill.verified", null, null, result);
          return { ok: true, ...result };
        }
        void runVerifiedBackfill({ network: "mainnet", max, reenrich })
          .then((r) => log("backfill.verified", null, null, r))
          .catch((err) => logger.error({ err: String(err) }, "verified-backfill route failed"));
        return { ok: true, started: true, max: max ?? "all", reenrich: !!reenrich };
      },
    );

    // --- repo link: run the program-id code search now -----------------------
    // The sweep is hourly and picks its own subjects, which makes "why is this
    // program not linked?" unanswerable from outside. This runs it on demand —
    // with a programId it forces that one program and reports what the row
    // actually looks like, so a miss can be told apart from an exclusion.
    admin.post<{ Body: { programId?: string } }>("/admin/repo-link", async (req, reply) => {
      const programId = req.body?.programId;
      // presence only — never echo the token itself
      if (!env.GITHUB_TOKEN) {
        return reply.code(400).send({ error: "GITHUB_TOKEN is not set on this service" });
      }
      if (!programId) {
        const result = await sweepRepoLinks("mainnet");
        await log("repo-link.sweep", null, null, result);
        return { ok: true, search: repoSearchStatus(), ...result };
      }
      const rows = await db.select().from(schema.subjects).where(eq(schema.subjects.id, programId));
      const row = rows[0];
      if (!row) return reply.code(404).send({ error: "subject not found" });
      const facts = (row.facts ?? {}) as Record<string, unknown>;
      const link = await linkOne(programId, row.crate, "mainnet", true);
      await log("repo-link.one", programId, facts.repoLink ?? null, link);
      return {
        ok: true,
        link,
        // what GitHub last said — separates "no repo exists" from "the token
        // was refused", which look identical in the link alone
        search: repoSearchStatus(),
        // the row as the sweep sees it — this is what explains a skip
        subject: {
          band: row.noveltyBand,
          crate: row.crate,
          repoUrl: row.repoUrl,
          closedAt: facts.closedAt ?? null,
          firstSeenAt: row.firstSeenAt,
          previouslyCheckedAt: facts.repoLinkCheckedAt ?? null,
        },
      };
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
