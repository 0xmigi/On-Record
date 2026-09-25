import {
  OTTER_SIGNER,
  PUBLIC_MAINNET_RPC,
  isMainnet,
  readProgram,
  readUploads,
  rpcClient,
  type ProgramFacts,
  type Upload,
} from "./chain.js";
import { checkSource, osecStatus, osecStatusAll, parseGithub, type OsecRecord, type SourceCheck } from "./remote.js";

// ---------------------------------------------------------------------------
// Why isn't this program verified? — answered without building anything.
//
// Measured on mainnet 2026-09-25: 1,028 programs have uploaded a verification
// recipe, 534 are verified, and 318 of the rest have since been closed. This
// doctor, run over the 175 live programs that tried and failed, put 151 of
// them down to something visible from chain + OtterSec + GitHub alone:
//   - 107 recipes describe a deploy the program has since upgraded past
//   -  28 were uploaded but never built (the submit step never ran)
//   -  16 point at a repo or commit GitHub can't find
// The other 24 are genuine hash mismatches, the one case that needs a rebuild,
// where the doctor hands over to `solana-verify` locally.
//
// Run over 40 programs from OtterSec's verified list, it agreed on 34. The
// other 6 each have a per-uploader build that matches the chain while /status
// says not verified, and in all 6 the uploader isn't the current authority.
//
// The report is plain data so the same diagnosis can back a panel on the web.
// ---------------------------------------------------------------------------

export type Mark = "pass" | "fail" | "warn" | "unknown";

export interface Check {
  id: "current" | "source" | "signer" | "build";
  mark: Mark;
  label: string;
}

export type Problem =
  | "stale"
  | "source-missing"
  | "commit-missing"
  | "never-built"
  | "hash-differs"
  | "not-marked"
  | "signer";

export interface UploadReport {
  upload: Upload;
  signerRole: "authority" | "ottersec" | "other";
  source: SourceCheck | null;
  record: OsecRecord | null;
  checks: Check[];
  problem: Problem | null;
}

export type Status =
  | "verified"
  | "verified-older-build"
  | "not-verified"
  | "never-submitted"
  | "unreadable";

export interface Fix {
  text: string;
  command?: string;
}

export interface Report {
  programId: string;
  cluster: "mainnet" | "other";
  /** Origin only: the URL the doctor reads through can carry an API key. */
  rpcUrl: string;
  program: ProgramFacts | null;
  status: Status;
  osec: OsecRecord | null;
  /** Every per-uploader build OtterSec holds (/status-all), including ones
   *  for closed uploads and older recipes. null = not asked or unreachable. */
  records: OsecRecord[] | null;
  uploads: UploadReport[];
  /** Index into uploads of the one the diagnosis is about. */
  primary: number | null;
  diagnosis: string;
  fixes: Fix[];
  notes: string[];
}

export interface DoctorOptions {
  rpcUrl: string;
  githubToken?: string;
}

const short = (s: string, n = 8): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const sha = (commit: string): string => commit.slice(0, 7);
const addr = (s: string): string => `${s.slice(0, 4)}…${s.slice(-4)}`;
const slot = (n: number): string => n.toLocaleString("en-US");

