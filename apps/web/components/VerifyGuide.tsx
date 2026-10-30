"use client";

import { useEffect, useState } from "react";
import { ProgramRow, type VerifyFacts } from "@/components/ProgramRow";
import type { ApiProgramDetail, ApiVerification } from "@/lib/api";

/**
 * How far one program is from a verified build: four numbered steps its
 * developer takes. Each row has the step and what it checks on the left, and
 * this program's value for it on the right, so the row reads without opening it. Opening a step shows what to do and
 * the commands, each with a copy button.
 *
 * Each step is a gate. Under the title, its key and this program's value; on
 * the title line, a green check once something proves it passes (verified
 * now, or the version before an upgrade was), else what it needs, in gray.
 * The header counts only passed steps: naming a later step as the one it's
 * "stuck at" would imply the earlier ones passed.
 *
 * Shaped by who signs upgrades: a wallet runs the commands, a Squads multisig
 * approves proposals, another program has its own flow. OtterSec watches the
 * chain and rebuilds when a recipe lands, so its rebuild is the end of step 4,
 * not a step.
 *
 * Data: /api/alerts/check (app/api/alerts/[action]/route.ts).
 */

export type GuideProgram = Omit<
  ApiProgramDetail,
  "events" | "neighbors" | "strings" | "idlInstructions" | "syscalls"
> & {
  /** the declared source answered GitHub publicly; null when it isn't on GitHub or GitHub didn't say */
  sourcePublic?: boolean | null;
};
export interface GuideData {
  program: GuideProgram;
  verification: ApiVerification | null;
  /** the doctor is still reading the chain, OtterSec and GitHub */
  pending: boolean;
}
type Squads = { threshold: number; members: number };

type State = "done" | "blocked" | "open";
type Glyph = "cpu" | "key" | "people" | "gear" | "repo" | "file";
interface StepDef {
  title: string;
  state: State;
  /** this program's own state for the step, on one line under the title:
   *  icon and key, then the value read from the chain (the only coloured text) */
  glyph: Glyph;
  key: string;
  value: string;
  /** what the value has to be to pass, shown on the title line only while the
   *  value is known to fail. Absent where there's no right answer (who signs is
   *  a fact, not a test). */
  need?: string;
  /** where the value points, when it's somewhere to go */
  href?: string;
  /** what to do, a line or two, shown when the step is opened */
  how: string[];
  commands: string[];
  /** what earns the step its check */
  when: string;
}

const TRIES = 6;
const WAIT_MS = 4000;
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
const repoLabel = (url: string) =>
  url
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/^https?:\/\/(www\.)?/i, "")
    .replace(/\/tree\/.*$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");

export function useGuide(id: string, initial?: GuideData): { data: GuideData | null; failed: string | null } {
  const [data, setData] = useState<GuideData | null>(initial ?? null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (initial && !initial.pending) return;
    let live = true;
    let record = initial?.program ?? null;
    const run = async () => {
      for (let i = 0; i < TRIES && live; i++) {
        if (i > 0 || initial) await new Promise((r) => setTimeout(r, WAIT_MS));
        try {
          // once the record is in hand, only the verdict is still coming
          const res = await fetch(`/api/alerts/check?id=${encodeURIComponent(id)}${record ? "&verdict" : ""}`);
          const d = (await res.json()) as Partial<GuideData> & { error?: string };
          if (!live) return;
          if (!res.ok) return setFailed(d.error ?? "couldn't check this one, try again shortly");
          record = d.program ?? record;
          if (record) setData({ program: record, verification: d.verification ?? null, pending: !!d.pending });
          if (!d.pending) return;
        } catch {
          break;
        }
      }
      if (live) setFailed("couldn't finish the check, try again shortly");
    };
    void run();
    return () => {
      live = false;
    };
  }, [id, initial]);
  return { data, failed };
}

/** Who signs upgrades. A program's own record can miss a Squads vault that
 *  hasn't acted for it yet; another program under the same authority may carry
 *  the decoded multisig, passed in as `siblingSquads`. */
function signerOf(p: GuideProgram, siblingSquads: Squads | null) {
  const ms = p.multisig?.threshold && p.multisig.members ? { threshold: p.multisig.threshold, members: p.multisig.members } : null;
  const s = ms ?? siblingSquads;
  if (p.authorityClass === "squads" || siblingSquads)
    return { kind: "squads" as const, label: s ? `Squads ${s.threshold} of ${s.members}` : "Squads multisig", fromSibling: !ms && !!siblingSquads };
  if (p.authorityClass === "program") return { kind: "program" as const, label: "program", fromSibling: false };
  if (p.authorityClass === "none") return { kind: "none" as const, label: "frozen", fromSibling: false };
  return { kind: "wallet" as const, label: "wallet", fromSibling: false };
}

