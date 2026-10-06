import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  db,
  schema,
  env,
  logger,
  newId,
  rpcUrl,
  diagnoseVerification,
  type VerificationReport,
} from "@onrecord/core";

// ---------------------------------------------------------------------------
// Verification alerts.
//
// A developer signs up with an address and somewhere to be pinged. Every open
// mainnet program that address controls is watched: the address is its upgrade
// authority, or the Squads multisig whose vault holds it. Programs the address
// deploys later are covered without asking.
//
// The sweep below runs every couple of minutes. For each watched program's
// latest deploy or upgrade made after the sign-up, it waits out a grace window,
// then runs the same verification doctor the program pages use:
//   verified   → recorded, nothing sent. Teams that re-verify fast hear nothing.
//   unverified → one ping: what happened, why, the fix, the program page.
//   later verified, after a ping → one "verified again" ping.
// alert_deliveries' unique index makes each verdict happen at most once, so the
// sweep is safe to re-run and to overlap with a restart.
//
// research/verification-feed-plan.md has the product reasoning.
// ---------------------------------------------------------------------------

const SITE = "https://on-record.azuolas.xyz";
/** OtterSec re-checks by itself when a recipe lands within ~5 minutes of an
 *  upgrade (the article). Judging at 10 avoids pinging teams who did it. */
const GRACE_MS = Number(process.env.ALERT_GRACE_MS ?? 10 * 60_000);
/** a version older than this when first seen is history, not news */
const MAX_AGE_MS = 7 * 24 * 3_600_000;
/** how often a pinged, still-unverified version is re-checked for "verified again" */
const RECHECK_MS = 30 * 60_000;

export const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type Channel = "webhook";
export const CHANNELS: readonly Channel[] = ["webhook"];

// --- which programs an address controls ------------------------------------

export interface WatchedProgram {
  id: string;
  name: string | null;
  verified: boolean;
  /** how the address controls it */
  via: "authority" | "multisig";
  lastEventAt: string | null;
}

export async function programsControlledBy(addresses: string[]): Promise<Map<string, WatchedProgram[]>> {
  const out = new Map<string, WatchedProgram[]>(addresses.map((a) => [a, []]));
  if (!addresses.length) return out;
  const multisigOf = sql<string | null>`${schema.subjects.facts}->'multisig'->>'address'`;
  const rows = await db
    .select({
      id: schema.subjects.id,
      name: schema.subjects.name,
      verified: schema.subjects.verified,
      authority: schema.subjects.authority,
      multisig: multisigOf,
      lastEventAt: schema.subjects.lastEventAt,
    })
    .from(schema.subjects)
    .where(
      and(
        eq(schema.subjects.kind, "program"),
        eq(schema.subjects.network, "mainnet"),
        sql`(${schema.subjects.facts} ->> 'closedAt') is null`,
        or(inArray(schema.subjects.authority, addresses), inArray(multisigOf, addresses)),
      ),
    )
    .orderBy(desc(schema.subjects.lastEventAt));
  for (const r of rows) {
    for (const [address, via] of [
      [r.authority, "authority"],
      [r.multisig, "multisig"],
    ] as const) {
      if (address && out.has(address)) {
        out.get(address)!.push({
          id: r.id,
          name: r.name,
          verified: r.verified,
          via,
          lastEventAt: r.lastEventAt?.toISOString() ?? null,
        });
      }
    }
  }
  return out;
}

// --- delivery ---------------------------------------------------------------

export interface AlertMessage {
  kind: "unverified" | "restored" | "test";
  programId?: string;
  programName?: string | null;
  slot?: number;
  /** plain text, the whole message; every channel can carry it */
  text: string;
}

/** Webhooks are fetched from our server, so they must point at the public
 *  internet: https only, and never a private, loopback or link-local address. */
export async function assertPublicHttpsUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("not a URL");
  }
  // local testing only; the production image sets NODE_ENV=production
  if (process.env.ALERTS_ALLOW_LOCAL_WEBHOOKS === "1" && process.env.NODE_ENV !== "production") return url;
  if (url.protocol !== "https:") throw new Error("webhook must be https");
  if (url.username || url.password) throw new Error("webhook URL can't carry credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error("webhook must be a public address");
  }
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error("webhook host doesn't resolve");
  if (addrs.some((a) => isPrivate(a.address))) throw new Error("webhook must be a public address");
  return url;
}