export async function diagnose(programId: string, opts: DoctorOptions): Promise<Report> {
  const rpc = rpcClient(opts.rpcUrl);
  const mainnet = await isMainnet(rpc);
  const report: Report = {
    programId,
    cluster: mainnet ? "mainnet" : "other",
    rpcUrl: rpcOrigin(opts.rpcUrl),
    program: null,
    status: "unreadable",
    osec: null,
    records: null,
    uploads: [],
    primary: null,
    diagnosis: "",
    fixes: [],
    notes: [],
  };

  const read = await readProgram(rpc, programId);
  if (!read.ok) {
    report.diagnosis = read.problem;
    return report;
  }
  const p = read.program;
  report.program = p;

  const [uploads, status, records] = await Promise.all([
    readUploads(rpc, programId),
    mainnet ? osecStatus(programId) : Promise.resolve(null),
    mainnet ? osecStatusAll(programId) : Promise.resolve(null),
  ]);
  report.osec = status;
  report.records = records;
  if (!mainnet) {
    report.notes.push(
      "OtterSec's remote verifier, the source of explorer badges, only covers mainnet. On this cluster you can still compare a local build with `solana-verify verify-from-repo`.",
    );
  } else if (!status || !records) {
    report.notes.push("OtterSec's API could not be reached, so build results are unknown.");
  }

  const cmd = commands(programId, printableRpc(opts.rpcUrl, mainnet));

  // -- already verified ------------------------------------------------------
  if (status?.is_verified && status.on_chain_hash === p.hash) {
    report.status = "verified";
    report.uploads = uploads.map((u) => ({
      upload: u,
      signerRole: role(u.signer, p.authority),
      source: null,
      record: records?.find((r) => r.signer === u.signer) ?? null,
      checks: [],
      problem: null,
    }));
    const when = status.last_verified_at ? `, last checked ${status.last_verified_at.slice(0, 10)}` : "";
    report.diagnosis = `OtterSec rebuilt ${repoLabel(status.repo_url)} at commit ${sha(status.commit)} and got exactly the bytes on chain${when}.`;
    return report;
  }
  if (status?.is_verified) {
    report.status = "verified-older-build";
    report.notes.push(
      `OtterSec still lists this program as verified, but for bytes that are no longer on chain (${short(status.on_chain_hash)} vs ${short(p.hash)} now). The badge describes a build from before the last upgrade.`,
    );
  }

  // -- nothing uploaded ------------------------------------------------------
  if (uploads.length === 0) {
    report.status = report.status === "verified-older-build" ? report.status : "never-submitted";
    const closed = (records ?? []).filter((r) => r.is_closed);
    report.diagnosis = closed.length
      ? `A verification recipe was uploaded once (${repoLabel(closed[0]!.repo_url)}), but the upload has since been closed, so there is nothing for OtterSec to check.`
      : "Nobody has uploaded a verification recipe for this program.";
    const source = p.securityTxt?.sourceCode;
    if (source) report.notes.push(`The program's own security.txt names its source: ${source}`);
    report.fixes = mainnetOnly(report, firstTimeFixes(cmd, source ?? closed[0]?.repo_url ?? null, p.authority));
    return report;
  }

  // -- one report per upload --------------------------------------------------
  for (const u of uploads) {
    const r: UploadReport = {
      upload: u,
      signerRole: role(u.signer, p.authority),
      source: null,
      record: null,
      checks: [],
      problem: null,
    };

    // 1. does the recipe describe the bytes on chain now?
    let stale = false;
    if (u.deployedSlot !== null) {
      stale = u.deployedSlot < p.deploySlot;
      r.checks.push({
        id: "current",
        mark: stale ? "fail" : "pass",
        label: stale
          ? `uploaded for the deploy at slot ${slot(u.deployedSlot)}; the program was redeployed at slot ${slot(p.deploySlot)}`
          : "describes the current deploy",
      });
    } else if (u.lastWriteSlot !== null) {
      stale = u.lastWriteSlot < p.deploySlot;
      r.checks.push({
        id: "current",
        mark: stale ? "fail" : "pass",
        label: stale
          ? `last written at slot ${slot(u.lastWriteSlot)}, before the current deploy at slot ${slot(p.deploySlot)}`
          : "written after the current deploy",
      });
    } else {
      r.checks.push({ id: "current", mark: "unknown", label: "could not tell when the recipe was written" });
    }

    // 2. can anyone still fetch the source?
    r.source = await checkSource(u.gitUrl, u.commit, opts.githubToken);
    r.checks.push({ id: "source", mark: sourceMark(r.source, u), label: sourceLabel(r.source, u) });

    // 3. who signed it
    if (r.signerRole === "authority") r.checks.push({ id: "signer", mark: "pass", label: "signed by the current upgrade authority" });
    else if (r.signerRole === "ottersec") r.checks.push({ id: "signer", mark: "pass", label: "uploaded by OtterSec" });
    else if (p.authority === null) r.checks.push({ id: "signer", mark: "pass", label: `signed by ${addr(u.signer)}; the program is immutable now` });
    else
      r.checks.push({
        id: "signer",
        mark: "warn",
        label: `signed by ${addr(u.signer)}, not the current upgrade authority ${addr(p.authority)}`,
      });

    // 4. what OtterSec's builder did with it
    let build: Problem | null = null;
    if (records) {
      const mine = records.filter((rec) => rec.signer === u.signer);
      const rec = mine.find((m) => m.commit === u.commit) ?? null;
      r.record = rec;
      if (!rec && mine.length) {
        build = "never-built";
        r.checks.push({
          id: "build",
          mark: "fail",
          label: `never built: OtterSec's last build for this uploader was an older recipe (commit ${sha(mine[0]!.commit)})`,
        });
      } else if (!rec || !rec.executable_hash) {
        build = "never-built";
        r.checks.push({ id: "build", mark: "fail", label: "never built: OtterSec has no build result for this recipe" });
      } else if (rec.executable_hash === p.hash) {
        if (!rec.is_verified) build = "not-marked";
        r.checks.push({
          id: "build",
          mark: rec.is_verified ? "pass" : "warn",
          label: rec.is_verified
            ? "OtterSec's build matches the chain"
            : "OtterSec's build matches the chain, but the program isn't marked verified",
        });
      } else {
        build = "hash-differs";
        const older = rec.on_chain_hash && rec.on_chain_hash !== p.hash ? " (built against an older deploy)" : "";
        r.checks.push({
          id: "build",
          mark: "fail",
          label: `OtterSec built ${short(rec.executable_hash)}, the chain has ${short(p.hash)}${older}`,
        });
      }
    }

    // A redeploy of identical bytes moves the deploy slot without changing
    // what's on chain; if the recipe's build still matches, it isn't stale.
    if (stale && r.record?.executable_hash === p.hash) {
      stale = false;
      r.checks[0] = { id: "current", mark: "pass", label: "its build matches the chain (the program was redeployed unchanged since)" };
    }

    r.problem = stale
      ? "stale"
      : r.source.repo === "missing"
        ? "source-missing"
        : r.source.commit === "missing"
          ? "commit-missing"
          : (build ?? (r.signerRole === "other" && p.authority !== null ? "signer" : null));
    report.uploads.push(r);
  }

  // The upload the diagnosis is about: one that describes the current deploy
  // if any does, then the authority's, then the most recent.
  const order = report.uploads
    .map((r, i) => ({ r, i }))
    .sort(
      (a, b) =>
        Number(a.r.problem === "stale") - Number(b.r.problem === "stale") ||
        Number(a.r.signerRole !== "authority") - Number(b.r.signerRole !== "authority") ||
        recency(b.r.upload) - recency(a.r.upload),
    );
  const primary = order[0]!;
  report.primary = primary.i;
  if (report.status !== "verified-older-build") report.status = "not-verified";
  explain(report, primary.r, p, cmd);
  report.fixes = mainnetOnly(report, report.fixes);
  return report;
}