function sourceOf(p: GuideProgram): string | null {
  return p.securityTxt?.source_code || p.repoUrlDeclared || p.repoUrl || null;
}

/** what the verify doctor found, in the terms the steps need */
function read(d: GuideData) {
  const cur = d.verification?.current ?? null;
  const reason = cur ? d.verification?.versions[cur.hash]?.reason ?? null : null;
  return {
    cur,
    reason,
    verified: cur?.status === "verified",
    /** the version before the last upgrade was verified: its build, deploy and source worked */
    before: d.verification?.broke ?? null,
    recipeRepoGone: reason === "the source repo is gone" || reason === "the commit is missing from the repo",
    rebuildDiffers: reason === "the rebuild doesn't match",
  };
}

function steps(d: GuideData, siblingSquads: Squads | null): StepDef[] {
  const p = d.program;
  const r = read(d);
  const machine = p.build?.download ?? p.build?.home ?? null;
  const signer = signerOf(p, siblingSquads);
  const src = sourceOf(p);
  const repo = src ?? "https://github.com/<owner>/<repo>";
  const auth = p.authority ? short(p.authority) : "—";
  const lastCommit = r.before?.commit ? r.before.commit.slice(0, 7) : null;
  const ms = p.multisig?.threshold ? p.multisig : null;
  const sq = ms ? { threshold: ms.threshold!, members: ms.members! } : siblingSquads;

  // 1. the build: a Mac build can't match; a rebuild that differs says the build did
  const buildState: State = r.verified
    ? "done"
    : machine === "mac" || r.rebuildDiffers
      ? "blocked"
      : r.before
        ? "done"
        : "open";
  const machineName = machine === "mac" ? "Mac" : machine === "linux" ? "Linux" : "unknown machine";
  const build: StepDef = {
    title: "Build in the verifier's container",
    state: buildState,
    glyph: "cpu",
    key: "built on",
    need: "needs the verifier image",
    value: r.before && !r.verified && buildState === "done" ? `${machineName.toLowerCase()} · ${lastCommit ?? "last version"} matched` : machineName.toLowerCase(),
    how: [
      "Requires Docker and solana-verify. Build from the commit that gets deployed.",
      "Repos with several programs: add --library-name with this program's crate.",
    ],
    commands: ["cargo install solana-verify", "solana-verify build"],
    when: "a rebuild in the container matches the bytes on chain",
  };

  // 2. the deploy: redone whenever the build is; proven when the build was
  const deploy: StepDef = {
    title: signer.kind === "squads" ? "Propose the upgrade" : signer.kind === "program" ? "Upgrade through its program" : "Deploy that build",
    state: buildState,
    glyph: signer.kind === "squads" ? "people" : signer.kind === "program" ? "gear" : "key",
    key: "authority",
    value:
      signer.kind === "squads"
        ? `${sq ? `${sq.threshold} of ${sq.members}` : "multisig"} · ${auth}`
        : signer.kind === "program"
          ? `program · ${auth}`
          : `wallet · ${auth}`,
    how:
      signer.kind === "squads"
        ? ["Build written to a buffer, buffer handed to the vault, upgrade created in Squads (Developers, Programs, Upgrade) and approved."]
        : signer.kind === "program"
          ? ["The upgrade authority is controlled by a program; the upgrade goes through that program's own flow."]
          : ["Deployed from target/deploy, signed by the upgrade authority."],
    commands:
      signer.kind === "wallet"
        ? [`solana program deploy -um --program-id ${p.id} target/deploy/<program>.so`]
        : [
            "solana program write-buffer -um target/deploy/<program>.so",
            `solana program set-buffer-authority -um <buffer> --new-buffer-authority ${p.authority ?? "<vault>"}`,
          ],
    when: "the program on chain is exactly the container's build",
  };

  // 3. the source: public at the commit that was built, before the recipe lands.
  // The recipe's own repo outranks the declared one: it's the one OtterSec fetches.
  const sourceFails = r.recipeRepoGone || !src || p.sourcePublic === false;
  const source: StepDef = {
    title: "Push that commit to a public repo",
    state: r.verified || (!sourceFails && p.sourcePublic) ? "done" : sourceFails ? "blocked" : "open",
    glyph: "repo",
    key: "public repo",
    need: src ? "needs to be public" : "needs a public repo",
    value: r.recipeRepoGone
      ? `recipe's ${r.reason === "the commit is missing from the repo" ? "commit" : "repo"} not found`
      : src
        ? `${repoLabel(src)}${p.sourcePublic === false ? " · not public" : ""}`
        : "none declared",
    href: !r.recipeRepoGone && src && p.sourcePublic !== false ? src : undefined,
    how: [
      "Pushed before the recipe is uploaded: OtterSec builds the moment it lands.",
      "Cargo.lock committed at the root; declare_id! set to this program's address.",
    ],
    commands: ["git push origin <commit>"],
    when: "OtterSec can fetch the commit the recipe names",
  };

  // 4. the recipe, and OtterSec's rebuild that follows it
  const recipe: StepDef = {
    title: signer.kind === "squads" ? "Propose the recipe" : "Upload the recipe",
    state: r.verified ? "done" : "blocked",
    glyph: "file",
    key: "recipe",
    need: r.cur?.status === "never-submitted" ? "needs uploading" : "needs a matching rebuild",
    value: r.verified
      ? "on chain"
      : r.cur?.status === "never-submitted"
        ? "none on chain"
        : r.cur?.status === "verified-older-build" || r.reason === "the recipe is for an older version"
          ? "for an older version"
          : r.reason ?? "no match",
    how:
      signer.kind === "squads"
        ? ["Signed by the vault: exported as a transaction, imported in Squads (Transaction Builder, Import), approved and executed."]
        : ["Run from the deployed commit, signed by the upgrade authority."],
    commands: [
      signer.kind === "squads"
        ? `solana-verify export-pda-tx -um ${repo} --program-id ${p.id} --uploader ${p.authority ?? "<vault>"} --commit-hash <commit>`
        : `solana-verify verify-from-repo -um --program-id ${p.id} ${repo} --commit-hash <commit>`,
    ],
    when: "OtterSec's rebuild of the recipe matches the chain",
  };

  return [build, deploy, source, recipe];
}

