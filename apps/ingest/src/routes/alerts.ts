import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema, logger, newId } from "@onrecord/core";
import {
  ADDRESS_RE,
  CHANNELS,
  assertPublicHttpsUrl,
  programsControlledBy,
  sendWebhook,
  testText,
  type Channel,
} from "../alerts.js";

// ---------------------------------------------------------------------------
// Verification alert sign-up. See alerts.ts for what gets watched and when a
// ping goes out.
//
// Unauthenticated writes, so: addresses must look like addresses, webhooks must
// be public https URLs that accept a test ping before anything is stored, and
// sign-ups are rate limited per caller and per target.
// ---------------------------------------------------------------------------

const MANAGE_RE = /^[A-Za-z0-9_-]{24,64}$/;
const WINDOW_MS = 3_600_000;
const PER_CALLER = 10;
const attempts = new Map<string, number[]>();

function limited(key: string): boolean {
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  attempts.set(key, recent);
  return recent.length > PER_CALLER;
}

export function registerAlertRoutes(app: FastifyInstance): void {
  // what an address would watch — the sign-up form shows this before subscribing
  app.get<{ Querystring: { address?: string } }>("/api/alerts/programs", async (req, reply) => {
    const address = (req.query.address ?? "").trim();
    if (!ADDRESS_RE.test(address)) return reply.code(400).send({ error: "not a Solana address" });
    const programs = (await programsControlledBy([address])).get(address) ?? [];
    return { address, programs };
  });

  app.post<{ Body: { address?: unknown; channel?: unknown; target?: unknown } }>(
    "/api/alerts/subscribe",
    async (req, reply) => {
      const address = typeof req.body?.address === "string" ? req.body.address.trim() : "";
      const channel = req.body?.channel as Channel;
      const target = typeof req.body?.target === "string" ? req.body.target.trim() : "";
      if (!ADDRESS_RE.test(address)) return reply.code(400).send({ error: "not a Solana address" });
      if (!CHANNELS.includes(channel)) return reply.code(400).send({ error: "channel not available" });
      if (!target || target.length > 500) return reply.code(400).send({ error: "missing target" });

      const caller = String(req.headers["x-forwarded-for"] ?? req.ip).split(",")[0]!.trim();
      if (limited(`ip:${caller}`) || limited(`target:${target}`)) {
        return reply.code(429).send({ error: "too many sign-ups, try again later" });
      }
      try {
        await assertPublicHttpsUrl(target);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }

      const existing = await db
        .select({ id: schema.alertSubscriptions.id })
        .from(schema.alertSubscriptions)
        .where(
          and(
            eq(schema.alertSubscriptions.address, address),
            eq(schema.alertSubscriptions.target, target),
            isNull(schema.alertSubscriptions.revokedAt),
          ),
        );
      if (existing.length) return reply.code(409).send({ error: "this address already pings that webhook" });

      const programs = (await programsControlledBy([address])).get(address) ?? [];
      const manageToken = randomBytes(24).toString("base64url");
      // the webhook proves itself by accepting the test ping; nothing is stored otherwise
      try {
        await sendWebhook(target, { kind: "test", text: testText(address, programs, manageToken) });
      } catch (err) {
        return reply.code(400).send({ error: `couldn't reach the webhook: ${(err as Error).message}` });
      }
      await db.insert(schema.alertSubscriptions).values({
        id: newId("asub"),
        address,
        channel,
        target,
        manageToken,
        confirmedAt: new Date(),
      });
      logger.info({ address, channel, programs: programs.length }, "alerts: subscribed");
      return { manageToken, programs };
    },
  );

  // the manage link: what this sign-up watches, and where it pings
  app.get<{ Querystring: { token?: string } }>("/api/alerts/subscription", async (req, reply) => {
    const token = req.query.token ?? "";
    if (!MANAGE_RE.test(token)) return reply.code(400).send({ error: "bad token" });
    const [sub] = await db
      .select()
      .from(schema.alertSubscriptions)
      .where(eq(schema.alertSubscriptions.manageToken, token));
    if (!sub) return reply.code(404).send({ error: "no such sign-up" });
    const programs = (await programsControlledBy([sub.address])).get(sub.address) ?? [];
    return {
      address: sub.address,
      channel: sub.channel,
      // the full URL is a secret for most webhook services; show where it goes, not the key
      target: sub.channel === "webhook" ? new URL(sub.target).host : sub.target,
      createdAt: sub.createdAt.toISOString(),
      active: !sub.revokedAt,
      programs,
    };
  });

  app.post<{ Body: { token?: unknown } }>("/api/alerts/unsubscribe", async (req, reply) => {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    if (!MANAGE_RE.test(token)) return reply.code(400).send({ error: "bad token" });
    const updated = await db
      .update(schema.alertSubscriptions)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.alertSubscriptions.manageToken, token), isNull(schema.alertSubscriptions.revokedAt)))
      .returning({ id: schema.alertSubscriptions.id });
    return { unsubscribed: updated.length > 0 };
  });
}