/** OtterSec's remote builder only serves mainnet, so off mainnet the
 *  submit-job steps are dead ends. */
function mainnetOnly(report: Report, fixes: Fix[]): Fix[] {
  return report.cluster === "mainnet" ? fixes : fixes.filter((f) => !f.command?.startsWith("solana-verify remote"));
}

function explain(report: Report, r: UploadReport, p: ProgramFacts, cmd: Commands): void {
  const u = r.upload;
  const repo = repoLabel(u.gitUrl);
  const reupload = (commit: string, text: string): Fix => ({ text, command: cmd.verifyFromRepo(u, commit) });
  // a re-uploaded recipe is signed by the authority, so that's the uploader to queue
  const submit: Fix = { text: "Then queue OtterSec's rebuild:", command: cmd.submitJob(p.authority ?? u.signer) };
  const signedBy = p.authority ? "signed by the upgrade authority" : "the program is immutable, so there's no upgrade authority to sign it";

  switch (r.problem) {
    case "stale":
      report.diagnosis =
        "The program was upgraded after this recipe was uploaded, so the recipe describes an older build. Nothing will match until there's a recipe for the current deploy.";
      if (r.source?.repo === "missing")
        report.diagnosis += ` The repo it points at (${repo}) is gone too, so the new recipe needs a public source.`;
      else if (r.source?.commit === "missing")
        report.diagnosis += ` Its commit (${sha(u.commit)}) is also missing from ${repo}.`;
      report.fixes = [
        reupload(
          "<commit you deployed>",
          `From the commit you deployed at slot ${slot(p.deploySlot)}, rebuild, compare and re-upload the recipe (${signedBy}):`,
        ),
        submit,
      ];
      if (!p.authority)
        report.notes.push(
          "The verified-builds docs ask for the upgrade authority to sign the recipe. This program no longer has one, and the docs don't say what OtterSec accepts instead.",
        );
      break;
    case "source-missing":
      report.diagnosis = `The recipe points at ${repo}, which GitHub can't find. It has been deleted or made private, so nobody can rebuild it.`;
      report.fixes = [
        { text: "Make the repo public again, or push the source somewhere public and re-upload the recipe with that URL." },
        submit,
      ];
      break;
    case "commit-missing":
      report.diagnosis = `The recipe points at commit ${sha(u.commit)}, which isn't in ${repo}. It was never pushed, or a force-push removed it.`;
      report.fixes = [
        reupload(
          "<commit you deployed>",
          `Push commit ${sha(u.commit)}, or re-upload the recipe with the commit you actually deployed:`,
        ),
        submit,
      ];
      break;
    case "never-built":
      report.diagnosis =
        "The recipe is uploaded, but OtterSec never ran a build for it. Uploading and submitting are separate commands, so the second one was probably skipped.";
      report.fixes = [{ text: "Queue the build:", command: cmd.submitJob(u.signer) }];
      break;
    case "hash-differs":
      report.diagnosis =
        "OtterSec rebuilt this recipe and got different bytes. Either the build settings differ from how the deployed program was built, or the deployed program didn't come from `solana-verify build` at all, in which case no rebuild will ever match it.";
      report.fixes = [
        { text: "Reproduce the mismatch locally (needs Docker; it asks before uploading anything):", command: cmd.verifyFromRepo(u, u.commit) },
        {
          text: "If the program on chain wasn't built with `solana-verify build`, redeploy a verifiable build, then re-upload the recipe and submit it.",
        },
      ];
      report.notes.push(
        "Common causes, per the verified-builds docs (the doctor can't tell which one yet): the Solana version isn't pinned (`[workspace.metadata.cli] solana = \"x.y.z\"`, needed when you don't depend on solana-program); no Cargo.lock at the repo root; the wrong `--library-name` (the lib name, not the package name) or `--mount-path`; the deployed .so came from `anchor build` or `cargo build-sbf` instead of `solana-verify build`.",
      );
      break;
    case "not-marked":
      report.diagnosis = "OtterSec's build matches the bytes on chain, but the program isn't marked verified. Re-submitting the job is the documented way to refresh it.";
      report.fixes = [{ text: "Re-queue the build:", command: cmd.submitJob(u.signer) }];
      break;
    case "signer":
      // Seen on mainnet 2026-09-25: a matching, verified per-uploader build
      // while /status says not verified, whenever the uploader isn't the
      // current authority. Consistent with the docs' rule; not documented as
      // the mechanism, so the wording stays with what the records show.
      report.diagnosis =
        r.record?.executable_hash === p.hash
          ? `OtterSec built this recipe and it matches the chain byte for byte, yet the status explorers read still says not verified. The upload was signed by ${addr(u.signer)}, not the current upgrade authority, and the docs require the authority to sign it.`
          : `Nothing else fails, but the recipe was signed by ${addr(u.signer)} and the docs require the program's upgrade authority to sign it. If the authority changed after the upload, re-upload from the current one.`;
      report.fixes = [
        reupload(u.commit, "Re-upload the recipe signed by the upgrade authority (for a multisig, export it with `solana-verify export-pda-tx` and run it through Squads):"),
        { text: "Then queue OtterSec's rebuild:", command: cmd.submitJob(p.authority ?? "<upgrade authority>") },
      ];
      break;
    default:
      report.diagnosis =
        report.cluster === "mainnet"
          ? "Every check passes but OtterSec doesn't show the program as verified. The build may still be running; check again later."
          : "The recipe describes the current deploy and its source is reachable.";
      report.fixes = report.cluster === "mainnet" ? [{ text: "If it doesn't clear up, re-queue the build:", command: cmd.submitJob(u.signer) }] : [];
  }
}