/** 16px line icons for the right-hand facts, in the spirit of GitHub's */
const GLYPH: Record<Glyph, React.ReactNode> = {
  cpu: (
    <>
      <rect x="4" y="4" width="8" height="8" rx="1" />
      <path d="M6 1.5v2.5M10 1.5v2.5M6 12v2.5M10 12v2.5M1.5 6H4M1.5 10H4M12 6h2.5M12 10h2.5" />
    </>
  ),
  key: (
    <>
      <circle cx="5.5" cy="8" r="3" />
      <path d="M8.5 8h6M12.5 8v2.5M14.5 8v1.5" />
    </>
  ),
  people: (
    <>
      <circle cx="6" cy="5.5" r="2.25" />
      <path d="M1.75 13.5c0-2.35 1.9-4.25 4.25-4.25s4.25 1.9 4.25 4.25" />
      <circle cx="11.5" cy="6" r="1.75" />
      <path d="M11 9.4c1.95.2 3.25 1.85 3.25 4.1" />
    </>
  ),
  gear: (
    <>
      <circle cx="8" cy="8" r="2.25" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </>
  ),
  repo: (
    <>
      <path d="M3 2.5A1.5 1.5 0 0 1 4.5 1h8.5v11.5H4.5A1.5 1.5 0 0 0 3 14z" />
      <path d="M3 14a1.5 1.5 0 0 1 1.5-1.5H13V15H4.5A1.5 1.5 0 0 1 3 14z" />
    </>
  ),
  file: (
    <>
      <path d="M9.5 1.5H4A1.5 1.5 0 0 0 2.5 3v10A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5V5.5z" />
      <path d="M9.5 1.5v4h4M5.5 9h5M5.5 11.5h3.5" />
    </>
  ),
};

function Glyph({ name }: { name: Glyph }) {
  return (
    <svg className="vguide-glyph" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {GLYPH[name]}
    </svg>
  );
}

/** a command on one line, cut to fit, with a button that copies all of it */
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="vcmd">
      <code title={text}>{text}</code>
      <button
        type="button"
        className="vcmd-copy"
        onClick={() => {
          const done = () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          };
          // the async clipboard can be refused (permissions, embedded views); fall back to a selection copy
          navigator.clipboard.writeText(text).then(done, () => {
            const t = document.createElement("textarea");
            t.value = text;
            document.body.appendChild(t);
            t.select();
            if (document.execCommand("copy")) done();
            t.remove();
          });
        }}
      >
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}

