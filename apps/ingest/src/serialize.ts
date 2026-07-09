import {
  schema,
  type ApiProgram,
  type ApiProgramDetail,
  type ApiRawEvent,
  type AuthorityClass,
  type Category,
  type EventEnrichment,
  type Network,
  type NoveltyBand,
} from "@onrecord/core";

type SubjectRow = typeof schema.subjects.$inferSelect;
type EventRow = typeof schema.events.$inferSelect;

export function serializeEvent(row: EventRow): ApiRawEvent {
  return {
    id: row.id,
    network: row.network as Network,
    type: row.type as ApiRawEvent["type"],
    signature: row.signature,
    slot: row.slot,
    blockTime: row.blockTime?.toISOString() ?? null,
    programId: row.programId,
    authorityBefore: row.authorityBefore,
    authorityAfter: row.authorityAfter,
    sha256After: row.sha256After,
  };
}

export function serializeProgram(row: SubjectRow, clusterSize: number | null = null): ApiProgram {
  const profile = row.profile ?? null;
  const facts = (row.facts ?? {}) as { social?: string; website?: string; hasSecurityTxt?: boolean };
  return {
    id: row.id,
    network: row.network as Network,
    name: row.name,
    deployedSlot: row.firstSeenSlot,
    deployedAt: row.firstSeenAt?.toISOString() ?? null,
    lastEventAt: row.lastEventAt?.toISOString() ?? null,
    band: (row.noveltyBand as NoveltyBand) ?? "variant",
    noveltyScore: row.noveltyScore ?? 0,
    category: (row.category as Category) ?? "unknown",
    sizeBytes: row.sizeBytes,
    instructionCount: row.instructionCount,
    idlPresent: row.idlPresent,
    authorityClass: (row.authorityClass as AuthorityClass) ?? null,
    deployerFundingSource: row.deployerFundingSource,
    earlySigners: row.earlySigners,
    verified: row.verified,
    bucketId: row.bucketId,
    clusterSize,
    framework: profile?.framework ?? null,
    capabilities: profile?.capabilities ?? [],
    integrations: profile?.integrations ?? [],
    syscallCount: profile?.syscalls.length ?? null,
    repoUrl: row.repoUrl,
    social: facts.social ?? null,
    website: facts.website ?? null,
    hasSecurityTxt: Boolean(facts.hasSecurityTxt),
  };
}

export function serializeProgramDetail(
  row: SubjectRow,
  events: EventRow[],
  neighbors: ApiProgramDetail["neighbors"],
  clusterSize: number | null,
): ApiProgramDetail {
  // pull IDL instructions + notable strings from the most recent fingerprint
  let idlInstructions: string[] = [];
  let strings: string[] = [];
  for (const e of events) {
    const fp = (e.enrichment as EventEnrichment).fingerprint;
    if (fp) {
      idlInstructions = fp.idl?.instructions ?? [];
      strings = (fp.strings ?? []).slice(0, 40);
      break; // events are newest-first
    }
  }
  return {
    ...serializeProgram(row, clusterSize),
    repoUrl: row.repoUrl,
    authority: row.authority,
    sha256: row.sha256,
    events: events.map(serializeEvent),
    neighbors,
    idlInstructions,
    strings,
  };
}
