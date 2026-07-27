import Link from "next/link";
import type { ApiCluster, ApiProgramDetail } from "@/lib/api";
import { dayStamp, shortUrl, truncateAddress } from "@/lib/format";
import { Chevron } from "@/components/Chevron";

/**
 * Lineage — the programs this one is related to, as rows.
 *
 * No headline, no verdict sentence: the section header already says "lineage",
 * and a prose read of the rows is noise on top of them. The evidence arrives in
 * three unrelated shapes (fuzzy bytecode distance, recovered crate/source-file
 * overlap, exact hash match against a verified build) that routinely point at
 * the SAME program — so merge them per program id and print one dated row each,
 * with this program on the rail so its place answers "fork or original?".
 */

// the classifier calls TLSH distance ≥150 novel — similarity = 1 − d/300
const NOVEL_SIM = 0.5;
const FAMILY_SIM = 0.83;
// a pack of same-shaped programs → the nearest is a lookalike, not a source
const CROWD_PEERS = 6;
const MAX_ROWS = 6;
// a clone family can run to thousands — the list shows a few, the family line counts them
const MAX_BUCKET_ROWS = 3;
// rows visible before expanding — enough to see the shape of the timeline
const PEEK = 2;

type Relative = {
  id: string;
  name: string | null;
  deployedAt: string | null;
  similarity: number | null; // structural (TLSH) match of the compiled code
  sharedFiles: number | null; // .rs files in common, recovered from panic paths
  exactRepo: string | null; // byte-identical to this verified build
  sameBucket: boolean; // clone bucket: identical sha256, or TLSH inside 50
  closed: boolean; // ProgramData gutted, rent reclaimed
};

// how a mainnet program was tied back to its devnet sighting
const INCUBATION_MATCH: Record<"sha256" | "tlsh" | "authority" | "program_id", string> = {
  sha256: "identical bytecode",
  tlsh: "near-identical bytecode",
  authority: "same upgrade authority",
  program_id: "same program address",
};

const SIM_TIP =
  "Structural similarity of the compiled bytecode (TLSH fuzzy hash) — a lead, not proof of copied code.";
const KIN_TIP =
  "Recovered from Rust panic paths baked into the binary: compiled from a crate of the same name, sharing this many of their own source files. Shared code, not necessarily an affiliated team.";
const BUCKET_TIP =
  "Same clone bucket — identical or near-identical bytecode under a fresh program id.";

/** Every lineage signal, merged per program id. The clone bucket is one of
 *  them: a bucket sibling IS a relative — near-identical bytecode under a fresh
 *  id — and listing it in the Activity tab instead let the two sections
 *  disagree about the same family (bucket ids are assigned once at ingest,
 *  first match wins; nearest/kin are recomputed against the whole corpus). */
function relativesOf(p: ApiProgramDetail, family: ApiCluster | null): Relative[] {
  const byId = new Map<string, Relative>();
  const put = (id: string, patch: Partial<Relative>) => {
    const cur: Relative = byId.get(id) ?? {
      id,
      name: null,
      deployedAt: null,
      similarity: null,
      sharedFiles: null,
      exactRepo: null,
      sameBucket: false,
      closed: false,
    };
    byId.set(id, {
      ...cur,
      ...patch,
      name: patch.name ?? cur.name,
      deployedAt: patch.deployedAt ?? cur.deployedAt,
    });
  };
  if (p.nearest?.id) {
    put(p.nearest.id, {
      name: p.nearest.name,
      deployedAt: p.nearest.deployedAt,
      similarity: p.nearest.similarity,
    });
  }
  for (const k of p.sourceKin ?? []) {
    put(k.programId, { name: k.name, deployedAt: k.deployedAt, sharedFiles: k.sharedFiles });
  }
  if (p.codeMatch) put(p.codeMatch.programId, { exactRepo: p.codeMatch.repository });
  for (const m of family?.members ?? []) {
    if (m.programId === p.id) continue;
    put(m.programId, {
      name: m.name,
      deployedAt: m.deployedAt,
      sameBucket: true,
      closed: m.closed,
    });
  }
  return [...byId.values()];
}

/** Strongest evidence first — decides the preview row and the row cap. */
function strength(r: Relative): number {
  if (r.exactRepo) return 4;
  if (r.sameBucket) return 3;
  if (r.similarity != null && r.similarity >= FAMILY_SIM) return 2;
  if (r.sharedFiles) return 1;
  return 0;
}

function ts(iso: string | null): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? Infinity : t; // undated (reference corpus) sorts last
}

/** What ties this relative to the program. */
function evidenceOf(r: Relative, crowdOf: number | null): string {
  const why: string[] = [];
  if (r.exactRepo) why.push("byte-identical");
  if (r.sameBucket) why.push("same code");
  if (r.similarity != null) why.push(`${Math.round(r.similarity * 100)}% match`);
  // in a crowd the nearest is one arbitrary member of a lookalike pack, not a
  // source — say so on the row so it can't be read as the thing it came from
  if (crowdOf != null) why.push(`one of ${crowdOf}`);
  if (r.sharedFiles != null) why.push(`${r.sharedFiles} files shared`);
  if (r.closed) why.push("closed");
  return why.join(" · ");
}