function isPrivate(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivate(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** Discord and Slack each want their own field; anything else gets the full
 *  structured message plus `text`. */
export async function sendWebhook(target: string, msg: AlertMessage): Promise<void> {
  const url = await assertPublicHttpsUrl(target);
  const body =
    url.hostname === "discord.com" || url.hostname.endsWith(".discord.com")
      ? { content: msg.text.slice(0, 2000) }
      : url.hostname === "hooks.slack.com"
        ? { text: msg.text }
        : { source: "on-record", ...msg };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "OnRecord-Alerts/1" },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`webhook answered HTTP ${res.status}`);
}

async function deliver(sub: { channel: string; target: string }, msg: AlertMessage): Promise<void> {
  if (sub.channel === "webhook") return sendWebhook(sub.target, msg);
  throw new Error(`channel ${sub.channel} not available yet`);
}

// --- message text -------------------------------------------------------------

const label = (id: string, name: string | null) => name ?? `${id.slice(0, 4)}…${id.slice(-4)}`;
const utc = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
const manageLink = (token: string) => `${SITE}/verification/alerts?manage=${token}`;

function unverifiedText(
  p: { id: string; name: string | null },
  v: { type: string; slot: number; blockTime: Date },
  report: VerificationReport,
  manageToken: string,
): string {
  const verb = v.type === "deploy" ? "deployed" : "upgraded";
  const lines = [
    `${label(p.id, p.name)} was ${verb} on mainnet and isn't verified.`,
    `${verb[0]!.toUpperCase()}${verb.slice(1)} ${utc(v.blockTime)}, slot ${v.slot.toLocaleString("en-US")}.`,
    "",
    `Why: ${report.diagnosis}`,
  ];
  if (report.fixes.length) {
    lines.push("", "To fix it:");
    for (const f of report.fixes) {
      if (f.text) lines.push(f.text);
      if (f.command) lines.push(f.command);
    }
  }
  lines.push("", `${SITE}/p/${p.id}`, `Stop these alerts: ${manageLink(manageToken)}`);
  return lines.join("\n");
}

function restoredText(p: { id: string; name: string | null }, v: { slot: number }, manageToken: string): string {
  return [
    `${label(p.id, p.name)} is verified again.`,
    `The build from slot ${v.slot.toLocaleString("en-US")} now matches its public source.`,
    "",
    `${SITE}/p/${p.id}`,
    `Stop these alerts: ${manageLink(manageToken)}`,
  ].join("\n");
}

export function testText(address: string, programs: WatchedProgram[], manageToken: string): string {
  const named = programs.slice(0, 5).map((p) => `- ${label(p.id, p.name)}`);
  const more = programs.length > 5 ? [`- and ${programs.length - 5} more`] : [];
  return [
    `On Record will ping here when a mainnet deploy or upgrade by ${label(address, null)} isn't verified.`,
    programs.length ? `Watching ${programs.length} program${programs.length === 1 ? "" : "s"} now:` : "It controls no programs on record yet; new ones are watched as they deploy.",
    ...named,
    ...more,
    "",
    `Stop these alerts: ${manageLink(manageToken)}`,
  ].join("\n");
}

// --- the sweep ------------------------------------------------------------------

const recheckedAt = new Map<string, number>();

