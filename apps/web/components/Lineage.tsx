import Link from "next/link";
import type { ApiCluster, ApiProgramDetail } from "@/lib/api";
import { dayStamp, formatBytes, shortUrl, truncateAddress } from "@/lib/format";
import { Chevron } from "@/components/Chevron";

/**
 * Lineage — every program built from this code, in one collapsed table.
 *
 * Borrows the Activity tab's record wholesale: same table, same column order
 * (tag, when, what), same cluster label, same tags. The two sections answer
 * different questions about the same program and used to look nothing alike.
 *
 *   The Record  — one program id, every loader event.
 *   Lineage     — every program id built from this code.
 *
 * Hard rules, each of them a version that was rejected:
 *  1. It collapses, and collapsed it is one line. This sits above Framework and
 *     Footprint on the Composition tab and cannot own the screen.
 *  2. One table, one header row. A heading-plus-table per cluster turned two
 *     short lists into half a page; the cluster is a divider row inside the
 *     table, and only when there is more than one.
 *  3. Labels and figures only — no narration. Not "not the newest, BENC…g1hq
 *     came later, closed after 4h": the position is "2nd of 3", the state is a
 *     CLOSED tag. Nothing is carried over from the record's heading that
 *     lineage has no use for (authority class, upgrade counts, last-seen).
 *  4. Rows run oldest→newest inside a cluster, never across one. A list that
 *     ran 19 Jul → 20 Jul → 13 Jul because devnet was appended to mainnet reads
 *     as broken chronology.
 *  5. Every row says whether that program is still open, and unknown prints
 *     "—", never a false LIVE.
 */

// the classifier calls TLSH distance ≥150 novel — similarity = 1 − d/300
const NOVEL_SIM = 0.5;
const FAMILY_SIM = 0.83;
// (the crowd/size thresholds that decide a weak match live in core/lineage.ts —
// the API applies them so the radar card and this panel can't disagree)
const MAX_ROWS = 8;
// a clone family can run to thousands — the table shows a few, the last row
// counts the rest
const MAX_BUCKET_ROWS = 4;

type Tone = "self" | "kin" | "weak";

type Relative = {
  id: string;
  name: string | null;
  deployedAt: string | null;
  similarity: number | null; // structural (TLSH) match of the compiled code
  sharedFiles: number | null; // .rs files in common, recovered from panic paths
  exactRepo: string | null; // byte-identical to this verified build
  sameBucket: boolean; // clone bucket: identical sha256, or TLSH inside 50
  closed: boolean; // ProgramData gutted, rent reclaimed
  closedAt: string | null; // when — deployedAt→closedAt is how long it lived
  /** whether open/closed is known at all. An API that predates the closedAt
   *  fields sends nothing, and "we don't know" must never render as LIVE. */
  stateKnown: boolean;
  /** Measured bytecode similarity to this program (0..1), from the API's own
   *  TLSH pass over the size window. null = not measured, which is not zero. */
  measured: number | null;
  /** set when the similarity is measuring generic shape, not kinship — the API
   *  decides this (core/lineage.ts) so every surface agrees */
  weak: "crowd" | "size" | null;
  peersWithin5: number | null; // how big the lookalike crowd is, when it is one
};

/** One line in the table. Both clusters produce these, so the two sections are
 *  the same component with different rows. */
type Row = {
  key: string;
  when: string | null;
  id: string;
  name: string | null;
  href: string | null;
  external: boolean;
  tag: string; // how it was matched, as a label
  /** 1–4: how strong that evidence is. Drives the shading, so the reader ranks
   *  the rows by looking rather than by knowing what the words mean. 0 = the
   *  program itself, which is not a match. */
  level: number;
  tone: Tone;
  repo: string | null;
  status: "live" | "closed" | null; // null = never established
  statusNote: string | null; // "4h" — how long it lasted, figure only
  statusTip: string | null;
  tip: string;
};

const SIM_TIP =
  "Structural similarity of the compiled bytecode (TLSH fuzzy hash) — a lead, not proof of copied code.";

/** How long a deploy lasted, for the rows that ended. Coarse on purpose: the
 *  point is "hours, not months", never a duration to quote. */
