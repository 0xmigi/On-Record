import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { logger } from "@onrecord/core";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Verified-update diff (spec §4.5): shallow clone of the previous and new
// commits, diff of programs/** Rust, truncated to ~60k chars. Feeds the
// writer's plain-English "what changed". Skipped if the diff exceeds 500KB.
// ---------------------------------------------------------------------------

const MAX_DIFF_BYTES = 500 * 1024;
const TRUNCATE_CHARS = 60_000;

export async function getDiffSummary(
  repoUrl: string,
  prevCommit: string,
  newCommit: string,
): Promise<string | null> {
  if (!/^https:\/\//.test(repoUrl)) return null;
  const dir = await mkdtemp(path.join(tmpdir(), "onrecord-diff-"));
  try {
    const git = (args: string[]) =>
      execFileAsync("git", args, { cwd: dir, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });

    await git(["init", "-q"]);
    await git(["remote", "add", "origin", repoUrl]);
    // blob-less shallow fetches of exactly the two commits we compare
    await git(["fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", prevCommit]);
    await git(["fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", newCommit]);

    const { stdout } = await git([
      "diff",
      `${prevCommit}..${newCommit}`,
      "--stat",
      "--patch",
      "--",
      "programs/**/*.rs",
      "programs/*.rs",
    ]);

    if (!stdout.trim()) return null;
    if (Buffer.byteLength(stdout) > MAX_DIFF_BYTES) {
      logger.info({ repoUrl, bytes: Buffer.byteLength(stdout) }, "diff too large, skipping");
      return null;
    }
    return stdout.length > TRUNCATE_CHARS
      ? stdout.slice(0, TRUNCATE_CHARS) + "\n…[diff truncated]"
      : stdout;
  } catch (err) {
    logger.warn({ repoUrl, err: String(err) }, "diff fetch failed");
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
