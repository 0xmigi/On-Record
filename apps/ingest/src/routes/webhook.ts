import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { db, schema, enqueue, env, newId, logger, type Network } from "@onrecord/core";
import { parseWebhookPayload } from "../parse.js";

/** Constant-time comparison of the webhook Authorization header against the
 *  configured shared secret. */
function secretMatches(header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Helius webhook receivers (spec §3). One endpoint per network; the shared
// secret configured on the Helius webhook arrives in the Authorization header.
// Events are recorded append-only, then the fingerprint stage is enqueued —
// the webhook returns fast and never blocks on enrichment.
// ---------------------------------------------------------------------------

export function registerWebhookRoutes(app: FastifyInstance): void {
  for (const network of ["mainnet", "devnet"] as Network[]) {
    app.post(`/webhooks/helius/${network}`, async (req, reply) => {
      const secret =
        network === "mainnet" ? env.HELIUS_WEBHOOK_SECRET_MAINNET : env.HELIUS_WEBHOOK_SECRET_DEVNET;
      // fail closed: with no secret configured, anyone could inject fabricated
      // deploy events into the record — same posture as the admin routes
      if (!secret) {
        logger.warn({ network }, "webhook rejected: no shared secret configured");
        return reply.code(503).send({ error: "webhook secret not configured" });
      }
      if (!secretMatches(req.headers.authorization, secret)) {
        return reply.code(401).send({ error: "bad webhook auth" });
      }

      const parsed = parseWebhookPayload(req.body);
      let recorded = 0;
      for (const ev of parsed) {
        const id = newId("evt");
        const inserted = await db
          .insert(schema.events)
          .values({
            id,
            network,
            type: ev.type,
            signature: ev.signature,
            instructionIndex: ev.instructionIndex,
            slot: ev.slot,
            blockTime: ev.blockTime,
            programId: ev.programId ?? "unknown",
            programDataAddress: ev.programDataAddress,
            authorityBefore: ev.authorityBefore,
            authorityAfter: ev.authorityAfter,
          })
          .onConflictDoNothing({
            target: [schema.events.signature, schema.events.instructionIndex],
          })
          .returning({ id: schema.events.id });

        // Helius retries deliveries — the unique (signature, ix) key makes
        // ingestion idempotent; only fresh rows enter the pipeline.
        if (inserted[0]) {
          recorded++;
          await enqueue("fingerprint", { eventId: inserted[0].id });
        }
      }

      logger.info({ network, received: parsed.length, recorded }, "webhook batch");
      return reply.send({ ok: true, recorded });
    });
  }
}
