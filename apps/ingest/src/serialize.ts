import {
  httpUrl,
  nearestWeakness,
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
  type RepoLink,
  type SecurityTxt,
} from "@onrecord/core";

type SubjectRow = typeof schema.subjects.$inferSelect;
type EventRow = typeof schema.events.$inferSelect;

/** Lineage stored on subjects.facts by the classify stage. */
interface NearestFact {
  id: string;
  distance: number;
  peersWithin5?: number; // distinct programs within 5 similarity points of the nearest
  runnerUpDistance?: number | null; // 2nd-nearest distance
}

/** What the serializer needs to know about a nearest-relative program. */
export interface NearestMeta {
  name: string | null;
  isReference: boolean;
  deployedAt: string | null; // neighbor's first deploy — for the before/after-this hint
  sizeBytes: number | null; // against this program's size — see nearestWeakness()
}

/** TLSH distance → display similarity. 0 = identical code, ≥300 = unrelated
 *  (same span the structural-novelty score uses, so the two never disagree). */
function similarityFromDistance(distance: number): number {
  return Math.max(0, Math.min(1, 1 - distance / 300));
}

function nearestOf(
  facts: { nearest?: NearestFact },
  sizeBytes: number | null,
  meta?: Map<string, NearestMeta>,
): ApiNearest | null {
  const n = facts.nearest;
  if (!n || typeof n.distance !== "number") return null;
  const m = meta?.get(n.id);
  return {
    id: n.id,
    name: m?.name ?? null,
    similarity: Math.round(similarityFromDistance(n.distance) * 100) / 100,
    isReference: m?.isReference ?? false,
    deployedAt: m?.deployedAt ?? null,
    peersWithin5: n.peersWithin5 ?? null,
    runnerUpSimilarity:
      typeof n.runnerUpDistance === "number"
        ? Math.round(similarityFromDistance(n.runnerUpDistance) * 100) / 100
        : null,
    // computed here, not in the UI: the radar card, the dossier and anything
    // else reading the API must agree on when this match can carry a name
    weak: nearestWeakness(n.peersWithin5, sizeBytes, m?.sizeBytes),
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
    upgradeCountTruncated?: boolean;
    nearest?: NearestFact;
    funderAddress?: string;
    fundingLamports?: number;
    deployCostLamports?: number;
    idlSource?: "pmp" | "anchor-legacy";
    logoUrl?: string;
    repoUrlDead?: boolean;
    repoUrlRoot?: string;
    codeMatch?: ApiProgram["codeMatch"];
    incubation?: ApiProgram["incubation"];
    multisig?: ApiProgram["multisig"];
    activity?: { t: number; c: number }[];
    momentum?: { txns24h: number; growth: number | null; txns24hTruncated?: boolean };
    closedAt?: string;
    interest?: ApiProgram["interest"];
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
    logoUrl: httpUrl(facts.logoUrl) ?? null,
    authorityClass: (row.authorityClass as AuthorityClass) ?? null,
    deployerFundingSource: row.deployerFundingSource,
    earlySigners: row.earlySigners,
    verified: row.verified,
    bucketId: row.bucketId,
    // the crate the binary leaked — programs built from the same source share
    // it even when each redeploy lands in its own copy bucket, so the radar
    // needs it to collapse a family into one card
    crate: row.crate,
    clusterSize,
    framework: profile?.framework ?? null,
    capabilities: profile?.capabilities ?? [],
    integrations: profile?.integrations ?? [],
    syscallCount: profile?.syscalls?.length ?? null,
    // scheme-guarded: these came out of attacker-controlled binaries and are
    // rendered as hrefs — rows ingested before the guard may hold bad schemes.
    // A repo the liveness sweep found gone is withheld from `repoUrl` rather
    // than flagged beside it: six consumers read this field (dossier link,
    // radar icon, avatar favicon, OG image, disclosure score, radar filter) and
    // a flag is only as good as the last one to remember to check it.
    // A stale pin (the repo lives, the commit it named is gone) falls back to
    // the repo root — still the source, still reachable. Only a genuinely dead
    // pointer is withheld.
    repoUrl: facts.repoUrlDead ? null : (httpUrl(facts.repoUrlRoot) ?? httpUrl(row.repoUrl)),
    repoUrlDeclared: facts.repoUrlDead ? httpUrl(row.repoUrl) : null,
    social: httpUrl(facts.social),
    website: httpUrl(facts.website),
    hasSecurityTxt: Boolean(facts.hasSecurityTxt),
    closedAt: facts.closedAt ?? null,
    closed: Boolean(facts.closedAt),
    deployType: (row.deployType as "deploy" | "upgrade") ?? "deploy",
    firstDeployAt: row.firstDeployAt?.toISOString() ?? null,
    upgradeCount: facts.upgradeCount ?? 0,
    upgradeCountTruncated: facts.upgradeCountTruncated ?? false,
    funderAddress: facts.funderAddress ?? null,
    fundingAmountSol:
      typeof facts.fundingLamports === "number"
        ? Math.round((facts.fundingLamports / 1e9) * 1000) / 1000
        : null,
    deployCostSol:
      typeof facts.deployCostLamports === "number"
        ? Math.round((facts.deployCostLamports / 1e9) * 1000) / 1000
        : null,
    nearest: nearestOf(facts, row.sizeBytes, nearestMeta),
    codeMatch: facts.codeMatch ?? null,
    incubation: facts.incubation ?? null,
    multisig: facts.multisig ?? null,
    // radar rows carry a 48h sparkline; the detail serializer widens to 7d
    activity: facts.activity?.slice(-48) ?? null,
    momentum: facts.momentum
      ? {
          txns24h: facts.momentum.txns24h,
          growth: facts.momentum.growth,
          txns24hTruncated: facts.momentum.txns24hTruncated ?? false,
        }
      : null,
    interest: facts.interest ?? null,
  };
}

export function serializeProgramDetail(
  row: SubjectRow,
  events: EventRow[],
  neighbors: ApiProgramDetail["neighbors"],
  clusterSize: number | null,
  nearestMeta?: Map<string, NearestMeta>,
  sourceKin: ApiProgramDetail["sourceKin"] = [],
): ApiProgramDetail {
  const facts = (row.facts ?? {}) as {
    securityTxt?: SecurityTxt;
    repoLink?: RepoLink;
    activity?: { t: number; c: number }[];
  };
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
    repoUrl: httpUrl(row.repoUrl),
    authority: row.authority,
    sha256: row.sha256,
    events: events.map(serializeEvent),
    neighbors,
    sourceKin,
    idlInstructions,
    strings,
    syscalls: row.profile?.syscalls ?? [],
    syscallSource: row.profile?.syscallSource ?? null,
    // handler names read off the binary — present for programs with no IDL
    instructionNames: row.profile?.instructionNames ?? [],
    instructionSource: row.profile?.instructionSource ?? null,
    securityTxt: facts.securityTxt ?? null,
    // the repo URL is a search hit rendered as an href — same scheme guard as
    // every other string that came out of a binary or a third party
    repoLink:
      facts.repoLink && httpUrl(facts.repoLink.repoUrl)
        ? { ...facts.repoLink, repoUrl: httpUrl(facts.repoLink.repoUrl)! }
        : null,
    activity: facts.activity ?? null, // full 7-day series on the dossier
  };
}