export async function sweepAlerts(): Promise<{ judged: number; sent: number; failed: number }> {
  const subs = await db
    .select()
    .from(schema.alertSubscriptions)
    .where(and(isNotNull(schema.alertSubscriptions.confirmedAt), isNull(schema.alertSubscriptions.revokedAt)));
  if (!subs.length) return { judged: 0, sent: 0, failed: 0 };

  const watched = await programsControlledBy([...new Set(subs.map((s) => s.address))]);
  const reports = new Map<string, Promise<VerificationReport | null>>();
  const diagnose = (id: string) => {
    let r = reports.get(id);
    if (!r) {
      r = diagnoseVerification(id, { rpcUrl: rpcUrl("mainnet"), githubToken: env.GITHUB_TOKEN || undefined }).catch(
        (err: unknown) => {
          logger.warn({ programId: id, err: String(err) }, "alerts: diagnosis failed");
          return null;
        },
      );
      reports.set(id, r);
    }
    return r;
  };

  let judged = 0;
  let sent = 0;
  let failed = 0;
  const now = Date.now();

  for (const sub of subs) {
    for (const p of watched.get(sub.address) ?? []) {
      const [latest] = await db
        .select({ slot: schema.events.slot, blockTime: schema.events.blockTime, type: schema.events.type })
        .from(schema.events)
        .where(
          and(
            eq(schema.events.programId, p.id),
            eq(schema.events.network, "mainnet"),
            inArray(schema.events.type, ["deploy", "upgrade"]),
          ),
        )
        .orderBy(desc(schema.events.slot))
        .limit(1);
      if (!latest?.blockTime) continue;
      const v = { ...latest, blockTime: latest.blockTime };
      const age = now - v.blockTime.getTime();
      // only what happened after the sign-up, once the grace window has passed
      if (v.blockTime < sub.confirmedAt! || age < GRACE_MS || age > MAX_AGE_MS) continue;

      const done = await db
        .select({ kind: schema.alertDeliveries.kind })
        .from(schema.alertDeliveries)
        .where(
          and(
            eq(schema.alertDeliveries.subscriptionId, sub.id),
            eq(schema.alertDeliveries.programId, p.id),
            eq(schema.alertDeliveries.slot, v.slot),
          ),
        );
      const kinds = new Set(done.map((d) => d.kind));
      if (kinds.has("ok") || kinds.has("restored")) continue;

      if (kinds.has("unverified")) {
        // pinged already; look again now and then for "verified again"
        const key = `${sub.id}:${p.id}:${v.slot}`;
        if (now - (recheckedAt.get(key) ?? 0) < RECHECK_MS) continue;
        recheckedAt.set(key, now);
        const report = await diagnose(p.id);
        if (report?.status !== "verified") continue;
        if (await record(sub, p.id, v.slot, "restored", restoredText(p, v, sub.manageToken), true)) sent++;
        else failed++;
        continue;
      }

      const report = await diagnose(p.id);
      if (!report || report.status === "unreadable") continue; // ask again next tick
      judged++;
      if (report.status === "verified") {
        await record(sub, p.id, v.slot, "ok", null, false);
        continue;
      }
      const ok = await record(sub, p.id, v.slot, "unverified", unverifiedText(p, v, report, sub.manageToken), true);
      if (ok) sent++;
      else failed++;
    }
  }
  if (judged || sent || failed) logger.info({ judged, sent, failed, subs: subs.length }, "alerts: sweep");
  return { judged, sent, failed };
}

/** Claim the verdict first, then send. A lost race (restart, overlapping tick)
 *  hits the unique index and sends nothing, so a ping can't go out twice. */
async function record(
  sub: { id: string; channel: string; target: string },
  programId: string,
  slot: number,
  kind: "unverified" | "restored" | "ok",
  text: string | null,
  send: boolean,
): Promise<boolean> {
  const id = newId("alrt");
  const claimed = await db
    .insert(schema.alertDeliveries)
    .values({ id, subscriptionId: sub.id, programId, slot, kind, status: send ? "pending" : "silent", detail: text })
    .onConflictDoNothing()
    .returning({ id: schema.alertDeliveries.id });
  if (!claimed.length || !send || !text) return true;
  try {
    await deliver(sub, { kind: kind as "unverified" | "restored", programId, slot, text });
    await db.update(schema.alertDeliveries).set({ status: "sent" }).where(eq(schema.alertDeliveries.id, id));
    return true;
  } catch (err) {
    await db
      .update(schema.alertDeliveries)
      .set({ status: "failed", error: String(err).slice(0, 500) })
      .where(eq(schema.alertDeliveries.id, id));
    logger.warn({ subscription: sub.id, programId, err: String(err) }, "alerts: delivery failed");
    return false;
  }
}
