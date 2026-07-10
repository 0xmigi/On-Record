import type { ApiProgramDetail, Framework } from "@/lib/api";
import {
  DETECTION_RELIABLE,
  FRAMEWORK_INFO,
  type Confidence,
  type FrameworkInfo,
} from "@/lib/frameworks";

// ---------------------------------------------------------------------------
// Composition deriver — reads the "larger data shape" out of a program's
// ELF-recovered strings. The backend already returns `strings` (notable
// printable runs from the binary); the developer's own Rust source paths and
// panic messages survive compilation, so we can recover crate name, internal
// module architecture, instruction handlers, and real protocol reach — far
// more than the embedded-pubkey `integrations` scan alone.
//
// This is a prototype layer: once the shape settles, the stable derivations
// move into packages/core/profile.ts so they're computed on the raw bytes and
// stored, not re-mined per request. Everything here is a fixed, explainable
// mapping of recovered facts — nothing inferred, nothing learned.
// ---------------------------------------------------------------------------

export type SizeBand = "lean" | "moderate" | "heavy";

export interface ModuleGroup {
  dir: string; // top-level source dir: instructions / state / adapters / cpi …
  files: string[]; // basenames, no extension
}

export interface Composition {
  framework: FrameworkInfo;
  confidence: Confidence; // how sure we are of the framework label (Anchor = certain)
  detectionReliable: boolean; // can this framework be positively fingerprinted on-chain
  // footprint — the physical cost of the build
  sizeBytes: number | null;
  sizeBand: SizeBand | null;
  rentSol: number | null;
  syscallCount: number | null;
  capabilities: string[];
  // recovered identity + architecture
  crate: string | null;
  moduleGroups: ModuleGroup[]; // the program's own source tree, stdlib filtered
  instructions: string[]; // handler names, from instructions/*.rs or the IDL
  instructionsApprox: boolean; // true when recovered from source, not the IDL
  publishesIdl: boolean; // Anchor IDL account instructions present in the binary
  // reach — who it plugs into
  embeddedIntegrations: string[]; // confirmed by embedded pubkey (the API field)
  sourceReach: string[]; // protocols named in source paths / strings
  // provenance
  toolchain: string | null;
  deps: string[];
}

// Protocols we can name from source module paths / strings — a much richer
// reach signal than the embedded-pubkey scan, which only catches constants.
const PROTOCOL_KEYWORDS: { re: RegExp; name: string }[] = [
  { re: /pump[_-]?swap|pump[_-]?bc|pumpfun|pump_/i, name: "Pump.fun" },
  { re: /raydium|launchlab|\bcpmm\b|\bclmm\b/i, name: "Raydium" },
  { re: /meteora|\bdlmm\b|\bdamm\b|\bdbc\b/i, name: "Meteora" },
  { re: /whirlpool|\borca\b/i, name: "Orca" },
  { re: /solfi/i, name: "SolFi" },
  { re: /manifest/i, name: "Manifest" },
  { re: /fluxbeam/i, name: "FluxBeam" },
  { re: /boop/i, name: "Boop.fun" },
  { re: /lifinity/i, name: "Lifinity" },
  { re: /phoenix/i, name: "Phoenix" },
  { re: /openbook/i, name: "OpenBook" },
  { re: /\bjupiter\b|\bjup\b/i, name: "Jupiter" },
  { re: /metaplex|\bmpl\b/i, name: "Metaplex" },
];

function sizeBand(bytes: number | null): SizeBand | null {
  if (bytes == null) return null;
  if (bytes < 64 * 1024) return "lean";
  if (bytes < 256 * 1024) return "moderate";
  return "heavy";
}

/** Humanize a snake_case module basename: create_recurring_delegation →
 *  "create recurring delegation". */
function humanize(name: string): string {
  return name.replace(/\.rs$/, "").replace(/_/g, " ").trim();
}

// Rust stdlib crate dirs (`<crate>/src/…` where crate is one of these = std,
// not the program). Toolchain/registry path fragments are rejected outright.
const STDLIB_CRATES = new Set(["alloc", "core", "std", "proc_macro", "test"]);
const TOOLCHAIN_RE = /library\/|platform-tools|\.cargo|crates\.io|rustc|registry\/src/;

/** Pull the program's own source modules out of the recovered strings,
 *  filtering Rust stdlib/toolchain paths. Works per-string because the
 *  recovered strings are concatenated with no separators — joining them and
 *  regexing globally would bleed adjacent paths together. */
