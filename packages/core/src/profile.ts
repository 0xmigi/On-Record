// ---------------------------------------------------------------------------
// Program Profiler (SPEC: docs/GRADING.md §5). Parses the SBF/eBPF ELF of a
// deployed program into a structured profile: framework, imported syscalls,
// derived capabilities, and known-program integrations. Universal to every
// program — this is the "work backwards from Solana" foundation the grading
// axes build on.
// ---------------------------------------------------------------------------

export type Framework = "anchor" | "pinocchio" | "native" | "unknown";

export interface ProgramProfile {
  framework: Framework;
  syscalls: string[]; // sorted unique sol_* imports (from the ELF dynamic symbols)
  capabilities: string[]; // derived groups: cpi, pda, hashing, advanced-crypto, tokens, return-data, sysvars
  integrations: string[]; // known programs referenced by embedded program id
  instructionCount: number | null;
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

// known syscalls — used to classify and as a fallback scan when the ELF has no
// readable dynamic symbol table
const KNOWN_SYSCALLS = [
  "sol_invoke_signed_c", "sol_invoke_signed_rust", "sol_log_", "sol_log_64_",
  "sol_log_pubkey", "sol_log_data", "sol_log_compute_units_", "sol_sha256",
  "sol_keccak256", "sol_blake3", "sol_poseidon", "sol_secp256k1_recover",
  "sol_curve_validate_point", "sol_curve_group_op", "sol_curve_multiscalar_mul",
  "sol_alt_bn128_group_op", "sol_alt_bn128_compression", "sol_big_mod_exp",
  "sol_try_find_program_address", "sol_create_program_address",
  "sol_get_clock_sysvar", "sol_get_rent_sysvar", "sol_get_epoch_schedule_sysvar",
  "sol_get_fees_sysvar", "sol_get_epoch_rewards_sysvar", "sol_get_last_restart_slot",
  "sol_get_stack_height", "sol_get_processed_sibling_instruction",
  "sol_set_return_data", "sol_get_return_data", "sol_memcpy_", "sol_memmove_",
  "sol_memset_", "sol_memcmp_", "sol_alloc_free_", "sol_remaining_compute_units",
  "sol_get_sysvar", "sol_get_epoch_stake", "sol_panic_",
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
function base58Decode(str: string): Buffer | null {
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

// --- minimal ELF64 section reader -------------------------------------------
function readDynStr(elf: Buffer): string[] | null {
  try {
    if (elf.length < 64 || elf.readUInt32BE(0) !== 0x7f454c46) return null; // \x7fELF
    if (elf[4] !== 2 || elf[5] !== 1) return null; // ELF64, little-endian
    const shoff = Number(elf.readBigUInt64LE(0x28));
    const shentsize = elf.readUInt16LE(0x3a);
    const shnum = elf.readUInt16LE(0x3c);
    const shstrndx = elf.readUInt16LE(0x3e);
    if (!shoff || !shnum || shoff + shnum * shentsize > elf.length) return null;

    const section = (i: number) => {
      const b = shoff + i * shentsize;
      return {
        nameOff: elf.readUInt32LE(b),
        offset: Number(elf.readBigUInt64LE(b + 0x18)),
        size: Number(elf.readBigUInt64LE(b + 0x20)),
      };
    };
    const shstr = section(shstrndx);
    const nameAt = (off: number) => {
      let end = shstr.offset + off;
      while (end < elf.length && elf[end] !== 0) end++;
      return elf.toString("utf8", shstr.offset + off, end);
    };
    for (let i = 0; i < shnum; i++) {
      const s = section(i);
      if (nameAt(s.nameOff) === ".dynstr" && s.offset + s.size <= elf.length) {
        return elf
          .toString("latin1", s.offset, s.offset + s.size)
          .split("\0")
          .filter(Boolean);
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Build the structured profile from a program's stripped bytecode. */
export function profileProgram(
  bytecode: Buffer,
  opts: { strings?: string[]; idlInstructions?: string[] } = {},
): ProgramProfile {
  // 1. syscalls — from the ELF dynamic string table, else a fallback scan
  const dyn = readDynStr(bytecode);
  let syscalls: string[];
  if (dyn) {
    syscalls = dyn.filter((s) => s.startsWith("sol_") || s === "abort");
  } else {
    const hay = bytecode.toString("latin1");
    syscalls = KNOWN_SYSCALLS.filter((s) => hay.includes(s));
  }
  syscalls = [...new Set(syscalls)].sort();

  // 2. capabilities — grouped from the syscall set
  const capabilities: string[] = [];
  for (const rule of CAPABILITY_RULES) {
    if (syscalls.some(rule.match)) capabilities.push(rule.cap);
  }

  // 3. framework — marker strings + syscall ABI
  const markers = (opts.strings ?? []).join(" ") + " " + bytecode.toString("latin1").slice(0, 0);
  const hay = opts.strings ? markers : bytecode.toString("latin1");
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

  return {
    framework,
    syscalls,
    capabilities,
    integrations,
    instructionCount: opts.idlInstructions?.length ?? null,
  };
}
