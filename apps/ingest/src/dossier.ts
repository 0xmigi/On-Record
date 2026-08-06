import { and, desc, eq, ne, sql } from "drizzle-orm";
import {
  db,
  schema,
  fetchAnchorIdl,
  primitiveTier,
  sampleProgramTraffic,
  sharedPathCount,
  pathOverlap,
  isSourceRelative,
  type EventEnrichment,
  type Network,
  type SecurityTxt,
  type TrafficSample,
} from "@onrecord/core";
import { familyFor } from "./interest.js";

// ---------------------------------------------------------------------------
// The LLM dossier: one program, as plain text, with the provenance attached.
//
// The web dossier is built for a person scanning; this is built for a reader
// that has to WRITE about the program afterwards and be able to defend every
// sentence. Three things follow from that, and they are the whole design:
//
//   1. Corpus-relative, not absolute. "362 KB" means nothing; "11× the median
//      for its framework, top 7% of 830" is a fact you can put in a post. Those
//      comparisons are database questions, so they belong here rather than
//      being re-derived by hand (differently) in every conversation.
//
//   2. Every line carries how it was derived. This is the generated form of the
//      method column in docs/posts/chancery.md — the section that makes the
//      "what if someone presses" pass writable instead of reconstructed.
//
//   3. Absent, zero and unknown stay distinct. "no IDL published" and "IDL not
//      checked" are different claims, and collapsing them is how a post ends up
//      asserting something nobody verified.
//
// It deliberately does NOT rank, score, or recommend. Judgement is the reader's
// job; this supplies evidence and its limits.
// ---------------------------------------------------------------------------

type SubjectRow = typeof schema.subjects.$inferSelect;

const KB = 1024;
const fmtBytes = (n: number | null): string =>
  n === null ? "unknown" : n >= KB ? `${Math.round(n / KB).toLocaleString()} KB (${n.toLocaleString()} B)` : `${n} B`;
const pct = (n: number): string => `${Math.round(n * 100)}%`;
const iso = (d: Date | null): string => d?.toISOString().replace(".000Z", "Z") ?? "unknown";

/** `- **label** — value  ·  _how it was derived_` */
function fact(label: string, value: string | number | null | undefined, method: string): string {
  const v = value === null || value === undefined || value === "" ? "unknown" : String(value);
  return `- **${label}** — ${v}  ·  _${method}_`;
}

function daysSince(d: Date | null): number | null {
  return d ? Math.floor((Date.now() - d.getTime()) / 86_400_000) : null;
}

// --- corpus statistics -------------------------------------------------------
// Cached per network for a few minutes: these are full-table aggregates over a
// corpus that grows by ~157 rows a day, so a stale-by-minutes answer is exact
// enough for "how unusual is this" and saves a scan per program in a batch.

interface SyscallCensus {
  perSyscall: Map<string, number>;
  programsWithProfile: number;
  computedAt: number;
}
const syscallCensusCache = new Map<Network, SyscallCensus>();
const CENSUS_TTL_MS = 5 * 60_000;

async function syscallCensus(network: Network): Promise<SyscallCensus> {
  const hit = syscallCensusCache.get(network);
  if (hit && Date.now() - hit.computedAt < CENSUS_TTL_MS) return hit;

  const rows = await db.execute<{ syscall: string; n: number }>(sql`
    select s.value as syscall, count(*)::int as n
    from ${schema.subjects}, jsonb_array_elements_text(${schema.subjects.profile} -> 'syscalls') s
    where ${schema.subjects.network} = ${network}
    group by 1
  `);
  const [totals] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.subjects)
    .where(and(eq(schema.subjects.network, network), sql`${schema.subjects.profile} is not null`));

  const census: SyscallCensus = {
    perSyscall: new Map(rows.map((r) => [r.syscall, Number(r.n)])),
    programsWithProfile: Number(totals?.n ?? 0),
    computedAt: Date.now(),
  };
  syscallCensusCache.set(network, census);
  return census;
}