interface Commands {
  verifyFromRepo(u: Upload, commit: string): string;
  submitJob(uploader: string): string;
}

function commands(programId: string, rpcUrl: string): Commands {
  return {
    verifyFromRepo: (u, commit) =>
      [
        "solana-verify verify-from-repo",
        `-u ${rpcUrl}`,
        `--program-id ${programId}`,
        repoUrl(u.gitUrl),
        `--commit-hash ${commit}`,
        ...u.args,
      ].join(" "),
    submitJob: (uploader) => `solana-verify remote submit-job --program-id ${programId} --uploader ${uploader}`,
  };
}

/** The RPC URL the fix commands print. The one the doctor reads through can
 *  carry an API key (the server's Helius URL does) and the commands end up on
 *  public pages, so mainnet prints the public endpoint and anything else keeps
 *  only its origin. */
function printableRpc(rpcUrl: string, mainnet: boolean): string {
  return mainnet ? PUBLIC_MAINNET_RPC : rpcOrigin(rpcUrl);
}

function rpcOrigin(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).origin;
  } catch {
    return "<rpc url>";
  }
}

function firstTimeFixes(cmd: Commands, source: string | null, authority: string | null): Fix[] {
  const repo = source ? repoUrl(source) : "https://github.com/<you>/<repo>";
  const fake: Upload = { pda: "", signer: "", cliVersion: "", gitUrl: repo, commit: "", args: [], deployedSlot: null, lastWriteSlot: null };
  return [
    { text: "Put the program's source in a public repo, with Cargo.lock committed at the root." },
    {
      text: "Build it in the pinned container and deploy exactly that .so. A program built any other way can't be verified without redeploying.",
      command: "solana-verify build",
    },
    {
      text: "Rebuild from the repo, compare with the chain and upload the recipe (signed by the upgrade authority):",
      command: cmd.verifyFromRepo(fake, "<commit you deployed>"),
    },
    { text: "Queue OtterSec's rebuild, which is what explorers show:", command: cmd.submitJob(authority ?? "<upgrade authority>") },
  ];
}

