import {
  schema,
  type ApiNearest,
  type ApiProgram,
  type ApiProgramDetail,
  type ApiRawEvent,
  type AuthorityClass,
  type Category,
  type EventEnrichment,
  type Network,
  type NoveltyBand,
  type SecurityTxt,
} from "@onrecord/core";

type SubjectRow = typeof schema.subjects.$inferSelect;
type EventRow = typeof schema.events.$inferSelect;

/** Lineage stored on subjects.facts by the classify stage. */
interface NearestFact {
  id: string;
  distance: number;
}

/** What the serializer needs to know about a nearest-relative program. */
export interface NearestMeta {
  name: string | null;
  isReference: boolean;
}

/** TLSH distance → display similarity. 0 = identical code, ≥300 = unrelated
 *  (same span the structural-novelty score uses, so the two never disagree). */
function similarityFromDistance(distance: number): number {
  return Math.max(0, Math.min(1, 1 - distance / 300));
}

function nearestOf(facts: { nearest?: NearestFact }, meta?: Map<string, NearestMeta>): ApiNearest | null {
  const n = facts.nearest;
  if (!n || typeof n.distance !== "number") return null;
  const m = meta?.get(n.id);
  return {
    id: n.id,
    name: m?.name ?? null,
    similarity: Math.round(similarityFromDistance(n.distance) * 100) / 100,
    isReference: m?.isReference ?? false,
  };
}

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

export function serializeProgram(
  row: SubjectRow,
  clusterSize: number | null = null,
  nearestMeta?: Map<string, NearestMeta>,
): ApiProgram {
  const profile = row.profile ?? null;
  const facts = (row.facts ?? {}) as {
    social?: string;
    website?: string;
    hasSecurityTxt?: boolean;
    upgradeCount?: number;
    nearest?: NearestFact;
    funderAddress?: string;
    fundingLamports?: number;
    deployCostLamports?: number;
    idlSource?: "pmp" | "anchor-legacy";
    logoUrl?: string;
    codeMatch?: ApiProgram["codeMatch"];
    multisig?: ApiProgram["multisig"];
  };
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
    idlSource: facts.idlSource ?? null,
    logoUrl: facts.logoUrl ?? null,
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
    repoUrl: row.repoUrl || null,
    social: facts.social ?? null,
    website: facts.website ?? null,
    hasSecurityTxt: Boolean(facts.hasSecurityTxt),
    deployType: (row.deployType as "deploy" | "upgrade") ?? "deploy",
    firstDeployAt: row.firstDeployAt?.toISOString() ?? null,
    upgradeCount: facts.upgradeCount ?? 0,
    funderAddress: facts.funderAddress ?? null,
    fundingAmountSol:
      typeof facts.fundingLamports === "number"
        ? Math.round((facts.fundingLamports / 1e9) * 1000) / 1000
        : null,
    deployCostSol:
      typeof facts.deployCostLamports === "number"
        ? Math.round((facts.deployCostLamports / 1e9) * 1000) / 1000
        : null,
    nearest: nearestOf(facts, nearestMeta),
    codeMatch: facts.codeMatch ?? null,
    multisig: facts.multisig ?? null,
  };
}

export function serializeProgramDetail(
  row: SubjectRow,
  events: EventRow[],
  neighbors: ApiProgramDetail["neighbors"],
  clusterSize: number | null,
  nearestMeta?: Map<string, NearestMeta>,
): ApiProgramDetail {
  const facts = (row.facts ?? {}) as { securityTxt?: SecurityTxt };
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
    ...serializeProgram(row, clusterSize, nearestMeta),
    repoUrl: row.repoUrl || null,
    authority: row.authority,
    sha256: row.sha256,
    events: events.map(serializeEvent),
    neighbors,
    idlInstructions,
    strings,
    securityTxt: facts.securityTxt ?? null,
  };
}
