// Timeline repair (THE RECORD). A program's ProgramData header only carries the
// LAST deploy slot, so anything that captures a program mid-life — the backfill,
// or a poller sighting of an already-live program — records that slot as a
// "deploy" even though the chain says the program already existed. The real
// genesis lives in the ProgramData signature history (oldest signature).
//
// Shared by the live pipeline and the repair script so the two can't drift.

import { and, eq, gt, like, or } from "drizzle-orm";
import { db, newId, schema, type DeployHistory, type Network } from "@onrecord/core";

/** Synthetic capture ids — not real transaction signatures. The poller watches
 *  ProgramData *account state* (never a transaction), and the backfill enumerates
 *  accounts, so neither can cite a signature. */
export const SYNTHETIC_SIG_PREFIXES = ["backfill:", "poll:", "incubation-backfill:"] as const;

/** True when a "signature" is one of our internal capture ids rather than a real
 *  on-chain signature — those must never be rendered as a verifiable receipt. */
export function isSyntheticSignature(signature: string | null | undefined): boolean {
  if (!signature) return false;
  return SYNTHETIC_SIG_PREFIXES.some((p) => signature.startsWith(p));
}

/** Seed the genesis deploy row from the ProgramData's oldest signature, so the
 *  dossier can show first + last rather than only the moment we happened to look.
 *  Idempotent: keyed on the real signature, so re-running is a no-op. */
export async function recordGenesisDeploy(
  network: Network,
  programId: string,
  programDataAddress: string,
  dh: DeployHistory,
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
