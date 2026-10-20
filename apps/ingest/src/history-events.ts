import { loadHistory, schema, type ProgramHistory } from "@onrecord/core";

// ---------------------------------------------------------------------------
// The record table from the backfilled history.
//
// Inside the history's range the loader record is complete: every deploy,
// upgrade, authority change and close, each with its real transaction. Live
// `events` rows in that range are dropped in favour of it, because the poller's
// rows there carry synthetic `poll:` signatures and occasionally an extend's
// slot (115 of 36,150 checked). Outside the range — after it, for now — the live
// rows are the record, as before.
// ---------------------------------------------------------------------------

type EventRow = typeof schema.events.$inferSelect;

const TIMELINE_KINDS: Record<string, string> = {
  deploy: "deploy",
  upgrade: "upgrade",
  set_authority: "set_authority",
  set_authority_checked: "set_authority",
  close: "close",
};

export function historyEvents(history: ProgramHistory): EventRow[] {
  const shaAt = new Map(history.versions.map((v) => [v.signature, v.sha256]));
  const out: EventRow[] = [];
  for (const l of history.loader) {
    const type = TIMELINE_KINDS[l.kind];
    if (!type || l.outcome === "failed") continue;
    const a = l.accounts;
    // account layouts: deploy [payer, programdata, program, buffer, rent, clock,
    // system, authority]; upgrade [programdata, program, buffer, spill, rent,
    // clock, authority]; set_authority [account, current, new?]; close
    // [account, recipient, authority, program]
    const before =
      type === "deploy" ? null : type === "upgrade" ? (a[6] ?? null) : (a[1] ?? null);
    const after =
      type === "deploy"
        ? (a[7] ?? null)
        : type === "upgrade"
          ? (a[6] ?? null)
          : type === "set_authority"
            ? (a[2] ?? null) // absent = made immutable
            : null;
    out.push({
      id: `hist:${l.signature}:${l.outer}:${l.inner}`,
      network: "mainnet",
      type,
      signature: l.signature,
      instructionIndex: l.outer * 1000 + l.inner + 1,
      slot: l.slot,
      blockTime: l.at ? new Date(l.at) : null,
      programId: history.program,
      programDataAddress: history.programdata,
      authorityBefore: type === "close" ? (a[2] ?? null) : before,
      authorityAfter: after,
      sha256Before: null,
      sha256After: type === "deploy" || type === "upgrade" ? (shaAt.get(l.signature) ?? null) : null,
      enrichment: { history: true },
      pipelineStage: "history",
      createdAt: new Date(0),
    });
  }
  return out;
}

/** Live events with the history's range swapped for the history's own record,
 *  newest first, capped at `limit`. */
export async function timelineWithHistory(
  programId: string,
  live: EventRow[],
  limit: number,
): Promise<{ events: EventRow[]; history: ProgramHistory | null }> {
  const history = await loadHistory(programId);
  if (!history) return { events: live, history: null };
  const { first_slot, last_slot } = history.coverage;
  const kept = live.filter((e) => e.network !== "mainnet" || e.slot < first_slot || e.slot > last_slot);
  const merged = [...kept, ...historyEvents(history)].sort((a, b) => b.slot - a.slot);
  return { events: merged.slice(0, limit), history };
}
