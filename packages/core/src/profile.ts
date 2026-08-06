// ---------------------------------------------------------------------------
// Program Profiler (SPEC: docs/GRADING.md §5). Parses the SBF/eBPF ELF of a
// deployed program into a structured profile: framework, imported syscalls,
// derived capabilities, and known-program integrations. Universal to every
// program — this is the "work backwards from Solana" foundation the grading
// axes build on.
//
// Two ELF shapes exist on chain and both must be read:
//
//   SBPFv1  — syscalls are dynamic imports. Names live in `.dynstr`, patched in
//             by `.rel.dyn`. `.rodata` string literals are NOT NUL-terminated;
//             their length arrives in a register.
//   SBPFv2+ — static syscalls. There is no `.dynstr`, no `.dynsym`, and no
//             relocation table at all: a syscall is a CALL_IMM whose immediate
//             is murmur3_32(name). `.rodata` strings are NUL-terminated.
//
// Reading only `.dynstr` reports zero syscalls for every program built with a
// current toolchain, which then reads as framework "unknown" with no
// capabilities — so the hashed form is resolved too.
// ---------------------------------------------------------------------------

export type Framework = "anchor" | "pinocchio" | "native" | "unknown";

/** How the syscall set was recovered — the evidence class behind the label. */
export type SyscallSource = "dynsym" | "static" | "strings";

/** How instruction names were recovered, strongest first. */
export type InstructionSource = "idl" | "anchor-log" | "debug-enum";

export interface ProgramProfile {
  framework: Framework;
  syscalls: string[]; // sorted unique sol_* imports, read off the ELF
  syscallSource: SyscallSource | null;
  capabilities: string[]; // derived groups: cpi, pda, hashing, advanced-crypto, tokens, return-data, sysvars
  integrations: string[]; // known programs referenced by embedded program id
  instructionCount: number | null;
  instructionNames: string[]; // recovered handler names, discriminant order where known
  instructionSource: InstructionSource | null;
}

// --- syscall → capability grouping ------------------------------------------
const CAPABILITY_RULES: { cap: string; match: (s: string) => boolean }[] = [
  { cap: "cpi", match: (s) => s.startsWith("sol_invoke") },
  { cap: "pda", match: (s) => s.includes("program_address") },
  { cap: "hashing", match: (s) => /sha256|keccak256|blake3|poseidon/.test(s) },
  {
    cap: "advanced-crypto",
    match: (s) => /secp256k1|curve_|alt_bn128|big_mod_exp/.test(s),
  },
  { cap: "return-data", match: (s) => s.includes("return_data") },
  { cap: "sysvars", match: (s) => s.includes("_sysvar") || s.includes("get_epoch") },
];

// The syscall ABI. Used three ways: to classify, as the murmur3 pre-image table
// for static syscalls, and as a fallback string scan.
const KNOWN_SYSCALLS = [
  "abort", "sol_panic_", "sol_log_", "sol_log_64_", "sol_log_pubkey", "sol_log_data",
  "sol_log_compute_units_", "sol_sha256", "sol_keccak256", "sol_blake3", "sol_poseidon",
  "sol_secp256k1_recover", "sol_curve_validate_point", "sol_curve_group_op",
  "sol_curve_multiscalar_mul", "sol_curve_pairing_map", "sol_alt_bn128_group_op",
  "sol_alt_bn128_compression", "sol_big_mod_exp", "sol_try_find_program_address",
  "sol_create_program_address", "sol_get_clock_sysvar", "sol_get_rent_sysvar",
  "sol_get_epoch_schedule_sysvar", "sol_get_fees_sysvar", "sol_get_epoch_rewards_sysvar",
  "sol_get_last_restart_slot", "sol_get_stack_height", "sol_get_processed_sibling_instruction",
  "sol_set_return_data", "sol_get_return_data", "sol_memcpy_", "sol_memmove_",
  "sol_memset_", "sol_memcmp_", "sol_alloc_free_", "sol_remaining_compute_units",
  "sol_get_sysvar", "sol_get_epoch_stake", "sol_invoke_signed_c", "sol_invoke_signed_rust",
];

