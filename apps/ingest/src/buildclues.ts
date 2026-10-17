/**
 * Build clues — what a program's own bytes say about how it was compiled.
 *
 * Rust bakes source file paths into panic messages, and two kinds of them
 * survive into a deployed program:
 *
 *  - The compiler's prebuilt standard library. platform-tools ships `core` and
 *    `alloc` precompiled, and their paths are those of the GitHub runner that
 *    built the release: `/Users/runner/work/platform-tools/…` for the macOS
 *    download, `/home/runner/work/platform-tools/…` for the Linux one (older
 *    releases: `bpf-tools`, or a maintainer's own `/Users/<name>/work/`). The
 *    macOS download only runs on macOS, so a Mac reading means the program was
 *    built on a Mac. A Linux reading means Linux, which includes Docker.
 *  - Dependencies, compiled on the developer's machine, carry the path of its
 *    cargo registry: `<home>/.cargo/registry/src/<index>/<crate>-<version>/`.
 *    That names crate versions (solana-program 1.18.26, anchor-lang 0.30.1),
 *    and the home folder names the OS: `/Users/…` macOS, `/home/…` Linux.
 *
 * The two never disagree: across mainnet (2026-10-16) 2,041 events pair the Mac
 * download with a `/Users/` registry and none pair either download with the
 * other OS's home. So the home folder stands in when the compiler paths are
 * missing (~1,260 mainnet events).
 *
 * No Rust version is read: the platform-tools paths carry none
 * (`…/out/rust/library/core/…`). Paths remapped at build time leave nothing,
 * and then every field is null — "not in the binary", never a guess.
 *
 * Read from the full stored string set, not the 40 the dossier ships.
 */

export interface BuildClues {
  /** which platform-tools download compiled it, from its prebuilt library paths */
  download: "mac" | "linux" | null;
  /** one path that shows it, verbatim, for the tooltip */
  downloadEvidence: string | null;
  /** the OS of the machine that compiled the dependencies, from its cargo registry path */
  home: "mac" | "linux" | null;
  /** crate versions out of cargo registry paths, the Solana-relevant ones first */
  crates: { name: string; version: string }[];
}

const MAC_DL = /\/Users\/[A-Za-z0-9._-]+\/work\/(?:platform-tools|bpf-tools)\/[^\s]{0,60}/;
const LINUX_DL = /\/home\/[A-Za-z0-9._-]+\/work\/(?:platform-tools|bpf-tools)\/[^\s]{0,60}/;
const HOME_MAC = /\/Users\/[^/\s]+\/\.cargo\/registry/;
const HOME_LINUX = /\/home\/[^/\s]+\/\.cargo\/registry/;
const REGISTRY_CRATE =
  /registry\/src\/[^/\s]+\/([a-z0-9_-]+?)-(\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)\//gi;

// the crates that say which Solana and which framework — shown first, in this order
const KEY_CRATES = ["solana-program", "anchor-lang", "pinocchio", "solana-sdk", "steel", "bolt-lang"];

export function readBuildClues(strings: string[]): BuildClues {
  const hay = strings.join("\n");
  const mac = hay.match(MAC_DL);
  const linux = hay.match(LINUX_DL);
  // both at once would contradict itself; say nothing rather than pick one
  const download = mac && !linux ? "mac" : linux && !mac ? "linux" : null;
  const evidence = download === "mac" ? mac![0] : download === "linux" ? linux![0] : null;

  const hm = HOME_MAC.test(hay);
  const hl = HOME_LINUX.test(hay);
  const home = hm && !hl ? "mac" : hl && !hm ? "linux" : null;

  const seen = new Map<string, string>();
  for (const m of hay.matchAll(REGISTRY_CRATE)) {
    const name = m[1]!.toLowerCase();
    if (!seen.has(name)) seen.set(name, m[2]!);
  }
  const key = KEY_CRATES.filter((n) => seen.has(n)).map((name) => ({ name, version: seen.get(name)! }));
  // Solana 2.x split solana-program into many solana-* crates; when the umbrella
  // crate isn't there, one of those still dates the SDK
  if (!seen.has("solana-program")) {
    const split = [...seen].find(([n]) => n.startsWith("solana-") && !KEY_CRATES.includes(n));
    if (split) key.push({ name: split[0], version: split[1] });
  }

  return { download, downloadEvidence: evidence, home, crates: key.slice(0, 4) };
}