/** The name, shown only when it differs from this program's — a family of
 *  redeploys shares one name, and printing it on every row says nothing. The
 *  address is always shown: a name is spoofable (a fork inherits it from copied
 *  bytecode), the address is what tells the real program from a lookalike. */
function relName(r: Relative, selfName: string | null): string | null {
  return r.name && r.name !== selfName ? r.name : null;
}

/** One record: when, what, how it relates. */
function RelativeRow({
  r,
  selfName,
  crowdOf,
}: {
  r: Relative;
  selfName: string | null;
  crowdOf: number | null;
}) {
  const name = relName(r, selfName);
  return (
    <li className="lin-row">
      <span className="lin-when">{r.deployedAt ? dayStamp(r.deployedAt) : "undated"}</span>
      <span className="lin-who">
        <Link href={`/p/${r.id}`} className="neighbor-addr">
          {name ? (
            <>
              {name} <span className="cell-dim">{truncateAddress(r.id)}</span>
            </>
          ) : (
            truncateAddress(r.id)
          )}
        </Link>
      </span>
      <span
        className="lin-why"
        title={
          r.sameBucket
            ? BUCKET_TIP
            : r.sharedFiles != null && r.similarity == null
              ? KIN_TIP
              : SIM_TIP
        }
      >
        {evidenceOf(r, crowdOf)}
        {r.exactRepo ? (
          <>
            {" "}
            <a
              className="receipt-link"
              href={r.exactRepo}
              target="_blank"
              rel="noopener noreferrer"
            >
              {shortUrl(r.exactRepo)}
              <span aria-hidden="true"> ↗</span>
            </a>
          </>
        ) : null}
      </span>
    </li>
  );
}

/** The family's behaviour, not its membership — the one thing the rows above
 *  can't say. A factory redeploys and closes; a fork ships once. */
function FamilyLine({ family }: { family: ApiCluster }) {
  const dated = family.members
    .map((m) => m.deployedAt)
    .filter((d): d is string => !!d)
    .sort();
  const closed = family.members.filter((m) => m.closed).length;
  const total = Math.max(family.memberCount, family.members.length);
  return (
    <p className="lin-meta">
      <span className="lin-meta-label">code family</span>
      <span title="Programs sharing this bytecode, tracked as one clone bucket. A factory redeploys and closes; a fork ships once. Dates span the members on record.">
        {total} deploys
        {dated.length > 1 ? (
          <span className="cell-dim">
            {" · "}
            {dayStamp(dated[0])} → {dayStamp(dated[dated.length - 1])}
          </span>
        ) : null}
        {closed > 0 ? (
          <span className="cell-dim">
            {" · "}
            {closed} already closed
          </span>
        ) : null}
      </span>
    </p>
  );
}

/** This program's own devnet history — only a same-address or same-authority
 *  match is ITS history. A sha256/tlsh hit just means code that LOOKS like this
 *  was on devnet first, which for a fork is somebody else's history entirely
 *  (a 23h-old Phoenix clone read "3.8 days on devnet before mainnet"). */