function facts(d: GuideData, siblingSquads: Squads | null): VerifyFacts {
  const p = d.program;
  const r = read(d);
  const machine = p.build?.download ?? p.build?.home ?? null;
  const signer = signerOf(p, siblingSquads);
  const src = sourceOf(p);
  return {
    builtOn: machine === "mac" ? "mac" : machine === "linux" ? "linux" : null,
    auth: signer.kind === "squads" ? signer.label.replace("Squads ", "") : signer.label,
    source: src ? repoLabel(src) : null,
    recipe: !r.cur ? null : r.verified ? "verified" : r.cur.status === "never-submitted" ? "none" : "not matching",
  };
}


export function VerifyGuide({
  id,
  initial,
  card = true,
  siblingSquads = null,
}: {
  id: string;
  initial?: GuideData;
  card?: boolean;
  /** a Squads multisig decoded from another program under the same authority */
  siblingSquads?: Squads | null;
}) {
  const { data, failed } = useGuide(id, initial);
  if (!data) {
    return failed ? <p className="alert-signup-error">{failed}</p> : <p className="alert-signup-programs">Checking…</p>;
  }
  const p = data.program;
  const head = card ? (
    <div className="vguide-card">
      <ProgramRow program={p} showNetwork verify={facts(data, siblingSquads)} />
    </div>
  ) : null;

  if (p.network !== "mainnet" || p.closed) {
    return (
      <div className="vguide">
        {head}
        <p className="vguide-off">{p.closed ? "Closed" : "Devnet · OtterSec verifies mainnet only"}</p>
      </div>
    );
  }
  const r = read(data);
  if (!r.cur) {
    return (
      <div className="vguide">
        {head}
        <p className="alert-signup-programs">{data.pending ? "Checking…" : failed ?? "Couldn't read the program on chain"}</p>
      </div>
    );
  }
  if (!r.verified && p.authorityClass === "none") {
    return (
      <div className="vguide">
        {head}
        <p className="vguide-off">Frozen · can&apos;t be upgraded to a verifiable build</p>
      </div>
    );
  }

  const list = steps(data, siblingSquads);
  // only what something proves counts: a step the chain can't confirm isn't done
  const done = list.filter((s) => s.state === "done").length;

  return (
    <div className="vguide">
      {head}
      <div className="vguide-progress">
        <p className={`vguide-count ${r.verified ? "vguide-count-done" : ""}`}>
          {r.verified ? "✓ Verified" : `${done} of ${list.length} steps done`}
        </p>
        <div className="vguide-bar" aria-hidden>
          {list.map((s, i) => (
            <span key={i} className={`vguide-seg vguide-seg-${s.state}`} />
          ))}
        </div>
      </div>
      <ol className="vguide-steps">
        {list.map((s, i) => (
          <li key={s.title} className={`vguide-step vguide-${s.state}`}>
            <details>
              <summary>
                <span className="vguide-num">{i + 1}</span>
                <span className="vguide-text">
                  {/* title, and on the right the gate: a check once it passes, else what it needs */}
                  <span className="vguide-head">
                    <span className="vguide-title">{s.title}</span>
                    {s.state === "done" ? (
                      <span className="vguide-pass" title="passes">
                        ✓
                      </span>
                    ) : s.need && s.state === "blocked" ? (
                      <span className="vguide-need">{s.need}</span>
                    ) : null}
                  </span>
                  {/* key and value on one line, joined like a receipt */}
                  <span className="vguide-row">
                    <span className="vguide-key">
                      <Glyph name={s.glyph} />
                      {s.key}
                    </span>
                    <span className="vguide-leader" aria-hidden />
                    {s.href ? (
                      <a className="vguide-value" title={s.href} href={s.href} target="_blank" rel="noopener noreferrer">
                        {s.value}
                      </a>
                    ) : (
                      <span className="vguide-value" title={s.value}>
                        {s.value}
                      </span>
                    )}
                  </span>
                </span>
              </summary>
              <div className="vguide-body">
                <p className="vguide-label">{s.state === "done" ? "How it was done" : "Action"}</p>
                {s.how.map((h) => (
                  <p key={h} className="vguide-how">
                    {h}
                  </p>
                ))}
                {s.commands.map((c) => (
                  <Command key={c} text={c} />
                ))}
                <p className="vguide-when">
                  <span className="vguide-when-check">✓</span> when {s.when}
                </p>
              </div>
            </details>
          </li>
        ))}
      </ol>
    </div>
  );
}