function role(signer: string, authority: string | null): UploadReport["signerRole"] {
  if (authority && signer === authority) return "authority";
  if (signer === OTTER_SIGNER) return "ottersec";
  return "other";
}

function recency(u: Upload): number {
  return u.deployedSlot ?? u.lastWriteSlot ?? 0;
}

function sourceMark(s: SourceCheck, u: Upload): Mark {
  if (s.repo === "missing" || s.commit === "missing") return "fail";
  if (s.repo === "ok" && !u.commit) return "warn";
  if (s.repo === "ok" && s.commit === "ok") return "pass";
  return "unknown";
}

function sourceLabel(s: SourceCheck, u: Upload): string {
  const repo = repoLabel(u.gitUrl);
  if (s.host === "none") return "the recipe has no source URL";
  if (s.repo === "missing") return `${repo} not found on GitHub (deleted or private)`;
  // older uploads left the commit empty and built whatever the default branch held
  if (s.repo === "ok" && !u.commit) return `${repo} exists, but no commit is pinned, so a rebuild uses today's default branch`;
  if (s.commit === "missing") return `commit ${sha(u.commit)} not found in ${repo}`;
  if (s.repo === "ok" && s.commit === "ok") return `${repo} @ ${sha(u.commit)} exists`;
  return `${repo}: ${s.note ?? "could not check"}`;
}

/** Recipes often store the /tree/<commit> URL; solana-verify wants the repo. */
function repoUrl(url: string): string {
  const gh = parseGithub(url);
  return gh ? `https://github.com/${gh.owner}/${gh.repo}` : url;
}

function repoLabel(url: string): string {
  const gh = parseGithub(url);
  return gh ? `github.com/${gh.owner}/${gh.repo}` : url || "(no url)";
}