interface SizeCohort {
  framework: string;
  n: number;
  median: number | null;
  atOrBelow: number;
}

/** Where this program's size sits among programs built the same way. Compared
 *  within framework because the distributions barely overlap — a 40 KB Anchor
 *  program is tiny and a 40 KB Pinocchio program is ordinary. */
async function sizeCohort(
  network: Network,
  framework: string | null,
  sizeBytes: number | null,
): Promise<SizeCohort | null> {
  if (!framework || sizeBytes === null) return null;
  const [row] = await db.execute<{ n: number; median: number | null; at_or_below: number }>(sql`
    select count(*)::int as n,
           percentile_cont(0.5) within group (order by ${schema.subjects.sizeBytes}) as median,
           count(*) filter (where ${schema.subjects.sizeBytes} <= ${sizeBytes})::int as at_or_below
    from ${schema.subjects}
    where ${schema.subjects.network} = ${network}
      and ${schema.subjects.profile} ->> 'framework' = ${framework}
      and ${schema.subjects.sizeBytes} is not null
  `);
  if (!row) return null;
  return {
    framework,
    n: Number(row.n),
    median: row.median === null ? null : Number(row.median),
    atOrBelow: Number(row.at_or_below),
  };
}

/** Programs built from the same crate, with shared-path evidence. Mirrors the
 *  dossier route's lineage panel so the two never disagree. */
async function sourceKin(row: SubjectRow): Promise<{ id: string; name: string | null; shared: number }[]> {
  if (!row.crate) return [];
  const candidates = await db
    .select({
      id: schema.subjects.id,
      name: schema.subjects.name,
      crate: schema.subjects.crate,
      sourcePaths: schema.subjects.sourcePaths,
    })
    .from(schema.subjects)
    .where(
      and(
        eq(schema.subjects.network, row.network),
        eq(schema.subjects.crate, row.crate),
        ne(schema.subjects.id, row.id),
      ),
    )
    .limit(200);
  const mine = row.sourcePaths ?? [];
  const kin: { id: string; name: string | null; shared: number }[] = [];
  for (const c of candidates) {
    const theirs = c.sourcePaths ?? [];
    const shared = sharedPathCount(mine, theirs);
    if (!isSourceRelative(row.crate, c.crate, shared, pathOverlap(mine, theirs))) continue;
    kin.push({ id: c.id, name: c.name, shared });
  }
  return kin.sort((a, b) => b.shared - a.shared).slice(0, 8);
}

// --- the document ------------------------------------------------------------

export interface DossierOptions {
  /** parse recent transactions (metered RPC). Off → the traffic section says so. */
  sample?: boolean;
}