function DevnetLine({ inc }: { inc: NonNullable<ApiProgramDetail["incubation"]> }) {
  const own = inc.matchedOn === "program_id" || inc.matchedOn === "authority";
  const days =
    inc.incubationDays >= 1
      ? `${inc.incubationDays} day${inc.incubationDays === 1 ? "" : "s"}`
      : "under a day";
  const deploys =
    inc.devnetDeploysTotal != null && inc.devnetDeploysTotal > inc.devnetIterations
      ? `${inc.devnetIterations} of ${inc.devnetDeploysTotal} deploys pre-launch`
      : `${inc.devnetIterations} deploy${inc.devnetIterations === 1 ? "" : "s"} pre-launch`;
  return (
    <p className="lin-meta">
      <span className="lin-meta-label">{own ? "devnet origin" : "on devnet"}</span>
      <span
        title={`first seen on devnet ${dayStamp(inc.firstDevnetAt)}${inc.lastDevnetAt ? `, last ${dayStamp(inc.lastDevnetAt)}` : ""} · matched on ${INCUBATION_MATCH[inc.matchedOn]}`}
      >
        {days} {own ? "before mainnet" : "earlier"}
        <span className="cell-dim"> · {deploys}</span>
      </span>
      {inc.devnetProgramId ? (
        <>
          <span className="cell-dim"> · </span>
          {inc.matchedOn === "program_id" ? (
            <a
              className="receipt-link"
              href={`https://explorer.solana.com/address/${inc.devnetProgramId}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
            >
              same address on devnet
              <span aria-hidden="true"> ↗</span>
            </a>
          ) : (
            <Link href={`/p/${inc.devnetProgramId}`} className="neighbor-addr">
              {truncateAddress(inc.devnetProgramId)}
            </Link>
          )}
        </>
      ) : null}
    </p>
  );
}

export function Lineage({
  program,
  family,
}: {
  program: ApiProgramDetail;
  family: ApiCluster | null;
}) {
  const found = relativesOf(program, family);
  // A distant bytecode neighbour is not a relative — below the classifier's own
  // novel threshold there is nothing to trace, so it doesn't get a row.
  const all = found.filter(
    (r) =>
      r.exactRepo ||
      r.sameBucket ||
      r.sharedFiles != null ||
      (r.similarity != null && r.similarity > NOVEL_SIM),
  );
  const byStrength = [...all].sort(
    (a, b) => strength(b) - strength(a) || ts(b.deployedAt) - ts(a.deployedAt),
  );
  // Keep the strongest evidence, but cap the clone-bucket siblings: a factory
  // has hundreds of byte-identical ids and they would crowd out the rows that
  // say something new (a 99% neighbour, a shared crate). Their number and
  // cadence are the family line's job, not the list's.
  let bucketRows = 0;
  const shown = byStrength
    .filter((r) => !r.sameBucket || strength(r) > 3 || ++bucketRows <= MAX_BUCKET_ROWS)
    .slice(0, MAX_ROWS)
    .sort((a, b) => ts(a.deployedAt) - ts(b.deployedAt));
  const hidden = all.length - shown.length;
  const selfAt = program.firstDeployAt ?? program.deployedAt;
  const selfIndex = shown.filter((r) => ts(r.deployedAt) <= ts(selfAt)).length;
  const crowd =
    program.nearest?.peersWithin5 != null && program.nearest.peersWithin5 >= CROWD_PEERS
      ? program.nearest.peersWithin5
      : null;
  const crowdOf = (r: Relative) => (r.id === program.nearest?.id ? crowd : null);

  // nothing to show — one dim line, no empty card
  if (!all.length && !program.incubation && !family) {
    const pct = program.nearest ? Math.round(program.nearest.similarity * 100) : null;
    return (
      <div className="lineage-panel lineage-none">
        no relatives on chain
        {pct != null ? ` · closest bytecode is only ${pct}% alike` : null}
      </div>
    );
  }

  // Collapsed clips the list mid-row: a half-visible record says "there is
  // more" in a way a count never does. Every row is rendered either way.
  const rows = [
    ...shown.slice(0, selfIndex).map((r) => (
      <RelativeRow key={r.id} r={r} selfName={program.name} crowdOf={crowdOf(r)} />
    )),
    <li className="lin-row lin-self" key="self">
      <span className="lin-when">{selfAt ? dayStamp(selfAt) : "undated"}</span>
      <span className="lin-who">{truncateAddress(program.id)}</span>
      <span className="lin-why">this program</span>
    </li>,
    ...shown.slice(selfIndex).map((r) => (
      <RelativeRow key={r.id} r={r} selfName={program.name} crowdOf={crowdOf(r)} />
    )),
    ...(hidden > 0
      ? [
          <li className="lin-row lin-more" key="more">
            <span className="lin-when" />
            <span className="lin-who">+{hidden} more</span>
            <span className="lin-why">related deploys</span>
          </li>,
        ]
      : []),
  ];

  // Collapsed is a header, not a sliced row: the aggregate in the same
  // label/value shape the radar cards use, and the rows underneath on click.
  // the header wants the most SPECIFIC evidence, not the highest-ranked row: a
  // clone sibling outranks a fuzzy neighbour for the list, but "99% match"
  // says more in a header than "same code"
  const bySim = all
    .filter((r) => r.similarity != null)
    .sort((a, b) => b.similarity! - a.similarity!)[0];
  const closest =
    all.find((r) => r.exactRepo) ??
    (bySim && bySim.similarity! >= FAMILY_SIM ? bySim : (byStrength[0] ?? null));
  const fields: [string, string][] = [];
  if (all.length) fields.push(["related", `${all.length}${hidden > 0 ? "+" : ""}`]);
  if (closest) fields.push(["closest", evidenceOf(closest, crowdOf(closest))]);
  if (!fields.length && program.incubation) {
    fields.push([
      program.incubation.matchedOn === "program_id" || program.incubation.matchedOn === "authority"
        ? "devnet origin"
        : "on devnet",
      program.incubation.incubationDays >= 1
        ? `${program.incubation.incubationDays} days`
        : "under a day",
    ]);
  }

  return (
    <details className="lineage-panel">
      <summary className="lin-head">
        <span className="lin-head-fields">
          {fields.map(([k, v]) => (
            <span className="lin-field" key={k}>
              <span className="lin-k">{k}</span>
              <span className="lin-v">{v}</span>
            </span>
          ))}
        </span>
        <Chevron className="lin-head-chev" />
      </summary>

      <div className="lin-body">
        <ol className="lin-list">{rows}</ol>
        {family ? <FamilyLine family={family} /> : null}
        {program.incubation ? <DevnetLine inc={program.incubation} /> : null}
      </div>
    </details>
  );
}
