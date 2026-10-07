// Timeline repair (THE RECORD). A program's ProgramData header only carries the
// LAST deploy slot, so anything that captures a program mid-life — the backfill,
// or a poller sighting of an already-live program — records that slot as a
// "deploy" even though the chain says the program already existed. The real
// genesis is the first successful deploy in the loader record (loader-history.ts).
//
// Shared by the live pipeline and the repair script so the two can't drift.

import { and, asc, eq, gt, inArray, like, or } from "drizzle-orm";
import { db, newId, schema, type DeployHistory, type Network } from "@onrecord/core";
import { loaderRecord } from "./loader-history.js";

/** Synthetic capture ids — not real transaction signatures. The poller watches
 *  ProgramData *account state* (never a transaction), and the backfill enumerates
 *  accounts, so neither can cite a signature. */
export const SYNTHETIC_SIG_PREFIXES = [
  "backfill:",
  "poll:",
  "incubation-backfill:",
  "counterpart-promote:",
] as const;

/** True when a "signature" is one of our internal capture ids rather than a real
 *  on-chain signature — those must never be rendered as a verifiable receipt. */
export function isSyntheticSignature(signature: string | null | undefined): boolean {
  if (!signature) return false;
  return SYNTHETIC_SIG_PREFIXES.some((p) => signature.startsWith(p));
}

/** Ingest a cluster's WHOLE deploy history as real event rows.
 *
 *  The poller only ever has events it watched live, so a program On Record was
 *  never following on a given cluster shows an empty timeline there — while the
 *  header confidently says "upgraded ×25". The two numbers came from different
 *  places and disagreed on screen.
 *
 *  Rows come from the loader record: one per successful deploy or upgrade
 *  instruction, each with the transaction that proves it. This used to take
 *  every ProgramData signature and call all but the oldest an upgrade, which
 *  put extends, authority changes, failed attempts and admin calls that merely
 *  pass the account in on the timeline as upgrades: of the 6,578 mainnet
 *  "upgrade" rows it wrote, 968 were upgrades and 5,124 carried no loader
 *  instruction at all (2026-10-07).
 *
 *  Idempotent: rows are keyed on the real signature, so re-running is a no-op
 *  and a later live sighting of the same upgrade collapses onto the same row.
 *  Returns how many NEW rows landed, and the newest and first of them. */
export async function ingestDeployHistory(
  network: Network,
  programId: string,
  programDataAddress: string,
): Promise<{
  inserted: number;
  total: number;
  truncated: boolean;
  newestSignature: string | null;
  firstDeployAt: Date | null;
}> {
  const rec = await loaderRecord(network, programId);
  const history = await db
    .select()
    .from(schema.loaderTxns)
    .where(
      and(
        eq(schema.loaderTxns.network, network),
        eq(schema.loaderTxns.programId, programId),
        inArray(schema.loaderTxns.kind, ["deploy", "upgrade"]),
        eq(schema.loaderTxns.failed, false),
      ),
    )
    .orderBy(asc(schema.loaderTxns.slot), asc(schema.loaderTxns.outerIndex), asc(schema.loaderTxns.innerIndex));
  // one event per transaction: events are keyed on (signature, 0)
  const bySignature = new Map(history.map((r) => [r.signature, r]));
  const rows = [...bySignature.values()].map((r) => ({
    id: newId("evt"),
    network,
    type: r.kind,
    signature: r.signature,
    instructionIndex: 0,
    slot: r.slot,
    blockTime: r.blockTime ?? new Date(),
    programId,
    programDataAddress,
    authorityBefore: r.authorityBefore,
    authorityAfter: r.authorityAfter,
  }));
  const done = { truncated: rec.incomplete, newestSignature: rows.at(-1)?.signature ?? null, firstDeployAt: rec.genesis?.firstDeployAt ?? null };
  if (!rows.length) return { inserted: 0, total: 0, ...done };

  let inserted = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const landed = await db
      .insert(schema.events)
      .values(rows.slice(i, i + 200))
      .onConflictDoNothing({ target: [schema.events.signature, schema.events.instructionIndex] })
      .returning({ id: schema.events.id });
    inserted += landed.length;
  }
  return { inserted, total: rows.length, ...done };
}

/** Seed the genesis deploy row, so the dossier can show first + last rather
 *  than only the moment we happened to look. Takes the first successful deploy
 *  from the loader record. Idempotent: keyed on the real signature, so
 *  re-running is a no-op. */
export async function recordGenesisDeploy(
  network: Network,
  programId: string,
  programDataAddress: string,
  dh: Pick<DeployHistory, "firstDeploySlot" | "firstSignature" | "firstDeployAt">,
): Promise<boolean> {
  if (dh.firstDeploySlot == null || !dh.firstSignature) return false;
  const inserted = await db
    .insert(schema.events)
    .values({
      id: newId("evt"),
      network,
      type: "deploy",
      signature: dh.firstSignature,
      instructionIndex: 0,
      slot: dh.firstDeploySlot,
      blockTime: dh.firstDeployAt,
      programId,
      programDataAddress,
      authorityBefore: null,
      authorityAfter: null,
      pipelineStage: "genesis", // a timeline marker, not for reprocessing
    })
    .onConflictDoNothing({ target: [schema.events.signature, schema.events.instructionIndex] })
    .returning({ id: schema.events.id });
  return inserted.length > 0;
}

/** Relabel phantom deploys: a *synthetic* capture typed "deploy" that sits above
 *  the genesis slot is really a later upgrade.
 *
 *  Deliberately scoped to synthetic captures. A program that was closed and then
 *  redeployed at the same address has a genuine second deploy — and that one
 *  carries a real signature, so restricting to synthetic ids leaves it intact. */
export async function relabelPhantomDeploys(
  network: Network,
  programId: string,
  genesisSlot: number,
): Promise<number> {
  const rows = await db
    .update(schema.events)
    .set({ type: "upgrade" })
    .where(
      and(
        eq(schema.events.network, network),
        eq(schema.events.programId, programId),
        eq(schema.events.type, "deploy"),
        gt(schema.events.slot, genesisSlot),
        or(...SYNTHETIC_SIG_PREFIXES.map((p) => like(schema.events.signature, `${p}%`)))!,
      ),
    )
    .returning({ id: schema.events.id });
  return rows.length;
}
