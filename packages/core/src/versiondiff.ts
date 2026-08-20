import { and, asc, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "./db/client.js";

/**
 * What changed between two versions of a program.
 *
 * No bytecode is stored and no RPC call is made. Every upgrade the pipeline has
 * ever processed left a full description of the image in `events.enrichment` —
 * fingerprint (sha256, size, strings, IDL instruction/account names) and profile
 * (framework, syscalls, capabilities, integrations). Diffing consecutive
 * descriptions recovers the changelog retroactively.
 *
 * The guards are the point. Two things routinely make a version LOOK like it
 * changed when it did not, and either one would put a false claim on the page:
 *
 *   naming source   the stored instruction names can switch convention between
 *                   versions (recovered PascalCase → IDL snake_case). That
 *                   reads as "every instruction was replaced". Detected by
 *                   normalising names, then suppressed.
 *
 *   the name cap    only IX_NAME_CAP names are stored per version, alphabetically.
 *                   Past the cap, adding `delegate_depth` silently pushes
 *                   `withdraw` off the end — which looks like a removal and is
 *                   not one. Removals are withheld on capped versions.
 *
 * Vendor source paths are filtered too: Rust's own library compiles its panic
 * paths into every image, so `src/fmt/`, `src/raw_vec/` and friends appear on
 * thousands of programs and belong to nobody's program.
 */

// keep in step with probeProgramMetadata's cap in metadata.ts
export const IX_NAME_CAP = 64;

const VENDOR_DIRS = new Set([
  "fmt", "unicode", "ser", "de", "str", "raw_vec", "iter", "collections", "num",
  "slice", "io", "raw", "sync", "alloc", "core", "std", "vec", "hash", "ops",
  "char", "ascii", "convert", "option", "result", "panicking", "backtrace",
  "macros", "internal", "imp", "sys", "sys_common", "thread", "time", "cmp",
]);

const SOURCE_PATH_RE = /(?:^|[^a-z0-9_/-])((?:programs?\/[a-z0-9_-]+\/)?src\/[a-z0-9_/-]+?\.rs)/gi;

/** author's own tree, or the compiler's? */
export function isProgramPath(path: string): boolean {
  if (/^programs?\//i.test(path)) return true;
  const dir = path.match(/src\/([a-z0-9_-]+)\//i)?.[1]?.toLowerCase();
  if (!dir) return true;
  return !VENDOR_DIRS.has(dir);
}

function pathsFrom(strings: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(strings)) return out;
  for (const s of strings) {
    for (const m of String(s).matchAll(SOURCE_PATH_RE)) {
      const hit = m[1];
      if (hit && isProgramPath(hit)) out.add(hit);
    }
  }
  return out;
}

/** case/separator-insensitive, so Adl and adl are the same instruction */
const norm = (s: string) => s.replace(/[_\s-]/g, "").toLowerCase();

export type DiffFlag = {
  type: "suppressed" | "unreliable";
  label: string;
  detail: string;
};

export type SetDelta = { added: string[]; removed: string[]; removedHidden?: number };

export type VersionDiff = {
  kind: "genesis" | "change" | "rebuild" | "suppressed";
  sha256: string;
  slot: string;
  signature: string | null;
  blockTime: string | null;
  sizeBytes: number;
  sizeDelta?: number;
  /** genesis only — the starting shape, since there is nothing to compare to */
  counts?: { instructions: number; sourcePaths: number };
  instructions?: SetDelta;
  accounts?: SetDelta;
  sourcePaths?: SetDelta;
  integrations?: SetDelta;
  capabilities?: SetDelta;
  flags?: DiffFlag[];
};

type Snapshot = {
  sha256: string;
  slot: bigint;
  signature: string | null;
  blockTime: Date | null;
  sizeBytes: number;
  instructions: Set<string>;
  accounts: Set<string>;
  paths: Set<string>;
  integrations: Set<string>;
  capabilities: Set<string>;
};

const delta = (before: Set<string>, after: Set<string>): SetDelta => ({
  added: [...after].filter((x) => !before.has(x)).sort(),
  removed: [...before].filter((x) => !after.has(x)).sort(),
});

const changed = (d: SetDelta) => d.added.length > 0 || d.removed.length > 0;

function toSet(v: unknown): Set<string> {
  return new Set(Array.isArray(v) ? v.map(String) : []);
}

/**
 * Every distinct version of a program we hold a description for, oldest first.
 *
 * Deduped by sha256: the same image redeployed is one version, not two, and the
 * earliest slot that carried it is the one that counts.
 */
export async function loadSnapshots(programId: string): Promise<Snapshot[]> {
  const rows = await db
    .select({
      sha256: schema.events.sha256After,
      slot: schema.events.slot,
      signature: schema.events.signature,
      blockTime: schema.events.blockTime,
      enrichment: schema.events.enrichment,
    })
    .from(schema.events)
    .where(and(eq(schema.events.programId, programId), isNotNull(schema.events.sha256After)))
    .orderBy(asc(schema.events.slot));

  const bySha = new Map<string, Snapshot>();
  for (const r of rows) {
    const e = (r.enrichment ?? {}) as Record<string, any>;
    const fp = e.fingerprint;
    if (!fp || !r.sha256) continue;
    // first slot wins — a later redeploy of the same image is not a new version
    if (bySha.has(r.sha256)) continue;
    bySha.set(r.sha256, {
      sha256: r.sha256,
      slot: BigInt(r.slot as unknown as string | number),
      signature: r.signature ?? null,
      blockTime: r.blockTime ?? null,
      sizeBytes: Number(fp.sizeBytes ?? 0),
      instructions: toSet(fp.idl?.instructions ?? e.profile?.instructionNames),
      accounts: toSet(fp.idl?.accounts),
      paths: pathsFrom(fp.strings),
      integrations: toSet(e.profile?.integrations),
      capabilities: toSet(e.profile?.capabilities),
    });
  }
  return [...bySha.values()].sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
}

/** the changelog for one program, oldest first */
export async function buildVersionDiffs(programId: string): Promise<VersionDiff[]> {
  const snaps = await loadSnapshots(programId);
  const out: VersionDiff[] = [];

  snaps.forEach((s, i) => {
    const base = {
      sha256: s.sha256,
      slot: s.slot.toString(),
      signature: s.signature,
      blockTime: s.blockTime?.toISOString() ?? null,
      sizeBytes: s.sizeBytes,
    };

    if (i === 0) {
      out.push({
        ...base,
        kind: "genesis",
        counts: { instructions: s.instructions.size, sourcePaths: s.paths.size },
      });
      return;
    }

    const prev = snaps[i - 1];
    if (!prev) return; // unreachable for i > 0; the index signature can't know
    const flags: DiffFlag[] = [];
    let instructions = delta(prev.instructions, s.instructions);

    // ── guard 1: the name source changed, not the program ──────────────
    const addN = new Set(instructions.added.map(norm));
    const remN = new Set(instructions.removed.map(norm));
    const overlap = [...addN].filter((x) => remN.has(x));
    const smaller = Math.min(addN.size, remN.size);
    if (overlap.length > 0 && smaller > 0 && overlap.length >= smaller * 0.8) {
      flags.push({
        type: "suppressed",
        label: "Naming convention changed",
        detail:
          `${overlap.length} instruction names switched case or separator ` +
          `(e.g. ${instructions.removed[0]} → ${instructions.added[0]}). ` +
          `The program did not change here — the name source did.`,
      });
      instructions = {
        added: instructions.added.filter((x) => !remN.has(norm(x))),
        removed: instructions.removed.filter((x) => !addN.has(norm(x))),
      };
    }

    // ── guard 2: the stored name list is capped and alphabetical ───────
    const atCap = s.instructions.size >= IX_NAME_CAP || prev.instructions.size >= IX_NAME_CAP;
    if (atCap && instructions.removed.length > 0) {
      flags.push({
        type: "unreliable",
        label: `Instruction list truncated at ${IX_NAME_CAP}`,
        detail:
          `This program has ${IX_NAME_CAP}+ instructions and only the first ${IX_NAME_CAP} are ` +
          `stored, alphabetically — so names drop off the end as others are added. ` +
          `Additions here are real; removals are withheld.`,
      });
      instructions = {
        added: instructions.added,
        removed: [],
        removedHidden: instructions.removed.length,
      };
    }

    const accounts = delta(prev.accounts, s.accounts);
    const sourcePaths = delta(prev.paths, s.paths);
    const integrations = delta(prev.integrations, s.integrations);
    const capabilities = delta(prev.capabilities, s.capabilities);

    const anything =
      changed(instructions) ||
      changed(accounts) ||
      changed(sourcePaths) ||
      changed(integrations) ||
      changed(capabilities);

    // a version whose only "change" was the rename is not a change at all
    const suppressedOnly = !anything && flags.some((f) => f.type === "suppressed");

    out.push({
      ...base,
      kind: suppressedOnly ? "suppressed" : anything ? "change" : "rebuild",
      sizeDelta: s.sizeBytes - prev.sizeBytes,
      instructions,
      accounts,
      sourcePaths,
      integrations,
      capabilities,
      flags,
    });
  });

  return out;
}