export async function buildDossier(programId: string, opts: DossierOptions = {}): Promise<string | null> {
  const [row] = await db.select().from(schema.subjects).where(eq(schema.subjects.id, programId));
  if (!row) return null;

  const network = row.network as Network;
  const facts = (row.facts ?? {}) as {
    securityTxt?: SecurityTxt;
    hasSecurityTxt?: boolean;
    website?: string;
    social?: string;
    upgradeCount?: number;
    upgradeCountTruncated?: boolean;
    nearest?: { id: string; distance: number; peersWithin5?: number };
    funderAddress?: string;
    deployCostLamports?: number;
    incubation?: {
      firstDevnetAt?: string;
      incubationDays?: number;
      devnetIterations?: number;
      devnetProgramId?: string;
      matchedOn?: string;
    };
    multisig?: { threshold?: number; members?: number; version?: string; address?: string };
    momentum?: { txns24h: number };
    closedAt?: string;
    interest?: { score: number; components: Record<string, number> };
    repoUrlDead?: boolean;
  };
  const profile = row.profile ?? null;

  const events = await db
    .select()
    .from(schema.events)
    .where(eq(schema.events.programId, row.id))
    .orderBy(desc(schema.events.slot))
    .limit(50);

  let strings: string[] = [];
  for (const e of events) {
    const fp = (e.enrichment as EventEnrichment).fingerprint;
    if (fp) {
      strings = fp.strings ?? [];
      break;
    }
  }

  const [census, cohort, kin, family, idl] = await Promise.all([
    syscallCensus(network),
    sizeCohort(network, profile?.framework ?? null, row.sizeBytes),
    sourceKin(row),
    familyFor(row),
    fetchAnchorIdl(network, row.id).catch(() => null),
  ]);

  let traffic: TrafficSample | null = null;
  let trafficError: string | null = null;
  if (opts.sample !== false) {
    try {
      traffic = await sampleProgramTraffic(network, row.id);
    } catch (err) {
      trafficError = String(err);
    }
  }

  const out: string[] = [];
  const h = (t: string) => out.push("", `## ${t}`, "");

  // --- header ---------------------------------------------------------------
  out.push(`# ${row.name ?? "(unnamed)"} — \`${row.id}\``);
  out.push("");
  out.push(
    `${network} · ${profile?.framework ?? "framework unknown"} · ${fmtBytes(row.sizeBytes)} · ` +
      `first deployed ${iso(row.firstDeployAt ?? row.firstSeenAt)}` +
      (facts.closedAt ? ` · **CLOSED ${facts.closedAt}** (rent reclaimed)` : ""),
  );
  out.push("");
  out.push(
    "_Generated for analysis. Every line states how it was derived. " +
      "Absent, zero and unknown are kept distinct — do not read one as another._",
  );

  // --- identity -------------------------------------------------------------
  h("Identity and deployment");
  const age = daysSince(row.firstDeployAt ?? row.firstSeenAt);
  out.push(fact("Name", row.name, row.name ? "recovered from bytecode or declared" : "no name recovered"));
  out.push(fact("First deploy", iso(row.firstDeployAt ?? row.firstSeenAt), "ProgramData signature history (oldest)"));
  out.push(
    fact(
      "Age",
      age === null ? null : `${age} days`,
      "derived from first deploy — a program is only NEW if this is small",
    ),
  );
  out.push(
    fact(
      "Upgrades",
      facts.upgradeCount === undefined
        ? null
        : `${facts.upgradeCount}${facts.upgradeCountTruncated ? "+ (page cap hit — this is a floor)" : ""}`,
      "ProgramData history: it appears only in deploy/upgrade/set-authority txns",
    ),
  );
  out.push(fact("Last event", iso(row.lastEventAt), "events table"));
  out.push(
    fact(
      "Deploy classification",
      row.deployType,
      "'upgrade' means the program id already existed — NOT a new program",
    ),
  );
  out.push(fact("Size", fmtBytes(row.sizeBytes), "ProgramData account length"));
  out.push(
    fact(
      "Deploy cost",
      facts.deployCostLamports ? `${(facts.deployCostLamports / 1e9).toFixed(3)} SOL` : null,
      "rent paid to hold the bytecode — SOL locked up, not spent",
    ),
  );
  out.push(fact("Authority", row.authority, "ProgramData header"));
  out.push(
    fact(
      "Authority class",
      row.authorityClass === "hot_wallet"
        ? "hot_wallet — one key can replace the program at will"
        : row.authorityClass,
      "classifier; 'none' means immutable",
    ),
  );
  if (facts.multisig) {
    out.push(
      fact(
        "Multisig",
        `${facts.multisig.threshold ?? "?"}-of-${facts.multisig.members ?? "?"}` +
          (facts.multisig.version ? ` (Squads ${facts.multisig.version})` : "") +
          (facts.multisig.address ? ` at \`${facts.multisig.address}\`` : ""),
        "a 1-of-N threshold is a hot wallet wearing a multisig costume — say so if it is",
      ),
    );
  }
  out.push(fact("Funded by", facts.funderAddress, "funding trail walk from the deployer"));
  if (facts.incubation) {
    out.push(
      fact(
        "Devnet incubation",
        `first devnet sighting ${facts.incubation.firstDevnetAt ?? "?"} · ${facts.incubation.incubationDays ?? "?"} days before mainnet · ` +
          `${facts.incubation.devnetIterations ?? "?"} devnet iteration(s)` +
          (facts.incubation.devnetProgramId ? ` · devnet id \`${facts.incubation.devnetProgramId}\`` : "") +
          (facts.incubation.matchedOn ? ` · matched on ${facts.incubation.matchedOn}` : ""),
        "someone tested before shipping — a real signal, and matched on bytecode similarity not on the id",
      ),
    );
  }
  out.push(fact("SHA-256", row.sha256, "bytecode hash"));

  // --- disclosure -----------------------------------------------------------
  h("Disclosure");
  const disclosures = [
    ["name", Boolean(row.name)],
    ["repo", Boolean(row.repoUrl) && !facts.repoUrlDead],
    ["site or social", Boolean(facts.website || facts.social)],
    ["IDL", Boolean(row.idlPresent || idl)],
    ["security.txt", Boolean(facts.hasSecurityTxt || facts.securityTxt)],
    ["verified build", Boolean(row.verified)],
  ] as const;
  out.push(
    fact(
      "Disclosure count",
      `${disclosures.filter(([, v]) => v).length} of 6 — ${disclosures.map(([k, v]) => `${k}: ${v ? "yes" : "no"}`).join(", ")}`,
      "these are six things a sniper never bothers with; all-absent is the 93% baseline",
    ),
  );
  out.push(fact("Repo", facts.repoUrlDead ? `${row.repoUrl} (DEAD — 404s)` : row.repoUrl, "declared or found; liveness checked"));
  out.push(fact("Website", facts.website, "security.txt or bytecode strings"));
  out.push(fact("Social", facts.social, "security.txt or bytecode strings"));
  out.push(fact("Verified build", row.verified ? "yes" : "no", "OtterSec/osec verify lookup"));
  if (facts.securityTxt) {
    const s = facts.securityTxt as Record<string, unknown>;
    out.push(
      fact(
        "security.txt",
        Object.entries(s)
          .filter(([, v]) => typeof v === "string" && v)
          .map(([k, v]) => `${k}: ${v}`)
          .join(" · "),
        "embedded in the binary — self-declared by the deployer, NOT verified by anyone",
      ),
    );
  }
  if (idl) {
    const i = idl as { instructions?: unknown[]; accounts?: unknown[]; errors?: unknown[]; types?: unknown[] };
    out.push(
      fact(
        "IDL",
        `${i.instructions?.length ?? 0} instructions · ${i.accounts?.length ?? 0} accounts · ${i.errors?.length ?? 0} errors · ${i.types?.length ?? 0} types`,
        "published on-chain (Anchor legacy or Program Metadata Program)",
      ),
    );
  } else {
    out.push(fact("IDL", "not published", "probed both the legacy Anchor address and the PMP"));
  }

  // --- recovered shape ------------------------------------------------------
  h("Recovered shape");
  out.push(
    "_What the binary gives up with no source and no IDL. The source tree comes " +
      "out of Rust panic paths, which survive any release build — this is why ~85% " +
      "of anonymous programs are still legible._",
  );
  out.push("");
  out.push(fact("Crate", row.crate, "dominant crate name in leaked panic paths"));
  const paths = row.sourcePaths ?? [];
  if (paths.length) {
    out.push("", "**Source tree** _(Rust panic paths)_", "```");
    for (const p of paths.slice(0, 60)) out.push(p);
    if (paths.length > 60) out.push(`… ${paths.length - 60} more`);
    out.push("```");
  } else {
    out.push(fact("Source tree", "none recovered", "no panic paths in the binary"));
  }
  const handlers = profile?.instructionNames ?? [];
  if (handlers.length) {
    out.push("", `**Handler names** (${handlers.length}, ${profile?.instructionSource ?? "source unknown"})`, "");
    out.push(handlers.slice(0, 80).map((n) => `\`${n}\``).join(" · "));
  }
  out.push("");
  out.push(fact("Capabilities", profile?.capabilities?.join(", "), "syscall groups"));
  out.push(fact("Integrations", profile?.integrations?.join(", "), "known program ids embedded in the binary"));

  // --- corpus position ------------------------------------------------------
  h("Position in the corpus");
  out.push(
    `_Comparisons are against ${census.programsWithProfile.toLocaleString()} profiled ${network} programs on record. ` +
      "Never describe this program as unusual without one of these numbers attached._",
  );
  out.push("");
  if (cohort && row.sizeBytes !== null) {
    const percentile = cohort.n ? Math.round((cohort.atOrBelow / cohort.n) * 100) : null;
    const ratio = cohort.median ? (row.sizeBytes / cohort.median).toFixed(1) : null;
    out.push(
      fact(
        "Size vs framework",
        `${ratio ? `${ratio}× the ${cohort.framework} median (${fmtBytes(cohort.median)})` : "median unknown"}` +
          `${percentile !== null ? ` · larger than ${percentile}% of ${cohort.n.toLocaleString()} ${cohort.framework} programs` : ""}`,
        "size distributions barely overlap between frameworks, so the comparison is within-framework",
      ),
    );
  }
  const syscalls = profile?.syscalls ?? [];
  if (syscalls.length) {
    out.push("", "**Syscalls, with corpus rarity**", "");
    out.push("| syscall | tier | programs on record | share |");
    out.push("|---|---|---|---|");
    const ranked = [...syscalls].sort(
      (a, b) => (census.perSyscall.get(a) ?? 0) - (census.perSyscall.get(b) ?? 0),
    );
    for (const s of ranked) {
      const n = census.perSyscall.get(s) ?? 0;
      const share = census.programsWithProfile ? (n / census.programsWithProfile) * 100 : 0;
      out.push(`| \`${s}\` | ${primitiveTier(s)} | ${n.toLocaleString()} of ${census.programsWithProfile.toLocaleString()} | ${share < 1 ? share.toFixed(2) : share.toFixed(0)}% |`);
    }
    out.push("");
    out.push(`_Syscall source: ${profile?.syscallSource ?? "unknown"}. Rarest first._`);
  } else {
    out.push(
      fact(
        "Syscalls",
        "none imported",
        "a program with no syscalls cannot log, CPI, or read a sysvar — check what it can possibly do",
      ),
    );
  }
  out.push("");
  out.push(
    fact(
      "Novelty band",
      `${row.noveltyBand ?? "unknown"} (score ${row.noveltyScore?.toFixed(4) ?? "—"})`,
      "structural distance to nearest known code — has misfired in BOTH directions; treat as a hint, never as the verdict",
    ),
  );
  if (facts.nearest) {
    out.push(
      fact(
        "Nearest relative",
        `${facts.nearest.id} at TLSH distance ${facts.nearest.distance}` +
          (facts.nearest.peersWithin5 ? ` · ${facts.nearest.peersWithin5} peers within 5 points` : ""),
        "TLSH over the bytecode; many peers at the same distance means a generic cluster, not a fork",
      ),
    );
  }
  out.push(
    fact(
      "Family",
      `${family.size} member(s), ${family.closed} closed (basis: ${family.basis})`,
      "closed siblings = rent reclaimed. A family that closes nothing is paying to stay; one that buries its own is a factory",
    ),
  );
  if (kin.length) {
    out.push("", "**Same-crate kin** _(shared source-path count)_", "");
    for (const k of kin) out.push(`- \`${k.id}\`${k.name ? ` (${k.name})` : ""} — ${k.shared} shared files`);
  }

  // --- traffic --------------------------------------------------------------
  h("Traffic (sampled, not counted)");
  out.push(
    "_`txns24h` is NOT reported here. It has been wrong twice: once counting one " +
      "identical transaction repeated on a timer as adoption, once counting the " +
      "deployer's own loader operations as usage. What follows is parsed from real " +
      "transactions._",
  );
  out.push("");
  if (trafficError) {
    out.push(fact("Sample", "FAILED", `sampling errored: ${trafficError} — make no usage claim`));
  } else if (!traffic) {
    out.push(
      fact(
        "Sample",
        opts.sample === false ? "not run (sampling disabled)" : "no signatures found",
        opts.sample === false ? "pass ?sample=1 to run it" : "the program id has no transaction history",
      ),
    );
  } else {
    out.push(
      fact(
        "Invocation share",
        `${traffic.invocations} of ${traffic.parsed} parsed transactions actually executed this program (${pct(traffic.invocationShare ?? 0)})`,
        "a low share means the traffic is happening NEAR the program, not through it",
      ),
    );
    out.push(fact("Signatures seen", traffic.signaturesSeen.toLocaleString(), "getSignaturesForAddress, newest first"));
    const shortWindow = traffic.spanHours !== null && traffic.spanHours < 1;
    out.push(
      fact(
        "Span",
        traffic.spanHours === null
          ? null
          : shortWindow
            ? `${Math.round(traffic.spanHours * 60)} minutes — the signature page filled up this fast`
            : `${traffic.spanHours} h`,
        "block times across the sample",
      ),
    );
    out.push(
      fact(
        "Implied rate",
        traffic.perDay === null
          ? null
          : `${traffic.perDay.toLocaleString()} txns/day` +
            (shortWindow ? " — **extrapolated from under an hour; quote the window, not this number**" : ""),
        "sample size ÷ span — an estimate, not a count",
      ),
    );
    out.push(
      fact(
        "Cadence (all traffic)",
        traffic.medianGapSeconds === null
          ? null
          : traffic.medianGapSeconds === 0
            ? "sub-second — several transactions per second, so aggregate cadence says nothing"
            : `median gap ${traffic.medianGapSeconds}s · ${traffic.regularity === null ? "regularity unmeasured" : `${pct(traffic.regularity)} of gaps within ±20% of median`}` +
              (traffic.looksScheduled ? " · **REGULAR — machine-driven, not users**" : ""),
        "organic traffic varies by orders of magnitude between transactions",
      ),
    );
    if (traffic.dominantPayer) {
      const d = traffic.dominantPayer;
      out.push(
        fact(
          "Busiest single payer",
          `\`${d.address}\` — ${d.invocations} invocations (${pct(d.share)} of sampled)` +
            (d.medianGapSeconds !== null && d.medianGapSeconds > 0
              ? ` · every ${d.medianGapSeconds}s` +
                (d.regularity !== null ? `, ${pct(d.regularity)} within ±20%` : "")
              : "") +
            (d.looksScheduled ? " · **ON A TIMER**" : "") +
            (d.address === row.authority ? " · **this is the upgrade authority**" : ""),
          "cadence measured per payer — a timer inside busy traffic is invisible in the aggregate",
        ),
      );
    }
    out.push(fact("Failed", traffic.errorShare === null ? null : pct(traffic.errorShare), "err field on the signature"));
    if (traffic.payload) {
      out.push(
        fact(
          "Payload",
          `${traffic.payload.min}–${traffic.payload.max} B · ${traffic.payload.distinct} distinct size(s)` +
            (traffic.payload.distinct === 1 ? " — **every call identical in size**" : "") +
            (traffic.payload.modalBytes ? ` · most common ${traffic.payload.modalBytes} B` : ""),
          "base58-decoded instruction data",
        ),
      );
    }
    if (traffic.accounts) {
      out.push(fact("Accounts per call", `${traffic.accounts.min}–${traffic.accounts.max}`, "instruction account list length"));
    }
    // Anchor dispatches on an 8-byte discriminator; native and Pinocchio switch
    // on the first byte. Which one applies is not always knowable — Chancery
    // publishes a full IDL and still dispatches on a leading `01 00`, so an
    // either/or guess would hide the real tag half the time. Show the byte
    // histogram always (it is never wrong), and add the 8-byte view only where
    // there is an IDL to match it against.
    if (traffic.leadingBytes.length) {
      out.push("", `**Instruction tags — first payload byte** (${traffic.leadingBytes.length} distinct)`, "");
      for (const t of traffic.leadingBytes) {
        out.push(`- \`0x${t.byte}\` — ${t.count} calls (${t.pct.toFixed(1)}%)`);
      }
      out.push("");
      out.push(
        "_The first byte is the instruction tag under native and Pinocchio dispatch. " +
          "One dominant tag means one code path is doing everything._",
      );
    }
    if (traffic.discriminators.length && (idl || profile?.framework === "anchor")) {
      out.push("", `**Leading 8 bytes** (${traffic.discriminators.length} distinct)`, "");
      for (const d of traffic.discriminators) {
        out.push(`- \`0x${d.disc}\` — ${d.count} calls (${d.pct.toFixed(1)}%)`);
      }
      out.push("");
      out.push(
        "_Anchor's discriminator is the first 8 bytes — match these against the IDL. " +
          "If they share a leading prefix the program is NOT using Anchor dispatch and " +
          "this table is tag-plus-arguments, not discriminators._",
      );
    }
    if (traffic.topFeePayers.length) {
      out.push("", "**Who pays**", "");
      for (const p of traffic.topFeePayers) {
        out.push(
          `- \`${p.address}\` — ${p.count} (${p.pct.toFixed(1)}%)` +
            (p.address === row.authority ? "  ← **the upgrade authority itself**" : ""),
        );
      }
    }
  }

  // --- limits ---------------------------------------------------------------
  h("What is not known");
  const gaps: string[] = [];
  if (!row.name) gaps.push("No name was recovered — the program declares nothing and leaked no crate name.");
  if (!row.verified) gaps.push("The build is not verified: the bytecode cannot be reproduced from any published source, so no repo can be said to *be* this program.");
  if (!idl && !handlers.length) gaps.push("Neither an IDL nor recovered handler names — instruction semantics are unknown, only discriminators.");
  if (!facts.funderAddress) gaps.push("The funding trail did not resolve — no statement can be made about who paid for the deploy.");
  if (!traffic) gaps.push("No traffic sample — make no claim at all about usage.");
  else if ((traffic.invocationShare ?? 1) < 0.5)
    gaps.push(
      `Only ${pct(traffic.invocationShare ?? 0)} of sampled transactions invoked the program. Whatever the rest are, they are not usage — identify them before describing this program as active.`,
    );
  if (facts.securityTxt)
    gaps.push("Everything in security.txt is self-declared by whoever deployed the binary. It names an entity; it does not prove one.");
  if (row.noveltyBand === "clone")
    gaps.push("Banded as a clone: near-identical code exists on record. Check the sibling before calling anything here new.");
  gaps.push("Purpose is never recoverable from bytecode. Anything about intent is inference and must be labelled as such.");
  for (const g of gaps) out.push(`- ${g}`);

  h("Method notes");
  out.push("- Source tree and handler names come from Rust panic paths and string tables — the developer's own names, not guesses.");
  out.push("- TLSH distance measures byte-level structure. It cannot see a shared source tree behind a different build, which is what the crate/kin section is for.");
  out.push("- Corpus comparisons are against programs *on record*, which is a sample of the chain, not the chain.");
  out.push(`- Generated ${new Date().toISOString()}.`);

  return out.join("\n") + "\n";
}