function lifespan(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `${Math.max(minutes, 1)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function ts(iso: string | null): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? Infinity : t; // undated (reference corpus) sorts last
}

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
      closedAt: null,
      stateKnown: false,
      measured: null,
      weak: null,
      peersWithin5: null,
    };
    byId.set(id, {
      ...cur,
      ...patch,
      name: patch.name ?? cur.name,
      deployedAt: patch.deployedAt ?? cur.deployedAt,
      closedAt: patch.closedAt ?? cur.closedAt,
      closed: patch.closed ?? cur.closed,
      stateKnown: patch.stateKnown || cur.stateKnown,
    });
  };
  // `closedAt` absent from the payload means an API that predates the field;
  // `closedAt: null` present means "checked, still open". Only the second is
  // an answer, so the two are kept apart rather than both collapsing to null.
  const state = (o: { closedAt?: string | null }) =>
    "closedAt" in o
      ? { stateKnown: true, closed: o.closedAt != null, closedAt: o.closedAt ?? null }
      : {};
  if (p.nearest?.id) {
    put(p.nearest.id, {
      name: p.nearest.name,
      deployedAt: p.nearest.deployedAt,
      similarity: p.nearest.similarity,
      weak: p.nearest.weak,
      peersWithin5: p.nearest.peersWithin5,
      ...state(p.nearest),
    });
  }
  for (const k of p.sourceKin ?? []) {
    put(k.programId, {
      name: k.name,
      deployedAt: k.deployedAt,
      sharedFiles: k.sharedFiles,
      ...state(k),
    });
  }
  if (p.codeMatch) put(p.codeMatch.programId, { exactRepo: p.codeMatch.repository });
  for (const m of family?.members ?? []) {
    if (m.programId === p.id) continue;
    put(m.programId, {
      name: m.name,
      deployedAt: m.deployedAt,
      sameBucket: true,
      // the bucket route always resolves this one, so it is always an answer
      stateKnown: true,
      closed: m.closed,
      closedAt: m.closedAt ?? null,
    });
  }
  // Last, so it reaches every relative — bucket siblings are added above, and
  // stamping the figures before them silently skipped the whole family.
  for (const [id, sim] of Object.entries(p.similarityTo ?? {})) {
    if (byId.has(id)) put(id, { measured: sim });
  }
  return [...byId.values()];
}

/** Strongest evidence first — decides which rows survive the cap. Zero means
 *  the match is measuring generic shape: a LOOKALIKE, not a relative. */
function strength(r: Relative): number {
  if (r.exactRepo) return 4;
  if (r.sameBucket) return 3;
  // a weak match scores as if it had no similarity at all — it must never be
  // the row a reader takes as "what this was forked from"
  if (!r.weak && r.similarity != null && r.similarity >= FAMILY_SIM) return 2;
  if (r.sharedFiles) return 1;
  return 0;
}

/** How closely this relative's compiled code matches, as a measured figure.
 *
 *  It used to be a five-word taxonomy, and in a real family nine rows in ten
 *  came out SAME BINARY or SAME SOURCE — two labels that looked equally weighty
 *  and had to be learned before either meant anything. They were in fact 100%
 *  and 86%, which ranks itself and needs no glossary.
 *
 *  Words survive only where a figure would be absent or misleading:
 *    LOOKALIKE   — the score is measuring framework shape, so the number would
 *                  read as kinship it hasn't earned.
 *    SAME SOURCE — no bytecode figure exists (the relative sits outside the
 *                  size prefilter) but the source tree matched, which is how a
 *                  build of Drift's crate at distance 182 is still a relative.
 */
function matchOf(r: Relative): { level: number; label: string; tone: Tone; tip: string } {
  const files =
    r.sharedFiles != null
      ? ` Shares ${r.sharedFiles} source files recovered from panic paths in the binary — the same source tree, however far the builds have drifted.`
      : "";
  // The stored `nearest` figure wins where it exists. It is what the radar card
  // and the dossier already print, and those surfaces are required not to
  // disagree with this one. The live pass can differ from it — one program here
  // reads 99% stored and 0% live, because the relative has been upgraded since
  // the fact was written and its fingerprint no longer resembles anything —
  // and a lineage row is the wrong place to discover that.
  const pct = r.similarity ?? r.measured;

  if (r.weak) {
    return {
      level: 1,
      label: "lookalike",
      tone: "weak",
      tip:
        (r.weak === "crowd"
          ? `${r.peersWithin5 ?? "Many"} programs sit equally close on the fuzzy hash, so the score is measuring framework shape rather than kinship. Probably not related at all.`
          : "Too far apart in size to share a body of code. Probably not related at all.") +
        (pct != null ? ` Bytecode is ${Math.round(pct * 100)}% alike.` : ""),
    };
  }
  // A source relative whose builds have diverged scores near zero on bytecode,
  // and a bare "0%" in a lineage table reads as "not related" when the row is
  // there precisely because the source tree matched. Below the corroboration
  // line the word leads and the figure moves to the hover.
  if (r.sharedFiles != null && (pct == null || pct < 0.75)) {
    return {
      level: 3,
      label: "same source",
      tone: "kin",
      tip: `Built from the same source tree.${files}${
        pct != null
          ? ` The compiled images have diverged far enough that only ${Math.round(pct * 100)}% of the bytecode still matches.`
          : " The two builds are too far apart in size for the bytecode comparison to run."
      }`,
    };
  }
  if (pct != null) {
    const n = Math.round(pct * 100);
    return {
      level: n >= 98 ? 4 : n >= 90 ? 3 : n >= 75 ? 2 : 1,
      label: `${n}%`,
      tone: "kin",
      tip:
        `${n}% of the compiled bytecode matches (TLSH fuzzy hash)${
          n === 100 ? " — the same image under a different program id" : ""
        }.${files}` + (r.exactRepo ? " Byte-identical to a published, verified build." : ""),
    };
  }
  if (r.exactRepo) {
    return {
      level: 4,
      label: "identical",
      tone: "kin",
      tip: "Byte-for-byte the same image as this published, verified build.",
    };
  }
  // A bucket sibling with no figure is still a bucket sibling: the family was
  // formed on identical-or-near-identical bytecode. Falling through to
  // "unscored" threw that away and printed a non-answer on five rows.
  if (r.sameBucket) {
    return {
      level: 4,
      label: "same binary",
      tone: "kin",
      tip: `The same compiled image under a different program id — identical, or near enough that the fuzzy hash cannot separate them.${files} No percentage: this one has dropped out of the fingerprint corpus, so the comparison could not be rerun.`,
    };
  }
  if (r.sharedFiles != null) {
    return {
      level: 3,
      label: "same source",
      tone: "kin",
      tip: `Built from the same source tree.${files} The bytecode was not scored — the two builds are too far apart in size for the comparison to run — so there is no percentage to give.`,
    };
  }
  return { level: 1, label: "unscored", tone: "weak", tip: "Related, but not scored." };
}

/** The name, shown only when it differs from this program's — a family of
 *  redeploys shares one name, and printing it on every row says nothing. The
 *  address is always shown: a name is spoofable (a fork inherits it from copied
 *  bytecode), the address is what tells the real program from a lookalike. */
function relName(r: Relative, selfName: string | null): string | null {
  return r.name && r.name !== selfName ? r.name : null;
}

function rowOf(r: Relative, selfName: string | null): Row {
  const { label, level, tone, tip } = matchOf(r);
  return {
    key: r.id,
    when: r.deployedAt,
    id: r.id,
    name: relName(r, selfName),
    href: `/p/${r.id}`,
    external: false,
    tag: label,
    level,
    tone,
    repo: r.exactRepo,
    status: !r.stateKnown ? null : r.closed ? "closed" : "live",
    statusNote: r.closed ? lifespan(r.deployedAt, r.closedAt) : null,
    statusTip: r.closedAt ? `ProgramData closed ${dayStamp(r.closedAt)}` : null,
    tip,
  };
}

/** Four segments, filled to the strength of the evidence. The point is that a
 *  reader ranks the rows without having to learn what the labels mean. */
function Meter({ level }: { level: number }) {
  return (
    <span className="lin-meter" aria-hidden="true">
      {[1, 2, 3, 4].map((i) => (
        <span key={i} className={i <= level ? "lin-seg lin-seg-on" : "lin-seg"} />
      ))}
    </span>
  );
}

/** One row's cells. */
function Cells({ row }: { row: Row }) {
  return (
    <>
      <td>
        <span className={`lin-match lin-match-${row.tone}`} title={row.tip}>
          {row.level > 0 ? <Meter level={row.level} /> : null}
          {row.tag}
        </span>
      </td>
      <td className="cell-dim">{row.when ? dayStamp(row.when) : "—"}</td>
      <td>
        {row.href ? (
          row.external ? (
            <a href={row.href} target="_blank" rel="noopener noreferrer">
              {truncateAddress(row.id)}
              <span aria-hidden="true"> ↗</span>
            </a>
          ) : (
            <Link href={row.href}>{truncateAddress(row.id)}</Link>
          )
        ) : (
          truncateAddress(row.id)
        )}
        {row.name ? <span className="cell-dim"> {row.name}</span> : null}
        {row.repo ? (
          <>
            {" "}
            <a href={row.repo} target="_blank" rel="noopener noreferrer">
              {shortUrl(row.repo)}
              <span aria-hidden="true"> ↗</span>
            </a>
          </>
        ) : null}
      </td>
      <td>
        {row.status ? (
          <span className={`evt-tag lin-state-${row.status}`} title={row.statusTip ?? undefined}>
            {row.status}
          </span>
        ) : (
          <span className="cell-dim" title="Never probed — not on the record either way.">
            —
          </span>
        )}
        {row.statusNote ? <span className="cell-dim"> {row.statusNote}</span> : null}
      </td>
    </>
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
  // Keep the strongest evidence, but cap the clone-bucket siblings: a factory
  // has hundreds of byte-identical ids and they would crowd out the rows that
  // say something new (a 99% neighbour, a shared crate).
  let bucketRows = 0;
  const shown = [...all]
    .sort((a, b) => strength(b) - strength(a) || ts(b.deployedAt) - ts(a.deployedAt))
    .filter((r) => !r.sameBucket || strength(r) > 3 || ++bucketRows <= MAX_BUCKET_ROWS)
    .slice(0, MAX_ROWS);

  const kinTotal = all.filter((r) => strength(r) > 0).length;
  const selfAt = program.firstDeployAt ?? program.deployedAt;
  const otherNetwork: "mainnet" | "devnet" =
    program.counterpart?.network ?? (program.network === "mainnet" ? "devnet" : "mainnet");

  // --- the other cluster ---------------------------------------------------
  // Two different programs can turn up here — this exact address running over
  // there, and an older binary that merely resembles it — and each row says
  // which. Both are dated, so the section sorts oldest→newest like the other.
  const cp = program.counterpart?.present ? program.counterpart : null;
  const inc = program.incubation;
  // only a same-address or same-authority match is THIS program's history. A
  // sha256/tlsh hit means code that LOOKS like this was on devnet first, which
  // for a fork is somebody else's history entirely (a 23h-old Phoenix clone
  // once read "3.8 days on devnet before mainnet").
  const incIsOwn = inc ? inc.matchedOn === "program_id" || inc.matchedOn === "authority" : false;
  const incDays =
    inc && inc.incubationDays >= 1
      ? `${inc.incubationDays} day${inc.incubationDays === 1 ? "" : "s"}`
      : "under a day";
  const otherRows: Row[] = [];
  if (cp) {
    // Size is read off ProgramData on each cluster, so a mismatch means the two
    // are running different builds — the thing a reader must know before
    // carrying any figure from this page across.
    const differs =
      cp.sizeBytes != null && program.sizeBytes != null && cp.sizeBytes !== program.sizeBytes;
    otherRows.push({
      key: "counterpart",
      when: cp.deployedAt,
      id: program.id,
      name: null,
      href: `https://explorer.solana.com/address/${program.id}${otherNetwork === "devnet" ? "?cluster=devnet" : ""}`,
      external: true,
      tag: "this program",
      level: 0,
      tone: "self",
      repo: null,
      status: cp.alive === false ? "closed" : "live",
      statusNote: null,
      statusTip: null,
      tip: `The same program address, probed on ${otherNetwork} ${dayStamp(cp.checkedAt)}${
        differs ? ` — running a different build there (${formatBytes(cp.sizeBytes)})` : ""
      }${cp.authorityClass ? `. Upgrade authority there: ${cp.authorityClass.replace("_", " ")}` : ""}.`,
    });
  }
  // the same address on both clusters is already the row above
  if (inc?.devnetProgramId && inc.devnetProgramId !== program.id) {
    otherRows.push({
      key: "incubation",
      when: inc.firstDevnetAt,
      id: inc.devnetProgramId,
      name: null,
      href: `/p/${inc.devnetProgramId}`,
      external: false,
      tag: incIsOwn ? (inc.matchedOn === "program_id" ? "this program" : "same author") : "lookalike",
      level: incIsOwn ? (inc.matchedOn === "program_id" ? 4 : 3) : 1,
      tone: incIsOwn ? "kin" : "weak",
      repo: null,
      status: null,
      statusNote: null,
      statusTip: null,
      tip: incIsOwn
        ? `This program's own devnet run, matched by ${inc.matchedOn === "program_id" ? "the same address" : "the same upgrade authority"} — ${incDays} before mainnet, ${inc.devnetIterations} deploy${inc.devnetIterations === 1 ? "" : "s"} there.`
        : `Matched to this program on bytecode alone, not by address, so it may belong to another team entirely. First seen ${incDays} before this deploy.`,
    });
  }
  otherRows.sort((a, b) => ts(a.when) - ts(b.when));

  // nothing anywhere — one dim line, not an empty table
  if (!all.length && !otherRows.length) {
    const pct = program.nearest ? Math.round(program.nearest.similarity * 100) : null;
    return (
      <div className="lineage-none">
        no relatives on chain
        {pct != null ? ` · closest bytecode is only ${pct}% alike` : null}
      </div>
    );
  }

  // --- this cluster --------------------------------------------------------
  const selfStatusNote = program.closed ? lifespan(selfAt, program.closedAt) : null;
  const selfRow: Row = {
    key: "self",
    when: selfAt,
    id: program.id,
    name: null,
    href: null,
    external: false,
    tag: "this program",
    level: 0,
    tone: "self",
    repo: null,
    status: program.closed ? "closed" : "live",
    statusNote: selfStatusNote,
    statusTip: program.closedAt ? `ProgramData closed ${dayStamp(program.closedAt)}` : null,
    tip: "The program this page is about.",
  };
  const homeRows: Row[] = [...shown.map((r) => rowOf(r, program.name)), selfRow].sort(
    (a, b) => ts(a.when) - ts(b.when),
  );

  // --- the one collapsed line ----------------------------------------------
  // Position and counts, nothing else. Earlier passes wrote a sentence here
  // ("not the newest — BENC…g1hq came later") and borrowed fields from the
  // record's heading that lineage has no use for; both were narration.
  const dated = [...all.filter((r) => strength(r) > 0 && r.deployedAt), { deployedAt: selfAt }];
  const rank =
    dated.filter((r) => ts(r.deployedAt) > ts(selfAt)).length + 1; // 1 = newest
  const closedKin = all.filter((r) => strength(r) > 0 && r.stateKnown && r.closed).length;
  // Position in the lineage, counted the way the table is ordered — oldest
  // first — so "program 3 of 3" is the bottom row and means newest. The label
  // sits directly under a header reading LINEAGE and builds on it rather than
  // starting a vocabulary of its own.
  const place = kinTotal + 2 - rank; // rank 1 = newest = last in the table
  const bits = [`program ${place} of ${kinTotal + 1}`];
  if (closedKin) bits.push(`${closedKin} closed`);
  if (otherRows.length) bits.push(otherNetwork);

  // What the table leaves out. The clone-bucket count is called out separately
  // because it is usually the bulk of it and it is a different kind of miss.
  const familyTotal = family ? Math.max(family.memberCount, family.members.length) : 0;
  const bucketNotListed = Math.max(0, familyTotal - (shown.filter((r) => r.sameBucket).length + 1));
  const beyondPage = Math.max(0, familyTotal - (family?.members.length ?? 0));
  const notListed = Math.max(0, all.length + beyondPage - shown.length);

  // the cluster divider only earns a row when there is more than one cluster
  const split = otherRows.length > 0;

  return (
    <details className="lineage-panel">
      <summary className="lin-head">
        <span className="lin-sum">{bits.join(" · ")}</span>
        <Chevron className="lin-head-chev" />
      </summary>
      <div className="table-scroll lin-scroll">
        <table className="record-table lin-table">
          {/* Tag, when, what — the record's column order, so a reader moving
              between the two tabs is reading the same table twice. */}
          <thead>
            <tr>
              <th scope="col">Match</th>
              <th scope="col">When</th>
              <th scope="col">Program</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {split ? (
              <tr className="lin-net-tr">
                <td colSpan={4}>
                  <span className={`cluster-record-net cluster-record-net-${program.network}`}>
                    on {program.network}
                  </span>
                </td>
              </tr>
            ) : null}
            {homeRows.map((row) => (
              <tr key={row.key} className={row.tone === "self" ? "lin-tr-self" : undefined}>
                <Cells row={row} />
              </tr>
            ))}
            {notListed > 0 ? (
              <tr className="lin-tr-more">
                <td colSpan={4} className="cell-dim">
                  + {notListed} more
                  {bucketNotListed > 0 ? ` · ${bucketNotListed} byte-identical` : ""}
                </td>
              </tr>
            ) : null}
            {split ? (
              <tr className="lin-net-tr">
                <td colSpan={4}>
                  <span className={`cluster-record-net cluster-record-net-${otherNetwork}`}>
                    on {otherNetwork}
                  </span>
                </td>
              </tr>
            ) : null}
            {otherRows.map((row) => (
              <tr key={row.key}>
                <Cells row={row} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