// well-known programs — a reference embedded in the bytecode = an integration
const KNOWN_PROGRAMS: Record<string, string> = {
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token",
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: "Metaplex Metadata",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "Raydium CLMM",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpool",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora DLMM",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun",
  pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT: "Pyth",
  GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw: "SPL Governance",
  SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf: "Squads",
  ComputeBudget111111111111111111111111111111: "Compute Budget",
};

// --- base58 decode (for the known-program byte search) ----------------------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = new Map([...B58].map((c, i) => [c, i]));
export function base58Decode(str: string): Buffer | null {
  let num = 0n;
  for (const ch of str) {
    const v = B58_MAP.get(ch);
    if (v === undefined) return null;
    num = num * 58n + BigInt(v);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  let bytes = Buffer.from(hex, "hex");
  // restore leading zero bytes (each leading '1' = one 0x00)
  let leading = 0;
  for (const ch of str) { if (ch === "1") leading++; else break; }
  if (leading) bytes = Buffer.concat([Buffer.alloc(leading), bytes]);
  return bytes;
}
const KNOWN_PROGRAM_BYTES: { bytes: Buffer; name: string }[] = Object.entries(KNOWN_PROGRAMS)
  .map(([id, name]) => ({ bytes: base58Decode(id), name }))
  .filter((x): x is { bytes: Buffer; name: string } => x.bytes != null && x.bytes.length === 32);

// --- murmur3_32 -------------------------------------------------------------
// The syscall registry hashes symbol names with murmur3_32(name, seed 0) and a
// static-syscall CALL_IMM carries that hash as its immediate. Same function the
// loader uses to resolve them, so a match is exact rather than heuristic.
function murmur3_32(key: string): number {
  const data = Buffer.from(key, "utf8");
  const C1 = 0xcc9e2d51;
  const C2 = 0x1b873593;
  let h = 0;
  const blocks = data.length - (data.length % 4);
  for (let i = 0; i < blocks; i += 4) {
    let k = data.readUInt32LE(i);
    k = Math.imul(k, C1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, C2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  let k = 0;
  for (let i = data.length - 1; i >= blocks; i--) k = (k << 8) | (data[i] ?? 0);
  if (data.length % 4) {
    k = Math.imul(k, C1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, C2);
    h ^= k;
  }
  h ^= data.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
const SYSCALL_BY_HASH = new Map<number, string>(KNOWN_SYSCALLS.map((n) => [murmur3_32(n), n]));

// --- minimal ELF64 reader ---------------------------------------------------
interface ElfSection {
  name: string;
  type: number;
  addr: number; // virtual address (0 when the section is not mapped)
  off: number; // file offset
  size: number;
}
interface Elf {
  sections: ElfSection[];
  /** executable region — the section table when present, else the X segment. */
  text: { off: number; size: number; addr: number } | null;
  /** mapped read-only regions a string pointer can land in. */
  data: { off: number; size: number; addr: number }[];
}

const SHT_NOBITS = 8;

function readElf(elf: Buffer): Elf | null {
  try {
    if (elf.length < 64 || elf.readUInt32BE(0) !== 0x7f454c46) return null; // \x7fELF
    if (elf[4] !== 2 || elf[5] !== 1) return null; // ELF64, little-endian

    const shoff = Number(elf.readBigUInt64LE(0x28));
    const shentsize = elf.readUInt16LE(0x3a);
    const shnum = elf.readUInt16LE(0x3c);
    const shstrndx = elf.readUInt16LE(0x3e);

    // A header is usable once its name/type/addr/offset/size fields are present;
    // the trailing sh_link…sh_entsize fields are not read here. That matters
    // because ProgramData parsing strips trailing zero bytes from the account,
    // and the last section header ends in zero-valued fields — so the table can
    // finish a few bytes past the buffer. Requiring the whole 64-byte entry threw
    // away every section for those programs, which lost `.dynstr` and silently
    // demoted them to the string-scan fallback.
    const HDR_READ = 0x28;
    const usable = shentsize >= HDR_READ ? Math.floor((elf.length - shoff - HDR_READ) / shentsize) + 1 : 0;
    const count = Math.min(shnum, Math.max(usable, 0));

    const sections: ElfSection[] = [];
    if (shoff && count && shstrndx < count) {
      const at = (i: number) => {
        const b = shoff + i * shentsize;
        return {
          nameOff: elf.readUInt32LE(b),
          type: elf.readUInt32LE(b + 4),
          addr: Number(elf.readBigUInt64LE(b + 0x10)),
          off: Number(elf.readBigUInt64LE(b + 0x18)),
          size: Number(elf.readBigUInt64LE(b + 0x20)),
        };
      };
      const shstr = at(shstrndx);
      const nameAt = (off: number) => {
        let end = shstr.off + off;
        while (end < elf.length && elf[end] !== 0) end++;
        return elf.toString("utf8", shstr.off + off, end);
      };
      for (let i = 0; i < count; i++) {
        const s = at(i);
        if (s.type === SHT_NOBITS) continue; // occupies no file bytes
        if (s.off + s.size > elf.length) continue;
        sections.push({ name: nameAt(s.nameOff), type: s.type, addr: s.addr, off: s.off, size: s.size });
      }
    }

    let text = sections.find((s) => s.name === ".text") ?? null;
    const data = sections.filter((s) => s.name === ".rodata" || s.name === ".data.rel.ro");

    // Fully stripped image: no usable section table. Fall back to the program
    // headers — the executable PT_LOAD is the text, the rest is candidate data.
    const fallbackData: { off: number; size: number; addr: number }[] = [];
    if (!text) {
      const phoff = Number(elf.readBigUInt64LE(0x20));
      const phentsize = elf.readUInt16LE(0x36);
      const phnum = elf.readUInt16LE(0x38);
      if (phoff && phnum && phoff + phnum * phentsize <= elf.length) {
        for (let i = 0; i < phnum; i++) {
          const b = phoff + i * phentsize;
          const type = elf.readUInt32LE(b);
          const flags = elf.readUInt32LE(b + 4);
          const off = Number(elf.readBigUInt64LE(b + 8));
          const addr = Number(elf.readBigUInt64LE(b + 0x10));
          const size = Number(elf.readBigUInt64LE(b + 0x20));
          if (type !== 1 || !size || off + size > elf.length) continue; // PT_LOAD only
          if (flags & 0x1) text = { name: ".text", type: 1, addr, off, size };
          else fallbackData.push({ off, size, addr });
        }
      }
    }

    return {
      sections,
      text: text ? { off: text.off, size: text.size, addr: text.addr } : null,
      data: data.length ? data.map((s) => ({ off: s.off, size: s.size, addr: s.addr })) : fallbackData,
    };
  } catch {
    return null;
  }
}

function readDynStr(elf: Buffer, parsed: Elf): string[] | null {
  const s = parsed.sections.find((x) => x.name === ".dynstr");
  if (!s) return null;
  return elf.toString("latin1", s.off, s.off + s.size).split("\0").filter(Boolean);
}

// --- SBF instruction walk ---------------------------------------------------
const OP_LDDW = 0x18; // load 64-bit immediate — the only 16-byte instruction
const OP_CALL_IMM = 0x85; // static syscall when the immediate is a known hash
const OP_MOV64_IMM = 0xb7; // supplies &str length on toolchains without NUL terminators

interface TextScan {
  /** syscall name → call count, resolved from hashed CALL_IMM immediates. */
  staticSyscalls: Map<string, number>;
  /** 64-bit lddw immediates → the text offsets that load them. */
  lddw: Map<number, number[]>;
  /** text offset → immediate of the next mov64-imm within a short window. */
  lenAfter: Map<number, number>;
}

function scanText(elf: Buffer, text: { off: number; size: number }): TextScan {
  const staticSyscalls = new Map<string, number>();
  const lddw = new Map<number, number[]>();
  const lenAfter = new Map<number, number>();
  const end = text.off + text.size;

  for (let p = text.off; p + 8 <= end; ) {
    const op = elf[p];
    if (op === OP_LDDW && p + 16 <= end) {
      const lo = elf.readUInt32LE(p + 4);
      const hi = elf.readUInt32LE(p + 12);
      const val = hi * 0x100000000 + lo;
      const rel = p - text.off;
      const seen = lddw.get(val);
      if (seen) seen.push(rel);
      else lddw.set(val, [rel]);
      // A &str is (pointer, length). The length is materialised by the next
      // mov64-imm, a couple of instructions after the pointer load at most.
      for (let q = p + 16; q + 8 <= end && q < p + 16 + 4 * 8; q += 8) {
        if (elf[q] === OP_MOV64_IMM) { lenAfter.set(rel, elf.readInt32LE(q + 4)); break; }
      }
      p += 16;
      continue;
    }
    if (op === OP_CALL_IMM) {
      const name = SYSCALL_BY_HASH.get(elf.readUInt32LE(p + 4));
      if (name) staticSyscalls.set(name, (staticSyscalls.get(name) ?? 0) + 1);
    }
    p += 8;
  }
  return { staticSyscalls, lddw, lenAfter };
}

// --- instruction-name recovery ---------------------------------------------
const IDENT = /^[A-Z][A-Za-z0-9]{2,47}$/;

// Fieldless-enum Debug impls put every variant name in .rodata, so a naive scan
// finds the serde/bincode/core error enums that ship inside every Rust program.
// Those clusters are indistinguishable from a real instruction enum by shape, so
// they are named and excluded rather than guessed at.
const NOISE = new Set([
  // bincode / serde
  "InvalidUtf8Encoding", "InvalidBoolEncoding", "InvalidCharEncoding", "InvalidTagEncoding",
  "DeserializeAnyNotSupported", "SequenceMustHaveLength", "SizeLimit", "Custom", "Message",
  // core / alloc
  "Utf8Error", "BorrowError", "BorrowMutError", "TryFromIntError", "ParseIntError",
  "Error", "Kind", "BufferTooSmall", "Layout", "Alignment",
  // std::io::ErrorKind
  "NotFound", "PermissionDenied", "ConnectionRefused", "ConnectionReset", "HostUnreachable",
  "NetworkUnreachable", "ConnectionAborted", "NotConnected", "AddrInUse", "AddrNotAvailable",
  "NetworkDown", "BrokenPipe", "AlreadyExists", "WouldBlock", "NotADirectory", "IsADirectory",
  "DirectoryNotEmpty", "ReadOnlyFilesystem", "FilesystemLoop", "StaleNetworkFileHandle",
  "InvalidInput", "InvalidData", "TimedOut", "WriteZero", "StorageFull", "NotSeekable",
  "QuotaExceeded", "FileTooLarge", "ResourceBusy", "ExecutableFileBusy", "CrossesDevices",
  "TooManyLinks", "InvalidFilename", "ArgumentListTooLong", "Interrupted", "Unsupported",
  "UnexpectedEof", "OutOfMemory", "Other", "Uncategorized", "InProgress", "Deadlock",
]);

// Fallback/placeholder variants — real members of the enum, but not handlers.
const SENTINEL = /^(Unknown|Invalid|None|Some|Ok|Err|Empty|Default|Uninitialized)$/;

// Anchor's own IDL-account instructions. Every Anchor program carries them and
// no published IDL lists them, so counting them would overstate the interface.
const ANCHOR_PLUMBING = /^Idl[A-Z]/;

/** The prefix Anchor logs before each handler name. */
const MARKER = "Instruction: ";

/**
 * Read the &str at a virtual address. NUL termination is authoritative where it
 * exists (SBPFv2+ .rodata); only when it does not — SBPFv1 packs string literals
 * with no separators — is the length taken from the paired register load, which
 * is a guess about which mov belongs to which pointer.
 */
function readStrAt(elf: Buffer, parsed: Elf, vaddr: number, len: number | undefined): string | null {
  for (const d of parsed.data) {
    if (vaddr < d.addr || vaddr >= d.addr + d.size) continue;
    const start = d.off + (vaddr - d.addr);
    const limit = d.off + d.size;
    const nul = elf.indexOf(0, start);
    if (nul > start && nul <= limit && nul - start <= 48) {
      return elf.toString("latin1", start, nul);
    }
    if (len != null && len >= 3 && len <= 48 && start + len <= limit) {
      return elf.toString("latin1", start, start + len);
    }
    return null;
  }
  return null;
}

/**
 * Read exactly `len` bytes at a virtual address. Used where the length is known
 * to be the real one — SBPFv1 packs literals with no separator, so a scan that
 * trusts anything else runs one literal into the next ("Swap" → "SwapInstruction").
 */
function readSized(elf: Buffer, parsed: Elf, vaddr: number, len: number): string | null {
  for (const d of parsed.data) {
    if (vaddr < d.addr || vaddr >= d.addr + d.size) continue;
    const start = d.off + (vaddr - d.addr);
    if (start + len > d.off + d.size) return null;
    return elf.toString("latin1", start, start + len);
  }
  return null;
}

interface Candidate { text: number; rel: number; len: number; name: string }

function recoverInstructions(
  elf: Buffer,
  parsed: Elf,
  scan: TextScan | null,
): { names: string[]; source: InstructionSource | null } {
  // Anchor writes the handler name into the literal itself —
  // msg!("Instruction: Deposit") — so the whole string is in .rodata. Provable,
  // and it covers Anchor programs that never published an IDL.
  const hay = elf.toString("latin1");
  const fromLiteral = new Set<string>();
  const take = (name: string) => {
    if (IDENT.test(name) && !NOISE.has(name) && !ANCHOR_PLUMBING.test(name)) fromLiteral.add(name);
  };
  // sized reads first — the only way to get exact boundaries on a toolchain that
  // stores literals back-to-back with no terminator
  if (scan) {
    for (const [vaddr, sites] of scan.lddw) {
      for (const site of sites) {
        const len = scan.lenAfter.get(site);
        if (len == null || len <= MARKER.length || len > MARKER.length + 48) continue;
        const s = readSized(elf, parsed, vaddr, len);
        if (s?.startsWith(MARKER)) take(s.slice(MARKER.length));
      }
    }
  }
  // and where .rodata is NUL-delimited the literal terminates itself, so an
  // anchored scan is exact too. Requiring the NUL is what keeps it exact.
  for (const m of hay.matchAll(/Instruction: ([A-Z][A-Za-z0-9]{2,47})\0/g)) {
    if (m[1]) take(m[1]);
  }
  if (fromLiteral.size) return { names: [...fromLiteral].sort(), source: "anchor-log" };

  // Otherwise the name is formatted at runtime — msg!("Instruction: {:?}", ix)
  // — and only the bare variant names are on chain. Recover them from the enum's
  // Debug impl: the &str constants it loads sit adjacent in .rodata and are
  // loaded from adjacent code. Requires the log marker as evidence that an
  // instruction name is what is being printed.
  if (!scan || !hay.includes("Instruction: ")) return { names: [], source: null };

  const cands: Candidate[] = [];
  for (const [vaddr, sites] of scan.lddw) {
    for (const site of sites) {
      const s = readStrAt(elf, parsed, vaddr, scan.lenAfter.get(site));
      if (!s || !IDENT.test(s) || NOISE.has(s)) continue;
      const d = parsed.data.find((x) => vaddr >= x.addr && vaddr < x.addr + x.size);
      if (!d) continue;
      cands.push({ text: site, rel: vaddr - d.addr, len: s.length, name: s });
    }
  }
  if (cands.length < 2) return { names: [], source: null };
  cands.sort((a, b) => a.text - b.text);

  // group by proximity in .text — one Debug impl's match arms
  const groups: Candidate[][] = [];
  let cur: Candidate[] = [];
  for (const c of cands) {
    const last = cur[cur.length - 1];
    if (last && c.text - last.text <= 64) cur.push(c);
    else { if (cur.length) groups.push(cur); cur = [c]; }
  }
  if (cur.length) groups.push(cur);

  // dedupe each group by .rodata offset and order it the way the enum is laid
  // out, which is discriminant order
  const byOffset = (g: Candidate[]) =>
    [...new Map(g.map((c) => [c.rel, c])).values()].sort((a, b) => a.rel - b.rel);

  // and require the names to be packed together in .rodata, which is what a
  // concatenated variant-name blob looks like and what an unrelated pair of
  // string loads does not.
  const packed = groups.filter((g) => {
    const uniq = byOffset(g);
    if (uniq.length < 2) return false;
    for (let i = 1; i < uniq.length; i++) {
      const prev = uniq[i - 1];
      const next = uniq[i];
      if (!prev || !next) return false;
      const gap = next.rel - (prev.rel + prev.len);
      if (gap < 0 || gap > 8) return false;
    }
    return true;
  });

  packed.sort((a, b) => new Set(b.map((c) => c.name)).size - new Set(a.map((c) => c.name)).size);
  const best = packed[0];
  if (!best) return { names: [], source: null };
  const names = byOffset(best).map((c) => c.name).filter((n) => !SENTINEL.test(n));
  return names.length ? { names, source: "debug-enum" } : { names: [], source: null };
}

/** Build the structured profile from a program's stripped bytecode. */
export function profileProgram(
  bytecode: Buffer,
  opts: { strings?: string[]; idlInstructions?: string[] } = {},
): ProgramProfile {
  const parsed = readElf(bytecode);
  const scan = parsed?.text ? scanText(bytecode, parsed.text) : null;

  // 1. syscalls — dynamic imports (SBPFv1), hashed CALL_IMM immediates
  //    (SBPFv2+), else a last-resort scan for the names as plain strings.
  let syscalls: string[] = [];
  let syscallSource: SyscallSource | null = null;
  const dyn = parsed ? readDynStr(bytecode, parsed) : null;
  if (dyn) {
    syscalls = dyn.filter((s) => s.startsWith("sol_") || s === "abort");
    if (syscalls.length) syscallSource = "dynsym";
  }
  if (!syscalls.length && scan?.staticSyscalls.size) {
    syscalls = [...scan.staticSyscalls.keys()];
    syscallSource = "static";
  }
  if (!syscalls.length) {
    const hay = bytecode.toString("latin1");
    const occurrences = (needle: string) => {
      let n = 0;
      for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
      return n;
    };
    // "abort" is excluded outright — too short to mean anything as a substring.
    const hits = new Map<string, number>();
    for (const s of KNOWN_SYSCALLS) {
      if (s === "abort") continue;
      const n = occurrences(s);
      if (n) hits.set(s, n);
    }
    // Several syscall names are prefixes of others: `sol_log_` sits inside
    // `sol_log_data`, `sol_log_64_` and `sol_log_pubkey`. A plain substring test
    // reports the short one for every program that only imports a long one, and
    // that false positive was inflating stored syscall counts. Keep the shorter
    // name only if it occurs more often than the names containing it.
    syscalls = [...hits.keys()].filter((s) => {
      let covered = 0;
      for (const [other, n] of hits) if (other !== s && other.includes(s)) covered += n;
      return hits.get(s)! > covered;
    });
    if (syscalls.length) syscallSource = "strings";
  }
  syscalls = [...new Set(syscalls)].sort();

  // 2. capabilities — grouped from the syscall set
  const capabilities: string[] = [];
  for (const rule of CAPABILITY_RULES) {
    if (syscalls.some(rule.match)) capabilities.push(rule.cap);
  }

  // 3. framework — marker strings + syscall ABI
  const hay = opts.strings ? opts.strings.join(" ") : bytecode.toString("latin1");
  let framework: Framework;
  if (/anchor:idl|AnchorError|IdlCreateAccount|Constraint(HasOne|Signer|Seeds|Raw)/.test(hay)) {
    framework = "anchor";
  } else if (syscalls.includes("sol_invoke_signed_c")) {
    framework = "pinocchio"; // C-ABI, no-std
  } else if (syscalls.length > 0) {
    framework = "native";
  } else {
    framework = "unknown";
  }

  // 4. integrations — known program ids embedded in the bytecode
  const integrations: string[] = [];
  for (const { bytes, name } of KNOWN_PROGRAM_BYTES) {
    if (bytecode.includes(bytes)) integrations.push(name);
  }

  // token handling is a capability worth surfacing explicitly
  if (integrations.some((n) => /Token/.test(n)) && !capabilities.includes("tokens")) {
    capabilities.push("tokens");
  }

  // 5. instructions — a published IDL is authoritative; else recover from the
  //    binary. Both beat having no interface surface at all, which is what every
  //    non-Anchor program used to report.
  const idl = (opts.idlInstructions ?? []).filter(Boolean);
  let instructionNames: string[];
  let instructionSource: InstructionSource | null;
  if (idl.length) {
    instructionNames = idl;
    instructionSource = "idl";
  } else {
    const rec = parsed ? recoverInstructions(bytecode, parsed, scan) : { names: [], source: null };
    instructionNames = rec.names;
    instructionSource = rec.source;
  }

  return {
    framework,
    syscalls,
    syscallSource,
    capabilities,
    integrations,
    instructionCount: instructionNames.length || null,
    instructionNames,
    instructionSource,
  };
}
