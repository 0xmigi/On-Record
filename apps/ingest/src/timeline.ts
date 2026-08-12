// Timeline repair (THE RECORD). A program's ProgramData header only carries the
// LAST deploy slot, so anything that captures a program mid-life — the backfill,
// or a poller sighting of an already-live program — records that slot as a
// "deploy" even though the chain says the program already existed. The real
// genesis lives in the ProgramData signature history (oldest signature).
//
// Shared by the live pipeline and the repair script so the two can't drift.

import { and, eq, gt, like, or } from "drizzle-orm";
import {
  db,
  newId,
  schema,
  listDeployHistory,
  type DeployHistory,
  type Network,
} from "@onrecord/core";

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
 *  header confidently says "upgraded ×25", because that count is read from
 *  ProgramData history at profile time. The two numbers came from different
 *  places and disagreed on screen.
 *
 *  ProgramData is written only by deploy/upgrade/set-authority, so every
 *  signature touching it is a code change with a citable transaction. The
 *  oldest is the genesis deploy; everything after it is an upgrade.
 *
 *  Idempotent: rows are keyed on the real signature, so re-running is a no-op
 *  and a later live sighting of the same upgrade collapses onto the same row.
 *  Returns how many NEW rows landed. */
export async function ingestDeployHistory(
  network: Network,
  programId: string,
  programDataAddress: string,
  authorityAfter: string | null,
): Promise<{ inserted: number; total: number; truncated: boolean }> {
  const { signatures, truncated } = await listDeployHistory(network, programDataAddress);
  if (!signatures.length) return { inserted: 0, total: 0, truncated };

  // newest-first from the RPC; oldest is the genesis deploy
  const oldestIndex = signatures.length - 1;
  const rows = signatures.map((sig, i) => ({
    id: newId("evt"),
    network,
    // Only call it a deploy when we actually reached the bottom of the history.
    // A truncated walk means the oldest signature we saw is just the oldest we
    // REACHED, and labelling it "deploy" would invent a genesis.
    type: i === oldestIndex && !truncated ? "deploy" : "upgrade",
    signature: sig.signature,
    instructionIndex: 0,
    slot: sig.slot,
    blockTime: sig.blockTime ? new Date(sig.blockTime * 1000) : new Date(),
    programId,
    programDataAddress,
    authorityBefore: null,
    // Only the newest event can be said to have produced the authority the
    // header currently shows; earlier ones are left unknown rather than guessed.
    authorityAfter: i === 0 ? authorityAfter : null,
  }));

  let inserted = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const landed = await db
      .insert(schema.events)
      .values(rows.slice(i, i + 200))
      .onConflictDoNothing({ target: [schema.events.signature, schema.events.instructionIndex] })
      .returning({ id: schema.events.id });
    inserted += landed.length;
  }
  return { inserted, total: rows.length, truncated };
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