function recoverModules(strings: string[]): { crate: string | null; paths: string[] } {
  let crate: string | null = null;
  const paths = new Set<string>();

  for (const raw of strings) {
    // workspace crate name: programs/<crate>/src/…  (best identity signal)
    const ws = raw.match(/programs\/([a-z0-9_-]+)\/src\//i);
    if (ws && !crate) crate = ws[1];

    // <cratedir>/src/<rest>.rs — the program's own tree. Non-greedy `.rs`.
    for (const m of raw.matchAll(/([a-z0-9_-]+)\/src\/([a-z0-9_/-]+?\.rs)/gi)) {
      if (STDLIB_CRATES.has(m[1].toLowerCase())) continue;
      if (TOOLCHAIN_RE.test(raw.slice(0, m.index))) continue; // std/dep path
      paths.add(m[2]);
    }
    // bare src/<rest>.rs (program root files), only when NOT part of a longer
    // path segment (a `/` before `src` means it had a crate dir, handled above).
    for (const m of raw.matchAll(/(?:^|[^a-z0-9_/-])src\/([a-z0-9_/-]+?\.rs)/gi)) {
      if (TOOLCHAIN_RE.test(raw.slice(0, m.index))) continue;
      paths.add(m[1]);
    }
  }
  return { crate, paths: [...paths] };
}

function groupModules(paths: string[]): ModuleGroup[] {
  const groups = new Map<string, Set<string>>();
  for (const p of paths) {
    const parts = p.split("/");
    const dir = parts.length > 1 ? parts[0] : "root";
    const base = parts[parts.length - 1].replace(/\.rs$/, "");
    if (base === "mod") continue; // mod.rs is a dir index, not a unit
    if (!groups.has(dir)) groups.set(dir, new Set());
    groups.get(dir)!.add(base);
  }
  // stable, meaningful order
  const order = ["instructions", "instruction", "handlers", "adapters", "cpi", "state", "states", "math", "events", "engine"];
  return [...groups.entries()]
    .map(([dir, files]) => ({ dir, files: [...files].sort() }))
    .sort((a, b) => {
      const ai = order.indexOf(a.dir);
      const bi = order.indexOf(b.dir);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      return a.dir.localeCompare(b.dir);
    });
}

function recoverToolchain(strings: string[]): { toolchain: string | null; deps: string[] } {
  const hay = strings.join("\n");
  const plat = hay.match(/platform-tools[^\s]*\/rust\/([a-z0-9._-]+)/i);
  const deps = new Set<string>();
  for (const m of hay.matchAll(/index\.crates\.io[^\s]*?\/([a-z0-9_-]+-\d+\.\d+\.\d+)\//gi)) {
    deps.add(m[1]);
  }
  return { toolchain: plat ? plat[1] : null, deps: [...deps].slice(0, 6) };
}

export function deriveComposition(p: ApiProgramDetail): Composition {
  const key = (p.framework ?? "unknown") as Framework;
  const fw = FRAMEWORK_INFO[key];
  const detectionReliable = DETECTION_RELIABLE[key];
  // Anchor is the only framework we can prove from the chain; everything else
  // is inference from binary shape, so we say so.
  const confidence: Confidence = detectionReliable ? "confirmed" : "inferred";
  const strings = p.strings ?? [];

  const { crate, paths } = recoverModules(strings);
  const moduleGroups = groupModules(paths);

  // instructions: prefer the IDL (authoritative); else recover from the
  // instructions/ module basenames.
  const idlInstr = (p.idlInstructions ?? []).filter(Boolean);
  // state/util/config files sometimes sit under instructions/ — they're not
  // handlers, so keep the list to real entrypoints.
  const NON_HANDLER = /(?:_config|_state|_common|_account|_utils?|_helpers?|_error|_events?)$|^(?:config|state|common|utils?|helpers?|error|events?|mod|admin|lib|constants)$/;
  const modInstr = moduleGroups
    .filter((g) => g.dir === "instructions" || g.dir === "instruction" || g.dir === "handlers")
    .flatMap((g) => g.files)
    .filter((f) => !NON_HANDLER.test(f));
  const instructions = idlInstr.length ? idlInstr : modInstr.map(humanize);
  const instructionsApprox = idlInstr.length === 0 && modInstr.length > 0;

  const publishesIdl = strings.join(" ").includes("IdlCreateAccount");

  // source reach — protocols named in module paths + strings
  const reachHay = [...paths, ...strings].join("\n");
  const sourceReach: string[] = [];
  for (const { re, name } of PROTOCOL_KEYWORDS) {
    if (re.test(reachHay) && !sourceReach.includes(name)) sourceReach.push(name);
  }

  const { toolchain, deps } = recoverToolchain(strings);

  return {
    framework: fw,
    confidence,
    detectionReliable,
    sizeBytes: p.sizeBytes,
    sizeBand: sizeBand(p.sizeBytes),
    rentSol: p.deployCostSol,
    syscallCount: p.syscallCount,
    capabilities: p.capabilities ?? [],
    crate,
    moduleGroups,
    instructions,
    instructionsApprox,
    publishesIdl,
    embeddedIntegrations: p.integrations ?? [],
    sourceReach,
    toolchain,
    deps,
  };
}
